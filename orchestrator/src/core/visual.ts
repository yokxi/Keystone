// Verifica visuale nella review (Fase 6b). La esegue KEYSTONE, non l'agente:
//   1. avvia l'app dal branch di partenza (in un worktree temporaneo, fuori dal tuo checkout);
//   2. esegue con Playwright i passaggi dichiarati dal worker e cattura le schermate "prima";
//   3. ferma l'app e ripete dal worktree dell'agente: schermate "dopo";
//   4. annota ogni problema di avvio o di esecuzione.
// Solo app web, solo rete locale:
//   - l'URL configurato deve essere locale (localhost, 127.0.0.1, [::1]);
//   - il browser blocca ogni richiesta che non sia locale (service worker bloccati);
//   - il processo dell'app riceve un proxy inesistente per HTTP/HTTPS: è un freno, non un isolamento
//     del sistema operativo (vedi docs/verifica-visuale.md).
// Le schermate stanno in ~/.keystone/<profilo>/visual/, mai nel repository, nei log o nelle trascrizioni.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DIAG_LIMITS, type PageDiagnostics, type Repo, type Task, type VisualCheck, type VisualConfig, type VisualReport, type VisualSide } from '@keystone/shared';
import type { Page } from 'playwright-core';
import { ensureDir } from '../util/fsx.js';
import { git } from '../util/git.js';
import { killTree } from '../util/proc.js';
import { lastLines, truncate } from '../util/text.js';
import { isSecretVar } from './agent-env.js';

export type { VisualConfig };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** L'URL dell'app è locale? (http/https su localhost, 127.0.0.1 o ::1) */
export function isLocalUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return (x.protocol === 'http:' || x.protocol === 'https:') && LOCAL_HOSTS.has(x.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Una richiesta del browser è ammessa? Solo locale, più gli schemi interni del browser. */
export function browserRequestAllowed(u: string, appUrl: string): boolean {
  if (/^(data|blob|about):/i.test(u)) return true;
  // solo l'origine dell'app (stesso host e stessa porta): gli altri servizi locali dell'utente
  // (database, Docker, altri dev server) non sono raggiungibili dalla pagina
  try {
    const x = new URL(u);
    const app = new URL(appUrl);
    const proto = x.protocol === 'ws:' ? 'http:' : x.protocol === 'wss:' ? 'https:' : x.protocol;
    return isLocalUrl(appUrl) && proto === app.protocol && x.host.toLowerCase() === app.host.toLowerCase();
  } catch {
    return false;
  }
}

function hostOf(u: string): string {
  try {
    return new URL(u).host || u.slice(0, 60);
  } catch {
    return u.slice(0, 60);
  }
}

/** Valida la configurazione di un repository; restituisce l'errore da mostrare. */
export function validateVisualConfig(c: VisualConfig): string | undefined {
  if (!c.command.trim()) return 'manca il comando di avvio';
  if (!isLocalUrl(c.url)) return `l'URL deve essere locale (http://localhost:… o http://127.0.0.1:…): ${c.url}`;
  return undefined;
}

/** Il percorso di una pagina, sempre sulla stessa origine dell'app. */
export function pageUrl(base: string, p: string): string {
  const rel = p.trim() || '/';
  if (!rel.startsWith('/') || rel.startsWith('//') || /^\/\\/.test(rel)) throw new Error(`percorso non valido "${p}": deve iniziare con / (stessa app)`);
  const u = new URL(rel, base);
  if (u.origin !== new URL(base).origin) throw new Error(`percorso fuori dall'app: ${p}`);
  return u.toString();
}

export interface BrowserChoice {
  /** canale di un browser installato (msedge, chrome) oppure il Chromium scaricato in ~/.keystone */
  channel?: string;
  executablePath?: string;
  label: string;
}

/** I browser utilizzabili, in ordine: Edge, Chrome, Chromium di Playwright in ~/.keystone. */
export function findBrowser(browsersDir: string): BrowserChoice | undefined {
  const pf = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
  const exists = (p: string) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };
  if (process.platform === 'win32') {
    if (pf.some((b) => exists(path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe')))) return { channel: 'msedge', label: 'Microsoft Edge (profilo temporaneo)' };
    if (pf.some((b) => exists(path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')))) return { channel: 'chrome', label: 'Google Chrome (profilo temporaneo)' };
  } else if (process.platform === 'darwin') {
    if (exists('/Applications/Google Chrome.app')) return { channel: 'chrome', label: 'Google Chrome (profilo temporaneo)' };
    if (exists('/Applications/Microsoft Edge.app')) return { channel: 'msedge', label: 'Microsoft Edge (profilo temporaneo)' };
  } else if (['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].some(exists)) return { channel: 'chrome', label: 'Google Chrome (profilo temporaneo)' };
  // Chromium scaricato con il permesso dell'utente
  if (exists(browsersDir)) {
    for (const d of fs.readdirSync(browsersDir).filter((x) => /^chromium(_headless_shell)?-\d+$/.test(x)).sort().reverse()) {
      for (const rel of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(browsersDir, d, rel);
        if (exists(p)) return { executablePath: p, label: 'Chromium di Playwright' };
      }
    }
  }
  return undefined;
}

/** Scarica Chromium in ~/.keystone (SOLO dopo il permesso dell'utente). */
export function installChromium(browsersDir: string): Promise<{ ok: boolean; output: string }> {
  const req = createRequire(import.meta.url);
  const cli = path.join(path.dirname(req.resolve('playwright-core/package.json')), 'cli.js');
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, 'install', 'chromium'], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: ensureDir(browsersDir) }, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (out += d.toString()));
    p.on('exit', (code) => resolve({ ok: code === 0, output: lastLines(out, 10) }));
    p.on('error', (e) => resolve({ ok: false, output: e.message }));
  });
}

/** Ferma l'app e tutti i processi che ha avviato. */
function stopApp(p: ChildProcess): void {
  if (p.exitCode === null && p.pid) killTree(p.pid);
}

/** Ambiente dell'app: quello sicuro degli agenti, senza credenziali, con la rete esterna verso un proxy inesistente. */
export function appEnv(base: Record<string, string | undefined>, url: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !isSecretVar(k)) out[k] = v;
  const dead = 'http://127.0.0.1:9';
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) out[k] = dead;
  out.NO_PROXY = out.no_proxy = 'localhost,127.0.0.1,::1';
  const port = new URL(url).port;
  if (port) out.PORT = port;
  out.BROWSER = 'none'; // dev server che aprono il browser da soli
  return out;
}

/** L'URL risponde? (qualsiasi risposta sotto 500) */
async function responds(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
    return r.status < 500;
  } catch {
    return false;
  }
}

