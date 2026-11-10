// Reference captured from a clip whose subtitle explicitly identifies MAGIK (Ferrsir).
// Only this verified portrait variant is supported until other heroes are calibrated.
import type { View } from './image';
const reference = Buffer.from('PD05MkTaP00pLbJpNSswNjQ3PDU3Vmx0cE9Ljf1jXlliYSwjGCA547k+NC1UwzMpMTc2Rll1fV9NVVZPTsTmRGpWW1YhIiguNMrmclEsMaJoNDplqdqlseXHflJPSW/st0ZdWlZILS4sLi+gq7daPzNQ0am26vXZ0nu6z4eBZUGw95FaNzIqIDIyMTAxalZXr2k3OJ/jyOv4w5Oabq97god35uBfPR8dISEuMS0xQGOAKnqJbj1GznCAqcauknx6hYiPkui/QzAcHB0dM0xrbl1JPmAqot1RPHyfcnyJlIyBd4GPmp2wlUMyHRscHF9IPT88OzhRWjrAgkRcopGooJyDcH+BlZ6hrGxILR0bHBxkucGbcXKq2OBQW5xkc3qawK2irqmVlZygpKuNOhccHB0d5ff27u/y9PLqiUViXV5+rK3TxamopKOhorCzklAkIB4eHuz96djKv8O/roBzY1tfdp3a0qm2sq2joKfAwp5pKSMgHiHT+PXjxq+hn4J/aWFiZnvU0bC50L23qam2xs6rVigjIB4eZJX2+ejax4eCdWNrcGd37LSU0ObMxLO1v83JmlIgIiAkNRkXhv3724yAfmBkYmllWd+siK/Q3NTIxM/GtY1XJys4RlIZGSWvuYN7g3hiX2ifl1qetnSft9bK3MnUtZl8ZUFHS09OGRkWKdbW0c17bmJwmXSAfqJjh6Wzutq7vZ6IalFKRk1PTRUWGEKP58qNhHBUeY9cfJlXU2ODgrC0qqN+dHJxcWlAQ0QsGxxTwad2enNle1OdXmGZmlY/S0adlYxsY2lqXVx2Oy9ebh0eL7ycT2ttbVRda0hbeLysnap/oZl1fpFeYGRmbllBOaojHx6Wv0hlZXhCjUlDg2qcyNLLsLjI0cubaF9jZ1d3RDDFUh4dYcJUXVo4OCwyYYtugqvGyry/0MW4lJRiYmdVmEw9m5kiJDy0eKtyP0FLN0x0aXmdusmstdC/fKqKdJXX3IJUTVK8RSwvmpWRWGB0ZioUQkBfg6enxZ6ym3G95+n187lkg0w0lYQvLm27QmJ4gmNmZl89LWqbinZzf4KUrPr/4pA6M6M7MEe4QS9BwUdxfW5ZX2yioDc1h6ini4GDjDWX73k8NS+jSlwnjHUvLp5tcGhabkxZap2PGTOWybZ+cpcxQ7p+NTMmg3KgKjyaLypylUpcXmRvem1WaUsdOmFuZXubO0NIdTM9Smyai1gtcVQnMq5FUGJsb21mVVxRHTZLdXF+qUNAOjJFYWlcszSCMjOBKyecQTZEV3FvbFxYVDQ1SZmReqB7RUZcY2drZKwkPVUsXUcnZ2gxPEVwc21nXVc3Z4ZhmWmblXF0ZmRmZmqIJys7KSZsJDyQNkdHZXd2eGNgO4SIUo1tg5iboaSEZmeakicqKiojRzoijjNQT1hkb4yDeFxvYVaGglSHlJKZiWZ+3JkkIyIiIiYtIW1DVFRZW1l8or/Oup5+hKFXcWJjZXZqs/W4IiAhISEgJCM+Wk9UWV5fpcvMz83Iw7+tk5B0U0tIRoFwUyEfISIjISMkJWVER0JAQlhgVFBLPzUyNDZFUFBOW11odoMhISAiJSQpLTJsWmNweoWGl6alqLe8v7/BxMO/w8TDwcTE', 'base64');
const W = 34, H = 36;

/** How different two portraits look: 0 = same, ~1 = unrelated. Undefined when `a` is too flat to judge. */
export function portraitError(a: Uint8Array, b: Uint8Array): number | undefined {
  const samples: number[] = [], expected: number[] = [];
  // Compare the face, excluding the shared frame and changing background.
  for (let y = 7; y < 29; y++) for (let x = 7; x < 26; x++) {
    samples.push(a[y * W + x]); expected.push(b[y * W + x]);
  }
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(samples), mb = mean(expected);
  const spread = Math.sqrt(mean(samples.map((v) => (v - ma) ** 2)));
  const refSpread = Math.sqrt(mean(expected.map((v) => (v - mb) ** 2)));
  if (spread < 12 || refSpread < 12) return undefined;
  return mean(samples.map((v, i) => Math.abs((v - ma) / spread - (expected[i] - mb) / refSpread)));
}

const MATCH = 0.32;
/** Another hero's portrait must look clearly worse than the best one. */
const MARGIN = 0.04;
const PER_HERO = 6;

/**
 * Bottom-left HUD portraits, by hero. Starts with the built-in Magik portrait and learns the rest from
 * your own games: when your hero's name is read cleanly from the screen, the portrait shown at that
 * moment is saved under that hero (skins included). After that the portrait alone identifies the hero.
 */
export class PortraitBook {
  private refs = new Map<string, Uint8Array[]>([['Magik', [reference]]]);

  constructor(saved: Record<string, string[]> = {}) {
    for (const [hero, list] of Object.entries(saved)) {
      const decoded = (Array.isArray(list) ? list : []).map((b) => Buffer.from(String(b), 'base64')).filter((b) => b.length === W * H);
      if (decoded.length) this.refs.set(hero, [...(this.refs.get(hero) ?? []), ...decoded].slice(-PER_HERO));
    }
  }

  match(view: View): string | undefined {
    if (view.w !== W || view.h !== H) return undefined;
    let best: { hero: string; err: number } | undefined;
    let second = Infinity;
    for (const [hero, list] of this.refs) {
      const err = Math.min(...list.map((r) => portraitError(view.luma, r) ?? Infinity));
      if (!best || err < best.err) {
        if (best) second = Math.min(second, best.err);
        best = { hero, err };
      } else second = Math.min(second, err);
    }
    return best && best.err < MATCH && second - best.err >= MARGIN ? best.hero : undefined;
  }

  /** Save this portrait for `hero` unless it already matches. Returns true when something new was learned. */
  learn(hero: string, view: View): boolean {
    if (view.w !== W || view.h !== H) return false;
    const list = this.refs.get(hero) ?? [];
    const self = portraitError(view.luma, view.luma);
    if (self === undefined) return false; // too flat: a menu, a fade, a death screen
    if (list.some((r) => (portraitError(view.luma, r) ?? Infinity) < MATCH * 0.75)) return false;
    this.refs.set(hero, [...list, new Uint8Array(view.luma)].slice(-PER_HERO));
    return true;
  }

  /** What to save between sessions (the built-in portrait is left out). */
  export(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [hero, list] of this.refs) {
      const learned = list.filter((r) => r !== reference).map((r) => Buffer.from(r).toString('base64'));
      if (learned.length) out[hero] = learned;
    }
    return out;
  }
}

export function matchPortrait(view: View): string | undefined {
  if (view.w !== W || view.h !== H) return undefined;
  const err = portraitError(view.luma, reference);
  return err !== undefined && err < MATCH ? 'MAGIK' : undefined;
}
