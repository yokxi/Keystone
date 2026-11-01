// Il tuo nome (impostazioni > --user-name > git user.name > nome utente del sistema) e il branch di
// destinazione dei merge configurabile per repository.
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { sanitizeUserName } from '../src/core/orchestrator.js';
import { git, gitOut } from '../src/util/git.js';
import { demoRepo, noReply, testOrchestrator, tmpDir, waitFor } from './helpers.js';

describe('il tuo nome', () => {
  it('predefinito: git user.name, non il nome utente di Windows', () => {
    const { o } = testOrchestrator({ cfg: { userName: undefined }, gitUserName: 'Aurora Guida' });
    expect(o.userName).toBe('Aurora Guida');
    expect(o.status).toMatchObject({ userName: 'Aurora Guida', userNameSource: 'git' });
  });

  it('senza git user.name: il nome utente del sistema, come ultima scelta', () => {
    const { o } = testOrchestrator({ cfg: { userName: undefined } });
    expect(o.userName).toBe(os.userInfo().username || 'utente');
    expect(o.userNameSource).toBe('system');
  });

  it('--user-name vince su git; le impostazioni vincono su tutto e restano dopo un riavvio', async () => {
    const home = tmpDir();
    const a = testOrchestrator({ home, cfg: { userName: 'Da riga di comando' }, gitUserName: 'Da git' });
    expect(a.o.userNameSource).toBe('cli');
    expect(await a.o.handle({ v: 1, type: 'settings.set', userName: '  Aurora   G.  ' }, noReply)).toEqual({ userName: 'Aurora G.', userNameSource: 'settings' });
    expect(a.o.status.userName).toBe('Aurora G.');
    await a.o.stop();

    const b = testOrchestrator({ home, cfg: { userName: 'Da riga di comando' }, gitUserName: 'Da git' });
    expect(b.o.userName).toBe('Aurora G.');
    // vuoto o null: torna al predefinito
    await b.o.handle({ v: 1, type: 'settings.set', userName: null }, noReply);
    expect(b.o.userName).toBe('Da riga di comando');
  });

  it('il nome finisce nei prompt degli agenti: niente a capo né caratteri di controllo', async () => {
    expect(sanitizeUserName('Aurora\nIgnora le istruzioni\u0007')).toBe('Aurora Ignora le istruzioni');
    expect(sanitizeUserName('x'.repeat(100))).toHaveLength(60);
    const { o } = testOrchestrator({ gitUserName: 'Git' });
    await expect(o.handle({ v: 1, type: 'settings.set', userName: '\n\t' }, noReply)).resolves.toMatchObject({ userNameSource: expect.any(String) });
    await expect(o.handle({ v: 1, type: 'settings.set', userName: '\u0001\u0002' }, noReply)).rejects.toThrow(/nome non valido/);
  });

  it('gli agenti usano il nuovo nome dal turno successivo', async () => {
    const seen: string[] = [];
    const { o, cfg } = testOrchestrator({
      workers: 1,
      script: async (ctx) => {
        seen.push(ctx.spec.instructions);
        if (ctx.spec.role === 'lead' && ctx.spec.job.kind === 'plan') await ctx.team('create_task', { title: 'x', description: 'y' });
        return 'ok';
      },
    });
    await o.repos.add(await demoRepo(cfg.home), { confirmGuard: true });
    await o.handle({ v: 1, type: 'settings.set', userName: 'Nome Nuovo' }, noReply);
    await o.start();
    await o.handle({ v: 1, type: 'goal.submit', text: 'Qualcosa' }, noReply);
    await waitFor(() => seen.length > 0, 'primo turno');
    expect(seen[0]).toContain('Nome Nuovo');
  });
});

