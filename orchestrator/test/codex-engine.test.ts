// Motore Codex: traduzione del protocollo app-server, policy su ogni azione, isolamento.
// Il flusso completo gira contro un app-server finto (fixtures/codex/fake-app-server.mjs) che usa
// gli stessi nomi di metodo della CLI 0.163.0; il test di isolamento usa la CLI vera.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineEvent, EngineId } from '@keystone/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultAgents } from '../src/config.js';
import { unwrapShell } from '../src/engines/codex/command.js';
import { CodexEngine, displayCodexModel, dynamicTools } from '../src/engines/codex/codex-engine.js';
import type { EngineAdapter, TurnSpec } from '../src/engines/types.js';
import { demoRepo, noReply, testOrchestrator, tmpDir, waitFor } from './helpers.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex', 'fake-app-server.mjs');

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'FAKE_CODEX_SCENARIO', 'FAKE_CODEX_LOG']) saved[k] = process.env[k];
  process.env.OPENAI_API_KEY = 'sk-finta-per-i-test';
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function fake(scenario: Record<string, unknown>) {
  const dir = tmpDir('keystone-codex-');
  const scen = path.join(dir, 'scenario.json');
  const log = path.join(dir, 'log.jsonl');
  fs.writeFileSync(scen, JSON.stringify(scenario));
  const engine = new CodexEngine({ codexHome: path.join(dir, 'codex-home'), binPath: FAKE, extraEnv: { FAKE_CODEX_SCENARIO: scen, FAKE_CODEX_LOG: log } });
  const entries = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>) : []);
  return { engine, entries, home: path.join(dir, 'codex-home') };
}

function spec(cwd: string, over: Partial<TurnSpec> = {}): TurnSpec {
  return {
    agentId: 'bruno',
    agentName: 'Bruno',
    role: 'worker',
    cwd,
    prompt: 'lavora',
    instructions: 'istruzioni di Keystone',
    model: '',
    env: { PATH: process.env.PATH, GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'credential.helper', OPENAI_API_KEY: 'sk-non-deve-passare' },
    writableRoots: [],
    tools: [{ name: 'list_tasks', description: 'tabellone', schema: z.object({}), run: async () => ({ text: 'nessun task' }) }],
    job: { kind: 'work', taskId: 't1' },
    ...over,
  };
}

async function drain(turn: ReturnType<CodexEngine['startSession']>, answer: (e: Extract<EngineEvent, { type: 'permission_request' }>) => boolean = () => true): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of turn.events) {
    out.push(e);
    if (e.type === 'permission_request') turn.respond(e.requestId, answer(e) ? { allow: true } : { allow: false, message: 'no' });
  }
  return out;
}

