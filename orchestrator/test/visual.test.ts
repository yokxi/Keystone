// Verifica visuale nella review (Fase 6b, parte 1): la esegue Keystone, non l'agente.
//  - funzioni di sicurezza: solo URL locali, pagine sulla stessa origine, ambiente senza credenziali,
//    collegamenti a node_modules tolti senza mai seguirli;
//  - flusso del team con la verifica simulata: resoconto del worker, esito nella review e nella
//    decisione di merge, permesso per scaricare il browser, schermate al lead solo con l'opzione;
//  - esecuzione vera con un browser installato (saltata se non c'è né Edge né Chrome).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { onlyAfter, type EngineId, type Outbound, type Task, type VisualCheck, type VisualReport } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import type { VisualDeps } from '../src/core/orchestrator.js';
import { classify } from '../src/core/policy.js';
import { reviewPrompt, tryReport, visualSummary } from '../src/core/prompts.js';
import { teamTools } from '../src/core/tools.js';
import { BROWSER_OPTIONS, BROWSER_TOOL, TRY_UI_LIMITS } from '../src/core/team.js';
import { appEnv, browserRequestAllowed, cleanupVisualLeftovers, findBrowser, isLocalUrl, pageUrl, removeLink, runTry, runVisual, shotFile, validateVisualConfig, type VisualRunInput, type VisualTryInput, type VisualTryResult } from '../src/core/visual.js';
import { toolResultContent, userMessageWithImages } from '../src/engines/claude/claude-engine.js';
import { toolContentItems, turnInput } from '../src/engines/codex/codex-engine.js';
import { SimEngine } from '../src/engines/sim/sim-engine.js';
import { defaultSimScript, type SimScript } from '../src/engines/sim/script.js';
import type { EngineAdapter, TeamToolResult, TurnSpec } from '../src/engines/types.js';
import { git, gitOut } from '../src/util/git.js';
import { redactImageData } from '../src/util/text.js';
import { demoRepo, noReply, testOrchestrator, tmpDir, waitFor } from './helpers.js';

