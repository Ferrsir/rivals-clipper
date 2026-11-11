// Rivals Clipper main process.
// Listens to Overwolf GEP for Marvel Rivals (or, in local mode, watches the screen for kills),
// keeps a replay buffer running while you play, and saves one clip per kill streak with a JSON
// sidecar describing what happened.

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ClipEvent, ClipSidecar, HeroRole } from '../shared/types';
import { AiProvider, checkStatus, createAiClient, login, logout, openInstaller } from './ai-auth';
import { clipFileName, isClipFile, sidecarPath, updateSidecar, writeSidecar } from './clip-store';
import { Library, type ClipQuery } from './library';
import { EventLog } from './event-log';
import { exportClip } from './ffmpeg';
import { MatchState, isPracticeMode, parseMaybeJson } from './match-state';
import { GameProcess, Recorder } from './recorder';
import type { BufferInfo, ClipRecorder, SavedVideo } from './capture/types';
import { LocalRecorder, StartCancelled } from './capture/local-recorder';
import { GameWatcher } from './capture/game-watcher';
import { CaptureRecovery } from './capture/recovery';
import { chooseEngine, lateBy, type Engine } from './engine';
import { ScreenDetector } from './vision/screen-detector';
import { DEFAULT_SETTINGS, Settings, ensureFolders, loadSettings, localOptions, paths, sanitizeSettings, saveSettings } from './settings';
import { StreakTracker } from './streak';
import { registerStudio } from './studio/register';
import { findFfmpeg } from './studio/ffmpeg-bin';
import { AiTagger, untagged } from './ai-tagger';
import { installGracefulShutdown, sendIfOpen } from './shutdown';
import { judgeClip, scanDeathScreen, trimClipFile } from './clip-check';
import { Updater } from './updater';

const MARVEL_RIVALS = 24890; // Overwolf game id
const GEP_FEATURES = ['gep_internal', 'game_info', 'match_info'];

interface PendingClip {
  fileName: string;
  trigger: 'auto' | 'manual';
  events: ClipEvent[];
  hero?: string;
  ultUsedBeforeKills: boolean;
  firstKillAt?: number;
  /** The match bar went away for a while during the clip (a round change or the match ending): it ends there. */
  hudBreakAt?: number;
  match: ClipSidecar['match'];
  matchSource: ClipSidecar['match'];
  bufferInfo: BufferInfo;
}

let win: BrowserWindow | undefined;
// Remembers where the library lives if you move it off F:.
const rootPointer = path.join(app.getPath('userData'), 'library-root.txt');
let settings: Settings = loadSettings(readRootPointer());

