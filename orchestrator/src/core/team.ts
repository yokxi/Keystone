// Il team: un lead e dei worker, ciascuno con il proprio motore (sim, Claude, Codex: anche misti).
//
// Ogni agente ha una coda di lavori; un lavoro = un turno del motore:
//   plan      il lead esplora il repo (sola lettura), scrive il piano, crea i task
//   work      un worker implementa un task nel suo worktree
//   review    il lead rivede un task finito (diff + test) -> request_merge o modifiche
//   followup  si riprende la sessione con un input nuovo (messaggio, risposta, feedback)
//
// Le sessioni sono salvate per (agente, task) e (lead, obiettivo). Un turno in corso è salvato in
// `team.inflight`: dopo un riavvio viene ripreso con la stessa sessione E lo stesso tipo di lavoro,
// così ciò che deve succedere a fine turno (l'obiettivo diventa attivo, il task va in review)
// non va perso. start() riconcilia ogni stato non terminale con ciò che è davvero in corso.
//
// Gli eventi dei motori (EngineEvent) vengono tradotti qui, in un punto solo, in log, stato
// dell'agente, costi e richieste di permesso.
import { BUDGET_OPTIONS, PERMISSION_OPTIONS, REPO_SKILLS_DIR, type AgentState, type Decision, type EngineEvent, type Goal, type Repo, type Role, type SkillContext, type Task, type TurnEndStatus, type VisualCheck, type VisualReport } from '@keystone/shared';
import type { EngineAdapter, EngineTurn, TeamToolResult, TurnSpec } from '../engines/types.js';
import { git } from '../util/git.js';
import { lastLines, truncate } from '../util/text.js';
import path from 'node:path';
import { agentEnv, secretVars } from './agent-env.js';
import { guardActive } from './gitsafety.js';
import type { Orchestrator } from './orchestrator.js';
import { classify, describeCall, describeRuleKey } from './policy.js';
import { ciReport, leadInstructions, planPrompt, RESUME_PROMPT, reviewPrompt, tryReport, visualSummary, workerInstructions, workPrompt } from './prompts.js';
import type { InflightJob, JobKind } from './store.js';
import { teamTools, type ToolHooks } from './tools.js';

export interface TeamMember {
  id: string;
  name: string;
  role: Role;
  engine: EngineAdapter;
  /** modello configurato (vuoto: il predefinito del motore) */
  model?: string;
  effort?: string;
}

export interface TeamOptions {
  /** worker al lavoro contemporaneamente */
  maxConcurrent: number;
  /** durata massima di un turno */
  turnTimeoutMs: number;
  /** il lead rivede ogni task prima che la decisione di merge arrivi all'utente */
  leadReview: boolean;
  /** comando dei test del repository target (default: rilevato, es. npm test) */
  ciCommand?: string;
  ciTimeoutMs?: number;
  /** quota minima di spesa per avviare un turno quando altri turni dello stesso obiettivo sono in corso */
  minTurnBudgetUsd?: number;
}

/** Quota minima predefinita per turno (dollari). */
export const MIN_TURN_BUDGET_USD = 0.25;

const BUDGET_CONTINUE_PROMPT =
  "Il turno precedente si è fermato perché ha esaurito la quota di spesa riservata al turno (il tetto dell'obiettivo non è stato raggiunto). Continua da dove eri rimasto.";

/** budget: l'obiettivo ha raggiunto il tetto di spesa (il turno resta salvato, come per shutdown) */
type AbortReason = 'pause' | 'stop' | 'shutdown' | 'cancel' | 'timeout' | 'budget';

interface Job {
  kind: JobKind;
  agentId: string;
  prompt: string;
  sessionKey: string;
  taskId?: string;
  goalId?: string;
  /** sessione nuova anche se ne esiste una per la chiave */
  fresh?: boolean;
  /** solleciti già inviati (worker che finisce il turno senza update_task) */
  nudges?: number;
  /** schermate allegate al prompt (review del lead con l'opzione attiva) */
  images?: Array<{ path: string; caption: string }>;
}

interface Running {
  job: Job;
  turn?: EngineTurn;
  reason?: AbortReason;
  done?: Promise<void>;
  /** decisioni aperte dal turno: annullate se il turno viene interrotto */
  decisions: Set<string>;
  whenAborted: Promise<void>;
  resolveAborted: () => void;
  /** percorsi che l'agente non può modificare in questo turno */
  protectedPaths: string[];
  /**
   * quota di spesa riservata al turno (assente: obiettivo senza tetto). Finché il turno è in corso
   * non è disponibile per altri turni dello stesso obiettivo.
   */
  reservedUsd?: number;
  /** inizio del turno e attese dell'agente già accumulate a quel momento (per il limite di tempo) */
  startedAt: number;
  waitedAtStart: number;
}

/** Il limite raggiunto da un obiettivo: spesa (tetto), turni o minuti di lavoro. */
export type GoalLimit = 'budget' | 'turns' | 'minutes';

/** La richiesta di permesso per scaricare Chromium (verifica visuale). */
export const BROWSER_TOOL = 'visual.browser';
export const BROWSER_OPTIONS = ['Scarica Chromium', 'Nega'] as const;
/** Schermate al massimo nella review del lead (ogni immagine costa token). */
const MAX_LEAD_IMAGES = 8;
/** Prova interfaccia (try_ui): prove per turno, tempo totale per turno e tempo massimo di una prova. */
export const TRY_UI_LIMITS = { perTurn: 5, msPerTurn: 10 * 60_000, msPerTry: 3 * 60_000 };

/** Ogni quanto si controlla il limite di tempo durante i turni. */
const LIMIT_CHECK_MS = 5_000;

interface TurnOutcome {
  status: TurnEndStatus;
  resultText?: string;
  errors: string[];
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TEST_RE = /\b(test|tests|vitest|jest|mocha|pytest|cargo test|go test|npm(\.cmd)? (run )?test)\b/i;

export class Team {
  readonly members: TeamMember[];
  readonly lead: TeamMember;
  private queues = new Map<string, Job[]>();
  private running = new Map<string, Running>();
  /** lavoro interrotto da una pausa, da riprendere con resume */
  private pausedJobs = new Map<string, Job>();
  /** task per cui CI/review è già in corso */
  private reviewing = new Set<string>();
  /** esito dei test dell'ultimo giro per task */
  private lastCi = new Map<string, string>();
  private stopping = false;
  private limitTimer: NodeJS.Timeout | undefined;
  private authFailed = false;
  private tickQueued = false;

  constructor(
    private o: Orchestrator,
    members: TeamMember[],
    private opts: TeamOptions,
  ) {
    const lead = members.find((m) => m.role === 'lead');
    if (!lead) throw new Error('il team ha bisogno di un lead');
    if (members.filter((m) => m.role === 'lead').length > 1) throw new Error('il team può avere un solo lead');
    this.lead = lead;
    this.members = members;
  }

  member(id: string): TeamMember | undefined {
    return this.members.find((m) => m.id === id);
  }

  workers(): TeamMember[] {
    return this.members.filter((m) => m.role === 'worker');
  }

  modelOf(m: TeamMember): string {
    return m.model || m.engine.defaultModel(m.role);
  }

  private get st() {
    return this.o.store.data.team;
  }

  // ---- ciclo di vita ------------------------------------------------------------------------

  async start(): Promise<void> {
    for (const m of this.members) {
      const model = this.modelOf(m);
      this.o.ensureAgent({ id: m.id, name: m.name, role: m.role, engine: m.engine.id, model: m.engine.displayModel(model) });
    }
    await this.checkAuth();
    this.recover();
    this.tick();
  }

  private async checkAuth(): Promise<void> {
    const engines = [...new Map(this.members.map((m) => [m.engine.id, m.engine])).values()];
    const problems: string[] = [];
    const accounts: string[] = [];
    for (const e of engines) {
      const r = await e.checkAuth().catch((err: Error) => ({ ok: false as const, message: err.message }));
      if (r.ok) accounts.push(`${e.label}: ${r.account}`);
      else problems.push(`${e.label}: ${r.message}`);
    }
    this.authFailed = problems.length > 0;
    this.o.setStatus({ auth: this.authFailed ? 'failed' : 'ok', message: this.authFailed ? problems.join(' · ') : accounts.join(' · ') });
    if (this.authFailed) this.o.notify('warn', `Autenticazione fallita: ${problems.join(' · ')}`);
  }

  /** Ferma tutti i turni. Con "shutdown" i turni in corso restano salvati e ripartono al riavvio. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.limitTimer) clearInterval(this.limitTimer);
    this.limitTimer = undefined;
    const waits: Promise<void>[] = [];
    for (const r of this.running.values()) {
      this.abort(r, 'shutdown');
      if (r.done) waits.push(r.done);
    }
    await Promise.race([Promise.allSettled(waits), new Promise((r) => setTimeout(r, 10_000))]);
  }

  /** Dopo un riavvio: riprende i turni interrotti e riconcilia gli stati rimasti a metà. */
  private recover(): void {
    // le richieste di permesso di un processo che non c'è più non hanno senso: l'agente ripresa riproverà
    for (const d of this.o.decisions.open().filter((x) => x.kind === 'permission')) this.o.decisions.cancel(d.id, 'orchestratore riavviato');
    for (const [agentId, inf] of Object.entries(this.st.inflight)) {
      const a = this.o.agent(agentId);
      if (!a || !this.member(agentId)) {
        delete this.st.inflight[agentId];
        continue;
      }
      if (this.goalPaused(inf.goalId ?? (inf.taskId ? this.o.tasks.get(inf.taskId)?.goalId : undefined))) continue;
      if (this.openQuestionOf(agentId)) {
        // aspetta la risposta: onDecisionSettled riprenderà la sessione
        this.o.setAgent(agentId, { state: 'waiting_user', activity: 'aspetta una tua risposta' });
        continue;
      }
      delete this.st.inflight[agentId];
      this.enqueue({ kind: inf.kind, agentId, sessionKey: inf.sessionKey, prompt: `${RESUME_PROMPT}\n\nIl lavoro era:\n${inf.prompt}`, ...(inf.taskId ? { taskId: inf.taskId } : {}), ...(inf.goalId ? { goalId: inf.goalId } : {}) });
    }
    this.o.store.markDirty();
    // obiettivi in pianificazione senza nessuno che li pianifichi
    for (const g of this.o.goals().filter((x) => x.status === 'planning')) {
      if (this.hasJob(this.lead.id, (j) => j.goalId === g.id)) continue;
      if (this.o.tasks.ofGoal(g.id).length) this.activateGoal(g);
      else this.enqueuePlan(g);
    }
    for (const t of this.o.tasks.list()) {
      if (this.goalPaused(t.goalId)) continue;
      if (t.status === 'doing' && t.assignee && !this.hasJob(t.assignee, (j) => j.taskId === t.id) && !this.openQuestionOf(t.assignee) && !this.st.inflight[t.assignee]) {
        // un task "doing" senza turno dietro: si riprende la sessione del worker
        const wt = t.worktree && t.repoId ? this.o.repos.findWorktree(t.repoId, t.worktree) : undefined;
        if (wt?.status === 'active') {
          this.o.setAgent(t.assignee, { taskId: t.id, worktree: wt.id, state: 'thinking', activity: `riprende ${t.id}` });
          this.enqueue({ kind: 'work', agentId: t.assignee, taskId: t.id, ...(t.goalId ? { goalId: t.goalId } : {}), sessionKey: `${t.assignee}:${t.id}`, prompt: `${RESUME_PROMPT}\n\n${workPrompt(this.promptEnv(), t, wt)}` });
        } else {
          this.o.tasks.setStatus(t.id, 'todo', { force: true });
        }
      }
      if (t.status === 'review' && !this.o.decisions.open().some((d) => d.kind === 'merge' && d.taskId === t.id) && !this.hasJob(this.lead.id, (j) => j.taskId === t.id)) {
        void this.afterWorkerDone(t.id);
      }
    }
  }