/** PNG 1x1 valido. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('verifica visuale: regole di sicurezza', () => {
  it("l'app e il browser parlano solo con la rete locale", () => {
    for (const u of ['http://localhost:3000', 'http://127.0.0.1:5173/x', 'https://localhost', 'http://[::1]:8080/']) expect(isLocalUrl(u), u).toBe(true);
    for (const u of ['http://example.com', 'http://localhost.evil.com', 'http://127.0.0.2', 'file:///C:/x', 'javascript:alert(1)', 'ftp://localhost', 'non un url']) expect(isLocalUrl(u), u).toBe(false);
    for (const u of ['data:image/png;base64,xx', 'blob:http://localhost/1', 'about:blank', 'ws://localhost:5173/hmr', 'wss://127.0.0.1:1']) expect(browserRequestAllowed(u), u).toBe(true);
    for (const u of ['https://fonts.googleapis.com/css', 'wss://evil.com/socket', 'http://192.168.1.10/']) expect(browserRequestAllowed(u), u).toBe(false);
    expect(validateVisualConfig({ command: 'npm run dev', url: 'http://localhost:5173', startTimeoutSec: 60 })).toBeUndefined();
    expect(validateVisualConfig({ command: '  ', url: 'http://localhost:5173', startTimeoutSec: 60 })).toMatch(/comando/);
    expect(validateVisualConfig({ command: 'x', url: 'https://staging.example.com', startTimeoutSec: 60 })).toMatch(/locale/);
  });

  it('i percorsi del worker restano sulla stessa app', () => {
    expect(pageUrl('http://localhost:3000', '/impostazioni?tab=2')).toBe('http://localhost:3000/impostazioni?tab=2');
    expect(pageUrl('http://localhost:3000/', '')).toBe('http://localhost:3000/');
    for (const p of ['//evil.com/x', 'http://evil.com', '/\\evil.com', 'relativo']) expect(() => pageUrl('http://localhost:3000', p), p).toThrow();
  });

  it("l'app riceve un ambiente senza credenziali, con un proxy inesistente per la rete esterna", () => {
    const env = appEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk', OPENAI_API_KEY: 'sk', GITHUB_TOKEN: 'gh', DB_PASSWORD: 'x', MY_SECRET: 'y', CLAUDE_CODE_OAUTH_TOKEN: 'z' }, 'http://localhost:4321');
    expect(env.PATH).toBe('/bin');
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD', 'MY_SECRET', 'CLAUDE_CODE_OAUTH_TOKEN']) expect(env[k], k).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:9');
    expect(env.NO_PROXY).toContain('localhost');
    expect(env.PORT).toBe('4321');
    expect(env.BROWSER).toBe('none');
  });

  it('il collegamento a node_modules si toglie senza toccare la cartella vera', () => {
    const d = tmpDir();
    const real = path.join(d, 'repo', 'node_modules');
    fs.mkdirSync(path.join(real, 'pacchetto'), { recursive: true });
    fs.writeFileSync(path.join(real, 'pacchetto', 'index.js'), 'x');
    const wt = path.join(d, 'wt');
    fs.mkdirSync(wt);
    const link = path.join(wt, 'node_modules');
    fs.symlinkSync(real, link, 'junction');
    removeLink(link);
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(path.join(real, 'pacchetto', 'index.js'), 'utf8')).toBe('x');
    // una cartella vera non è un collegamento di Keystone: non si tocca
    removeLink(real);
    expect(fs.existsSync(real)).toBe(true);
  });

  it("dopo un'interruzione la pulizia toglie collegamenti e worktree temporanei, non le dipendenze vere", async () => {
    const d = tmpDir();
    const real = path.join(d, 'repo', 'node_modules');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'keep.txt'), 'x');
    const visualDir = path.join(d, 'visual');
    const base = path.join(visualDir, 't1-base');
    fs.mkdirSync(base, { recursive: true });
    fs.symlinkSync(real, path.join(base, 'node_modules'), 'junction');
    const wt = path.join(d, 'wt');
    fs.mkdirSync(wt);
    fs.symlinkSync(real, path.join(wt, 'node_modules'), 'junction');
    const repo = { id: 'r1', name: 'r', path: path.join(d, 'repo'), branch: 'main', dirty: false, ci: 'unknown', worktrees: [{ id: 'w1', repoId: 'r1', agentId: 'bruno', branch: 'b', base: 'main', path: wt, status: 'active', files: 0, additions: 0, deletions: 0 }] } as const;
    const done = await cleanupVisualLeftovers(visualDir, [repo as never]);
    expect(done).toHaveLength(2);
    expect(fs.existsSync(base)).toBe(false);
    expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(false);
    expect(fs.readFileSync(path.join(real, 'keep.txt'), 'utf8')).toBe('x');
  });

  it('una schermata si serve solo se appartiene alla verifica del task', () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, 'before-1.png'), PNG);
    fs.writeFileSync(path.join(d, 'segreto.png'), PNG);
    const task = { id: 't1', visual: { status: 'done', at: 1, problems: [], checks: [{ name: 'Home', caption: '', before: { shot: { id: 'before-1' } }, after: { error: 'x' } }] } } as unknown as Task;
    expect(shotFile(d, task, 'before-1')).toBe(path.join(d, 'before-1.png'));
    expect(shotFile(d, task, 'segreto')).toBeUndefined();
    expect(shotFile(d, task, '../before-1')).toBeUndefined();
    expect(shotFile(d, task, 'after-1')).toBeUndefined();
  });
});

describe('verifica visuale: testi per il lead e per te', () => {
  const rep: VisualReport = {
    status: 'done',
    at: 1,
    problems: ['dopo: richieste di rete esterne bloccate (fonts.googleapis.com)'],
    checks: [
      { name: 'Home', caption: 'il titolo nuovo', before: { shot: { id: 'before-1' } }, after: { shot: { id: 'after-1' } } },
      { name: 'Login', caption: '', before: { shot: { id: 'before-2' } }, after: { shot: { id: 'after-2', error: 'Timeout 10000ms exceeded' }, error: 'Timeout 10000ms exceeded' } },
    ],
  };

  it('riassunto: pagine, passaggi non riusciti e problemi', () => {
    const s = visualSummary(rep);
    expect(s.split('\n')[0]).toBe('Verifica visuale eseguita da Keystone: 2 pagine, 1 con passaggi non riusciti, 1 problemi');
    expect(s).toContain('- Home (atteso: il titolo nuovo): prima: schermata; dopo: schermata');
    expect(s).toContain('passaggio non riuscito (Timeout 10000ms exceeded)');
    expect(s).toContain('fonts.googleapis.com');
    expect(visualSummary({ status: 'skipped', note: 'il worker non ha indicato pagine da verificare', at: 1, checks: [], problems: [] })).toMatch(/non eseguita \(il worker non ha indicato/);
    expect(visualSummary({ status: 'failed', note: "l'app non si è avviata", at: 1, checks: [], problems: [] })).toMatch(/NON RIUSCITA/);
  });

  it('la review del lead contiene resoconto ed esito; con le immagini lo dice', () => {
    const task = {
      id: 't1',
      title: 'Titolo',
      assignee: 'bruno',
      visual: rep,
      report: { request: 'cambia il titolo', changes: 'h1', why: 'richiesto', verification: 'npm test', openIssues: '' },
    } as unknown as Task;
    const env = { userName: 'Aurora', nameOf: (id: string) => id, tasks: [] };
    const p = reviewPrompt(env, task, [], 'Test eseguiti da Keystone: nessuno');
    expect(p).toContain('Resoconto del worker (quello che dice lui, da verificare):');
    expect(p).toContain('- richiesta: cambia il titolo');
    expect(p).toContain('- problemi aperti: nessuno');
    expect(p).toContain('Verifica visuale eseguita da Keystone: 2 pagine');
    expect(p).not.toContain('allegate');
    expect(reviewPrompt(env, task, [], '', { withImages: true })).toContain('Le schermate prima/dopo sono allegate');
  });
});

describe('verifica visuale: immagini ai motori, mai nelle trascrizioni', () => {
  it('Claude: blocchi immagine con didascalia; file mancanti diventano testo', () => {
    const d = tmpDir();
    const f = path.join(d, 'after-1.png');
    fs.writeFileSync(f, PNG);
    const m = userMessageWithImages('Rivedi t1', [
      { path: f, caption: 'Home: dopo' },
      { path: path.join(d, 'manca.png'), caption: 'Login: dopo' },
    ]);
    const content = m.message.content as Array<{ type: string; text?: string; source?: { data: string; media_type: string } }>;
    expect(content.map((c) => c.type)).toEqual(['text', 'text', 'image', 'text']);
    expect(content[1]!.text).toBe('Home: dopo');
    expect(content[2]!.source).toMatchObject({ media_type: 'image/png', data: PNG.toString('base64') });
    expect(content[3]!.text).toBe('Login: dopo: schermata non disponibile');
  });

  it('Codex: localImage con il percorso, preceduto dalla didascalia', () => {
    const d = tmpDir();
    const f = path.join(d, 'before-1.png');
    fs.writeFileSync(f, PNG);
    expect(turnInput({ prompt: 'Rivedi', images: [{ path: f, caption: 'Home: prima' }, { path: path.join(d, 'no.png'), caption: 'X' }] })).toEqual([
      { type: 'text', text: 'Rivedi', text_elements: [] },
      { type: 'text', text: 'Home: prima', text_elements: [] },
      { type: 'localImage', path: f },
      { type: 'text', text: 'X: schermata non disponibile', text_elements: [] },
    ]);
    expect(turnInput({ prompt: 'solo testo' })).toEqual([{ type: 'text', text: 'solo testo', text_elements: [] }]);
  });

  it('le trascrizioni registrate non contengono i dati delle immagini', () => {
    const m = userMessageWithImages('x', []);
    const msg = { ...m, message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(5000) } }] } };
    const line = JSON.stringify({ t: 'msg', msg, other: 'data:image/png;base64,AAAA', data: 'breve' }, redactImageData);
    expect(line).not.toContain('AAAA');
    expect(line).toContain('[immagine omessa da Keystone]');
    expect(line).toContain('"data":"breve"');
  });
});

// ---- flusso del team, con la verifica simulata ---------------------------------------------

const CHECKS = [
  { name: 'Home', path: '/', steps: [{ action: 'click', selector: '#saluta' }], caption: 'il saluto nuovo' },
  { name: 'Impostazioni', path: '/impostazioni', steps: [], caption: 'invariata' },
];

/** Il worker manda il resoconto con le pagine da verificare, poi lavora come sempre. */
function workerWithReport(results: string[]): SimScript {
  return async (ctx) => {
    if (ctx.spec.role === 'worker' && ctx.spec.job.kind === 'work') {
      const taskId = ctx.spec.job.taskId!;
      const base = { task_id: taskId, request: 'aggiungi un saluto', changes: 'nuovo file', why: 'richiesto', verification: 'npm test', open_issues: 'nessuno' };
      results.push((await ctx.team('submit_report', { ...base, visual_checks: [{ name: 'Fuori', path: '//evil.com', steps: [], caption: '' }] })).text);
      results.push((await ctx.team('submit_report', { ...base, visual_checks: CHECKS })).text);
    }
    return defaultSimScript(ctx);
  };
}