function readRootPointer(): string {
  try {
    return fs.readFileSync(rootPointer, 'utf8').trim() || DEFAULT_SETTINGS.rootFolder;
  } catch {
    return DEFAULT_SETTINGS.rootFolder;
  }
}
let log: EventLog;
const state = new MatchState(loadHeroRoles());
/** Present only when running inside ow-electron. Plain Electron has no app.overwolf. */
const overwolf = (app as { overwolf?: Electron.App['overwolf'] }).overwolf;
const owRecorder = new Recorder((msg, extra) => status(msg, extra));
// Local mode (no Overwolf): the built-in recorder, a process-list watcher and the screen detector.
const captureRecovery = new CaptureRecovery();
const localRecorder = new LocalRecorder((msg, extra) => status(msg, extra), {
  ffmpeg: localFfmpeg,
  onInterrupted: () => {
    if (engine !== 'local' || !gameRunning) return;
    finishCapture();
    void detector.stop();
    retryBuffer('Screen recording interrupted');
  },
  // A new resolution or aspect ratio mid-game (e.g. stretched 4:3): save the clip in progress, then record
  // and detect at the new size straight away. startBuffer restarts the detector with a new HUD layout.
  onResized: ({ width, height }) => {
    if (engine !== 'local' || !gameRunning) return;
    status(`Game resolution is now ${width}x${height}. Restarting recording and kill detection at the new size.`);
    void detector.stop();
    void startBuffer();
  },
});
const gameWatcher = new GameWatcher();
const detector = new ScreenDetector({
  ffmpeg: localFfmpeg,
  log: (msg, extra) => status(msg, extra),
  dataDir: () => app.getPath('userData'),
  sink: {
    gameEvent: (key, value, at) => engine === 'local' && onGameEvent('screen', key, value, at),
    infoUpdate: (feature, key, value) => engine === 'local' && onInfoUpdate(feature, key, value),
  },
});
/** Which engine is in use. Undefined while 'auto' waits to see if Overwolf's packages load. */
let engine: Engine | undefined;
/** The recorder of the engine in use. */
let recorder: ClipRecorder = owRecorder;
/** Kept after the buffer stops, for a clip that finishes saving afterwards. */
let lastBufferInfo: BufferInfo | undefined;
let streak = makeStreak();
let pending: PendingClip | undefined;
let stopTimer: NodeJS.Timeout | undefined;
let gameProcess: GameProcess | undefined;
let gameRunning = false;
let quitting = false;
let shutdownStudio: (() => Promise<void>) | undefined;
/** Between match_start and match_end. AI tagging waits until this is false. */
let inMatch = false;
/** Your last death (screen or Overwolf), so a clip started by a KO right after it still ends there. */
let lastDeathAt = -Infinity;
/** Since when the match bar has been gone (a round change or the end of the match), or undefined while it shows. */
let hudGoneAt: number | undefined;
let lastStatus = 'Waiting for Marvel Rivals';
/** Set when Overwolf's game events or recorder never loaded, so the window can say why instead of "waiting". */
let packagesProblem: string | undefined;
const readyPackages = new Set<string>();
/** Shared AI client: the Studio and AI tagging call this. */
export const ai = createAiClient(() => settings.aiProvider);
/** Clip Library index. The Studio can call library.query({...}) for ranked, filtered clips. */
export const library = new Library(() => paths(settings.rootFolder).clips);
/** Check for updates / Update: pulls the latest GitHub release and installs it once nothing is recording. */
const updater = new Updater({
  currentVersion: app.getVersion(),
  downloadDir: path.join(app.getPath('temp'), 'rivals-clipper-update'),
  installDir: path.dirname(app.getPath('exe')),
  libraryFolder: () => settings.rootFolder,
  // In built-in mode the process watcher is the truth: gameRunning alone can be left set when a recorder
  // retry or a start races the game closing, and an update then waits forever.
  busy: () => ({ gameRunning: gameRunning && (engine !== 'local' || !!gameWatcher.game), clipping: !!pending || clipChecks.size > 0 }),
  quit: () => app.quit(),
  log: (line) => {
    try {
      fs.appendFileSync(path.join(app.getPath('userData'), 'updater.log'), `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* best effort */
    }
  },
  onChange: (s) => sendIfOpen(win, 'update-status', s),
  packaged: app.isPackaged,
});
/** Any ffmpeg that works: the running recorder's copy, else Overwolf's or the bundled one (see localFfmpeg). */
async function anyFfmpeg(): Promise<string | undefined> {
  if (recorder.ffmpegPath) return recorder.ffmpegPath;
  return localFfmpeg().catch(() => undefined);
}

const tagger = new AiTagger({
  ai,
  ffmpeg: anyFfmpeg,
  read: (videoFile) => {
    try {
      return JSON.parse(fs.readFileSync(sidecarPath(videoFile), 'utf8')) as ClipSidecar;
    } catch {
      return undefined;
    }
  },
  save: (videoFile, info) => updateSidecar(videoFile, { ai: info }),
  canRun: () => !quitting && !inMatch && !pending,
  enabled: () => settings.aiTagging && settings.aiProvider !== 'none',
  onTagged: (clip) => {
    pushClip(clip);
    if (clip.ai?.error) status(`AI tagging failed: ${clip.ai.error}`);
    else status(`AI tagged a clip: ${clip.ai?.summary || clip.ai?.tags.join(', ')}`);
  },
  onStatus: (msg) => status(msg),
});

/** Clips saved during the current match, so the match outcome can be added when it ends. */
let matchClips: string[] = [];

function makeStreak() {
  return new StreakTracker({
    preRollMs: settings.preRollSeconds * 1000,
    postRollMs: settings.postRollSeconds * 1000,
    maxClipMs: settings.maxClipSeconds * 1000,
    chainMs: settings.chainSeconds * 1000,
    // Screen detection reports kills up to ~2 s late (1.6 s on 2026-11-09); keep listening that much longer.
    // Overwolf's events come as they happen.
    get lateMs() {
      return engine === 'overwolf' ? 0 : 2500;
    },
  });
}

function loadHeroRoles(): Record<string, HeroRole> {
  try {
    return JSON.parse(fs.readFileSync(paths(settings.rootFolder).heroRoles, 'utf8'));
  } catch {
    return {};
  }
}

async function localFfmpeg(): Promise<string> {
  const f = await findFfmpeg(owRecorder.ffmpegPath);
  if (!f.ok || !f.path) throw new Error(f.problem ?? 'No ffmpeg found');
  return f.path;
}

function statusPayload(extra?: unknown) {
  return {
    msg: lastStatus,
    extra,
    gameRunning,
    buffer: recorder.info,
    clipping: !!pending,
    engine,
    // In local mode Overwolf not loading is expected, not an error.
    packagesProblem: engine === 'local' ? undefined : packagesProblem,
    detection: engine === 'local' ? detector.status() : undefined,
  };
}

function status(msg: string, extra?: unknown) {
  lastStatus = msg;
  log?.write('status', { msg, extra });
  sendIfOpen(win, 'status', statusPayload(extra));
}

function pushClip(clip: ClipSidecar) {
  sendIfOpen(win, 'clip-saved', clip);
}

// ---------- storage root (F: drive by default) ----------

function prepareRoot() {
  try {
    ensureFolders(settings.rootFolder);
  } catch (err) {
    const fallback = path.join(app.getPath('videos'), 'RivalsClips');
    status(`Could not use ${settings.rootFolder} (${(err as Error).message}). Saving to ${fallback} instead.`);
    settings = { ...settings, rootFolder: fallback };
    ensureFolders(fallback);
  }
  log?.flushSync();
  log = new EventLog(paths(settings.rootFolder).logs);
}

// ---------- clipping ----------

async function beginClip(trigger: 'auto' | 'manual', now: number, pastMs: number, stopAt: number) {
  if (quitting || pending) return;
  if (!recorder.info) {
    status('Kill detected but the replay buffer is not running yet');
    streak.finish();
    return;
  }
  const fileName = clipFileName(new Date(now), 0, state.myHero);
  const clip: PendingClip = pending = {
    fileName,
    trigger,
    events: [],
    hero: state.myHero,
    ultUsedBeforeKills: state.ultUsedBefore(now),
    match: { ...state.context },
    matchSource: state.context,
    bufferInfo: { ...recorder.info },
  };
  scheduleStop(stopAt);
  try {
    // A kill seen on screen is reported a moment after it happened, so reach back that much further.
    await recorder.startClip(fileName, pastMs + lateBy(now, Date.now()), (video) => onClipSaved(video, clip));
    status(trigger === 'manual' ? 'Saving manual clip' : 'Got one! Clipping');
  } catch (err) {
    status(`Could not start clip: ${(err as Error).message}`);
    if (pending === clip) finishCapture();
  }
}

/** Footage kept after your death, and the most a KO right after it can stretch that. */
const DEATH_TAIL_MS = 1000;
const DEATH_GRACE_MS = 2000;

/** You died at `at`: an auto clip ends just after (Ferris: no death screens in clips). Manual clips are left alone. */
function cutAtDeath(at: number) {
  if (!pending || pending.trigger !== 'auto' || !streak.isActive) return;
  const stopAt = streak.cut(at, DEATH_TAIL_MS, DEATH_GRACE_MS);
  if (stopAt !== undefined) scheduleStop(stopAt);
}

/**
 * Where an auto clip should end: the streak's end, but not into a round change or the match ending
 * (the match bar gone, as in the 2026-11-09 18:42 clip that ran on into "CONTROL KRAKOA"). A kill
 * keeps at least a second after it.
 */
function clipEnd(endAt: number | undefined): number | undefined {
  if (!pending || pending.trigger !== 'auto') return endAt;
  const times = pending.events.filter((e) => e.type === 'kill' || e.type === 'assist').map((e) => e.at);
  const firstKill = Math.min(...times, Infinity);
  const lastKill = Math.max(...times, -Infinity);
  // The bar gone right now, after the last kill or for longer than a flicker (heavy effects hide it for a moment);
  // or a break that is already over.
  const goneNow = hudGoneAt !== undefined && (hudGoneAt > lastKill || Date.now() - hudGoneAt >= HUD_FLICKER_MS) ? hudGoneAt : undefined;
  // Gone long before the first kill is not a round change at the end of this clip (more likely the bar isn't being found).
  const near = (t: number | undefined) => (t !== undefined && t >= firstKill - 3000 ? t : Infinity);
  const gone = Math.min(near(pending.hudBreakAt), near(goneNow));
  if (gone === Infinity) return endAt;
  // Kills in the last moment of a round can come after the bar went: they keep a second after them.
  const cut = Math.max(gone + 300, lastKill + 1000);
  return endAt === undefined ? cut : Math.min(endAt, cut);
}

function clipFirstKill(clip: PendingClip): number {
  return Math.min(...clip.events.filter((e) => e.type === 'kill' || e.type === 'assist').map((e) => e.at), Infinity);
}

/** The match bar missing this long is a flicker; this long or more, while a clip records, is a break (a round change). */
const HUD_FLICKER_MS = 1500;
const HUD_BREAK_MS = 4000;

function scheduleStop(stopAt: number) {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(endStreak, Math.max(0, stopAt - Date.now()));
}

function finishCapture() {
  pending = undefined;
  streak.finish();
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = undefined;
}

/** `until`: where the footage should end, when that is earlier than now (the streak's last kill + post-roll). */
function stopCapture(until?: number) {
  finishCapture();
  recorder.stopClip(until);
}

/** The streak's wait is over: save the clip, trimmed to just after its last kill. */
function endStreak() {
  stopCapture(clipEnd(streak.isActive ? streak.currentEndAt : undefined));
}

function onClipSaved(video: SavedVideo, clip: PendingClip) {
  if (pending === clip) finishCapture();
  if (!clip || !video.filePath || video.error) {
    status(video.recoveryFolder ? `Clip failed to save. Recovery files are in ${video.recoveryFolder}` : 'Clip failed to save', video.error);
    return;
  }
  const info = clip.bufferInfo;
  // The local recorder says which tracks it wrote; Overwolf clips follow the buffer settings.
  const tracks = video.audioTracks ?? (info.micRecorded ? ['game', 'mic'] : ['game']);
  const saved = writeSidecar({
    version: 1,
    id: path.basename(video.filePath).replace(/\.[^.]+$/, ''),
    videoFile: video.filePath,
    createdAt: Date.now(),
    startTimeEpoch: video.startTimeEpoch,
    durationMs: video.duration,
    trigger: clip.trigger,
    hero: clip.hero,
    match: { ...clip.match, outcome: clip.matchSource.outcome },
    events: clip.events,
    ultUsedBeforeKills: clip.ultUsedBeforeKills,
    video: { width: info.width, height: info.height, fps: info.fps },
    audioTracks: tracks.map((label, index) => ({ index, label })),
    useMic: tracks.includes('mic') && settings.useMicInReelsByDefault,
  });
  // Listed now, so the match result (which comes a moment after the match ends) reaches it while it is checked.
  if (clip.matchSource === state.context) matchClips.push(saved.videoFile);
  const check = checkSavedClip(saved).then((final) => {
    if (!final) return;
    const k = final.events.filter((e) => e.type === 'kill').length;
    const a = final.events.filter((e) => e.type === 'assist').length;
    status(`Saved ${k}-kill${a ? `, ${a}-assist` : ''} clip (score ${final.score})`);
    pushClip(final);
    tagger.enqueue(final.videoFile);
  }).finally(() => {
    clipChecks.delete(check);
    updater.idle();
  });
  clipChecks.add(check);
}

/** Saved clips still being checked, so closing the app waits for them. */
const clipChecks = new Set<Promise<void>>();

/**
 * Looks at the saved footage for the death screen: cuts the clip just after your death, or drops it when
 * every kill in it happened while you were dead. Returns the clip as it ends up, or undefined if dropped.
 * Any problem leaves the clip as it was.
 */
async function checkSavedClip(clip: ClipSidecar): Promise<ClipSidecar | undefined> {
  if (clip.trigger !== 'auto' || engine !== 'local') return clip;
  try {
    const ff = await localFfmpeg();
    const samples = await scanDeathScreen(ff, clip.videoFile, settings.hudScale);
    // Assists only count when they make clips of their own.
    const counted = clip.events.filter((e) => e.type === 'kill' || (e.type === 'assist' && settings.clipAssists));
    const times = counted.map((e) => (e.at - clip.startTimeEpoch) / 1000);
    const verdict = judgeClip(samples, times, clip.durationMs / 1000);
    if (verdict.action === 'keep') return clip;
    log.write('skip', { reason: 'death screen', action: verdict.action, why: verdict.reason, clip: clip.id });
    if (verdict.action === 'reject') {
      // The Recycle Bin, so a wrong call can be undone. If that fails, the clip stays.
      await shell.trashItem(clip.videoFile);
      for (const f of [sidecarPath(clip.videoFile), clip.videoFile.replace(/\.mp4$/i, '.cover.jpg')]) {
        if (fs.existsSync(f)) await shell.trashItem(f).catch(() => undefined);
      }
      matchClips = matchClips.filter((f) => f !== clip.videoFile);
      // A Library view may have listed it while it was checked (or when the match result came): both re-read on this.
      sendIfOpen(win, 'clip-saved', { removed: clip.videoFile });
      status('Dropped a clip whose kills were in your death replay (moved to the Recycle Bin)');
      return undefined;
    }
    await trimClipFile(ff, clip.videoFile, verdict.untilSec);
    const end = clip.startTimeEpoch + verdict.untilSec * 1000;
    return updateSidecar(clip.videoFile, { durationMs: Math.round(verdict.untilSec * 1000), events: clip.events.filter((e) => e.at <= end) }) ?? clip;
  } catch (err) {
    log.write('skip', { reason: 'clip check failed', error: (err as Error).message, clip: clip.id });
    return clip;
  }
}

let practiceNoticeShown = false;

function handleKill(now: number, total?: number) {
  handleMoment('kill', now, total);
}

/** One of your final hits or (when clipAssists is on) assists: starts or extends a clip. */
function handleMoment(type: 'kill' | 'assist', now: number, total?: number, victim?: string) {
  const notPlaying = state.notPlaying(now);
  if (notPlaying) {
    // Dead and watching a teammate, spectating or a replay: that KO isn't yours.
    log.write('skip', { reason: notPlaying, type, at: now });
    return;
  }
  const autoClip = type === 'kill' || settings.clipAssists;
  if (!autoClip) {
    pending?.events.push({ type: 'assist', at: now, victim, myHero: state.myHero });
    return;
  }
  if (!settings.clipPractice && isPracticeMode(state.context)) {
    log.write('skip', { reason: 'practice', context: state.context });
    if (!practiceNoticeShown) status('Practice Range: auto-clips are off here (manual hotkey still works)');
    practiceNoticeShown = true;
  } else {
    let action = streak.onKill(now);
    if (action.type === 'restart') {
      endStreak();
      action = streak.onKill(now);
    }
    if (action.type === 'start') {
      void beginClip('auto', now, action.pastDurationMs, action.stopAt);
      // A KO in the moment after your death (a projectile landing): its clip still ends at the death.
      if (now - lastDeathAt <= DEATH_GRACE_MS) cutAtDeath(lastDeathAt);
    } else if (action.type === 'extend') scheduleStop(action.stopAt);
    // A kill after a round change (the clip runs into the next round): keep it all rather than lose the kill.
    if (pending?.hudBreakAt !== undefined && now > pending.hudBreakAt + HUD_BREAK_MS) pending.hudBreakAt = undefined;
  }
  // Still record the kill into a clip that is already recording (e.g. a manual one in practice).
  // Wait briefly so the matching kill_feed line (with the victim) has arrived.
  const clip = pending;
  if (clip && type === 'assist') clip.events.push({ type: 'assist', at: now, victim, myHero: state.myHero });
  else if (clip) {
    const event = state.describeKill(total, now);
    clip.events.push(event);
    setTimeout(() => Object.assign(event, state.describeKill(total, now)), 400);
  }
}

function handleManualClip() {
  const now = Date.now();
  if (pending) {
    const action = streak.onKill(now);
    if (action.type === 'extend') scheduleStop(action.stopAt);
    else if (action.type === 'restart') stopCapture();
    if (action.type !== 'restart') return;
  }
  const past = Math.min(30_000, settings.bufferSeconds * 1000 - 2000, Math.max(0, (settings.maxClipSeconds - settings.postRollSeconds) * 1000));
  streak.begin(now, past, now + 2000);
  void beginClip('manual', now, past, now + 2000);
}

// ---------- GEP ----------

/** `at` is when it happened: screen detection reports events a moment after they showed on screen. */
function onGameEvent(feature: string, key: string, value: unknown, at = Date.now()) {
  if (quitting) return;
  const now = at;
  log.write('event', { feature, key, value, ...(feature === 'screen' ? { at, lateMs: Date.now() - at } : {}) });
  switch (key) {
    case 'kill':
      handleKill(now, Number(parseMaybeJson(value)) || undefined);
      break;
    case 'assist': {
      const v = parseMaybeJson<{ victim?: string }>(value);
      handleMoment('assist', now, undefined, v && typeof v === 'object' && typeof v.victim === 'string' ? v.victim : undefined);
      break;
    }
    case 'death':
      state.onDeath(now);
      lastDeathAt = now;
      pending?.events.push({ type: 'death', at: now, myHero: state.myHero });
      cutAtDeath(now);
      break;
    case 'hud':
      // The match bar went away (round change, match end) or came back.
      if (value === false) hudGoneAt ??= now;
      else {
        if (pending && hudGoneAt !== undefined && now - hudGoneAt >= HUD_BREAK_MS && hudGoneAt >= clipFirstKill(pending) - 3000) pending.hudBreakAt ??= hudGoneAt;
        hudGoneAt = undefined;
      }
      break;
    case 'kill_feed':
      state.onKillFeed(value, now);
      break;
    case 'streak': {
      // The game's double/triple/quad/penta callout: the streak isn't over, so keep the clip open.
      const stopAt = pending ? streak.hold(now) : undefined;
      if (stopAt) scheduleStop(stopAt);
      break;
    }
    case 'match_start':
      inMatch = true;
      hudGoneAt = undefined;
      lastDeathAt = -Infinity;
      state.onMatchStart();
      matchClips = [];
      practiceNoticeShown = false;
      status('Match started');
      break;
    case 'round_start':
      state.onRoundStart();
      break;
    case 'match_end':
      inMatch = false;
      tagger.kick();
      if (pending) stopCapture(clipEnd(streak.isActive ? streak.currentEndAt : undefined));
      status('Match ended');
      break;
  }
}

function onInfoUpdate(feature: string, key: string, value: unknown) {
  log.write('info', { feature, key, value });
  const learned = state.onInfoUpdate(feature, key, value, Date.now());
  // The hero seen while the clip records is the clip's hero. A clip can start before the new match's
  // hero is recognised (2026-11-09 19:26: a Magik penta started while the last match's Deadpool was still set).
  if (key === 'local_hero' && pending && state.myHero) pending.hero = state.myHero;
  if (learned) {
    try {
      fs.writeFileSync(paths(settings.rootFolder).heroRoles, JSON.stringify(state.heroRoles, null, 2));
    } catch {
      /* not critical */
    }
  }
  if (key === 'match_outcome' && state.context.outcome) {
    // Tag the clips from the last 20 seconds of the match with the result.
    const cutoff = Date.now() - 20_000;
    for (const f of matchClips) {
      try {
        const c = JSON.parse(fs.readFileSync(sidecarPath(f), 'utf8')) as ClipSidecar;
        if (c.startTimeEpoch + c.durationMs >= cutoff) {
          const updated = updateSidecar(f, { endedMatch: state.context.outcome });
          if (updated) pushClip(updated);
        }
      } catch {
        /* ignore */
      }
    }
  }
}

function setupGep() {
  const gep = app.overwolf.packages.gep;
  gep.on('game-detected', async (e, gameId, name) => {
    if (gameId !== MARVEL_RIVALS || engine === 'local') return;
    e.enable();
    await gep.setRequiredFeatures(MARVEL_RIVALS, GEP_FEATURES).catch((err) => status('GEP feature setup failed', String(err)));
    status(`${name} detected, game events on`);
    if (!recorder.info) void startBuffer();
  });
  gep.on('elevated-privileges-required', () =>
    status('Marvel Rivals is running as administrator. Run Rivals Clipper as administrator too, or kills will not be detected.'),
  );
  gep.on('new-game-event', (_e, _gameId, data) => engine === 'overwolf' && onGameEvent(data.feature, data.key, data.value));
  gep.on('new-info-update', (_e, _gameId, data) => engine === 'overwolf' && onInfoUpdate(data.feature, data.key, data.value));
  gep.on('game-exit', () => {
    if (engine !== 'overwolf') return;
    gameRunning = false;
    inMatch = false;
    tagger.kick();
    stopCapture();
    void recorder.stop().then(() => {
      status('Marvel Rivals closed');
      updater.idle();
    });
  });
  gep.on('error', (_e, _gameId, err) => status('GEP error', err));
}

// ---------- recorder ----------

let bufferStarts = 0;

function retryBuffer(reason: string) {
  if (engine !== 'local' || !gameRunning) return;
  const rec = recorder;
  const run = bufferStarts;
  const delay = captureRecovery.schedule(() => {
    if (engine === 'local' && gameRunning && recorder === rec && bufferStarts === run) void startBuffer();
  });
  status(`${reason}. Retrying recording in ${delay / 1000} seconds.`);
}

async function startBuffer() {
  if (quitting) return;
  stopCapture();
  captureRecovery.clearPending();
  gameRunning = true;
  const rec = recorder;
  const run = ++bufferStarts;
  // The game can close, the engine can change or a newer start can begin while this one waits.
  const overtaken = () => run !== bufferStarts || !gameRunning || recorder !== rec;
  try {
    const info = await rec.start(settings, gameProcess ?? {}, paths(settings.rootFolder).clips);
    if (overtaken()) return;
    captureRecovery.reset();
    lastBufferInfo = info;
    const how = rec.kind === 'local' && info.encoder ? ` (${info.encoder}${info.gpu ? ` on ${info.gpu}` : ''})` : '';
    status(`Replay buffer running${how}. Go get some kills.`);
  } catch (err) {
    if (err instanceof StartCancelled || overtaken()) return;
    status(`Replay buffer failed to start: ${(err as Error).message}`);
    if (rec.kind === 'local') retryBuffer(`Screen recording unavailable: ${(err as Error).message}`);
    return;
  }
  // Local mode: kills come from the screen. Started after the recorder so it knows the capture works.
  if (rec.kind === 'local' && engine === 'local') await detector.start(settings).catch((err) => status(`Kill detection failed to start: ${(err as Error).message}`));
}

function setupRecorder() {
  const rec = owRecorder.api;
  void rec.registerGames({ gamesIds: [MARVEL_RIVALS] });
  rec.on('game-launched', (game) => {
    if (game.id !== MARVEL_RIVALS || game.type !== 'Game' || engine !== 'overwolf') return;
    gameProcess = { pid: game.processInfo?.pid, fullPath: game.processInfo?.fullPath };
    void startBuffer();
  });
  rec.on('game-exit', () => {
    if (engine !== 'overwolf') return;
    gameRunning = false;
    inMatch = false;
    tagger.kick();
    gameProcess = undefined;
  });
  rec.on('performance-warning', (w) => status('Recording is struggling to keep up', w));
}

// ---------- engine: Overwolf or local ----------

/**
 * Picks Overwolf or local mode from the setting and whether Overwolf's packages loaded.
 * Once picked it stays for the session unless the setting changes (`reconsider`).
 */
function applyEngine(reconsider = false): void {
  if (engine && !reconsider) return;
  const next = chooseEngine(localOptions(settings).engine, {
    present: !!overwolf,
    ready: readyPackages.has('gep') && readyPackages.has('recorder'),
    failed: !!packagesProblem,
  });
  if (!next || next === engine) return;
  const prev = engine;
  engine = next;
  log?.write('engine', { engine: next, setting: settings.engine, packagesProblem });
  if (prev) {
    captureRecovery.reset();
    // Switching while running: stop the old engine. Its clip in progress still saves.
    stopCapture();
    const old = recorder;
    gameRunning = false;
    inMatch = false;
    void old.stop().catch(() => undefined);
    if (prev === 'local') {
      gameWatcher.stop();
      void detector.shutdown();
    }
  }
  if (next === 'local') {
    recorder = localRecorder;
    gameWatcher.start();
    status(
      settings.engine === 'local'
        ? 'Local mode: waiting for Marvel Rivals'
        : 'Overwolf is not available, so local mode is on (screen detection + built-in recorder). Waiting for Marvel Rivals.',
    );
  } else {
    recorder = owRecorder;
    status(prev ? 'Switched to Overwolf. Restart Marvel Rivals to start recording with it.' : lastStatus);
  }
}

function setupLocalMode() {
  gameWatcher.on('launched', (game: { pid: number; name: string }) => {
    if (engine !== 'local') return;
    gameProcess = { pid: game.pid };
    status('Marvel Rivals detected');
    void startBuffer();
  });
  gameWatcher.on('exit', () => {
    if (engine !== 'local') return;
    captureRecovery.reset();
    gameRunning = false;
    inMatch = false;
    gameProcess = undefined;
    stopCapture();
    void Promise.all([detector.shutdown(), localRecorder.stop()]).then(() => {
      status('Marvel Rivals closed');
      tagger.kick();
      updater.idle();
    });
  });
}

// ---------- UI + IPC ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Rivals Clipper',
    backgroundColor: '#0f1115',
    webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  void win.loadFile(path.join(__dirname, '../../renderer/index.html'));
  win.once('closed', () => { win = undefined; });
}

function setupIpc() {
  ipcMain.handle('status', () => statusPayload());
  ipcMain.handle('clips:list', () => library.query({ limit: 200 }).items);
  ipcMain.handle('clips:query', (_e, q: ClipQuery) => library.query(q ?? {}));
  ipcMain.handle('clips:facets', () => library.facets());
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', async (_e, patch: Partial<Settings>) => {
    const rootChanged = patch.rootFolder && patch.rootFolder !== settings.rootFolder;
    const engineChanged = patch.engine !== undefined && patch.engine !== settings.engine;
    settings = sanitizeSettings({ ...settings, ...patch }, settings);
    if (rootChanged) prepareRoot();
    saveSettings(settings);
    fs.mkdirSync(path.dirname(rootPointer), { recursive: true });
    fs.writeFileSync(rootPointer, settings.rootFolder);
    streak = makeStreak();
    registerHotkey();
    const engineBefore = engine;
    applyEngine(engineChanged);
    if (gameRunning && engine === engineBefore) await startBuffer(); // apply capture changes
    return settings;
  });
  ipcMain.handle('mics:list', () => recorder.listMics().catch(() => []));
  // Clip actions only ever touch .mp4 files inside the clips folder, whatever the window sends.
  const clipOnly = (videoFile: unknown): string => {
    if (!isClipFile(videoFile, paths(settings.rootFolder).clips)) throw new Error('That file is not a clip in your library.');
    return videoFile;
  };
  ipcMain.handle('clip:setMic', (_e, videoFile: string, useMic: boolean) => updateSidecar(clipOnly(videoFile), { useMic: !!useMic }));
  ipcMain.handle('clip:rate', (_e, videoFile: string, rating: number) => {
    const r = Math.round(Number(rating));
    if (!(r >= 1 && r <= 5)) throw new Error('Rating must be 1 to 5 stars.');
    return updateSidecar(clipOnly(videoFile), { rating: r });
  });
  ipcMain.handle('clip:aiTag', (_e, videoFile: string) => tagger.tagNow(clipOnly(videoFile)));
  ipcMain.handle('clips:aiTagUntagged', () => {
    const list = untagged(library.query({ limit: 100_000 }).items);
    for (const c of list) tagger.enqueue(c.videoFile);
    return list.length;
  });
  ipcMain.handle('clip:show', (_e, videoFile: string) => shell.showItemInFolder(clipOnly(videoFile)));
  /** Moves the clip and its sidecar to the Recycle Bin, so a mistake can be undone there. */
  ipcMain.handle('clip:delete', async (_e, videoFile: string) => {
    const file = clipOnly(videoFile);
    for (const f of [file, sidecarPath(file)]) if (fs.existsSync(f)) await shell.trashItem(f);
    status('Clip moved to the Recycle Bin');
    return true;
  });
  ipcMain.handle('clip:export', async (_e, rawFile: string, withMic: boolean) => {
    const videoFile = clipOnly(rawFile);
    const ff = await anyFfmpeg();
    if (!ff) throw new Error('No ffmpeg found to export with. Reinstall the app or set FFMPEG_PATH.');
    const c = JSON.parse(fs.readFileSync(sidecarPath(videoFile), 'utf8')) as ClipSidecar;
    const out = await exportClip(ff, videoFile, paths(settings.rootFolder).exports, { withMic, hasMicTrack: c.audioTracks.length > 1 });
    shell.showItemInFolder(out);
    return out;
  });
  ipcMain.handle('folder:pick', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath: settings.rootFolder });
    return r.canceled ? undefined : r.filePaths[0];
  });
  ipcMain.handle('folder:open', () => shell.openPath(settings.rootFolder));

  // ---- AI sign-in (Claude Code or Codex, on the user's own account) ----
  ipcMain.handle('ai:status', async () => ({
    provider: settings.aiProvider,
    onboarded: settings.onboarded,
    claude: await checkStatus('claude'),
    codex: await checkStatus('codex'),
  }));
  ipcMain.handle('ai:install', (_e, provider: AiProvider) => openInstaller(provider));
  ipcMain.handle('ai:login', async (_e, provider: AiProvider) => {
    const result = await login(provider, s => sendIfOpen(win, 'ai-status', s));
    if (result.loggedIn) {
      settings = { ...settings, aiProvider: provider, onboarded: true };
      saveSettings(settings);
    }
    return result;
  });
  ipcMain.handle('ai:use', (_e, provider: AiProvider | 'none') => {
    settings = { ...settings, aiProvider: provider, onboarded: true };
    saveSettings(settings);
    return settings;
  });
  ipcMain.handle('ai:logout', async (_e, provider: AiProvider) => {
    await logout(provider);
    if (settings.aiProvider === provider) settings = { ...settings, aiProvider: 'none' };
    saveSettings(settings);
    return checkStatus(provider);
  });
  ipcMain.handle('ai:ask', (_e, opts: Parameters<typeof ai.ask>[0]) => ai.ask(opts));
  ipcMain.handle('app:paths', () => paths(settings.rootFolder));
  ipcMain.handle('update:status', () => updater.status);
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:install', (_e, force?: unknown) => updater.install(force === true));
  ipcMain.handle('update:cancel', () => updater.cancel());
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  if (!settings.manualClipHotkey) return;
  const ok = globalShortcut.register(settings.manualClipHotkey, handleManualClip);
  if (!ok) status(`Hotkey ${settings.manualClipHotkey} is taken by another app`);
}

// ---------- boot ----------

overwolf?.disableAnonymousAnalytics();

const PACKAGES_HELP =
  'Overwolf blocked its game-event and recording packages, so kills cannot be detected or recorded. ' +
  'This happens when the app is not signed by Overwolf. Run it from source with your Overwolf dev key ' +
  '(see docs/run-with-overwolf.md), or install a build signed with Overwolf keys.';

function reportPackagesProblem(reason: string) {
  packagesProblem = `${PACKAGES_HELP} (${reason})`;
  if (engine !== 'local') status('Overwolf packages did not load');
  applyEngine();
}

if (overwolf) {
  overwolf.packages.on('ready', (_e, packageName, version) => {
    log?.write('package-ready', { packageName, version });
    readyPackages.add(packageName);
    if (readyPackages.has('gep') && readyPackages.has('recorder') && packagesProblem) {
      packagesProblem = undefined;
      status(lastStatus);
    }
    if (packageName === 'gep') setupGep();
    if (packageName === 'recorder') setupRecorder();
    applyEngine();
  });
  overwolf.packages.on('failed-to-initialize', (_e, packageName) => reportPackagesProblem(`"${packageName}" failed to initialize`));
  // When Overwolf rejects the app signature it skips package loading without any event, so watch for silence too.
  setTimeout(() => {
    const missing = ['gep', 'recorder'].filter((p) => !readyPackages.has(p));
    if (missing.length) reportPackagesProblem(`${missing.join(' and ')} not loaded after 60 seconds`);
  }, 60_000);
}

app.whenReady().then(() => {
  // Standalone builds also migrate settings saved by the old Overwolf installer.
  if (!overwolf) settings = { ...settings, engine: 'local' };
  prepareRoot();
  if (!fs.existsSync(paths(settings.rootFolder).settings)) saveSettings({ ...DEFAULT_SETTINGS, ...settings });
  setupIpc();
  shutdownStudio = registerStudio({ getSettings: () => settings, ffmpegPath: () => recorder.ffmpegPath, ai });
  createWindow();
  registerHotkey();
  setupLocalMode();
  status(lastStatus);
  applyEngine();
  // Look for a new version shortly after start and every 6 hours. Only checks: installing is your call.
  setTimeout(() => void updater.check(), 15_000);
  setInterval(() => void updater.check(), 6 * 60 * 60_000).unref();
});

installGracefulShutdown(app, async () => {
  quitting = true;
  gameRunning = false;
  bufferStarts++;
  captureRecovery.reset();
  globalShortcut.unregisterAll();
  gameWatcher.stop();
  if (stopTimer) clearTimeout(stopTimer);
  status('Closing: finishing saved clips…');
  stopCapture();
  const results = await Promise.allSettled([detector.shutdown(), recorder.stop(), shutdownStudio?.()]);
  // A clip saved just now may still be under its death-screen check (a trim or a move to the Recycle Bin).
  await Promise.race([Promise.allSettled([...clipChecks]), new Promise((r) => setTimeout(r, 15_000))]);
  for (const result of results) if (result.status === 'rejected') log?.write('shutdown-error', String(result.reason));
  // An update that was waiting for the game or a clip installs now that everything has stopped.
  updater.onQuit();
  log?.flushSync();
}, error => {
  log?.write('shutdown-error', String(error));
  log?.flushSync();
});
app.on('window-all-closed', () => app.quit());
