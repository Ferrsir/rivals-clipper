# Capture and export sizes

## What Marvel Rivals gives us

Marvel Rivals renders at your monitor's native resolution and aspect ratio (Display settings, Resolution). Its upscalers (TAAU, FSR, DLSS, XeSS) change the internal render scale, not the output size. So the clipper records the game window at your monitor's native size by default.

## Where the clips are going

| Platform | Shape | Upload size | Notes |
| --- | --- | --- | --- |
| TikTok | 9:16 vertical | 1080 × 1920 | 30 or 60 fps |
| Instagram Reels | 9:16 vertical | 1080 × 1920 | Keep text out of the bottom ~20% (caption and buttons) |
| YouTube Shorts | 9:16 vertical | 1080 × 1920 | Up to 60 s or 3 min, depending on account |
| YouTube videos | 16:9 | 1920 × 1080, 2560 × 1440 or 3840 × 2160 | 1440p and up gets YouTube's better codec, so it looks noticeably sharper than a 1080p upload |

## Why the recording resolution matters for vertical edits

A 16:9 game frame has to be cropped to 9:16 for TikTok, Reels and Shorts. The crop is only as tall as your recording, then it gets scaled to 1080 × 1920.

| Record at | 9:16 crop from it | Scale to reach 1080 × 1920 | Result |
| --- | --- | --- | --- |
| 1080p | 608 × 1080 | 1.78× up | Soft, noticeably blurry text and UI |
| 1440p | 810 × 1440 | 1.33× up | Good |
| 4K | 1215 × 2160 | 0.89× down | Sharpest |

## Recommended settings

- **Resolution:** "Match my monitor". If you play on a 1080p monitor, consider 1440p capture only if your GPU has headroom (the game still renders at 1080p, so it gains less).
- **Frame rate:** 60 fps for normal clips. Pick **120 fps** if you want smooth slow-motion and speed ramps (velocity edits); 120 fps footage slowed to 50% still plays at 60 fps.
- **Bitrate:** automatic (20 Mbps at 1080p, 35 Mbps at 1440p, 60 Mbps at 4K, ×1.5 at 120 fps). High because these clips get cropped and re-encoded in the Reel Maker.
- **Audio:** game sound on track 1, your mic on track 2. The game track never contains your mic, so any clip can be used with or without it.
