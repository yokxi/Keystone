// Processo main di Electron: possiede la connessione all'orchestratore e fa da ponte verso il
// renderer. Il renderer non apre mai il WebSocket e non ha accesso a Node: parla con il main solo
// attraverso window.keystone (preload + contextBridge), e ogni comando viene validato qui.
//
// Sicurezza della finestra: contextIsolation, sandbox, niente nodeIntegration, niente webview,
// navigazione e nuove finestre bloccate, permessi del browser negati, CSP nella pagina.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell, type IpcMainInvokeEvent } from 'electron';
import type { DiffFile, ServerMessage, ViewState } from '@keystone/shared';
import { CHANNELS, type Ack, type ConnectionInfo, type UiEvent } from './api.js';
import { isTrustedSender, validateCommand } from './ipc-validate.js';
import { OrchestratorClient } from './orchestrator-client.js';

const home = process.env.KEYSTONE_HOME?.trim() || path.join(os.homedir(), '.keystone');
const profile = process.env.KEYSTONE_PROFILE?.trim() || 'default';

function orchestratorPort(): number {
  if (process.env.KEYSTONE_PORT) return Number(process.env.KEYSTONE_PORT);
  try {
    const info = JSON.parse(fs.readFileSync(path.join(home, profile, 'orchestrator.json'), 'utf8')) as { port?: number };
    if (info.port) return info.port;
  } catch {
    /* nessun orchestratore attivo: porta predefinita */
  }
  return 7931;
}

const port = orchestratorPort();
const url = `ws://127.0.0.1:${port}`;
const client = new OrchestratorClient({ url, clientName: 'keystone-app', retryDelayMs: 500, maxDelayMs: 5000 });
const rendererHtml = path.join(__dirname, '..', 'renderer', 'index.html');
const smokeDir = process.env.KEYSTONE_SMOKE_DIR;
let win: BrowserWindow | undefined;
let appUrl = '';

// ---- stato verso il renderer (al massimo ~20 aggiornamenti al secondo) -----------------------

let pushTimer: NodeJS.Timeout | undefined;
function pushState(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    win?.webContents.send(CHANNELS.state, client.state);
  }, 50);
}

const pendingDiffs = new Map<string, (files: DiffFile[]) => void>();

client.onState(() => pushState());
client.onMessage$((m: ServerMessage) => {
  if (m.type === 'diff') {
    pendingDiffs.get(m.requestId)?.(m.files);
    pendingDiffs.delete(m.requestId);
  } else if (m.type === 'notify') {
    sendEvent({ type: 'notify', level: m.level, text: m.text });
    // l'utente è altrove: notifica di sistema quando serve una sua decisione
    if (m.level === 'need_user' && win && !win.isFocused() && Notification.isSupported()) new Notification({ title: 'Keystone', body: m.text }).show();
  } else if (m.type === 'agent.say') {
    sendEvent({ type: 'say', agentId: m.agentId, ...(m.to ? { to: m.to } : {}), text: m.text, ts: m.ts });
  }
});

function sendEvent(e: UiEvent): void {
  win?.webContents.send(CHANNELS.event, e);
}

// ---- IPC ----------------------------------------------------------------------------------

function guard(e: IpcMainInvokeEvent): void {
  if (!isTrustedSender(e.senderFrame?.url, appUrl)) throw new Error('mittente IPC non attendibile');
}

let diffSeq = 0;