/** Il motore sim, con i turni registrati (per leggere prompt e immagini della review del lead). */
function spyEngines(script: SimScript, specs: TurnSpec[]): Map<EngineId, EngineAdapter> {
  const sim = new SimEngine({ stepDelayMs: 0, script });
  const spy: EngineAdapter = {
    id: sim.id,
    label: sim.label,
    defaultModel: (r) => sim.defaultModel(r),
    displayModel: (m) => sim.displayModel(m),
    checkAuth: () => sim.checkAuth(),
    startSession: (spec) => (specs.push(spec), sim.startSession(spec)),
    resumeSession: (id, spec) => (specs.push(spec), sim.resumeSession(id, spec)),
  };
  return new Map<EngineId, EngineAdapter>([['sim', spy]]);
}

/** Una verifica simulata: scrive due PNG per pagina e restituisce l'esito. */
function fakeVisual(calls: VisualRunInput[], over: Partial<VisualDeps> = {}): Partial<VisualDeps> {
  return {
    findBrowser: () => ({ channel: 'msedge', label: 'Edge (finto)' }),
    installBrowser: async () => ({ ok: true, output: '' }),
    run: async (input) => {
      calls.push(input);
      fs.mkdirSync(input.shotsDir, { recursive: true });
      const checks = (input.task.visualChecks ?? []).map((c, i) => {
        for (const side of ['before', 'after']) fs.writeFileSync(path.join(input.shotsDir, `${side}-${i + 1}.png`), PNG);
        return { name: c.name, caption: c.caption, before: { shot: { id: `before-${i + 1}` } }, after: { shot: { id: `after-${i + 1}` } } };
      });
      return { status: 'done', at: input.now(), checks, problems: [] };
    },
    ...over,
  };
}

async function setup(opts: { visual: Partial<VisualDeps>; agentScreenshots?: boolean; configure?: boolean; leadReview?: boolean }) {
  const results: string[] = [];
  const specs: TurnSpec[] = [];
  const { o, cfg } = testOrchestrator({ workers: 1, leadReview: opts.leadReview ?? true, engines: spyEngines(workerWithReport(results), specs), visual: opts.visual });
  const r = await o.repos.add(await demoRepo(cfg.home), { confirmGuard: true });
  if (opts.configure !== false) {
    await o.handle({ v: 1, type: 'repo.config', repoId: r.id, visual: { command: 'npm run dev', url: 'http://localhost:5173', startTimeoutSec: 30, ...(opts.agentScreenshots ? { agentScreenshots: true } : {}) } }, noReply);
  }
  await o.start();
  await o.handle({ v: 1, type: 'goal.submit', text: 'Aggiungi un saluto' }, noReply);
  return { o, repoId: r.id, results, specs, home: cfg.home };
}

