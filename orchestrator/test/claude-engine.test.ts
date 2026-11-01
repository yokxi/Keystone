// Motore Claude con trascrizioni registrate: nessuna chiamata API. Gli hook passano davvero dalla
// policy di Keystone e i tool del team vengono eseguiti davvero sull'orchestratore.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineEvent, EngineId } from '@keystone/shared';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultAgents } from '../src/config.js';
import { detectApiAuth, envForAuth } from '../src/engines/claude/auth.js';
import { assertNoPermissionBypass, ClaudeEngine, DISALLOWED_TOOLS, LEAD_TOOLS, sessionCostDelta, WORKER_TOOLS } from '../src/engines/claude/claude-engine.js';
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
  /** Un turno ripreso: un messaggio con `observed` token, poi il risultato con total e modelUsage. */
  async function resumedTurn(total: number, base: number, observed: number, modelTokens?: number) {
    const records: ReplayRecord[] = [];
    const transcript: TranscriptEntry[] = [
      { t: 'msg', msg: { type: 'system', subtype: 'init', session_id: 'sess-x', model: 'claude-sonnet-5-5' } },
      { t: 'msg', msg: { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'continuo' }], usage: { input_tokens: observed - 100, output_tokens: 100 } } } },
      {
        t: 'msg',
        msg: { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: total, num_turns: 1, ...(modelTokens ? { modelUsage: { 'claude-sonnet-5-5': { inputTokens: modelTokens - 100, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: total } } } : {}) },
      },
    ];
    const engine = new ClaudeEngine({ configDir: tmpDir() }, replayQuery([transcript], records));
    const events = await drain(engine.resumeSession('sess-x', spec(tmpDir(), { sessionCostUsd: base, budgetUsd: 1.234 })));
    const cost = events.find((e) => e.type === 'usage' && e.sessionTotalUsd !== undefined) as Extract<EngineEvent, { type: 'usage' }>;
    return { records, events, cost };
  }

  it('sessione ripresa che ha ritrovato il totale (modelUsage include i turni precedenti): conta solo l\'incremento', async () => {
    const { records, events, cost } = await resumedTurn(0.3, 0.25, 2_000, 12_000);
    expect(records[0]!.options!.resume).toBe('sess-x');
    expect(records[0]!.options!.maxBudgetUsd).toBe(1.23);
    expect(cost.costUsd).toBeCloseTo(0.05, 6);
    expect(cost.unreconciledUsd).toBeUndefined();
    expect(cost.sessionTotalUsd).toBe(0.3);
    expect(events.at(-1)).toEqual({ type: 'turn_end', status: 'success', resultText: 'ok' });
  });

  it('sessione ripresa che NON ha ritrovato il totale (total < base): conta tutto il totale', async () => {
    const { cost } = await resumedTurn(0.1, 0.25, 2_000, 2_000);
    expect(cost.costUsd).toBeCloseTo(0.1, 6);
    expect(cost.unreconciledUsd).toBeUndefined();
    // la base del turno dopo è il totale che conosce la CLI, non la somma di Keystone
    expect(cost.sessionTotalUsd).toBe(0.1);
  });

  it('sessione ripresa non ritrovata con total >= base: modelUsage uguale al turno, conta tutto (prima ne contava meno)', async () => {
    const { cost } = await resumedTurn(0.4, 0.25, 2_000, 2_050);
    expect(cost.costUsd).toBeCloseTo(0.4, 6);
    expect(cost.unreconciledUsd).toBeUndefined();
  });

  it('sessione ripresa senza prove (nessun modelUsage): conta in modo prudente e segna la parte non riconciliata', async () => {
    const { cost } = await resumedTurn(0.3, 0.25, 2_000);
    expect(cost.costUsd).toBeCloseTo(0.3, 6); // mai meno della spesa possibile
    expect(cost.unreconciledUsd).toBeCloseTo(0.25, 6); // forse già contata
  });

  it('sessionCostDelta: casi limite', () => {
    const base = { resumed: true, observedTokens: 1_000, modelTokens: 1_000, compacted: false };
    expect(sessionCostDelta({ ...base, resumed: false, base: 0.5, total: 0.7 })).toEqual({ delta: 0.7, unreconciled: 0, how: 'new' });
    expect(sessionCostDelta({ ...base, base: 0, total: 0.7 })).toMatchObject({ delta: 0.7, how: 'new' });
    // una compattazione aggiunge token a modelUsage che il turno non vede: niente prove, prudenza
    expect(sessionCostDelta({ ...base, compacted: true, modelTokens: 10_000, base: 0.2, total: 0.5 })).toMatchObject({ delta: 0.5, unreconciled: 0.2, how: 'unknown' });
    // zona incerta tra "ritrovato" e "non ritrovato": prudenza
    expect(sessionCostDelta({ ...base, modelTokens: 1_250, base: 0.5, total: 1 })).toMatchObject({ delta: 1, unreconciled: 0.5, how: 'unknown' });
    expect(sessionCostDelta({ ...base, modelTokens: 2_000, base: 0.5, total: 1 })).toMatchObject({ delta: 0.5, how: 'restored' });
  });

  it('esiti di errore: limite di turni, tetto di spesa del turno, autenticazione', async () => {
    const run = async (msgs: Array<Record<string, unknown>>) => drain(new ClaudeEngine({ configDir: tmpDir() }, replayQuery([msgs.map((msg) => ({ t: 'msg' as const, msg }))])).startSession(spec(tmpDir())));
    expect((await run([{ type: 'result', subtype: 'error_max_turns', errors: [] }])).at(-1)).toEqual({ type: 'turn_end', status: 'max_turns' });
    // quota del turno esaurita: non è un errore, il team riprende la sessione quando c'è spesa
    const budget = await run([{ type: 'result', subtype: 'error_max_budget_usd', errors: [], total_cost_usd: 0.5 }]);
    expect(budget.find((e) => e.type === 'error')).toBeUndefined();
    expect(budget.find((e) => e.type === 'usage')).toMatchObject({ costUsd: 0.5 });
    expect(budget.at(-1)).toEqual({ type: 'turn_end', status: 'budget' });
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

  it('con il login personale la CLI resta nella cartella isolata: credenziale solo dal token, niente chiavi API', async () => {
    const records: ReplayRecord[] = [];
    const configDir = tmpDir();
    const engine = new ClaudeEngine({ configDir, useClaudeLogin: true }, replayQuery([[{ t: 'msg', msg: { type: 'result', subtype: 'success', total_cost_usd: 0 } }]], records));
    await drain(engine.startSession(spec(tmpDir(), { env: { ANTHROPIC_API_KEY: 'sk-ant-finta', CLAUDE_CODE_OAUTH_TOKEN: 'token-finto' } })));
    const env = records[0]!.options!.env!;
    expect(env.CLAUDE_CONFIG_DIR).toBe(configDir); // mai ~/.claude
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-finto');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
    expect(records[0]!.options!.settingSources).toEqual([]);
    expect(records[0]!.options!.permissionMode).toBe('default');
    expect(engine.billing).toBe('subscription');
    expect(new ClaudeEngine({ configDir }).billing).toBe('api');
  });

  it('il login personale senza token non parte, e spiega come ottenerlo', async () => {
    const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const engine = new ClaudeEngine({ configDir: tmpDir(), useClaudeLogin: true });
      expect(await engine.checkAuth()).toMatchObject({ ok: false, message: expect.stringMatching(/claude setup-token/) });
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token-finto';
      expect(await engine.checkAuth()).toMatchObject({ ok: true });
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
    }
  });

  it('con il login personale: nessun tetto in dollari, salvo richiesta esplicita (freno sulla stima)', async () => {
    const { applyLoginBudget, defaultConfig } = await import('../src/config.js');
    const a = defaultConfig({});
    expect(a.budgetUsdPerGoal).toBe(5);
    expect(applyLoginBudget(a, false)).toMatch(/stima/);
    expect(a.budgetUsdPerGoal).toBe(0);
    const b = { ...defaultConfig({}), budgetUsdPerGoal: 2 };
    expect(applyLoginBudget(b, true)).toMatch(/\$2 applicato alla spesa stimata/);
    expect(b.budgetUsdPerGoal).toBe(2);
  });

  it('la barra di stato dice se la spesa è una stima (abbonamento)', async () => {
    const engines = new Map<EngineId, EngineAdapter>([['claude', new ClaudeEngine({ configDir: tmpDir(), useClaudeLogin: true }, replayQuery([[]]))]]);
    const { o } = testOrchestrator({ workers: 1, engines, cfg: { agents: defaultAgents('claude', 1) } });
    expect(o.status.billing).toBe('subscription');
    const { o: sim } = testOrchestrator({ workers: 1 });
    expect(sim.status.billing).toBeUndefined();
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

describe('trascrizioni vere (prova con il login, CLI 2.1.302)', () => {
  const real = (f: string) => loadTranscript(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude', 'real', f));

  it('total_cost_usd: il piano conta tutto, la review (stessa sessione ripresa) solo l\'incremento', async () => {
    const plan = real('ada-plan-g1.jsonl');
    const review = real('ada-review-t1.jsonl');
    const sessionOf = (t: TranscriptEntry[]) => t.flatMap((e) => (e.t === 'msg' && e.msg.type === 'result' ? [e.msg.session_id] : []))[0];
    expect(sessionOf(review)).toBe(sessionOf(plan)); // la review riprende la sessione del piano

    const first = await drain(new ClaudeEngine({ configDir: tmpDir(), useClaudeLogin: true }, replayQuery([plan])).startSession(spec(tmpDir(), { role: 'lead' })));
    const c1 = first.find((e) => e.type === 'usage' && e.sessionTotalUsd !== undefined) as Extract<EngineEvent, { type: 'usage' }>;
    expect(c1.costUsd).toBeCloseTo(0.0629525, 5);

    const second = await drain(new ClaudeEngine({ configDir: tmpDir(), useClaudeLogin: true }, replayQuery([review])).resumeSession('13dec756', spec(tmpDir(), { role: 'lead', sessionCostUsd: c1.sessionTotalUsd! })));
    const c2 = second.find((e) => e.type === 'usage' && e.sessionTotalUsd !== undefined) as Extract<EngineEvent, { type: 'usage' }>;
    // la CLI ha ritrovato il totale (0.0629525 -> 0.0769877): si conta solo la differenza, senza parte prudenziale
    expect(c2.sessionTotalUsd).toBeCloseTo(0.0769877, 5);
    expect(c2.costUsd).toBeCloseTo(0.0140352, 5);
    expect(c2.unreconciledUsd).toBeUndefined();
    expect(second.at(-1)).toMatchObject({ type: 'turn_end', status: 'success' });
  });

  it('formato reale: modelUsage cumulativo (con le chiamate di servizio a Haiku), usage del risultato solo del turno', () => {
    const resultOf = (f: string) => real(f).flatMap((e) => (e.t === 'msg' && e.msg.type === 'result' ? [e.msg as Record<string, any>] : []))[0]!;
    const plan = resultOf('ada-plan-g1.jsonl');
    const review = resultOf('ada-review-t1.jsonl');
    // le chiamate di servizio (Haiku) del piano ricompaiono identiche nella review: totale ripreso dalla trascrizione
    expect(review.modelUsage['claude-haiku-5-5']).toMatchObject({ inputTokens: 1237, outputTokens: 212, costUSD: plan.modelUsage['claude-haiku-5-5'].costUSD });
    // usage del risultato: solo questo turno (molto meno dei token cumulativi di modelUsage)
    const turnTokens = review.usage.input_tokens + review.usage.output_tokens + review.usage.cache_read_input_tokens + review.usage.cache_creation_input_tokens;
    const cumulative = Object.values(review.modelUsage as Record<string, any>).reduce((s, u) => s + u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, 0);
    expect(turnTokens / cumulative).toBeLessThan(0.5);
    // con l'abbonamento il costo è a listino (una stima), e nessuna chiave API
    expect(plan.modelUsage['claude-sonnet-5-5'].costBasis).toBe('list');
    const init = real('ada-plan-g1.jsonl').find((e) => e.t === 'msg' && e.msg.subtype === 'init') as { msg: Record<string, unknown> };
    expect(init.msg.apiKeySource).toBe('none');
  });
});
