// L'orchestratore: possiede tutto lo stato, compone i sottosistemi, applica gli intenti
// dell'utente e offre al team le primitive per far lavorare gli agenti. Non dipende dal
// trasporto: il server WebSocket gli passa i messaggi del client e si iscrive a quelli in uscita.
import os from 'node:os';
import path from 'node:path';
import { MERGE_OPTIONS, type Agent, type ClientMessage, type Decision, type Goal, type LogKind, type NotifyLevel, type OrchestratorStatus, type Outbound, type Task } from '@keystone/shared';
import { truncate } from '../util/text.js';
import { MessageBus } from './bus.js';
import { consoleLogger, type Ctx, type Logger } from './context.js';
import { DecisionError, DecisionQueue, type NewDecision } from './decisions.js';
import { Memory, MemoryError } from './memory.js';
import { RepoError, RepoManager, type RepoManagerOptions } from './repos.js';
import { Store } from './store.js';
import { TaskError, TaskGraph } from './taskgraph.js';
import { Team, type TeamMember, type TeamOptions } from './team.js';

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
  userName?: string;
  logger?: Logger;
  now?: () => number;
  /** solo test: guasti simulati durante il merge */
  repoFaults?: RepoManagerOptions['faults'];
  /** file di regole del guardiano git (default: <home>/git/agent-guard.gitconfig) */
  guardFile?: string;
  /** tetto di spesa predefinito per obiettivo in dollari (0 o assente = nessun tetto) */
  defaultBudgetUsd?: number;
  storeDebounceMs?: number;
}

type Listener = (msg: Outbound) => void;

export class Orchestrator {
  readonly store: Store;
  readonly tasks: TaskGraph;
  readonly decisions: DecisionQueue;
  readonly bus: MessageBus;
  readonly memory: Memory;
  readonly repos: RepoManager;
  readonly team: Team;
  readonly log: Logger;
  readonly userName: string;
  readonly now: () => number;
  readonly defaultBudgetUsd: number | undefined;
  status: OrchestratorStatus;
  private listeners = new Set<Listener>();

  constructor(opts: OrchestratorOptions) {
    this.log = opts.logger ?? consoleLogger();
    this.now = opts.now ?? Date.now;
    this.defaultBudgetUsd = opts.defaultBudgetUsd && opts.defaultBudgetUsd > 0 ? opts.defaultBudgetUsd : undefined;
    this.userName = opts.userName ?? (os.userInfo().username || 'utente');
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
    });
    const costUsd = this.store.data.agents.reduce((s, a) => s + a.costUsd, 0);
    const tokens = this.store.data.agents.reduce((s, a) => s + a.tokens, 0);
    this.status = { version: VERSION, auth: 'unknown', message: 'avvio…', costUsd, tokens, userName: this.userName, profile: path.basename(path.resolve(opts.dataDir)) };
    this.team = new Team(this, opts.members, opts.team);
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
      logs,
    };
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
    if (this.tasks.goalComplete(goalId) && (status === 'active' || status === 'planning' || status === 'paused')) status = 'done';
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
      context: [summary, `${wt.files} file, +${wt.additions} -${wt.deletions}`, `Test: ${this.team.ciNoteOf(t.id) ?? (t.ci === 'unknown' ? 'non eseguiti' : t.ci)}`].join('\n'),
      taskId: t.id,
      repoId: t.repoId,
      worktree: wt.id,
    });
    this.setAgent(this.leadId, { state: 'idle', activity: `aspetta la tua review di ${t.id}` });
    return d;
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

  private async applyMergeAnswer(d: Decision): Promise<void> {
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
        this.bus.feed('merge', `Unito ${res.branch} in ${res.base} (${res.sha}, ${res.files} file)`);
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
      this.bus.feed('merge', `${t.id} rifiutato (il branch resta per un eventuale recupero)`);
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
      if (e instanceof TaskError || e instanceof DecisionError || e instanceof RepoError || e instanceof MemoryError) throw new ClientError(e.message);
      throw e;
    }
  }

  private async dispatch(msg: ClientMessage, reply: (m: Outbound) => void): Promise<Record<string, unknown> | undefined> {
    switch (msg.type) {
      case 'hello':
        reply(this.snapshot());
        return undefined;
      case 'goal.submit': {
        const repo = msg.repoId ? this.repos.get(msg.repoId) : this.repos.defaultRepo();
        if (!repo) throw new ClientError(msg.repoId ? `nessun repository ${msg.repoId}` : 'nessun repository registrato: aggiungine uno');
        const budgetUsd = msg.budgetUsd ?? this.defaultBudgetUsd;
        const goal: Goal = { id: this.store.nextId('g'), text: msg.text.trim(), status: 'planning', progress: 0, repoId: repo.id, costUsd: 0, ...(budgetUsd ? { budgetUsd } : {}), createdAt: this.now() };
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
    }
  }
}