describe('motore Codex: parti', () => {
  it('toglie l\'involucro della shell: la policy vede il comando interno', () => {
    expect(unwrapShell('"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content README.md"')).toEqual({ tool: 'PowerShell', command: 'Get-Content README.md' });
    expect(unwrapShell('powershell.exe -NoProfile -Command "git push origin main"')).toEqual({ tool: 'PowerShell', command: 'git push origin main' });
    expect(unwrapShell("/bin/bash -lc 'npm test && git status'")).toEqual({ tool: 'Bash', command: 'npm test && git status' });
    expect(unwrapShell('cmd /c npm test')).toEqual({ tool: 'Bash', command: 'npm test' });
    expect(unwrapShell('npm test')).toEqual({ tool: 'Bash', command: 'npm test' });
    // opzioni sconosciute: l'involucro resta intero (la policy vede la shell e chiede)
    expect(unwrapShell('powershell -EncodedCommand ZQBjAGgAbwA=')).toEqual({ tool: 'PowerShell', command: 'powershell -EncodedCommand ZQBjAGgAbwA=' });
  });

  it('nomi dei modelli, tool del team come dynamicTools', () => {
    expect(displayCodexModel('gpt-6.1-sol')).toBe('GPT-6.1 Sol');
    expect(displayCodexModel('modello-strano')).toBe('modello-strano');
    const [t] = dynamicTools([{ name: 'update_task', description: 'aggiorna', schema: z.object({ task_id: z.string(), status: z.enum(['doing', 'review']) }), run: async () => ({ text: '' }) }]);
    expect(t).toMatchObject({ type: 'function', name: 'update_task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } } } });
  });

  it('ambiente e configurazione: niente credenziali, CODEX_HOME di Keystone, isolamento, sandbox', () => {
    const home = path.join(tmpDir(), 'codex-home');
    const engine = new CodexEngine({ codexHome: home });
    const env = engine.processEnv({ PATH: 'x', OPENAI_API_KEY: 'sk-x', CODEX_API_KEY: 'k', ANTHROPIC_API_KEY: 'a', CODEX_HOME: 'C:\\Users\\utente\\.codex', GIT_CONFIG_COUNT: '1' });
    expect(env).toMatchObject({ PATH: 'x', CODEX_HOME: home, GIT_CONFIG_COUNT: '1' });
    for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY']) expect(env[k], k).toBeUndefined();
    const worker = engine.threadConfig({ role: 'worker', env: { GIT_CONFIG_KEY_0: 'credential.helper', KEYSTONE_AGENT: 'bruno', OPENAI_API_KEY: 'sk-x', HOME: 'h' } }, ['C:\\r\\.git\\objects']);
    expect(worker).toMatchObject({
      mcp_servers: {},
      project_doc_max_bytes: 0,
      web_search: 'disabled',
      features: { remote_plugin: false, tool_suggest: false, memories: false },
      shell_environment_policy: { inherit: 'core', set: { GIT_CONFIG_KEY_0: 'credential.helper', KEYSTONE_AGENT: 'bruno' } },
      windows: { sandbox: 'unelevated' },
      sandbox_workspace_write: { writable_roots: ['C:\\r\\.git\\objects'], network_access: false },
    });
    expect((worker.shell_environment_policy as { set: Record<string, string> }).set.OPENAI_API_KEY).toBeUndefined();
    const lead = engine.threadConfig({ role: 'lead', env: {} }, []);
    expect(lead.windows).toBeUndefined();
    expect(lead.sandbox_workspace_write).toBeUndefined();
  });

  it('cartelle scrivibili del worker: oggetti, il suo branch e la gitdir del worktree, mai l\'intera .git', async () => {
    const { o, cfg } = testOrchestrator({ workers: 1 });
    const repoPath = await demoRepo(cfg.home);
    const r = await o.repos.add(repoPath, { confirmGuard: true });
    const wt = await o.repos.createWorktree(r.id, 'bruno', { id: 't1', title: 'Saluto' });
    const roots = await new CodexEngine({ codexHome: tmpDir() }).writableRoots(wt.path);
    const common = path.join(repoPath, '.git');
    expect(roots).toEqual(expect.arrayContaining([path.join(common, 'objects'), path.join(common, 'refs', 'heads', 'Keystone', 'bruno'), path.join(common, 'logs', 'refs', 'heads', 'Keystone', 'bruno')]));
    expect(roots.some((x) => x.includes(path.join('.git', 'worktrees')))).toBe(true);
    expect(roots).not.toContain(common);
    expect(roots.some((x) => /[\\/](config|hooks)$/.test(x))).toBe(false);
  });
});

describe('motore Codex: un turno (app-server finto)', () => {
  it('handshake, login con la chiave, skill disattivate, thread isolato; la chiave non arriva al processo', async () => {
    const { engine, entries } = fake({ account: null, skills: [{ name: 'imagegen', path: 'C:\\h\\skills\\.system\\imagegen\\SKILL.md', enabled: true }], steps: [{ notify: 'item/completed', params: { threadId: '$THREAD', turnId: '$TURN', item: { type: 'agentMessage', id: 'm1', text: 'fatto' } } }] });
    const events = await drain(engine.startSession(spec(tmpDir())));
    expect(events.at(-1)).toEqual({ type: 'turn_end', status: 'success', resultText: 'fatto' });
    expect(events).toContainEqual({ type: 'session', sessionId: 'th-finto-1' });
    expect(events).toContainEqual({ type: 'model', model: 'gpt-finto-1' });
    const log = entries();
    const methods = log.filter((e) => e.t === 'in' && e.msg.method).map((e) => e.msg.method);
    expect(methods.slice(0, 7)).toEqual(['initialize', 'initialized', 'account/read', 'account/login/start', 'skills/list', 'skills/config/write', 'thread/start']);
    const login = log.find((e) => e.msg?.method === 'account/login/start')!.msg.params;
    expect(login).toEqual({ type: 'apiKey', apiKey: 'sk-finta-per-i-test' });
    expect(log.find((e) => e.msg?.method === 'skills/config/write')!.msg.params).toEqual({ path: 'C:\\h\\skills\\.system\\imagegen\\SKILL.md', enabled: false });
    const start = log.find((e) => e.msg?.method === 'thread/start')!.msg.params;
    expect(start).toMatchObject({ approvalPolicy: 'untrusted', sandbox: 'workspace-write', config: { mcp_servers: {}, project_doc_max_bytes: 0 }, dynamicTools: [{ name: 'list_tasks' }] });
    expect(start.developerInstructions).toContain('istruzioni di Keystone');
    // il processo di Codex non riceve la chiave né le altre credenziali (né quelle dell'ambiente degli agenti)
    const env = log.find((e) => e.t === 'env')!.env;
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toMatch(/codex-home$/);
  });

  it('comandi e modifiche di file passano dalla policy; i dinieghi tornano a Codex come "decline"', async () => {
    const { engine, entries } = fake({
      account: { type: 'apiKey' },
      steps: [
        { notify: 'item/started', params: { threadId: '$THREAD', turnId: '$TURN', item: { type: 'commandExecution', id: 'c1', command: 'powershell.exe -Command "npm test"', cwd: '.', status: 'inProgress' } } },
        { request: 'item/commandExecution/requestApproval', params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'c1', kind: 'command', command: 'powershell.exe -Command "npm test"', startedAtMs: 1, environmentId: null } },
        { notify: 'item/completed', params: { threadId: '$THREAD', turnId: '$TURN', item: { type: 'commandExecution', id: 'c1', command: 'npm test', cwd: '.', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' } } },
        { request: 'item/commandExecution/requestApproval', params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'c2', kind: 'command', command: '/bin/bash -lc "git push origin main"', startedAtMs: 2, environmentId: null } },
        { notify: 'item/started', params: { threadId: '$THREAD', turnId: '$TURN', item: { type: 'fileChange', id: 'f1', changes: [{ path: 'saluto.js', kind: { type: 'add' }, diff: '+ciao' }], status: 'inProgress' } } },
        { request: 'item/fileChange/requestApproval', params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'f1', startedAtMs: 3 } },
        { request: 'item/tool/requestUserInput', params: { threadId: '$THREAD', turnId: '$TURN' } },
        { request: 'item/permissions/requestApproval', params: { threadId: '$THREAD', turnId: '$TURN' } },
        { request: 'item/commandExecution/requestApproval', params: { threadId: 'altro-thread', turnId: 'x', itemId: 'c9', kind: 'command', command: 'ls', startedAtMs: 4, environmentId: null } },
      ],
    });
    const cwd = tmpDir();
    const asked: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const events = await drain(engine.startSession(spec(cwd)), (e) => {
      asked.push({ tool: e.tool, input: e.input });
      return !String(e.input.command ?? '').includes('git push');
    });
    expect(asked).toEqual([
      { tool: 'PowerShell', input: { command: 'npm test' } },
      { tool: 'Bash', input: { command: 'git push origin main' } },
      { tool: 'Edit', input: { file_path: path.join(cwd, 'saluto.js') } },
    ]);
    const responses = entries().filter((e) => e.t === 'response').map((e) => [e.method, e.res]);
    expect(responses).toEqual([
      ['item/commandExecution/requestApproval', { decision: 'accept' }],
      ['item/commandExecution/requestApproval', { decision: 'decline' }],
      ['item/fileChange/requestApproval', { decision: 'accept' }],
      ['item/tool/requestUserInput', { error: expect.objectContaining({ message: expect.stringMatching(/ask_user/) }) }],
      ['item/permissions/requestApproval', { error: expect.objectContaining({ message: expect.stringMatching(/permessi aggiuntivi/) }) }],
      ['item/commandExecution/requestApproval', { error: expect.objectContaining({ message: 'thread sconosciuto' }) }],
    ]);
    expect(events.filter((e) => e.type === 'tool_call').map((e) => (e as { tool: string }).tool)).toEqual(['PowerShell', 'Write']);
    expect(events).toContainEqual({ type: 'tool_result', callId: 'c1', ok: true, output: 'ok' });
  });

  it('senza chiave e senza login: nessun turno, errore di autenticazione', async () => {
    delete process.env.OPENAI_API_KEY;
    const { engine } = fake({ account: null, steps: [] });
    expect(await engine.checkAuth()).toMatchObject({ ok: false, message: expect.stringMatching(/OPENAI_API_KEY/) });
    const events = await drain(engine.startSession(spec(tmpDir())));
    expect(events.find((e) => e.type === 'error')).toMatchObject({ auth: true });
    expect(events.at(-1)).toEqual({ type: 'turn_end', status: 'error' });
  });

  it('il worker non parte se Codex non attiva la sandbox con scrittura (Windows senza windows.sandbox)', async () => {
    const { engine } = fake({ account: { type: 'apiKey' }, sandbox: { type: 'readOnly', networkAccess: false }, steps: [] });
    const events = await drain(engine.startSession(spec(tmpDir())));
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/sandbox con scrittura/) });
    expect(events.at(-1)).toEqual({ type: 'turn_end', status: 'error' });
  });

  it('interruzione: turn/interrupt e turno chiuso come interrotto', async () => {
    const { engine, entries } = fake({ account: { type: 'apiKey' }, hang: true, steps: [] });
    const turn = engine.startSession(spec(tmpDir()));
    const events: EngineEvent[] = [];
    const reading = (async () => {
      for await (const e of turn.events) {
        events.push(e);
        if (e.type === 'session') setTimeout(() => turn.abort('pause'), 300);
      }
    })();
    await reading;
    expect(events.at(-1)).toEqual({ type: 'turn_end', status: 'aborted' });
    expect(entries().some((e) => e.msg?.method === 'turn/interrupt')).toBe(true);
  });

  it('ripresa: thread/resume con lo stesso thread, token contati solo per il turno', async () => {
    const { engine, entries } = fake({
      account: { type: 'apiKey' },
      steps: [
        { notify: 'thread/tokenUsage/updated', params: { threadId: '$THREAD', turnId: '$TURN', tokenUsage: { total: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 }, last: { totalTokens: 500, inputTokens: 400, outputTokens: 100 } } } },
        { notify: 'thread/tokenUsage/updated', params: { threadId: '$THREAD', turnId: '$TURN', tokenUsage: { total: { totalTokens: 1800, inputTokens: 1450, outputTokens: 350 }, last: { totalTokens: 300, inputTokens: 250, outputTokens: 50 } } } },
      ],
    });
    const events = await drain(engine.resumeSession('th-precedente', spec(tmpDir())));
    expect(entries().find((e) => e.msg?.method === 'thread/resume')!.msg.params).toMatchObject({ threadId: 'th-precedente', approvalPolicy: 'untrusted' });
    const usage = events.filter((e) => e.type === 'usage') as Array<{ inputTokens: number; outputTokens: number }>;
    // 1000 token erano dei turni precedenti: si contano 500 + 300
    expect(usage.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0)).toBe(800);
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', status: 'success' });
  });
});

