// Il repository di un obiettivo: con più repository registrati va indicato, e il lavoro (task,
// worktree, merge) avviene solo lì. Prima finiva in silenzio nel primo registrato.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDemoRepo } from '../src/demo.js';
import { noReply, testOrchestrator, tmpDir, waitFor } from './helpers.js';

async function twoRepos() {
  const { o, cfg } = testOrchestrator({ workers: 1 });
  const a = await o.repos.add(await createDemoRepo(path.join(cfg.home, 'primo')), { confirmGuard: true });
  const b = await o.repos.add(await createDemoRepo(path.join(tmpDir(), 'secondo')), { confirmGuard: true });
  await o.start();
  return { o, a, b };
}

describe('repository dell\'obiettivo', () => {
  it('con più repository, un obiettivo senza repository è rifiutato e non crea nulla', async () => {
    const { o, a, b } = await twoRepos();
    await expect(o.handle({ v: 1, type: 'goal.submit', text: 'Aggiungi un saluto' }, noReply)).rejects.toThrow(new RegExp(`indica il repository.*#${a.id}.*#${b.id}`));
    expect(o.snapshot().goals).toHaveLength(0);
    await o.stop();
  });

  it('con il repository indicato, task e worktree sono in quel repository', async () => {
    const { o, a, b } = await twoRepos();
    await o.handle({ v: 1, type: 'goal.submit', text: 'Aggiungi un saluto', repoId: b.id }, noReply);
    const t = await waitFor(() => (o.tasks.get('t1')?.worktree ? o.tasks.get('t1') : undefined), 'primo task con worktree');
    expect(o.goal('g1')?.repoId).toBe(b.id);
    expect(t.repoId).toBe(b.id);
    expect(o.repos.get(b.id)!.worktrees.map((w) => w.id)).toContain(t.worktree);
    expect(o.repos.get(a.id)!.worktrees).toHaveLength(0);
    await o.stop();
  });

  it('un repository che non esiste è rifiutato', async () => {
    const { o } = await twoRepos();
    await expect(o.handle({ v: 1, type: 'goal.submit', text: 'x', repoId: 'non-esiste' }, noReply)).rejects.toThrow(/nessun repository non-esiste/);
    await o.stop();
  });
});
