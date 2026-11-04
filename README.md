# Rivals Clipper

Auto-clips your Marvel Rivals kills and streaks, keeps a ranked highlight library, and (coming next) turns the best clips into TikTok, Reels, Shorts and YouTube edits.

Kill detection uses Overwolf's official Game Events Provider for Marvel Rivals, and recording uses Overwolf's recorder package (an OBS-based replay buffer). Nothing reads game memory, so there is no anti-cheat risk.

## What works now (Phase 0 + 1)

- **Replay buffer** of the game while Marvel Rivals is running (60 s in memory, nothing written until something happens).
- **Streak clips:** the first kill saves the last 12 s, and every kill within 5 s of the previous one extends the same clip, so a triple kill is one clip, not three. Capped at 90 s.
- **Manual clip** hotkey (F9 by default) for plays that aren't kills.
- **Separate audio tracks:** game sound on track 1, mic on track 2 (optional). Per-clip "mic in reels" switch, and one-click exports with or without mic.
- **Game-only audio** by default, so Discord and Spotify stay out of your clips.
- **Event sidecar** next to every clip (`<clip>.json`): each kill with victim, victim's hero and role, your hero, teammates alive, enemies alive, ult usage, map, mode, and match result.
- **Scoring and tags:** double/triple/quad, fast, clutch, healer-hunt, team-wipe, ult, match-winner, plus your 1 to 5 star rating.
- **Raw event log** of everything GEP reports, in `logs/gep-YYYY-MM-DD.jsonl`, so we can tune detection from real matches.
- Everything is stored under **`F:\RivalsClips`** (changeable in the app). If F: isn't available it falls back to `Videos\RivalsClips` and tells you.

```
F:\RivalsClips\
  clips\        2026-11-04_21-14-03_0k_Magik.mp4 + .json
  exports\      game-only and with-mic exports
  logs\         gep-2026-11-04.jsonl
  settings.json
  hero-roles.json
```

## Run it (Windows)

1. Install [Node.js 22 LTS](https://nodejs.org/) and [Git](https://git-scm.com/download/win).
2. In a terminal:
   ```
   git clone <this repo>
   cd rivals-clipper
   npm install
   npm start
   ```
3. Launch Marvel Rivals. The status bar turns green when the replay buffer is running.
4. Play a match. Clips appear in the list as they're saved.

The first launch downloads Overwolf's `gep` and `recorder` packages, which can take a minute. If Marvel Rivals runs as administrator, run Rivals Clipper as administrator too, or game events won't arrive.

To build an installer: `npm run dist` (output in `release/`). Publishing it to other people requires registering the app with Overwolf; personal use does not.

## Settings worth knowing

See [docs/resolution-guide.md](docs/resolution-guide.md) for why recording at 1440p or above matters for vertical TikTok/Reels crops, and when to use 120 fps.

## Development

```
npm run typecheck
npm test
```

Code map:

| File | What it does |
| --- | --- |
| `src/main/main.ts` | Wires GEP events to the streak logic and the recorder, plus IPC for the UI |
| `src/main/streak.ts` | Decides when a clip starts and stops (pure, tested) |
| `src/main/match-state.ts` | Live match picture from GEP: roster, ult charge, kill feed (tested) |
| `src/main/scoring.ts` | Score and tags for a clip (tested) |
| `src/main/recorder.ts` | Overwolf recorder setup: game capture, audio tracks, replay buffer |
| `src/main/clip-store.ts` | Clip sidecar JSON read/write |
| `src/main/ffmpeg.ts` | Exports with or without the mic track |
| `renderer/` | The app window |

## Roadmap

1. ~~Phase 0: event logging~~
2. ~~Phase 1: clipper~~
3. Phase 2: library with SQLite index, filters, bulk cleanup
4. Phase 3: AI style tags (Claude or ChatGPT through your own sign-in)
5. Phase 4: Reel Maker: pick clips and music, beat-synced cuts, 9:16 and 16:9 export
6. Phase 5: edit-style recipes (speed ramps, zoom punches, shake, flashes, text)
7. Phase 6: polish

## License

MIT