describe('verifica visuale nel flusso del team (verifica simulata)', () => {
  it('dopo i test: Keystone verifica le pagine dichiarate; esito nella review del lead e nella decisione', async () => {
    const calls: VisualRunInput[] = [];
    const { o, repoId, results, specs } = await setup({ visual: fakeVisual(calls) });
    const d = await waitFor(() => o.decisions.open().find((x) => x.kind === 'merge'), 'decisione di merge');
    const t = o.tasks.get(d.taskId!)!;

    // submit_report: un percorso fuori dall'app è rifiutato, quello buono è registrato
    expect(results[0]).toMatch(/percorso "\/\/evil.com" non valido/);
    expect(results[1]).toMatch(/Keystone verificherà 2 pagine/);
    expect(t.report).toMatchObject({ request: 'aggiungi un saluto', openIssues: 'nessuno' });
    expect(t.visualChecks).toHaveLength(2);

    // una sola verifica, "prima" = il punto da cui è partito il branch, "dopo" = il worktree
    expect(calls).toHaveLength(1);
    const wt = o.repos.requireWorktree(repoId, t.worktree!);
    expect(calls[0]!.worktreePath).toBe(wt.path);
    expect(calls[0]!.baseRef).toBe(await gitOut(o.repos.get(repoId)!.path, ['merge-base', wt.base, wt.branch]));
    expect(calls[0]!.shotsDir).toBe(o.visualShotsDir(t.id));
    // l'app non riceve le credenziali dell'orchestratore
    expect(Object.keys(calls[0]!.env).some((k) => /API_KEY$/.test(k))).toBe(false);

    expect(t.visual).toMatchObject({ status: 'done', checks: [{ name: 'Home' }, { name: 'Impostazioni' }] });
    const review = specs.find((s) => s.role === 'lead' && s.job.kind === 'review')!;
    expect(review.prompt).toContain('Resoconto del worker');
    expect(review.prompt).toContain('Verifica visuale eseguita da Keystone: 2 pagine');
    // opzione disattivata di default: niente immagini al lead
    expect(review.images).toBeUndefined();
    expect(d.context).toContain('Verifica visuale eseguita da Keystone: 2 pagine');

    // la schermata arriva all'interfaccia solo se appartiene alla verifica del task
    const out: Outbound[] = [];
    expect(await o.handle({ v: 1, type: 'visual.shot.request', requestId: 'q1', taskId: t.id, shotId: 'after-1' }, (m) => out.push(m))).toEqual({ found: true });
    expect(out[0]).toMatchObject({ type: 'visual.shot', requestId: 'q1', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` });
    expect(await o.handle({ v: 1, type: 'visual.shot.request', requestId: 'q2', taskId: t.id, shotId: 'after-9' }, (m) => out.push(m))).toEqual({ found: false });
    expect(out[1]).toMatchObject({ type: 'visual.shot', requestId: 'q2', error: 'schermata non trovata' });
  });

  it('con l\'opzione attiva il lead riceve le schermate prima/dopo, con didascalia', async () => {
    const calls: VisualRunInput[] = [];
    const { o, specs } = await setup({ visual: fakeVisual(calls), agentScreenshots: true });
    const d = await waitFor(() => o.decisions.open().find((x) => x.kind === 'merge'), 'decisione di merge');
    const review = specs.find((s) => s.role === 'lead' && s.job.kind === 'review')!;
    const dir = o.visualShotsDir(d.taskId!);
    expect(review.images).toEqual([
      { path: path.join(dir, 'before-1.png'), caption: 'Home: prima (atteso: il saluto nuovo)' },
      { path: path.join(dir, 'after-1.png'), caption: 'Home: dopo (atteso: il saluto nuovo)' },
      { path: path.join(dir, 'before-2.png'), caption: 'Impostazioni: prima (atteso: invariata)' },
      { path: path.join(dir, 'after-2.png'), caption: 'Impostazioni: dopo (atteso: invariata)' },
    ]);
    expect(review.prompt).toContain('Le schermate prima/dopo sono allegate');
  });

  it('senza browser chiede il permesso; se lo neghi la review prosegue senza schermate', async () => {
    const calls: VisualRunInput[] = [];
    let installs = 0;
    const { o } = await setup({ visual: fakeVisual(calls, { findBrowser: () => undefined, installBrowser: async () => (installs++, { ok: true, output: '' }) }) });
    const p = await waitFor(() => o.decisions.open().find((x) => x.kind === 'permission' && x.tool === BROWSER_TOOL), 'permesso per il browser');
    expect(p.options).toEqual([...BROWSER_OPTIONS]);
    expect(p.alwaysAsk).toBe(true);
    expect(p.command).toMatch(/playwright install chromium/);
    expect(o.decisions.open().some((x) => x.kind === 'merge')).toBe(false); // la review aspetta la tua risposta
    await o.handle({ v: 1, type: 'decision.answer', decisionId: p.id, option: 'Nega' }, noReply);
    const d = await waitFor(() => o.decisions.open().find((x) => x.kind === 'merge'), 'decisione di merge');
    expect(installs).toBe(0);
    expect(calls).toHaveLength(0);
    expect(o.tasks.get(d.taskId!)!.visual).toMatchObject({ status: 'skipped', note: 'download di Chromium non consentito' });
  });

  it('se consenti il download, Keystone scarica Chromium e poi verifica', async () => {
    const calls: VisualRunInput[] = [];
    let installed = false;
    const { o } = await setup({
      visual: fakeVisual(calls, { findBrowser: () => (installed ? { executablePath: 'chrome', label: 'Chromium di Playwright' } : undefined), installBrowser: async () => ((installed = true), { ok: true, output: '' }) }),
    });
    const p = await waitFor(() => o.decisions.open().find((x) => x.kind === 'permission' && x.tool === BROWSER_TOOL), 'permesso per il browser');
    await o.handle({ v: 1, type: 'decision.answer', decisionId: p.id, option: 'Scarica Chromium' }, noReply);
    const d = await waitFor(() => o.decisions.open().find((x) => x.kind === 'merge'), 'decisione di merge');
    expect(installed).toBe(true);
    expect(calls[0]!.browser.label).toBe('Chromium di Playwright');
    expect(o.tasks.get(d.taskId!)!.visual?.status).toBe('done');
  });

  it('senza configurazione la verifica non parte: le pagine restano solo annotate', async () => {
    const calls: VisualRunInput[] = [];
    const { o, results } = await setup({ visual: fakeVisual(calls), configure: false });
    const d = await waitFor(() => o.decisions.open().find((x) => x.kind === 'merge'), 'decisione di merge');
    expect(results[1]).toMatch(/verifica visuale non è configurata/);
    expect(calls).toHaveLength(0);
    expect(o.tasks.get(d.taskId!)!.visual).toBeUndefined();
  });
});

// ---- esecuzione vera: app locale, browser installato -----------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const SERVER = `import http from 'node:http';
import fs from 'node:fs';
http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync('index.html')); }
  else { res.writeHead(404); res.end(); }
}).listen(Number(process.env.PORT), '127.0.0.1');
`;
// Le immagini (404 e esterna bloccata) ritardano l'evento load: la diagnostica è completa senza
// dipendere da attese a tempo. Lo script "dopo" scrive in console e lancia un errore non gestito.
const page = (title: string, broken = false) =>
  `<!doctype html><html><body><h1 id="t">${title}</h1><p id="c"></p><button id="b" onclick="document.getElementById('c').textContent='Cliccato'">clic</button>` +
  `<img src="/manca.png"><img src="http://example.invalid/x.png">` +
  (broken ? `<script>console.error('Errore solo dopo'); throw new Error('Boom dopo');</script>` : `<script>console.log('pronto');</script>`) +
  `</body></html>`;

const browser = findBrowser(path.join(process.env.KEYSTONE_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.keystone'), 'browsers'));

describe.skipIf(!browser)('verifica visuale vera (browser installato)', () => {
  it('avvia l\'app dal branch di partenza e dal worktree, cattura le schermate, blocca la rete esterna', { timeout: 120_000 }, async () => {
    const d = tmpDir();
    const repoPath = path.join(d, 'repo');
    fs.mkdirSync(repoPath);
    fs.writeFileSync(path.join(repoPath, 'server.mjs'), SERVER);
    fs.writeFileSync(path.join(repoPath, 'index.html'), page('Prima'));
    const id = ['-c', 'user.name=Test', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
    await git(repoPath, ['init', '-q', '-b', 'main']);
    await git(repoPath, ['add', '-A']);
    await git(repoPath, [...id, 'commit', '-q', '-m', 'app']);
    const wtPath = path.join(d, 'wt');
    await git(repoPath, ['worktree', 'add', '-q', '-b', 'nuovo-titolo', wtPath]);
    fs.writeFileSync(path.join(wtPath, 'index.html'), page('Dopo', true));
    await git(wtPath, [...id, 'commit', '-q', '-am', 'titolo']);

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const task = {
      id: 't1',
      visualChecks: [
        { name: 'Home', path: '/', steps: [{ action: 'click', selector: '#b' }, { action: 'wait', selector: '#t' }], caption: 'il titolo' },
        // un passaggio che fallisce subito, senza aspettare un timeout: si scrive in un titolo
        { name: 'Campo sbagliato', path: '/', steps: [{ action: 'fill', selector: '#t', value: 'x' }], caption: '' },
      ],
    } as unknown as Task;
    const shotsDir = path.join(d, 'visual', 't1');
    const rep = await runVisual({
      repo: { id: 'r1', name: 'repo', path: repoPath, branch: 'main', dirty: false, ci: 'unknown', worktrees: [], visual: { command: 'node server.mjs', url, startTimeoutSec: 30 } },
      task,
      worktreePath: wtPath,
      baseRef: 'main',
      shotsDir,
      browser: browser!,
      env: { ...process.env, ANTHROPIC_API_KEY: 'non-deve-arrivare' },
      // margine ampio: i passaggi che devono riuscire non dipendono dal carico della macchina
      stepTimeoutMs: 30_000,
      now: Date.now,
    });

    expect(rep.status).toBe('done');
    expect(rep.checks[0]).toMatchObject({ name: 'Home', before: { shot: { id: 'before-1' } }, after: { shot: { id: 'after-1' } } });
    expect(rep.checks[0]!.before.error).toBeUndefined();
    // un passaggio non riuscito: la schermata c'è comunque, con l'errore
    expect(rep.checks[1]!.after.shot?.id).toBe('after-2');
    expect(rep.checks[1]!.after.error).toMatch(/not an <input>/);
    expect(rep.checks[1]!.after.error).not.toMatch(/Timeout/);
    // l'immagine esterna è stata bloccata, e lo dice
    expect(rep.problems.join('\n')).toContain('example.invalid');
    // diagnostica: il 404 e la richiesta bloccata ci sono prima e dopo; errore JS e console solo dopo
    const b = rep.checks[0]!.before.diagnostics!;
    const a = rep.checks[0]!.after.diagnostics!;
    expect(b.errors).toEqual([]);
    expect(b.console).toEqual([{ type: 'log', text: 'pronto' }]);
    expect(b.failedRequests).toEqual(expect.arrayContaining([expect.objectContaining({ url: `${url}/manca.png`, status: 404 }), expect.objectContaining({ url: 'http://example.invalid/x.png', blocked: true })]));
    expect(a.errors[0]).toMatch(/^Boom dopo/);
    const fresh = onlyAfter(b, a);
    expect(fresh.errors).toHaveLength(1);
    expect(fresh.console).toEqual([{ type: 'error', text: 'Errore solo dopo' }]);
    expect(fresh.failedRequests).toEqual([]);
    expect(visualSummary(rep)).toContain('solo dopo: 1 errori JavaScript, 1 errori/avvisi in console, 0 richieste fallite');
    // prima e dopo sono diverse (il titolo è cambiato), e stanno nella cartella delle schermate
    const before = fs.readFileSync(path.join(shotsDir, 'before-1.png'));
    const after = fs.readFileSync(path.join(shotsDir, 'after-1.png'));
    expect(before.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(before.equals(after)).toBe(false);
    // il worktree temporaneo è stato tolto e l'app è stata fermata
    expect(fs.existsSync(path.join(d, 'visual', 't1-base'))).toBe(false);
    expect((await gitOut(repoPath, ['worktree', 'list'])).split('\n')).toHaveLength(2);
    await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });

  it("se un'altra app risponde già sull'URL non cattura niente e lo dice", { timeout: 30_000 }, async () => {
    const port = await freePort();
    const other = net.createServer((s) => s.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok'));
    await new Promise<void>((r) => other.listen(port, '127.0.0.1', r));
    try {
      const d = tmpDir();
      const rep = await runVisual({
        repo: { id: 'r1', name: 'repo', path: d, branch: 'main', dirty: false, ci: 'unknown', worktrees: [], visual: { command: 'node -e 0', url: `http://127.0.0.1:${port}`, startTimeoutSec: 5 } },
        task: { id: 't1', visualChecks: [{ name: 'Home', path: '/', steps: [], caption: '' }] } as unknown as Task,
        worktreePath: d,
        baseRef: 'main',
        shotsDir: path.join(d, 'visual', 't1'),
        browser: browser!,
        env: process.env,
        now: Date.now,
      });
      expect(rep.status).toBe('failed');
      expect(rep.note).toMatch(/risponde già/);
    } finally {
      other.close();
    }
  });
});

