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
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Repo, Task, VisualCheck, VisualReport } from '@keystone/shared';
import { ensureDir } from '../util/fsx.js';
import { git } from '../util/git.js';
import { lastLines, truncate } from '../util/text.js';

export type VisualConfig = NonNullable<Repo['visual']>;

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
export function browserRequestAllowed(u: string): boolean {
  if (/^(data|blob|about):/i.test(u)) return true;
  return isLocalUrl(u) || /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u);
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
function killTree(p: ChildProcess): void {
  if (p.exitCode !== null || !p.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else {
    try {
      process.kill(-p.pid, 'SIGKILL');
    } catch {
      p.kill('SIGKILL');
    }
  }
}

/** Ambiente dell'app: quello sicuro degli agenti, senza credenziali, con la rete esterna verso un proxy inesistente. */
export function appEnv(base: Record<string, string | undefined>, url: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !/(API_KEY|AUTH_TOKEN|OAUTH_TOKEN|SECRET|PASSWORD|_TOKEN)$/i.test(k)) out[k] = v;
  const dead = 'http://127.0.0.1:9';
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) out[k] = dead;
  out.NO_PROXY = out.no_proxy = 'localhost,127.0.0.1,::1';
  const port = new URL(url).port;
  if (port) out.PORT = port;
  out.BROWSER = 'none'; // dev server che aprono il browser da soli
  return out;
}

/** Avvia l'app e aspetta che risponda; restituisce il processo e il suo output. */
async function startApp(dir: string, cfg: VisualConfig, env: Record<string, string>): Promise<{ proc: ChildProcess; output: () => string; error?: string }> {
  let out = '';
  const proc = spawn(cfg.command, { cwd: dir, env, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d: Buffer) => (out = (out + d.toString()).slice(-20_000)));
  proc.stderr!.on('data', (d: Buffer) => (out = (out + d.toString()).slice(-20_000)));
  const deadline = Date.now() + cfg.startTimeoutSec * 1000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return { proc, output: () => out, error: `l'app è terminata subito (codice ${proc.exitCode})` };
    try {
      const r = await fetch(cfg.url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
      if (r.status < 500) return { proc, output: () => out };
    } catch {
      /* non ancora pronta */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { proc, output: () => out, error: `l'app non risponde su ${cfg.url} entro ${cfg.startTimeoutSec} s` };
}

type Side = 'before' | 'after';

/** Esegue i controlli in una istanza dell'app già avviata e cattura le schermate. */
async function captureSide(browser: BrowserChoice, cfg: VisualConfig, checks: VisualCheck[], side: Side, shotsDir: string, stepTimeoutMs: number) {
  const { chromium } = await import('playwright-core');
  const b = await chromium.launch({ headless: true, ...(browser.channel ? { channel: browser.channel } : {}), ...(browser.executablePath ? { executablePath: browser.executablePath } : {}) });
  const blocked = new Set<string>();
  const results: Array<{ shot?: { id: string; error?: string }; error?: string }> = [];
  try {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', acceptDownloads: false });
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (browserRequestAllowed(u)) return route.continue();
      blocked.add(new URL(u).host);
      return route.abort('blockedbyclient');
    });
    for (let i = 0; i < checks.length; i++) {
      const c = checks[i]!;
      const page = await ctx.newPage();
      page.setDefaultTimeout(stepTimeoutMs);
      let error: string | undefined;
      try {
        await page.goto(pageUrl(cfg.url, c.path), { waitUntil: 'load' });
        for (const s of c.steps) {
          if (s.action === 'goto') await page.goto(pageUrl(cfg.url, s.path), { waitUntil: 'load' });
          else if (s.action === 'click') await page.locator(s.selector).first().click();
          else if (s.action === 'fill') await page.locator(s.selector).first().fill(s.value);
          else if (s.action === 'press') await page.locator(s.selector).first().press(s.key);
          else if (s.action === 'wait') await page.locator(s.selector).first().waitFor({ state: 'visible' });
        }
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
      } catch (e) {
        error = truncate(((e as Error).message ?? String(e)).split('\n')[0]!, 300);
      }
      // la schermata si cattura anche se un passaggio è fallito: mostra dove si è fermata
      const id = `${side}-${i + 1}`;
      try {
        await page.screenshot({ path: path.join(shotsDir, `${id}.png`), fullPage: true });
        results.push({ shot: { id, ...(error ? { error } : {}) }, ...(error ? { error } : {}) });
      } catch (e) {
        results.push({ error: error ?? `schermata non catturata: ${(e as Error).message}` });
      }
      await page.close();
    }
  } finally {
    await b.close();
  }
  return { results, blocked: [...blocked] };
}

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
  const sides: Record<Side, Awaited<ReturnType<typeof captureSide>>['results'] | undefined> = { before: undefined, after: undefined };
  const env = appEnv(input.env, cfg.url);
  try {
    // il branch di partenza, in un worktree temporaneo (il tuo checkout non viene toccato)
    await git(input.repo.path, ['worktree', 'remove', '--force', baseDir], { allowFail: true });
    fs.rmSync(baseDir, { recursive: true, force: true });
    const add = await git(input.repo.path, ['worktree', 'add', '--detach', baseDir, input.baseRef], { allowFail: true });
    if (add.code !== 0) problems.push(`impossibile preparare il branch di partenza: ${truncate(add.stderr.trim(), 200)}`);
    for (const [side, dir] of [['before', add.code === 0 ? baseDir : undefined], ['after', input.worktreePath]] as const) {
      if (!dir) continue;
      const linked = await linkDependencies(input.repo.path, dir);
      const app = await startApp(dir, cfg, env);
      try {
        if (app.error) {
          problems.push(`${side === 'before' ? 'prima' : 'dopo'}: ${app.error}${app.output().trim() ? `\n${lastLines(app.output(), 8)}` : ''}`);
          continue;
        }
        const r = await captureSide(input.browser, cfg, checks, side, input.shotsDir, input.stepTimeoutMs ?? 10_000);
        sides[side] = r.results;
        if (r.blocked.length) problems.push(`${side === 'before' ? 'prima' : 'dopo'}: richieste di rete esterne bloccate (${r.blocked.slice(0, 5).join(', ')})`);
      } catch (e) {
        problems.push(`${side === 'before' ? 'prima' : 'dopo'}: ${truncate((e as Error).message ?? String(e), 300)}`);
      } finally {
        killTree(app.proc);
        if (linked) removeLink(linked);
      }
    }
  } finally {
    await git(input.repo.path, ['worktree', 'remove', '--force', baseDir], { allowFail: true });
    fs.rmSync(baseDir, { recursive: true, force: true });
    await git(input.repo.path, ['worktree', 'prune'], { allowFail: true });
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
export function removeLink(link: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(link);
  } catch {
    return;
  }
  if (!st.isSymbolicLink()) return; // non è un collegamento creato da Keystone: non si tocca
  try {
    fs.unlinkSync(link);
  } catch {
    fs.rmdirSync(link); // junction su Windows: rmdir non ricorsivo toglie solo il collegamento
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
