// Repository, worktree, merge approvati, test.
//
// Ogni task lavora in un proprio worktree su `Keystone/<agente>/<task>-<slug>`, nella cartella
// `<home>/worktrees/<repo>/ks-<agente>-<task>`. Il checkout dell'utente viene toccato SOLO da un
// merge approvato. Le operazioni che cambiano worktree e branch di un repo sono serializzate.
//
// MERGE APPROVATO (merge()):
//   1. il lavoro rimasto non committato nel worktree viene committato sul branch dell'agente
//   2. controlli: il checkout che ha la base estratta non deve avere modifiche tracciate; il merge
//      non deve avere conflitti (`git merge-tree`)
//   3. il commit di merge viene costruito FUORI dal working tree (`merge-tree --write-tree` +
//      `commit-tree`), con l'identità dell'utente e firmato se la sua configurazione firma
//   4. applicazione:
//      - se la base è estratta in un checkout (di solito il tuo): controllo preliminare a secco
//        (`read-tree -n -m -u`: nessun file non tracciato verrebbe sovrascritto), poi
//        `git merge --ff-only <commit>`: il nuovo commit ha come primo genitore la tua HEAD, quindi
//        è un fast-forward: git aggiorna indice e file cambiati e poi sposta il branch. Alla fine
//        HEAD è il commit di merge e `git status` è pulito (verificato). Se qualcosa fallisce, il
//        checkout viene riportato esattamente al commit di partenza.
//      - se la base non è estratta da nessuna parte: `git update-ref <base> <nuovo> <vecchio>`,
//        che è atomico e fallisce se nel frattempo la base è cambiata.
//   5. il worktree viene chiuso e il branch dell'agente viene eliminato (core/branches.ts: solo se
//      punta ancora al commit unito), salvo keepMergedBranches.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DbConnection, Decision, DiffFile, Repo, VisualConfig, Worktree } from '@keystone/shared';
import { DB_LIMITS, MERGE_OPTIONS } from '@keystone/shared';
import { ensureDir, samePath } from '../util/fsx.js';
import { git, gitOut, identityEnv } from '../util/git.js';
import { deleteKeystoneBranch, listKeystoneBranches, type KeystoneBranch } from './branches.js';
import { runShell } from '../util/proc.js';
import { lastLines, slugify } from '../util/text.js';
import type { Ctx } from './context.js';
import { parseUnifiedDiff } from './diff.js';
import { validateConnection } from './db/manager.js';
import { validateVisualConfig } from './visual.js';
import { guardActive, guardInstalled, installGuard, previewGuard, writeGuardFile, WORKTREE_PREFIX, type GuardPreview } from './gitsafety.js';
import { withoutSecrets } from '../util/secrets.js';

export const BRANCH_PREFIX = 'Keystone';

export type RepoErrorCode = 'not_found' | 'not_git' | 'not_root' | 'no_commits' | 'needs_confirmation' | 'refused' | 'conflict' | 'dirty' | 'empty' | 'unsafe' | 'failed';

export class RepoError extends Error {
  constructor(
    message: string,
    readonly code: RepoErrorCode = 'failed',
    /** code "conflict": i file in conflitto */
    readonly files: string[] = [],
  ) {
    super(message);
    this.name = 'RepoError';
  }
}

export interface MergeResult {
  sha: string;
  base: string;
  branch: string;
  files: number;
  /** il branch dell'agente è stato eliminato dopo il merge */
  branchDeleted: boolean;
  /** perché il branch è rimasto (se è rimasto) */
  branchKeptReason?: string;
}

/** Un branch di un task finito (rifiutato, annullato o completato) che la pulizia può eliminare. */
export interface StaleBranch extends KeystoneBranch {
  repoId: string;
  repoPath: string;
  worktree: string;
  taskId?: string;
  why: string;
}

export interface TestResult {
  command: string;
  pass: boolean;
  code: number | null;
  timedOut: boolean;
  /** coda dell'output */
  output: string;
  durationMs: number;
}