describe('motore Codex nel team (app-server finto)', () => {
  it('lead e worker Codex: i tool del team passano dalla policy e girano sull\'orchestratore; un worker non può creare task', async () => {
    const dir = tmpDir('keystone-codex-team-');
    const scen = path.join(dir, 'scenario.json');
    // stesso scenario per ogni turno: create_task (consentito al lead, negato al worker), poi list_tasks
    fs.writeFileSync(
      scen,
      JSON.stringify({
        account: { type: 'apiKey' },
        steps: [
          { request: 'item/tool/call', params: { threadId: '$THREAD', turnId: '$TURN', callId: 'k1', namespace: null, tool: 'create_task', arguments: { title: 'Saluto in inglese', description: 'aggiungi saluta_en' } } },
          { notify: 'item/completed', params: { threadId: '$THREAD', turnId: '$TURN', item: { type: 'agentMessage', id: 'm1', text: 'piano pronto' } } },
        ],
      }),
    );
    const log = path.join(dir, 'log.jsonl');
    const engine = new CodexEngine({ codexHome: path.join(dir, 'codex-home'), binPath: FAKE, extraEnv: { FAKE_CODEX_SCENARIO: scen, FAKE_CODEX_LOG: log } });
    const engines = new Map<EngineId, EngineAdapter>([['codex', engine]]);
    const { o, cfg } = testOrchestrator({ workers: 1, leadReview: false, engines, cfg: { agents: defaultAgents('codex', 1) } });
    await o.repos.add(await demoRepo(cfg.home), { confirmGuard: true });
    await o.start();
    await o.handle({ v: 1, type: 'goal.submit', text: 'Aggiungi un saluto in inglese' }, noReply);
    await waitFor(() => o.tasks.get('t1'), 'task creato dal lead Codex');
    expect(o.tasks.get('t1')).toMatchObject({ title: 'Saluto in inglese' });
    // il worker riceve lo stesso scenario: create_task non è tra i suoi tool, quindi non gira
    await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('tool sconosciuto: create_task'), 'create_task rifiutata al worker', 30_000);
    expect(o.tasks.list()).toHaveLength(1);
    expect(o.agent('ada')?.model).toBe('gpt-finto-1'); // il nome riportato da Codex all'avvio del thread
    await o.team.idle();
  });
});
