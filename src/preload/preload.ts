import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('clipper', {
  status: () => ipcRenderer.invoke('status'),
  listClips: () => ipcRenderer.invoke('clips:list'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
  listMics: () => ipcRenderer.invoke('mics:list'),
  setMic: (videoFile: string, useMic: boolean) => ipcRenderer.invoke('clip:setMic', videoFile, useMic),
  rate: (videoFile: string, rating: number) => ipcRenderer.invoke('clip:rate', videoFile, rating),
  show: (videoFile: string) => ipcRenderer.invoke('clip:show', videoFile),
  exportClip: (videoFile: string, withMic: boolean) => ipcRenderer.invoke('clip:export', videoFile, withMic),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  onStatus: (cb: (s: unknown) => void) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onClip: (cb: (c: unknown) => void) => ipcRenderer.on('clip-saved', (_e, c) => cb(c)),
});