/** Aspetta che l'URL smetta di rispondere (la porta torna libera dopo aver fermato l'app). */
async function waitFree(url: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await responds(url))) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** Avvia l'app e aspetta che risponda; restituisce il processo e il suo output. */
async function startApp(dir: string, cfg: VisualConfig, env: Record<string, string>): Promise<{ proc: ChildProcess; output: () => string; error?: string }> {
  let out = '';
  const proc = spawn(cfg.command, { cwd: dir, env, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d: Buffer) => (out = (out + d.toString()).slice(-20_000)));
  proc.stderr!.on('data', (d: Buffer) => (out = (out + d.toString()).slice(-20_000)));
  // senza questo listener un errore di avvio (es. cartella inesistente) farebbe cadere l'orchestratore
  let spawnError: string | undefined;
  proc.on('error', (e) => (spawnError = e.message));
  const deadline = Date.now() + cfg.startTimeoutSec * 1000;
  while (Date.now() < deadline) {
    if (spawnError) return { proc, output: () => out, error: `l'app non si è avviata: ${spawnError}` };
    if (proc.exitCode !== null) return { proc, output: () => out, error: `l'app è terminata subito (codice ${proc.exitCode})` };
    if (await responds(cfg.url)) return { proc, output: () => out };
    await new Promise((r) => setTimeout(r, 400));
  }
  return { proc, output: () => out, error: `l'app non risponde su ${cfg.url} entro ${cfg.startTimeoutSec} s` };
}

type Side = 'before' | 'after' | 'try';
const SIDE_LABEL: Record<Side, string> = { before: 'prima', after: 'dopo', try: 'prova' };

const VIEWPORT = { width: 1280, height: 800 };
/** Altezza massima di una schermata, in pixel. */
const MAX_SHOT_HEIGHT = 4000;

