// Motore Claude con trascrizioni registrate: nessuna chiamata API. Gli hook passano davvero dalla
// policy di Keystone e i tool del team vengono eseguiti davvero sull'orchestratore.
import path from 'node:path';
import type { EngineEvent, EngineId } from '@keystone/shared';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultAgents } from '../src/config.js';
import { detectApiAuth, envForAuth } from '../src/engines/claude/auth.js';
import { assertNoPermissionBypass, ClaudeEngine, DISALLOWED_TOOLS, LEAD_TOOLS, WORKER_TOOLS } from '../src/engines/claude/claude-engine.js';
import { displayClaudeModel } from '../src/engines/claude/models.js';
import { loadTranscript, replayQuery, type ReplayRecord, type TranscriptEntry } from '../src/engines/claude/replay.js';
import type { EngineAdapter, TurnSpec } from '../src/engines/types.js';
import { demoRepo, noReply, testOrchestrator, tmpDir, waitFor } from './helpers.js';

const FIX = path.resolve(import.meta.dirname, 'fixtures', 'claude');
const leadPlan = () => loadTranscript(path.join(FIX, 'lead-plan.jsonl'));
const workerWork = () => loadTranscript(path.join(FIX, 'worker-work.jsonl'));

// l'ambiente del test non deve influire: niente credenziali vere
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_AUTH_TOKEN']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = 'sk-ant-finta-per-i-test';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token-di-login-che-non-deve-passare';
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function setupTeam(turns: TranscriptEntry[][], opts: { budgetUsd?: number } = {}) {
  const records: ReplayRecord[] = [];
  const home = tmpDir();
  const engine = new ClaudeEngine({ configDir: path.join(home, 'claude-config'), effort: 'medium', leadEffort: 'high' }, replayQuery(turns, records));
  const engines = new Map<EngineId, EngineAdapter>([['claude', engine]]);
  const { o, cfg } = testOrchestrator({ home, engines, cfg: { agents: defaultAgents('claude', 1) } });
  await o.repos.add(await demoRepo(cfg.home), { confirmGuard: true });
  await o.start();
  await o.handle({ v: 1, type: 'goal.submit', text: 'Aggiungi un saluto in inglese', ...(opts.budgetUsd ? { budgetUsd: opts.budgetUsd } : {}) }, noReply);
  return { o, records, home };
}

function spec(cwd: string, over: Partial<TurnSpec> = {}): TurnSpec {
  return {
    agentId: 'bruno',
    agentName: 'Bruno',
    role: 'worker',
    cwd,
    prompt: 'lavora',
    instructions: 'istruzioni',
    model: 'claude-sonnet-5-5',
    env: { ...process.env },
    writableRoots: [],
    tools: [{ name: 'update_task', description: 'x', schema: z.object({ task_id: z.string(), status: z.string().optional(), summary: z.string().optional() }), run: async () => ({ text: 'ok' }) }],
    job: { kind: 'work', taskId: 't1' },
    ...over,
  };
}

async function drain(turn: ReturnType<ClaudeEngine['startSession']>, answer: (e: Extract<EngineEvent, { type: 'permission_request' }>) => boolean = () => true): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of turn.events) {
    out.push(e);
    if (e.type === 'permission_request') turn.respond(e.requestId, answer(e) ? { allow: true } : { allow: false, message: 'no' });
  }
  return out;
}

