// Merge su approvazione: il checkout dell'utente risulta allineato e pulito; se qualcosa fallisce
// a metà il branch dell'utente resta esattamente com'era.
import fs from 'node:fs';
import path from 'node:path';
import { MERGE_OPTIONS, type Decision } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import { RepoError, RepoManager, type RepoManagerOptions } from '../src/core/repos.js';
import { git, gitOut } from '../src/util/git.js';
import { demoRepo, testCtx, tmpDir } from './helpers.js';

const AGENT = { name: 'Keystone Bruno', email: 'bruno@keystone.local' };
const agentEnv = { ...process.env, GIT_AUTHOR_NAME: AGENT.name, GIT_AUTHOR_EMAIL: AGENT.email, GIT_COMMITTER_NAME: AGENT.name, GIT_COMMITTER_EMAIL: AGENT.email };

async function setup(faults?: RepoManagerOptions['faults']) {
  const dir = tmpDir();
  const repo = await demoRepo(dir);
  // l'identità dell'utente in questo repository (quella con cui verrà fatto il merge approvato)
  await git(repo, ['config', 'user.name', 'Utente Test']);
  await git(repo, ['config', 'user.email', 'utente@example.com']);
  const repos = new RepoManager(testCtx(path.join(dir, 'state')), {
    worktreesDir: path.join(dir, 'worktrees'),
    guardFile: path.join(dir, 'state', 'git', 'agent-guard.gitconfig'),
    removeDelayMs: 20,
    ...(faults ? { faults } : {}),
  });
  await repos.add(repo, { confirmGuard: true });
  const wt = await repos.createWorktree('repo', 'bruno', { id: 't1', title: 'saluto' });
  fs.writeFileSync(path.join(wt.path, 'nuovo.txt'), 'scritto dall\'agente\n');
  fs.appendFileSync(path.join(wt.path, 'README.md'), 'Riga aggiunta dall\'agente.\n');
  await git(wt.path, ['add', '-A'], { env: agentEnv });
  await git(wt.path, ['commit', '-q', '-m', 't1: saluto'], { env: agentEnv });
  const decision: Decision = { id: 'd1', agentId: 'ada', kind: 'merge', question: 'Unire t1?', options: [...MERGE_OPTIONS], status: 'answered', answer: { option: 'Merge' }, repoId: 'repo', worktree: wt.id, taskId: 't1', createdAt: 1 };
  const baseSha = await gitOut(repo, ['rev-parse', 'main']);
  const merge = () => repos.merge(decision, { commitMessage: 't1: saluto', agentIdentity: AGENT });
  return { dir, repo, repos, wt, decision, baseSha, merge };
}