/** Il testo di un errore JavaScript: messaggio e le prime righe dello stack. */
function errorText(e: Error): string {
  const stack = (e.stack ?? '')
    .split('\n')
    .slice(1, 4)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  return `${e.message || e.name || 'errore'}${stack ? `\n${stack}` : ''}`;
}

/**
 * Raccoglie console, errori JavaScript non gestiti e richieste fallite (errori di rete, 4xx/5xx,
 * richieste bloccate perché non locali) di una pagina, entro i limiti di DIAG_LIMITS.
 */
function collectDiagnostics(page: Page): PageDiagnostics {
  const d: PageDiagnostics = { console: [], errors: [], failedRequests: [] };
  const add = <T>(list: T[], max: number, item: T) => {
    if (list.length < max) list.push(item);
    else d.truncated = true;
  };
  page.on('console', (m) => {
    // il browser scrive in console ogni risorsa non caricata: è già tra le richieste fallite
    if (/^Failed to load resource:/.test(m.text())) return;
    add(d.console, DIAG_LIMITS.console, { type: m.type().slice(0, 20), text: truncate(m.text(), DIAG_LIMITS.text) });
  });
  page.on('pageerror', (e) => add(d.errors, DIAG_LIMITS.errors, truncate(errorText(e), DIAG_LIMITS.error)));
  page.on('requestfailed', (r) => {
    const failure = r.failure()?.errorText ?? 'errore di rete';
    add(d.failedRequests, DIAG_LIMITS.requests, { url: truncate(r.url(), DIAG_LIMITS.url), method: r.method(), failure: truncate(failure, 200), ...(/BLOCKED_BY_CLIENT/i.test(failure) ? { blocked: true } : {}) });
  });
  page.on('response', (r) => {
    if (r.status() >= 400) add(d.failedRequests, DIAG_LIMITS.requests, { url: truncate(r.url(), DIAG_LIMITS.url), method: r.request().method(), status: r.status() });
  });
  return d;
}

/** Esegue i controlli in una istanza dell'app già avviata: schermate e diagnostica per pagina. */
async function captureSide(browser: BrowserChoice, cfg: VisualConfig, checks: VisualCheck[], side: Side, shotsDir: string, opts: { stepTimeoutMs: number; deadline?: number }) {
  const { chromium } = await import('playwright-core');
  const b = await chromium.launch({ headless: true, ...(browser.channel ? { channel: browser.channel } : {}), ...(browser.executablePath ? { executablePath: browser.executablePath } : {}) });
  const blocked = new Set<string>();
  const results: VisualSide[] = [];
  const late = () => opts.deadline !== undefined && Date.now() > opts.deadline;
  const timeout = () => (opts.deadline === undefined ? opts.stepTimeoutMs : Math.max(1000, Math.min(opts.stepTimeoutMs, opts.deadline - Date.now())));
  try {
    const ctx = await b.newContext({ viewport: VIEWPORT, serviceWorkers: 'block', acceptDownloads: false });
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (browserRequestAllowed(u, cfg.url)) return route.continue();
      blocked.add(hostOf(u));
      return route.abort('blockedbyclient');
    });
    // anche i WebSocket: quelli non locali vengono chiusi senza mai connettersi
    await ctx.routeWebSocket(/.*/, (ws) => {
      if (browserRequestAllowed(ws.url(), cfg.url)) ws.connectToServer();
      else {
        blocked.add(hostOf(ws.url()));
        void ws.close({ code: 1008, reason: "bloccato da Keystone: solo l'origine dell'app" });
      }
    });
    for (let i = 0; i < checks.length; i++) {
      const c = checks[i]!;
      if (late()) {
        results.push({ error: 'non eseguita: tempo massimo della prova superato' });
        continue;
      }
      const page = await ctx.newPage();
      const diagnostics = collectDiagnostics(page);
      let error: string | undefined;
      try {
        page.setDefaultTimeout(timeout());
        await page.goto(pageUrl(cfg.url, c.path), { waitUntil: 'load' });
        for (const st of c.steps) {
          if (late()) throw new Error('tempo massimo della prova superato');
          page.setDefaultTimeout(timeout());
          if (st.action === 'goto') await page.goto(pageUrl(cfg.url, st.path), { waitUntil: 'load' });
          else if (st.action === 'click') await page.locator(st.selector).first().click();
          else if (st.action === 'fill') await page.locator(st.selector).first().fill(st.value);
          else if (st.action === 'press') await page.locator(st.selector).first().press(st.key);
          else if (st.action === 'wait') await page.locator(st.selector).first().waitFor({ state: 'visible' });
        }
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
      } catch (e) {
        error = truncate(((e as Error).message ?? String(e)).split('\n')[0]!, 300);
      }
      // la schermata si cattura anche se un passaggio è fallito: mostra dove si è fermata
      const id = `${side}-${i + 1}`;
      try {
        // pagina intera, ma al massimo MAX_SHOT_HEIGHT pixel: le pagine lunghissime pesano e non servono
        const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)).catch(() => VIEWPORT.height);
        await page.screenshot({ path: path.join(shotsDir, `${id}.png`), fullPage: true, clip: { x: 0, y: 0, width: VIEWPORT.width, height: Math.max(1, Math.min(height, MAX_SHOT_HEIGHT)) } });
        results.push({ shot: { id, ...(error ? { error } : {}) }, ...(error ? { error } : {}), diagnostics });
      } catch (e) {
        results.push({ error: error ?? `schermata non catturata: ${(e as Error).message}`, diagnostics });
      }
      await page.close();
    }
  } finally {
    await b.close();
  }
  return { results, blocked: [...blocked] };
}

