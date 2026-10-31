// Il push fallisce a livello di git (non solo nella policy): con `git -c`, con l'ambiente
// sovrascritto o svuotato, da uno script, da uno script npm e da un hook. Il checkout dell'utente
// invece continua a fare push normalmente.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentEnv } from '../src/core/agent-env.js';
import { guardActive, removeGuard } from '../src/core/gitsafety.js';
import { RepoManager } from '../src/core/repos.js';
import { git, gitOut } from '../src/util/git.js';
import { demoRepo, testCtx, tmpDir } from './helpers.js';

async function setup() {
  const dir = tmpDir();
  const repo = await demoRepo(dir);
  const remote = path.join(dir, 'remote.git');
  await git(dir, ['init', '-q', '--bare', remote]);
  await git(repo, ['remote', 'add', 'origin', remote]);
  await git(repo, ['push', '-q', 'origin', 'main']);
  const repos = new RepoManager(testCtx(path.join(dir, 'state')), { worktreesDir: path.join(dir, 'worktrees'), guardFile: path.join(dir, 'state', 'git', 'agent-guard.gitconfig') });
  await repos.add(repo, { confirmGuard: true });
  const wt = await repos.createWorktree('repo', 'bruno', { id: 't1', title: 'push' });
  fs.writeFileSync(path.join(wt.path, 'lavoro.txt'), 'lavoro dell\'agente\n');
  const env = agentEnv(process.env, { agentId: 'bruno', name: 'Bruno', cwd: wt.path }) as NodeJS.ProcessEnv;
  await git(wt.path, ['add', '-A'], { env });
  await git(wt.path, ['commit', '-q', '-m', 'lavoro'], { env });
  const refs = () => gitOut(dir, ['--git-dir', remote, 'for-each-ref', '--format=%(refname) %(objectname)']);
  return { dir, repo, remote, repos, wt, env, refs, before: await refs() };
}

