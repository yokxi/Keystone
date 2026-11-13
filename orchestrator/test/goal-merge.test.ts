// Fase 11: un solo merge per obiettivo. I task, rivisti dal lead, si uniscono da soli nel branch
// dell'obiettivo (mai nel checkout dell'utente); quando sono tutti fatti Keystone esegue i test sul
// lavoro completo e manda all'utente una sola decisione. Il merge nel branch dell'utente parte solo
// da quella decisione ed è atomico come quello per task.
import fs from 'node:fs';
import path from 'node:path';
import type { Decision } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import type { Orchestrator } from '../src/core/orchestrator.js';
import { RepoError } from '../src/core/repos.js';
import { git, gitOut } from '../src/util/git.js';
import { demoRepo, noReply, testOrchestrator, waitFor } from './helpers.js';

async function setup(opts: Parameters<typeof testOrchestrator>[0] = {}, prepare?: (repo: string) => Promise<void>) {
  const { o, cfg } = testOrchestrator({ mergePerGoal: true, ...opts });
  const repo = await demoRepo(cfg.home);
  if (prepare) await prepare(repo);
  await o.repos.add(repo, { confirmGuard: true });
  await o.start();
  return { o, repo, cfg };
}

const submit = (o: Orchestrator, text: string) => o.handle({ v: 1, type: 'goal.submit', text }, noReply);
const openDecision = (o: Orchestrator, pred: (d: Decision) => boolean) => o.decisions.open().find(pred);
const answer = (o: Orchestrator, id: string, option?: string, text?: string) =>
  o.handle({ v: 1, type: 'decision.answer', decisionId: id, ...(option ? { option } : {}), ...(text ? { text } : {}) }, noReply);
const goalDecision = (o: Orchestrator) => waitFor(() => openDecision(o, (d) => d.kind === 'merge' && !!d.goalId), 'decisione di merge dell\'obiettivo', 90_000);