  private hasJob(agentId: string, pred: (j: Job) => boolean): boolean {
    const r = this.running.get(agentId);
    if (r && pred(r.job)) return true;
    return (this.queues.get(agentId) ?? []).some(pred);
  }

  /** L'agente ha un turno (in corso, in coda o in pausa) per questo task? */
  isWorkingOn(agentId: string, taskId: string | undefined): boolean {
    if (!taskId) return false;
    return this.hasJob(agentId, (j) => j.taskId === taskId) || this.pausedJobs.get(agentId)?.taskId === taskId;
  }

  private openQuestionOf(agentId: string): Decision | undefined {
    return this.o.decisions.open().find((d) => d.agentId === agentId && d.kind === 'question');
  }

  // ---- obiettivi e scheduling ---------------------------------------------------------------

  submitGoal(goal: Goal): void {
    this.enqueuePlan(goal);
  }

  private enqueuePlan(goal: Goal): void {
    const key = `${this.lead.id}:${goal.id}`;
    this.o.setAgent(this.lead.id, { state: 'thinking', activity: `pianifica: ${truncate(goal.text, 60)}` });
    this.enqueue({ kind: 'plan', agentId: this.lead.id, goalId: goal.id, sessionKey: key, fresh: !this.o.store.data.sessions[key], prompt: planPrompt(this.promptEnv(), goal) });
  }

  private activateGoal(goal: Goal): void {
    this.o.setGoal(goal.id, { status: 'active' });
    this.o.bus.feed('plan', `Piano pronto: ${this.o.tasks.ofGoal(goal.id).length} task per "${truncate(goal.text, 80)}"`, { agentId: this.lead.id });
    this.tick();
  }

  /** Pianifica uno scheduling al prossimo giro dell'event loop (più chiamate = un solo giro). */
  tick(): void {
    if (this.tickQueued || this.stopping) return;
    this.tickQueued = true;
    setImmediate(() => {
      this.tickQueued = false;
      this.schedule().catch((e) => this.o.log.error(`scheduler: ${(e as Error).stack ?? e}`));
    });
  }

  private workersBusy(): number {
    let n = 0;
    for (const [id] of this.running) if (id !== this.lead.id) n++;
    return n;
  }

  private isFree(id: string): boolean {
    const a = this.o.agent(id);
    if (!a || !a.active || a.paused) return false;
    if (this.running.has(id) || (this.queues.get(id)?.length ?? 0) > 0 || this.pausedJobs.has(id)) return false;
    return !this.o.tasks.list().some((t) => t.assignee === id && (t.status === 'doing' || t.status === 'review'));
  }

  private async schedule(): Promise<void> {
    if (this.authFailed || this.stopping) return;
    for (const goal of this.o.goals().filter((g) => g.status === 'active')) {
      for (const t of this.o.tasks.ready(goal.id)) {
        if (this.workersBusy() >= this.opts.maxConcurrent) return;
        let w: string | undefined;
        if (t.assignee && this.member(t.assignee)?.role === 'worker' && this.o.agent(t.assignee)?.active) {
          if (!this.isFree(t.assignee)) continue; // aspetta il worker indicato
          w = t.assignee;
        } else {
          w = this.workers().find((m) => this.isFree(m.id))?.id;
        }
        if (!w) continue;
        try {
          await this.startWork(w, t, goal);
        } catch (e) {
          this.o.log.error(`impossibile avviare ${t.id} per ${w}: ${(e as Error).message}`);
          this.o.agentLog(w, 'error', `non riesco ad avviare ${t.id}: ${(e as Error).message}`);
          this.o.tasks.setStatus(t.id, 'blocked', { force: true, reason: `avvio fallito: ${truncate((e as Error).message, 200)}` });
        }
      }
    }
    for (const id of this.queues.keys()) this.pump(id);
  }

  private async startWork(agentId: string, t: Task, goal: Goal): Promise<void> {
    const repoId = t.repoId ?? goal.repoId ?? this.o.repos.defaultRepo()?.id;
    if (!repoId) throw new Error('nessun repository registrato');
    this.o.tasks.update(t.id, { assignee: agentId, repoId });
    // un task già iniziato da un altro worker riparte dal suo branch, così non si perde nulla
    let startPoint: string | undefined;
    let continuesFrom: string | undefined;
    const prev = t.worktree ? this.o.repos.findWorktree(repoId, t.worktree) : undefined;
    if (prev && prev.agentId !== agentId && prev.status !== 'merged') {
      startPoint = prev.branch;
      continuesFrom = prev.agentId;
    }
    const wt = await this.o.repos.createWorktree(repoId, agentId, t, startPoint);
    this.o.tasks.update(t.id, { branch: wt.branch, worktree: wt.id });
    this.o.tasks.setStatus(t.id, 'doing');
    this.o.setAgent(agentId, { taskId: t.id, worktree: wt.id, state: 'thinking', activity: `inizia ${t.id}` });
    this.o.bus.feed('task', `${this.o.nameOf(agentId)} ha iniziato ${t.id}: ${t.title}`, { agentId });
    const key = `${agentId}:${t.id}`;
    this.enqueue({ kind: 'work', agentId, taskId: t.id, goalId: goal.id, sessionKey: key, fresh: !this.o.store.data.sessions[key], prompt: workPrompt(this.promptEnv(), t, wt, continuesFrom) });
  }

  // ---- code dei lavori ----------------------------------------------------------------------

  private enqueue(job: Job): void {
    const q = this.queues.get(job.agentId) ?? [];
    q.push(job);
    this.queues.set(job.agentId, q);
    this.pump(job.agentId);
  }

  private pump(agentId: string): void {
    if (this.stopping || this.authFailed || this.running.has(agentId)) return;
    const a = this.o.agent(agentId);
    if (!a || a.paused || !a.active) return;
    const q = this.queues.get(agentId);
    if (!q?.length) return;
    if (agentId !== this.lead.id && this.workersBusy() >= this.opts.maxConcurrent) return;
    // i lavori di un obiettivo in pausa per il tetto di spesa aspettano in coda, e anche quelli
    // per cui la spesa residua è già tutta riservata ad altri turni dello stesso obiettivo
    let reservedUsd: number | undefined;
    let waitingForBudget = false;
    const reached: Array<{ goalId: string; limit: GoalLimit }> = [];
    const idx = q.findIndex((j) => {
      const goalId = this.goalOfJob(j);
      if (this.goalPaused(goalId)) return false;
      // limite di turni o di tempo dell'obiettivo: nessun turno nuovo
      const limit = goalId ? this.limitReached(goalId) : undefined;
      if (limit) {
        reached.push({ goalId: goalId!, limit });
        return false;
      }
      const r = this.reserveFor(j, agentId);
      if (r === null) {
        waitingForBudget = true;
        return false;
      }
      reservedUsd = r;
      return true;
    });
    if (idx < 0) {
      const activity = 'aspetta: la spesa residua è riservata ad altri turni';
      if (waitingForBudget && a.activity !== activity) this.o.setAgent(agentId, { activity });
      for (const r of reached) this.onBudgetReached(r.goalId, r.limit);
      return;
    }
    const job = q.splice(idx, 1)[0]!;
    let resolveAborted!: () => void;
    const whenAborted = new Promise<void>((r) => (resolveAborted = r));
    const entry: Running = {
      job,
      decisions: new Set(),
      whenAborted,
      resolveAborted,
      protectedPaths: [],
      ...(reservedUsd !== undefined ? { reservedUsd } : {}),
      startedAt: this.o.now(),
      waitedAtStart: this.o.decisions.waitedMs(agentId),
    };
    const goalId = this.goalOfJob(job);
    const g = goalId ? this.o.goal(goalId) : undefined;
    if (g?.turnLimit !== undefined) this.o.setGoal(g.id, { turnsUsed: (g.turnsUsed ?? 0) + 1 });
    if (g?.minuteLimit !== undefined) this.ensureLimitTimer();
    this.running.set(agentId, entry);
    entry.done = this.runJob(entry).catch((e) => this.o.log.error(`turno di ${agentId}: ${(e as Error).stack ?? e}`));
  }

  /**
   * La quota di spesa per un nuovo turno: undefined = obiettivo senza tetto, null = deve aspettare.
   * Ogni turno riceve al massimo una fetta del tetto (tetto / posti: il lead più i worker che
   * possono lavorare insieme) e mai più del residuo meno le quote dei turni in corso dello stesso
   * obiettivo. Così la somma delle quote dei turni in corso non supera mai il residuo: lo
   * sforamento massimo è l'ultima chiamata al modello di ciascun turno.
   */
  private reserveFor(job: Job, agentId: string): number | undefined | null {
    const goalId = this.goalOfJob(job);
    const remaining = this.o.remainingBudget(goalId);
    if (remaining === undefined) return undefined;
    if (remaining <= 0) return null;
    const cap = this.o.goal(goalId!)!.budgetUsd!;
    let reserved = 0;
    let others = 0;
    for (const [id, r] of this.running) {
      if (id === agentId || r.reservedUsd === undefined || this.goalOfJob(r.job) !== goalId) continue;
      reserved += r.reservedUsd;
      others++;
    }
    const min = this.opts.minTurnBudgetUsd ?? MIN_TURN_BUDGET_USD;
    const slots = 1 + Math.max(1, Math.min(this.opts.maxConcurrent, this.workers().length));
    const slice = Math.max(min, cap / slots);
    if (!others) return Math.min(slice, remaining);
    const available = remaining - reserved;
    if (available < Math.min(min, slice)) return null;
    return Math.min(slice, available);
  }

