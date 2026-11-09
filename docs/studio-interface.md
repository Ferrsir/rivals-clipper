# Studio interface

The app shell (sign-in, Clipper, Settings, Library, installer) and the Editing Studio are built separately. This is the contract between them.

## Ownership

| Area | Owner |
| --- | --- |
| `src/main/studio/**`, `src/shared/studio.ts`, `renderer/studio/**`, `test/studio-*.test.ts` | Studio |
| Everything else | Shell |

## Renderer mount

- The Studio tab holds `<div id="studio-root">`.
- The first time the tab opens, the shell runs `import('./studio/index.js').then((m) => m.mount(rootEl))`.
- `renderer/studio/` is vanilla ES modules, no build step. The shell stays vanilla JS too.
- CSP allows `img-src 'self' file: data: blob:` and `media-src file: blob:`.

## Preload bridge

`window.studioBridge`:

```js
studioBridge.invoke(channel, ...args) // Promise; only channels starting with "studio:"
studioBridge.on(channel, callback)    // same rule
```

The Studio also has the shell's `window.clipper` API (read-only use expected), including `clipper.listClips()` and `clipper.ai.*`.

## Main process

The Studio registers its IPC handlers with one line in `main.ts`:

```ts
registerStudio({ getSettings: () => settings, ffmpegPath: () => recorder.ffmpegPath, ai });
```

`ai` is exported from `main.ts`, created by `createAiClient` in `src/main/ai-auth.ts`:

```ts
interface AiClient {
  status(): Promise<{ signedIn: boolean; provider: 'claude' | 'codex' | 'none' }>;
  ask(opts: { prompt: string; system?: string; imagePaths?: string[]; expectJson?: boolean; timeoutMs?: number }):
    Promise<{ text: string; provider: 'claude' | 'codex'; json?: unknown }>;
}
```

It runs on the user's own Claude Code or Codex sign-in, one-shot, with read-only access. `imagePaths` are local image files (e.g. extracted frames).

## Clips

- Read `ClipSidecar` v1 (`src/shared/types.ts`) through `listClips(clipsFolder)` in `src/main/clip-store.ts`.
- Kill time inside a clip = `event.at - startTimeEpoch` (ms).
- Audio: track 0 is game, track 1 is mic when `audioTracks` has two entries; honour `useMic`.
- For filtered or ranked clips, use the Library: `import { library } from '../main'` and call `library.query({ hero, map, gameType, tags, minKills, minRating, text, sort: 'new' | 'score' | 'kills' | 'rating', limit, offset })`. It returns `{ items, total }`. `library.facets()` lists heroes, maps, modes and tags with counts. In the renderer, the same calls are `clipper.queryClips(q)` and `clipper.clipFacets()`. The pure `queryClips(clips, q)` lives in `src/main/library.ts`.
- Sidecars may carry an optional `ai` field (`{ tags, summary, hype 1-10, provider, at, error? }`) once AI tagging has run. Its tags are already merged into `tags`, and `summary` is a ready-made caption idea.
- The Library indexes sidecars in memory and rescans only changed files, so it needs no database module. The sidecar stays backward compatible (only new optional fields).
- The Studio never writes into `clips/`.

## Storage

From `paths(root)` in `src/main/settings.ts` (created at startup):

| Key | Path |
| --- | --- |
| `studio` | `<root>\studio` (projects) |
| `music` | `<root>\music` (uploads) |
| `reels` | `<root>\exports\reels` (renders) |

## Prompt-driven gameplay editing

Create reel accepts up to20,000characters and calls the selected signed-in provider. Quick ideas is explicitly local. Plans carry source clip IDs, source trims, exact kill-marker times, a maximum duration budget and an imported song start. The model cannot substitute arbitrary source paths. A trim that removes a marked streak kill is rejected; impossible duration budgets remain previewable with a warning and block final export.

Vertical exports remove the top objective and bottom ability HUD, recenter gameplay and separately crop the original upper-right feed. Both picture and feed use the same source segment timing. Moving the inspector crop box takes precedence over automatic framing. Follow character with AI sends up to16 ordered source frames per clip for player torso positions, interpolates accepted locations, and holds the prior location on uncertain samples. It cannot guarantee every intermediate frame or remove subtitles baked into source video. Provider limits surface as errors, not fabricated edits.

After Make reel renders, a review sends up to12 actual output frames, prioritizing marked kill moments to the selected provider and measures duration/audio level. Reviews persist under studio/reviews and clearly separate issues from limitations. Optional local style-feed.jpg and style-gameplay.jpg under studio/references are appended as actual visual references. Reviews never certify audio timing by looking at images, claim50 independent reviewers, or automatically publish. Request changes preserves trusted sources and checks that the user has not changed the project while the AI works.

The production sequence is brief, select, frame, render, review, revise, then user playback/export. It is inspired by Reel Studio's orchestration pattern, implemented with this app's local renderer. External anime video intros and timed artwork layers are still unsupported; a text card is not a substitute. No restricted upstream doctrine or private gameplay is redistributed in this repository.

