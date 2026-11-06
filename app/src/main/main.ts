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
import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import { dbDestination, type DiffFile, type ServerMessage, type ViewState } from '@keystone/shared';
import { CHANNELS, type Ack, type ConnectionInfo, type UiEvent } from './api.js';
import { DbSecrets } from './db-secrets.js';
import { isTrustedSender, validateCommand } from './ipc-validate.js';
import { earlyExit, findOrchestrator, openStartLog, orchestratorArgs, startLogFile, tailLines } from './orchestrator-launch.js';
import { listProfiles, resolveStartProfile } from './profiles.js';
import { OrchestratorClient } from './orchestrator-client.js';

const home = process.env.KEYSTONE_HOME?.trim() || path.join(os.homedir(), '.keystone');
/** il profilo dell'app: quello che il pulsante "Avvia orchestratore" usa se non se ne sceglie un altro */
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
/** password dei database: cifrate con safeStorage nel profilo dell'app, mai in chiaro */
const dbSecrets = new DbSecrets(path.join(home, profile, 'db-secrets.json'), {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => safeStorage.encryptString(s),
  decrypt: (b) => safeStorage.decryptString(b),
});
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
const pendingShots = new Map<string, (r: { dataUrl?: string; error?: string }) => void>();

client.onState(() => pushState());
client.onMessage$((m: ServerMessage) => {
  if (m.type === 'diff') {
    pendingDiffs.get(m.requestId)?.(m.files);
    pendingDiffs.delete(m.requestId);
  } else if (m.type === 'visual.shot') {
    pendingShots.get(m.requestId)?.({ ...(m.dataUrl ? { dataUrl: m.dataUrl } : {}), ...(m.error ? { error: m.error } : {}) });
    pendingShots.delete(m.requestId);
  } else if (m.type === 'notify') {
    sendEvent({ type: 'notify', level: m.level, text: m.text });
    // l'utente è altrove: notifica di sistema quando serve una sua decisione
    if (m.level === 'need_user' && win && !win.isFocused() && Notification.isSupported()) new Notification({ title: 'Keystone', body: m.text }).show();
  } else if (m.type === 'agent.say') {
    sendEvent({ type: 'say', agentId: m.agentId, ...(m.to ? { to: m.to } : {}), text: m.text, ts: m.ts });
  } else if (m.type === 'snapshot') {
    // a ogni collegamento l'orchestratore riceve le password dei database (le tiene solo in memoria);
    // dopo lo snapshot, quando il client risulta collegato
    setTimeout(() => void pushDbSecrets(), 0);
  }
});

/** Manda all'orchestratore le password delle connessioni che esistono ancora. */
async function pushDbSecrets(): Promise<void> {
  let all: ReturnType<DbSecrets['all']>;
  try {
    all = dbSecrets.all();
  } catch {
    return;
  }
  // solo alle connessioni che vanno ancora dove andavano quando hai scritto la password
  const same = (r: string, c: string, dest: string) => client.state.repos.some((x) => x.id === r && x.db?.some((d) => d.id === c && dbDestination(d) === dest));
  for (const s of all) if (same(s.repoId, s.connectionId, s.destination)) await client.request({ type: 'db.secret', repoId: s.repoId, connectionId: s.connectionId, password: s.password, destination: s.destination });
}

function sendEvent(e: UiEvent): void {
  win?.webContents.send(CHANNELS.event, e);
}

// ---- IPC ----------------------------------------------------------------------------------

function guard(e: IpcMainInvokeEvent): void {
  if (!isTrustedSender(e.senderFrame?.url, appUrl)) throw new Error('mittente IPC non attendibile');
}

let diffSeq = 0;
let shotSeq = 0;

