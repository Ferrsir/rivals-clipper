// Rivals Clipper main process.
// Listens to Overwolf GEP for Marvel Rivals, keeps a replay buffer running while you play,
// and saves one clip per kill streak with a JSON sidecar describing what happened.

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ClipEvent, ClipSidecar, HeroRole } from '../shared/types';
import { clipFileName, listClips, sidecarPath, updateSidecar, writeSidecar } from './clip-store';
import { EventLog } from './event-log';
import { exportClip } from './ffmpeg';
import { MatchState, parseMaybeJson } from './match-state';
import { GameProcess, Recorder } from './recorder';
import { DEFAULT_SETTINGS, Settings, ensureFolders, loadSettings, paths, saveSettings } from './settings';
import { StreakTracker } from './streak';

const MARVEL_RIVALS = 24890; // Overwolf game id
const GEP_FEATURES = ['gep_internal', 'game_info', 'match_info'];

interface PendingClip {
  fileName: string;
  trigger: 'auto' | 'manual';
  events: ClipEvent[];
  hero?: string;
  ultUsedBeforeKills: boolean;
  firstKillAt?: number;
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
const recorder = new Recorder((msg, extra) => status(msg, extra));
let streak = makeStreak();
let pending: PendingClip | undefined;
let stopTimer: NodeJS.Timeout | undefined;
let gameProcess: GameProcess | undefined;
let gameRunning = false;
let lastStatus = 'Waiting for Marvel Rivals';
/** Clips saved during the current match, so the match outcome can be added when it ends. */
let matchClips: string[] = [];

function makeStreak() {
  return new StreakTracker({
    preRollMs: settings.preRollSeconds * 1000,
    postRollMs: settings.postRollSeconds * 1000,
    maxClipMs: settings.maxClipSeconds * 1000,
  });
}

function loadHeroRoles(): Record<string, HeroRole> {
  try {
    return JSON.parse(fs.readFileSync(paths(settings.rootFolder).heroRoles, 'utf8'));
  } catch {
    return {};
  }
}

function status(msg: string, extra?: unknown) {
  lastStatus = msg;
  log?.write('status', { msg, extra });
  win?.webContents.send('status', { msg, extra, gameRunning, buffer: recorder.info, clipping: !!pending });
}

function pushClip(clip: ClipSidecar) {
  win?.webContents.send('clip-saved', clip);
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
  log = new EventLog(paths(settings.rootFolder).logs);
}

// ---------- clipping ----------

async function beginClip(trigger: 'auto' | 'manual', now: number, pastMs: number, stopAt: number) {
  if (!recorder.info) {
    status('Kill detected but the replay buffer is not running yet');
    streak.finish();
    return;
  }
  const fileName = clipFileName(new Date(now), 0, state.myHero);
  pending = {
    fileName,
    trigger,
    events: [],
    hero: state.myHero,
    ultUsedBeforeKills: state.ultUsedBefore(now),
  };
  scheduleStop(stopAt, now);
  try {
    await recorder.startClip(fileName, pastMs, (video) => onClipSaved(video));
    status(trigger === 'manual' ? 'Saving manual clip' : 'Kill! Clipping');
  } catch (err) {
    status(`Could not start clip: ${(err as Error).message}`);
    pending = undefined;
    streak.finish();
  }
}

function scheduleStop(stopAt: number, now = Date.now()) {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(() => recorder.stopClip(), Math.max(0, stopAt - now));
}

function onClipSaved(video: { filePath?: string; duration: number; startTimeEpoch: number; error?: unknown }) {
  const clip = pending;
  pending = undefined;
  streak.finish();
  if (stopTimer) clearTimeout(stopTimer);
  if (!clip || !video.filePath || video.error) {
    status('Clip failed to save', video.error);
    return;
  }
  const kills = clip.events.filter((e) => e.type === 'kill').length;
  const info = recorder.info ?? { width: 0, height: 0, fps: 0, micRecorded: false };
  const saved = writeSidecar({
    version: 1,
    id: path.basename(video.filePath).replace(/\.[^.]+$/, ''),
    videoFile: video.filePath,
    createdAt: Date.now(),
    startTimeEpoch: video.startTimeEpoch,
    durationMs: video.duration,
    trigger: clip.trigger,
    hero: clip.hero,
    match: { ...state.context },
    events: clip.events,
    ultUsedBeforeKills: clip.ultUsedBeforeKills,
    video: { width: info.width, height: info.height, fps: info.fps },
    audioTracks: info.micRecorded ? [{ index: 0, label: 'game' }, { index: 1, label: 'mic' }] : [{ index: 0, label: 'game' }],
    useMic: info.micRecorded && settings.useMicInReelsByDefault,
  });
  matchClips.push(saved.videoFile);
  status(`Saved ${kills}-kill clip (score ${saved.score})`);
  pushClip(saved);
}

function handleKill(now: number, total?: number) {
  const action = streak.onKill(now);
  if (action.type === 'start') void beginClip('auto', now, action.pastDurationMs, action.stopAt);
  else if (action.type === 'extend') scheduleStop(action.stopAt, now);
  // Wait briefly so the matching kill_feed line (with the victim) has arrived.
  setTimeout(() => pending?.events.push(state.describeKill(total, now)), 400);
}

function handleManualClip() {
  const now = Date.now();
  if (pending) {
    scheduleStop(now + settings.postRollSeconds * 1000, now);
    return;
  }
  const past = Math.min(30_000, settings.bufferSeconds * 1000 - 2000);
  void beginClip('manual', now, past, now + 2000);
}

// ---------- GEP ----------

function onGameEvent(feature: string, key: string, value: unknown) {
  const now = Date.now();
  log.write('event', { feature, key, value });
  switch (key) {
    case 'kill':
      handleKill(now, Number(parseMaybeJson(value)) || undefined);
      break;
    case 'assist':
      pending?.events.push({ type: 'assist', at: now, myHero: state.myHero });
      if (settings.assistsExtendClip && pending) handleKill(now);
      break;
    case 'death':
      pending?.events.push({ type: 'death', at: now, myHero: state.myHero });
      break;
    case 'kill_feed':
      state.onKillFeed(value, now);
      break;
    case 'match_start':
      state.onMatchStart();
      matchClips = [];
      status('Match started');
      break;
    case 'round_start':
      state.onRoundStart();
      break;
    case 'match_end':
      if (pending) recorder.stopClip();
      status('Match ended');
      break;
  }
}

function onInfoUpdate(feature: string, key: string, value: unknown) {
  log.write('info', { feature, key, value });
  const learned = state.onInfoUpdate(feature, key, value, Date.now());
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
    if (gameId !== MARVEL_RIVALS) return;
    e.enable();
    await gep.setRequiredFeatures(MARVEL_RIVALS, GEP_FEATURES).catch((err) => status('GEP feature setup failed', String(err)));
    status(`${name} detected, game events on`);
    if (!recorder.info) void startBuffer();
  });
  gep.on('elevated-privileges-required', () =>
    status('Marvel Rivals is running as administrator. Run Rivals Clipper as administrator too, or kills will not be detected.'),
  );
  gep.on('new-game-event', (_e, _gameId, data) => onGameEvent(data.feature, data.key, data.value));
  gep.on('new-info-update', (_e, _gameId, data) => onInfoUpdate(data.feature, data.key, data.value));
  gep.on('game-exit', () => {
    gameRunning = false;
    void recorder.stop().then(() => status('Marvel Rivals closed'));
  });
  gep.on('error', (_e, _gameId, err) => status('GEP error', err));
}