function registerIpc(): void {
  ipcMain.handle(CHANNELS.getState, (e): ViewState => {
    guard(e);
    return client.state;
  });
  ipcMain.handle(CHANNELS.send, async (e, payload: unknown): Promise<Ack> => {
    guard(e);
    const v = validateCommand(payload);
    if (!v.ok) return { ok: false, error: v.error };
    return client.request(v.msg);
  });
  ipcMain.handle(CHANNELS.diff, async (e, repoId: unknown, worktree: unknown) => {
    guard(e);
    if (typeof repoId !== 'string' || typeof worktree !== 'string') return { ok: false, error: 'richiesta non valida' };
    const requestId = `diff-${++diffSeq}`;
    const files = new Promise<DiffFile[]>((resolve) => pendingDiffs.set(requestId, resolve));
    const ack = await client.request({ type: 'diff.request', requestId, repoId, worktree });
    if (!ack.ok) {
      pendingDiffs.delete(requestId);
      return { ok: false, error: ack.error ?? 'diff non disponibile' };
    }
    return { ok: true, files: await Promise.race([files, new Promise<DiffFile[]>((r) => setTimeout(() => r([]), 30_000))]) };
  });
  ipcMain.handle(CHANNELS.preview, async (e, p: unknown) => {
    guard(e);
    if (typeof p !== 'string' || !p.trim()) return { ok: false, error: 'percorso non valido' };
    const ack = await client.request({ type: 'repo.preview', path: p });
    return ack.ok ? { ok: true, preview: ack.result } : { ok: false, error: ack.error ?? 'anteprima non disponibile' };
  });
  ipcMain.handle(CHANNELS.pickFolder, async (e) => {
    guard(e);
    if (!win) return undefined;
    const r = await dialog.showOpenDialog(win, { title: 'Scegli la cartella del repository', properties: ['openDirectory'] });
    return r.canceled ? undefined : r.filePaths[0];
  });
  ipcMain.handle(CHANNELS.connection, (e): ConnectionInfo => {
    guard(e);
    return { url, canStart: !!orchestratorEntry() };
  });
  ipcMain.handle(CHANNELS.start, (e): Ack => {
    guard(e);
    return startOrchestrator();
  });
}

/** In sviluppo l'app può avviare l'orchestratore dai sorgenti (il packaging arriva in Fase 8). */
function orchestratorEntry(): { root: string; main: string } | undefined {
  const root = path.resolve(__dirname, '..', '..', '..');
  const main = path.join(root, 'orchestrator', 'src', 'main.ts');
  return fs.existsSync(main) && fs.existsSync(path.join(root, 'node_modules', 'tsx')) ? { root, main } : undefined;
}

function startOrchestrator(): Ack {
  const entry = orchestratorEntry();
  if (!entry) return { ok: false, error: 'orchestratore non trovato: avvialo con "npm run orchestrator"' };
  // l'eseguibile di Electron funziona anche come Node con ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, ['--import', 'tsx', entry.main, '--port', String(port), '--profile', profile], {
    cwd: entry.root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KEYSTONE_HOME: home },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { ok: true };
}

// ---- finestra -----------------------------------------------------------------------------

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: 'Keystone',
    backgroundColor: '#14161a',
    show: !smokeDir,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  win.removeMenu();
  win.webContents.on('will-navigate', (ev) => ev.preventDefault());
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    // i link esterni (documentazione) si aprono nel browser, mai nell'app
    if (/^https:\/\//.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  void win.loadFile(rendererHtml, smokeDir ? { search: 'smoke=1' } : {});
  appUrl = `file:///${rendererHtml.replace(/\\/g, '/').replace(/^\//, '')}`;
  win.on('closed', () => (win = undefined));
  if (smokeDir) void runSmoke(win, smokeDir);
}

/** Modalità di verifica: cattura una schermata per ogni vista, in tema chiaro e scuro, poi esce. */
async function runSmoke(w: BrowserWindow, dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  await new Promise<void>((r) => w.webContents.once('did-finish-load', () => r()));
  const start = Date.now();
  while (!client.state.connected && Date.now() - start < 20_000) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, Number(process.env.KEYSTONE_SMOKE_WAIT_MS ?? 1500)));
  const views = (process.env.KEYSTONE_SMOKE_VIEWS ?? 'board,agents,decisions,review,memory,repos,register').split(',');
  for (const theme of ['light', 'dark']) {
    for (const view of views) {
      await w.webContents.executeJavaScript(`window.__keystoneSmoke && window.__keystoneSmoke(${JSON.stringify(view)}, ${JSON.stringify(theme)}, ${JSON.stringify(process.env.KEYSTONE_SMOKE_REPO ?? '')})`);
      await new Promise((r) => setTimeout(r, 700));
      const img = await w.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `${theme}-${view}.png`), img.toPNG());
    }
  }
  app.quit();
}

app.whenReady().then(() => {
  // nessun permesso del browser (fotocamera, notifiche web, ...) per la pagina
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
  });
  registerIpc();
  client.connect();
  createWindow();
});

app.on('window-all-closed', () => {
  client.close();
  app.quit();
});
