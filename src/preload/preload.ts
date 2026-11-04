import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('clipper', {
  status: () => ipcRenderer.invoke('status'),
  listClips: () => ipcRenderer.invoke('clips:list'),
  queryClips: (q: unknown) => ipcRenderer.invoke('clips:query', q),
  clipFacets: () => ipcRenderer.invoke('clips:facets'),
  deleteClip: (videoFile: string) => ipcRenderer.invoke('clip:delete', videoFile),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
  listMics: () => ipcRenderer.invoke('mics:list'),
  setMic: (videoFile: string, useMic: boolean) => ipcRenderer.invoke('clip:setMic', videoFile, useMic),
  rate: (videoFile: string, rating: number) => ipcRenderer.invoke('clip:rate', videoFile, rating),
  show: (videoFile: string) => ipcRenderer.invoke('clip:show', videoFile),
  exportClip: (videoFile: string, withMic: boolean) => ipcRenderer.invoke('clip:export', videoFile, withMic),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  ai: {
    status: () => ipcRenderer.invoke('ai:status'),
    install: (provider: string) => ipcRenderer.invoke('ai:install', provider),
    login: (provider: string) => ipcRenderer.invoke('ai:login', provider),
    use: (provider: string) => ipcRenderer.invoke('ai:use', provider),
    logout: (provider: string) => ipcRenderer.invoke('ai:logout', provider),
    ask: (opts: { prompt: string; system?: string; imagePaths?: string[]; expectJson?: boolean }) => ipcRenderer.invoke('ai:ask', opts),
    onStatus: (cb: (s: unknown) => void) => ipcRenderer.on('ai-status', (_e, s) => cb(s)),
  },
  paths: () => ipcRenderer.invoke('app:paths'),
  onStatus: (cb: (s: unknown) => void) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onClip: (cb: (c: unknown) => void) => ipcRenderer.on('clip-saved', (_e, c) => cb(c)),
});

// Generic bridge for the Studio module, so it can add channels without editing this file.
// Only channels starting with "studio:" pass through.
const allowed = (ch: string) => typeof ch === 'string' && ch.startsWith('studio:');
contextBridge.exposeInMainWorld('studioBridge', {
  invoke: (ch: string, ...args: unknown[]) => (allowed(ch) ? ipcRenderer.invoke(ch, ...args) : Promise.reject(new Error(`Blocked channel ${ch}`))),
  on: (ch: string, cb: (...args: unknown[]) => void) => {
    if (allowed(ch)) ipcRenderer.on(ch, (_e, ...args) => cb(...args));
  },
});
