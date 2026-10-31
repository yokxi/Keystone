// Tetto di spesa per obiettivo: al raggiungimento gli agenti si fermano, il lavoro resta salvato e
// arriva una decisione; alzando il tetto i turni riprendono con la stessa sessione.
import type { EngineId } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import { SimEngine } from '../src/engines/sim/sim-engine.js';
import type { SimScript } from '../src/engines/sim/script.js';
import type { EngineAdapter } from '../src/engines/types.js';
import { gitOut } from '../src/util/git.js';
import { demoRepo, noReply, testOrchestrator, tmpDir, waitFor } from './helpers.js';

/**
 * Il lead crea un task; il worker spende $0.03 alla volta: prima scrive e committa un file (lavoro
 * salvato sul branch), poi spende ancora e chiude il task. Con un tetto di $0.05 si ferma a metà.
 */
const costlyScript: SimScript = async (ctx) => {
  const { role, job } = ctx.spec;
  if (role === 'lead' && job.kind === 'plan') {
    await ctx.team('create_task', { title: 'Lavoro costoso', description: 'spende' });
    ctx.usage(10, 10, 0.01);
    return 'piano';
  }
  if (role === 'lead') {
    if (job.kind === 'review') await ctx.team('request_merge', { task_id: job.taskId, summary: 'ok' });
    return 'ok';
  }
  const already = ctx.readFile('lavoro.txt');
  if (!already) {
    await ctx.writeFile('lavoro.txt', 'prima parte\n');
    await ctx.git(['add', '-A']);
    await ctx.git(['commit', '-q', '-m', 'prima parte']);
  }
  ctx.usage(100, 100, 0.03);
  await ctx.say('continuo');
  ctx.usage(100, 100, 0.03);
  await ctx.say('ancora');
  await ctx.writeFile('lavoro.txt', 'prima parte\nseconda parte\n');
  await ctx.team('update_task', { task_id: job.taskId, status: 'review', summary: ctx.resumed ? 'finito dopo la ripresa' : 'finito' });
  return 'fatto';
};

async function setup(home = tmpDir(), budgetUsd = 0.05) {
  const engines = new Map<EngineId, EngineAdapter>([['sim', new SimEngine({ stepDelayMs: 20, script: costlyScript })]]);
  const { o, cfg } = testOrchestrator({ home, workers: 1, engines });
  if (!o.repos.list().length) await o.repos.add(await demoRepo(cfg.home), { confirmGuard: true });
  await o.start();
  return { o, submit: () => o.handle({ v: 1, type: 'goal.submit', text: 'Obiettivo costoso', budgetUsd }, noReply) };
}

