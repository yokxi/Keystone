// Il guardiano git: sta fuori da repository e worktree (in ~/.keystone/git), si installa solo con
// la conferma dell'utente, un agente non può modificarlo né cambiare il percorso dell'include, e
// senza guardiano nessun worker lavora.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { EngineId, PermissionAnswer } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import { guardActive, removeGuard } from '../src/core/gitsafety.js';
import { classify } from '../src/core/policy.js';
import { isInsideOrEqual } from '../src/util/fsx.js';
import { SimEngine } from '../src/engines/sim/sim-engine.js';
import type { SimScript } from '../src/engines/sim/script.js';
import type { EngineAdapter } from '../src/engines/types.js';
import { gitOut } from '../src/util/git.js';
import { demoRepo, noReply, onCleanup, testOrchestrator, tmpDir, waitFor } from './helpers.js';
import { createDemoRepo, isKeystoneDemo } from '../src/demo.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

describe('registrazione con conferma', () => {
  it('senza conferma il .git/config non cambia; l\'anteprima mostra esattamente la riga che poi viene aggiunta', async () => {
    const { o, cfg } = testOrchestrator();
    const repo = await demoRepo(cfg.home);
    const configFile = path.join(repo, '.git', 'config');
    const before = fs.readFileSync(configFile, 'utf8');

    const pv = (await o.handle({ v: 1, type: 'repo.preview', path: repo }, noReply)) as { configFile: string; lines: string[]; guardFile: string; installed: boolean };
    expect(pv.installed).toBe(false);
    expect(path.resolve(pv.configFile)).toBe(path.resolve(configFile));
    expect(pv.lines[0]).toMatch(/^\[includeIf "gitdir\/i:.*\/worktrees\/ks-\*"\]$/);
    expect(pv.lines[1]).toBe(`\tpath = ${pv.guardFile}`);

    await expect(o.handle({ v: 1, type: 'repo.add', path: repo }, noReply)).rejects.toThrow(/Conferma la modifica/);
    await expect(o.handle({ v: 1, type: 'repo.add', path: repo, confirmGuard: false }, noReply)).rejects.toThrow(/Conferma/);
    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    expect(o.repos.list()).toHaveLength(0);

    await o.handle({ v: 1, type: 'repo.add', path: repo, confirmGuard: true }, noReply);
    const after = fs.readFileSync(configFile, 'utf8').replace(/\r\n/g, '\n');
    expect(after.startsWith(before.replace(/\r\n/g, '\n'))).toBe(true); // aggiunta in fondo, nient'altro cambia
    expect(after.slice(before.replace(/\r\n/g, '\n').length).trim()).toBe(pv.lines.join('\n').trim());
    // registrare di nuovo non chiede più nulla e non duplica la riga
    expect(((await o.handle({ v: 1, type: 'repo.preview', path: repo }, noReply)) as { installed: boolean }).installed).toBe(true);
    await o.handle({ v: 1, type: 'repo.add', path: repo }, noReply);
    expect(fs.readFileSync(configFile, 'utf8').match(/includeIf/g)).toHaveLength(1);
  });

  it('il file incluso sta in ~/.keystone/git, fuori da repository e worktree', async () => {
    const { o, cfg } = testOrchestrator();
    const repo = await demoRepo(cfg.home);
    await o.repos.add(repo, { confirmGuard: true });
    const guard = o.repos.guardFile;
    expect(path.resolve(guard)).toBe(path.resolve(cfg.home, 'git', 'agent-guard.gitconfig'));
    expect(isInsideOrEqual(repo, guard)).toBe(false);
    expect(isInsideOrEqual(path.join(cfg.home, cfg.profile, 'worktrees'), guard)).toBe(false);
    expect(fs.readFileSync(guard, 'utf8')).toMatch(/helper = ""/);
  });

  it('da riga di comando: senza terminale e senza --confirm-guard si ferma e non modifica nulla', async () => {
    const dir = tmpDir();
    const repo = await demoRepo(dir);
    const before = fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'orchestrator/src/main.ts', '--home', path.join(dir, 'home'), '--port', '0', '--repo', repo], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60_000, input: '' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/includeIf "gitdir\/i:/); // la riga viene mostrata
    expect(r.stdout).toMatch(/--remove-git-guard/);
    expect(r.stderr).toMatch(/--confirm-guard/);
    expect(fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8')).toBe(before);
  });
});