describe.skipIf(!browser)('prova interfaccia vera (browser installato)', () => {
  it('solo il worktree: esito dei passaggi, diagnostica e schermata', { timeout: 120_000 }, async () => {
    const d = tmpDir();
    const wt = path.join(d, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, 'server.mjs'), SERVER);
    fs.writeFileSync(path.join(wt, 'index.html'), page('Prova', true));
    await git(wt, ['init', '-q', '-b', 'main']);
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const r = await runTry({
      repo: { id: 'r1', name: 'repo', path: wt, branch: 'main', dirty: false, ci: 'unknown', worktrees: [], visual: { command: 'node server.mjs', url, startTimeoutSec: 30 } },
      checks: [
        { name: 'Home', path: '/', steps: [{ action: 'click', selector: '#b' }], caption: '' },
        { name: 'Campo sbagliato', path: '/', steps: [{ action: 'fill', selector: '#t', value: 'x' }], caption: '' },
      ],
      worktreePath: wt,
      shotsDir: path.join(d, 'visual', 't1-try'),
      browser: browser!,
      env: process.env,
      maxMs: 90_000,
      stepTimeoutMs: 30_000,
    });
    expect(r.status).toBe('done');
    expect(r.pages[0]!.side).toMatchObject({ shot: { id: 'try-1' } });
    expect(r.pages[0]!.side.error).toBeUndefined();
    expect(r.pages[1]!.side.error).toMatch(/not an <input>/);
    expect(r.pages[0]!.side.diagnostics!.errors[0]).toMatch(/^Boom dopo/);
    expect(fs.existsSync(path.join(d, 'visual', 't1-try', 'try-1.png'))).toBe(true);
    const text = tryReport(r, { withImages: false });
    expect(text).toContain('- Home: passaggi riusciti');
    expect(text).toContain('errore JS: Boom dopo');
    expect(text).toContain('console: [error] Errore solo dopo');
    expect(text).toContain(`richiesta: GET ${url}/manca.png → 404`);
    expect(text).toContain('richiesta: GET http://example.invalid/x.png → bloccata (non locale)');
    await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });

  it('una prova che supera il tempo massimo si ferma e lo dice', { timeout: 60_000 }, async () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, 'server.mjs'), SERVER);
    fs.writeFileSync(path.join(d, 'index.html'), page('Prova'));
    const port = await freePort();
    const r = await runTry({
      repo: { id: 'r1', name: 'repo', path: d, branch: 'main', dirty: false, ci: 'unknown', worktrees: [], visual: { command: 'node server.mjs', url: `http://127.0.0.1:${port}`, startTimeoutSec: 30 } },
      // il tempo è già esaurito: nessuna pagina viene aperta, senza dipendere dalla velocità della macchina
      checks: [{ name: 'Home', path: '/', steps: [], caption: '' }],
      worktreePath: d,
      shotsDir: path.join(d, 'visual', 't1-try'),
      browser: browser!,
      env: process.env,
      maxMs: -1,
    });
    expect(r.pages[0]!.side.error).toMatch(/tempo massimo della prova superato/);
  });
});

