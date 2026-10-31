import { describe, expect, it } from 'vitest';
import { TaskError, TaskGraph } from '../src/core/taskgraph.js';
import { testCtx } from './helpers.js';

function graph() {
  const ctx = testCtx();
  return { g: new TaskGraph(ctx), ctx };
}

describe('TaskGraph', () => {
  it('crea task con id progressivi e li annuncia all\'interfaccia', () => {
    const { g, ctx } = graph();
    const a = g.create({ title: ' Primo ', createdBy: 'ada' });
    const b = g.create({ title: 'Secondo', createdBy: 'ada', deps: [a.id] });
    expect(a.id).toBe('t1');
    expect(a.title).toBe('Primo');
    expect(b.deps).toEqual(['t1']);
    expect(ctx.events.filter((e) => e.type === 'task.upsert')).toHaveLength(2);
  });

  it('rifiuta titoli vuoti, dipendenze sconosciute, auto-dipendenze e cicli', () => {
    const { g } = graph();
    expect(() => g.create({ title: '  ', createdBy: 'ada' })).toThrow(TaskError);
    expect(() => g.create({ title: 'x', createdBy: 'ada', deps: ['t9'] })).toThrow(/sconosciuta/);
    const a = g.create({ title: 'a', createdBy: 'ada' });
    const b = g.create({ title: 'b', createdBy: 'ada', deps: [a.id] });
    const c = g.create({ title: 'c', createdBy: 'ada', deps: [b.id] });
    expect(() => g.update(a.id, { deps: [a.id] })).toThrow(/se stesso/);
    expect(() => g.update(a.id, { deps: [c.id] })).toThrow(/ciclo/);
    expect(g.wouldCycle(a.id, [c.id])).toBe(true);
    expect(g.wouldCycle(c.id, [a.id])).toBe(false);
  });

  it('un task parte solo con assegnatario e dipendenze completate', () => {
    const { g } = graph();
    const a = g.create({ title: 'a', createdBy: 'ada' });
    const b = g.create({ title: 'b', createdBy: 'ada', deps: [a.id] });
    expect(() => g.setStatus(a.id, 'doing')).toThrow(/assegnatario/);
    g.update(b.id, { assignee: 'bruno' });
    expect(() => g.setStatus(b.id, 'doing')).toThrow(/aspetta t1/);
    expect(g.ready().map((t) => t.id)).toEqual(['t1']);
    g.update(a.id, { assignee: 'chiara' });
    g.setStatus(a.id, 'doing');
    g.setStatus(a.id, 'review');
    g.setStatus(a.id, 'done');
    expect(g.ready().map((t) => t.id)).toEqual(['t2']);
    g.setStatus(b.id, 'doing');
    expect(g.require(b.id).status).toBe('doing');
  });

  it('applica le transizioni ammesse', () => {
    const { g } = graph();
    const a = g.create({ title: 'a', createdBy: 'ada', assignee: 'bruno' });
    expect(() => g.setStatus(a.id, 'review')).toThrow(/non può passare/);
    g.setStatus(a.id, 'cancelled');
    expect(() => g.setStatus(a.id, 'doing')).toThrow(/non può passare/);
    g.setStatus(a.id, 'todo'); // retry
    g.setStatus(a.id, 'blocked', { reason: 'serve una chiave' });
    expect(g.require(a.id).blockedReason).toBe('serve una chiave');
    g.setStatus(a.id, 'todo');
    expect(g.require(a.id).blockedReason).toBeUndefined();
  });

  it('un task con worktree diventa done solo con un merge approvato', () => {
    const { g } = graph();
    const a = g.create({ title: 'a', createdBy: 'ada', assignee: 'bruno' });
    g.update(a.id, { worktree: 'bruno-t1' });
    g.setStatus(a.id, 'doing');
    g.setStatus(a.id, 'review');
    expect(() => g.setStatus(a.id, 'done')).toThrow(/merge approvato/);
    g.setStatus(a.id, 'done', { merged: true });
    expect(g.require(a.id).status).toBe('done');
  });

  it('ordina i task pronti per priorità e poi per età', () => {
    const { g, ctx } = graph();
    const a = g.create({ title: 'a', createdBy: 'ada' });
    ctx.clock.t++;
    const b = g.create({ title: 'b', createdBy: 'ada', priority: 5 });
    ctx.clock.t++;
    const c = g.create({ title: 'c', createdBy: 'ada' });
    expect(g.ready().map((t) => t.id)).toEqual([b.id, a.id, c.id]);
  });

  it('calcola l\'avanzamento dell\'obiettivo escludendo i task annullati', () => {
    const { g } = graph();
    const a = g.create({ title: 'a', createdBy: 'ada', goalId: 'g1', assignee: 'bruno' });
    const b = g.create({ title: 'b', createdBy: 'ada', goalId: 'g1', assignee: 'bruno' });
    const c = g.create({ title: 'c', createdBy: 'ada', goalId: 'g1' });
    expect(g.progress('g1')).toBe(0);
    g.setStatus(a.id, 'doing');
    g.setStatus(a.id, 'review');
    g.setStatus(a.id, 'done');
    g.setStatus(b.id, 'doing');
    g.setStatus(c.id, 'cancelled');
    expect(g.progress('g1')).toBe(0.7); // (1 + 0.4) / 2
    expect(g.goalComplete('g1')).toBe(false);
    g.setStatus(b.id, 'review');
    g.setStatus(b.id, 'done');
    expect(g.goalComplete('g1')).toBe(true);
  });
});