describe('tetto di spesa per obiettivo', () => {
  it('al raggiungimento: obiettivo in pausa, agente fermo, lavoro salvato sul branch, decisione per l\'utente', async () => {
    const { o, submit } = await setup();
    await submit();
    const d = await waitFor(() => o.decisions.open().find((x) => x.kind === 'budget'), 'decisione di tetto raggiunto');
    await o.team.idle();
    const g = o.goal('g1')!;
    expect(g.status).toBe('paused');
    expect(g.pausedFrom).toBe('active');
    expect(g.costUsd).toBeGreaterThanOrEqual(0.05);
    expect(d.options).toEqual(['Aumenta il tetto', 'Lascia in pausa']);
    expect(d.question).toMatch(/Tetto di spesa raggiunto: \$0\.0\d su \$0\.05/);
    // il task non è finito né bloccato: è fermo, con il turno salvato per la ripresa
    const t = o.tasks.get('t1')!;
    expect(t.status).toBe('doing');
    expect(o.store.data.team.inflight.bruno).toMatchObject({ kind: 'work', taskId: 't1' });
    expect(o.agent('bruno')?.activity).toMatch(/tetto di spesa/);
    // il lavoro fatto fin qui è sul branch dell'agente
    const repo = o.repos.list()[0]!.path;
    expect(await gitOut(repo, ['show', `${t.branch}:lavoro.txt`])).toBe('prima parte');
  });

  it('"Aumenta il tetto" con un importo: l\'obiettivo riprende e il worker continua la stessa sessione', async () => {
    const { o, submit } = await setup();
    await submit();
    const d = await waitFor(() => o.decisions.open().find((x) => x.kind === 'budget'), 'decisione');
    await o.team.idle();
    const session = o.store.data.sessions['bruno:t1']?.sessionId;
    await o.handle({ v: 1, type: 'decision.answer', decisionId: d.id, option: 'Aumenta il tetto', text: '1' }, noReply);
    expect(o.goal('g1')).toMatchObject({ status: 'active', budgetUsd: 1 });
    await waitFor(() => o.decisions.open().find((x) => x.kind === 'merge'), 'decisione di merge dopo la ripresa');
    expect(o.tasks.get('t1')?.summary).toMatch(/finito dopo la ripresa/);
    expect(o.store.data.sessions['bruno:t1']?.sessionId).toBe(session);
  });

  it('"Aumenta il tetto" senza importo raddoppia il tetto', async () => {
    const { o, submit } = await setup();
    await submit();
    const d = await waitFor(() => o.decisions.open().find((x) => x.kind === 'budget'), 'decisione');
    await o.handle({ v: 1, type: 'decision.answer', decisionId: d.id, option: 'Aumenta il tetto' }, noReply);
    expect(o.goal('g1')?.budgetUsd).toBe(0.1);
  });

  it('"Lascia in pausa": nessun agente lavora finché il tetto non viene alzato (anche dal tabellone)', async () => {
    const { o, submit } = await setup();
    await submit();
    const d = await waitFor(() => o.decisions.open().find((x) => x.kind === 'budget'), 'decisione');
    await o.handle({ v: 1, type: 'decision.answer', decisionId: d.id, option: 'Lascia in pausa' }, noReply);
    await o.team.idle();
    await new Promise((r) => setTimeout(r, 300));
    expect(o.goal('g1')?.status).toBe('paused');
    expect(o.tasks.get('t1')?.status).toBe('doing');
    // un messaggio all'agente non lo fa ripartire
    await o.handle({ v: 1, type: 'user.message', to: 'bruno', text: 'vai avanti' }, noReply);
    await new Promise((r) => setTimeout(r, 300));
    expect(o.tasks.get('t1')?.status).toBe('doing');
    // alzare il tetto dal tabellone (goal.budget) fa ripartire il lavoro
    const r = await o.handle({ v: 1, type: 'goal.budget', goalId: 'g1', budgetUsd: 2 }, noReply);
    expect(r).toMatchObject({ status: 'active', budgetUsd: 2 });
    await waitFor(() => o.decisions.open().find((x) => x.kind === 'merge'), 'merge dopo aver alzato il tetto');
  });

  it('la pausa sopravvive a un riavvio: nessuna ripresa automatica, poi si riprende alzando il tetto', async () => {
    const home = tmpDir();
    const a = await setup(home);
    await a.submit();
    await waitFor(() => a.o.decisions.open().find((x) => x.kind === 'budget'), 'decisione');
    await a.o.team.idle();
    await a.o.stop();

    const b = await setup(home);
    await new Promise((r) => setTimeout(r, 300));
    expect(b.o.goal('g1')?.status).toBe('paused');
    expect(b.o.tasks.get('t1')?.status).toBe('doing');
    expect(b.o.store.data.team.inflight.bruno).toBeTruthy();
    const d = b.o.decisions.open().find((x) => x.kind === 'budget')!;
    await b.o.handle({ v: 1, type: 'decision.answer', decisionId: d.id, option: 'Aumenta il tetto', text: '$ 3,50' }, noReply);
    expect(b.o.goal('g1')?.budgetUsd).toBe(3.5);
    await waitFor(() => b.o.decisions.open().find((x) => x.kind === 'merge'), 'merge dopo il riavvio');
  });

  it('senza tetto (0) non ci sono pause', async () => {
    const engines = new Map<EngineId, EngineAdapter>([['sim', new SimEngine({ stepDelayMs: 0, script: costlyScript })]]);
    const { o, cfg } = testOrchestrator({ workers: 1, engines, cfg: { budgetUsdPerGoal: 0 } });
    await o.repos.add(await demoRepo(cfg.home), { confirmGuard: true });
    await o.start();
    await o.handle({ v: 1, type: 'goal.submit', text: 'Senza tetto' }, noReply);
    await waitFor(() => o.decisions.open().find((x) => x.kind === 'merge'), 'merge');
    expect(o.goal('g1')?.budgetUsd).toBeUndefined();
    expect(o.decisions.list().some((x) => x.kind === 'budget')).toBe(false);
  });
});
