// L'orchestratore: possiede tutto lo stato, compone i sottosistemi, applica gli intenti
// dell'utente e offre al team le primitive per far lavorare gli agenti. Non dipende dal
// trasporto: il server WebSocket gli passa i messaggi del client e si iscrive a quelli in uscita.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MERGE_OPTIONS, type Worktree, type Agent, type ClientMessage, type Decision, type Goal, type LogKind, type NotifyLevel, type OrchestratorStatus, type Outbound, type Skill, type Task, type VisualReport } from '@keystone/shared';
import { readGitUserName } from '../util/git.js';
import { truncate } from '../util/text.js';
import { MessageBus } from './bus.js';
import { consoleLogger, type Ctx, type Logger } from './context.js';
import { DecisionError, DecisionQueue, type NewDecision } from './decisions.js';
import { Memory, MemoryError } from './memory.js';
import { isGoalBranch, RepoError, RepoManager, type RepoManagerOptions } from './repos.js';
import { SkillError, SkillManager } from './skills.js';
import { DbManager } from './db/manager.js';
import { DbError } from './db/types.js';
import { Store } from './store.js';
import { TaskError, TaskGraph } from './taskgraph.js';
import { visualSummary } from './prompts.js';
import { Team, type TeamMember, type TeamOptions } from './team.js';
import { cleanupVisualLeftovers, findBrowser, installChromium, runTry, runVisual, shotFile, type BrowserChoice, type VisualRunInput, type VisualTryInput, type VisualTryResult } from './visual.js';

export const VERSION = '0.1.0';

/** Errore dovuto alla richiesta del client (mostrato all'utente). */
export class ClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientError';
  }
}


export interface OrchestratorOptions {
  /** cartella dello stato (profilo) */
  dataDir: string;
  members: TeamMember[];
  team: TeamOptions;
  /** nome da riga di comando (--user-name); le impostazioni hanno la precedenza */
  userName?: string;
  /** legge git user.name (sostituibile nei test) */
  resolveGitUserName?: () => string | undefined;
  logger?: Logger;
  now?: () => number;
  /** solo test: guasti simulati durante il merge */
  repoFaults?: RepoManagerOptions['faults'];
  /** conserva il branch dell'agente dopo un merge riuscito */
  keepMergedBranches?: boolean;
  /** una decisione di merge per task invece di una per obiettivo (Fase 11) */
  mergePerTask?: boolean;
  /** limiti predefiniti per obiettivo in turni e minuti di lavoro (0 o assente = nessun limite) */
  defaultGoalLimits?: { turns?: number; minutes?: number };
  /** file di regole del guardiano git (default: <home>/git/agent-guard.gitconfig) */
  guardFile?: string;
  /** tetto di spesa predefinito per obiettivo in dollari (0 o assente = nessun tetto) */
  defaultBudgetUsd?: number;
  storeDebounceMs?: number;
  /** solo test: verifica visuale simulata */
  visual?: Partial<VisualDeps>;
  /** cartella delle skill personali (default: ~/.keystone/skills, accanto ai profili) */
  personalSkillsDir?: string;
  /** file di configurazione (config.json): percorsi protetti per gli agenti */
  configFiles?: string[];
}

type Listener = (msg: Outbound) => void;

/** Le parti della verifica visuale che i test possono sostituire (browser, download, esecuzione). */
export interface VisualDeps {
  findBrowser(): BrowserChoice | undefined;
  /** scarica Chromium in ~/.keystone/browsers: SOLO dopo il permesso dell'utente */
  installBrowser(): Promise<{ ok: boolean; output: string }>;
  run(input: VisualRunInput): Promise<VisualReport>;
  /** prova interfaccia del worker: solo il suo worktree */
  tryRun(input: VisualTryInput): Promise<VisualTryResult>;
}

/**
 * Un nome accettabile per l'utente: senza caratteri di controllo né a capo (finisce nei prompt),
 * spazi compattati, al massimo 60 caratteri. Stringa vuota se non resta niente.
 */
export function sanitizeUserName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
}

/** subscription se almeno un agente usa un abbonamento (la spesa è allora una stima), api se tutti pagano a consumo. */
function billingOf(members: Array<{ engine: { billing?: 'api' | 'subscription' | 'estimate'; reportsCost?: boolean } }>): { billing?: 'api' | 'subscription' | 'estimate'; costIncomplete?: true } {
  const incomplete = members.some((m) => m.engine.reportsCost === false) ? { costIncomplete: true as const } : {};
  if (members.some((m) => m.engine.billing === 'subscription')) return { billing: 'subscription', ...incomplete };
  if (members.some((m) => m.engine.billing === 'estimate')) return { billing: 'estimate', ...incomplete };
  if (members.some((m) => m.engine.billing === 'api')) return { billing: 'api', ...incomplete };
  return incomplete;
}

export class Orchestrator {
  readonly store: Store;
  readonly tasks: TaskGraph;
  readonly decisions: DecisionQueue;
  readonly bus: MessageBus;
  readonly memory: Memory;
  readonly repos: RepoManager;
  readonly team: Team;
  readonly log: Logger;
  private readonly cliUserName: string | undefined;
  private readonly gitUserName: string | undefined;
  readonly now: () => number;
  readonly defaultBudgetUsd: number | undefined;
  readonly defaultGoalLimits: { turns?: number; minutes?: number };
  /** merge per obiettivo (default) o per task */
  readonly mergePerTask: boolean;
  status: OrchestratorStatus;
  readonly visual: VisualDeps;
  readonly skills: SkillManager;
  /** accesso al database in sola lettura (password solo in memoria) */
  readonly db: DbManager;
  /** file di configurazione: gli agenti non possono modificarli */
  readonly configFiles: readonly string[];
  /** l'ultimo elenco delle skill mandato all'interfaccia */
  private skillList: Skill[] = [];
  private skillRefresh: Promise<void> | undefined;
  private skillRefreshAgain = false;
  private readonly dataDir: string;
  /** una sola app avviata per volta per repository: la porta dell'URL è una */
  private visualLocks = new Map<string, Promise<unknown>>();
  private listeners = new Set<Listener>();

