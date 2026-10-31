import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/core/diff.js';
import { RepoError, RepoManager } from '../src/core/repos.js';
import { git, gitOut } from '../src/util/git.js';
import { demoRepo, testCtx, tmpDir } from './helpers.js';

function manager() {
  const dir = tmpDir();
  const ctx = testCtx(path.join(dir, 'state'));
  return { repos: new RepoManager(ctx, { worktreesDir: path.join(dir, 'worktrees'), guardFile: path.join(dir, 'git', 'agent-guard.gitconfig'), removeDelayMs: 20 }), dir, ctx };
}

describe('RepoManager', () => {
  it('registra solo la radice di un repository con almeno un commit', async () => {
    const { repos, dir } = manager();
    const repo = await demoRepo(dir);
    const r = await repos.add(repo, { confirmGuard: true });
    expect(r).toMatchObject({ id: 'repo', branch: 'main', dirty: false });
    // registrare due volte lo stesso repo non lo duplica
    await repos.add(repo, { confirmGuard: true });
    expect(repos.list()).toHaveLength(1);
    fs.mkdirSync(path.join(repo, 'sub'));
    await expect(repos.add(path.join(repo, 'sub'), { confirmGuard: true })).rejects.toMatchObject({ code: 'not_root' });
    await expect(repos.add(path.join(dir, 'nessuno'), { confirmGuard: true })).rejects.toBeInstanceOf(RepoError);
    const empty = path.join(dir, 'vuoto');
    fs.mkdirSync(empty);
    await expect(repos.add(empty, { confirmGuard: true })).rejects.toMatchObject({ code: 'not_git' });
    await git(empty, ['init', '-q']);
    await expect(repos.add(empty, { confirmGuard: true })).rejects.toMatchObject({ code: 'no_commits' });
  });

  it('crea un worktree per task su Keystone/<agente>/<task> senza toccare il checkout dell\'utente', async () => {
    const { repos, dir } = manager();
    const repo = await demoRepo(dir);
    await repos.add(repo, { confirmGuard: true });
    const headBefore = await gitOut(repo, ['rev-parse', 'HEAD']);
    const wt = await repos.createWorktree('repo', 'bruno', { id: 't1', title: 'Aggiungi il flag --version' });
    expect(wt.branch).toBe('Keystone/bruno/t1-aggiungi-il-flag-version');
    expect(wt.base).toBe('main');
    expect(fs.existsSync(path.join(wt.path, 'README.md'))).toBe(true);
    expect(await gitOut(wt.path, ['symbolic-ref', '--short', 'HEAD'])).toBe(wt.branch);
    // il checkout dell'utente è rimasto com'era
    expect(await gitOut(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await gitOut(repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(await gitOut(repo, ['status', '--porcelain'])).toBe('');
    // chiederlo di nuovo restituisce lo stesso worktree
    expect((await repos.createWorktree('repo', 'bruno', { id: 't1', title: 'Aggiungi il flag --version' })).path).toBe(wt.path);
  });

  it('il diff include modifiche committate, non committate e file nuovi, senza toccare l\'indice dell\'agente', async () => {
    const { repos, dir } = manager();
    const repo = await demoRepo(dir);
    await repos.add(repo, { confirmGuard: true });
    const wt = await repos.createWorktree('repo', 'chiara', { id: 't2', title: 'diff' });
    fs.appendFileSync(path.join(wt.path, 'README.md'), 'Riga committata.\n');
    await git(wt.path, ['add', '-A']);
    await git(wt.path, ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'c1']);
    fs.writeFileSync(path.join(wt.path, 'index.js'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(wt.path, 'nuovo.txt'), 'ciao\n');
    const files = await repos.diff('repo', wt.id);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['README.md']).toMatchObject({ status: 'modified', additions: 1, deletions: 0 });
    expect(byPath['index.js']).toMatchObject({ status: 'modified', deletions: 3, additions: 1 });
    expect(byPath['nuovo.txt']).toMatchObject({ status: 'added', additions: 1 });
    // nessun file è stato aggiunto all'indice dell'agente
    expect(await gitOut(wt.path, ['diff', '--cached', '--name-only'])).toBe('');
    await repos.refresh('repo');
    expect(repos.findWorktree('repo', wt.id)).toMatchObject({ files: 3 });
  });

  it('abbandonare un worktree salva il lavoro sul branch, rimuove la cartella e fa prune', async () => {
    const { repos, dir } = manager();
    const repo = await demoRepo(dir);
    await repos.add(repo, { confirmGuard: true });
    const wt = await repos.createWorktree('repo', 'dario', { id: 't3', title: 'abbandono' });
    fs.writeFileSync(path.join(wt.path, 'lavoro.txt'), 'mezzo fatto\n');
    await repos.abandon('repo', wt.id, 't3: lavoro salvato', { name: 'Keystone Dario', email: 'dario@keystone.local' });
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(repos.findWorktree('repo', wt.id)?.status).toBe('abandoned');
    expect(await gitOut(repo, ['log', '-1', '--format=%an|%s', wt.branch])).toBe('Keystone Dario|t3: lavoro salvato');
    expect(await gitOut(repo, ['show', `${wt.branch}:lavoro.txt`])).toBe('mezzo fatto');
    expect(await gitOut(repo, ['worktree', 'list', '--porcelain'])).not.toContain('dario-t3');
    // il diff del worktree chiuso resta consultabile
    expect((await repos.diff('repo', wt.id)).map((f) => f.path)).toEqual(['lavoro.txt']);
  });

  it('ricrea un worktree rimasto a metà da un crash (cartella esistente, non registrata)', async () => {
    const { repos, dir } = manager();
    const repo = await demoRepo(dir);
    await repos.add(repo, { confirmGuard: true });
    const stale = path.join(dir, 'worktrees', 'repo', 'ks-elena-t4');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'residuo.txt'), 'x');
    const wt = await repos.createWorktree('repo', 'elena', { id: 't4', title: 'residuo' });
    expect(fs.existsSync(path.join(wt.path, 'residuo.txt'))).toBe(false);
    expect(fs.existsSync(path.join(wt.path, 'README.md'))).toBe(true);
  });

  it('segnala il checkout dell\'utente con modifiche non committate', async () => {
    const { repos, dir } = manager();
    const repo = await demoRepo(dir);
    await repos.add(repo, { confirmGuard: true });
    fs.appendFileSync(path.join(repo, 'README.md'), 'modifica\n');
    expect((await repos.refresh('repo')).dirty).toBe(true);
  });
});