/** Un ambiente "svuotato" come con `env -i`: solo ciò che serve per trovare git. */
function bareEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('push bloccato a livello git', () => {
  it('push normale, con git -c e con pushurl esplicito: falliscono tutti', async () => {
    const s = await setup();
    const attempts: string[][] = [
      ['push', 'origin', 'HEAD'],
      ['push', s.remote, 'HEAD:refs/heads/diretto'],
      ['-c', 'protocol.allow=always', '-c', 'protocol.file.allow=always', 'push', 'origin', 'HEAD'],
      ['-c', 'protocol.allow=always', '-c', `remote.origin.pushurl=${s.remote}`, 'push', 'origin', 'HEAD'],
      ['-c', `url.${s.remote}.pushInsteadOf=${s.remote}`, '-c', 'protocol.allow=always', 'push', 'origin', 'HEAD'],
    ];
    for (const args of attempts) {
      const r = run(s.wt.path, args, s.env);
      expect(r.code, `git ${args.join(' ')} è riuscito: ${r.out}`).not.toBe(0);
    }
    expect(await s.refs()).toBe(s.before);
  });

  it('con le variabili d\'ambiente sovrascritte o svuotate (env -i): fallisce', async () => {
    const s = await setup();
    const envs: Array<[string, NodeJS.ProcessEnv]> = [
      ['GIT_ALLOW_PROTOCOL riabilitato', { ...s.env, GIT_ALLOW_PROTOCOL: 'file:https:ssh:git' }],
      ['configurazione d\'ambiente azzerata', { ...s.env, GIT_CONFIG_COUNT: '0' }],
      ['entrambe tolte', Object.fromEntries(Object.entries(s.env).filter(([k]) => k !== 'GIT_ALLOW_PROTOCOL' && !k.startsWith('GIT_CONFIG')))],
      ['GIT_CONFIG_PARAMETERS iniettato', { ...s.env, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_PARAMETERS: "'protocol.allow'='always'" }],
      ['env -i', bareEnv()],
      ['env -i + GIT_ALLOW_PROTOCOL=file', bareEnv({ GIT_ALLOW_PROTOCOL: 'file' })],
      ['env -i + configurazione globale vuota', bareEnv({ GIT_CONFIG_GLOBAL: path.join(s.dir, 'vuota.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' })],
    ];
    for (const [label, env] of envs) {
      const r = run(s.wt.path, ['push', 'origin', 'HEAD'], env);
      expect(r.code, `${label}: il push è riuscito\n${r.out}`).not.toBe(0);
      const r2 = run(s.wt.path, ['push', s.remote, 'HEAD:refs/heads/x'], env);
      expect(r2.code, `${label} (URL esplicito): il push è riuscito\n${r2.out}`).not.toBe(0);
    }
    expect(await s.refs()).toBe(s.before);
  });

  it('da uno script, anche se lo script ripulisce il proprio ambiente', async () => {
    const s = await setup();
    const script = path.join(s.wt.path, 'pubblica.cjs');
    fs.writeFileSync(
      script,
      [
        "const { spawnSync } = require('node:child_process');",
        'const clean = {};',
        "for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'HOME', 'USERPROFILE']) if (process.env[k]) clean[k] = process.env[k];",
        "const a = spawnSync('git', ['push', 'origin', 'HEAD'], { stdio: 'inherit' });",
        "const b = spawnSync('git', ['push', 'origin', 'HEAD'], { env: clean, stdio: 'inherit' });",
        'process.exit(a.status === 0 || b.status === 0 ? 0 : 1);',
      ].join('\n'),
    );
    const r = spawnSync(process.execPath, [script], { cwd: s.wt.path, env: s.env, encoding: 'utf8', windowsHide: true });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    expect(await s.refs()).toBe(s.before);
  });

  it('da uno script npm lanciato dal loop dei test', async () => {
    const s = await setup();
    const pkgPath = path.join(s.wt.path, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts: Record<string, string> };
    pkg.scripts.test = 'git push origin HEAD';
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    const res = await s.repos.runTests('repo', s.wt.id, { env: s.env, timeoutMs: 60_000 });
    expect(res?.pass).toBe(false);
    expect(await s.refs()).toBe(s.before);
  });

  it('da un hook git (post-commit) che prova a pubblicare', async () => {
    const s = await setup();
    const hooks = (await gitOut(s.repo, ['rev-parse', '--git-path', 'hooks'])).trim();
    const hookDir = path.resolve(s.repo, hooks);
    fs.mkdirSync(hookDir, { recursive: true });
    const marker = path.join(s.dir, 'hook-eseguito.txt');
    fs.writeFileSync(path.join(hookDir, 'post-commit'), `#!/bin/sh\necho eseguito > "${marker.replace(/\\/g, '/')}"\ngit push origin HEAD:refs/heads/dal-hook\nenv -i PATH="$PATH" git push origin HEAD:refs/heads/dal-hook-env-i\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(s.wt.path, 'altro.txt'), 'x\n');
    await git(s.wt.path, ['add', '-A'], { env: s.env });
    const c = run(s.wt.path, ['commit', '-q', '-m', 'commit con hook'], s.env);
    expect(c.code, c.out).toBe(0);
    expect(fs.existsSync(marker)).toBe(true); // l'hook è partito davvero
    expect(await s.refs()).toBe(s.before);
  });

  it('anche fetch e ls-remote sono bloccati negli worktree degli agenti', async () => {
    const s = await setup();
    expect(run(s.wt.path, ['fetch', 'origin'], s.env).code).not.toBe(0);
    expect(run(s.wt.path, ['ls-remote', 'origin'], bareEnv()).code).not.toBe(0);
  });

  it('gli agenti non possono firmare con le chiavi dell\'utente', async () => {
    const s = await setup();
    fs.writeFileSync(path.join(s.wt.path, 'firma.txt'), 'x\n');
    await git(s.wt.path, ['add', '-A'], { env: s.env });
    const r = run(s.wt.path, ['commit', '-S', '-m', 'firmato'], s.env);
    expect(r.code).not.toBe(0);
    const r2 = run(s.wt.path, ['-c', 'commit.gpgsign=true', 'commit', '-m', 'firmato'], s.env);
    expect(r2.code).not.toBe(0);
  });

  it('il checkout dell\'utente non è toccato: il suo push funziona come prima', async () => {
    const s = await setup();
    fs.writeFileSync(path.join(s.repo, 'utente.txt'), 'mio\n');
    await git(s.repo, ['add', '-A']);
    await git(s.repo, ['-c', 'user.name=Utente', '-c', 'user.email=u@u', 'commit', '-q', '-m', 'commit dell\'utente']);
    const r = run(s.repo, ['push', 'origin', 'main'], process.env);
    expect(r.code, r.out).toBe(0);
    expect(await gitOut(s.repo, ['config', '--get', 'protocol.allow']).catch(() => '')).toBe('');
  });

  it('il guardiano è attivo nei worktree degli agenti e si può rimuovere dal repository', async () => {
    const s = await setup();
    expect(await guardActive(s.wt.path)).toBe(true);
    expect(await guardActive(s.repo)).toBe(false);
    await removeGuard(s.repo);
    expect(await guardActive(s.wt.path)).toBe(false);
    expect((await gitOut(s.repo, ['config', '--local', '--list'])).toLowerCase()).not.toContain('includeif');
  });
});