export interface RepoManagerOptions {
  worktreesDir: string;
  /** file di regole incluso dal guardiano git (core/gitsafety.ts) */
  guardFile: string;
  /** firma i commit di merge se la configurazione git dell'utente firma (default true) */
  signMerges?: boolean;
  removeAttempts?: number;
  removeDelayMs?: number;
  /** conserva il branch dell'agente dopo un merge riuscito (default: eliminato) */
  keepMergedBranches?: boolean;
  /** solo test: punti in cui simulare un guasto durante il merge */
  faults?: { afterApply?: () => void | Promise<void>; beforeApply?: () => void | Promise<void> };
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

  /**
   * Anteprima della registrazione: verifica che sia la radice di un repository con almeno un
   * commit e mostra la riga che verrebbe aggiunta al suo .git/config (il guardiano git).
   */
  async preview(p: string): Promise<{ root: string } & GuardPreview> {
    const abs = await this.validateRoot(p);
    return { root: abs, ...(await previewGuard(abs, this.opts.guardFile)) };
  }

  /**
   * Registra un repository. Se il guardiano non è ancora installato serve `confirmGuard: true`,
   * cioè che l'utente abbia visto l'anteprima (preview) e confermato la modifica al .git/config.
   */
  async add(p: string, opts: { confirmGuard?: boolean } = {}): Promise<Repo> {
    const abs = await this.validateRoot(p);
    const pv = await previewGuard(abs, this.opts.guardFile);
    if (!pv.installed && !opts.confirmGuard) {
      throw new RepoError(`per registrare ${abs} va aggiunta a ${pv.configFile} questa riga (guardiano git di Keystone):\n${pv.lines.join('\n')}\nConferma la modifica per continuare.`, 'needs_confirmation');
    }
    await installGuard(abs, this.opts.guardFile);
    const existing = this.repos.find((r) => samePath(r.path, abs));
    if (existing) return this.refresh(existing.id);
    let id = slugify(path.basename(abs), 40);
    for (let i = 2; this.get(id); i++) id = `${slugify(path.basename(abs), 36)}-${i}`;
    const repo: Repo = { id, name: path.basename(abs), path: abs, branch: await this.currentBranch(abs), dirty: false, ci: 'unknown', worktrees: [] };
    this.repos.push(repo);
    this.ctx.log.info(`guardiano git installato in ${pv.configFile} (push bloccato nei worktree degli agenti)`);
    return this.refresh(id);
  }

  private async validateRoot(p: string): Promise<string> {
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
    return abs;
  }

  /** La cartella git comune del repository (dove stanno config, hook e i dati dei worktree). */
  async commonDir(repoId: string): Promise<string> {
    const r = this.require(repoId);
    return path.resolve(r.path, await gitOut(r.path, ['rev-parse', '--git-common-dir']));
  }

  get guardFile(): string {
    return this.opts.guardFile;
  }

  /**
   * Il branch di destinazione del repository: quello configurato o, se manca, il branch aperto nel
   * checkout ('HEAD' se staccato). Da qui partono i worktree e qui si fanno i merge.
   */
  async targetBranch(repoId: string): Promise<string> {
    const r = this.require(repoId);
    return r.mergeTarget ?? (await this.currentBranch(r.path));
  }

  /** Esegue `fn` in coda alle altre operazioni sullo stesso repository (merge, worktree). */
  withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    return this.serial(repoId, fn);
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
    r.branches = await this.localBranches(r.path);
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

  setCi(repoId: string, ci: Repo['ci']): void {
    const r = this.get(repoId);
    if (!r || r.ci === ci) return;
    r.ci = ci;
    this.changed(r);
  }

  branchName(agentId: string, taskId: string, title: string): string {
    return `${BRANCH_PREFIX}/${agentId}/${taskId}-${slugify(title, 30)}`;
  }