describe('motore Claude: opzioni', () => {
  it('nessuna modalità che salti i permessi, nessuna configurazione utente, solo i tool previsti', async () => {
    const { o, records, home } = await setupTeam([leadPlan(), workerWork()]);
    await waitFor(() => records.length >= 1, 'primo turno');
    const lead = records[0]!.options!;
    expect(lead.permissionMode).toBe('default');
    expect((lead as { allowDangerouslySkipPermissions?: boolean }).allowDangerouslySkipPermissions).toBeUndefined();
    expect(lead.allowedTools).toBeUndefined();
    expect(lead.settingSources).toEqual([]);
    expect(lead.strictMcpConfig).toBe(true);
    expect(lead.skills).toEqual([]);
    expect(lead.plugins).toEqual([]);
    expect(Object.keys(lead.mcpServers ?? {})).toEqual(['keystone']);
    expect(lead.tools).toEqual(LEAD_TOOLS);
    expect(lead.disallowedTools).toEqual(expect.arrayContaining(['Agent', 'Task', 'Skill', 'WebSearch', 'WebFetch']));
    expect(lead.hooks?.PreToolUse?.[0]?.matcher).toBeUndefined(); // l'hook vale per tutti i tool
    expect(lead.canUseTool).toBeTypeOf('function');
    expect(lead.model).toBe('claude-opus-5-5');
    expect(lead.effort).toBe('high');
    expect(lead.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
    // la CLI usa una cartella di configurazione di Keystone, mai ~/.claude
    expect(path.resolve(lead.env!.CLAUDE_CONFIG_DIR!)).toBe(path.resolve(home, 'claude-config'));
    // modalità API: il token di login personale non passa; la chiave sì
    expect(lead.env!.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(lead.env!.ANTHROPIC_API_KEY).toBe('sk-ant-finta-per-i-test');
    // la sicurezza git arriva anche ai processi della CLI
    expect(lead.env!.GIT_ALLOW_PROTOCOL).toBe('keystone-none');

    await waitFor(() => records.length >= 2, 'turno del worker');
    const worker = records[1]!.options!;
    expect(worker.tools).toEqual(WORKER_TOOLS);
    expect(worker.model).toBe('claude-sonnet-5-5');
    expect(worker.effort).toBe('medium');
    expect(worker.cwd).toContain(`${path.sep}ks-bruno-t1`);
    expect(worker.env!.GIT_AUTHOR_NAME).toBe('Keystone Bruno');
    // il worker aspetta la risposta al permesso per curl: la diamo, poi il team si ferma
    const p = await waitFor(() => o.decisions.open().find((d) => d.kind === 'permission'), 'permesso');
    await o.handle({ v: 1, type: 'decision.answer', decisionId: p.id, option: 'Nega' }, noReply);
    await o.team.idle();
  });

  it('assertNoPermissionBypass rifiuta ogni variante che salterebbe la policy', () => {
    const base: Options = { permissionMode: 'default', hooks: { PreToolUse: [{ hooks: [async () => ({ continue: true })] }] }, canUseTool: async () => ({ behavior: 'deny', message: 'x' }) };
    expect(() => assertNoPermissionBypass(base)).not.toThrow();
    for (const mode of ['bypassPermissions', 'acceptEdits', 'auto', 'dontAsk', 'plan', undefined]) {
      expect(() => assertNoPermissionBypass({ ...base, permissionMode: mode as Options['permissionMode'] })).toThrow(/permissionMode/);
    }
    expect(() => assertNoPermissionBypass({ ...base, allowDangerouslySkipPermissions: true } as Options)).toThrow();
    expect(() => assertNoPermissionBypass({ ...base, allowedTools: ['Bash'] })).toThrow(/allowedTools/);
    expect(() => assertNoPermissionBypass({ ...base, permissionPrompts: 'none' } as Options)).toThrow();
    expect(() => assertNoPermissionBypass({ ...base, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [async () => ({ continue: true })] }] } })).toThrow(/PreToolUse/);
    expect(() => assertNoPermissionBypass({ ...base, hooks: {} })).toThrow(/PreToolUse/);
    const { canUseTool: _c, ...noCan } = base;
    expect(() => assertNoPermissionBypass(noCan)).toThrow(/canUseTool/);
  });

  it('il codice sorgente non contiene modi per saltare i permessi', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'engines', 'claude', 'claude-engine.ts'), 'utf8');
    for (const forbidden of ["'bypassPermissions'", "'acceptEdits'", "'dontAsk'", 'allowDangerouslySkipPermissions: true', "permissionPrompts: 'none'"]) expect(src).not.toContain(forbidden);
    expect(DISALLOWED_TOOLS).toContain('Agent');
  });
});