describe('un agente non può modificare il guardiano', () => {
  async function setup() {
    const { o, cfg } = testOrchestrator();
    const repo = await demoRepo(cfg.home);
    await o.repos.add(repo, { confirmGuard: true });
    const wt = await o.repos.createWorktree('repo', 'bruno', { id: 't1', title: 'prova' });
    const common = await o.repos.commonDir('repo');
    const protectedPaths = [path.dirname(o.repos.guardFile), path.join(common, 'config'), path.join(common, 'worktrees'), path.join(wt.path, '.git')];
    return { o, repo, wt, common, protectedPaths, guard: o.repos.guardFile };
  }

  it('policy: scritture, cancellazioni e modifiche dell\'include sono negate (non chieste)', async () => {
    const s = await setup();
    const ctx = { role: 'worker' as const, cwd: s.wt.path, protectedPaths: s.protectedPaths };
    const g = s.guard.replace(/\\/g, '/');
    const cfg = path.join(s.common, 'config').replace(/\\/g, '/');
    const bash = [
      `echo "[protocol]" > "${g}"`,
      `echo x >> "${g}"`,
      `rm "${g}"`,
      `rm -rf "${path.dirname(g)}"`,
      `cp altro.gitconfig "${g}"`,
      `sed -i s/never/always/ "${g}"`,
      `echo "[include]" >> "${cfg}"`,
      'git config --local includeIf.gitdir/i:x.path y',
      `git config --unset-all "includeIf.gitdir/i:${s.common.replace(/\\/g, '/')}/worktrees/ks-*.path"`,
      'git config --remove-section includeIf.gitdir/i:x',
      `git config --file "${g}" protocol.allow always`,
      'git -c include.path=altro.gitconfig status',
      'echo "gitdir: altrove" > .git',
      `echo x > "${path.join(s.common, 'worktrees', 'ks-bruno-t1', 'commondir').replace(/\\/g, '/')}"`,
    ];
    for (const command of bash) {
      const v = classify('Bash', { command }, ctx);
      expect(v.action, `${command} -> ${v.action}: ${v.reason}`).toBe('deny');
    }
    expect(classify('Write', { file_path: s.guard }, ctx).action).toBe('deny');
    expect(classify('Edit', { file_path: path.join(s.common, 'config') }, ctx).action).toBe('deny');
    expect(classify('Edit', { file_path: path.join(s.wt.path, '.git') }, ctx).action).toBe('deny');
    // anche "consenti sempre" non sblocca un percorso protetto
    expect(classify('Write', { file_path: s.guard }, { ...ctx, alwaysAllow: [`Write:${path.dirname(s.guard)}`] }).action).toBe('deny');
  });

  it('in un turno vero: ogni tentativo è negato senza chiedere all\'utente e il guardiano resta intatto', async () => {
    const attempts: Array<[string, Record<string, unknown>]> = [];
    const answers: PermissionAnswer[] = [];
    const script: SimScript = async (ctx) => {
      if (ctx.spec.role === 'lead' && ctx.spec.job.kind === 'plan') {
        await ctx.team('create_task', { title: 'manomissione', description: 'prova' });
        return 'ok';
      }
      if (ctx.spec.role === 'worker' && ctx.spec.job.kind === 'work') {
        for (const [tool, input] of attempts) answers.push(await ctx.permission(tool, input));
        await ctx.team('update_task', { task_id: ctx.spec.job.taskId, status: 'blocked', blocked_reason: 'fine prova' });
      }
      return 'ok';
    };
    const engines = new Map<EngineId, EngineAdapter>([['sim', new SimEngine({ stepDelayMs: 0, script })]]);
    const { o, cfg } = testOrchestrator({ workers: 1, engines });
    const repo = await demoRepo(cfg.home);
    await o.repos.add(repo, { confirmGuard: true });
    const guard = o.repos.guardFile;
    const guardBefore = fs.readFileSync(guard, 'utf8');
    const configBefore = fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');
    attempts.push(
      ['Write', { file_path: guard, content: '' }],
      ['Bash', { command: `echo x > "${guard.replace(/\\/g, '/')}"` }],
      ['Bash', { command: 'git config --local includeIf.gitdir/i:x.path y' }],
      ['Edit', { file_path: path.join(repo, '.git', 'config') }],
    );
    await o.start();
    await o.handle({ v: 1, type: 'goal.submit', text: 'prova' }, noReply);
    await waitFor(() => o.tasks.get('t1')?.status === 'blocked', 'fine del turno');
    expect(answers.map((a) => a.allow)).toEqual([false, false, false, false]);
    expect(o.decisions.list().filter((d) => d.kind === 'permission')).toHaveLength(0); // nessuna domanda: negato e basta
    expect(fs.readFileSync(guard, 'utf8')).toBe(guardBefore);
    expect(fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8')).toBe(configBefore);
  });

  it('se il guardiano viene rimosso, nessun worker lavora: il task si blocca con il motivo', async () => {
    const { o, cfg } = testOrchestrator({ workers: 1 });
    const repo = await demoRepo(cfg.home);
    await o.repos.add(repo, { confirmGuard: true });
    await o.start();
    await o.handle({ v: 1, type: 'goal.submit', text: 'Aggiungi un saluto' }, noReply);
    const m = await waitFor(() => o.decisions.open().find((d) => d.kind === 'merge'), 'decisione');
    const wtPath = o.repos.requireWorktree('repo', o.tasks.get('t1')!.worktree!).path;
    await removeGuard(repo);
    expect(await guardActive(wtPath)).toBe(false);
    // il worker dovrebbe riprendere il task per una modifica: senza guardiano non parte
    await o.handle({ v: 1, type: 'decision.answer', decisionId: m.id, option: 'Richiedi modifiche', text: 'una riga in più' }, noReply);
    await waitFor(() => o.tasks.get('t1')?.status === 'blocked', 't1 bloccato');
    expect(o.tasks.get('t1')?.blockedReason).toMatch(/guardiano git non attivo/);
    expect(await gitOut(wtPath, ['log', '-1', '--format=%s'])).not.toMatch(/revisione/);
  });

  it('senza guardiano installato non si crea nessun worktree', async () => {
    const { o, cfg } = testOrchestrator();
    const repo = await demoRepo(cfg.home);
    await o.repos.add(repo, { confirmGuard: true });
    await removeGuard(repo);
    await expect(o.repos.createWorktree('repo', 'bruno', { id: 't9', title: 'x' })).rejects.toMatchObject({ code: 'unsafe' });
  });
});

describe('conferma automatica solo per il repository di prova creato da Keystone', () => {
  it('isKeystoneDemo: serve il marcatore scritto alla creazione, nel percorso previsto', async () => {
    const dir = tmpDir();
    const demo = path.join(dir, 'home', 'demo-repo');
    await createDemoRepo(demo);
    expect(isKeystoneDemo(demo, demo)).toBe(true);
    // stesso repository ma percorso diverso da quello previsto
    expect(isKeystoneDemo(demo, path.join(dir, 'altrove'))).toBe(false);
    // un repository copiato altrove porta con sé il marcatore, ma il percorso non corrisponde
    const copy = path.join(dir, 'copia');
    fs.cpSync(demo, copy, { recursive: true });
    expect(isKeystoneDemo(copy, copy)).toBe(false);
    // un repository qualunque, senza marcatore
    const other = await demoRepo(dir);
    fs.rmSync(path.join(other, '.git', 'keystone-demo.json'), { force: true });
    expect(isKeystoneDemo(other, other)).toBe(false);
  });

  it('--demo con un repository non creato da Keystone nel percorso di prova: la conferma resta obbligatoria', async () => {
    const dir = tmpDir();
    const home = path.join(dir, 'home');
    const userRepo = path.join(home, 'demo-repo');
    fs.mkdirSync(userRepo, { recursive: true });
    await gitOut(userRepo, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(userRepo, 'mio.txt'), 'lavoro mio\n');
    await gitOut(userRepo, ['add', '-A']);
    await gitOut(userRepo, ['-c', 'user.name=U', '-c', 'user.email=u@u', 'commit', '-qm', 'mio']);
    const before = fs.readFileSync(path.join(userRepo, '.git', 'config'), 'utf8');
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'orchestrator/src/main.ts', '--demo', '--home', home, '--port', '0'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60_000, input: '' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/includeIf "gitdir\/i:/);
    expect(r.stderr).toMatch(/--confirm-guard/);
    expect(fs.readFileSync(path.join(userRepo, '.git', 'config'), 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(userRepo, 'mio.txt'), 'utf8')).toBe('lavoro mio\n'); // non toccato
  });

  it('--demo che crea il proprio repository di prova: conferma automatica (la riga viene comunque mostrata)', async () => {
    const home = path.join(tmpDir(), 'home');
    const child = spawn(process.execPath, ['--import', 'tsx', 'orchestrator/src/main.ts', '--demo', '--home', home, '--port', '0'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    onCleanup(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    const config = path.join(home, 'demo-repo', '.git', 'config');
    await waitFor(() => fs.existsSync(config) && /includeIf/.test(fs.readFileSync(config, 'utf8')) && /in ascolto/.test(out), 'guardiano installato nel repository di prova', 60_000);
    expect(out).toMatch(/includeIf "gitdir\/i:/);
  });
});