// ---- parte 2 senza browser: diagnostica, testi, prova interfaccia nel team ------------------

describe('diagnostica: cosa compare solo dopo', () => {
  const diag = (o: Partial<{ console: Array<{ type: string; text: string }>; errors: string[]; failedRequests: Array<{ url: string; method?: string; status?: number; blocked?: boolean; failure?: string }> }>) => ({ console: [], errors: [], failedRequests: [], ...o });

  it('confronta messaggi, prima riga degli errori e risorse senza query', () => {
    const before = diag({
      console: [{ type: 'warning', text: 'vecchio avviso' }],
      errors: ['TypeError: x is undefined\n    at a (http://localhost:5173/src/a.js?t=1:10:5)'],
      failedRequests: [{ url: 'http://localhost:5173/api/utente?t=111', method: 'GET', status: 404 }],
    });
    const after = diag({
      console: [{ type: 'warning', text: 'vecchio avviso' }, { type: 'error', text: 'nuovo errore' }],
      errors: ['TypeError: x is undefined\n    at a (http://localhost:5173/src/a.js?t=2:12:9)', 'ReferenceError: y is not defined'],
      failedRequests: [{ url: 'http://localhost:5173/api/utente?t=222', method: 'GET', status: 404 }, { url: 'http://localhost:5173/api/ordini', method: 'POST', status: 500 }],
    });
    expect(onlyAfter(before, after)).toEqual({
      console: [{ type: 'error', text: 'nuovo errore' }],
      errors: ['ReferenceError: y is not defined'],
      failedRequests: [{ url: 'http://localhost:5173/api/ordini', method: 'POST', status: 500 }],
    });
    // senza il lato "prima" non si può dire cosa è nuovo
    expect(onlyAfter(undefined, after)).toEqual({ console: [], errors: [], failedRequests: [] });
  });

  it('nel riassunto per il lead: in evidenza il nuovo, il resto solo come conteggio', () => {
    const rep: VisualReport = {
      status: 'done',
      at: 1,
      problems: [],
      checks: [
        {
          name: 'Home',
          caption: '',
          before: { shot: { id: 'before-1' }, diagnostics: diag({ failedRequests: [{ url: 'http://localhost/a.png', status: 404 }] }) },
          after: { shot: { id: 'after-1' }, diagnostics: diag({ errors: ['Boom'], failedRequests: [{ url: 'http://localhost/a.png', status: 404 }] }) },
        },
      ],
    };
    const s = visualSummary(rep);
    expect(s).toContain('  solo dopo: 1 errori JavaScript, 0 errori/avvisi in console, 0 richieste fallite');
    expect(s).toContain('    - errore JS: Boom');
    expect(s).toContain('  presenti anche prima: 1 tra errori, avvisi e richieste fallite');
    expect(s).not.toContain('a.png');
  });
});

