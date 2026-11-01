// Tetto di spesa con turni in parallelo: lead e worker dello stesso obiettivo non possono spendere
// insieme più del residuo. Ogni turno parte con una quota riservata; un turno parte solo se il
// residuo, tolte le quote dei turni in corso, basta. Altrimenti aspetta.
import type { EngineEvent, EngineId, TurnEndStatus } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import { EventChannel } from '../src/engines/channel.js';
import type { AuthCheck, EngineAdapter, EngineTurn, TurnSpec } from '../src/engines/types.js';
import type { Orchestrator } from '../src/core/orchestrator.js';
import { demoRepo, noReply, testOrchestrator, waitFor } from './helpers.js';

interface FakeTurn {
  spec: TurnSpec;
  resumed: boolean;
  /** quota ancora riservata (budgetUsd meno la spesa già riportata) */
  open: number;
  emit(e: EngineEvent): void;
  /** chiama un tool del team */
  tool(name: string, args: Record<string, unknown>): Promise<string>;
  /** spende e chiude il turno */
  end(status: TurnEndStatus, cost?: { costUsd: number; sessionTotalUsd?: number; unreconciledUsd?: number }): void;
  ended: boolean;
}

/** Motore finto: i turni restano aperti finché il test non li chiude. */
class FakeEngine implements EngineAdapter {
  readonly id = 'sim' as const;
  readonly label = 'Finto';
  turns: FakeTurn[] = [];
  /** violazioni dell'invariante: somma delle quote aperte > residuo dell'obiettivo */
  violations: string[] = [];
  o?: Orchestrator;
  onStart?: (t: FakeTurn) => void;

  defaultModel(): string {
    return 'finto';
  }
  displayModel(m: string): string {
    return m;
  }
  async checkAuth(): Promise<AuthCheck> {
    return { ok: true, account: 'finto' };
  }
  startSession(spec: TurnSpec): EngineTurn {
    return this.run(spec, false);
  }
  resumeSession(_id: string, spec: TurnSpec): EngineTurn {
    return this.run(spec, true);
  }
  running(): FakeTurn[] {
    return this.turns.filter((t) => !t.ended);
  }

  private run(spec: TurnSpec, resumed: boolean): EngineTurn {
    const ch = new EventChannel<EngineEvent>();
    const turn: FakeTurn = {
      spec,
      resumed,
      open: spec.budgetUsd ?? Infinity,
      ended: false,
      emit: (e) => ch.push(e),
      tool: async (name, args) => {
        const t = spec.tools.find((x) => x.name === name);
        if (!t) throw new Error(`tool ${name} non disponibile`);
        return (await t.run(args)).text;
      },
      end: (status, cost) => {
        if (turn.ended) return;
        if (cost) {
          ch.push({ type: 'usage', inputTokens: 0, outputTokens: 0, ...cost });
          turn.open = Math.max(0, turn.open - cost.costUsd);
        }
        turn.ended = true;
        ch.push({ type: 'turn_end', status });
        ch.close();
      },
    };
    this.turns.push(turn);
    // invariante: le quote aperte dei turni in corso non superano il residuo dell'obiettivo
    const goalId = spec.job.goalId ?? (spec.job.taskId ? this.o?.tasks.get(spec.job.taskId)?.goalId : undefined);
    const remaining = this.o?.remainingBudget(goalId);
    const open = this.running().reduce((s, t) => s + t.open, 0);
    if (remaining !== undefined && open > remaining + 1e-9) this.violations.push(`${spec.agentId} ${spec.job.kind}: quote aperte ${open} > residuo ${remaining}`);
    ch.push({ type: 'session', sessionId: `sess-${spec.agentId}-${spec.job.taskId ?? spec.job.goalId}` });
    queueMicrotask(() => this.onStart?.(turn));
    return {
      events: ch,
      respond: () => undefined,
      abort: () => {
        if (turn.ended) return;
        turn.ended = true;
        ch.push({ type: 'turn_end', status: 'aborted' });
        ch.close();
      },
    };
  }
}

async function setup(budgetUsd: number) {
  const engine = new FakeEngine();
  const engines = new Map<EngineId, EngineAdapter>([['sim', engine]]);
  const { o, cfg } = testOrchestrator({ workers: 1, engines, leadReview: false });
  engine.o = o;
  await o.repos.add(await demoRepo(cfg.home), { confirmGuard: true });
  // il lead pianifica un task e chiude il turno senza spendere
  engine.onStart = (t) => {
    if (t.spec.role === 'lead' && t.spec.job.kind === 'plan') void t.tool('create_task', { title: 'Saluto', description: 'aggiungi saluta_en' }).then(() => t.end('success', { costUsd: 0.01, sessionTotalUsd: 0.01 }));
  };
  await o.start();
  await o.handle({ v: 1, type: 'goal.submit', text: 'Aggiungi saluta_en', budgetUsd }, noReply);
  const work = await waitFor(() => engine.running().find((t) => t.spec.role === 'worker'), 'turno del worker');
  return { o, engine, work };
}

