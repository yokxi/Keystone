// Fase 11, dopo la revisione: le protezioni del merge per obiettivo nei casi limite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Decision } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import type { Orchestrator } from '../src/core/orchestrator.js';
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
const goalDecision = (o: Orchestrator, not?: string) =>
  waitFor(() => openDecision(o, (d) => d.kind === 'merge' && !!d.goalId && d.id !== not), "decisione di merge dell'obiettivo", 90_000);
const OPTS = { commitMessage: 'x', agentIdentity: { name: 'a', email: 'a@a' }, keystoneIdentity: { name: 'k', email: 'k@k' } };

describe('merge per obiettivo: casi limite', () => {
  it("se il tuo checkout è su un branch di Keystone, l'obiettivo non parte", async () => {
    const { o, repo } = await setup();
    await git(repo, ['checkout', '-q', '-b', 'Keystone/goal/g9']);
    await expect(submit(o, 'Aggiungi un saluto')).rejects.toThrow(/branch di Keystone/);
  });

  it("un branch Keystone/goal/g1 rimasto da prima non viene riusato: test, diff e merge usano quello nuovo", async () => {
    const { o, repo } = await setup({}, async (r) => {
      // un lavoro rifiutato rimasto nel repository, con lo stesso id (per esempio dopo un reset)
      await git(r, ['checkout', '-q', '-b', 'Keystone/goal/g1']);
      fs.writeFileSync(path.join(r, 'lavoro-rifiutato.txt'), 'x');
      await git(r, ['add', '-A']);
      await git(r, ['-c', 'user.name=U', '-c', 'user.email=u@u', 'commit', '-q', '-m', 'rifiutato']);
      await git(r, ['checkout', '-q', 'main']);
    });
    await submit(o, 'Aggiungi un saluto');
    expect(o.goal('g1')?.branch).toBe('Keystone/goal/g1-2');
    const d = await goalDecision(o);
    expect(o.repos.findWorktree(d.repoId!, d.worktree!)?.branch).toBe('Keystone/goal/g1-2');
    const files = (await o.repos.diff(d.repoId!, d.worktree!)).map((f) => f.path);
    expect(files).not.toContain('lavoro-rifiutato.txt');
    await answer(o, d.id, 'Merge');
    expect(o.goal('g1')?.status).toBe('done');
    expect(fs.existsSync(path.join(repo, 'keystone-sim', 't1.md'))).toBe(true);
    expect(fs.existsSync(path.join(repo, 'lavoro-rifiutato.txt'))).toBe(false);
    // il branch vecchio resta com'era
    expect(await gitOut(repo, ['log', '-1', '--format=%s', 'Keystone/goal/g1'])).toBe('rifiutato');
  }, 150_000);

  it("mergeIntoGoal: solo verso il branch di quell'obiettivo, mai se è aperto nel tuo checkout", async () => {
    const { o, repo } = await setup({ mergePerGoal: false });
    const repoId = o.repos.list()[0]!.id;
    await git(repo, ['branch', 'Keystone/goal/zz', 'main']);
    const wt = await o.repos.createWorktree(repoId, 'bruno', { id: 't50', title: 'prova' }, undefined, 'Keystone/goal/zz');
    fs.writeFileSync(path.join(wt.path, 'nuovo.txt'), 'x');
    // un altro branch Keystone/goal/*: rifiutato
    await expect(o.repos.mergeIntoGoal(repoId, wt.id, 'Keystone/goal/altro', OPTS)).rejects.toThrow(/serve la tua approvazione/);
    // il branch dell'obiettivo aperto nel checkout dell'utente: rifiutato, il checkout resta com'era
    await git(repo, ['checkout', '-q', 'Keystone/goal/zz']);
    const head = await gitOut(repo, ['rev-parse', 'HEAD']);
    await expect(o.repos.mergeIntoGoal(repoId, wt.id, 'Keystone/goal/zz', OPTS)).rejects.toThrow(/è aperto in/);
    expect(await gitOut(repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect(fs.existsSync(path.join(repo, 'nuovo.txt'))).toBe(false);
  });

  it("se il branch dell'obiettivo cambia dopo la review, il Merge non parte e arriva una nuova decisione", async () => {
    const { o, repo } = await setup();
    await submit(o, 'Aggiungi un saluto');
    const d1 = await goalDecision(o);
    expect(d1.reviewedSha).toMatch(/^[0-9a-f]{40}$/);
    const head = await gitOut(repo, ['rev-parse', 'HEAD']);
    // un commit nel branch dell'obiettivo dopo la review (per esempio fatto da un test)
    const wtPath = o.repos.findWorktree(d1.repoId!, d1.worktree!)!.path;
    fs.writeFileSync(path.join(wtPath, 'aggiunto-dopo.txt'), 'x');
    await git(wtPath, ['add', '-A']);
    await git(wtPath, ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'dopo la review']);
    await answer(o, d1.id, 'Merge');
    expect(o.decisions.get(d1.id)?.status).toBe('cancelled');
    expect(await gitOut(repo, ['rev-parse', 'HEAD'])).toBe(head);
    const d2 = await goalDecision(o, d1.id);
    expect(d2.reviewedSha).not.toBe(d1.reviewedSha);
  }, 150_000);

  it("un task nuovo che entra nell'obiettivo annulla la decisione aperta", async () => {
    const { o } = await setup();
    await submit(o, 'Aggiungi un saluto');
    const d1 = await goalDecision(o);
    o.tasks.create({ title: 'Ancora una modifica', goalId: 'g1', repoId: d1.repoId!, createdBy: 'ada' });
    o.team.tick();
    await waitFor(() => o.decisions.get(d1.id)?.status === 'cancelled', 'decisione annullata', 90_000);
    const d2 = await goalDecision(o, d1.id);
    expect(d2.context).toContain('Ancora una modifica');
  }, 200_000);

  it('la pulizia dopo i test non segue le junction: i file fuori dal worktree restano', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-fuori-'));
    fs.writeFileSync(path.join(outside, 'segreto.txt'), 'da non cancellare');
    try {
      const { o } = await setup({ mergePerGoal: false }, async (r) => {
        fs.writeFileSync(path.join(r, 'junction.test.cjs'), `require('fs').symlinkSync(${JSON.stringify(outside)}, 'j', 'junction');\n`);
        await git(r, ['add', '-A']);
        await git(r, ['commit', '-q', '-m', 'test che crea una junction']);
      });
      const repoId = o.repos.list()[0]!.id;
      const wt = await o.repos.createWorktree(repoId, 'bruno', { id: 't51', title: 'prova' });
      await o.repos.runTests(repoId, wt.id, { command: 'npm test', env: process.env, timeoutMs: 120_000 });
      expect(fs.readFileSync(path.join(outside, 'segreto.txt'), 'utf8')).toBe('da non cancellare');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 120_000);

  it('"Richiedi modifiche" senza testo: la decisione si riapre e chiede cosa cambiare', async () => {
    const { o } = await setup();
    await submit(o, 'Aggiungi un saluto');
    const d = await goalDecision(o);
    await answer(o, d.id, 'Richiedi modifiche');
    expect(o.decisions.get(d.id)).toMatchObject({ status: 'open' });
    expect(o.decisions.get(d.id)?.context).toMatch(/Scrivi cosa cambiare/);
  }, 120_000);

  it('obiettivo in pausa: niente decisione finale', async () => {
    const { o } = await setup();
    await submit(o, 'Aggiungi un saluto');
    const d = await goalDecision(o);
    o.decisions.cancel(d.id, 'prova');
    o.setGoal('g1', { status: 'paused' });
    expect(await o.checkGoalReady('g1')).toBeUndefined();
  }, 120_000);

  it('conflitto al merge finale: la decisione si chiude e un task unisce il tuo branch e risolve', async () => {
    const { o, repo } = await setup();
    await submit(o, 'Aggiungi un saluto');
    const d = await goalDecision(o);
    // nel frattempo sul tuo branch arriva un lavoro che tocca lo stesso file
    fs.mkdirSync(path.join(repo, 'keystone-sim'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'keystone-sim', 't1.md'), '# versione arrivata prima\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['-c', 'user.name=U', '-c', 'user.email=u@u', 'commit', '-q', '-m', "lavoro dell'utente"]);
    const head = await gitOut(repo, ['rev-parse', 'HEAD']);
    await answer(o, d.id, 'Merge');
    expect(o.decisions.get(d.id)?.status).toBe('cancelled');
    expect(await gitOut(repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect(o.tasks.list().some((t) => t.title === 'Unisci main e risolvi i conflitti')).toBe(true);
    await o.stop();
  }, 120_000);

  it("i merge nel branch dell'obiettivo non sono mai firmati, anche con commit.gpgsign=true", async () => {
    const { o, repo } = await setup({}, async (r) => {
      // una firma qualsiasi fallirebbe: se Keystone firmasse, il merge dei task non riuscirebbe
      await git(r, ['config', 'commit.gpgsign', 'true']);
      await git(r, ['config', 'gpg.program', 'programma-di-firma-inesistente']);
    });
    await submit(o, 'Aggiungi un saluto');
    await goalDecision(o);
    const sigs = (await gitOut(repo, ['log', '--merges', '--format=%G?', 'Keystone/goal/g1'])).split('\n').filter(Boolean);
    expect(sigs.length).toBe(2);
    expect(sigs.every((s) => s === 'N')).toBe(true);
  }, 120_000);
});
