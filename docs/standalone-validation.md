# Standalone validation

The shipping runtime is standard Electron. Overwolf type packages remain development-only for the
legacy integration in source; the installer does not include the Overwolf runtime or packages.
Old engine preferences migrate to built-in detection in standalone builds.

## Verified on November 4, 2026

- Local Windows typecheck and tests, including real Studio renders with FFmpeg 9.
- Bundled FFmpeg screen probe: RTX 5080, NVENC with GPU frames, 3840x1080 monitor.
- Local replay buffer saved a short 60 fps H.264 MP4 with an AAC game/desktop track; the file decoded without errors.
- Windows audio helper enumerated devices and captured the default desktop output. The mic was disabled in this smoke test.
- Screen detector ran at 10 fps with local English OCR enabled, 27 frames analyzed, no dropped frames in a short desktop check.
- Standard Electron NSIS installer built locally, using the audio helper built by GitHub Actions from unchanged native source.

These checks do not measure kill accuracy or prove game-only audio isolation, microphone sync,
performance during gameplay, HDR support, or installability on a friend's PC.

## Before sharing as a dependable clipper

1. Install the GitHub Actions installer on a clean Windows account or another PC.
2. Set the correct monitor and player name. Play a whole match, a Practice Range session, and use F9.
3. Check pre-roll, consecutive kills, assists, trades, deaths, match result, a 90-second streak,
   alt-tab, game exit during a clip, and a resolution change.
4. Verify game-only audio excludes Discord/music, mic is separate and synchronized, and the no-mic export removes it.
5. Record raw gameplay with another recorder and label the actual KO times as described in local-mode.md.
   Run the harness against several complete matches and report precision, recall and latency separately by resolution/HUD scale.
6. Suggested release targets: at least 99% KO precision and 95% recall on held-out full matches,
   zero Practice Range auto-clips after calibration, and no corrupt or missing clips. These are targets, not measured results.
7. Compare average FPS and frame-time spikes with recording off and on. Include NVENC, AMF and CPU fallback where available.
8. Export a real reel with vertical crop, captions, music and mic toggles. Watch and listen to the whole result.

Windows executable signing is separate from Overwolf. The current installer is unsigned;
standard Electron removes the Overwolf service/signing dependency, not Windows reputation checks.
