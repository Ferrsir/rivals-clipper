# Local mode: kill detection and recording without Overwolf

Rivals Clipper can run without Overwolf. In local mode it finds your kills by watching the screen, the same way
you do, and records with your graphics card through Windows' own screen capture. Clips come out exactly like the
Overwolf ones (H.264 MP4, game sound on track 1, your mic on track 2, the same `.json` sidecar), so the Library,
scoring and the Studio work the same.

**Anti-cheat safety:** local mode only looks at the picture on your monitor (Windows Desktop Duplication, what
OBS and Discord use) and lists running programs by name (like Task Manager). It never opens the game process, reads
its memory, injects anything or talks to the game. Game audio is captured with Windows' per-app audio loopback,
which records what the game plays to your speakers, not anything inside the game.

## Turning it on

Current installers use standard Electron and start directly in **Built-in screen detection**.
No Overwolf account, package signing or ads are needed. Settings from older installers are migrated
to built-in mode automatically. Set your name and monitor under Settings, **Kill detection**.

Then just play. The status bar says which encoder and graphics card are recording, and the Kill detection panel
shows what the detector sees (screen size, checks per second, whether you're in a match).

Set **Your in-game name** if you can. Without it the app learns your name from the kill feed after four of your
rows, and until then a kill-feed row alone can't tell your kill from your death (the KO list still works).

## How it finds kills

| Cue on screen | What it means | Needs text reading |
| --- | --- | --- |
| A new name in the KO list right of the crosshair, with the crossed-blades icon | You got a KO (only your KOs show there) | No (the name is read for the victim) |
| The same, with the figure-on-a-ring icon | An assist | No |
| A new light-grey row in the kill feed with your name on the left | Your KO | Yes |
| The same kind of row with your name on the right | Your death | Yes |
| "N PLAYER KO STREAK!" with no KO seen just before it | A KO the other cues missed | No |
| The blue and red objective bar at the top | You're in a match | No |
| VICTORY / DEFEAT | Match result | Yes |
| The map label, top left | Map name, or the Practice Range | Yes |

A KO-list name and a feed row within 1.5 s of each other are one KO, and the same name again within 5 s is the
same KO shown twice. Each KO is reported with the time it showed
on screen, and the clip reaches back by however long detection took, so clips start where they should.

Text reading uses Tesseract (WebAssembly, bundled, runs on your PC, nothing is uploaded). If it can't start,
kills still come from the KO list and streak banners.

**Practice Range:** once the app has seen the match bar on your PC, kills with no match bar on screen for 90 s are
treated as the Practice Range and not auto-clipped (the manual hotkey still works). Until it has seen one real match
on your PC it can't tell the Practice Range apart, so play one match first.

## How it records

ffmpeg's `ddagrab` captures the monitor on the graphics card it is plugged into, and the video is encoded on that
same card, so frames never pass through the CPU:

- Monitor plugged into the **RTX 5080**: NVIDIA NVENC.
- Monitor plugged into the **motherboard** (AMD graphics): AMD AMF on the iGPU. The app tells you to move the cable
  to the GeForce, which is better for the game too. If AMF fails, frames are copied to NVENC.
- Last resort: CPU encoding (x264), capped to fit within 1920x1080 at 60 fps, preserving the monitor's aspect ratio.

The recording resolution setting is a maximum height: 1080p, 1440p or 4K. A smaller monitor is never
upscaled. Native resolution keeps GPU frames on the graphics card. Choosing a smaller recording size
uses a CPU resize before hardware encoding because the bundled FFmpeg has no D3D11 scaling filter.
The status log reports the actual output size and frame rate.

The encoded video stays in memory (60 s at 1440p60 and the default 35 Mbps is about 260 MB of RAM). Nothing is written to disk until
a clip is saved. Keyframes are 1 s apart, so a clip starts within a second of the requested pre-roll.

Audio comes from `rc-audio.exe`, a small helper that records the game's own sound (or everything you hear, if you
picked that) and your mic, each into its own buffer. Saving a clip cuts the audio to the same wall-clock window as
the video. Per-app game audio needs Windows 11 (or Windows 10 build 20348 or later); on older systems it falls back to
everything you hear.

Play in **borderless** or **fullscreen** on the monitor set in *Monitor to record* (0 = main monitor).

## Cost while you play

Measured, not guessed:

- Recording: done on the graphics card's video encoder, which is separate from the part that renders the game.
- Detection: a second, light capture at 10 checks per second that only keeps the HUD corners (about 2.3 MB per
  check instead of the whole 1440p screen). Cropping took about a fifth of one CPU core on the (slow) test machine,
  and analysing about 3.5 ms per check.
- Text reading: about 60 ms per read, only when a new row or name appears, on a background thread.

*Checks per second* can go down to 5 if you want it even lighter. Kills are still caught; they're reported a little
later.

## Where it is not as good as Overwolf

Honest list, so you know what to expect:

- **Assists are new and lightly tested.** They come from the KO list's assist icon, which was checked on only one
  example so far. When unsure, a line counts as a KO.
- **Heroes, teammates alive, enemies alive and ult usage are not known**, so clips from local mode have fewer tags
  (no clutch, healer-hunt or ult tags). Kill count, streaks, fast kills, victim names, map and match result work.
- **Your name has to be on screen to tell kills from deaths in the kill feed.** The KO list doesn't need it.
- **Detection lags by up to a second or two** (it waits for text reading and for the KO list and feed to agree).
  Clips still start on time because the pre-roll is stretched by the delay.
- **Unusual HUD settings** (a different HUD scale, colour-blind modes, a hidden kill feed) need the matching setting
  here or may not be read. Set *In-game HUD scale* if you changed the game's HUD size.
- **New game updates can move the HUD.** If a patch moves the kill feed or KO list, detection needs a new region
  file. Overwolf would update by itself.
- **HDR** has not been tested yet.

## Test harness (for tuning detection)

The same detector runs over recorded videos and is scored against the true kill times:

```
npm run harness -- match1.mp4 [more.mp4] [--player YourName] [--fps 10] [--no-ocr] [--json report.json]
```

A labels file next to a video (`match1.labels.json`) is picked up automatically:

```json
{
  "playerName": "YourName",
  "kills": [12.7, 14.1, 19.5],
  "deaths": [48.0],
  "practice": false
}
```

Times are seconds into the video, when the KO shows on screen. The report shows precision, recall and how late each
kill was detected, plus which ones were missed or false.

**Good test footage:** whole matches recorded at your normal resolution and HUD settings (OBS or Nvidia's
recorder, 60 fps, any bitrate), plus one Practice Range session, so the app can be checked for not clipping there.
Edited clips (zoomed, cropped, with effects) are much harder than raw footage. For those, `"layout": "tiktok-square"`
or custom `"regions"` tell the harness where the HUD is.

Current results on the reference edits (576×576 TikTok crops with zoom and shake, the hardest case):
precision 90 to 100%, recall 69 to 90%. Raw 1440p footage is expected to do better; that is the next thing to
measure.