/** Un lato: avvia l'app nella cartella, esegue le pagine, ferma l'app. */
async function runSide(o: {
  repoPath: string;
  dir: string;
  side: Side;
  cfg: VisualConfig;
  env: Record<string, string>;
  checks: VisualCheck[];
  browser: BrowserChoice;
  shotsDir: string;
  stepTimeoutMs: number;
  deadline?: number;
}): Promise<{ results?: VisualSide[]; problems: string[] }> {
  const problems: string[] = [];
  const label = SIDE_LABEL[o.side];
  let linked: string | undefined;
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  let results: VisualSide[] | undefined;
  try {
    linked = await linkDependencies(o.repoPath, o.dir);
    app = await startApp(o.dir, o.cfg, o.env);
    if (app.error) problems.push(`${label}: ${app.error}${app.output().trim() ? `\n${lastLines(app.output(), 8)}` : ''}`);
    else {
      const r = await captureSide(o.browser, o.cfg, o.checks, o.side, o.shotsDir, { stepTimeoutMs: o.stepTimeoutMs, ...(o.deadline !== undefined ? { deadline: o.deadline } : {}) });
      results = r.results;
      if (r.blocked.length) problems.push(`${label}: richieste di rete esterne bloccate (${r.blocked.slice(0, 5).join(', ')})`);
    }
  } catch (e) {
    problems.push(`${label}: ${truncate((e as Error).message ?? String(e), 300)}`);
  } finally {
    if (app) stopApp(app.proc);
    if (linked && !removeLink(linked)) problems.push(`${label}: collegamento a node_modules non rimosso (${linked}): verrà tolto al prossimo avvio`);
    if (!(await waitFree(o.cfg.url, 10_000))) problems.push(`${label}: l'app risponde ancora su ${o.cfg.url} dopo essere stata fermata`);
  }
  return { ...(results ? { results } : {}), problems };
}

const busyNote = (url: string) => `qualcosa risponde già su ${url} prima dell'avvio: ferma l'altra app o scegli un'altra porta`;

export interface VisualRunInput {
  repo: Repo & { visual: VisualConfig };
  task: Task;
  /** il worktree dell'agente (stato "dopo") */
  worktreePath: string;
  /** il commit di partenza (stato "prima") */
  baseRef: string;
  /** cartella delle schermate di questo task: ~/.keystone/<profilo>/visual/<task> */
  shotsDir: string;
  browser: BrowserChoice;
  env: Record<string, string | undefined>;
  stepTimeoutMs?: number;
  now: () => number;
}