describe('tetto di spesa con lead e worker contemporanei', () => {
  it('con residuo sufficiente lead e worker lavorano insieme, e le loro quote sommate non superano il residuo', async () => {
    const { o, engine, work } = await setup(2);
    // tetto $2, posti 2 (lead + 1 worker): fetta $1. Residuo $1.99 dopo il piano.
    expect(work.spec.budgetUsd).toBe(1);
    await o.handle({ v: 1, type: 'user.message', to: 'ada', text: 'come va?' }, noReply);
    const lead = await waitFor(() => engine.running().find((t) => t.spec.role === 'lead'), 'turno del lead in parallelo');
    expect(engine.running()).toHaveLength(2);
    expect(lead.spec.budgetUsd!).toBeCloseTo(0.99, 6); // il residuo meno la quota del worker
    expect(work.spec.budgetUsd! + lead.spec.budgetUsd!).toBeLessThanOrEqual(o.remainingBudget('g1')! + 1e-9);
    expect(engine.violations).toEqual([]);
    lead.end('success', { costUsd: 0.2, sessionTotalUsd: 0.2 });
    await work.tool('update_task', { task_id: 't1', status: 'review', summary: 'fatto' });
    work.end('success', { costUsd: 0.3, sessionTotalUsd: 0.3 });
    await o.team.idle();
    expect(o.goal('g1')?.costUsd).toBeCloseTo(0.51, 6);
  });

  it('se il residuo meno la quota del worker non basta, il turno del lead aspetta e parte quando la quota si libera', async () => {
    const { o, engine, work } = await setup(0.4);
    // tetto $0.40: fetta = minimo $0.25. Il worker riserva $0.25, ne restano $0.14 (< $0.25)
    expect(work.spec.budgetUsd).toBe(0.25);
    await o.handle({ v: 1, type: 'user.message', to: 'ada', text: 'come va?' }, noReply);
    await waitFor(() => o.agent('ada')?.activity.includes('riservata ad altri turni'), 'lead in attesa di spesa');
    await new Promise((r) => setTimeout(r, 100));
    expect(engine.running().filter((t) => t.spec.role === 'lead')).toHaveLength(0);

    await work.tool('update_task', { task_id: 't1', status: 'review', summary: 'fatto' });
    work.end('success', { costUsd: 0.05, sessionTotalUsd: 0.05 });
    const lead = await waitFor(() => engine.running().find((t) => t.spec.role === 'lead'), 'turno del lead dopo il worker');
    // residuo 0.40 - 0.01 - 0.05 = 0.34, fetta 0.25
    expect(lead.spec.budgetUsd).toBe(0.25);
    lead.end('success', { costUsd: 0.02 });
    await o.team.idle();
    expect(engine.violations).toEqual([]);
  });

  it('un turno che esaurisce la sua quota (non il tetto) riprende la stessa sessione, con la base del totale riportato dal motore', async () => {
    const { o, engine, work } = await setup(1);
    expect(work.resumed).toBe(false);
    work.end('budget', { costUsd: 0.4, sessionTotalUsd: 0.4 });
    const again = await waitFor(() => engine.running().find((t) => t.spec.role === 'worker' && t !== work), 'ripresa del worker');
    expect(again.resumed).toBe(true);
    expect(again.spec.prompt).toMatch(/quota di spesa riservata al turno/);
    expect(again.spec.sessionCostUsd).toBe(0.4); // il totale del motore, base dell'incremento
    // residuo 1 - 0.01 - 0.4 = 0.59, fetta 0.5
    expect(again.spec.budgetUsd).toBe(0.5);
    expect(o.tasks.get('t1')?.status).toBe('doing'); // non è un fallimento
    // il motore non sa dire se la sessione ripresa ha ritrovato la spesa: la conta, e la segna
    await again.tool('update_task', { task_id: 't1', status: 'review', summary: 'fatto' });
    again.end('success', { costUsd: 0.5, sessionTotalUsd: 0.5, unreconciledUsd: 0.4 });
    await o.team.idle();
    expect(o.goal('g1')?.costUsd).toBeCloseTo(0.91, 6);
    expect(o.goal('g1')?.costUnreconciledUsd).toBeCloseTo(0.4, 6);
    expect(o.store.data.sessions['bruno:t1']?.engineTotalUsd).toBe(0.5);
    expect(engine.violations).toEqual([]);
  });
});