describe('merge per obiettivo', () => {
  it('una sola decisione per tutto l\'obiettivo; il checkout dell\'utente cambia solo dopo il Merge', async () => {
    const { o, repo } = await setup();
    const headBefore = await gitOut(repo, ['rev-parse', 'HEAD']);
    await submit(o, 'Aggiungi un saluto');
    const d = await goalDecision(o);

    // nessuna decisione per i singoli task: sono già uniti nel branch dell'obiettivo
    expect(o.decisions.list().filter((x) => x.kind === 'merge')).toHaveLength(1);
    expect(d).toMatchObject({ goalId: 'g1', repoId: expect.any(String), worktree: 'goal-g1' });
    expect(d.taskId).toBeUndefined();
    expect(o.tasks.list().map((t) => t.status)).toEqual(['done', 'done']);
    expect(o.goal('g1')).toMatchObject({ status: 'active', branch: 'Keystone/goal/g1', base: 'main' });
    expect(d.context).toMatch(/Test eseguiti da Keystone sul branch dell'obiettivo, con tutti i task uniti/);
    expect(d.context).toContain('t1 Prepara: Aggiungi un saluto');
    expect(d.context).toContain('t2 Completa: Aggiungi un saluto');

    // il checkout dell'utente non è stato toccato
    expect(await gitOut(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(fs.existsSync(path.join(repo, 'keystone-sim'))).toBe(false);
    // i merge nel branch dell'obiettivo sono di Keystone, non dell'utente
    const goalMerges = (await gitOut(repo, ['log', '--merges', '--format=%an|%s', 'Keystone/goal/g1'])).split('\n').filter(Boolean);
    expect(goalMerges.length).toBe(2);
    expect(goalMerges.every((l) => l.startsWith('Keystone|Merge Keystone/'))).toBe(true);

    // la diff della review è quella di tutto l'obiettivo
    const files = await o.repos.diff(d.repoId!, d.worktree!);
    expect(files.map((f) => f.path).sort()).toEqual(['keystone-sim/t1.md', 'keystone-sim/t2.md']);

    await answer(o, d.id, 'Merge');
    expect(o.goal('g1')).toMatchObject({ status: 'done', progress: 1 });
    expect(fs.existsSync(path.join(repo, 'keystone-sim', 't1.md'))).toBe(true);
    expect(fs.existsSync(path.join(repo, 'keystone-sim', 't2.md'))).toBe(true);
    expect(await gitOut(repo, ['status', '--porcelain'])).toBe('');
    // un solo merge nel branch dell'utente, con la sua identità
    const merges = (await gitOut(repo, ['log', '--merges', '--first-parent', '--format=%an|%s', 'main'])).split('\n').filter(Boolean);
    expect(merges).toHaveLength(1);
    const userName = await gitOut(repo, ['config', 'user.name']);
    expect(merges[0]).toBe(`${userName}|Merge Keystone/goal/g1 in main`);
    // branch e worktree dell'obiettivo eliminati
    expect((await git(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/Keystone/goal/g1'], { allowFail: true })).code).not.toBe(0);
    expect(o.repos.get(d.repoId!)!.worktrees.find((w) => w.id === 'goal-g1')?.status).toBe('merged');
  }, 120_000);

  it('i file lasciati dai test finali non finiscono nella diff né nel branch dell\'utente', async () => {
    const { o, repo } = await setup({}, async (r) => {
      // un test del repository che lascia un file nella cartella di lavoro
      fs.writeFileSync(path.join(r, 'artefatto.test.cjs'), "require('fs').writeFileSync('artefatto-dei-test.txt', 'x');\n");
      await git(r, ['add', '-A']);
      await git(r, ['commit', '-q', '-m', 'test che lascia un file']);
    });
    await submit(o, 'Aggiungi un saluto');
    const d = await goalDecision(o);
    const files = await o.repos.diff(d.repoId!, d.worktree!);
    expect(files.map((f) => f.path)).not.toContain('artefatto-dei-test.txt');
    await answer(o, d.id, 'Merge');
    expect(o.goal('g1')?.status).toBe('done');
    expect(await gitOut(repo, ['ls-files'])).not.toContain('artefatto-dei-test.txt');
    expect(fs.existsSync(path.join(repo, 'artefatto-dei-test.txt'))).toBe(false);
  }, 120_000);

  it('checkout con modifiche: il merge non parte, la decisione si riapre con il motivo', async () => {
    const { o, repo } = await setup();
    await submit(o, 'Aggiungi un saluto');
    const d = await goalDecision(o);
    fs.appendFileSync(path.join(repo, 'index.js'), "// modifica in corso dell'utente\n");
    const headBefore = await gitOut(repo, ['rev-parse', 'HEAD']);
    await answer(o, d.id, 'Merge');
    expect(o.decisions.get(d.id)).toMatchObject({ status: 'open' });
    expect(o.decisions.get(d.id)?.context).toMatch(/modifiche non committate/);
    expect(await gitOut(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(o.goal('g1')?.status).toBe('active');
  }, 120_000);

  it('"Rifiuta": niente nel branch dell\'utente, l\'obiettivo si chiude, il branch resta per il recupero', async () => {
    const { o, repo } = await setup();
    const headBefore = await gitOut(repo, ['rev-parse', 'HEAD']);
    await submit(o, 'Aggiungi un saluto');
    const d = await goalDecision(o);
    await answer(o, d.id, 'Rifiuta');
    expect(o.goal('g1')?.status).toBe('cancelled');
    expect(await gitOut(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await gitOut(repo, ['rev-parse', '--verify', 'refs/heads/Keystone/goal/g1'])).toMatch(/^[0-9a-f]{40}/);
  }, 120_000);

  it('"Richiedi modifiche": il lead ripianifica, poi arriva di nuovo una sola decisione', async () => {
    const { o } = await setup();
    await submit(o, 'Aggiungi un saluto');
    const d1 = await goalDecision(o);
    await answer(o, d1.id, 'Richiedi modifiche', 'aggiungi anche un congedo');
    const d2 = await waitFor(() => openDecision(o, (d) => d.kind === 'merge' && !!d.goalId && d.id !== d1.id), 'nuova decisione', 90_000);
    expect(d2.goalId).toBe('g1');
    expect(o.decisions.open().filter((d) => d.kind === 'merge')).toHaveLength(1);
  }, 120_000);

  it('il merge automatico va solo verso un branch Keystone/goal/*, mai verso il branch dell\'utente', async () => {
    const { o } = await setup({ mergePerGoal: false });
    await submit(o, 'Aggiungi un saluto');
    const d = await waitFor(() => openDecision(o, (x) => x.kind === 'merge' && x.taskId === 't1'), 'decisione del task');
    // un worktree che parte dal branch dell'utente: senza decisione non si unisce
    await expect(o.repos.mergeIntoGoal(d.repoId!, d.worktree!, 'Keystone/goal/g1', { commitMessage: 'x', agentIdentity: { name: 'a', email: 'a@a' }, keystoneIdentity: { name: 'k', email: 'k@k' } })).rejects.toBeInstanceOf(RepoError);
    await expect(o.repos.mergeIntoGoal(d.repoId!, d.worktree!, 'Keystone/goal/g1', { commitMessage: 'x', agentIdentity: { name: 'a', email: 'a@a' }, keystoneIdentity: { name: 'k', email: 'k@k' } })).rejects.toThrow(/serve la tua approvazione/);
  });

  it("dopo i test si tolgono solo i file creati dai test, non il lavoro dell'agente non ancora committato", async () => {
    const { o, repo } = await setup({ mergePerGoal: false }, async (r) => {
      fs.writeFileSync(path.join(r, 'crea.test.cjs'), "require('fs').writeFileSync('creato-dai-test.txt', 'x');\n");
      await git(r, ['add', '-A']);
      await git(r, ['commit', '-q', '-m', 'test che crea un file']);
    });
    const repoId = o.repos.list()[0]!.id;
    const wt = await o.repos.createWorktree(repoId, 'bruno', { id: 't99', title: 'prova' });
    fs.writeFileSync(path.join(wt.path, 'lavoro-dell-agente.txt'), 'non ancora committato');
    const res = await o.repos.runTests(repoId, wt.id, { command: 'npm test', env: process.env, timeoutMs: 120_000 });
    expect(res?.pass).toBe(true);
    expect(fs.existsSync(path.join(wt.path, 'lavoro-dell-agente.txt'))).toBe(true);
    expect(fs.existsSync(path.join(wt.path, 'creato-dai-test.txt'))).toBe(false);
    void repo;
  }, 120_000);
});