  /** Il lavoro di un turno in corso finora, senza le attese di una risposta dell'utente. */
  private activeSoFar(r: Running): number {
    return Math.max(0, this.o.now() - r.startedAt - (this.o.decisions.waitedMs(r.job.agentId) - r.waitedAtStart));
  }

  /** Il tempo di lavoro dell'obiettivo: quello dei turni finiti più quello dei turni in corso. */
  goalActiveMs(goalId: string): number {
    let ms = this.o.goal(goalId)?.activeMs ?? 0;
    for (const r of this.running.values()) if (this.goalOfJob(r.job) === goalId) ms += this.activeSoFar(r);
    return ms;
  }

  /** Il limite di turni o di tempo raggiunto dall'obiettivo, se c'è (la spesa la controlla addGoalCost). */
  private limitReached(goalId: string): GoalLimit | undefined {
    const g = this.o.goal(goalId);
    if (!g) return undefined;
    if (g.turnLimit !== undefined && (g.turnsUsed ?? 0) >= g.turnLimit) return 'turns';
    if (g.minuteLimit !== undefined && this.goalActiveMs(goalId) >= g.minuteLimit * 60_000) return 'minutes';
    return undefined;
  }

  /** Durante i turni il limite di tempo si controlla ogni pochi secondi. */
  private ensureLimitTimer(): void {
    if (this.limitTimer) return;
    this.limitTimer = setInterval(() => {
      let any = false;
      for (const r of [...this.running.values()]) {
        const goalId = this.goalOfJob(r.job);
        const g = goalId ? this.o.goal(goalId) : undefined;
        if (!g || g.minuteLimit === undefined || r.reason) continue;
        any = true;
        if (this.goalActiveMs(g.id) >= g.minuteLimit * 60_000) this.onBudgetReached(g.id, 'minutes');
      }
      if (!any && this.limitTimer) {
        clearInterval(this.limitTimer);
        this.limitTimer = undefined;
      }
    }, LIMIT_CHECK_MS);
    this.limitTimer.unref?.();
  }

  private pumpAll(): void {
    for (const id of this.queues.keys()) this.pump(id);
  }

  private abort(r: Running, reason: AbortReason): void {
    if (r.reason) return;
    r.reason = reason;
    r.turn?.abort(reason);
    r.resolveAborted();
    // le domande restano aperte solo in caso di spegnimento: al riavvio la risposta riprende la sessione
    for (const id of r.decisions) {
      const d = this.o.decisions.get(id);
      if (!d || d.status !== 'open') continue;
      if ((reason === 'shutdown' || reason === 'budget') && d.kind === 'question') continue;
      this.o.decisions.cancel(id, `turno di ${this.o.nameOf(r.job.agentId)} interrotto (${reason})`);
    }
  }

  /**
   * Percorsi che l'agente non può modificare: la cartella del guardiano git (~/.keystone/git), il
   * .git/config del repository (contiene l'include del guardiano), i dati dei worktree in
   * .git/worktrees, il collegamento .git del worktree, le skill (.keystone/skills/ nella cartella
   * di lavoro e nel checkout, ~/.keystone/skills/), i file dello stato del profilo e config.json.
   */
  private async protectedPathsFor(job: Job, cwd: string): Promise<string[]> {
    const skillsIn = (dir: string) => path.join(dir, ...REPO_SKILLS_DIR.split('/'));
    // lo stato del profilo (contiene le impronte delle skill personali confermate)
    const state = [this.o.store.file, `${this.o.store.file}.bak`];
    const out = [path.dirname(this.o.repos.guardFile), this.o.skills.personalDir, skillsIn(cwd), ...state, ...this.o.configFiles];
    const goal = job.goalId ? this.o.goal(job.goalId) : undefined;
    const t = job.taskId ? this.o.tasks.get(job.taskId) : undefined;
    const repoId = t?.repoId ?? goal?.repoId ?? this.o.repos.defaultRepo()?.id;
    if (repoId) {
      const common = await this.o.repos.commonDir(repoId);
      out.push(path.join(common, 'config'), path.join(common, 'worktrees'), skillsIn(this.o.repos.require(repoId).path));
    }
    if (this.member(job.agentId)?.role === 'worker') out.push(path.join(cwd, '.git'));
    return out;
  }