/** La verifica completa: prima (branch di partenza) e dopo (worktree dell'agente). */
export async function runVisual(input: VisualRunInput): Promise<VisualReport> {
  const checks = input.task.visualChecks ?? [];
  const problems: string[] = [];
  const cfg = input.repo.visual;
  const report = (status: VisualReport['status'], note?: string, rows: VisualReport['checks'] = []): VisualReport => ({ status, ...(note ? { note } : {}), at: input.now(), checks: rows, problems });
  if (!checks.length) return report('skipped', 'il worker non ha indicato pagine da verificare (submit_report con visual_checks)');
  const bad = validateVisualConfig(cfg);
  if (bad) return report('skipped', `configurazione non valida: ${bad}`);

  // le schermate di una verifica precedente dello stesso task vengono sostituite
  fs.rmSync(input.shotsDir, { recursive: true, force: true });
  ensureDir(input.shotsDir);
  const baseDir = path.join(path.dirname(input.shotsDir), `${path.basename(input.shotsDir)}-base`);
  const sides: Partial<Record<'before' | 'after', VisualSide[]>> = {};
  const env = appEnv(input.env, cfg.url);
  // un'altra app risponde già sull'URL: le schermate sarebbero sue, non del branch
  if (await responds(cfg.url)) return report('failed', busyNote(cfg.url));
  try {
    // il branch di partenza, in un worktree temporaneo (il tuo checkout non viene toccato)
    await removeBaseWorktree(input.repo.path, baseDir);
    const add = await git(input.repo.path, ['worktree', 'add', '--detach', baseDir, input.baseRef], { allowFail: true });
    if (add.code !== 0) problems.push(`impossibile preparare il branch di partenza: ${truncate(add.stderr.trim(), 200)}`);
    for (const [side, dir] of [['before', add.code === 0 ? baseDir : undefined], ['after', input.worktreePath]] as const) {
      if (!dir) continue;
      const r = await runSide({ repoPath: input.repo.path, dir, side, cfg, env, checks, browser: input.browser, shotsDir: input.shotsDir, stepTimeoutMs: input.stepTimeoutMs ?? 10_000 });
      problems.push(...r.problems);
      if (r.results) sides[side] = r.results;
    }
  } finally {
    await removeBaseWorktree(input.repo.path, baseDir);
  }
  const rows = checks.map((c, i) => ({
    name: c.name,
    caption: c.caption,
    before: sides.before?.[i] ?? { error: 'non eseguita' },
    after: sides.after?.[i] ?? { error: 'non eseguita' },
  }));
  if (!sides.before && !sides.after) return report('failed', "l'app non si è avviata", rows);
  return report('done', undefined, rows);
}

export interface VisualTryInput {
  repo: Repo & { visual: VisualConfig };
  checks: VisualCheck[];
  /** il worktree del worker */
  worktreePath: string;
  /** cartella delle schermate delle prove: ~/.keystone/<profilo>/visual/<task>-try */
  shotsDir: string;
  browser: BrowserChoice;
  env: Record<string, string | undefined>;
  /** tempo massimo per i passaggi della prova (l'avvio ha il suo limite) */
  maxMs: number;
  stepTimeoutMs?: number;
}

export interface VisualTryResult {
  status: 'done' | 'failed';
  note?: string;
  pages: Array<{ name: string; caption: string; side: VisualSide }>;
  problems: string[];
  durationMs: number;
}

/**
 * "Prova interfaccia" per il worker: Keystone avvia l'app dal suo worktree, esegue i passaggi e
 * restituisce esito, console, errori, richieste fallite e schermate. Solo il lato del worktree.
 */
export async function runTry(input: VisualTryInput): Promise<VisualTryResult> {
  const start = Date.now();
  const cfg = input.repo.visual;
  const done = (status: VisualTryResult['status'], note: string | undefined, pages: VisualTryResult['pages'], problems: string[]): VisualTryResult => ({ status, ...(note ? { note } : {}), pages, problems, durationMs: Date.now() - start });
  const bad = validateVisualConfig(cfg);
  if (bad) return done('failed', `configurazione non valida: ${bad}`, [], []);
  fs.rmSync(input.shotsDir, { recursive: true, force: true });
  ensureDir(input.shotsDir);
  if (await responds(cfg.url)) return done('failed', busyNote(cfg.url), [], []);
  const r = await runSide({
    repoPath: input.repo.path,
    dir: input.worktreePath,
    side: 'try',
    cfg,
    env: appEnv(input.env, cfg.url),
    checks: input.checks,
    browser: input.browser,
    shotsDir: input.shotsDir,
    stepTimeoutMs: input.stepTimeoutMs ?? 10_000,
    deadline: start + input.maxMs,
  });
  const pages = input.checks.map((c, i) => ({ name: c.name, caption: c.caption, side: r.results?.[i] ?? { error: 'non eseguita' } }));
  return r.results ? done('done', undefined, pages, r.problems) : done('failed', "l'app non si è avviata", pages, r.problems);
}

