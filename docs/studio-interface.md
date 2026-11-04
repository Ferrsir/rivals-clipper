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
- The Library will add a SQLite index and export a query function. The sidecar stays backward compatible (only new optional fields).
- The Studio never writes into `clips/`.

## Storage

From `paths(root)` in `src/main/settings.ts` (created at startup):

| Key | Path |
| --- | --- |
| `studio` | `<root>\studio` (projects) |
| `music` | `<root>\music` (uploads) |
| `reels` | `<root>\exports\reels` (renders) |