/** Testo di un file con i fine riga normalizzati (git può convertirli: core.autocrlf). */
function readText(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

async function expectUnchanged(repo: string, baseSha: string) {
  expect(await gitOut(repo, ['rev-parse', 'main'])).toBe(baseSha);
  expect(await gitOut(repo, ['rev-parse', 'HEAD'])).toBe(baseSha);
  expect(await gitOut(repo, ['status', '--porcelain'])).toBe('');
  expect(fs.existsSync(path.join(repo, 'nuovo.txt'))).toBe(false);
}

describe('merge approvato', () => {
  it('base estratta nel checkout dell\'utente: dopo il merge il working tree è allineato e pulito', async () => {
    const s = await setup();
    // un file non tracciato dell'utente che il merge non tocca deve restare
    fs.writeFileSync(path.join(s.repo, 'appunti-utente.txt'), 'miei appunti\n');
    const branchTip = await gitOut(s.repo, ['rev-parse', s.wt.branch]);
    const res = await s.merge();
    const head = await gitOut(s.repo, ['rev-parse', 'HEAD']);
    expect(await gitOut(s.repo, ['rev-parse', 'main'])).toBe(head);
    expect(head.startsWith(res.sha)).toBe(true);
    // pulito: nessuna modifica tracciata, e l'unico file non tracciato è quello dell'utente
    expect(await gitOut(s.repo, ['status', '--porcelain'])).toBe('?? appunti-utente.txt');
    // i file del merge sono nel working tree
    expect(readText(path.join(s.repo, 'nuovo.txt'))).toBe('scritto dall\'agente\n');
    expect(fs.readFileSync(path.join(s.repo, 'README.md'), 'utf8')).toContain('Riga aggiunta dall\'agente.');
    expect(fs.readFileSync(path.join(s.repo, 'appunti-utente.txt'), 'utf8')).toBe('miei appunti\n');
    // commit di merge: due genitori (base, branch dell'agente), con l'identità dell'utente
    const [p1, p2] = (await gitOut(s.repo, ['log', '-1', '--format=%P'])).split(' ');
    expect(p1).toBe(s.baseSha);
    expect(p2).toBe(branchTip);
    expect(await gitOut(s.repo, ['log', '-1', '--format=%an <%ae>'])).toBe('Utente Test <utente@example.com>');
    expect(await gitOut(s.repo, ['log', '-1', '--format=%B'])).toContain('Approvato in Keystone (decisione d1, task t1)');
    // i commit dell'agente restano con la sua identità
    expect(await gitOut(s.repo, ['log', '-1', '--format=%an', 'HEAD^2'])).toBe('Keystone Bruno');
    // il worktree è chiuso e il branch dell'agente eliminato (di default)
    expect(fs.existsSync(s.wt.path)).toBe(false);
    expect(s.repos.findWorktree('repo', s.wt.id)?.status).toBe('merged');
    expect(res.branchDeleted).toBe(true);
    expect(await gitOut(s.repo, ['branch', '--list', s.wt.branch])).toBe('');
    // il diff unito resta consultabile
    expect((await s.repos.diff('repo', s.wt.id)).map((f) => f.path).sort()).toEqual(['README.md', 'nuovo.txt']);
  });

  it('base non estratta da nessuna parte: si sposta solo il riferimento, in modo atomico', async () => {
    const s = await setup();
    await git(s.repo, ['switch', '-q', '-c', 'altro']);
    await s.merge();
    expect(await gitOut(s.repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('altro');
    expect(await gitOut(s.repo, ['rev-parse', 'HEAD'])).toBe(s.baseSha); // il checkout dell'utente non è toccato
    expect(await gitOut(s.repo, ['status', '--porcelain'])).toBe('');
    expect(await gitOut(s.repo, ['log', '-1', '--format=%P', 'main'])).toContain(s.baseSha);
  });

  it('il lavoro lasciato non committato nel worktree viene committato con l\'identità dell\'agente', async () => {
    const s = await setup();
    fs.writeFileSync(path.join(s.wt.path, 'ultimo.txt'), 'dimenticato\n');
    await s.merge();
    expect(await gitOut(s.repo, ['log', '-1', '--format=%an|%s', 'HEAD^2'])).toBe('Keystone Bruno|t1: saluto');
    expect(readText(path.join(s.repo, 'ultimo.txt'))).toBe('dimenticato\n');
  });

  it('rifiutato se il checkout ha modifiche non committate', async () => {
    const s = await setup();
    fs.appendFileSync(path.join(s.repo, 'index.js'), '// modifica dell\'utente\n');
    await expect(s.merge()).rejects.toMatchObject({ code: 'dirty' });
    expect(await gitOut(s.repo, ['rev-parse', 'HEAD'])).toBe(s.baseSha);
    expect(fs.readFileSync(path.join(s.repo, 'index.js'), 'utf8')).toContain('modifica dell\'utente');
    expect(s.repos.findWorktree('repo', s.wt.id)?.status).toBe('active');
  });

  it('rifiutato prima di toccare qualcosa se un file non tracciato verrebbe sovrascritto', async () => {
    const s = await setup();
    fs.writeFileSync(path.join(s.repo, 'nuovo.txt'), 'file mio, non tracciato\n');
    await expect(s.merge()).rejects.toMatchObject({ code: 'dirty' });
    expect(await gitOut(s.repo, ['rev-parse', 'HEAD'])).toBe(s.baseSha);
    expect(fs.readFileSync(path.join(s.repo, 'nuovo.txt'), 'utf8')).toBe('file mio, non tracciato\n');
  });

  it('rifiutato in caso di conflitto, con l\'elenco dei file', async () => {
    const s = await setup();
    fs.appendFileSync(path.join(s.repo, 'README.md'), 'Riga diversa dell\'utente.\n');
    await git(s.repo, ['commit', '-qam', 'modifica dell\'utente']);
    const newBase = await gitOut(s.repo, ['rev-parse', 'HEAD']);
    const err = (await s.merge().catch((e: unknown) => e)) as RepoError;
    expect(err).toBeInstanceOf(RepoError);
    expect(err.code).toBe('conflict');
    expect(err.files).toEqual(['README.md']);
    expect(await gitOut(s.repo, ['rev-parse', 'HEAD'])).toBe(newBase);
    expect(await gitOut(s.repo, ['status', '--porcelain'])).toBe('');
  });

  it('atomico: un guasto dopo il fast-forward riporta il checkout esattamente com\'era', async () => {
    const s = await setup({
      afterApply: () => {
        throw new Error('guasto simulato');
      },
    });
    await expect(s.merge()).rejects.toThrow(/guasto simulato/);
    await expectUnchanged(s.repo, s.baseSha);
    expect(fs.readFileSync(path.join(s.repo, 'README.md'), 'utf8')).not.toContain('Riga aggiunta dall\'agente.');
    expect(s.repos.findWorktree('repo', s.wt.id)?.status).toBe('active'); // si può riprovare
  });

  it('atomico anche quando la base non è estratta: il riferimento torna com\'era', async () => {
    const s = await setup({
      afterApply: () => {
        throw new Error('guasto simulato');
      },
    });
    await git(s.repo, ['switch', '-q', '-c', 'altro']);
    await expect(s.merge()).rejects.toThrow(/guasto simulato/);
    expect(await gitOut(s.repo, ['rev-parse', 'main'])).toBe(s.baseSha);
  });

  it('se la base cambia durante il merge, il merge è rifiutato e il nuovo commit dell\'utente resta', async () => {
    let userCommit = '';
    const s = await setup({
      beforeApply: async () => {
        fs.writeFileSync(path.join(s.repo, 'altro.txt'), 'commit arrivato nel frattempo\n');
        await git(s.repo, ['add', 'altro.txt']);
        await git(s.repo, ['commit', '-q', '-m', 'commit nel frattempo']);
        userCommit = await gitOut(s.repo, ['rev-parse', 'HEAD']);
      },
    });
    await expect(s.merge()).rejects.toMatchObject({ code: 'refused' });
    expect(await gitOut(s.repo, ['rev-parse', 'HEAD'])).toBe(userCommit);
    expect(await gitOut(s.repo, ['status', '--porcelain'])).toBe('');
  });

  it('se la firma richiesta dalla configurazione dell\'utente fallisce, nulla cambia', async () => {
    const s = await setup();
    await git(s.repo, ['config', 'commit.gpgsign', 'true']);
    await git(s.repo, ['config', 'gpg.program', 'programma-inesistente-keystone']);
    await expect(s.merge()).rejects.toThrow(/firma/);
    await expectUnchanged(s.repo, s.baseSha);
  });

  it('solo con una decisione di merge approvata per quel worktree', async () => {
    const s = await setup();
    const opts = { commitMessage: 'x', agentIdentity: AGENT };
    await expect(s.repos.merge({ ...s.decision, answer: { option: 'Rifiuta' } }, opts)).rejects.toMatchObject({ code: 'refused' });
    await expect(s.repos.merge({ ...s.decision, status: 'open' }, opts)).rejects.toMatchObject({ code: 'refused' });
    await expect(s.repos.merge({ ...s.decision, kind: 'question' }, opts)).rejects.toMatchObject({ code: 'refused' });
    await expectUnchanged(s.repo, s.baseSha);
  });

  it('un branch senza modifiche non viene unito', async () => {
    const s = await setup();
    const wt2 = await s.repos.createWorktree('repo', 'chiara', { id: 't2', title: 'vuoto' });
    await expect(s.repos.merge({ ...s.decision, worktree: wt2.id }, { commitMessage: 'x', agentIdentity: AGENT })).rejects.toMatchObject({ code: 'empty' });
  });
});

describe('pulizia dei worktree orfani', () => {
  it('rimuove cartelle orfane e registrazioni senza cartella, non tocca i worktree attivi', async () => {
    const s = await setup();
    const orphan = path.join(s.dir, 'worktrees', 'repo', 'ks-vecchio-t9');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'x.txt'), 'x');
    const wt2 = await s.repos.createWorktree('repo', 'chiara', { id: 't2', title: 'sparito' });
    fs.rmSync(wt2.path, { recursive: true, force: true }); // cartella sparita (es. cancellata a mano)
    const report = await s.repos.pruneOrphans();
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(s.wt.path)).toBe(true);
    expect(s.repos.findWorktree('repo', wt2.id)?.status).toBe('abandoned');
    expect(report.join('\n')).toContain('ks-vecchio-t9');
    expect(await gitOut(s.repo, ['worktree', 'list'])).not.toContain('ks-chiara-t2');
  });
});