  /**
   * Le skill di un turno. Repository e branch: per il lead quello dell'obiettivo e il suo branch di
   * destinazione; per il worker quello del task e la base del worktree (il branch in cui verrà
   * unito). Mai il worktree dell'agente: vedi core/skills.ts.
   */
  private async skillsForJob(job: Job, role: Role): Promise<{ text: string; refs: Array<{ id: string; source: 'repo' | 'personal'; name: string }>; omitted: string[]; problems: string[] }> {
    const task = job.taskId ? this.o.tasks.get(job.taskId) : undefined;
    let repo: Repo | undefined;
    let branch: string | undefined;
    let files: string[] = [];
    let text = '';
    let phase: SkillContext['phase'];
    if (role === 'lead') {
      const goal = job.goalId ? this.o.goal(job.goalId) : this.o.currentGoal();
      repo = (task?.repoId && this.o.repos.get(task.repoId)) || (goal?.repoId && this.o.repos.get(goal.repoId)) || this.o.repos.defaultRepo();
      branch = repo ? await this.o.repos.targetBranch(repo.id) : undefined;
      phase = job.kind === 'review' || (job.kind === 'followup' && task) ? 'review' : 'piano';
      text = phase === 'review' && task ? [task.title, task.description ?? '', task.summary ?? ''].join(' ') : (goal?.text ?? '');
    } else {
      repo = task?.repoId ? this.o.repos.get(task.repoId) : undefined;
      const wt = repo && task?.worktree ? this.o.repos.findWorktree(repo.id, task.worktree) : undefined;
      branch = wt?.base;
      phase = 'lavoro';
      text = task ? [task.title, task.description ?? ''].join(' ') : '';
    }
    if (repo && task?.worktree && (role === 'worker' || phase === 'review')) {
      files = await this.o.repos.diff(repo.id, task.worktree).then(
        (ds) => ds.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])),
        () => [],
      );
    }
    return this.o.skills.forTurn({ repo, branch, ctx: { role, phase, files, text } });
  }

  private cwdFor(job: Job): string {
    if (job.agentId === this.lead.id) {
      const goal = job.goalId ? this.o.goal(job.goalId) : this.o.currentGoal();
      const repo = (goal?.repoId && this.o.repos.get(goal.repoId)) || this.o.repos.defaultRepo();
      if (!repo) throw new Error('nessun repository per il lead');
      return repo.path;
    }
    const t = job.taskId ? this.o.tasks.get(job.taskId) : undefined;
    if (!t?.worktree || !t.repoId) throw new Error(`il lavoro di ${job.agentId} non ha un worktree`);
    return this.o.repos.requireWorktree(t.repoId, t.worktree).path;
  }

  private promptEnv() {
    return { userName: this.o.userName, nameOf: (id: string) => this.o.nameOf(id), tasks: this.o.tasks.list() };
  }

  private async runJob(entry: Running): Promise<void> {
    const { job } = entry;
    const agentId = job.agentId;
    const m = this.member(agentId)!;
    let outcome: TurnOutcome = { status: 'error', errors: [] };
    try {
      const cwd = this.cwdFor(job);
      entry.protectedPaths = await this.protectedPathsFor(job, cwd);
      if (m.role === 'worker' && !(await guardActive(cwd))) {
        // il guardiano git è stato rimosso o manomesso: nessun turno senza protezione
        const t = job.taskId ? this.o.tasks.get(job.taskId) : undefined;
        if (t) this.o.tasks.setStatus(t.id, 'blocked', { force: true, reason: 'guardiano git non attivo nel worktree: registra di nuovo il repository' });
        this.o.notify('warn', `Turno di ${m.name} non avviato: il guardiano git non è attivo in ${cwd}`);
        throw new Error(`guardiano git non attivo in ${cwd}: turno non avviato`);
      }
      // le skill si leggono prima di segnare il turno come in corso: la lettura usa git (asincrona)
      const skills = await this.skillsForJob(job, m.role).catch((e: Error) => ({ text: '', refs: [], omitted: [], problems: [`skill non lette: ${e.message}`] }));
      const session = this.o.store.data.sessions[job.sessionKey];
      const resume = !job.fresh && session && session.engine === m.engine.id ? session.sessionId : undefined;
      const inflight: InflightJob = { kind: job.kind, sessionKey: job.sessionKey, prompt: job.prompt, startedAt: this.o.now(), ...(job.taskId ? { taskId: job.taskId } : {}), ...(job.goalId ? { goalId: job.goalId } : {}) };
      this.st.inflight[agentId] = inflight;
      this.o.store.markDirty();

      const task = job.taskId ? this.o.tasks.get(job.taskId) : undefined;
      const goal = job.goalId ? this.o.goal(job.goalId) : undefined;
      let instructions =
        m.role === 'lead' ? leadInstructions(this.promptEnv(), this.workers()) : workerInstructions(this.promptEnv(), this.o.repos.requireWorktree(task!.repoId!, task!.worktree!));
      // le skill: stesse istruzioni per ogni motore, lette dal branch di destinazione
      instructions += skills.text;
      this.o.setAgent(agentId, { skills: skills.refs });
      if (skills.refs.length) this.o.agentLog(agentId, 'text', `Skill ricevute: ${skills.refs.map((r) => `${r.name} (${r.source === 'repo' ? 'repository' : 'personale'})`).join(', ')}`);
      if (skills.omitted.length) this.o.agentLog(agentId, 'error', `Skill non consegnate per il limite di lunghezza: ${skills.omitted.join(', ')}`);
      for (const p of skills.problems.slice(0, 5)) this.o.agentLog(agentId, 'error', p);
      const unread = this.o.bus.inbox(agentId, { markRead: true });
      const prompt = unread.length ? `${job.prompt}\n\n[Nuovi messaggi]\n${unread.map((x) => `- da ${x.from === 'user' ? this.o.userName : this.o.nameOf(x.from)}: ${x.text}`).join('\n')}` : job.prompt;
      const model = this.modelOf(m);
      this.o.agentLog(agentId, 'text', `${resume ? 'Riprende' : 'Avvia'} ${job.kind}${job.taskId ? ` ${job.taskId}` : ''} (${m.engine.label} · ${m.engine.displayModel(model)})`);

      // limiti della prova interfaccia: valgono per questo turno
      const tries = { count: 0, usedMs: 0 };
      const hooks: ToolHooks = {
        onReview: () => undefined, // gestito a fine turno
        onChangesRequested: (taskId, feedback) => this.sendBackToWorker(taskId, `Il lead ha chiesto modifiche a ${taskId}:\n${feedback}\n\nFai le modifiche, rilancia i test, poi update_task("${taskId}", status "review", summary).`),
        onTasksChanged: () => this.tick(),
        onDecisionOpened: (id) => entry.decisions.add(id),
        ...(m.role === 'worker' ? { tryUi: (taskId: string, checks: VisualCheck[]) => this.tryUi(agentId, taskId, checks, tries, () => !!entry.reason) } : {}),
      };
      const guard = { aborted: () => !!entry.reason, reason: () => entry.reason, whenAborted: entry.whenAborted };
      const spec: TurnSpec = {
        agentId,
        agentName: m.name,
        role: m.role,
        cwd,
        prompt,
        ...(job.images?.length ? { images: job.images } : {}),
        instructions,
        model,
        ...(m.effort ? { effort: m.effort } : {}),
        env: agentEnv(process.env, { agentId, name: m.name, cwd }),
        credentials: secretVars(process.env),
        writableRoots: [],
        tools: teamTools(this.o, agentId, m.role, hooks, guard),
        ...(entry.reservedUsd !== undefined ? { budgetUsd: entry.reservedUsd } : {}),
        ...(resume && session && (session.engineTotalUsd ?? session.costUsd) !== undefined ? { sessionCostUsd: (session.engineTotalUsd ?? session.costUsd)! } : {}),
        job: { kind: job.kind, ...(job.taskId ? { taskId: job.taskId } : {}), ...(job.goalId ? { goalId: job.goalId } : {}), ...(job.kind === 'plan' && goal ? { title: goal.text } : task ? { title: task.title } : {}) },
      };
      const turn = resume ? m.engine.resumeSession(resume, spec) : m.engine.startSession(spec);
      entry.turn = turn;
      if (entry.reason) turn.abort(entry.reason);
      const timer = setTimeout(() => this.abort(entry, 'timeout'), this.opts.turnTimeoutMs);
      timer.unref?.();
      try {
        for await (const ev of turn.events) {
          const end = this.handleEvent(entry, m, cwd, ev);
          if (end) outcome = { ...outcome, ...end };
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      outcome = { status: 'error', errors: [...outcome.errors, msg] };
      this.o.agentLog(agentId, 'error', `errore del turno: ${truncate(msg, 400)}`);
    } finally {
      // il tempo di lavoro del turno (senza le attese di una tua risposta) va all'obiettivo
      const goalId = this.goalOfJob(job);
      const g = goalId ? this.o.goal(goalId) : undefined;
      if (g?.minuteLimit !== undefined) this.o.setGoal(g.id, { activeMs: Math.round((g.activeMs ?? 0) + this.activeSoFar(entry)) });
      this.running.delete(agentId);
    }
    await this.finishJob(entry, outcome);
  }

  /** Traduce un evento del motore. Restituisce l'esito se l'evento chiude il turno. */
  private handleEvent(entry: Running, m: TeamMember, cwd: string, ev: EngineEvent): Partial<TurnOutcome> | undefined {
    const agentId = m.id;
    if (entry.reason && ev.type !== 'turn_end' && ev.type !== 'session') return undefined; // niente da un turno interrotto raggiunge la vista
    switch (ev.type) {
      case 'session': {
        const prev = this.o.store.data.sessions[entry.job.sessionKey];
        if (prev?.sessionId !== ev.sessionId || prev.engine !== m.engine.id) {
          const same = prev?.sessionId === ev.sessionId;
          this.o.store.data.sessions[entry.job.sessionKey] = {
            sessionId: ev.sessionId,
            engine: m.engine.id,
            model: this.modelOf(m),
            updatedAt: this.o.now(),
            ...(same && prev.costUsd !== undefined ? { costUsd: prev.costUsd } : {}),
            ...(same && prev.engineTotalUsd !== undefined ? { engineTotalUsd: prev.engineTotalUsd } : {}),
          };
          this.o.store.markDirty();
        }
        return undefined;
      }
      case 'model':
        this.o.setAgent(agentId, { model: m.engine.displayModel(ev.model) });
        return undefined;
      case 'text':
        if (ev.text.trim()) this.o.agentLog(agentId, 'text', ev.text);
        this.o.setAgent(agentId, { state: 'thinking' });
        return undefined;
      case 'tool_call': {
        const team = describeTeamCall(ev.tool, ev.input);
        this.o.agentLog(agentId, 'tool', team ?? describeCall(ev.tool, ev.input));
        // i tool del team aggiornano da soli stato e attività (es. ask_user: "aspetta una tua risposta")
        const state = team ? undefined : stateForTool(ev.tool, ev.input);
        if (state) this.o.setAgent(agentId, { state, activity: truncate(describeCall(ev.tool, ev.input), 80) });
        return undefined;
      }
      case 'tool_result': {
        const kind = !ev.ok ? 'error' : 'result';
        const text = lastLines(ev.output, 8);
        if (text.trim()) this.o.agentLog(agentId, kind, text);
        return undefined;
      }
      case 'file_change':
        this.o.agentLog(agentId, 'diff', ev.diff ?? `${ev.change} ${ev.path}`);
        return undefined;
      case 'permission_request':
        void this.gate(entry, m, cwd, ev).then((answer) => entry.turn?.respond(ev.requestId, answer));
        return undefined;
      case 'usage': {
        this.o.addUsage(agentId, ev.inputTokens + ev.outputTokens, ev.costUsd ?? 0);
        const rec = this.o.store.data.sessions[entry.job.sessionKey];
        if (rec && ev.sessionTotalUsd !== undefined) {
          rec.engineTotalUsd = ev.sessionTotalUsd;
          this.o.store.markDirty();
        }
        const goalId = this.goalOfJob(entry.job);
        if (ev.unreconciledUsd && goalId) {
          this.o.addGoalUnreconciled(goalId, ev.unreconciledUsd);
          this.o.agentLog(agentId, 'text', `spesa contata per prudenza: la sessione ripresa potrebbe non aver ritrovato $${ev.unreconciledUsd.toFixed(2)} già contati; restano contati finché non vengono riconciliati`);
        }
        if (ev.costUsd) {
          if (rec) rec.costUsd = Math.round(((rec.costUsd ?? 0) + ev.costUsd) * 1e6) / 1e6;
          // la spesa ora è nel totale dell'obiettivo: non è più riservata al turno
          if (entry.reservedUsd !== undefined) entry.reservedUsd = Math.max(0, entry.reservedUsd - ev.costUsd);
          if (goalId && this.o.addGoalCost(goalId, ev.costUsd)) this.onBudgetReached(goalId);
        }
        return undefined;
      }
      case 'error':
        this.o.agentLog(agentId, 'error', ev.message);
        if (ev.auth) {
          this.authFailed = true;
          this.o.setStatus({ auth: 'failed', message: `${m.engine.label}: ${ev.message}` });
          this.o.notify('warn', `${m.engine.label}: autenticazione fallita (${ev.message})`);
        }
        return { errors: [ev.message] };
      case 'turn_end':
        return { status: ev.status, ...(ev.resultText ? { resultText: ev.resultText } : {}) };
    }
  }

  /** La policy decide; quello che non può consentire da sola diventa una decisione per l'utente. */
  private async gate(entry: Running, m: TeamMember, cwd: string, ev: Extract<EngineEvent, { type: 'permission_request' }>) {
    const agentId = m.id;
    if (entry.reason) return { allow: false as const, message: 'turno interrotto' };
    const verdict = classify(ev.tool, ev.input, { role: m.role, cwd, readDirs: [this.o.memory.dir], alwaysAllow: this.o.store.data.permissionRules[agentId] ?? [], protectedPaths: entry.protectedPaths });
    const what = describeCall(ev.tool, ev.input);
    if (verdict.action === 'allow') return { allow: true as const };
    if (verdict.action === 'deny') {
      this.o.agentLog(agentId, 'permission', `negato: ${what} (${verdict.reason})`);
      return { allow: false as const, message: verdict.reason };
    }
    const before = this.o.agent(agentId);
    const d = this.o.createDecision({
      agentId,
      kind: 'permission',
      tool: ev.tool,
      command: what,
      alwaysAsk: !verdict.sticky,
      question: `${m.name} vuole eseguire ${truncate(what, 200)}`,
      // config git, variabili d'ambiente, hook, git -c, .git: si approva solo la singola esecuzione
      options: verdict.sticky ? PERMISSION_OPTIONS : [PERMISSION_OPTIONS[0], PERMISSION_OPTIONS[2]],
      context: [
        verdict.reason,
        `cartella: ${cwd}`,
        ...(ev.reason ? [`motivo: ${ev.reason}`] : []),
        verdict.sticky ? `"${PERMISSION_OPTIONS[1]}" vale per: ${verdict.ruleKeys.map(describeRuleKey).join('; ')}` : 'Questa azione richiede sempre la tua approvazione: non si può consentire una volta per tutte.',
      ].join('\n'),
      ...(before?.taskId ? { taskId: before.taskId } : {}),
    });
    entry.decisions.add(d.id);
    this.o.setAgent(agentId, { state: 'waiting_user', activity: 'chiede un permesso' });
    this.o.agentLog(agentId, 'permission', `permesso? ${what}`);
    const res = await this.o.decisions.wait(d.id);
    if (entry.reason) return { allow: false as const, message: 'turno interrotto' };
    if (before) this.o.setAgent(agentId, { state: before.state === 'waiting_user' ? 'thinking' : before.state, activity: before.activity });
    const opt = res.answer?.option;
    if (res.status === 'answered' && (opt === PERMISSION_OPTIONS[0] || opt === PERMISSION_OPTIONS[1])) {
      if (opt === PERMISSION_OPTIONS[1] && verdict.sticky) {
        const rules = (this.o.store.data.permissionRules[agentId] ??= []);
        for (const k of verdict.ruleKeys) if (!rules.includes(k)) rules.push(k);
        this.o.store.markDirty();
      }
      this.o.agentLog(agentId, 'permission', `consentito: ${what}`);
      return { allow: true as const };
    }
    this.o.agentLog(agentId, 'permission', `${res.status === 'cancelled' ? 'richiesta ritirata' : 'negato'}: ${what}`);
    return { allow: false as const, message: `${this.o.userName} ha negato${res.answer?.text ? `: ${res.answer.text}` : ''}. Trova un'altra strada o chiedi con ask_user.` };
  }

  private async finishJob(entry: Running, outcome: TurnOutcome): Promise<void> {
    const { job } = entry;
    const agentId = job.agentId;
    const reason = entry.reason;
    if (reason === 'shutdown') return; // inflight resta salvato: si riprende al riavvio
    // tetto di spesa raggiunto (anche se il turno è finito da solo per il tetto del motore):
    // il turno resta salvato e riprende quando il tetto viene alzato
    if (reason === 'budget' || (outcome.status !== 'success' && this.goalPaused(this.goalOfJob(job)))) {
      this.o.setAgent(agentId, { state: 'idle', activity: 'fermo: tetto di spesa raggiunto' });
      return;
    }
    delete this.st.inflight[agentId];
    this.o.store.markDirty();
    if (!reason && outcome.status === 'budget') {
      // quota del turno esaurita ma il tetto dell'obiettivo no: riprende la stessa sessione appena
      // c'è spesa disponibile (in coda, come ogni turno)
      this.o.agentLog(agentId, 'text', "quota di spesa del turno esaurita: riprende appena c'è spesa disponibile");
      this.o.setAgent(agentId, { state: 'idle', activity: 'quota del turno esaurita: riprende a breve' });
      this.enqueue({ ...job, fresh: false, prompt: BUDGET_CONTINUE_PROMPT });
      this.pumpAll();
      this.tick();
      return;
    }
    try {
      if (reason === 'pause') {
        const next: Job = { ...job, fresh: false, prompt: `${this.o.userName} ti aveva messo in pausa e ora ti ha ripreso. Le domande aperte sono state ritirate: richiedile se servono ancora. Continua il lavoro.` };
        if (this.o.agent(agentId)?.paused) {
          this.pausedJobs.set(agentId, next);
          this.o.setAgent(agentId, { state: 'idle', activity: 'in pausa' });
        } else this.enqueue(next);
      } else if (reason === 'stop' || reason === 'cancel') {
        this.o.setAgent(agentId, { state: 'idle', activity: reason === 'stop' ? 'fuori turno' : 'task annullato', taskId: undefined, worktree: undefined });
      } else {
        if (reason === 'timeout') {
          this.o.agentLog(agentId, 'error', `il turno ha superato il tempo massimo (${Math.round(this.opts.turnTimeoutMs / 60_000)} min)`);
          outcome = { status: 'error', errors: [...outcome.errors, 'tempo scaduto'] };
        }
        await this.afterTurn(job, outcome);
      }
    } catch (e) {
      this.o.log.error(`dopo il turno di ${agentId}: ${(e as Error).stack ?? e}`);
    }
    this.pump(agentId);
    // la quota del turno è libera: possono partire turni che aspettavano spesa disponibile
    this.pumpAll();
    if (reason !== 'stop' && reason !== 'pause') this.deliverPending(agentId);
    this.tick();
  }

  private failureText(o: TurnOutcome): string {
    return truncate(o.errors[0] ?? (o.status === 'max_turns' ? 'limite di turni raggiunto' : o.status), 120);
  }

  private async afterTurn(job: Job, outcome: TurnOutcome): Promise<void> {
    const failed = outcome.status !== 'success';
    if (job.agentId === this.lead.id) {
      this.o.setAgent(this.lead.id, failed ? { state: 'error', activity: `turno fallito: ${this.failureText(outcome)}` } : { state: 'idle', activity: 'segue il tabellone' });
      const goal = job.goalId ? this.o.goal(job.goalId) : undefined;
      if (goal?.status === 'planning') {
        if (this.o.tasks.ofGoal(goal.id).length) this.activateGoal(goal);
        else if (failed) {
          this.o.setGoal(goal.id, { status: 'failed' });
          this.o.bus.feed('error', `La pianificazione è finita senza task: ${this.failureText(outcome)}`, { agentId: this.lead.id });
        } else if (job.kind === 'plan') {
          this.o.setGoal(goal.id, { status: 'cancelled' });
          this.o.bus.feed('goal', `Nessun task pianificato: obiettivo chiuso (${truncate(goal.text, 80)})`, { agentId: this.lead.id });
        }
      }
      if (job.kind === 'review' && job.taskId) {
        const t = this.o.tasks.get(job.taskId);
        const open = this.o.decisions.open().some((d) => d.kind === 'merge' && d.taskId === job.taskId);
        // nessun verdetto dal lead: la decisione arriva comunque all'utente (mai merge automatico)
        if (t?.status === 'review' && !open) await this.o.openMergeDecision(t, `Review del lead: ${truncate(outcome.resultText ?? '(nessun verdetto)', 300)}`);
      }
      return;
    }
    const t = job.taskId ? this.o.tasks.get(job.taskId) : undefined;
    if (!t) {
      this.o.setAgent(job.agentId, failed ? { state: 'error', activity: `turno fallito: ${this.failureText(outcome)}` } : { state: 'idle', activity: 'libero' });
      return;
    }
    if (t.status === 'review') {
      await this.afterWorkerDone(t.id);
      return;
    }
    if (t.status === 'doing') {
      const nudges = this.st.nudges[t.id] ?? 0;
      if (!failed && nudges < 1) {
        this.st.nudges[t.id] = nudges + 1;
        this.o.store.markDirty();
        this.enqueue({ ...job, kind: 'followup', fresh: false, prompt: `Hai finito il turno ma ${t.id} è ancora "doing". Se il lavoro è completo chiama update_task("${t.id}", status "review", summary). Se sei bloccato usa status "blocked" con blocked_reason. Altrimenti continua.` });
        return;
      }
      if (t.repoId) await this.o.repos.refresh(t.repoId);
      const wt = t.worktree && t.repoId ? this.o.repos.findWorktree(t.repoId, t.worktree) : undefined;
      if (!failed && wt && wt.files > 0) {
        this.o.tasks.setStatus(t.id, 'review', { summary: truncate(outcome.resultText ?? 'lavoro completato', 400) });
        await this.afterWorkerDone(t.id);
      } else {
        const reason = failed ? `turno fallito: ${this.failureText(outcome)}` : 'il worker si è fermato senza modifiche';
        this.o.tasks.setStatus(t.id, 'blocked', { reason, force: true });
        this.o.setAgent(job.agentId, failed ? { state: 'error', activity: `${t.id}: ${this.failureText(outcome)}` } : { state: 'blocked', activity: `${t.id} bloccato` });
        this.o.notify('warn', `${this.o.nameOf(job.agentId)}: ${t.id} ${failed ? 'è fallito' : 'è bloccato'} (${reason})`);
      }
      return;
    }
    if (t.status === 'blocked') {
      this.o.setAgent(job.agentId, { state: 'blocked', activity: `${t.id} bloccato` });
      this.o.notify('warn', `${this.o.nameOf(job.agentId)} è bloccato su ${t.id}: ${t.blockedReason ?? ''}`);
      return;
    }
    this.o.setAgent(job.agentId, { state: 'idle', activity: 'libero' });
  }

  /** Un worker ha finito: test del repository, poi review del lead (o decisione di merge diretta). */
  private async afterWorkerDone(taskId: string): Promise<void> {
    if (this.reviewing.has(taskId)) return;
    this.reviewing.add(taskId);
    try {
      const t = this.o.tasks.get(taskId);
      if (!t || t.status !== 'review' || !t.repoId || !t.worktree) return;
      const worker = t.assignee;
      await this.o.repos.refresh(t.repoId);
      const files = await this.o.repos.diff(t.repoId, t.worktree);
      if (!files.length) {
        // niente da unire (report, analisi): si chiude senza test né merge
        await this.o.openMergeDecision(t, t.summary ?? 'nessuna modifica');
        return;
      }

      // loop dei test: dopo ogni task, nel worktree, con l'ambiente sicuro degli agenti
      const ci = await this.runCi(t);
      if (ci && !ci.pass) {
        const fixes = this.st.ciFixes[t.id] ?? 0;
        if (fixes < 1 && worker && this.o.agent(worker)?.active) {
          this.st.ciFixes[t.id] = fixes + 1;
          this.o.store.markDirty();
          this.sendBackToWorker(
            t.id,
            `I test sono falliti dopo ${t.id} (${ci.command}):\n${ci.output}\n\nCorreggi gli errori, rilancia i test, poi update_task("${t.id}", status "review", summary).`,
          );
          return;
        }
        // secondo fallimento: si va comunque in review, con il fallimento annotato
        this.o.tasks.update(t.id, { summary: `${t.summary ? `${t.summary}\n` : ''}ATTENZIONE: i test falliscono ancora (${ci.command}).` });
        this.o.bus.feed('ci', `${t.id}: i test falliscono anche dopo la correzione: va in review con il fallimento annotato`, worker ? { agentId: worker } : {});
      }
      const ciNote = ciReport(ci);
      this.lastCi.set(t.id, ciNote);

      // verifica visuale (se configurata per il repository): la esegue Keystone, non l'agente
      const visual = await this.runVisualCheck(t.id);
      const current = this.o.tasks.get(t.id);
      if (!current || current.status !== 'review') return; // annullato o rimandato nel frattempo
      if (worker) this.o.setAgent(worker, { state: 'idle', activity: `${t.id} in review` });

      if (this.opts.leadReview && this.o.agent(this.lead.id)?.active) {
        this.o.setAgent(this.lead.id, { state: 'reading', activity: `rivede ${t.id}` });
        const repo = current.repoId ? this.o.repos.get(current.repoId) : undefined;
        const images = repo?.visual?.agentScreenshots && visual ? this.leadImages(current.id, visual) : [];
        this.enqueue({
          kind: 'review',
          agentId: this.lead.id,
          taskId: t.id,
          ...(t.goalId ? { goalId: t.goalId } : {}),
          sessionKey: `${this.lead.id}:${t.goalId ?? 'adhoc'}`,
          prompt: reviewPrompt(this.promptEnv(), current, files, ciNote, { withImages: images.length > 0 }),
          ...(images.length ? { images } : {}),
        });
      } else {
        await this.o.openMergeDecision(t, t.summary ?? 'Lavoro completato.');
      }
    } finally {
      this.reviewing.delete(taskId);
    }
  }

  /**
   * La verifica visuale del task, se il repository la prevede: Keystone avvia l'app dal branch di
   * partenza e dal worktree, esegue i passaggi dichiarati dal worker e cattura le schermate.
   * Senza browser chiede il permesso di scaricare Chromium. Restituisce l'esito (undefined se la
   * verifica non è configurata).
   */
  private async runVisualCheck(taskId: string): Promise<VisualReport | undefined> {
    const t = this.o.tasks.get(taskId);
    const repo = t?.repoId ? this.o.repos.get(t.repoId) : undefined;
    if (!t || !repo || !t.worktree) return undefined;
    if (!repo.visual) {
      if (t.visual) this.o.tasks.update(t.id, { visual: null });
      return undefined;
    }
    const cfg = repo.visual;
    const worker = t.assignee;
    const skipped = (note: string): VisualReport => {
      const r: VisualReport = { status: 'skipped', note, at: this.o.now(), checks: [], problems: [] };
      this.o.tasks.update(t.id, { visual: r });
      this.o.bus.feed('ci', `${t.id}: verifica visuale non eseguita (${note})`, worker ? { agentId: worker } : {});
      return r;
    };
    if (!t.visualChecks?.length) return skipped('il worker non ha indicato pagine da verificare');
    let browser = this.o.visual.findBrowser();
    if (!browser) {
      const ok = await this.askBrowserInstall(t);
      if (!ok.allowed) return skipped(ok.why);
      browser = this.o.visual.findBrowser();
      if (!browser) return skipped('Chromium scaricato ma non trovato');
    }
    const wt = this.o.repos.requireWorktree(repo.id, t.worktree);
    this.o.tasks.update(t.id, { visual: { status: 'running', at: this.o.now(), checks: [], problems: [] } });
    if (worker) {
      this.o.setAgent(worker, { state: 'testing', activity: `verifica visuale di ${t.id}` });
      this.o.agentLog(worker, 'test', `verifica visuale: ${t.visualChecks.length} pagine, app avviata con "${cfg.command}" (${browser.label})`);
    }
    // "prima" = il punto da cui è partito il branch dell'agente
    const fork = await git(repo.path, ['merge-base', wt.base, wt.branch], { allowFail: true });
    const baseRef = fork.code === 0 && fork.stdout.trim() ? fork.stdout.trim() : wt.base;
    const m = worker ? this.member(worker) : undefined;
    let r: VisualReport;
    try {
      // una sola app per volta per repository (prove dei worker e altre verifiche aspettano)
      r = await this.o.withVisualLock(repo.id, () => this.o.visual.run({
        repo: { ...repo, visual: cfg },
        task: t,
        worktreePath: wt.path,
        baseRef,
        shotsDir: this.o.visualShotsDir(t.id),
        browser,
        env: agentEnv(process.env, { agentId: worker ?? 'visual', name: m?.name ?? 'Verifica visuale', cwd: wt.path }),
        now: this.o.now,
      }));
    } catch (e) {
      r = { status: 'failed', note: 'errore della verifica', at: this.o.now(), checks: [], problems: [truncate((e as Error).message ?? String(e), 300)] };
    }
    this.o.tasks.update(t.id, { visual: r });
    const summary = visualSummary(r);
    if (worker) this.o.agentLog(worker, r.status === 'done' && !r.problems.length ? 'test' : 'error', summary);
    this.o.bus.feed('ci', `${t.id}: ${summary.split('\n')[0]}`, worker ? { agentId: worker } : {});
    return r;
  }

  /**
   * Chiede il permesso di scaricare Chromium in ~/.keystone/browsers (una sola decisione aperta,
   * condivisa tra i task che la aspettano). Dopo il sì lo scarica.
   */
  private async askBrowserInstall(t: Task): Promise<{ allowed: true } | { allowed: false; why: string }> {
    const existing = this.o.decisions.open().find((d) => d.kind === 'permission' && d.tool === BROWSER_TOOL);
    const d =
      existing ??
      this.o.createDecision({
        agentId: this.lead.id,
        kind: 'permission',
        tool: BROWSER_TOOL,
        question: 'Scaricare Chromium per la verifica visuale?',
        command: `playwright install chromium   (in ${this.o.browsersDir}, circa 150 MB)`,
        context: `La verifica visuale di ${t.id} ha bisogno di un browser e non ho trovato Edge né Chrome. Chromium viene scaricato da Playwright nella cartella di Keystone, non nel repository. Se neghi, la review di ${t.id} prosegue senza schermate.`,
        options: BROWSER_OPTIONS,
        alwaysAsk: true,
        taskId: t.id,
      });
    const answered = await this.o.decisions.wait(d.id);
    if (answered.status !== 'answered' || answered.answer?.option !== BROWSER_OPTIONS[0]) return { allowed: false, why: 'download di Chromium non consentito' };
    if (this.o.visual.findBrowser()) return { allowed: true }; // già scaricato per un altro task
    this.o.bus.feed('system', `Scarico Chromium in ${this.o.browsersDir}…`);
    const res = await this.o.visual.installBrowser();
    if (!res.ok) {
      this.o.notify('warn', `Download di Chromium non riuscito: ${truncate(res.output, 200)}`);
      return { allowed: false, why: `download di Chromium non riuscito: ${truncate(res.output, 200)}` };
    }
    this.o.bus.feed('system', 'Chromium scaricato: la verifica visuale può partire');
    return { allowed: true };
  }

  /**
   * Prova interfaccia (try_ui): Keystone avvia l'app dal worktree del worker, esegue i passaggi e
   * restituisce esito, console, errori e richieste fallite. Limiti per turno (TRY_UI_LIMITS); la
   * schermata va all'agente solo se l'utente l'ha consentito per il repository.
   */
  private async tryUi(agentId: string, taskId: string, checks: VisualCheck[], tries: { count: number; usedMs: number }, aborted: () => boolean): Promise<TeamToolResult> {
    const err = (text: string): TeamToolResult => ({ text: `Errore: ${text}`, isError: true });
    const t = this.o.tasks.get(taskId);
    const repo = t?.repoId ? this.o.repos.get(t.repoId) : undefined;
    if (!t || !repo || !t.worktree) return err(`${taskId} non ha un worktree`);
    if (!repo.visual) return err(`la verifica visuale non è configurata per ${repo.name}: la prova dell'interfaccia non è disponibile (può configurarla l'utente nella pagina Repository)`);
    if (tries.count >= TRY_UI_LIMITS.perTurn) return err(`hai già fatto ${tries.count} prove in questo turno (massimo ${TRY_UI_LIMITS.perTurn})`);
    const remaining = TRY_UI_LIMITS.msPerTurn - tries.usedMs;
    if (remaining <= 5_000) return err(`tempo per le prove di questo turno esaurito (${TRY_UI_LIMITS.msPerTurn / 60_000} minuti)`);
    const browser = this.o.visual.findBrowser();
    if (!browser) return err("nessun browser disponibile (né Edge né Chrome): l'utente potrà consentire il download di Chromium alla review");
    const wt = this.o.repos.requireWorktree(repo.id, t.worktree);
    const cfg = repo.visual;
    tries.count++;
    const m = this.member(agentId);
    this.o.agentLog(agentId, 'test', `prova interfaccia: ${checks.length} pagine, app avviata con "${cfg.command}" (${browser.label})`);
    const started = Date.now();
    try {
      const r = await this.o.withVisualLock(repo.id, async () => {
        if (aborted()) throw new Error('il turno è stato interrotto');
        return this.o.visual.tryRun({
          repo: { ...repo, visual: cfg },
          checks,
          worktreePath: wt.path,
          shotsDir: this.o.visualTryDir(t.id),
          browser,
          env: agentEnv(process.env, { agentId, name: m?.name ?? agentId, cwd: wt.path }),
          maxMs: Math.min(TRY_UI_LIMITS.msPerTry, remaining),
        });
      });
      const dir = this.o.visualTryDir(t.id);
      const images = cfg.agentScreenshots ? r.pages.flatMap((p) => (p.side.shot ? [{ path: path.join(dir, `${p.side.shot.id}.png`), caption: `${p.name}: prova` }] : [])) : [];
      const text = tryReport(r, { withImages: images.length > 0 });
      this.o.agentLog(agentId, r.status === 'done' && !r.pages.some((p) => p.side.error) ? 'test' : 'error', text);
      return { text, ...(r.status === 'failed' ? { isError: true } : {}), ...(images.length ? { images } : {}) };
    } catch (e) {
      return err(`prova non riuscita: ${truncate((e as Error).message ?? String(e), 300)}`);
    } finally {
      tries.usedMs += Date.now() - started;
    }
  }

  /** Le schermate per il lead (solo con l'opzione attiva): prima e dopo di ogni pagina, con didascalia. */
  private leadImages(taskId: string, r: VisualReport): Array<{ path: string; caption: string }> {
    if (r.status !== 'done') return [];
    const dir = this.o.visualShotsDir(taskId);
    const out: Array<{ path: string; caption: string }> = [];
    for (const c of r.checks) {
      for (const [side, label] of [['before', 'prima'], ['after', 'dopo']] as const) {
        const shot = c[side].shot;
        if (shot) out.push({ path: path.join(dir, `${shot.id}.png`), caption: `${c.name}: ${label}${c.caption ? ` (atteso: ${c.caption})` : ''}` });
      }
    }
    return out.slice(0, MAX_LEAD_IMAGES);
  }

  /** Esito dei test dell'ultimo giro per un task (per il testo della decisione di merge). */
  ciNoteOf(taskId: string): string | undefined {
    return this.lastCi.get(taskId);
  }

  /** Esegue i test del repository target nel worktree del task. */
  private async runCi(t: Task) {
    if (!t.repoId || !t.worktree) return undefined;
    const wt = this.o.repos.requireWorktree(t.repoId, t.worktree);
    const command = this.opts.ciCommand ?? this.o.repos.detectTestCommand(wt.path);
    const worker = t.assignee;
    if (!command) {
      this.o.tasks.update(t.id, { ci: 'unknown' });
      if (worker) this.o.agentLog(worker, 'test', 'nessun comando di test riconosciuto: test non eseguiti');
      return undefined;
    }
    this.o.tasks.update(t.id, { ci: 'running' });
    this.o.repos.setCi(t.repoId, 'running');
    if (worker) {
      this.o.setAgent(worker, { state: 'testing', activity: `test di ${t.id}` });
      this.o.agentLog(worker, 'test', `test: ${command}`);
    }
    const m = worker ? this.member(worker) : undefined;
    const env = agentEnv(process.env, { agentId: worker ?? 'ci', name: m?.name ?? 'CI', cwd: wt.path }) as NodeJS.ProcessEnv;
    const res = await this.o.repos.runTests(t.repoId, t.worktree, { command, env, timeoutMs: this.opts.ciTimeoutMs ?? 10 * 60_000 });
    if (!res) return undefined;
    this.o.tasks.update(t.id, { ci: res.pass ? 'pass' : 'fail' });
    this.o.repos.setCi(t.repoId, res.pass ? 'pass' : 'fail');
    if (worker) this.o.agentLog(worker, res.pass ? 'test' : 'error', `test ${res.pass ? 'superati' : 'FALLITI'} (${(res.durationMs / 1000).toFixed(1)} s)\n${lastLines(res.output, 12)}`);
    this.o.bus.feed('ci', `${t.id}: test ${res.pass ? 'superati' : 'falliti'} (${res.command})`, worker ? { agentId: worker } : {});
    return res;
  }

  /**
   * Un merge approvato è in conflitto con la base (nel frattempo è stato unito altro lavoro): il
   * branch torna al worker, che unisce la base nel suo worktree, risolve e richiede la review.
   * Restituisce false se non c'è nessuno a cui rimandarlo (decide l'utente).
   */
  onMergeConflict(t: Task, info: { base: string; branch: string; files: string[] }): boolean {
    if (!t.assignee || !this.o.agent(t.assignee)?.active) return false;
    delete this.st.ciFixes[t.id];
    this.o.store.markDirty();
    this.sendBackToWorker(
      t.id,
      `${this.o.userName} ha approvato il merge di ${t.id}, ma ${info.branch} ora è in conflitto con ${info.base} (nel frattempo è stato unito altro lavoro) in: ${info.files.join(', ') || '(vedi git status)'}.\n` +
        `Nel tuo worktree esegui \`git merge ${info.base}\`, risolvi ogni conflitto tenendo le modifiche di entrambe le parti, rilancia i test e committa il merge (git commit --no-edit). ` +
        `Non fare rebase, reset né checkout di altri branch. Poi update_task("${t.id}", status "review", summary).`,
    );
    return true;
  }

  /** Riprende la sessione del worker con un feedback (modifiche richieste, conflitto, test falliti). */
  sendBackToWorker(taskId: string, prompt: string): void {
    const t = this.o.tasks.get(taskId);
    if (!t?.assignee) return;
    const a = this.o.agent(t.assignee);
    if (!a?.active) {
      this.o.tasks.setStatus(t.id, 'todo', { force: true, summary: truncate(prompt, 400) });
      this.o.tasks.update(t.id, { assignee: null });
      this.tick();
      return;
    }
    if (t.status !== 'doing') this.o.tasks.setStatus(t.id, 'doing', { force: true });
    this.o.setAgent(t.assignee, { taskId: t.id, ...(t.worktree ? { worktree: t.worktree } : {}), state: 'thinking', activity: `rivede ${t.id}` });
    this.enqueue({ kind: 'followup', agentId: t.assignee, taskId: t.id, ...(t.goalId ? { goalId: t.goalId } : {}), sessionKey: `${t.assignee}:${t.id}`, prompt });
  }

  // ---- intenti dell'utente ------------------------------------------------------------------

  /** Il messaggio è già nel bus: qui si decide se serve un turno per leggerlo. */
  onUserMessage(to: string): void {
    const id = to === 'all' ? this.lead.id : to;
    const a = this.o.agent(id);
    if (!a) return;
    if (!a.active) {
      this.o.bus.send(id, 'user', `(${a.name} è fuori turno: il messaggio verrà consegnato quando lo riattivi.)`);
      return;
    }
    // durante un turno arriva con il prossimo risultato di un tool, o a fine turno (deliverPending)
    if (this.running.has(id) || this.pausedJobs.has(id) || (this.queues.get(id)?.length ?? 0) > 0) return;
    const mine = this.o.bus.inbox(id).filter((m) => m.from === 'user' && (m.to === id || m.to === 'all'));
    if (!mine.length) return;
    const body = mine.map((m) => m.text).join('\n\n');
    this.o.bus.markRead(id, mine.map((m) => m.id));
    const prompt = `Messaggio di ${this.o.userName}: ${body}\n\nRispondi brevemente con send_message(to "user") e agisci se serve.`;
    if (id === this.lead.id) {
      const goal = this.o.currentGoal();
      if (!goal) {
        this.o.bus.send(this.lead.id, 'user', 'Non c\'è ancora un obiettivo: scrivilo nella console e lo pianifico.');
        return;
      }
      this.enqueue({ kind: 'followup', agentId: this.lead.id, goalId: goal.id, sessionKey: `${this.lead.id}:${goal.id}`, prompt });
      return;
    }
    const t = this.o.tasks.list().filter((x) => x.assignee === id && (x.status === 'doing' || x.status === 'review')).pop();
    if (!t) {
      this.o.bus.send(id, 'user', `Non sto lavorando a un task: giro il messaggio a ${this.lead.name}.`);
      this.o.bus.send('user', this.lead.id, `(per ${a.name}) ${body}`);
      this.onUserMessage(this.lead.id);
      return;
    }
    this.enqueue({ kind: 'followup', agentId: id, taskId: t.id, ...(t.goalId ? { goalId: t.goalId } : {}), sessionKey: `${id}:${t.id}`, prompt });
  }

  /** Messaggi dell'utente arrivati dopo l'ultimo tool del turno: un follow-up per leggerli. */
  private deliverPending(agentId: string): void {
    if (this.stopping) return;
    if (this.o.bus.inbox(agentId).some((m) => m.from === 'user')) this.onUserMessage(agentId);
  }

  onDecisionSettled(d: Decision): void {
    if (d.kind !== 'question') return;
    // durante un turno ask_user si sveglia da solo; dopo un riavvio nessuno aspetta: si riprende la sessione
    if (this.o.decisions.hasWaiters(d.id) || this.running.has(d.agentId)) return;
    const inf = this.st.inflight[d.agentId];
    if (!inf) return;
    delete this.st.inflight[d.agentId];
    const ans = [d.answer?.option, d.answer?.text].filter(Boolean).join(' — ') || '(annullata)';
    this.enqueue({
      kind: inf.kind,
      agentId: d.agentId,
      sessionKey: inf.sessionKey,
      ...(inf.taskId ? { taskId: inf.taskId } : {}),
      ...(inf.goalId ? { goalId: inf.goalId } : {}),
      prompt: `Avevi chiesto a ${this.o.userName}: "${d.question}". Risposta: ${ans}. (La domanda era stata interrotta da un riavvio dell'orchestratore.) Continua.`,
    });
  }

  /** Abbandona il worktree attivo di un task (salvando il lavoro sul branch). */
  private async windDown(t: Task, why: string): Promise<void> {
    if (!t.repoId || !t.worktree) return;
    const wt = this.o.repos.findWorktree(t.repoId, t.worktree);
    if (!wt || wt.status !== 'active') return;
    const r = this.running.get(wt.agentId);
    if (r?.job.taskId === t.id) await r.done;
    const m = this.member(wt.agentId);
    await this.o.repos.abandon(t.repoId, wt.id, `${t.id}: lavoro salvato (${why})`, { name: `Keystone ${m?.name ?? wt.agentId}`, email: `${wt.agentId}@keystone.local` });
  }

  /** L'obiettivo di un lavoro (direttamente o tramite il suo task). */
  private goalOfJob(j: { goalId?: string; taskId?: string }): string | undefined {
    return j.goalId ?? (j.taskId ? this.o.tasks.get(j.taskId)?.goalId : undefined);
  }

  private goalPaused(goalId: string | undefined): boolean {
    return !!goalId && this.o.goal(goalId)?.status === 'paused';
  }

  /**
   * Tetto di spesa raggiunto: l'obiettivo va in pausa, i suoi turni vengono fermati e restano
   * salvati (si riprendono con la stessa sessione), e arriva una decisione per l'utente.
   */
  /**
   * L'obiettivo ha raggiunto un limite: spesa (tetto in dollari), turni o minuti di lavoro. Va in
   * pausa, il lavoro resta salvato e arriva una decisione. Con il tetto di spesa o di tempo i turni
   * in corso si fermano subito (la sessione resta per riprenderli); con il limite di turni quelli
   * già avviati finiscono, ma non ne partono altri.
   */
  onBudgetReached(goalId: string, limit: GoalLimit = 'budget'): void {
    const g = this.o.goal(goalId);
    if (!g || g.status === 'paused' || g.status === 'done' || g.status === 'cancelled' || g.status === 'failed') return;
    this.o.setGoal(goalId, { status: 'paused', pausedFrom: g.status });
    if (limit !== 'turns') for (const r of this.running.values()) if (this.goalOfJob(r.job) === goalId) this.abort(r, 'budget');
    const minutes = Math.round(this.goalActiveMs(goalId) / 60_000);
    const what =
      limit === 'turns'
        ? { question: `Limite di turni raggiunto: ${g.turnsUsed ?? 0} su ${g.turnLimit}.`, unit: 'il nuovo limite di turni', feed: 'Limite di turni raggiunto' }
        : limit === 'minutes'
          ? { question: `Limite di tempo raggiunto: ${minutes} su ${g.minuteLimit} minuti di lavoro.`, unit: 'il nuovo limite in minuti', feed: 'Limite di tempo raggiunto' }
          : { question: `Tetto di spesa raggiunto: $${g.costUsd.toFixed(2)} su $${(g.budgetUsd ?? 0).toFixed(2)}.`, unit: 'il nuovo tetto in dollari', feed: 'Tetto di spesa raggiunto' };
    if (!this.o.decisions.open().some((d) => d.kind === 'budget' && d.context?.includes(`[${goalId}]`))) {
      this.o.createDecision({
        agentId: this.lead.id,
        kind: 'budget',
        question: `${what.question} Gli agenti sono fermi e il lavoro è salvato.`,
        options: BUDGET_OPTIONS,
        context: `Obiettivo [${goalId}]: ${truncate(g.text, 300)}\nLimite: ${limit}\nPer continuare scegli "${BUDGET_OPTIONS[0]}" e scrivi ${what.unit} (senza numero: il doppio di quello attuale). "${BUDGET_OPTIONS[1]}" lascia tutto fermo: potrai alzarlo più tardi.`,
      });
    }
    this.o.bus.feed('goal', `${what.feed} per "${truncate(g.text, 80)}": agenti fermi, lavoro salvato`);
  }

  /** Risposta alla decisione di limite raggiunto (spesa, turni o tempo). */
  onBudgetAnswer(d: Decision): void {
    const goalId = /\[(g\d+)\]/.exec(d.context ?? '')?.[1];
    const g = goalId ? this.o.goal(goalId) : undefined;
    if (!g || d.answer?.option !== BUDGET_OPTIONS[0]) return;
    const limit = (/\nLimite: (budget|turns|minutes)\b/.exec(d.context ?? '')?.[1] ?? 'budget') as GoalLimit;
    const asked = Number(String(d.answer?.text ?? '').replace(',', '.').match(/\d+(\.\d+)?/)?.[0]);
    const ok = Number.isFinite(asked) && asked > 0;
    if (limit === 'turns') this.setGoalLimits(g.id, { turnLimit: ok ? Math.ceil(asked) : (g.turnLimit ?? 1) * 2 });
    else if (limit === 'minutes') this.setGoalLimits(g.id, { minuteLimit: ok ? asked : (g.minuteLimit ?? 1) * 2 });
    else this.setGoalBudget(g.id, ok ? asked : (g.budgetUsd ?? 1) * 2);
  }

  /** Cambia il limite di turni o di tempo; se l'obiettivo era in pausa e ora c'è margine, riprende. */
  setGoalLimits(goalId: string, limits: { turnLimit?: number; minuteLimit?: number }): void {
    if (!this.o.goal(goalId)) return;
    this.o.setGoal(goalId, limits);
    const parts = [limits.turnLimit !== undefined ? `${limits.turnLimit} turni` : '', limits.minuteLimit !== undefined ? `${limits.minuteLimit} minuti` : ''].filter(Boolean).join(' e ');
    this.resumeIfWithinLimits(goalId, `Limite alzato a ${parts}`);
  }

  /** Cambia il tetto di un obiettivo; se era in pausa e ora c'è margine, i suoi turni riprendono. */
  setGoalBudget(goalId: string, budgetUsd: number): void {
    if (!this.o.goal(goalId)) return;
    this.o.setGoal(goalId, { budgetUsd });
    this.resumeIfWithinLimits(goalId, `Tetto alzato a $${budgetUsd.toFixed(2)}`);
  }

  /** Un obiettivo in pausa riprende solo se è dentro TUTTI i suoi limiti; altrimenti arriva la decisione per il prossimo. */
  private resumeIfWithinLimits(goalId: string, why: string): void {
    const g = this.o.goal(goalId);
    if (!g || g.status !== 'paused') return;
    if (g.budgetUsd !== undefined && g.costUsd >= g.budgetUsd) return;
    for (const d of this.o.decisions.open().filter((x) => x.kind === 'budget' && x.context?.includes(`[${goalId}]`))) this.o.decisions.cancel(d.id, 'limite aggiornato');
    const other = this.limitReached(goalId);
    if (other) {
      // dentro il limite appena alzato ma fuori da un altro: torna in pausa con la decisione per quello
      this.o.setGoal(goalId, { status: g.pausedFrom ?? 'active', pausedFrom: undefined });
      this.onBudgetReached(goalId, other);
      return;
    }
    this.o.setGoal(goalId, { status: g.pausedFrom ?? 'active', pausedFrom: undefined });
    this.o.bus.feed('goal', `${why}: gli agenti riprendono "${truncate(g.text, 80)}"`);
    // i turni fermati riprendono con la stessa sessione
    for (const [agentId, inf] of Object.entries(this.st.inflight)) {
      if (this.goalOfJob(inf) !== goalId || this.running.has(agentId) || this.openQuestionOf(agentId)) continue;
      delete this.st.inflight[agentId];
      this.enqueue({ kind: inf.kind, agentId, sessionKey: inf.sessionKey, prompt: `Il lavoro era stato fermato perché l'obiettivo aveva raggiunto un limite (spesa, turni o tempo); ora il limite è stato alzato. Riprendi da dove eri rimasto.\n\nIl lavoro era:\n${inf.prompt}`, ...(inf.taskId ? { taskId: inf.taskId } : {}), ...(inf.goalId ? { goalId: inf.goalId } : {}) });
    }
    this.o.store.markDirty();
    for (const id of this.queues.keys()) this.pump(id);
    this.tick();
  }

  async onTaskAction(t: Task, action: 'cancel' | 'retry' | 'prioritize' | 'reassign', arg?: string): Promise<void> {
    if (action === 'prioritize') {
      const p = Number(arg ?? '1');
      if (!Number.isInteger(p)) throw new Error('la priorità deve essere un numero intero');
      this.o.tasks.update(t.id, { priority: p });
    } else if (action === 'retry') {
      if (!['blocked', 'cancelled', 'done'].includes(t.status) && !(t.status === 'doing' && !this.hasJob(t.assignee ?? '', (j) => j.taskId === t.id))) {
        throw new Error(`${t.id} è ${t.status}: niente da riprovare`);
      }
      delete this.st.nudges[t.id];
      this.o.tasks.setStatus(t.id, 'todo', { force: true });
      this.o.tasks.update(t.id, { ci: 'unknown' });
    } else if (action === 'cancel') {
      this.dropJobs(t.id, 'cancel');
      this.o.tasks.setStatus(t.id, 'cancelled', { force: true });
      for (const d of this.o.decisions.open().filter((x) => x.taskId === t.id)) this.o.decisions.cancel(d.id, `${t.id} annullato`);
      await this.windDown(t, 'task annullato');
    } else if (action === 'reassign') {
      const to = arg ? this.o.resolveAgentId(arg) : undefined;
      if (!to || this.member(to)?.role !== 'worker') throw new Error(`"${arg ?? ''}" non è un worker`);
      if (t.assignee === to) return;
      this.dropJobs(t.id, 'cancel');
      await this.windDown(t, `riassegnato a ${this.o.nameOf(to)}`);
      if (t.status === 'doing' || t.status === 'review' || t.status === 'blocked') this.o.tasks.setStatus(t.id, 'todo', { force: true });
      this.o.tasks.update(t.id, { assignee: to });
    }
    this.tick();
  }

  private dropJobs(taskId: string, reason: AbortReason): void {
    for (const r of this.running.values()) if (r.job.taskId === taskId && r.job.agentId !== this.lead.id) this.abort(r, reason);
    for (const [id, q] of this.queues) this.queues.set(id, q.filter((j) => j.taskId !== taskId));
    for (const [id, j] of this.pausedJobs) if (j.taskId === taskId) this.pausedJobs.delete(id);
  }

  async onAgentAction(agentId: string, action: 'pause' | 'resume' | 'stop' | 'spawn'): Promise<void> {
    const a = this.o.agent(agentId);
    if (!a || !this.member(agentId)) throw new Error(`nessun agente ${agentId}`);
    if (action === 'pause') {
      this.o.setAgent(agentId, { paused: true, activity: 'in pausa' });
      const r = this.running.get(agentId);
      if (r) this.abort(r, 'pause');
      else this.o.setAgent(agentId, { state: 'idle' });
    } else if (action === 'resume' || action === 'spawn') {
      this.o.setAgent(agentId, { paused: false, active: true, ...(a.state === 'idle' ? { activity: 'pronto' } : {}) });
      const job = this.pausedJobs.get(agentId);
      if (job) {
        this.pausedJobs.delete(agentId);
        this.enqueue(job);
      }
      this.pump(agentId);
      this.deliverPending(agentId);
    } else if (action === 'stop') {
      this.o.setAgent(agentId, { active: false, paused: false });
      const r = this.running.get(agentId);
      if (r) this.abort(r, 'stop');
      this.queues.delete(agentId);
      this.pausedJobs.delete(agentId);
      for (const d of this.o.decisions.open().filter((x) => x.agentId === agentId && x.kind !== 'merge')) this.o.decisions.cancel(d.id, `${a.name} è fuori turno`);
      // i suoi task tornano sul tabellone: il prossimo worker riparte dal suo branch
      for (const t of this.o.tasks.list().filter((x) => x.assignee === agentId && x.status === 'doing')) {
        await this.windDown(t, `${a.name} fuori turno`);
        this.o.tasks.setStatus(t.id, 'todo', { force: true });
        this.o.tasks.update(t.id, { assignee: null });
      }
      this.o.setAgent(agentId, { state: 'idle', activity: 'fuori turno', taskId: undefined, worktree: undefined });
    }
    this.tick();
  }

  /** Per i test: attende che non ci siano turni in corso né in coda. */
  async idle(timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    // i lavori di un obiettivo in pausa non possono partire: non sono attività
    const runnable = () => [...this.queues.values()].some((q) => q.some((j) => !this.goalPaused(this.goalOfJob(j))));
    for (;;) {
      const queued = runnable();
      if (!this.running.size && !queued && !this.tickQueued && !this.reviewing.size) {
        await new Promise((r) => setTimeout(r, 20));
        const again = runnable();
        if (!this.running.size && !again && !this.tickQueued && !this.reviewing.size) return;
      }
      if (Date.now() - start > timeoutMs) throw new Error('il team non si è fermato in tempo');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

/** Descrizione leggibile di una chiamata a un tool del team (undefined se non è un tool del team). */
function describeTeamCall(tool: string, input: Record<string, unknown>): string | undefined {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (tool) {
    case 'ask_user':
      return `chiede: ${s('question')}${Array.isArray(input.options) && input.options.length ? ` (${(input.options as string[]).join(' / ')})` : ''}`;
    case 'send_message':
      return `messaggio a ${s('to')}: ${s('text')}`;
    case 'write_memory':
      return `scrive in memoria: ${s('title')}`;
    case 'read_memory':
      return `legge la memoria${s('id') ? `: ${s('id')}` : s('query') ? `: "${s('query')}"` : ''}`;
    case 'update_task':
      return `aggiorna ${s('task_id')}${s('status') ? ` → ${s('status')}` : ''}${s('summary') ? `: ${s('summary')}` : ''}`;
    case 'report_status':
      return `stato: ${s('activity')}`;
    case 'list_tasks':
      return 'guarda il tabellone';
    case 'create_task':
      return `crea il task "${s('title')}"${Array.isArray(input.deps) && input.deps.length ? ` (dopo ${(input.deps as string[]).join(', ')})` : ''}`;
    case 'request_merge':
      return `propone il merge di ${s('task_id')}`;
    case 'submit_report':
      return `manda il resoconto di ${s('task_id')}${Array.isArray(input.visual_checks) && input.visual_checks.length ? ` (${input.visual_checks.length} pagine da verificare)` : ''}`;
    case 'try_ui':
      return `prova l'interfaccia di ${s('task_id')}${Array.isArray(input.checks) ? ` (${input.checks.length} pagine)` : ''}`;
    default:
      return undefined;
  }
}

function stateForTool(tool: string, input: Record<string, unknown>): AgentState | undefined {
  if (READ_TOOLS.has(tool)) return 'reading';
  if (EDIT_TOOLS.has(tool)) return 'editing';
  if (tool === 'Bash' || tool === 'PowerShell') return TEST_RE.test(String(input.command ?? '')) ? 'testing' : 'running';
  if (tool === 'ask_user') return 'waiting_user';
  return undefined;
}