  /**
   * Crea il worktree di un task a partire dal branch dell'utente (o da `startPoint`). Se il branch
   * esiste già (task ripreso), il worktree lo riusa. Prima di consegnarlo verifica che il
   * guardiano git sia attivo: altrimenti si rifiuta (meglio fermi che senza protezione).
   */
  createWorktree(repoId: string, agentId: string, task: { id: string; title: string }, startPoint?: string): Promise<Worktree> {
    return this.serial(repoId, async () => {
      const r = this.require(repoId);
      const id = `${agentId}-${task.id}`;
      const existing = r.worktrees.find((w) => w.id === id && w.status === 'active');
      if (existing && fs.existsSync(existing.path)) return existing;
      // il worktree parte dal branch in cui verrà unito: quello configurato o il branch aperto
      const base = r.mergeTarget ?? (await this.currentBranch(r.path));
      if (base === 'HEAD') throw new RepoError(`il checkout di ${r.name} non è su un branch (HEAD staccato)`, 'refused');
      if (r.mergeTarget && !(await this.branchExists(r.path, r.mergeTarget))) {
        throw new RepoError(`il branch di destinazione ${r.mergeTarget} di ${r.name} non esiste più: sceglilo di nuovo nella pagina Repository`, 'refused');
      }
      // il guardiano si installa solo con la conferma dell'utente (add): qui si verifica soltanto
      writeGuardFile(this.opts.guardFile);
      if (!(await guardInstalled(r.path, this.opts.guardFile))) {
        throw new RepoError(`il guardiano git non è installato in ${r.name}: registra di nuovo il repository e conferma la modifica al .git/config`, 'unsafe');
      }
      const branch = this.branchName(agentId, task.id, task.title);
      const dir = path.join(this.opts.worktreesDir, r.id, `${WORKTREE_PREFIX}${id}`);
      if (fs.existsSync(dir)) {
        // residuo di un tentativo precedente: va tolto prima di ricrearlo
        await git(r.path, ['worktree', 'remove', '--force', dir], { allowFail: true });
        await this.removeDir(dir);
        await git(r.path, ['worktree', 'prune'], { allowFail: true });
      }
      ensureDir(path.dirname(dir));
      const exists = (await git(r.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).code === 0;
      await git(r.path, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, startPoint ?? base]);
      if (!(await guardActive(dir))) {
        await git(r.path, ['worktree', 'remove', '--force', dir], { allowFail: true });
        throw new RepoError(`il guardiano git non risulta attivo in ${dir}: worktree non consegnato all'agente`, 'unsafe');
      }
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
    const env = { ...withoutSecrets(process.env), GIT_INDEX_FILE: tmpIndex };
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
      // worktree chiuso: diff tra il punto di partenza e il lavoro dell'agente (il commit salvato al
      // merge, perché il branch può essere stato eliminato; altrimenti il branch conservato)
      const r = this.require(repoId);
      const meta = this.ctx.store.data.worktreeMeta?.[`${repoId}/${w.id}`];
      const tip = meta?.branchSha ?? w.branch;
      const fork = meta?.forkSha ?? (await git(r.path, ['merge-base', w.base, tip], { allowFail: true })).stdout.trim();
      if (!fork) return [];
      const d = await git(r.path, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', fork, tip], { allowFail: true });
      return d.code === 0 ? parseUnifiedDiff(d.stdout) : [];
    }
    return this.diffWorktree(w);
  }

  /** Il .git del worktree punta ancora a questo repository? (un agente potrebbe averlo riscritto) */
  private async worktreeIntact(r: Repo, w: Worktree): Promise<boolean> {
    const top = await git(w.path, ['rev-parse', '--show-toplevel', '--git-common-dir'], { allowFail: true });
    if (top.code !== 0) return false;
    const [toplevel, common] = top.stdout.trim().split('\n');
    const repoCommon = path.resolve(r.path, await gitOut(r.path, ['rev-parse', '--git-common-dir']));
    return !!toplevel && !!common && samePath(toplevel, w.path) && samePath(path.resolve(w.path, common), repoCommon);
  }

  /**
   * Committa sul branch del worktree il lavoro rimasto non committato, con l'identità indicata
   * (quella dell'agente). Restituisce true se ha creato un commit.
   */
  async commitAll(repoId: string, worktreeId: string, message: string, identity: { name: string; email: string }): Promise<boolean> {
    const r = this.require(repoId);
    const w = this.requireWorktree(repoId, worktreeId);
    if (!fs.existsSync(w.path)) return false;
    if (!(await this.worktreeIntact(r, w))) throw new RepoError(`il collegamento .git di ${w.id} non punta più a ${r.name}: non committo nulla`, 'unsafe');
    const branch = await this.currentBranch(w.path);
    if (branch !== w.branch) throw new RepoError(`${w.id} è su ${branch}, non sul branch dell'agente ${w.branch}`, 'unsafe');
    const status = await gitOut(w.path, ['status', '--porcelain']);
    if (!status) return false;
    const env = { ...withoutSecrets(process.env), ...identityEnv(identity.name, identity.email) };
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
        if (e instanceof RepoError && e.code === 'unsafe') return; // lasciato com'è, da controllare a mano
      }
      w.status = 'abandoned';
      await this.removeWorktree(r, w);
      this.changed(r);
    });
  }

  // ---- merge --------------------------------------------------------------------------------

  /** La cartella in cui `branch` è estratto (il checkout dell'utente o un altro worktree), se c'è. */
  async checkoutOf(r: Repo, branch: string): Promise<string | undefined> {
    const out = await gitOut(r.path, ['worktree', 'list', '--porcelain']);
    let current: string | undefined;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) current = line.slice(9).trim();
      else if (line.trim() === `branch refs/heads/${branch}` && current) return path.resolve(current);
    }
    return undefined;
  }

  /** Il merge si può fare? (senza cambiare nulla) */
  async canMerge(repoId: string, worktreeId: string): Promise<{ ok: true; tree: string } | { ok: false; error: RepoError }> {
    const r = this.require(repoId);
    const w = this.requireWorktree(repoId, worktreeId);
    if (w.status !== 'active') return { ok: false, error: new RepoError(`il worktree ${w.id} è ${w.status}`, 'refused') };
    const target = await this.checkoutOf(r, w.base);
    if (target && (await this.isDirty(target))) {
      return { ok: false, error: new RepoError(`il checkout ${target} (${w.base}) ha modifiche non committate: committale o mettile da parte, poi approva di nuovo`, 'dirty') };
    }
    const mt = await git(r.path, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `refs/heads/${w.base}`, `refs/heads/${w.branch}`], { allowFail: true });
    if (mt.code === 1) {
      const files = mt.stdout.trim().split('\n').slice(1).filter(Boolean);
      return { ok: false, error: new RepoError(`il merge andrebbe in conflitto in: ${files.join(', ') || '(file sconosciuti)'}`, 'conflict', files) };
    }
    if (mt.code !== 0) return { ok: false, error: new RepoError(`merge-tree non riuscito: ${mt.stderr.trim()}`, 'failed') };
    return { ok: true, tree: mt.stdout.split('\n')[0]!.trim() };
  }

  /**
   * Unisce il branch di un worktree nella sua base. SOLO con una decisione di merge risolta con
   * "Merge" che riguarda proprio questo worktree. Atomico: se fallisce, la base resta com'era.
   */
  merge(decision: Decision, opts: { commitMessage: string; agentIdentity: { name: string; email: string } }): Promise<MergeResult> {
    return this.serial(decision.repoId ?? '?', () => this.doMerge(decision, opts));
  }

  private async doMerge(d: Decision, opts: { commitMessage: string; agentIdentity: { name: string; email: string } }): Promise<MergeResult> {
    if (d.kind !== 'merge') throw new RepoError('serve una decisione di merge', 'refused');
    if (d.status !== 'answered' || d.answer?.option !== MERGE_OPTIONS[0]) throw new RepoError(`la decisione ${d.id} non approva il merge`, 'refused');
    if (!d.repoId || !d.worktree) throw new RepoError(`la decisione ${d.id} non indica repository e worktree`, 'refused');
    const r = this.require(d.repoId);
    const w = this.requireWorktree(r.id, d.worktree);
    if (w.status !== 'active') throw new RepoError(`il worktree ${w.id} è ${w.status}`, 'refused');

    // 1. il lavoro dell'agente è tutto committato sul suo branch
    await this.commitAll(r.id, w.id, opts.commitMessage, opts.agentIdentity);
    const baseSha = await gitOut(r.path, ['rev-parse', `refs/heads/${w.base}`]);
    const branchSha = await gitOut(r.path, ['rev-parse', `refs/heads/${w.branch}`]);
    if (Number(await gitOut(r.path, ['rev-list', '--count', `${baseSha}..${branchSha}`])) === 0) throw new RepoError(`${w.branch} non ha modifiche da unire`, 'empty');

    // 2. controlli: checkout pulito, nessun conflitto
    const check = await this.canMerge(r.id, w.id);
    if (!check.ok) throw check.error;

    // 3. commit di merge costruito fuori dal working tree, con l'identità dell'utente
    const sign = this.opts.signMerges !== false && (await git(r.path, ['config', '--type=bool', '--get', 'commit.gpgsign'], { allowFail: true })).stdout.trim() === 'true';
    const msg = `Merge ${w.branch} in ${w.base}\n\n${opts.commitMessage}\n\nApprovato in Keystone (decisione ${d.id}${w.taskId ? `, task ${w.taskId}` : ''}).`;
    const ct = await git(r.path, ['commit-tree', ...(sign ? ['-S'] : []), check.tree, '-p', baseSha, '-p', branchSha, '-m', msg], { allowFail: true, timeoutMs: 120_000 });
    if (ct.code !== 0) {
      const why = (ct.stderr || ct.stdout).trim().split('\n').slice(-2).join(' ');
      throw new RepoError(sign ? `la firma del commit di merge non è riuscita (commit.gpgsign=true): ${why}` : `impossibile creare il commit di merge: ${why}`, 'failed');
    }
    const mergeSha = ct.stdout.trim();

    // 4. applicazione atomica
    await this.opts.faults?.beforeApply?.();
    const target = await this.checkoutOf(r, w.base);
    if (target) await this.applyToCheckout(target, w.base, baseSha, mergeSha);
    else {
      const up = await git(r.path, ['update-ref', '-m', `keystone: merge ${w.branch}`, `refs/heads/${w.base}`, mergeSha, baseSha], { allowFail: true });
      if (up.code !== 0) throw new RepoError(`${w.base} è cambiato durante il merge: riprova (${up.stderr.trim()})`, 'refused');
      try {
        await this.opts.faults?.afterApply?.();
      } catch (e) {
        await git(r.path, ['update-ref', `refs/heads/${w.base}`, baseSha, mergeSha], { allowFail: true });
        throw new RepoError(`merge annullato: ${(e as Error).message}`, 'failed');
      }
    }

    // 5. chiusura: il worktree si chiude, il diff unito resta consultabile (dai commit salvati),
    // il branch dell'agente si elimina solo se punta ancora al commit unito
    const files = (await gitOut(r.path, ['diff', '--name-only', baseSha, mergeSha])).split('\n').filter(Boolean).length;
    const meta = (this.ctx.store.data.worktreeMeta ??= {});
    meta[`${r.id}/${w.id}`] = { forkSha: await gitOut(r.path, ['merge-base', baseSha, branchSha]), mergedSha: mergeSha, branchSha };
    w.status = 'merged';
    await this.removeWorktree(r, w);
    let branchDeleted = false;
    let branchKeptReason: string | undefined;
    if (this.opts.keepMergedBranches) branchKeptReason = 'conservato per configurazione (--keep-branches)';
    else {
      const del = await deleteKeystoneBranch(r.path, w.branch, branchSha);
      branchDeleted = del.ok;
      if (!del.ok) branchKeptReason = del.reason;
    }
    await this.refresh(r.id);
    return { sha: mergeSha.slice(0, 7), base: w.base, branch: w.branch, files, branchDeleted, ...(branchKeptReason ? { branchKeptReason } : {}) };
  }

  /**
   * Porta il checkout dell'utente da `baseSha` a `mergeSha` (fast-forward). Se un passo fallisce,
   * il checkout torna esattamente a `baseSha`.
   */
  private async applyToCheckout(target: string, base: string, baseSha: string, mergeSha: string): Promise<void> {
    const head = await gitOut(target, ['rev-parse', 'HEAD']);
    if (head !== baseSha) throw new RepoError(`${base} è cambiato durante il merge: riprova`, 'refused');
    // a secco: nessun file non tracciato verrebbe sovrascritto, l'indice è coerente
    const dry = await git(target, ['read-tree', '-n', '-m', '-u', baseSha, mergeSha], { allowFail: true });
    if (dry.code !== 0) throw new RepoError(`il merge toccherebbe file non tracciati o modificati in ${target}: ${lastLines(dry.stderr.trim(), 3)}`, 'dirty');
    try {
      const ff = await git(target, ['merge', '--ff-only', '-q', mergeSha], { allowFail: true });
      if (ff.code !== 0) throw new Error(lastLines((ff.stderr || ff.stdout).trim(), 3));
      await this.opts.faults?.afterApply?.();
      const now = await gitOut(target, ['rev-parse', 'HEAD']);
      if (now !== mergeSha) throw new Error(`HEAD è ${now.slice(0, 7)} invece di ${mergeSha.slice(0, 7)}`);
      if (await this.isDirty(target)) throw new Error('il working tree non è pulito dopo il merge');
    } catch (e) {
      await this.rollbackCheckout(target, base, baseSha, mergeSha);
      throw new RepoError(`merge non applicato, ${base} è rimasto com'era: ${(e as Error).message}`, 'failed');
    }
  }

  private async rollbackCheckout(target: string, base: string, baseSha: string, mergeSha: string): Promise<void> {
    // il checkout era pulito prima del merge (verificato): tornare a baseSha non perde lavoro
    await git(target, ['reset', '-q', '--hard', baseSha], { allowFail: true });
    const added = (await gitOut(target, ['diff', '--name-only', '--diff-filter=A', baseSha, mergeSha])).split('\n').filter(Boolean);
    for (const f of added) {
      const tracked = (await git(target, ['ls-files', '--error-unmatch', f], { allowFail: true })).code === 0;
      if (!tracked) fs.rmSync(path.join(target, f), { force: true });
    }
    const branchNow = await gitOut(target, ['rev-parse', `refs/heads/${base}`]);
    if (branchNow !== baseSha) await git(target, ['update-ref', `refs/heads/${base}`, baseSha], { allowFail: true });
    this.ctx.log.warn(`merge annullato: ${target} riportato a ${baseSha.slice(0, 7)}`);
  }

  // ---- pulizia ------------------------------------------------------------------------------

  /**
   * Rimuove i worktree orfani: cartelle in <home>/worktrees/<repo>/ che non corrispondono a un
   * worktree attivo, registrazioni di git senza cartella (`git worktree prune`), worktree attivi
   * la cui cartella non esiste più. Restituisce cosa ha fatto.
   */
  async pruneOrphans(): Promise<string[]> {
    const report: string[] = [];
    for (const r of this.repos) {
      await this.serial(r.id, async () => {
        const active = new Set(r.worktrees.filter((w) => w.status === 'active').map((w) => path.resolve(w.path).toLowerCase()));
        const dir = path.join(this.opts.worktreesDir, r.id);
        if (fs.existsSync(dir)) {
          for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name);
            if (active.has(path.resolve(p).toLowerCase())) continue;
            await git(r.path, ['worktree', 'remove', '--force', p], { allowFail: true });
            const ok = await this.removeDir(p);
            report.push(`${ok ? 'rimosso' : 'NON rimosso (occupato)'}: ${p}`);
          }
        }
        for (const w of r.worktrees) {
          if (w.status === 'active' && !fs.existsSync(w.path)) {
            w.status = 'abandoned';
            report.push(`worktree ${w.id} senza cartella: segnato come abbandonato`);
          }
        }
        const pr = await git(r.path, ['worktree', 'prune', '-v'], { allowFail: true });
        for (const line of (pr.stdout + pr.stderr).split('\n').filter(Boolean)) report.push(`git worktree prune (${r.name}): ${line.trim()}`);
        this.changed(r);
      });
    }
    return report;
  }

  /**
   * I branch che la pulizia può eliminare (dopo conferma): branch Keystone/* di un worktree chiuso
   * di questo profilo, il cui task è annullato/rifiutato, completato o sparito. Non compaiono: i
   * branch di task che possono ancora riprendere (todo, doing, review, blocked), quelli conservati
   * dopo un merge per scelta, e quelli che questo profilo non conosce (di un altro profilo o creati
   * a mano), che non vengono mai toccati.
   */
  async staleBranches(taskStatus: (taskId: string) => string | undefined): Promise<StaleBranch[]> {
    const out: StaleBranch[] = [];
    for (const r of this.list()) {
      const branches = new Map((await listKeystoneBranches(r.path)).map((b) => [b.name, b]));
      for (const w of r.worktrees) {
        if (w.status !== 'abandoned') continue;
        const b = branches.get(w.branch);
        if (!b) continue;
        // lo stesso branch è ancora usato da un worktree attivo (task ripreso): non è da pulire
        if (r.worktrees.some((x) => x.status === 'active' && x.branch === w.branch)) continue;
        const st = w.taskId ? taskStatus(w.taskId) : undefined;
        if (st !== undefined && st !== 'cancelled' && st !== 'done') continue;
        const why = st === 'cancelled' ? 'task rifiutato o annullato' : st === 'done' ? 'task completato senza merge' : 'task non più presente';
        out.push({ ...b, repoId: r.id, repoPath: r.path, worktree: w.id, ...(w.taskId ? { taskId: w.taskId } : {}), why });
        branches.delete(w.branch);
      }
    }
    return out;
  }

  /** Elimina i branch confermati dall'utente, ciascuno solo se punta ancora al commit mostrato. */
  deleteStaleBranches(list: StaleBranch[]): Promise<string[]> {
    const byRepo = new Map<string, StaleBranch[]>();
    for (const b of list) byRepo.set(b.repoId, [...(byRepo.get(b.repoId) ?? []), b]);
    return Promise.all(
      [...byRepo].map(([repoId, items]) =>
        this.serial(repoId, async () => {
          const report: string[] = [];
          for (const b of items) {
            const r = await deleteKeystoneBranch(b.repoPath, b.name, b.sha);
            report.push(r.ok ? `branch ${b.name} eliminato (${b.why})` : `branch ${b.name} conservato: ${r.reason}`);
          }
          return report;
        }),
      ),
    ).then((x) => x.flat());
  }

  /** I branch locali del repository, esclusi quelli degli agenti (al massimo 200). */
  private async localBranches(repoPath: string): Promise<string[]> {
    const out = await git(repoPath, ['for-each-ref', '--format=%(refname:short)', '--count=400', 'refs/heads/'], { allowFail: true });
    return out.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((b) => b && !b.startsWith(`${BRANCH_PREFIX}/`))
      .slice(0, 200);
  }

  private async branchExists(repoPath: string, branch: string): Promise<boolean> {
    return (await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).code === 0;
  }

  /**
   * Il branch in cui fare i merge del repository (null = il branch aperto nel tuo checkout). Deve
   * esistere e non può essere un branch degli agenti. Vale per i task che partono da ora: i
   * worktree già aperti restano sulla loro base.
   */
  setMergeTarget(repoId: string, target: string | null): Promise<Repo> {
    return this.serial(repoId, async () => {
      const r = this.require(repoId);
      if (target === null) delete r.mergeTarget;
      else {
        if (target.startsWith(`${BRANCH_PREFIX}/`) || target.toLowerCase().startsWith(`${BRANCH_PREFIX.toLowerCase()}/`)) throw new RepoError(`${target} è un branch degli agenti: non può essere la destinazione dei merge`, 'refused');
        const fmt = await git(r.path, ['check-ref-format', '--branch', target], { allowFail: true });
        if (fmt.code !== 0 || target.startsWith('-')) throw new RepoError(`nome di branch non valido: ${target}`, 'refused');
        if (!(await this.branchExists(r.path, target))) throw new RepoError(`il branch ${target} non esiste in ${r.name}`, 'refused');
        r.mergeTarget = target;
      }
      await this.refresh(r.id);
      this.changed(r);
      return r;
    });
  }

  /**
   * La verifica visuale del repository (null = disattivata). L'URL deve essere locale: l'app
   * avviata per la verifica non deve parlare con la rete esterna.
   */
  setVisual(repoId: string, cfg: VisualConfig | null): Repo {
    const r = this.require(repoId);
    if (cfg === null) delete r.visual;
    else {
      const clean: VisualConfig = { command: cfg.command.trim(), url: cfg.url.trim(), startTimeoutSec: cfg.startTimeoutSec, ...(cfg.agentScreenshots ? { agentScreenshots: true } : {}) };
      const bad = validateVisualConfig(clean);
      if (bad) throw new RepoError(bad, 'refused');
      r.visual = clean;
    }
    this.changed(r);
    return r;
  }

  /** Crea o sostituisce (stesso id) una connessione a database del repository (senza password). */
  setDbConnection(repoId: string, conn: DbConnection): Repo {
    const r = this.require(repoId);
    const list = r.db ?? [];
    const clean = validateConnection(conn, list, DB_LIMITS.perRepo);
    const i = list.findIndex((c) => c.id === clean.id);
    r.db = i < 0 ? [...list, clean] : list.map((c, k) => (k === i ? clean : c));
    this.changed(r);
    return r;
  }

  /** Toglie una connessione a database. */
  deleteDbConnection(repoId: string, connectionId: string): Repo {
    const r = this.require(repoId);
    if (!r.db?.some((c) => c.id === connectionId)) throw new RepoError(`nessuna connessione ${connectionId} in ${r.name}`, 'refused');
    r.db = r.db.filter((c) => c.id !== connectionId);
    if (!r.db.length) delete r.db;
    this.changed(r);
    return r;
  }

  /** Rimuove la cartella di un worktree con retry (Windows) e poi `git worktree prune`. */
  async removeWorktree(r: Repo, w: Worktree): Promise<boolean> {
    await git(r.path, ['worktree', 'remove', '--force', w.path], { allowFail: true });
    const ok = await this.removeDir(w.path);
    await git(r.path, ['worktree', 'prune'], { allowFail: true });
    if (!ok) this.ctx.log.warn(`la cartella ${w.path} è ancora occupata: verrà rimossa con la pulizia dei worktree orfani`);
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

  // ---- test del repository target -----------------------------------------------------------

  /** Il comando di test del repository, se riconoscibile. */
  detectTestCommand(dir: string): string | undefined {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const test = (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> }).scripts?.test;
        if (test && !/no test specified/.test(test)) return 'npm test';
      } catch {
        /* package.json non valido */
      }
    }
    if (fs.existsSync(path.join(dir, 'Cargo.toml'))) return 'cargo test';
    if (fs.existsSync(path.join(dir, 'go.mod'))) return 'go test ./...';
    if (['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'].some((f) => fs.existsSync(path.join(dir, f)))) return 'python -m pytest';
    return undefined;
  }

  /** Esegue i test nel worktree, con l'ambiente indicato (quello sicuro degli agenti). */
  async runTests(repoId: string, worktreeId: string, opts: { command?: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<TestResult | undefined> {
    const w = this.requireWorktree(repoId, worktreeId);
    const command = opts.command ?? this.detectTestCommand(w.path);
    if (!command) return undefined;
    const res = await runShell(command, { cwd: w.path, env: opts.env, timeoutMs: opts.timeoutMs });
    const output = lastLines(res.output.trim(), 40) + (res.timedOut ? `\n(tempo scaduto dopo ${Math.round(opts.timeoutMs / 1000)} s: processi terminati)` : '');
    return { command, pass: res.code === 0 && !res.timedOut, code: res.code, timedOut: res.timedOut, output, durationMs: res.durationMs };
  }

  private changed(r: Repo): void {
    this.ctx.store.markDirty();
    this.ctx.emit({ type: 'repo.upsert', repo: { ...r, worktrees: r.worktrees.map((w) => ({ ...w })) } });
  }
}
