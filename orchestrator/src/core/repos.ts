// Repository e worktree.
//
// Ogni task lavora in un proprio worktree su `Keystone/<agente>/<task>-<slug>`, sotto
// `<home>/worktrees/<repo>/<agente>-<task>`. Il checkout dell'utente non viene mai toccato da qui:
// si leggono solo il suo branch e se ha modifiche. Le operazioni che cambiano i worktree di un repo
// sono serializzate (una alla volta per repo).
//
// Fase 2: registrazione dei repo, creazione/rimozione dei worktree, diff, commit dei lavori
// lasciati a metà. Merge su approvazione, conflitti e blocco del push arrivano in Fase 3.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiffFile, Repo, Worktree } from '@keystone/shared';
import { ensureDir, samePath } from '../util/fsx.js';
import { git, gitOut, identityEnv } from '../util/git.js';
import { slugify } from '../util/text.js';
import type { Ctx } from './context.js';
import { parseUnifiedDiff } from './diff.js';

export const BRANCH_PREFIX = 'Keystone';

export class RepoError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'not_git' | 'not_root' | 'no_commits' | 'duplicate' | 'refused' | 'failed' = 'failed',
  ) {
    super(message);
    this.name = 'RepoError';
  }
}

export interface RepoManagerOptions {
  worktreesDir: string;
  /** tentativi di rimozione di una cartella occupata (Windows) */
  removeAttempts?: number;
  removeDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RepoManager {
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    private ctx: Ctx,
    private opts: RepoManagerOptions,
  ) {
    ensureDir(opts.worktreesDir);
  }

  private get repos(): Repo[] {
    return this.ctx.store.data.repos;
  }

  list(): readonly Repo[] {
    return this.repos;
  }

  get(id: string): Repo | undefined {
    return this.repos.find((r) => r.id === id);
  }

  require(id: string): Repo {
    const r = this.get(id);
    if (!r) throw new RepoError(`il repository ${id} non è registrato`, 'not_found');
    return r;
  }

  defaultRepo(): Repo | undefined {
    return this.repos[0];
  }

  findWorktree(repoId: string, id: string): Worktree | undefined {
    return this.get(repoId)?.worktrees.find((w) => w.id === id);
  }

  requireWorktree(repoId: string, id: string): Worktree {
    const w = this.findWorktree(repoId, id);
    if (!w) throw new RepoError(`il worktree ${id} non esiste in ${repoId}`, 'not_found');
    return w;
  }

  /** Esegue `fn` dopo le operazioni già in coda sullo stesso repo. */
  private serial<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(repoId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(
      repoId,
      next.catch(() => undefined),
    );
    return next;
  }

