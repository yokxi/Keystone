// Protocollo Keystone v1: entità e messaggi scambiati tra orchestratore e interfaccia.
//
// Gli schemi zod sono la fonte di verità: l'orchestratore valida ogni messaggio in arrivo, i test
// validano anche quelli in uscita, e docs/protocol.md li descrive (un test verifica che ogni tipo
// di messaggio sia documentato).
//
// Ogni messaggio è un oggetto JSON in un frame WebSocket: { v: 1, type, id?, ...payload }.
import { z } from 'zod';
import { Skill, SkillDraft, SkillRef, SkillSource, SKILL_ID_RE } from './skills.js';

export const PROTOCOL_VERSION = 1 as const;

const Id = z.string().min(1).max(200);
const Ts = z.number().int().nonnegative();

// ---- enumerazioni ---------------------------------------------------------------------------

export const EngineId = z.enum(['sim', 'claude', 'codex']);
export type EngineId = z.infer<typeof EngineId>;

export const Role = z.enum(['lead', 'worker']);
export type Role = z.infer<typeof Role>;

export const AgentState = z.enum(['idle', 'thinking', 'reading', 'editing', 'running', 'testing', 'waiting_user', 'blocked', 'done', 'error']);
export type AgentState = z.infer<typeof AgentState>;

