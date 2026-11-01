// Limite per obiettivo in turni e in minuti di lavoro (il freno della modalità login, dove la spesa
// è solo una stima): al raggiungimento l'obiettivo va in pausa con il lavoro salvato e arriva una
// decisione; alzando il limite si riprende. Le attese di una tua risposta non contano nel tempo.
import type { EngineId } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import { applyLoginLimits, defaultConfig, LOGIN_GOAL_LIMITS } from '../src/config.js';
import { DecisionQueue } from '../src/core/decisions.js';
import { SimEngine } from '../src/engines/sim/sim-engine.js';
import type { SimScript } from '../src/engines/sim/script.js';
import type { EngineAdapter } from '../src/engines/types.js';
import { demoRepo, noReply, testCtx, testOrchestrator, waitFor } from './helpers.js';

async function start(goalLimits: { turns?: number; minutes?: number }, script?: SimScript, stepDelayMs = 0) {
  const engines = new Map<EngineId, EngineAdapter>([['sim', new SimEngine({ stepDelayMs, ...(script ? { script } : {}) })]]);
  const { o, cfg } = testOrchestrator({ workers: 1, leadReview: false, engines, cfg: { goalLimits } });
  await o.repos.add(await demoRepo(cfg.home), { confirmGuard: true });
  await o.start();
  await o.handle({ v: 1, type: 'goal.submit', text: 'Aggiungi un saluto' }, noReply);
  return o;
}

describe('limite di turni per obiettivo', () => {
  it('raggiunto il limite non parte nessun turno: pausa, decisione; alzandolo si riprende', async () => {
    const o = await start({ turns: 1 });
    // il piano è il turno 1; il turno del worker non parte
    const d = await waitFor(() => o.decisions.open().find((x) => x.kind === 'budget'), 'decisione di limite');
    expect(d.question).toMatch(/Limite di turni raggiunto: 1 su 1/);
    expect(d.context).toMatch(/il nuovo limite di turni/);
    expect(o.goal('g1')).toMatchObject({ status: 'paused', turnLimit: 1, turnsUsed: 1 });
    await o.team.idle();
    expect(o.store.data.feed.some((f) => f.text.includes('Limite di turni raggiunto'))).toBe(true);
    expect(o.decisions.list().some((x) => x.kind === 'merge')).toBe(false);

    await o.handle({ v: 1, type: 'decision.answer', decisionId: d.id, option: 'Aumenta il tetto', text: '5' }, noReply);
    expect(o.goal('g1')).toMatchObject({ status: 'active', turnLimit: 5 });
    await waitFor(() => o.decisions.open().find((x) => x.kind === 'merge'), 'merge dopo aver alzato il limite');
    expect(o.goal('g1')!.turnsUsed).toBe(2);
  });

  it('senza numero il limite raddoppia', async () => {
    const o = await start({ turns: 1 });
    const d = await waitFor(() => o.decisions.open().find((x) => x.kind === 'budget'), 'decisione');
    await o.handle({ v: 1, type: 'decision.answer', decisionId: d.id, option: 'Aumenta il tetto' }, noReply);
    expect(o.goal('g1')?.turnLimit).toBe(2);
  });
});

describe('limite di tempo per obiettivo', () => {
  /** il worker lavora a lungo (molti passi): il limite scatta a metà turno */
  const slow: SimScript = async (ctx) => {
    if (ctx.spec.role === 'lead') {
      if (ctx.spec.job.kind === 'plan') await ctx.team('create_task', { title: 'Lungo', description: 'molti passi' });
      return 'ok';
    }
    for (let i = 0; i < 200; i++) await ctx.say(`passo ${i}`);
    return 'fatto';
  };

  it('a metà turno: il turno si ferma con la sessione salvata, l\'obiettivo va in pausa', async () => {
    const o = await start({ minutes: 0.04 }, slow, 50); // 2,4 secondi di lavoro
    const d = await waitFor(() => o.decisions.open().find((x) => x.kind === 'budget'), 'decisione di tempo', 30_000);
    expect(d.question).toMatch(/Limite di tempo raggiunto: \d+ su 0.04 minuti/);
    await o.team.idle();
    expect(o.goal('g1')?.status).toBe('paused');
    expect(o.goal('g1')!.activeMs!).toBeGreaterThanOrEqual(0.04 * 60_000);
    // il turno interrotto resta da riprendere, come con il tetto di spesa
    expect(o.store.data.team.inflight.bruno).toMatchObject({ kind: 'work' });
    expect(o.tasks.get('t1')?.status).toBe('doing');
  }, 60_000);

  it('le attese di una tua risposta non contano', async () => {
    const ctx = testCtx();
    const q = new DecisionQueue(ctx);
    const d = q.create({ agentId: 'bruno', kind: 'question', question: 'Quale formato?', options: [] });
    const waiting = q.wait(d.id);
    ctx.clock.t += 90_000;
    expect(q.waitedMs('bruno')).toBe(90_000); // attesa in corso
    q.answer(d.id, undefined, 'JSON');
    q.settle(d.id);
    await waiting;
    ctx.clock.t += 10_000;
    expect(q.waitedMs('bruno')).toBe(90_000); // finita: non cresce più
    expect(q.waitedMs('ada')).toBe(0);
  });
});

describe('limiti predefiniti con il login personale', () => {
  it('30 turni e 60 minuti, salvo valori espliciti (0 = nessun limite)', () => {
    const a = defaultConfig({});
    expect(applyLoginLimits(a, {})).toMatch(/30 turni, 60 minuti/);
    expect(a.goalLimits).toEqual({ turns: LOGIN_GOAL_LIMITS.turns, minutes: LOGIN_GOAL_LIMITS.minutes });
    const b = defaultConfig({});
    applyLoginLimits(b, { turns: 0, minutes: 15 });
    expect(b.goalLimits).toEqual({ minutes: 15 });
  });

  it('il nuovo obiettivo riceve i limiti predefiniti', async () => {
    const { o, cfg } = testOrchestrator({ workers: 1, cfg: { goalLimits: { turns: 30, minutes: 60 } } });
    await o.repos.add(await demoRepo(cfg.home), { confirmGuard: true });
    await o.start();
    await o.handle({ v: 1, type: 'goal.submit', text: 'Qualcosa' }, noReply);
    expect(o.goal('g1')).toMatchObject({ turnLimit: 30, minuteLimit: 60 });
    expect(o.goal('g1')!.turnsUsed).toBeGreaterThanOrEqual(0); // il piano può essere già partito
  });
});