  constructor(opts: OrchestratorOptions) {
    this.log = opts.logger ?? consoleLogger();
    this.now = opts.now ?? Date.now;
    this.defaultBudgetUsd = opts.defaultBudgetUsd && opts.defaultBudgetUsd > 0 ? opts.defaultBudgetUsd : undefined;
    this.mergePerTask = !!opts.mergePerTask;
    this.defaultGoalLimits = {
      ...(opts.defaultGoalLimits?.turns && opts.defaultGoalLimits.turns > 0 ? { turns: Math.floor(opts.defaultGoalLimits.turns) } : {}),
      ...(opts.defaultGoalLimits?.minutes && opts.defaultGoalLimits.minutes > 0 ? { minutes: opts.defaultGoalLimits.minutes } : {}),
    };
    this.dataDir = path.resolve(opts.dataDir);
    const browsersDir = this.browsersDir;
    this.visual = {
      findBrowser: () => findBrowser(browsersDir),
      installBrowser: () => installChromium(browsersDir),
      run: runVisual,
      tryRun: runTry,
      ...opts.visual,
    };
    this.cliUserName = opts.userName ? sanitizeUserName(opts.userName) : undefined;
    this.gitUserName = sanitizeUserName((opts.resolveGitUserName ?? readGitUserName)() ?? '');
    this.store = new Store(opts.dataDir, { now: this.now, onWarn: (m) => this.log.warn(m), ...(opts.storeDebounceMs !== undefined ? { debounceMs: opts.storeDebounceMs } : {}) });
    const ctx: Ctx = { store: this.store, now: this.now, emit: (m) => this.emit(m), log: this.log };
    this.tasks = new TaskGraph(ctx);
    this.decisions = new DecisionQueue(ctx);
    this.bus = new MessageBus(ctx);
    this.memory = new Memory(ctx, path.join(opts.dataDir, 'memory'));
    this.repos = new RepoManager(ctx, {
      worktreesDir: path.join(opts.dataDir, 'worktrees'),
      // fuori da repository e worktree: ~/.keystone/git/ (percorso protetto dalla policy)
      guardFile: opts.guardFile ?? path.join(path.dirname(path.resolve(opts.dataDir)), 'git', 'agent-guard.gitconfig'),
      ...(opts.repoFaults ? { faults: opts.repoFaults } : {}),
      ...(opts.keepMergedBranches ? { keepMergedBranches: true } : {}),
    });
    // config.json nella radice dello stato è sempre protetto, anche se non esiste ancora
    this.configFiles = [...new Set([...(opts.configFiles ?? []), path.join(path.dirname(this.dataDir), 'config.json')].map((f) => path.resolve(f)))];
    this.db = new DbManager({ repos: () => this.repos.list(), logFile: path.join(this.dataDir, 'db-queries.jsonl'), now: this.now });
    this.skills = new SkillManager({
      personalDir: opts.personalSkillsDir ?? path.join(path.dirname(this.dataDir), 'skills'),
      repos: () => this.repos.list(),
      targetBranch: (id) => this.repos.targetBranch(id),
      withRepoLock: (id, fn) => this.repos.withRepoLock(id, fn),
      overrides: () => this.store.data.settings.skillOverrides ?? {},
      setOverride: (key, enabled) => {
        const o = { ...(this.store.data.settings.skillOverrides ?? {}) };
        if (enabled === null) delete o[key];
        else o[key] = enabled;
        if (Object.keys(o).length) this.store.data.settings.skillOverrides = o;
        else delete this.store.data.settings.skillOverrides;
        this.store.markDirty();
      },
      approvedPersonal: () => this.store.data.settings.personalSkillHashes ?? {},
      setApprovedPersonal: (id, hash) => {
        const h = { ...(this.store.data.settings.personalSkillHashes ?? {}) };
        if (hash === null) delete h[id];
        else h[id] = hash;
        if (Object.keys(h).length) this.store.data.settings.personalSkillHashes = h;
        else delete this.store.data.settings.personalSkillHashes;
        this.store.markDirty();
      },
      userName: () => this.userName,
    });
    const costUsd = this.store.data.agents.reduce((s, a) => s + a.costUsd, 0);
    const tokens = this.store.data.agents.reduce((s, a) => s + a.tokens, 0);
    this.status = { version: VERSION, auth: 'unknown', message: 'avvio…', costUsd, tokens, userName: this.userName, userNameSource: this.userNameSource, profile: path.basename(path.resolve(opts.dataDir)), ...billingOf(opts.members) };
    this.team = new Team(this, opts.members, opts.team);
  }