/** Toglie il worktree temporaneo del branch di partenza (prima il collegamento a node_modules, mai seguito). */
async function removeBaseWorktree(repoPath: string, baseDir: string): Promise<void> {
  removeLink(path.join(baseDir, 'node_modules'));
  await git(repoPath, ['worktree', 'remove', '--force', baseDir], { allowFail: true });
  fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5 });
  await git(repoPath, ['worktree', 'prune'], { allowFail: true });
}

/**
 * Dopo un'interruzione (crash, chiusura forzata): toglie i collegamenti a node_modules rimasti nei
 * worktree degli agenti e i worktree temporanei del branch di partenza. Restituisce cosa ha fatto.
 */
export async function cleanupVisualLeftovers(visualDir: string, repos: readonly Repo[]): Promise<string[]> {
  const done: string[] = [];
  for (const r of repos) {
    for (const w of r.worktrees.filter((x) => x.status === 'active')) {
      const link = path.join(w.path, 'node_modules');
      if (isLink(link)) {
        removeLink(link);
        done.push(`tolto il collegamento a node_modules rimasto in ${w.path}`);
      }
    }
  }
  if (!fs.existsSync(visualDir)) return done;
  for (const name of fs.readdirSync(visualDir).filter((n) => n.endsWith('-base'))) {
    const dir = path.join(visualDir, name);
    removeLink(path.join(dir, 'node_modules'));
    for (const r of repos) await git(r.path, ['worktree', 'remove', '--force', dir], { allowFail: true });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    for (const r of repos) await git(r.path, ['worktree', 'prune'], { allowFail: true });
    done.push(`rimosso il worktree temporaneo ${dir}`);
  }
  return done;
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Le dipendenze JavaScript non sono nel repository: se il tuo checkout ha node_modules (ignorata da
 * git) e la cartella no, la si collega (junction, rimossa alla fine) per poter avviare l'app.
 */
async function linkDependencies(repoPath: string, dir: string): Promise<string | undefined> {
  const src = path.join(repoPath, 'node_modules');
  const dst = path.join(dir, 'node_modules');
  if (!fs.existsSync(src) || fs.existsSync(dst) || path.resolve(src) === path.resolve(dst)) return undefined;
  const ignored = (await git(dir, ['check-ignore', '-q', 'node_modules'], { allowFail: true })).code === 0;
  if (!ignored) return undefined;
  try {
    fs.symlinkSync(src, dst, 'junction');
    return dst;
  } catch {
    return undefined;
  }
}

/**
 * Toglie il collegamento a node_modules SENZA seguirlo: mai una cancellazione ricorsiva, che su una
 * junction potrebbe svuotare la cartella vera del tuo checkout.
 */
export function removeLink(link: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(link);
  } catch {
    return true; // non c'è
  }
  if (!st.isSymbolicLink()) return true; // non è un collegamento creato da Keystone: non si tocca
  try {
    fs.unlinkSync(link);
    return true;
  } catch {
    try {
      fs.rmdirSync(link); // junction su Windows: rmdir non ricorsivo toglie solo il collegamento
      return true;
    } catch {
      return false; // occupato: resta, e la pulizia all'avvio lo toglie
    }
  }
}

/** Il file di una schermata, solo se appartiene alla verifica del task (niente percorsi arbitrari). */
export function shotFile(shotsDir: string, task: Task, shotId: string): string | undefined {
  if (!/^[a-z0-9-]{1,80}$/.test(shotId)) return undefined;
  const known = (task.visual?.checks ?? []).some((c) => c.before.shot?.id === shotId || c.after.shot?.id === shotId);
  if (!known) return undefined;
  const file = path.join(shotsDir, `${shotId}.png`);
  return fs.existsSync(file) ? file : undefined;
}