  /** Registra un repository. Il percorso deve essere la radice del repo, non una sottocartella. */
  async add(p: string): Promise<Repo> {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) throw new RepoError(`${abs} non esiste`, 'not_found');
    const top = await git(abs, ['rev-parse', '--show-toplevel'], { allowFail: true });
    if (top.code !== 0) throw new RepoError(`${abs} non è un repository git`, 'not_git');
    const root = path.resolve(top.stdout.trim());
    if (!samePath(fs.realpathSync(root), fs.realpathSync(abs))) {
      throw new RepoError(`${abs} è dentro il repository ${root}: registra la radice del repository`, 'not_root');
    }
    if ((await git(abs, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })).code !== 0) {
      throw new RepoError(`${abs} non ha ancora commit: crea almeno un commit`, 'no_commits');
    }
    const existing = this.repos.find((r) => samePath(r.path, abs));
    if (existing) return this.refresh(existing.id);
    let id = slugify(path.basename(abs), 40);
    for (let i = 2; this.get(id); i++) id = `${slugify(path.basename(abs), 36)}-${i}`;
    const repo: Repo = { id, name: path.basename(abs), path: abs, branch: await this.currentBranch(abs), dirty: false, ci: 'unknown', worktrees: [] };
    this.repos.push(repo);
    return this.refresh(id);
  }

  private async currentBranch(dir: string): Promise<string> {
    const r = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : 'HEAD';
  }

  /** Il checkout ha modifiche tracciate non committate? */
  async isDirty(dir: string): Promise<boolean> {
    return (await gitOut(dir, ['status', '--porcelain', '--untracked-files=no'])).length > 0;
  }

  /** Aggiorna branch, stato del checkout e statistiche dei worktree attivi. */
  async refresh(repoId: string): Promise<Repo> {
    const r = this.require(repoId);
    r.branch = await this.currentBranch(r.path);
    r.dirty = await this.isDirty(r.path);
    for (const w of r.worktrees) {
      if (w.status !== 'active' || !fs.existsSync(w.path)) continue;
      try {
        const files = await this.diffWorktree(w);
        w.files = files.length;
        w.additions = files.reduce((s, f) => s + f.additions, 0);
        w.deletions = files.reduce((s, f) => s + f.deletions, 0);
      } catch (e) {
        this.ctx.log.warn(`statistiche di ${w.id}: ${(e as Error).message}`);
      }
    }
    this.changed(r);
    return r;
  }

  branchName(agentId: string, taskId: string, title: string): string {
    return `${BRANCH_PREFIX}/${agentId}/${taskId}-${slugify(title, 30)}`;
  }

  /**
   * Crea il worktree di un task, a partire dal branch dell'utente (o da `startPoint`). Se il branch
   * esiste già (task ripreso), il worktree lo riusa.
   */
  createWorktree(repoId: string, agentId: string, task: { id: string; title: string }, startPoint?: string): Promise<Worktree> {
    return this.serial(repoId, async () => {
      const r = this.require(repoId);
      const id = `${agentId}-${task.id}`;
      const existing = r.worktrees.find((w) => w.id === id && w.status === 'active');
      if (existing && fs.existsSync(existing.path)) return existing;
      const base = await this.currentBranch(r.path);
      if (base === 'HEAD') throw new RepoError(`il checkout di ${r.name} non è su un branch (HEAD staccato)`, 'refused');
      const branch = this.branchName(agentId, task.id, task.title);
      const dir = path.join(this.opts.worktreesDir, r.id, id);
      if (fs.existsSync(dir)) {
        // residuo di un tentativo precedente: va tolto prima di ricrearlo
        await git(r.path, ['worktree', 'remove', '--force', dir], { allowFail: true });
        await this.removeDir(dir);
        await git(r.path, ['worktree', 'prune'], { allowFail: true });
      }
      ensureDir(path.dirname(dir));
      const exists = (await git(r.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).code === 0;
      const args = exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, startPoint ?? base];
      await git(r.path, args);
      const w: Worktree = { id, repoId: r.id, agentId, taskId: task.id, branch, base, path: dir, status: 'active', files: 0, additions: 0, deletions: 0 };
      r.worktrees = [...r.worktrees.filter((x) => x.id !== id), w];
      this.changed(r);
      return w;
    });
  }

  /**
   * Diff del worktree rispetto al punto in cui si è staccato dalla base, compresi i file non
   * committati e quelli nuovi. Usa un indice temporaneo: l'indice dell'agente non viene toccato.
   */
  private async diffWorktree(w: Worktree): Promise<DiffFile[]> {
    const fork = (await git(w.path, ['merge-base', w.base, 'HEAD'], { allowFail: true })).stdout.trim() || 'HEAD';
    const tmpIndex = path.join(os.tmpdir(), `keystone-index-${crypto.randomBytes(6).toString('hex')}`);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    try {
      await git(w.path, ['read-tree', 'HEAD'], { env });
      await git(w.path, ['add', '-A'], { env });
      const out = await gitOut(w.path, ['-c', 'core.quotePath=false', 'diff', '--cached', '--no-color', '--no-ext-diff', '-M', fork], { env });
      return parseUnifiedDiff(out);
    } finally {
      fs.rmSync(tmpIndex, { force: true });
    }
  }

  async diff(repoId: string, worktreeId: string): Promise<DiffFile[]> {
    const w = this.requireWorktree(repoId, worktreeId);
    if (w.status !== 'active' || !fs.existsSync(w.path)) {
      // worktree chiuso: diff tra la base e il branch conservato
      const r = this.require(repoId);
      const fork = (await git(r.path, ['merge-base', w.base, w.branch], { allowFail: true })).stdout.trim();
      if (!fork) return [];
      return parseUnifiedDiff(await gitOut(r.path, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', fork, w.branch]));
    }
    return this.diffWorktree(w);
  }

  /**
   * Committa sul branch del worktree il lavoro rimasto non committato (es. prima di abbandonarlo),
   * con l'identità indicata. Restituisce true se ha creato un commit.
   */
  async commitAll(repoId: string, worktreeId: string, message: string, identity: { name: string; email: string }): Promise<boolean> {
    const w = this.requireWorktree(repoId, worktreeId);
    if (!fs.existsSync(w.path)) return false;
    const status = await gitOut(w.path, ['status', '--porcelain']);
    if (!status) return false;
    const env = { ...process.env, ...identityEnv(identity.name, identity.email) };
    await git(w.path, ['add', '-A'], { env });
    await git(w.path, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', message], { env });
    return true;
  }

  /** Abbandona un worktree: salva il lavoro sul branch, rimuove la cartella, conserva il branch. */
  abandon(repoId: string, worktreeId: string, message: string, identity: { name: string; email: string }): Promise<void> {
    return this.serial(repoId, async () => {
      const r = this.require(repoId);
      const w = this.requireWorktree(repoId, worktreeId);
      if (w.status !== 'active') return;
      try {
        await this.commitAll(repoId, worktreeId, message, identity);
      } catch (e) {
        this.ctx.log.warn(`commit prima di abbandonare ${w.id}: ${(e as Error).message}`);
      }
      w.status = 'abandoned';
      await this.removeWorktree(r, w);
      this.changed(r);
    });
  }

  /** Rimuove la cartella di un worktree con retry (Windows) e poi `git worktree prune`. */
  async removeWorktree(r: Repo, w: Worktree): Promise<boolean> {
    await git(r.path, ['worktree', 'remove', '--force', w.path], { allowFail: true });
    const ok = await this.removeDir(w.path);
    await git(r.path, ['worktree', 'prune'], { allowFail: true });
    if (!ok) this.ctx.log.warn(`la cartella ${w.path} è ancora occupata: verrà rimossa più tardi`);
    return ok;
  }

  private async removeDir(dir: string): Promise<boolean> {
    const attempts = this.opts.removeAttempts ?? 6;
    for (let i = 0; i < attempts; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
        if (!fs.existsSync(dir)) return true;
      } catch {
        /* occupata: si riprova */
      }
      await sleep((this.opts.removeDelayMs ?? 250) * (i + 1));
    }
    return !fs.existsSync(dir);
  }

  private changed(r: Repo): void {
    this.ctx.store.markDirty();
    this.ctx.emit({ type: 'repo.upsert', repo: { ...r, worktrees: r.worktrees.map((w) => ({ ...w })) } });
  }
}