  /** Le schermate della verifica visuale di un task: ~/.keystone/<profilo>/visual/<task>. */
  visualShotsDir(taskId: string): string {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId)) throw new Error(`id di task non valido: ${taskId}`);
    return path.join(this.dataDir, 'visual', taskId);
  }

  /** Le schermate delle prove del worker (try_ui): ~/.keystone/<profilo>/visual/<task>-try. */
  visualTryDir(taskId: string): string {
    return `${this.visualShotsDir(taskId)}-try`;
  }

  /**
   * Esegue `fn` quando nessun'altra verifica o prova dello stesso repository è in corso: usano tutte
   * la stessa porta, e due app avviate insieme si scambierebbero le schermate.
   */
  withVisualLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.visualLocks.get(repoId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.visualLocks.set(repoId, tail);
    void tail.then(() => {
      if (this.visualLocks.get(repoId) === tail) this.visualLocks.delete(repoId);
    });
    return run;
  }

  /** Il Chromium scaricato con il permesso dell'utente, condiviso tra i profili: ~/.keystone/browsers. */
  get browsersDir(): string {
    return path.join(path.dirname(this.dataDir), 'browsers');
  }

  get leadId(): string {
    return this.team.lead.id;
  }

  // ---- ciclo di vita ------------------------------------------------------------------------

  async start(): Promise<void> {
    // cartelle di worktree rimaste occupate o orfane da un'esecuzione precedente
    await this.repos.pruneOrphans().then(
      (r) => r.forEach((line) => this.log.info(`pulizia worktree: ${line}`)),
      (e: Error) => this.log.warn(`pulizia dei worktree all'avvio: ${e.message}`),
    );
    // verifica visuale interrotta: collegamenti a node_modules e worktree temporanei rimasti
    await cleanupVisualLeftovers(path.join(this.dataDir, 'visual'), this.repos.list()).then(
      (r) => r.forEach((line) => this.log.info(`pulizia della verifica visuale: ${line}`)),
      (e: Error) => this.log.warn(`pulizia della verifica visuale all'avvio: ${e.message}`),
    );
    // una verifica rimasta "in corso" non riparte da sola: la review la rifà
    for (const t of this.tasks.list()) if (t.visual?.status === 'running') this.tasks.update(t.id, { visual: null });
    await this.refreshSkills();
    await this.team.start();
  }

  async stop(): Promise<void> {
    await this.team.stop();
    this.store.close();
  }

  // ---- uscita verso l'interfaccia -----------------------------------------------------------

  onOutbound(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(msg: Outbound): void {
    if (msg.type === 'task.upsert' && msg.task.goalId) this.refreshGoal(msg.task.goalId);
    for (const l of this.listeners) {
      try {
        l(msg);
      } catch (e) {
        this.log.error(`listener: ${(e as Error).message}`);
      }
    }
  }

  snapshot(): Extract<Outbound, { type: 'snapshot' }> {
    const d = this.store.data;
    const logs: Record<string, ReturnType<Store['logTail']>> = {};
    for (const a of d.agents) logs[a.id] = this.store.logTail(a.id).slice(-60);
    return {
      type: 'snapshot',
      status: { ...this.status },
      agents: d.agents.map((a) => ({ ...a })),
      tasks: d.tasks.map((t) => ({ ...t, deps: [...t.deps] })),
      goals: d.goals.map((g) => ({ ...g })),
      decisions: d.decisions.map((x) => ({ ...x })),
      repos: d.repos.map((r) => ({ ...r, worktrees: r.worktrees.map((w) => ({ ...w })) })),
      memory: this.memory.list(),
      feed: d.feed.slice(-200),
      skills: this.skillList.map((x) => ({ ...x })),
      logs,
    };
  }

  /**
   * Rilegge le skill e manda l'elenco all'interfaccia. Le chiamate che arrivano mentre una lettura
   * è in corso ne fanno partire un'altra alla fine (l'ultima vede sempre lo stato più recente).
   */
  refreshSkills(): Promise<void> {
    if (this.skillRefresh) {
      this.skillRefreshAgain = true;
      return this.skillRefresh;
    }
    const run = async () => {
      do {
        this.skillRefreshAgain = false;
        try {
          this.skillList = await this.skills.list();
          this.emit({ type: 'skills', skills: this.skillList.map((x) => ({ ...x })) });
        } catch (e) {
          this.log.warn(`lettura delle skill: ${(e as Error).message}`);
        }
      } while (this.skillRefreshAgain);
    };
    this.skillRefresh = run().finally(() => (this.skillRefresh = undefined));
    return this.skillRefresh;
  }

  notify(level: NotifyLevel, text: string): void {
    this.emit({ type: 'notify', level, text });
  }

  setStatus(patch: Partial<OrchestratorStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit({ type: 'status', status: { ...this.status } });
  }

  // ---- agenti -------------------------------------------------------------------------------

  agents(): readonly Agent[] {
    return this.store.data.agents;
  }

  agent(id: string): Agent | undefined {
    return this.store.data.agents.find((a) => a.id === id);
  }

  /** Crea l'agente se manca, altrimenti aggiorna nome/ruolo/motore/modello dalla configurazione. */
  ensureAgent(a: Pick<Agent, 'id' | 'name' | 'role' | 'engine' | 'model'>): Agent {
    const existing = this.agent(a.id);
    if (existing) return this.setAgent(a.id, { name: a.name, role: a.role, engine: a.engine, model: a.model });
    const agent: Agent = { ...a, state: 'idle', activity: 'pronto', paused: false, active: true, costUsd: 0, tokens: 0 };
    this.store.data.agents.push(agent);
    this.store.markDirty();
    this.emit({ type: 'agent.upsert', agent: { ...agent } });
    return agent;
  }

  /** Aggiorna un agente. Una chiave presente con valore undefined viene rimossa. */
  setAgent(id: string, patch: Partial<Agent>): Agent {
    const a = this.agent(id);
    if (!a) throw new ClientError(`nessun agente ${id}`);
    let changed = false;
    for (const [k, v] of Object.entries(patch) as Array<[keyof Agent, unknown]>) {
      if (v === undefined) {
        if (k in a) {
          delete (a as Partial<Agent>)[k];
          changed = true;
        }
      } else if ((a as Record<string, unknown>)[k] !== v) {
        (a as Record<string, unknown>)[k] = v;
        changed = true;
      }
    }
    if (changed) {
      this.store.markDirty();
      this.emit({ type: 'agent.upsert', agent: { ...a } });
    }
    return a;
  }

  agentLog(agentId: string, kind: LogKind, text: string): void {
    const entry = { ts: this.now(), kind, text: truncate(text, 20_000) };
    this.store.appendLog(agentId, [entry]);
    this.emit({ type: 'agent.log', agentId, entries: [entry] });
  }

  /**
   * Somma la spesa all'obiettivo. Restituisce true se il tetto è stato raggiunto con questa spesa
   * (il team allora ferma gli agenti dell'obiettivo).
   */
  /** Il tuo nome: impostazioni, poi --user-name, poi git user.name, poi il nome utente del sistema. */
  get userName(): string {
    return this.store.data.settings.userName || this.cliUserName || this.gitUserName || os.userInfo().username || 'utente';
  }

  get userNameSource(): 'settings' | 'cli' | 'git' | 'system' {
    return this.store.data.settings.userName ? 'settings' : this.cliUserName ? 'cli' : this.gitUserName ? 'git' : 'system';
  }

  /** Cambia il tuo nome (vuoto: torna al predefinito). Vale dai prossimi turni degli agenti. */
  setUserName(raw: string | null): string {
    const name = raw === null ? '' : sanitizeUserName(raw);
    if (raw !== null && raw.trim() && !name) throw new ClientError('nome non valido');
    if (name) this.store.data.settings.userName = name;
    else delete this.store.data.settings.userName;
    this.store.markDirty();
    this.setStatus({ userName: this.userName, userNameSource: this.userNameSource });
    this.bus.feed('system', `Il tuo nome per gli agenti ora è "${this.userName}"${name ? '' : ' (predefinito)'}`);
    return this.userName;
  }

  addGoalCost(goalId: string, costUsd: number): boolean {
    const g = this.goal(goalId);
    if (!g || costUsd <= 0) return false;
    g.costUsd = Math.round((g.costUsd + costUsd) * 1e6) / 1e6;
    this.store.markDirty();
    this.emit({ type: 'goal.upsert', goal: { ...g } });
    return g.budgetUsd !== undefined && g.costUsd >= g.budgetUsd;
  }

  /** Parte della spesa dell'obiettivo contata per prudenza (sessioni riprese non riconciliate). */
  addGoalUnreconciled(goalId: string, usd: number): void {
    const g = this.goal(goalId);
    if (!g || usd <= 0) return;
    g.costUnreconciledUsd = Math.round(((g.costUnreconciledUsd ?? 0) + usd) * 1e6) / 1e6;
    this.store.markDirty();
    this.emit({ type: 'goal.upsert', goal: { ...g } });
  }

  /** Spesa ancora disponibile per l'obiettivo (undefined = nessun tetto). */
  remainingBudget(goalId: string | undefined): number | undefined {
    const g = goalId ? this.goal(goalId) : undefined;
    if (!g || g.budgetUsd === undefined) return undefined;
    return Math.max(0, g.budgetUsd - g.costUsd);
  }

  addUsage(agentId: string, tokens: number, costUsd: number): void {
    const a = this.agent(agentId);
    if (!a) return;
    this.setAgent(agentId, { tokens: a.tokens + tokens, costUsd: Math.round((a.costUsd + costUsd) * 1e6) / 1e6 });
    this.setStatus({ tokens: this.status.tokens + tokens, costUsd: Math.round((this.status.costUsd + costUsd) * 1e6) / 1e6 });
  }

  nameOf(id: string): string {
    if (id === 'user') return this.userName;
    return this.agent(id)?.name ?? id;
  }

  /** Id di un agente a partire da id o nome (senza distinzione di maiuscole, "@" opzionale). */
  resolveAgentId(nameOrId: string): string | undefined {
    const q = nameOrId.trim().replace(/^@/, '').toLowerCase();
    if (q === 'lead') return this.leadId;
    return this.agents().find((a) => a.id.toLowerCase() === q || a.name.toLowerCase() === q)?.id;
  }

  // ---- obiettivi ----------------------------------------------------------------------------

  goals(): readonly Goal[] {
    return this.store.data.goals;
  }

  goal(id: string): Goal | undefined {
    return this.store.data.goals.find((g) => g.id === id);
  }

  /** Il repository su cui lavora un agente: quello del suo task, poi dell'obiettivo, poi il predefinito. */
  repoIdOf(agentId: string): string | undefined {
    const t = this.agent(agentId)?.taskId ? this.tasks.get(this.agent(agentId)!.taskId!) : undefined;
    return t?.repoId ?? this.currentGoal()?.repoId ?? this.repos.defaultRepo()?.id;
  }

  /** L'obiettivo più recente ancora aperto (o l'ultimo in assoluto). */
  currentGoal(): Goal | undefined {
    const gs = this.store.data.goals;
    return [...gs].reverse().find((g) => g.status === 'planning' || g.status === 'active') ?? gs[gs.length - 1];
  }

  setGoal(id: string, patch: Partial<Goal>): void {
    const g = this.goal(id);
    if (!g) return;
    Object.assign(g, patch);
    this.store.markDirty();
    this.emit({ type: 'goal.upsert', goal: { ...g } });
  }

  private refreshGoal(goalId: string): void {
    const g = this.goal(goalId);
    if (!g) return;
    const progress = this.tasks.progress(goalId);
    let status = g.status;
    // con il merge per obiettivo l'obiettivo si chiude solo con il merge finale approvato
    const awaitingMerge = !this.mergePerTask && !!g.branch;
    if (this.tasks.goalComplete(goalId) && !awaitingMerge && (status === 'active' || status === 'planning' || status === 'paused')) status = 'done';
    if (awaitingMerge && this.tasks.goalComplete(goalId)) void this.checkGoalReady(goalId);
    else if (status === 'cancelled' && this.tasks.ofGoal(goalId).some((t) => t.status !== 'cancelled' && t.status !== 'done')) status = 'active';
    if (progress !== g.progress || status !== g.status) {
      g.progress = progress;
      g.status = status;
      this.store.markDirty();
      for (const l of this.listeners) l({ type: 'goal.upsert', goal: { ...g } });
      if (status === 'done') this.bus.feed('goal', `Obiettivo completato: ${truncate(g.text, 100)}`);
    }
  }

  // ---- decisioni ----------------------------------------------------------------------------

  createDecision(input: NewDecision): Decision {
    const d = this.decisions.create(input);
    const label = d.kind === 'merge' ? 'merge da rivedere' : d.kind === 'permission' ? 'permesso' : 'domanda';
    this.bus.feed('decision', `${this.nameOf(d.agentId)}: ${label} ${d.id} — ${truncate(d.question, 160)}`, { agentId: d.agentId });
    this.notify('need_user', `${this.nameOf(d.agentId)} ha bisogno di te (${label}): ${truncate(d.question, 120)}`);
    return d;
  }

  /**
   * Apre la decisione di merge di un task in review. Se il worktree non ha modifiche, il task si
   * chiude come completato senza chiedere un merge vuoto (restituisce undefined).
   */
  async openMergeDecision(t: Task, summary: string): Promise<Decision | undefined> {
    if (!t.repoId || !t.worktree) return undefined;
    await this.repos.refresh(t.repoId);
    const wt = this.repos.requireWorktree(t.repoId, t.worktree);
    if (wt.status === 'active' && wt.files === 0) {
      const m = this.team.member(wt.agentId);
      await this.repos.abandon(t.repoId, wt.id, `${t.id}: nessuna modifica`, { name: `Keystone ${m?.name ?? wt.agentId}`, email: `${wt.agentId}@keystone.local` });
      this.tasks.setStatus(t.id, 'done', { force: true, summary: t.summary ?? 'nessuna modifica' });
      this.bus.feed('task', `${t.id} non ha modificato file: chiuso, niente da unire`, { ...(t.assignee ? { agentId: t.assignee } : {}) });
      if (t.assignee && this.agent(t.assignee)?.taskId === t.id) this.setAgent(t.assignee, { state: 'idle', activity: `${t.id} completato`, taskId: undefined, worktree: undefined });
      this.team.tick();
      return undefined;
    }
    const d = this.createDecision({
      agentId: this.leadId,
      kind: 'merge',
      question: `Unire ${t.id} "${t.title}" (${wt.branch}) in ${wt.base}?`,
      options: MERGE_OPTIONS,
      context: [summary, `${wt.files} file, +${wt.additions} -${wt.deletions}`, this.team.ciNoteOf(t.id) ?? `Test eseguiti da Keystone: ${t.ci === 'unknown' ? 'nessuno' : t.ci}`, ...(t.visual ? [visualSummary(t.visual)] : [])].join('\n'),
      taskId: t.id,
      repoId: t.repoId,
      worktree: wt.id,
    });
    this.setAgent(this.leadId, { state: 'idle', activity: `aspetta la tua review di ${t.id}` });
    return d;
  }

  /**
   * Il lead ha approvato un task (request_merge, o il task finito senza review del lead). Con il
   * merge per task arriva all'utente una decisione per il task; con il merge per obiettivo (default)
   * il task si unisce nel branch dell'obiettivo e l'utente decide una volta sola, alla fine.
   * Restituisce il testo per il lead.
   */
  async submitForMerge(t: Task, summary: string): Promise<string> {
    const goal = t.goalId ? this.goal(t.goalId) : undefined;
    const wt = t.repoId && t.worktree ? this.repos.findWorktree(t.repoId, t.worktree) : undefined;
    if (this.mergePerTask || !goal || !wt || !isGoalBranch(wt.base)) {
      const d = await this.openMergeDecision(t, summary);
      return d ? `Decisione di merge ${d.id} inviata a ${this.userName}.` : `${t.id} non ha modificato nessun file: chiuso come completato, niente da unire.`;
    }
    return this.mergeTaskIntoGoal(t, wt, goal, summary);
  }

  private async mergeTaskIntoGoal(t: Task, wt: Worktree, goal: Goal, summary: string): Promise<string> {
    const agentId = wt.agentId;
    const identity = { name: `Keystone ${this.nameOf(agentId)}`, email: `${agentId}@keystone.local` };
    const finish = (text: string) => {
      if (t.assignee && this.agent(t.assignee)?.taskId === t.id) this.setAgent(t.assignee, { state: 'idle', activity: text, taskId: undefined, worktree: undefined });
      this.team.tick();
    };
    await this.repos.refresh(wt.repoId);
    try {
      const res = await this.repos.mergeIntoGoal(wt.repoId, wt.id, {
        commitMessage: `${t.id}: ${t.title}\n\n${summary}`,
        agentIdentity: identity,
        keystoneIdentity: { name: 'Keystone', email: 'keystone@keystone.local' },
      });
      this.tasks.update(t.id, { summary });
      this.tasks.setStatus(t.id, 'done', { merged: true });
      this.bus.feed('merge', `${t.id} unito nel branch dell'obiettivo ${goal.id} (${res.sha}, ${res.files} file): il merge nel tuo branch lo approvi alla fine dell'obiettivo`);
      finish(`${t.id} unito nell'obiettivo`);
      void this.checkGoalReady(goal.id);
      return `${t.id} unito nel branch dell'obiettivo. ${this.userName} approverà una sola volta il merge dell'intero obiettivo, quando tutti i task saranno fatti.`;
    } catch (e) {
      if (e instanceof RepoError && e.code === 'empty') {
        if (wt.status === 'active') await this.repos.abandon(wt.repoId, wt.id, `${t.id}: nessuna modifica`, identity);
        this.tasks.setStatus(t.id, 'done', { force: true, summary: t.summary ?? 'nessuna modifica' });
        this.bus.feed('task', `${t.id} non ha modificato file: chiuso, niente da unire`, { agentId });
        finish(`${t.id} completato`);
        void this.checkGoalReady(goal.id);
        return `${t.id} non ha modificato nessun file: chiuso come completato.`;
      }
      if (e instanceof RepoError && e.code === 'conflict' && this.team.onMergeConflict(t, { base: wt.base, branch: wt.branch, files: e.files })) {
        this.bus.feed('merge', `${t.id} è in conflitto con il branch dell'obiettivo (${e.files.join(', ')}): ${this.nameOf(t.assignee!)} unisce e risolve`, { agentId: t.assignee! });
        return `${t.id} è in conflitto con il lavoro già unito nell'obiettivo: rimandato a ${this.nameOf(t.assignee!)} per la risoluzione.`;
      }
      const reason = e instanceof RepoError ? e.message : `merge fallito: ${(e as Error).message}`;
      this.tasks.setStatus(t.id, 'blocked', { force: true, reason: `merge nel branch dell'obiettivo non riuscito: ${truncate(reason, 200)}` });
      this.notify('warn', `${t.id}: merge nel branch dell'obiettivo non riuscito: ${reason}`);
      this.bus.feed('merge', `${t.id}: merge nel branch dell'obiettivo non riuscito: ${reason}`);
      return `Merge di ${t.id} nel branch dell'obiettivo non riuscito: ${reason}`;
    }
  }

  private readonly goalChecks = new Set<string>();

  /**
   * Merge per obiettivo: quando tutti i task sono fatti, Keystone estrae il branch dell'obiettivo
   * in un suo worktree, ci esegue i test e manda all'utente l'unica decisione di merge.
   */
  async checkGoalReady(goalId: string): Promise<Decision | undefined> {
    const g = this.goal(goalId);
    if (this.mergePerTask || !g?.branch || !g.base || !g.repoId) return undefined;
    if (g.status === 'done' || g.status === 'cancelled' || !this.tasks.goalComplete(goalId)) return undefined;
    if (this.decisions.open().some((d) => d.kind === 'merge' && d.goalId === goalId)) return undefined;
    if (this.goalChecks.has(goalId)) return undefined;
    // il lead sta pianificando (modifiche chieste o conflitto): la decisione arriva dopo i suoi task
    if (this.team.leadBusyWith(goalId)) return undefined;
    this.goalChecks.add(goalId);
    try {
      if (!(await this.repos.hasChanges(g.repoId, g.base, g.branch))) {
        this.setGoal(goalId, { status: 'done', progress: 1 });
        this.bus.feed('goal', `Obiettivo completato senza modifiche da unire: ${truncate(g.text, 100)}`);
        return undefined;
      }
      const wt = await this.repos.createGoalWorktree(g.repoId, goalId, this.leadId, g.base);
      await this.repos.refresh(g.repoId);
      this.setAgent(this.leadId, { state: 'testing', activity: `test finali di ${goalId}` });
      let ciNote: string;
      try {
        ciNote = await this.team.runGoalCi(g.repoId, wt);
      } finally {
        // i file lasciati dai test non devono finire nella diff né nel merge
        await this.repos.cleanGoalWorktree(g.repoId, wt.id);
      }
      const tasks = this.tasks.ofGoal(goalId).filter((t) => t.status === 'done');
      const fresh = this.repos.findWorktree(g.repoId, wt.id) ?? wt;
      const d = this.createDecision({
        agentId: this.leadId,
        kind: 'merge',
        question: `Unire l'obiettivo ${goalId} "${truncate(g.text, 80)}" (${fresh.branch}) in ${g.base}?`,
        options: MERGE_OPTIONS,
        context: [
          `Lavoro dell'obiettivo, rivisto dal lead task per task:`,
          ...tasks.map((t) => `- ${t.id} ${t.title}${t.summary ? `: ${truncate(t.summary.replace(/\s+/g, ' '), 300)}` : ''}`),
          '',
          `${fresh.files} file, +${fresh.additions} -${fresh.deletions}`,
          ciNote,
          ...tasks.filter((t) => t.visual).map((t) => `${t.id}: ${visualSummary(t.visual!)}`),
        ].join('\n'),
        goalId,
        repoId: g.repoId,
        worktree: wt.id,
      });
      this.setAgent(this.leadId, { state: 'idle', activity: `aspetta la tua review dell'obiettivo ${goalId}` });
      return d;
    } catch (e) {
      const reason = e instanceof RepoError ? e.message : (e as Error).message;
      this.notify('warn', `Obiettivo ${goalId}: preparazione del merge finale non riuscita: ${reason}`);
      this.bus.feed('merge', `Obiettivo ${goalId}: preparazione del merge finale non riuscita: ${reason}`);
      return undefined;
    } finally {
      this.goalChecks.delete(goalId);
    }
  }

  async answerDecision(id: string, option?: string, text?: string): Promise<Decision> {
    const d = this.decisions.answer(id, option, text);
    this.bus.feed('decision', `${this.userName} ha risposto a ${d.id}: ${[d.answer?.option, d.answer?.text].filter(Boolean).join(' — ')}`);
    try {
      if (d.kind === 'merge') await this.applyMergeAnswer(d);
      if (d.kind === 'budget') this.team.onBudgetAnswer(d);
    } finally {
      this.decisions.settle(d.id);
    }
    this.team.onDecisionSettled(d);
    return d;
  }

  /** La risposta alla decisione di merge dell'intero obiettivo (Fase 11). */
  private async applyGoalMergeAnswer(d: Decision, g: Goal): Promise<void> {
    const opt = d.answer?.option;
    const lead = { name: `Keystone ${this.nameOf(this.leadId)}`, email: `${this.leadId}@keystone.local` };
    if (opt === MERGE_OPTIONS[0]) {
      const tasks = this.tasks.ofGoal(g.id).filter((t) => t.status === 'done');
      try {
        const res = await this.repos.merge(d, {
          commitMessage: `Obiettivo ${g.id}: ${truncate(g.text, 200)}\n\n${tasks.map((t) => `- ${t.id}: ${t.title}`).join('\n')}`,
          agentIdentity: lead,
        });
        this.setGoal(g.id, { status: 'done', progress: 1 });
        void this.refreshSkills();
        this.bus.feed('merge', `Obiettivo ${g.id} unito in ${res.base} (${res.sha}, ${res.files} file); branch dell'obiettivo ${res.branchDeleted ? 'eliminato' : `conservato: ${res.branchKeptReason ?? ''}`}`);
        this.bus.feed('goal', `Obiettivo completato: ${truncate(g.text, 100)}`);
        this.setAgent(this.leadId, { state: 'idle', activity: `obiettivo ${g.id} unito` });
        this.team.tick();
      } catch (e) {
        if (e instanceof RepoError && e.code === 'empty') {
          this.setGoal(g.id, { status: 'done', progress: 1 });
          this.bus.feed('merge', `Obiettivo ${g.id}: niente da unire, completato`);
          return;
        }
        if (e instanceof RepoError && e.code === 'conflict') {
          // il branch dell'utente è cambiato: un worker unisce e risolve, poi arriva una nuova decisione
          this.decisions.reopen(d.id);
          this.decisions.cancel(d.id, `conflitto con ${g.base} in ${e.files.join(', ')}: un worker unisce ${g.base} nel lavoro dell'obiettivo e risolve`);
          this.team.goalConflictTask(g, e.files);
          this.bus.feed('merge', `Obiettivo ${g.id} in conflitto con ${g.base} (${e.files.join(', ')}): creato un task per unire e risolvere`);
          return;
        }
        const reason = e instanceof RepoError ? e.message : `merge fallito: ${(e as Error).message}`;
        this.decisions.reopen(d.id, `${d.context ?? ''}\n\nMerge non eseguito: ${reason}`.trim());
        this.notify('warn', `Merge dell'obiettivo ${g.id} non eseguito: ${reason}`);
        this.bus.feed('merge', `Merge dell'obiettivo ${g.id} non eseguito: ${reason}`);
      }
    } else if (opt === MERGE_OPTIONS[1]) {
      this.team.requestGoalChanges(g, d.answer?.text ?? '');
    } else if (opt === MERGE_OPTIONS[2]) {
      const wt = d.repoId && d.worktree ? this.repos.findWorktree(d.repoId, d.worktree) : undefined;
      if (wt?.status === 'active') await this.repos.abandon(wt.repoId, wt.id, `obiettivo ${g.id}: rifiutato`, lead);
      this.setGoal(g.id, { status: 'cancelled' });
      this.bus.feed('merge', `Obiettivo ${g.id} rifiutato: il suo branch ${g.branch ?? ''} resta per un eventuale recupero`);
      this.setAgent(this.leadId, { state: 'idle', activity: `obiettivo ${g.id} rifiutato` });
    }
  }

  private async applyMergeAnswer(d: Decision): Promise<void> {
    const goalOfDecision = d.goalId && !d.taskId ? this.goal(d.goalId) : undefined;
    if (goalOfDecision) return this.applyGoalMergeAnswer(d, goalOfDecision);
    const t = d.taskId ? this.tasks.get(d.taskId) : undefined;
    const opt = d.answer?.option;
    if (opt === MERGE_OPTIONS[0]) {
      const wt = d.repoId && d.worktree ? this.repos.findWorktree(d.repoId, d.worktree) : undefined;
      const agentId = wt?.agentId ?? t?.assignee ?? this.leadId;
      try {
        const res = await this.repos.merge(d, {
          commitMessage: t ? `${t.id}: ${t.title}${t.summary ? `\n\n${t.summary}` : ''}` : `merge ${d.worktree ?? ''}`,
          agentIdentity: { name: `Keystone ${this.nameOf(agentId)}`, email: `${agentId}@keystone.local` },
        });
        if (t) this.tasks.setStatus(t.id, 'done', { merged: true });
        // il merge può aver cambiato le skill sul branch di destinazione
        void this.refreshSkills();
        this.bus.feed('merge', `Unito ${res.branch} in ${res.base} (${res.sha}, ${res.files} file); branch ${res.branchDeleted ? 'eliminato' : `conservato: ${res.branchKeptReason ?? ''}`}`);
        if (t?.assignee && this.agent(t.assignee)?.taskId === t.id) this.setAgent(t.assignee, { state: 'idle', activity: `${t.id} unito`, taskId: undefined, worktree: undefined });
        this.team.tick();
      } catch (e) {
        if (e instanceof RepoError && e.code === 'empty' && t) {
          // niente da unire (nessuna modifica rispetto alla base): il task è semplicemente completato
          if (wt?.status === 'active') await this.repos.abandon(wt.repoId, wt.id, `${t.id}: nessuna modifica`, { name: `Keystone ${this.nameOf(agentId)}`, email: `${agentId}@keystone.local` });
          this.tasks.setStatus(t.id, 'done', { force: true });
          this.bus.feed('merge', `${t.id}: niente da unire, chiuso come completato`);
          this.team.tick();
          return;
        }
        if (e instanceof RepoError && e.code === 'conflict' && t && wt && this.team.onMergeConflict(t, { base: wt.base, branch: wt.branch, files: e.files })) {
          // il branch torna al worker: dopo la risoluzione arriverà una nuova decisione di merge
          this.decisions.reopen(d.id);
          this.decisions.cancel(d.id, `conflitto con ${wt.base} in ${e.files.join(', ')}: rimandato a ${this.nameOf(t.assignee!)} per la risoluzione`);
          this.bus.feed('merge', `${t.id} è in conflitto con ${wt.base} (${e.files.join(', ')}): ${this.nameOf(t.assignee!)} unisce ${wt.base} e risolve`, { agentId: t.assignee! });
          return;
        }
        const reason = e instanceof RepoError ? e.message : `merge fallito: ${(e as Error).message}`;
        this.decisions.reopen(d.id, `${d.context ?? ''}\n\nMerge non eseguito: ${reason}`.trim());
        this.notify('warn', `Merge di ${d.taskId ?? d.id} non eseguito: ${reason}`);
        this.bus.feed('merge', `Merge di ${d.taskId ?? d.id} non eseguito: ${reason}`);
      }
    } else if (opt === MERGE_OPTIONS[1] && t) {
      this.team.sendBackToWorker(t.id, `${this.userName} ha rivisto ${t.id} e chiede modifiche:\n${d.answer?.text ?? '(nessun dettaglio: chiedi con ask_user se non è chiaro)'}\n\nFai le modifiche, rilancia i test, poi update_task("${t.id}", status "review", summary).`);
    } else if (opt === MERGE_OPTIONS[2] && t) {
      if (t.repoId && t.worktree) {
        const wt = this.repos.findWorktree(t.repoId, t.worktree);
        if (wt?.status === 'active') await this.repos.abandon(t.repoId, wt.id, `${t.id}: rifiutato`, { name: `Keystone ${this.nameOf(wt.agentId)}`, email: `${wt.agentId}@keystone.local` });
      }
      this.tasks.setStatus(t.id, 'cancelled', { force: true, summary: `rifiutato da ${this.userName}${d.answer?.text ? `: ${d.answer.text}` : ''}` });
      this.bus.feed('merge', `${t.id} rifiutato (il branch resta per un eventuale recupero; la pulizia lo elimina dopo conferma)`);
      if (t.assignee && this.agent(t.assignee)?.taskId === t.id) this.setAgent(t.assignee, { state: 'idle', activity: `${t.id} rifiutato`, taskId: undefined, worktree: undefined });
      this.team.tick();
    }
  }

  /**
   * Pulizia manuale dei worktree: chiude quelli attivi il cui task è finito, annullato o sparito
   * (salvando il lavoro sul branch), poi rimuove le cartelle orfane e fa `git worktree prune`.
   * I worktree su cui un agente sta lavorando non vengono toccati.
   */
  async pruneWorktrees(): Promise<string[]> {
    const report: string[] = [];
    for (const r of this.repos.list()) {
      for (const w of r.worktrees.filter((x) => x.status === 'active')) {
        const t = w.taskId ? this.tasks.get(w.taskId) : undefined;
        const finished = !t || t.status === 'done' || t.status === 'cancelled' || t.worktree !== w.id;
        if (!finished || this.team.isWorkingOn(w.agentId, w.taskId)) continue;
        await this.repos.abandon(r.id, w.id, `${w.taskId ?? w.id}: lavoro salvato durante la pulizia`, { name: `Keystone ${this.nameOf(w.agentId)}`, email: `${w.agentId}@keystone.local` });
        report.push(`chiuso il worktree ${w.id} (task ${w.taskId ?? '?'} ${t?.status ?? 'inesistente'}); branch ${w.branch} conservato`);
      }
    }
    report.push(...(await this.repos.pruneOrphans()));
    this.bus.feed('system', `Pulizia dei worktree: ${report.length ? `${report.length} operazioni` : 'niente da fare'}`);
    return report;
  }

  // ---- intenti del client -------------------------------------------------------------------

  /**
   * Applica un messaggio del client. `reply` manda un messaggio solo a quel client (es. il diff).
   * Restituisce un eventuale risultato per l'ack; gli errori dell'utente sono ClientError.
   */
  async handle(msg: ClientMessage, reply: (m: Outbound) => void): Promise<Record<string, unknown> | undefined> {
    try {
      return await this.dispatch(msg, reply);
    } catch (e) {
      if (e instanceof TaskError || e instanceof DecisionError || e instanceof RepoError || e instanceof MemoryError || e instanceof SkillError || e instanceof DbError) throw new ClientError(e.message);
      throw e;
    }
  }

  private async dispatch(msg: ClientMessage, reply: (m: Outbound) => void): Promise<Record<string, unknown> | undefined> {
    switch (msg.type) {
      case 'hello':
        reply(this.snapshot());
        return undefined;
      case 'goal.submit': {
        // con più repository l'obiettivo deve dire dove lavorare: mai il primo in silenzio
        const all = this.repos.list();
        if (!msg.repoId && all.length > 1) throw new ClientError(`indica il repository dell'obiettivo (${all.map((r) => `#${r.id}`).join(', ')})`);
        const repo = msg.repoId ? this.repos.get(msg.repoId) : this.repos.defaultRepo();
        if (!repo) throw new ClientError(msg.repoId ? `nessun repository ${msg.repoId}` : 'nessun repository registrato: aggiungine uno');
        const budgetUsd = msg.budgetUsd ?? this.defaultBudgetUsd;
        const limits = this.defaultGoalLimits;
        const goal: Goal = {
          id: this.store.nextId('g'),
          text: msg.text.trim(),
          status: 'planning',
          progress: 0,
          repoId: repo.id,
          costUsd: 0,
          ...(budgetUsd ? { budgetUsd } : {}),
          ...(limits.turns ? { turnLimit: limits.turns, turnsUsed: 0 } : {}),
          ...(limits.minutes ? { minuteLimit: limits.minutes, activeMs: 0 } : {}),
          createdAt: this.now(),
        };
        this.store.data.goals.push(goal);
        this.store.markDirty();
        this.emit({ type: 'goal.upsert', goal: { ...goal } });
        this.bus.feed('goal', `Nuovo obiettivo: ${truncate(goal.text, 200)}`);
        this.team.submitGoal(goal);
        return { goalId: goal.id };
      }
      case 'user.message': {
        const to = msg.to.toLowerCase() === 'all' ? 'all' : this.resolveAgentId(msg.to);
        if (!to) throw new ClientError(`nessun agente "${msg.to}"`);
        this.bus.send('user', to, msg.text);
        this.team.onUserMessage(to);
        return { to };
      }
      case 'decision.answer': {
        const d = await this.answerDecision(msg.decisionId, msg.option, msg.text);
        return { status: d.status };
      }
      case 'task.action': {
        const t = this.tasks.get(msg.taskId);
        if (!t) throw new ClientError(`nessun task ${msg.taskId}`);
        try {
          await this.team.onTaskAction(t, msg.action, msg.arg);
        } catch (e) {
          if (e instanceof Error && !(e instanceof ClientError)) throw new ClientError(e.message);
          throw e;
        }
        return { status: this.tasks.require(t.id).status };
      }
      case 'agent.action': {
        const id = this.resolveAgentId(msg.agentId);
        if (!id) throw new ClientError(`nessun agente "${msg.agentId}"`);
        try {
          await this.team.onAgentAction(id, msg.action);
        } catch (e) {
          if (e instanceof Error && !(e instanceof ClientError)) throw new ClientError(e.message);
          throw e;
        }
        return { agentId: id };
      }
      case 'diff.request': {
        const files = await this.repos.diff(msg.repoId, msg.worktree);
        reply({ type: 'diff', requestId: msg.requestId, repoId: msg.repoId, worktree: msg.worktree, files });
        return { files: files.length };
      }
      case 'repo.preview': {
        const pv = await this.repos.preview(msg.path);
        return { ...pv };
      }
      case 'repo.add': {
        const r = await this.repos.add(msg.path, { confirmGuard: msg.confirmGuard === true });
        void this.refreshSkills();
        return { repoId: r.id };
      }
      case 'goal.budget': {
        const g = this.goal(msg.goalId);
        if (!g) throw new ClientError(`nessun obiettivo ${msg.goalId}`);
        this.team.setGoalBudget(g.id, msg.budgetUsd);
        return { goalId: g.id, budgetUsd: msg.budgetUsd, status: this.goal(g.id)!.status };
      }
      case 'worktrees.prune': {
        const report = await this.pruneWorktrees();
        return { report };
      }
      case 'settings.set':
        return { userName: this.setUserName(msg.userName), userNameSource: this.userNameSource };
      case 'repo.config': {
        // campo assente = invariato; null = torna al default
        if (msg.mergeTarget === undefined && msg.visual === undefined) throw new ClientError('niente da cambiare: indica mergeTarget o visual');
        let r = this.repos.require(msg.repoId);
        if (msg.visual !== undefined) {
          r = this.repos.setVisual(msg.repoId, msg.visual);
          this.bus.feed('system', r.visual ? `${r.name}: verifica visuale attiva (${r.visual.command} → ${r.visual.url})` : `${r.name}: verifica visuale disattivata`);
        }
        if (msg.mergeTarget !== undefined) {
          r = await this.repos.setMergeTarget(msg.repoId, msg.mergeTarget && msg.mergeTarget.trim() ? msg.mergeTarget.trim() : null);
          this.bus.feed('system', `${r.name}: i merge vanno in ${r.mergeTarget ?? `${r.branch} (il branch aperto)`}`);
        }
        if (msg.mergeTarget !== undefined) void this.refreshSkills();
        return { repoId: r.id, mergeTarget: r.mergeTarget ?? null, visual: r.visual ?? null };
      }
      case 'skill.save': {
        const where = { source: msg.source, repoId: msg.repoId, id: msg.skillId };
        const file = await this.skills.save(where, msg.draft, msg.create);
        await this.refreshSkills();
        const repo = msg.repoId ? this.repos.get(msg.repoId) : undefined;
        this.bus.feed('system', `Skill "${msg.draft.name}" ${msg.create ? 'creata' : 'modificata'} ${repo ? `nel checkout di ${repo.name}: gli agenti la ricevono dopo il commit sul branch di destinazione` : '(personale)'}`);
        return { skillId: msg.skillId, file, needsCommit: msg.source === 'repo' };
      }
      case 'skill.delete': {
        const file = await this.skills.remove({ source: msg.source, repoId: msg.repoId, id: msg.skillId });
        await this.refreshSkills();
        this.bus.feed('system', `Skill "${msg.skillId}" cancellata${msg.source === 'repo' ? ' dal checkout: committa la cancellazione' : ''}`);
        return { skillId: msg.skillId, file, needsCommit: msg.source === 'repo' };
      }
      case 'skill.toggle': {
        await this.skills.toggle({ source: msg.source, repoId: msg.repoId, id: msg.skillId }, msg.enabled);
        await this.refreshSkills();
        return { skillId: msg.skillId, enabled: msg.enabled };
      }
      case 'skill.confirm': {
        this.skills.confirm(msg.skillId, msg.hash);
        await this.refreshSkills();
        this.bus.feed('system', `Skill personale "${msg.skillId}" confermata: gli agenti la ricevono dai prossimi turni`);
        return { skillId: msg.skillId };
      }
      case 'skills.refresh': {
        await this.refreshSkills();
        return { skills: this.skillList.length };
      }
      case 'db.save': {
        const r = this.repos.setDbConnection(msg.repoId, msg.connection);
        this.bus.feed('system', `${r.name}: connessione a database "${msg.connection.name}" salvata (sola lettura)`);
        return { repoId: r.id, connectionId: msg.connection.id };
      }
      case 'db.delete': {
        const r = this.repos.deleteDbConnection(msg.repoId, msg.connectionId);
        this.db.forget(msg.repoId, msg.connectionId);
        this.bus.feed('system', `${r.name}: connessione a database "${msg.connectionId}" tolta`);
        return { repoId: r.id, connectionId: msg.connectionId };
      }
      case 'db.secret': {
        // la password resta solo in memoria; il risultato non la contiene
        this.db.find(msg.repoId, msg.connectionId);
        this.db.setSecret(msg.repoId, msg.connectionId, msg.password, msg.destination);
        return { connectionId: msg.connectionId, loaded: msg.password !== null };
      }
      case 'orchestrator.shutdown':
        // lo gestisce il server (OrchestratorServer, opzione onShutdown): il nucleo non esce mai da solo
        throw new ClientError('arresto non disponibile');
      case 'db.test': {
        const text = await this.db.test(msg.repoId, msg.connectionId);
        return { connectionId: msg.connectionId, text };
      }
      case 'visual.shot.request': {
        const t = this.tasks.get(msg.taskId);
        const file = t ? shotFile(this.visualShotsDir(t.id), t, msg.shotId) : undefined;
        if (!file) {
          reply({ type: 'visual.shot', requestId: msg.requestId, error: 'schermata non trovata' });
          return { found: false };
        }
        reply({ type: 'visual.shot', requestId: msg.requestId, dataUrl: `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` });
        return { found: true };
      }
    }
  }
}