function registerIpc(): void {
  ipcMain.handle(CHANNELS.getState, (e): ViewState => {
    guard(e);
    return client.state;
  });
  ipcMain.handle(CHANNELS.send, async (e, payload: unknown): Promise<Ack> => {
    guard(e);
    const v = validateCommand(payload);
    if (!v.ok) return { ok: false, error: v.error };
    const ack = await client.request(v.msg);
    // una connessione tolta perde anche la password salvata
    if (ack.ok && v.msg.type === 'db.delete') {
      try {
        dbSecrets.set(v.msg.repoId, v.msg.connectionId, null);
      } catch {
        /* id non valido: niente da togliere */
      }
    }
    return ack;
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
  ipcMain.handle(CHANNELS.shot, async (e, taskId: unknown, shotId: unknown) => {
    guard(e);
    if (typeof taskId !== 'string' || typeof shotId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(shotId)) return { ok: false, error: 'richiesta non valida' };
    const requestId = `shot-${++shotSeq}`;
    const res = new Promise<{ dataUrl?: string; error?: string }>((resolve) => pendingShots.set(requestId, resolve));
    const ack = await client.request({ type: 'visual.shot.request', requestId, taskId, shotId });
    if (!ack.ok) {
      pendingShots.delete(requestId);
      return { ok: false, error: ack.error ?? 'schermata non disponibile' };
    }
    const r: { dataUrl?: string; error?: string } = await Promise.race([res, new Promise<{ error: string }>((ok) => setTimeout(() => ok({ error: 'tempo scaduto' }), 30_000))]);
    pendingShots.delete(requestId);
    // al renderer arriva solo un'immagine PNG in base64, mai altro
    if (r.dataUrl && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(r.dataUrl)) return { ok: true, dataUrl: r.dataUrl };
    return { ok: false, error: r.error ?? 'schermata non valida' };
  });
  ipcMain.handle(CHANNELS.dbPassword, async (e, repoId: unknown, connectionId: unknown, password: unknown, destination: unknown): Promise<Ack> => {
    guard(e);
    if (typeof repoId !== 'string' || typeof connectionId !== 'string') return { ok: false, error: 'connessione non valida' };
    if (password !== null && (typeof destination !== 'string' || destination.length > 3000)) return { ok: false, error: 'destinazione non valida' };
    if (password !== null && (typeof password !== 'string' || password.length < 4 || password.length > 1000)) return { ok: false, error: 'password non valida (da 4 a 1000 caratteri)' };
    let where: ReturnType<DbSecrets['set']>;
    try {
      where = dbSecrets.set(repoId, connectionId, password, typeof destination === 'string' ? destination : '');
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const ack = await client.request({ type: 'db.secret', repoId, connectionId, password, ...(password !== null && typeof destination === 'string' ? { destination } : {}) });
    // la password non torna mai al renderer
    return { ok: true, result: { stored: where, orchestrator: ack.ok ? 'ricevuta' : (ack.error ?? 'non collegato') } };
  });
  ipcMain.handle(CHANNELS.dbPasswordKeys, (e): string[] => {
    guard(e);
    return dbSecrets.keys();
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
    return { url, canStart: !!orchestratorEntry(), profile, profiles: listProfiles(home) };
  });
  ipcMain.handle(CHANNELS.start, async (e, requested: unknown): Promise<Ack> => {
    guard(e);
    const r = resolveStartProfile(profile, requested, home);
    if (!r.ok) return { ok: false, error: r.error };
    return startOrchestrator(r.profile);
  });
}

/** L'orchestratore: il bundle nell'app impacchettata, i sorgenti in sviluppo (orchestrator-launch.ts). */
function orchestratorEntry() {
  return findOrchestrator({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appDistDir: __dirname });
}

async function startOrchestrator(startProfile: string): Promise<Ack> {
  const entry = orchestratorEntry();
  if (!entry) return { ok: false, error: 'orchestratore non trovato: avvialo con "npm run orchestrator"' };
  // l'uscita dell'orchestratore va in ~/.keystone/<profilo>/orchestrator-avvio.log: serve a spiegare
  // un avvio fallito (per esempio un config.json non valido)
  const log = startLogFile(home, startProfile);
  let child: ReturnType<typeof spawn>;
  let fd: number | undefined;
  try {
    fd = openStartLog(log, new Date());
    // l'eseguibile di Electron funziona anche come Node con ELECTRON_RUN_AS_NODE; la porta è quella
    // a cui l'app è collegata, il profilo quello dell'app o quello scelto esplicitamente
    child = spawn(process.execPath, orchestratorArgs(entry, port, startProfile), {
      cwd: entry.cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KEYSTONE_HOME: home },
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
  } catch (e) {
    return { ok: false, error: `orchestratore non avviato: ${(e as Error).message}` };
  } finally {
    // il figlio ha il suo handle del file: il padre chiude il proprio in ogni caso
    if (fd !== undefined) fs.closeSync(fd);
  }
  const early = await earlyExit(child, 2500);
  child.unref();
  if (early) {
    const why = early.error ?? tailLines(log).replace(/^Keystone:\s*/m, '');
    const head = early.error ? "l'orchestratore non è partito" : `l'orchestratore si è fermato all'avvio (codice ${early.code})`;
    const lines = [`${head}${why ? ':' : ''}`, ...(why ? [why] : []), `Dettagli in ${log}`];
    return { ok: false, error: lines.join('\n') };
  }
  return { ok: true, result: { profile: startProfile } };
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