describe('motore Claude: ogni tool passa dalla policy di Keystone', () => {
  it('piano e lavoro da trascrizione: letture consentite, rete chiesta all\'utente, tool del team eseguiti davvero', async () => {
    const { o, records } = await setupTeam([leadPlan(), workerWork()]);
    // la curl del worker diventa una richiesta di permesso: la neghiamo
    const p = await waitFor(() => o.decisions.open().find((d) => d.kind === 'permission'), 'richiesta di permesso per curl');
    expect(p.command).toBe('Bash: curl https://example.com');
    await o.handle({ v: 1, type: 'decision.answer', decisionId: p.id, option: 'Nega' }, noReply);
    await waitFor(() => o.tasks.get('t1')?.status === 'done', 'task completato');
    await o.team.idle();

    // ogni chiamata è passata dall'hook, con la decisione della policy
    expect(records[0]!.decisions.map((d) => [d.toolName, d.decision])).toEqual([
      ['Glob', 'allow'],
      ['mcp__keystone__create_task', 'allow'],
      ['mcp__keystone__write_memory', 'allow'],
    ]);
    expect(records[1]!.decisions.map((d) => [d.toolName, d.decision])).toEqual([
      ['Read', 'allow'],
      ['Bash', 'deny'],
      ['mcp__keystone__update_task', 'allow'],
    ]);
    // i tool del team hanno agito sull'orchestratore
    expect(o.tasks.get('t1')?.title).toBe('Aggiungi il saluto in inglese');
    expect(o.memory.get('shared/piano')?.body).toBe('- t1: saluto in inglese');
    // vista: modelli, log con i nomi normalizzati, costi
    expect(o.agent('ada')?.model).toBe('Opus 5.5');
    expect(o.agent('bruno')?.model).toBe('Sonnet 5.5');
    expect(o.store.logTail('ada').some((l) => l.kind === 'tool' && l.text.includes('crea il task'))).toBe(true);
    expect(o.store.logTail('bruno').some((l) => l.kind === 'permission' && l.text.includes('negato'))).toBe(true);
    expect(o.goal('g1')?.costUsd).toBeCloseTo(0.42, 6);
    expect(o.status.costUsd).toBeCloseTo(0.42, 6);
    expect(o.store.data.sessions['ada:g1']).toMatchObject({ sessionId: 'sess-lead-1', engine: 'claude', costUsd: 0.12 });
    expect(o.store.data.sessions['bruno:t1']).toMatchObject({ sessionId: 'sess-worker-1', costUsd: 0.3 });
  });

  it('un server MCP diverso da quello di Keystone viene negato senza chiedere', async () => {
    const turn = new ClaudeEngine({ configDir: tmpDir() }, replayQuery([[{ t: 'hook', toolUseId: 'x1', toolName: 'mcp__server-utente__esegui', input: {} }]]));
    const engine = turn;
    const events = await drain(engine.startSession(spec(tmpDir())), (e) => e.tool !== 'mcp__server-utente__esegui');
    const req = events.find((e) => e.type === 'permission_request');
    expect(req).toMatchObject({ tool: 'mcp__server-utente__esegui' });
    const { classify } = await import('../src/core/policy.js');
    expect(classify('mcp__server-utente__esegui', {}, { role: 'worker', cwd: tmpDir() }).action).toBe('deny');
    expect(classify('mcp__keystone__update_task', {}, { role: 'worker', cwd: tmpDir() }).action).toBe('allow');
    expect(classify('mcp__keystone__create_task', {}, { role: 'worker', cwd: tmpDir() }).action).toBe('deny'); // solo il lead crea task
  });
});

