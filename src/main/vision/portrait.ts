// Reference captured from a clip whose subtitle explicitly identifies MAGIK (Ferrsir).
// Only this verified portrait variant is supported until other heroes are calibrated.
import type { View } from './image';
const reference = Buffer.from('PD05MkTaP00pLbJpNSswNjQ3PDU3Vmx0cE9Ljf1jXlliYSwjGCA547k+NC1UwzMpMTc2Rll1fV9NVVZPTsTmRGpWW1YhIiguNMrmclEsMaJoNDplqdqlseXHflJPSW/st0ZdWlZILS4sLi+gq7daPzNQ0am26vXZ0nu6z4eBZUGw95FaNzIqIDIyMTAxalZXr2k3OJ/jyOv4w5Oabq97god35uBfPR8dISEuMS0xQGOAKnqJbj1GznCAqcauknx6hYiPkui/QzAcHB0dM0xrbl1JPmAqot1RPHyfcnyJlIyBd4GPmp2wlUMyHRscHF9IPT88OzhRWjrAgkRcopGooJyDcH+BlZ6hrGxILR0bHBxkucGbcXKq2OBQW5xkc3qawK2irqmVlZygpKuNOhccHB0d5ff27u/y9PLqiUViXV5+rK3TxamopKOhorCzklAkIB4eHuz96djKv8O/roBzY1tfdp3a0qm2sq2joKfAwp5pKSMgHiHT+PXjxq+hn4J/aWFiZnvU0bC50L23qam2xs6rVigjIB4eZJX2+ejax4eCdWNrcGd37LSU0ObMxLO1v83JmlIgIiAkNRkXhv3724yAfmBkYmllWd+siK/Q3NTIxM/GtY1XJys4RlIZGSWvuYN7g3hiX2ifl1qetnSft9bK3MnUtZl8ZUFHS09OGRkWKdbW0c17bmJwmXSAfqJjh6Wzutq7vZ6IalFKRk1PTRUWGEKP58qNhHBUeY9cfJlXU2ODgrC0qqN+dHJxcWlAQ0QsGxxTwad2enNle1OdXmGZmlY/S0adlYxsY2lqXVx2Oy9ebh0eL7ycT2ttbVRda0hbeLysnap/oZl1fpFeYGRmbllBOaojHx6Wv0hlZXhCjUlDg2qcyNLLsLjI0cubaF9jZ1d3RDDFUh4dYcJUXVo4OCwyYYtugqvGyry/0MW4lJRiYmdVmEw9m5kiJDy0eKtyP0FLN0x0aXmdusmstdC/fKqKdJXX3IJUTVK8RSwvmpWRWGB0ZioUQkBfg6enxZ6ym3G95+n187lkg0w0lYQvLm27QmJ4gmNmZl89LWqbinZzf4KUrPr/4pA6M6M7MEe4QS9BwUdxfW5ZX2yioDc1h6ini4GDjDWX73k8NS+jSlwnjHUvLp5tcGhabkxZap2PGTOWybZ+cpcxQ7p+NTMmg3KgKjyaLypylUpcXmRvem1WaUsdOmFuZXubO0NIdTM9Smyai1gtcVQnMq5FUGJsb21mVVxRHTZLdXF+qUNAOjJFYWlcszSCMjOBKyecQTZEV3FvbFxYVDQ1SZmReqB7RUZcY2drZKwkPVUsXUcnZ2gxPEVwc21nXVc3Z4ZhmWmblXF0ZmRmZmqIJys7KSZsJDyQNkdHZXd2eGNgO4SIUo1tg5iboaSEZmeakicqKiojRzoijjNQT1hkb4yDeFxvYVaGglSHlJKZiWZ+3JkkIyIiIiYtIW1DVFRZW1l8or/Oup5+hKFXcWJjZXZqs/W4IiAhISEgJCM+Wk9UWV5fpcvMz83Iw7+tk5B0U0tIRoFwUyEfISIjISMkJWVER0JAQlhgVFBLPzUyNDZFUFBOW11odoMhISAiJSQpLTJsWmNweoWGl6alqLe8v7/BxMO/w8TDwcTE', 'base64');
export function matchPortrait(view: View): string | undefined {
  if (view.w !== 34 || view.h !== 36) return undefined;
  const samples: number[] = [], expected: number[] = [];
  // Compare the face, excluding the shared frame and changing background.
  for (let y = 7; y < 29; y++) for (let x = 7; x < 26; x++) {
    samples.push(view.luma[y * view.w + x]); expected.push(reference[y * view.w + x]);
  }
  const mean = (a: number[]) => a.reduce((s,v)=>s+v,0)/a.length;
  const a = mean(samples), b = mean(expected);
  const spread = Math.sqrt(mean(samples.map(v=>(v-a)**2)));
  const refSpread = Math.sqrt(mean(expected.map(v=>(v-b)**2)));
  if (spread < 12) return undefined;
  const error = mean(samples.map((v,i)=>Math.abs((v-a)/spread-(expected[i]-b)/refSpread)));
  return error < 0.32 ? 'MAGIK' : undefined;
}