For source clips up to30seconds, the feed overlay now classifies every source frame at30fps and masks only detected light player-involvement banner rows. Scenery between rows is transparent. Names and portraits remain original source pixels; no kill rows are fabricated. Mask timestamps follow the same seek and retiming as gameplay. Longer legacy sources retain the conventional tight feed crop and require review. This identifies player-involvement rows, which can include deaths/trades; it does not independently reclassify clip kill metadata.

Before AI clip selection, Studio now extracts three-frame source contact sheets for up to12 ranked candidates (restricted to a named hero when possible). The actual sheets and exact marker facts are sent together; the model is asked to reject menu/death-only and obstructed footage. Make reel requests one plan; Suggest ideas requests five. This is sampled visual selection, not full-video understanding.

## Reference-square master

The imported reference edits were square, not9:16. Reference square exports a1080x1080 master alongside the existing vertical presets, with the same player framing, clean HUD crop and isolated original feed. It keeps more surrounding action visible instead of forcing every reference into a narrow portrait crop. The toolbar wraps so Preview and Export stay accessible in narrower windows. Square masters are exported for manual platform preview; automatic upload routing remains attached to the named platform presets.

Rapid eliminations can share a planning impact but must retain separate timeline markers. The planner now maps every source kill marker through the actual retimed segments, including markers less than150ms apart, instead of losing one when grouping timing anchors. Off-beat warnings remain honest rather than declaring every rapid kill aligned.

## Reference-style defaults (2026-11-05)

Ferris's feedback on the first prompt-made reels, and what changed:

- **Kill feed as one box.** The row-isolation mask (`feed-mask.ts`) is gone. Square and vertical outputs crop the whole source feed region (`FEED_REGION` in `render.ts`: x 0.70–0.995, y 0.02–0.205 of the 16:9 frame), darken it slightly, and pin it flush to the top-right corner for every gameplay clip, like the reference edits. On 9:16 it is wider and sits just under TikTok's top buttons.
- **Hero centred.** Marvel Rivals' camera keeps the hero in the middle, so the default is a fixed centred crop. AI frame tracking (`followCharacter`) is opt-in because it jumped around big effects.
- **Kill montage style** (`montage`, the new default): no hook card, captions or end text unless asked, 2–3.4 s of build-up, every cut and kill on a beat, each clip cut 0.25–0.75 s after its last kill, slow-mo and trails on the big play only.
- **Length is enforced** (`fit.ts`). The number in the prompt ("30 seconds", "20-30s", "half a minute") is the target, 30 s when none is given. After the AI's plan, and after every revision, the Studio measures the real beat-synced timeline and adds the best unused kill clips (same hero first, closer kept last) or drops the weakest, until it is within a second or two. A render no longer fails for being over budget.
- **Revisions add clips.** "Request changes" sends the AI the library list too, so "make it longer, add more clips" really pulls new clips.
- **Your own media.** Drop videos or pictures on the Create panel (or "+ Add files"). The AI can put your videos in the edit (`asset:<id>` clip ids), lay a picture over a clip (`overlays`, positions in source-frame fractions, times in clip seconds), and add subtitles you wrote (`subtitles`, mapped through retiming in `subtitleTimes`). A face-anchored overlay is located by your signed-in AI on 3–12 frames and follows those keyframes (`overlay.ts`). Speech-to-text is not built in: subtitles use words from your prompt.
- **Make reel steps.** The Create panel shows four steps (plan, length + music, render, review) with notes such as which song was picked and how many clips were added. If no song was chosen and your library has analysed songs, the best match is picked automatically.

## Timeline and hand edits

The bottom panel is laid out like Premiere Pro's sequence panel: a timecode ruler with the song's beats and drop, then V2 (subtitles, captions, picture overlays), V1 (clips with head thumbnails, kill markers, held frames and jump cuts), A1 (each clip's own sound) and A2 (the song, its volume line, audio jumps and the end fade).

- Selection tool (V): click to select, drag a clip's edge to trim it (sets `manualTrim`, so the planner keeps that trim and only flexes speed to stay on the beat), drag a clip to reorder.
- Razor (C): click a clip to split it in two; kill markers, overlays and subtitles follow their half.
- Audio jump (J): the song drops out for one beat at the playhead (`project.musicCuts`); drag it to move, Delete removes it.
- Snap (S) snaps edits to beats. Ctrl+wheel or +/- zooms, \ fits, arrows step a frame.
- Without a fresh preview, scrubbing shows the source frame at the playhead in the program monitor.

Per-clip controls (Clip tab, "Edit"): music under this clip (`musicLevel`), clip volume (`gain`), level the sound up (`normalize`), hold the last frame (`holdBeats`), fade in/out, jump cuts between kills (`jumpCut`), keep my trim. Audio tab: the ending (`ending.mode` cut or play-out, with its fade) and the audio jumps list.

A prompt with a hook clip before gameplay gets the hook defaults (song at 16% under it, sound levelled, one-beat hold) and ends the hook just after the word named in "till gojo goes 'exactly'". "Let the last clip play out" sets the play-out ending.