describe('policy: ogni tool del team è ammesso per il suo ruolo, e solo per quello', () => {
  it('nessun tool dimenticato (submit_report e try_ui compresi)', () => {
    const { o } = testOrchestrator({ workers: 1 });
    const hooks = { onReview: () => undefined, onChangesRequested: () => undefined, onTasksChanged: () => undefined, onDecisionOpened: () => undefined };
    const guard = { aborted: () => false, reason: () => undefined, whenAborted: new Promise<void>(() => undefined) };
    const lead = teamTools(o, o.leadId, 'lead', hooks, guard).map((t) => t.name);
    const worker = teamTools(o, 'bruno', 'worker', hooks, guard).map((t) => t.name);
    expect(worker).toEqual(expect.arrayContaining(['submit_report', 'try_ui']));
    expect(lead).not.toContain('try_ui');
    const cwd = tmpDir();
    for (const [role, names, others] of [['lead', lead, worker], ['worker', worker, lead]] as const) {
      for (const n of names) {
        expect(classify(`mcp__keystone__${n}`, {}, { role, cwd }).action, `${role} ${n}`).toBe('allow');
        expect(classify(n, {}, { role, cwd }).action, `${role} ${n}`).toBe('allow');
      }
      for (const n of others.filter((x) => !names.includes(x))) expect(classify(`mcp__keystone__${n}`, {}, { role, cwd }).action, `${role} ${n}`).toBe('deny');
    }
  });
});

describe('risultati dei tool con immagini', () => {
  it('Claude: testo, didascalia e blocco immagine; Codex: inputImage come data URL', () => {
    const d = tmpDir();
    const f = path.join(d, 'try-1.png');
    fs.writeFileSync(f, PNG);
    const r: TeamToolResult = { text: 'esito', images: [{ path: f, caption: 'Home: prova' }, { path: path.join(d, 'no.png'), caption: 'X' }] };
    expect(toolResultContent(r)).toEqual([
      { type: 'text', text: 'esito' },
      { type: 'text', text: 'Home: prova' },
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: 'X: schermata non disponibile' },
    ]);
    expect(toolContentItems(r)).toEqual([
      { type: 'inputText', text: 'esito' },
      { type: 'inputText', text: 'Home: prova' },
      { type: 'inputImage', imageUrl: `data:image/png;base64,${PNG.toString('base64')}` },
      { type: 'inputText', text: 'X: schermata non disponibile' },
    ]);
  });
});