export const TaskStatus = z.enum(['todo', 'doing', 'review', 'done', 'blocked', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const CiStatus = z.enum(['unknown', 'running', 'pass', 'fail']);
export type CiStatus = z.infer<typeof CiStatus>;

export const LogKind = z.enum(['text', 'tool', 'result', 'error', 'diff', 'test', 'permission']);
export type LogKind = z.infer<typeof LogKind>;

export const DecisionKind = z.enum(['question', 'permission', 'merge', 'budget']);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const DecisionStatus = z.enum(['open', 'answered', 'cancelled']);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

/** paused: fermato perché ha raggiunto il tetto di spesa (riprende quando il tetto viene alzato) */
export const GoalStatus = z.enum(['planning', 'active', 'paused', 'done', 'failed', 'cancelled']);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const FeedKind = z.enum(['goal', 'plan', 'task', 'message', 'decision', 'merge', 'ci', 'memory', 'system', 'error', 'user']);
export type FeedKind = z.infer<typeof FeedKind>;

export const WorktreeStatus = z.enum(['active', 'merged', 'abandoned']);
export type WorktreeStatus = z.infer<typeof WorktreeStatus>;

export const NotifyLevel = z.enum(['info', 'warn', 'need_user']);
export type NotifyLevel = z.infer<typeof NotifyLevel>;

/** Opzioni fisse delle decisioni di merge e di permesso (l'interfaccia le mostra così). */
export const MERGE_OPTIONS = ['Merge', 'Richiedi modifiche', 'Rifiuta'] as const;
export const PERMISSION_OPTIONS = ['Consenti una volta', 'Consenti sempre per questo agente', 'Nega'] as const;
/** Decisione di tetto di spesa raggiunto: il testo della risposta può indicare il nuovo tetto in dollari. */
export const BUDGET_OPTIONS = ['Aumenta il tetto', 'Lascia in pausa'] as const;

// ---- entità ---------------------------------------------------------------------------------

export const Agent = z.object({
  id: Id,
  name: z.string(),
  role: Role,
  engine: EngineId,
  /** modello in uso, come lo mostra l'interfaccia (es. "Opus 5.5", "sim") */
  model: z.string(),
  state: AgentState,
  /** una riga su cosa sta facendo */
  activity: z.string(),
  taskId: Id.optional(),
  worktree: Id.optional(),
  /** in pausa: il task resta suo */
  paused: z.boolean(),
  /** fuori turno: non riceve lavoro finché non viene riattivato */
  active: z.boolean(),
  costUsd: z.number().nonnegative(),
  tokens: z.number().int().nonnegative(),
  /** le skill ricevute nell'ultimo turno (assente: nessun turno ancora) */
  skills: z.array(SkillRef).optional(),
});
export type Agent = z.infer<typeof Agent>;

export const LogEntry = z.object({ ts: Ts, kind: LogKind, text: z.string() });
export type LogEntry = z.infer<typeof LogEntry>;

/** Un passaggio di una verifica visuale (eseguito da Keystone con Playwright, non dall'agente). */
export const VisualStep = z.discriminatedUnion('action', [
  /** apre un percorso dell'app (relativo all'URL configurato, sempre sulla stessa origine) */
  z.object({ action: z.literal('goto'), path: z.string().max(500) }),
  z.object({ action: z.literal('click'), selector: z.string().min(1).max(300) }),
  z.object({ action: z.literal('fill'), selector: z.string().min(1).max(300), value: z.string().max(2000) }),
  z.object({ action: z.literal('press'), selector: z.string().min(1).max(300), key: z.string().min(1).max(50) }),
  /** aspetta che un elemento sia visibile */
  z.object({ action: z.literal('wait'), selector: z.string().min(1).max(300) }),
]);
export type VisualStep = z.infer<typeof VisualStep>;

/** Una pagina da verificare: si apre `path`, si eseguono i passaggi, si cattura la schermata. */
export const VisualCheck = z.object({
  name: z.string().min(1).max(100),
  path: z.string().max(500),
  steps: z.array(VisualStep).max(30),
  /** cosa si dovrebbe vedere (didascalia nella review) */
  caption: z.string().max(300),
});
export type VisualCheck = z.infer<typeof VisualCheck>;

/** Il resoconto strutturato del worker a fine task. */
export const WorkReport = z.object({
  request: z.string().max(4000),
  changes: z.string().max(8000),
  why: z.string().max(8000),
  verification: z.string().max(8000),
  openIssues: z.string().max(4000),
});
export type WorkReport = z.infer<typeof WorkReport>;

/** Una schermata catturata (il file sta in ~/.keystone, mai nel repository). */
export const VisualShot = z.object({ id: z.string().regex(/^[a-z0-9-]{1,80}$/), error: z.string().optional() });
/** Limiti della diagnostica raccolta per pagina e per lato (testi troncati, elenchi limitati). */
export const DIAG_LIMITS = { console: 50, errors: 20, requests: 50, text: 500, error: 1000, url: 300 } as const;
/** Un messaggio della console del browser (type: log, info, warning, error, debug…). */
export const ConsoleEntry = z.object({ type: z.string().max(20), text: z.string().max(DIAG_LIMITS.text) });
export type ConsoleEntry = z.infer<typeof ConsoleEntry>;
/** Una richiesta fallita: errore di rete, risposta 4xx/5xx o richiesta bloccata perché non locale. */
export const FailedRequest = z.object({
  url: z.string().max(DIAG_LIMITS.url),
  method: z.string().max(10).optional(),
  status: z.number().int().optional(),
  failure: z.string().max(200).optional(),
  /** bloccata da Keystone (non locale) */
  blocked: z.boolean().optional(),
});
export type FailedRequest = z.infer<typeof FailedRequest>;
/** Console, errori JavaScript non gestiti e richieste fallite di una pagina. */
export const PageDiagnostics = z.object({
  console: z.array(ConsoleEntry).max(DIAG_LIMITS.console),
  errors: z.array(z.string().max(DIAG_LIMITS.error)).max(DIAG_LIMITS.errors),
  failedRequests: z.array(FailedRequest).max(DIAG_LIMITS.requests),
  /** alcune voci sono state tralasciate per i limiti */
  truncated: z.boolean().optional(),
});
export type PageDiagnostics = z.infer<typeof PageDiagnostics>;
export const VisualSide = z.object({ shot: VisualShot.optional(), error: z.string().optional(), diagnostics: PageDiagnostics.optional() });
export type VisualSide = z.infer<typeof VisualSide>;
/** Configurazione della verifica visuale di un repository. */
export const VisualConfig = z.object({
  /** il comando che avvia l'app, eseguito nella cartella del branch (es. "npm run dev") */
  command: z.string().min(1).max(1000),
  /** solo rete locale: http(s) su localhost, 127.0.0.1 o [::1] */
  url: z.string().min(1).max(500),
  startTimeoutSec: z.number().int().min(5).max(600),
  /** gli agenti vedono le schermate: il lead nella review, il worker con try_ui (costa token; disattivato di default) */
  agentScreenshots: z.boolean().optional(),
});
export type VisualConfig = z.infer<typeof VisualConfig>;

export const VisualReport = z.object({
  /** running: in corso; done: eseguita; skipped: non eseguita (motivo in note); failed: l'app non si è avviata */
  status: z.enum(['running', 'done', 'skipped', 'failed']),
  note: z.string().optional(),
  at: Ts,
  checks: z.array(z.object({ name: z.string(), caption: z.string(), before: VisualSide, after: VisualSide })),
  /** problemi di avvio o di esecuzione, da mostrare nella review */
  problems: z.array(z.string()),
});
export type VisualReport = z.infer<typeof VisualReport>;

export const Task = z.object({
  id: Id,
  title: z.string().min(1),
  description: z.string().optional(),
  status: TaskStatus,
  /** id dei task che devono essere completati (merge approvato) prima di questo */
  deps: z.array(Id),
  assignee: Id.optional(),
  priority: z.number().int(),
  goalId: Id.optional(),
  repoId: Id.optional(),
  branch: z.string().optional(),
  worktree: Id.optional(),
  ci: CiStatus,
  summary: z.string().optional(),
  blockedReason: z.string().optional(),
  /** resoconto strutturato del worker (submit_report) */
  report: WorkReport.optional(),
  /** pagine e passaggi da verificare dichiarati dal worker */
  visualChecks: z.array(VisualCheck).max(10).optional(),
  /** esito della verifica visuale eseguita da Keystone */
  visual: VisualReport.optional(),
  createdBy: Id,
  createdAt: Ts,
  updatedAt: Ts,
});
export type Task = z.infer<typeof Task>;

export const Goal = z.object({
  id: Id,
  text: z.string().min(1),
  status: GoalStatus,
  /** 0..1 */
  progress: z.number().min(0).max(1),
  repoId: Id.optional(),
  /** spesa registrata per l'obiettivo in dollari (i motori che riportano solo token contano 0) */
  costUsd: z.number().nonnegative(),
  /** parte di costUsd contata per prudenza su sessioni riprese, non ancora riconciliata */
  costUnreconciledUsd: z.number().nonnegative().optional(),
  /** tetto di spesa in dollari; assente = nessun tetto */
  budgetUsd: z.number().positive().optional(),
  /** limite di turni degli agenti per l'obiettivo (assente = nessun limite) e turni avviati */
  turnLimit: z.number().int().positive().optional(),
  turnsUsed: z.number().int().nonnegative().optional(),
  /** limite di minuti di lavoro degli agenti (senza le attese di una tua risposta) e tempo usato */
  minuteLimit: z.number().positive().optional(),
  activeMs: z.number().nonnegative().optional(),
  /** lo stato da ripristinare quando un obiettivo in pausa riprende */
  pausedFrom: GoalStatus.optional(),
  createdAt: Ts,
});
export type Goal = z.infer<typeof Goal>;

export const DecisionAnswer = z.object({ option: z.string().optional(), text: z.string().optional() });
export type DecisionAnswer = z.infer<typeof DecisionAnswer>;

export const Decision = z.object({
  id: Id,
  agentId: Id,
  kind: DecisionKind,
  question: z.string().min(1),
  options: z.array(z.string()),
  context: z.string().optional(),
  status: DecisionStatus,
  answer: DecisionAnswer.optional(),
  /** perché è stata annullata (status "cancelled") */
  cancelReason: z.string().optional(),
  taskId: Id.optional(),
  repoId: Id.optional(),
  worktree: Id.optional(),
  /** permesso: il tool richiesto (Bash, Edit, ...) */
  tool: z.string().optional(),
  /** permesso: il comando o la chiamata completa, senza tagli */
  command: z.string().optional(),
  /** permesso: richiede sempre approvazione ("Consenti sempre" non è disponibile) */
  alwaysAsk: z.boolean().optional(),
  createdAt: Ts,
  answeredAt: Ts.optional(),
});
export type Decision = z.infer<typeof Decision>;

export const Worktree = z.object({
  id: Id,
  repoId: Id,
  agentId: Id,
  taskId: Id.optional(),
  branch: z.string(),
  /** branch di destinazione del merge */
  base: z.string(),
  path: z.string(),
  status: WorktreeStatus,
  files: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type Worktree = z.infer<typeof Worktree>;

export const Repo = z.object({
  id: Id,
  name: z.string(),
  path: z.string(),
  /** branch attualmente estratto nel checkout dell'utente */
  branch: z.string(),
  /** verifica visuale: come avviare l'app (assente = disattivata) */
  visual: VisualConfig.optional(),
  /** branch in cui si fanno i merge (e da cui partono i worktree); assente = il branch aperto */
  mergeTarget: z.string().optional(),
  /** branch locali tra cui scegliere la destinazione (esclusi quelli degli agenti) */
  branches: z.array(z.string()).optional(),
  dirty: z.boolean(),
  ci: CiStatus,
  worktrees: z.array(Worktree),
});
export type Repo = z.infer<typeof Repo>;

export const MemoryEntry = z.object({
  /** "shared/<slug>" oppure "<agentId>/<slug>" */
  id: Id,
  /** "shared" oppure l'id dell'agente proprietario */
  scope: Id,
  title: z.string(),
  body: z.string(),
  author: z.string().optional(),
  updated: Ts,
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

export const FeedItem = z.object({
  ts: Ts,
  kind: FeedKind,
  text: z.string(),
  agentId: Id.optional(),
  to: Id.optional(),
});
export type FeedItem = z.infer<typeof FeedItem>;

export const OrchestratorStatus = z.object({
  version: z.string(),
  /** stato dell'autenticazione dei motori in uso */
  auth: z.enum(['ok', 'failed', 'unknown']),
  /** riga da mostrare nel banner di stato */
  message: z.string(),
  costUsd: z.number().nonnegative(),
  tokens: z.number().int().nonnegative(),
  userName: z.string(),
  /** da dove viene il tuo nome: impostazioni, --user-name, git user.name o nome utente del sistema */
  userNameSource: z.enum(['settings', 'cli', 'git', 'system']).optional(),
  /** il profilo dell'orchestratore (l'app avvisa se è diverso dal suo) */
  profile: z.string().optional(),
  /** subscription: un motore usa l'abbonamento; estimate: la spesa di un motore è stimata dai token con i prezzi indicati */
  billing: z.enum(['api', 'subscription', 'estimate']).optional(),
  /** almeno un motore riporta solo token (Codex): la spesa mostrata non comprende il suo consumo */
  costIncomplete: z.boolean().optional(),
});
export type OrchestratorStatus = z.infer<typeof OrchestratorStatus>;

export const DiffLine = z.object({
  kind: z.enum(['add', 'del', 'ctx']),
  text: z.string(),
  oldNo: z.number().int().positive().optional(),
  newNo: z.number().int().positive().optional(),
});
export type DiffLine = z.infer<typeof DiffLine>;

export const DiffHunk = z.object({
  header: z.string(),
  oldStart: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  lines: z.array(DiffLine),
});
export type DiffHunk = z.infer<typeof DiffHunk>;

export const DiffFile = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  binary: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(DiffHunk),
});
export type DiffFile = z.infer<typeof DiffFile>;

// ---- messaggi orchestratore -> interfaccia ------------------------------------------------

function envelope<T extends string>(type: T) {
  return { v: z.literal(PROTOCOL_VERSION), type: z.literal(type), id: z.string().max(100).optional() };
}

export const SnapshotMsg = z.object({
  ...envelope('snapshot'),
  status: OrchestratorStatus,
  agents: z.array(Agent),
  tasks: z.array(Task),
  goals: z.array(Goal),
  decisions: z.array(Decision),
  repos: z.array(Repo),
  memory: z.array(MemoryEntry),
  feed: z.array(FeedItem),
  /** le skill: personali e dei repository registrati */
  skills: z.array(Skill),
  /** coda recente del log di ogni agente */
  logs: z.record(z.string(), z.array(LogEntry)),
});
export const AgentUpsertMsg = z.object({ ...envelope('agent.upsert'), agent: Agent });
export const AgentLogMsg = z.object({ ...envelope('agent.log'), agentId: Id, entries: z.array(LogEntry) });
export const AgentSayMsg = z.object({ ...envelope('agent.say'), agentId: Id, to: Id.optional(), text: z.string(), ts: Ts });
export const TaskUpsertMsg = z.object({ ...envelope('task.upsert'), task: Task });
export const GoalUpsertMsg = z.object({ ...envelope('goal.upsert'), goal: Goal });
export const DecisionUpsertMsg = z.object({ ...envelope('decision.upsert'), decision: Decision });
export const RepoUpsertMsg = z.object({ ...envelope('repo.upsert'), repo: Repo });
export const MemoryUpsertMsg = z.object({ ...envelope('memory.upsert'), entry: MemoryEntry });
export const FeedAddMsg = z.object({ ...envelope('feed.add'), item: FeedItem });
export const StatusMsg = z.object({ ...envelope('status'), status: OrchestratorStatus });
/** Risposta a visual.shot.request: l'immagine come data URL PNG (solo verso il client che l'ha chiesta). */
export const VisualShotMsg = z.object({ ...envelope('visual.shot'), requestId: z.string(), dataUrl: z.string().optional(), error: z.string().optional() });
export const DiffMsg = z.object({
  ...envelope('diff'),
  requestId: z.string(),
  repoId: Id,
  worktree: Id,
  files: z.array(DiffFile),
});
/** L'elenco completo delle skill, ogni volta che cambia. */
export const SkillsMsg = z.object({ ...envelope('skills'), skills: z.array(Skill) });
export const NotifyMsg = z.object({ ...envelope('notify'), level: NotifyLevel, text: z.string() });
export const AckMsg = z.object({
  ...envelope('ack'),
  /** id del messaggio del client a cui si risponde */
  re: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
});
export const ErrorMsg = z.object({ ...envelope('error'), message: z.string(), re: z.string().optional() });

export const ServerMessage = z.discriminatedUnion('type', [
  SnapshotMsg,
  AgentUpsertMsg,
  AgentLogMsg,
  AgentSayMsg,
  TaskUpsertMsg,
  GoalUpsertMsg,
  DecisionUpsertMsg,
  RepoUpsertMsg,
  MemoryUpsertMsg,
  FeedAddMsg,
  StatusMsg,
  DiffMsg,
  VisualShotMsg,
  SkillsMsg,
  NotifyMsg,
  AckMsg,
  ErrorMsg,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Un messaggio del server senza il campo `v` (lo aggiunge il trasporto). */
export type Outbound = ServerMessage extends infer M ? (M extends { v: number } ? Omit<M, 'v'> : never) : never;

// ---- messaggi interfaccia -> orchestratore ------------------------------------------------

export const HelloMsg = z.object({ ...envelope('hello'), client: z.string().max(100), protocol: z.literal(PROTOCOL_VERSION) });
export const GoalSubmitMsg = z.object({
  ...envelope('goal.submit'),
  text: z.string().trim().min(1).max(20_000),
  repoId: Id.optional(),
  /** tetto di spesa in dollari per questo obiettivo (default: quello della configurazione) */
  budgetUsd: z.number().positive().max(100_000).optional(),
});
/** Cambia il tetto di spesa di un obiettivo; se era in pausa per il tetto e ora c'è margine, riprende. */
export const GoalBudgetMsg = z.object({ ...envelope('goal.budget'), goalId: Id, budgetUsd: z.number().positive().max(100_000) });
export const UserMessageMsg = z.object({
  ...envelope('user.message'),
  /** id o nome dell'agente, oppure "all" */
  to: Id,
  text: z.string().trim().min(1).max(20_000),
});
export const DecisionAnswerMsg = z.object({
  ...envelope('decision.answer'),
  decisionId: Id,
  /** etichetta dell'opzione, o numero 1-based come stringa */
  option: z.string().optional(),
  text: z.string().max(20_000).optional(),
});
export const TaskActionMsg = z.object({
  ...envelope('task.action'),
  taskId: Id,
  action: z.enum(['cancel', 'retry', 'prioritize', 'reassign']),
  /** prioritize: la nuova priorità; reassign: l'agente */
  arg: z.string().optional(),
});
export const AgentActionMsg = z.object({
  ...envelope('agent.action'),
  agentId: Id,
  action: z.enum(['pause', 'resume', 'stop', 'spawn']),
});
export const DiffRequestMsg = z.object({ ...envelope('diff.request'), requestId: z.string().min(1).max(100), repoId: Id, worktree: Id });
/** Anteprima della registrazione: la riga che verrebbe aggiunta al .git/config. */
export const RepoPreviewMsg = z.object({ ...envelope('repo.preview'), path: z.string().min(1) });
export const RepoAddMsg = z.object({
  ...envelope('repo.add'),
  path: z.string().min(1),
  /** l'utente ha visto l'anteprima e conferma la modifica al .git/config */
  confirmGuard: z.boolean().optional(),
});

/** Risultato di repo.preview (nel campo `result` dell'ack). */
export const RepoPreview = z.object({
  root: z.string(),
  configFile: z.string(),
  lines: z.array(z.string()),
  guardFile: z.string(),
  installed: z.boolean(),
});
export type RepoPreview = z.infer<typeof RepoPreview>;
export const WorktreesPruneMsg = z.object({ ...envelope('worktrees.prune') });
/** Il tuo nome come lo usano gli agenti e i log; null o vuoto = torna al predefinito (git user.name). */
export const SettingsSetMsg = z.object({ ...envelope('settings.set'), userName: z.string().max(200).nullable() });
/**
 * Configurazione di un repository. Ogni campo assente resta com'è; null torna al default:
 * mergeTarget null = il branch aperto nel tuo checkout, visual null = verifica visuale disattivata.
 */
export const RepoConfigMsg = z.object({
  ...envelope('repo.config'),
  repoId: Id,
  /** assente = invariato */
  mergeTarget: z.string().max(250).nullable().optional(),
  /** verifica visuale: null = disattivata; assente = invariata */
  visual: VisualConfig.nullable().optional(),
}).refine((m) => m.mergeTarget !== undefined || m.visual !== undefined, { message: 'indica almeno mergeTarget o visual' });
/** Una schermata della verifica visuale di un task (la risposta è un messaggio visual.shot). */
export const VisualShotRequestMsg = z.object({ ...envelope('visual.shot.request'), requestId: z.string().min(1).max(100), taskId: Id, shotId: z.string().regex(/^[a-z0-9-]{1,80}$/) });

/** Dove sta una skill: personale, oppure del repository indicato. */
const SkillWhere = { source: SkillSource, repoId: Id.optional(), skillId: z.string().regex(SKILL_ID_RE) };
const needsRepo = (m: { source: string; repoId?: string | undefined }) => (m.source === 'repo') === !!m.repoId;
const repoMessage = { message: 'repoId serve per le skill del repository e solo per quelle' };
/**
 * Crea o modifica una skill. Personale: ~/.keystone/skills/<id>.md. Del repository: il file nel
 * tuo checkout (.keystone/skills/<id>.md), che gli agenti ricevono solo dopo il commit sul branch
 * di destinazione. create: true rifiuta se esiste già.
 */
export const SkillSaveMsg = z.object({ ...envelope('skill.save'), ...SkillWhere, create: z.boolean(), draft: SkillDraft }).refine(needsRepo, repoMessage);
/** Cancella il file di una skill (del repository: nel tuo checkout, da committare). */
export const SkillDeleteMsg = z.object({ ...envelope('skill.delete'), ...SkillWhere }).refine(needsRepo, repoMessage);
/** Attiva o disattiva una skill solo per te, senza toccare il file; null = vale il file. */
export const SkillToggleMsg = z.object({ ...envelope('skill.toggle'), ...SkillWhere, enabled: z.boolean().nullable() }).refine(needsRepo, repoMessage);
/**
 * Conferma una skill personale creata o cambiata fuori dall'app: vale solo se il file ha ancora
 * l'impronta mostrata (`Skill.unconfirmed`), così non si conferma un contenuto mai visto.
 */
export const SkillConfirmMsg = z.object({ ...envelope('skill.confirm'), skillId: z.string().regex(SKILL_ID_RE), hash: z.string().regex(/^[0-9a-f]{64}$/) });
/** Rilegge le skill (dopo un commit o una modifica fatta fuori da Keystone). */
export const SkillsRefreshMsg = z.object({ ...envelope('skills.refresh') });

export const ClientMessage = z.discriminatedUnion('type', [
  HelloMsg,
  GoalSubmitMsg,
  UserMessageMsg,
  DecisionAnswerMsg,
  TaskActionMsg,
  AgentActionMsg,
  DiffRequestMsg,
  RepoPreviewMsg,
  RepoAddMsg,
  WorktreesPruneMsg,
  GoalBudgetMsg,
  SettingsSetMsg,
  RepoConfigMsg,
  VisualShotRequestMsg,
  SkillSaveMsg,
  SkillDeleteMsg,
  SkillToggleMsg,
  SkillConfirmMsg,
  SkillsRefreshMsg,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Un messaggio del client senza il campo `v` (distribuito su ogni tipo di messaggio). */
export type ClientPayload = ClientMessage extends infer M ? (M extends { v: number } ? Omit<M, 'v'> : never) : never;

export const SERVER_MESSAGE_TYPES = ServerMessage.options.map((o) => o.shape.type.value);
export const CLIENT_MESSAGE_TYPES = ClientMessage.options.map((o) => o.shape.type.value);

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; error: string; id?: string };

function issues(e: z.ZodError): string {
  return e.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(messaggio)'}: ${i.message}`)
    .join('; ');
}

/** Interpreta un frame del client. Non lancia mai eccezioni. */
export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'JSON non valido' };
  }
  const id = data && typeof data === 'object' && typeof (data as { id?: unknown }).id === 'string' ? (data as { id: string }).id : undefined;
  const r = ClientMessage.safeParse(data);
  if (!r.success) return { ok: false, error: issues(r.error), ...(id ? { id } : {}) };
  return { ok: true, msg: r.data };
}

/** Interpreta un frame del server (lato interfaccia). */
export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'JSON non valido' };
  }
  const r = ServerMessage.safeParse(data);
  return r.success ? { ok: true, msg: r.data } : { ok: false, error: issues(r.error) };
}
