// Preload (sandbox, contextIsolation): espone al renderer solo window.keystone, con canali IPC
// fissi. Nessun oggetto di Electron o di Node passa al renderer.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CHANNELS, type KeystoneApi, type UiEvent, type UpdateStatus } from '../main/api.js';
import type { ViewState } from '@keystone/shared';

const api: KeystoneApi = {
  getState: () => ipcRenderer.invoke(CHANNELS.getState),
  onState: (cb) => {
    const h = (_e: IpcRendererEvent, s: ViewState) => cb(s);
    ipcRenderer.on(CHANNELS.state, h);
    return () => ipcRenderer.removeListener(CHANNELS.state, h);
  },
  onEvent: (cb) => {
    const h = (_e: IpcRendererEvent, ev: UiEvent) => cb(ev);
    ipcRenderer.on(CHANNELS.event, h);
    return () => ipcRenderer.removeListener(CHANNELS.event, h);
  },
  send: (cmd) => ipcRenderer.invoke(CHANNELS.send, cmd),
  requestDiff: (repoId, worktree) => ipcRenderer.invoke(CHANNELS.diff, repoId, worktree),
  requestShot: (taskId, shotId) => ipcRenderer.invoke(CHANNELS.shot, taskId, shotId),
  previewRepo: (p) => ipcRenderer.invoke(CHANNELS.preview, p),
  pickFolder: () => ipcRenderer.invoke(CHANNELS.pickFolder),
  connection: () => ipcRenderer.invoke(CHANNELS.connection),
  startOrchestrator: (profile) => ipcRenderer.invoke(CHANNELS.start, profile),
  setDbPassword: (repoId, connectionId, password, destination) => ipcRenderer.invoke(CHANNELS.dbPassword, repoId, connectionId, password, destination),
  dbPasswordKeys: () => ipcRenderer.invoke(CHANNELS.dbPasswordKeys),
  stopOrchestrator: () => ipcRenderer.invoke(CHANNELS.stop),
  updateStatus: () => ipcRenderer.invoke(CHANNELS.updateStatus),
  onUpdate: (cb) => {
    const h = (_e: IpcRendererEvent, s: UpdateStatus) => cb(s);
    ipcRenderer.on(CHANNELS.update, h);
    return () => ipcRenderer.removeListener(CHANNELS.update, h);
  },
  checkUpdates: () => ipcRenderer.invoke(CHANNELS.updateCheck),
  setUpdateCheck: (on) => ipcRenderer.invoke(CHANNELS.updateSet, on),
  openRelease: () => ipcRenderer.invoke(CHANNELS.openRelease),
};

contextBridge.exposeInMainWorld('keystone', api);