describe('una sola app per volta per repository', () => {
  it('le esecuzioni dello stesso repository si mettono in fila, anche dopo un errore; repository diversi no', async () => {
    const { o } = testOrchestrator({ workers: 1 });
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = o.withVisualLock('r1', async () => {
      log.push('a:inizio');
      await gate;
      log.push('a:fine');
      throw new Error('fallita');
    });
    const second = o.withVisualLock('r1', async () => {
      log.push('b');
      return 2;
    });
    const other = o.withVisualLock('r2', async () => {
      log.push('altro repo');
      return 3;
    });
    expect(await other).toBe(3);
    expect(log).toEqual(['a:inizio', 'altro repo']); // r2 non aspetta r1
    release();
    await expect(first).rejects.toThrow('fallita');
    expect(await second).toBe(2);
    expect(log).toEqual(['a:inizio', 'altro repo', 'a:fine', 'b']);
  });
});

/** Il worker prova l'interfaccia `times` volte durante il lavoro, poi lavora come sempre. */
function workerTrying(times: number, results: TeamToolResult[]): SimScript {
  return async (ctx) => {
    if (ctx.spec.role === 'worker' && ctx.spec.job.kind === 'work') {
      for (let i = 0; i < times; i++) results.push(await ctx.team('try_ui', { task_id: ctx.spec.job.taskId!, checks: CHECKS }));
    }
    return defaultSimScript(ctx);
  };
}

function fakeTry(calls: VisualTryInput[]): Partial<VisualDeps> {
  return {
    findBrowser: () => ({ channel: 'msedge', label: 'Edge (finto)' }),
    tryRun: async (input): Promise<VisualTryResult> => {
      calls.push(input);
      fs.mkdirSync(input.shotsDir, { recursive: true });
      fs.writeFileSync(path.join(input.shotsDir, 'try-1.png'), PNG);
      return {
        status: 'done',
        durationMs: 1234,
        problems: [],
        pages: input.checks.map((c: VisualCheck, i) => ({
          name: c.name,
          caption: c.caption,
          side: i === 0 ? { shot: { id: 'try-1' }, diagnostics: { console: [], errors: ['Boom'], failedRequests: [] } } : { error: 'locator.click: Timeout' },
        })),
      };
    },
  };
}

async function setupTry(opts: { times: number; agentScreenshots?: boolean; configure?: boolean }) {
  const results: TeamToolResult[] = [];
  const calls: VisualTryInput[] = [];
  const { o, cfg } = testOrchestrator({ workers: 1, leadReview: false, engines: new Map<EngineId, EngineAdapter>([['sim', new SimEngine({ stepDelayMs: 0, script: workerTrying(opts.times, results) })]]), visual: fakeTry(calls) });
  const r = await o.repos.add(await demoRepo(cfg.home), { confirmGuard: true });
  if (opts.configure !== false) {
    await o.handle({ v: 1, type: 'repo.config', repoId: r.id, visual: { command: 'npm run dev', url: 'http://localhost:5173', startTimeoutSec: 30, ...(opts.agentScreenshots ? { agentScreenshots: true } : {}) } }, noReply);
  }
  await o.start();
  await o.handle({ v: 1, type: 'goal.submit', text: 'Aggiungi un saluto' }, noReply);
  const d = await waitFor(() => o.decisions.open().find((x) => x.kind === 'merge'), 'decisione di merge');
  return { o, results, calls, repoId: r.id, taskId: d.taskId! };
}

describe('prova interfaccia (try_ui) nel team, con la prova simulata', () => {
  it('Keystone prova il worktree del worker e gli restituisce esito e diagnostica; massimo per turno', async () => {
    const { o, results, calls, repoId, taskId } = await setupTry({ times: TRY_UI_LIMITS.perTurn + 1 });
    expect(calls).toHaveLength(TRY_UI_LIMITS.perTurn);
    const t = o.tasks.get(taskId)!;
    expect(calls[0]!.worktreePath).toBe(o.repos.requireWorktree(repoId, t.worktree!).path);
    expect(calls[0]!.shotsDir).toBe(o.visualTryDir(taskId));
    expect(calls[0]!.maxMs).toBeLessThanOrEqual(TRY_UI_LIMITS.msPerTry);
    expect(Object.keys(calls[0]!.env).some((k) => /API_KEY$/.test(k))).toBe(false);
    const first = results[0]!;
    expect(first.isError).toBeUndefined();
    expect(first.text).toContain("Prova dell'interfaccia eseguita da Keystone nel tuo worktree (1.2 s): eseguita");
    expect(first.text).toContain('errore JS: Boom');
    expect(first.text).toContain('passaggio non riuscito: locator.click: Timeout');
    // schermate agli agenti disattivate (default): niente immagini, e lo dice
    expect(first.images).toBeUndefined();
    expect(first.text).toContain('Schermate non allegate');
    expect(results[TRY_UI_LIMITS.perTurn]).toMatchObject({ isError: true, text: expect.stringMatching(/massimo 5/) });
  });

  it("con le schermate per gli agenti attive, la schermata torna al worker", async () => {
    const { o, results, taskId } = await setupTry({ times: 1, agentScreenshots: true });
    expect(results[0]!.images).toEqual([{ path: path.join(o.visualTryDir(taskId), 'try-1.png'), caption: 'Home: prova' }]);
    expect(results[0]!.text).toContain('Le schermate sono allegate');
  });

  it('senza verifica visuale configurata la prova non parte e lo spiega', async () => {
    const { results, calls } = await setupTry({ times: 1, configure: false });
    expect(calls).toHaveLength(0);
    expect(results[0]).toMatchObject({ isError: true, text: expect.stringMatching(/non è configurata/) });
  });
});
