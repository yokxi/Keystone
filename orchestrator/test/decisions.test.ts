import { MERGE_OPTIONS, PERMISSION_OPTIONS } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import { DecisionError, DecisionQueue } from '../src/core/decisions.js';
import { testCtx } from './helpers.js';

describe('DecisionQueue', () => {
  it('apre una decisione, la persiste e la annuncia', () => {
    const ctx = testCtx();
    const q = new DecisionQueue(ctx);
    const d = q.create({ agentId: 'ada', kind: 'question', question: 'Formato?', options: ['JSON', 'CSV'] });
    expect(d).toMatchObject({ id: 'd1', status: 'open', options: ['JSON', 'CSV'] });
    expect(ctx.store.data.decisions).toHaveLength(1);
    expect(ctx.events.at(-1)?.type).toBe('decision.upsert');
  });

  it('permessi e merge richiedono opzioni; le domande no', () => {
    const q = new DecisionQueue(testCtx());
    expect(() => q.create({ agentId: 'a', kind: 'merge', question: 'Unire?', options: [] })).toThrow(DecisionError);
    expect(() => q.create({ agentId: 'a', kind: 'question', question: ' ', options: [] })).toThrow(DecisionError);
    expect(q.create({ agentId: 'a', kind: 'question', question: 'Perché?', options: [] }).options).toEqual([]);
  });

  it('accetta l\'opzione per etichetta o per numero e sveglia chi aspetta dopo settle()', async () => {
    const q = new DecisionQueue(testCtx());
    const d = q.create({ agentId: 'bruno', kind: 'permission', question: 'curl?', options: PERMISSION_OPTIONS });
    let woke = false;
    const waiting = q.wait(d.id).then((x) => {
      woke = true;
      return x;
    });
    q.answer(d.id, '3');
    await Promise.resolve();
    expect(woke).toBe(false); // effetti non ancora completati
    q.settle(d.id);
    const done = await waiting;
    expect(done.answer?.option).toBe('Nega');
    const m = q.create({ agentId: 'ada', kind: 'merge', question: 'Unire t1?', options: MERGE_OPTIONS });
    expect(q.answer(m.id, 'merge').answer?.option).toBe('Merge');
  });

  it('rifiuta opzioni non valide, risposte vuote e doppie risposte', () => {
    const q = new DecisionQueue(testCtx());
    const m = q.create({ agentId: 'ada', kind: 'merge', question: 'Unire?', options: MERGE_OPTIONS });
    expect(() => q.answer(m.id, '9')).toThrow(/non valida/);
    expect(() => q.answer(m.id)).toThrow(/scegli/);
    const d = q.create({ agentId: 'ada', kind: 'question', question: 'Nome?', options: [] });
    expect(() => q.answer(d.id, undefined, '  ')).toThrow(/vuota/);
    q.answer(d.id, undefined, 'Keystone');
    expect(() => q.answer(d.id, undefined, 'altro')).toThrow(/già risolta/);
  });

  it('annullare una decisione sveglia chi aspetta con lo stato cancelled', async () => {
    const q = new DecisionQueue(testCtx());
    const d = q.create({ agentId: 'bruno', kind: 'question', question: 'A o B?', options: ['A', 'B'] });
    const w = q.wait(d.id);
    q.cancel(d.id, 'turno interrotto');
    const res = await w;
    expect(res.status).toBe('cancelled');
    expect(res.cancelReason).toBe('turno interrotto');
  });

  it('reopen() riapre una decisione risolta (es. merge rifiutato) aggiornando il contesto', () => {
    const q = new DecisionQueue(testCtx());
    const m = q.create({ agentId: 'ada', kind: 'merge', question: 'Unire?', options: MERGE_OPTIONS });
    q.answer(m.id, 'Merge');
    q.reopen(m.id, 'il checkout ha modifiche non committate');
    expect(q.get(m.id)).toMatchObject({ status: 'open', context: 'il checkout ha modifiche non committate' });
    expect(q.get(m.id)?.answer).toBeUndefined();
  });
});