describe('parseUnifiedDiff', () => {
  it('assegna i numeri di riga vecchi e nuovi', () => {
    const files = parseUnifiedDiff(
      ['diff --git a/a.txt b/a.txt', 'index 1..2 100644', '--- a/a.txt', '+++ b/a.txt', '@@ -1,3 +1,3 @@', ' uno', '-due', '+DUE', ' tre', ''].join('\n'),
    );
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: 'ctx', text: 'uno', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'due', oldNo: 2 },
      { kind: 'add', text: 'DUE', newNo: 2 },
      { kind: 'ctx', text: 'tre', oldNo: 3, newNo: 3 },
    ]);
  });

  it('riconosce rinomine, file binari ed eliminazioni', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/old.txt b/new.txt',
        'similarity index 100%',
        'rename from old.txt',
        'rename to new.txt',
        'diff --git a/img.png b/img.png',
        'Binary files a/img.png and b/img.png differ',
        'diff --git a/x.txt b/x.txt',
        'deleted file mode 100644',
        '--- a/x.txt',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-addio',
      ].join('\n'),
    );
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ['new.txt', 'renamed', false],
      ['img.png', 'modified', true],
      ['x.txt', 'deleted', false],
    ]);
    expect(files[0]?.oldPath).toBe('old.txt');
    expect(files[2]?.deletions).toBe(1);
  });
});
