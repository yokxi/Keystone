// Branch degli agenti: eliminati dopo un merge riuscito (salvo --keep-branches), eliminati dalla
// pulizia solo dopo conferma se il task è stato rifiutato o abbandonato, tutti eliminati da --reset
// nel solo repository di prova. Mai toccato un branch che non inizi con "Keystone/".
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteAllKeystoneBranches, deleteKeystoneBranch, isKeystoneBranch, listKeystoneBranches } from '../src/core/branches.js';
import type { Orchestrator } from '../src/core/orchestrator.js';
import { git, gitOut } from '../src/util/git.js';
import { demoRepo, noReply, testOrchestrator, tmpDir, waitFor } from './helpers.js';

/**
 * Branch dell'utente che nessuna operazione di Keystone deve toccare. ("keystone/..." minuscolo è
 * rifiutato per nome nel primo test; qui non si crea perché su Windows i riferimenti non
 * distinguono maiuscole e minuscole e condividerebbe la cartella di Keystone/.)
 */
const USER_BRANCHES = ['feature/x', 'KeystoneX/y', 'feature/Keystone/z', 'Keystone-mio'];

async function branches(repo: string): Promise<string[]> {
  return (await gitOut(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).split('\n').filter(Boolean).sort();
}

async function repoWithBranches(): Promise<{ repo: string; sha: string }> {
  const repo = await demoRepo();
  const sha = await gitOut(repo, ['rev-parse', 'HEAD']);
  for (const b of [...USER_BRANCHES, 'Keystone/bruno/t1-a', 'Keystone/chiara/t2-b']) await git(repo, ['branch', b, sha]);
  return { repo, sha };
}

describe('solo i branch Keystone/*', () => {
  it('riconosce i nomi', () => {
    for (const ok of ['Keystone/bruno/t1-saluto', 'Keystone/x']) expect(isKeystoneBranch(ok), ok).toBe(true);
    for (const no of ['main', 'Keystone', 'Keystone/', 'keystone/bruno/t1', 'KeystoneX/y', 'feature/Keystone/z', 'Keystone-mio', 'Keystone/../main', 'Keystone/a b', 'Keystone/x.lock']) expect(isKeystoneBranch(no), no).toBe(false);
  });

  it('deleteKeystoneBranch rifiuta i branch dell\'utente, quelli estratti e quelli spostati', async () => {
    const { repo, sha } = await repoWithBranches();
    for (const b of ['main', ...USER_BRANCHES]) expect(await deleteKeystoneBranch(repo, b, sha), b).toMatchObject({ ok: false });
    // spostato rispetto al commit atteso: conservato
    const other = await gitOut(repo, ['commit-tree', 'HEAD^{tree}', '-m', 'altro']);
    expect(await deleteKeystoneBranch(repo, 'Keystone/bruno/t1-a', other)).toMatchObject({ ok: false });
    // tutto zeri per git vorrebbe dire "nessun controllo": rifiutato
    expect(await deleteKeystoneBranch(repo, 'Keystone/bruno/t1-a', '0'.repeat(40))).toMatchObject({ ok: false });
    // estratto in un worktree: conservato
    const wt = path.join(tmpDir(), 'wt');
    await git(repo, ['worktree', 'add', wt, 'Keystone/chiara/t2-b']);
    expect(await deleteKeystoneBranch(repo, 'Keystone/chiara/t2-b', sha)).toMatchObject({ ok: false, reason: expect.stringMatching(/estratto/) });
    // il caso buono
    expect(await deleteKeystoneBranch(repo, 'Keystone/bruno/t1-a', sha)).toEqual({ ok: true });
    expect(await branches(repo)).toEqual(['Keystone/chiara/t2-b', ...USER_BRANCHES, 'main'].sort());
  });

  it('--reset del repository di prova: elimina tutti i Keystone/* e nient\'altro', async () => {
    const { repo } = await repoWithBranches();
    // un worktree rimasto da un profilo cancellato: la cartella non c'è più, git lo dimentica
    const wt = path.join(tmpDir(), 'wt-vecchio');
    await git(repo, ['worktree', 'add', wt, 'Keystone/chiara/t2-b']);
    fs.rmSync(wt, { recursive: true, force: true });
    const report = await deleteAllKeystoneBranches(repo);
    expect(report).toEqual(['branch Keystone/bruno/t1-a eliminato', 'branch Keystone/chiara/t2-b eliminato']);
    expect(await branches(repo)).toEqual([...USER_BRANCHES, 'main'].sort());
    expect(await listKeystoneBranches(repo)).toEqual([]);
  });
});

async function flow(cfg: { keepMergedBranches?: boolean } = {}) {
  const { o, cfg: c } = testOrchestrator({ workers: 2, leadReview: false, cfg });
  const repo = await demoRepo(c.home);
  await o.repos.add(repo, { confirmGuard: true });
  const sha = await gitOut(repo, ['rev-parse', 'HEAD']);
  for (const b of USER_BRANCHES) await git(repo, ['branch', b, sha]);
  // un Keystone/* che questo profilo non conosce (di un altro profilo o creato a mano)
  await git(repo, ['branch', 'Keystone/altro/t9-sconosciuto', sha]);
  await o.start();
  // due task indipendenti
  await o.handle({ v: 1, type: 'goal.submit', text: 'Primo pezzo; Secondo pezzo' }, noReply);
  return { o, repo };
}

const answer = (o: Orchestrator, id: string, option: string) => o.handle({ v: 1, type: 'decision.answer', decisionId: id, option }, noReply);
const mergeDecision = (o: Orchestrator, taskId: string) => waitFor(() => o.decisions.open().find((d) => d.kind === 'merge' && d.taskId === taskId), `merge di ${taskId}`);

describe('branch dopo merge, rifiuto e pulizia', () => {
  it('dopo un merge riuscito il branch dell\'agente viene eliminato; gli altri restano', async () => {
    const { o, repo } = await flow();
    const d = await mergeDecision(o, 't1');
    const branch = o.tasks.get('t1')!.branch!;
    expect(await branches(repo)).toContain(branch);
    await answer(o, d.id, 'Merge');
    await waitFor(() => o.tasks.get('t1')?.status === 'done', 't1 unito');
    expect(await branches(repo)).not.toContain(branch);
    for (const b of [...USER_BRANCHES, 'main', 'Keystone/altro/t9-sconosciuto']) expect(await branches(repo)).toContain(b);
    expect(o.store.data.feed.some((f) => f.text.includes(`Unito ${branch}`) && f.text.includes('branch eliminato'))).toBe(true);
    // il diff unito resta consultabile anche senza branch
    const wt = o.repos.list()[0]!.worktrees.find((w) => w.branch === branch)!;
    expect((await o.repos.diff(o.repos.list()[0]!.id, wt.id)).length).toBeGreaterThan(0);
  });

  it('con --keep-branches il branch resta dopo il merge', async () => {
    const { o, repo } = await flow({ keepMergedBranches: true });
    const d = await mergeDecision(o, 't1');
    const branch = o.tasks.get('t1')!.branch!;
    await answer(o, d.id, 'Merge');
    await waitFor(() => o.tasks.get('t1')?.status === 'done', 't1 unito');
    expect(await branches(repo)).toContain(branch);
    // un branch conservato per scelta non è "da pulire"
    expect((await o.repos.staleBranches((id) => o.tasks.get(id)?.status)).map((b) => b.name)).not.toContain(branch);
  });

  it('pulizia: elenca solo i branch dei task rifiutati o abbandonati, li elimina dopo conferma, mai gli altri', async () => {
    const { o, repo } = await flow();
    const d1 = await mergeDecision(o, 't1');
    const d2 = await mergeDecision(o, 't2');
    const rejected = o.tasks.get('t1')!.branch!;
    const open = o.tasks.get('t2')!.branch!;
    await answer(o, d1.id, 'Rifiuta');
    await waitFor(() => o.tasks.get('t1')?.status === 'cancelled', 't1 rifiutato');
    // il rifiuto conserva il branch (recuperabile)
    expect(await branches(repo)).toContain(rejected);

    const stale = await o.repos.staleBranches((id) => o.tasks.get(id)?.status);
    expect(stale.map((b) => b.name)).toEqual([rejected]);
    expect(stale[0]).toMatchObject({ taskId: 't1', why: 'task rifiutato o annullato' });
    // t2 aspetta ancora la decisione: il suo branch non compare; nemmeno lo sconosciuto o quelli dell'utente

    expect(await o.repos.deleteStaleBranches(stale)).toEqual([`branch ${rejected} eliminato (task rifiutato o annullato)`]);
    const after = await branches(repo);
    expect(after).not.toContain(rejected);
    for (const b of [open, 'Keystone/altro/t9-sconosciuto', ...USER_BRANCHES, 'main']) expect(after).toContain(b);
    expect(d2.status).toBe('open');
  });

  it('pulizia: se il branch è cambiato dopo la conferma, resta dov\'è', async () => {
    const { o, repo } = await flow();
    const d1 = await mergeDecision(o, 't1');
    const rejected = o.tasks.get('t1')!.branch!;
    await answer(o, d1.id, 'Rifiuta');
    await waitFor(() => o.tasks.get('t1')?.status === 'cancelled', 't1 rifiutato');
    const stale = await o.repos.staleBranches((id) => o.tasks.get(id)?.status);
    // qualcuno sposta il branch dopo che l'elenco è stato mostrato
    await git(repo, ['branch', '-f', rejected, 'main']);
    const report = await o.repos.deleteStaleBranches(stale);
    expect(report[0]).toMatch(/conservato/);
    expect(await branches(repo)).toContain(rejected);
  });
});