describe('motore Claude: sessioni, costi ed errori', () => {
  it('resumeSession passa resume e conta solo l\'incremento del costo cumulativo', async () => {
    const records: ReplayRecord[] = [];
    const transcript: TranscriptEntry[] = [
      { t: 'msg', msg: { type: 'system', subtype: 'init', session_id: 'sess-x', model: 'claude-sonnet-5-5' } },
      { t: 'msg', msg: { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0.3, num_turns: 1 } },
    ];
    const engine = new ClaudeEngine({ configDir: tmpDir() }, replayQuery([transcript], records));
    const events = await drain(engine.resumeSession('sess-x', spec(tmpDir(), { sessionCostUsd: 0.25, budgetUsd: 1.234 })));
    expect(records[0]!.options!.resume).toBe('sess-x');
    expect(records[0]!.options!.maxBudgetUsd).toBe(1.23);
    const usage = events.filter((e) => e.type === 'usage' && e.costUsd);
    expect(usage).toHaveLength(1);
    expect((usage[0] as { costUsd: number }).costUsd).toBeCloseTo(0.05, 6);
    expect(events.at(-1)).toEqual({ type: 'turn_end', status: 'success', resultText: 'ok' });
  });

  it('esiti di errore: limite di turni, tetto di spesa del turno, autenticazione', async () => {
    const run = async (msgs: Array<Record<string, unknown>>) => drain(new ClaudeEngine({ configDir: tmpDir() }, replayQuery([msgs.map((msg) => ({ t: 'msg' as const, msg }))])).startSession(spec(tmpDir())));
    expect((await run([{ type: 'result', subtype: 'error_max_turns', errors: [] }])).at(-1)).toEqual({ type: 'turn_end', status: 'max_turns' });
    const budget = await run([{ type: 'result', subtype: 'error_max_budget_usd', errors: [], total_cost_usd: 0.5 }]);
    expect(budget.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/tetto di spesa/) });
    expect(budget.at(-1)).toEqual({ type: 'turn_end', status: 'error' });
    const auth = await run([{ type: 'assistant', error: 'authentication_failed', message: { id: 'm', content: [] } }, { type: 'result', subtype: 'error_during_execution', errors: ['401'] }]);
    expect(auth.find((e) => e.type === 'error' && e.auth)).toBeTruthy();
  });

  it('i nomi dei modelli sono mostrati per esteso', () => {
    expect(displayClaudeModel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(displayClaudeModel('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(displayClaudeModel('claude-haiku-4-5')).toBe('Haiku 4.5');
    expect(displayClaudeModel('anthropic.claude-opus-5-5')).toBe('Opus 5.5');
    expect(displayClaudeModel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(displayClaudeModel('qualcos-altro')).toBe('qualcos-altro');
  });
});

describe('motore Claude: autenticazione', () => {
  it('chiave API o provider cloud; senza credenziali errore chiaro; login personale solo se abilitato', async () => {
    expect(detectApiAuth({ ANTHROPIC_API_KEY: 'sk' })).toEqual({ ok: true, source: 'chiave API' });
    expect(detectApiAuth({ CLAUDE_CODE_USE_BEDROCK: '1' })).toEqual({ ok: true, source: 'Amazon Bedrock' });
    expect(detectApiAuth({ CLAUDE_CODE_USE_VERTEX: 'true' })).toEqual({ ok: true, source: 'Google Vertex AI' });
    expect(detectApiAuth({ CLAUDE_CODE_USE_FOUNDRY: '1' })).toEqual({ ok: true, source: 'Microsoft Foundry' });
    expect(detectApiAuth({ CLAUDE_CODE_USE_BEDROCK: '0' })).toEqual({ ok: false });
    expect(detectApiAuth({ CLAUDE_CODE_OAUTH_TOKEN: 'login' })).toEqual({ ok: false }); // il login non è credenziale API

    delete process.env.ANTHROPIC_API_KEY;
    const noKey = await new ClaudeEngine({ configDir: tmpDir() }).checkAuth();
    expect(noKey).toMatchObject({ ok: false, message: expect.stringMatching(/ANTHROPIC_API_KEY/) });
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    expect(await new ClaudeEngine({ configDir: tmpDir() }).checkAuth()).toEqual({ ok: true, account: 'Google Vertex AI' });

    expect(envForAuth({ ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' }, false)).toEqual({ ANTHROPIC_API_KEY: 'k' });
    expect(envForAuth({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'a', CLAUDE_CODE_OAUTH_TOKEN: 't' }, true)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 't' });
  });

  it('con il login personale abilitato la CLI usa la configurazione dell\'utente (dove stanno le credenziali), senza chiavi API', async () => {
    const records: ReplayRecord[] = [];
    const engine = new ClaudeEngine({ configDir: tmpDir(), useClaudeLogin: true }, replayQuery([[{ t: 'msg', msg: { type: 'result', subtype: 'success', total_cost_usd: 0 } }]], records));
    await drain(engine.startSession(spec(tmpDir())));
    const env = records[0]!.options!.env!;
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(records[0]!.options!.settingSources).toEqual([]); // le altre barriere restano
    expect(records[0]!.options!.permissionMode).toBe('default');
  });

  it('senza credenziali il team non avvia turni e lo dice nella barra di stato', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const records: ReplayRecord[] = [];
    const engines = new Map<EngineId, EngineAdapter>([['claude', new ClaudeEngine({ configDir: tmpDir() }, replayQuery([leadPlan()], records))]]);
    const { o, cfg } = testOrchestrator({ engines, cfg: { agents: defaultAgents('claude', 1) } });
    await o.repos.add(await demoRepo(cfg.home), { confirmGuard: true });
    await o.start();
    expect(o.status).toMatchObject({ auth: 'failed', message: expect.stringMatching(/ANTHROPIC_API_KEY/) });
    await o.handle({ v: 1, type: 'goal.submit', text: 'qualcosa' }, noReply);
    await new Promise((r) => setTimeout(r, 300));
    expect(records).toHaveLength(0);
  });
});