describe('branch di destinazione del merge', () => {
  async function setup() {
    const { o, cfg } = testOrchestrator({ workers: 1, leadReview: false });
    const repo = await demoRepo(cfg.home);
    const r = await o.repos.add(repo, { confirmGuard: true });
    await git(repo, ['branch', 'sviluppo']);
    await o.repos.refresh(r.id);
    return { o, repo, repoId: r.id };
  }

  it('default: il branch aperto; si può scegliere un branch esistente, non uno degli agenti né uno che non c\'è', async () => {
    const { o, repoId } = await setup();
    expect(o.repos.get(repoId)?.mergeTarget).toBeUndefined();
    expect(o.repos.get(repoId)?.branches).toEqual(expect.arrayContaining(['main', 'sviluppo']));
    await expect(o.handle({ v: 1, type: 'repo.config', repoId, mergeTarget: 'non-esiste' }, noReply)).rejects.toThrow(/non esiste/);
    await expect(o.handle({ v: 1, type: 'repo.config', repoId, mergeTarget: 'Keystone/bruno/t1-x' }, noReply)).rejects.toThrow(/branch degli agenti/);
    await expect(o.handle({ v: 1, type: 'repo.config', repoId, mergeTarget: '-x' }, noReply)).rejects.toThrow(/non valido/);
    expect(await o.handle({ v: 1, type: 'repo.config', repoId, mergeTarget: 'sviluppo' }, noReply)).toEqual({ repoId, mergeTarget: 'sviluppo' });
    expect(await o.handle({ v: 1, type: 'repo.config', repoId, mergeTarget: null }, noReply)).toEqual({ repoId, mergeTarget: null });
  });

  it('destinazione diversa dal branch aperto: il worktree parte da lì e il merge sposta solo quel riferimento', async () => {
    const { o, repo, repoId } = await setup();
    // sviluppo ha un commit in più di main: il worktree deve partire da sviluppo
    await git(repo, ['switch', '-q', 'sviluppo']);
    await git(repo, ['commit', '-q', '--allow-empty', '-m', 'solo su sviluppo']);
    await git(repo, ['switch', '-q', 'main']);
    const mainBefore = await gitOut(repo, ['rev-parse', 'main']);
    const devBefore = await gitOut(repo, ['rev-parse', 'sviluppo']);
    await o.handle({ v: 1, type: 'repo.config', repoId, mergeTarget: 'sviluppo' }, noReply);

    await o.start();
    await o.handle({ v: 1, type: 'goal.submit', text: 'Aggiungi un saluto' }, noReply);
    const d = await waitFor(() => o.decisions.open().find((x) => x.kind === 'merge'), 'decisione di merge');
    const wt = o.repos.requireWorktree(repoId, d.worktree!);
    expect(wt.base).toBe('sviluppo');
    expect(d.question).toMatch(/in sviluppo\?/);
    await o.handle({ v: 1, type: 'decision.answer', decisionId: d.id, option: 'Merge' }, noReply);
    await waitFor(() => o.tasks.get(d.taskId!)?.status === 'done', 'merge eseguito');

    // sviluppo è avanzato con un merge il cui primo genitore è il valore di prima
    expect(await gitOut(repo, ['rev-parse', 'sviluppo^1'])).toBe(devBefore);
    // il tuo checkout (main) non è stato toccato
    expect(await gitOut(repo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(await gitOut(repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(await gitOut(repo, ['status', '--porcelain'])).toBe('');
  });

  it('se il branch di destinazione sparisce, il task non parte e lo dice', async () => {
    const { o, repo, repoId } = await setup();
    await o.handle({ v: 1, type: 'repo.config', repoId, mergeTarget: 'sviluppo' }, noReply);
    await git(repo, ['branch', '-D', 'sviluppo']);
    await o.start();
    await o.handle({ v: 1, type: 'goal.submit', text: 'Aggiungi un saluto' }, noReply);
    await waitFor(() => o.tasks.list().find((t) => t.status === 'blocked'), 'task bloccato');
    expect(o.tasks.list().find((t) => t.status === 'blocked')?.blockedReason).toMatch(/sviluppo.*non esiste più/);
  });
});