// ---------- recorder ----------

async function startBuffer() {
  gameRunning = true;
  try {
    await recorder.start(settings, gameProcess ?? {}, paths(settings.rootFolder).clips);
    status('Replay buffer running. Go get some kills.');
  } catch (err) {
    status(`Replay buffer failed to start: ${(err as Error).message}`);
  }
}

function setupRecorder() {
  const rec = recorder.api;
  void rec.registerGames({ gamesIds: [MARVEL_RIVALS] });
  rec.on('game-launched', (game) => {
    if (game.id !== MARVEL_RIVALS || game.type !== 'Game') return;
    gameProcess = { pid: game.processInfo?.pid, fullPath: game.processInfo?.fullPath };
    void startBuffer();
  });
  rec.on('game-exit', () => {
    gameRunning = false;
    gameProcess = undefined;
  });
  rec.on('performance-warning', (w) => status('Recording is struggling to keep up', w));
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
}

function setupIpc() {
  ipcMain.handle('status', () => ({ msg: lastStatus, gameRunning, buffer: recorder.info, clipping: !!pending }));
  ipcMain.handle('clips:list', () => listClips(paths(settings.rootFolder).clips));
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', async (_e, patch: Partial<Settings>) => {
    const rootChanged = patch.rootFolder && patch.rootFolder !== settings.rootFolder;
    settings = { ...settings, ...patch };
    if (rootChanged) prepareRoot();
    saveSettings(settings);
    fs.mkdirSync(path.dirname(rootPointer), { recursive: true });
    fs.writeFileSync(rootPointer, settings.rootFolder);
    streak = makeStreak();
    registerHotkey();
    if (gameRunning) await startBuffer(); // apply capture changes
    return settings;
  });
  ipcMain.handle('mics:list', () => recorder.listMics().catch(() => []));
  ipcMain.handle('clip:setMic', (_e, videoFile: string, useMic: boolean) => updateSidecar(videoFile, { useMic }));
  ipcMain.handle('clip:rate', (_e, videoFile: string, rating: number) => updateSidecar(videoFile, { rating }));
  ipcMain.handle('clip:show', (_e, videoFile: string) => shell.showItemInFolder(videoFile));
  ipcMain.handle('clip:export', async (_e, videoFile: string, withMic: boolean) => {
    const ff = recorder.ffmpegPath;
    if (!ff) throw new Error('ffmpeg not available yet (recorder package still loading)');
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
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  if (!settings.manualClipHotkey) return;
  const ok = globalShortcut.register(settings.manualClipHotkey, handleManualClip);
  if (!ok) status(`Hotkey ${settings.manualClipHotkey} is taken by another app`);
}

// ---------- boot ----------

app.overwolf.disableAnonymousAnalytics();

app.overwolf.packages.on('ready', (_e, packageName, version) => {
  log?.write('package-ready', { packageName, version });
  if (packageName === 'gep') setupGep();
  if (packageName === 'recorder') setupRecorder();
});
app.overwolf.packages.on('failed-to-initialize', (_e, packageName) => status(`Overwolf package "${packageName}" failed to load`));

app.whenReady().then(() => {
  prepareRoot();
  if (!fs.existsSync(paths(settings.rootFolder).settings)) saveSettings({ ...DEFAULT_SETTINGS, ...settings });
  setupIpc();
  createWindow();
  registerHotkey();
  status(lastStatus);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  void recorder.stop().catch(() => undefined);
});
app.on('window-all-closed', () => app.quit());
