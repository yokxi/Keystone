// Configurazione dell'orchestratore: valori predefiniti. Il file ~/.keystone/config.json e le
// opzioni da riga di comando si applicano sopra (config-file.ts, main.ts).
import os from 'node:os';
import path from 'node:path';
import type { EngineId, Role } from '@keystone/shared';

export interface AgentConfig {
  id: string;
  name: string;
  role: Role;
  engine: EngineId;
  model?: string;
  effort?: string;
}

export interface OrchestratorConfig {
  /** radice dello stato: ~/.keystone (o KEYSTONE_HOME) */
  home: string;
  /** profilo: lo stato vive in <home>/<profile> */
  profile: string;
  host: '127.0.0.1';
  port: number;
  agents: AgentConfig[];
  maxConcurrent: number;
  turnTimeoutMs: number;
  leadReview: boolean;
  /** comando dei test del repository target (default: rilevato) */
  ciCommand?: string;
  ciTimeoutMs: number;
  userName?: string;
  sim: { stepDelayMs: number };
  /** file di configurazione: percorsi protetti per gli agenti */
  configFiles?: string[];
  /** conserva il branch dell'agente dopo un merge riuscito (default: eliminato) */
  keepMergedBranches?: boolean;
  /** limiti per obiettivo: turni degli agenti e minuti di lavoro (senza le attese di una tua risposta) */
  goalLimits?: { turns?: number; minutes?: number };
  /** tetto di spesa predefinito per obiettivo in dollari (0 = nessun tetto) */
  budgetUsdPerGoal: number;
  claude: {
    leadModel?: string;
    workerModel?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    leadEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    maxTurnsLead?: number;
    maxTurnsWorker?: number;
    /** login personale di Claude Code (solo uso personale): disattivato di default */
    useClaudeLogin: boolean;
    /** registra le trascrizioni dei turni in questa cartella (per i test di replay) */
    recordDir?: string;
  };
  codex: {
    leadModel?: string;
    workerModel?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    leadEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    /** login ChatGPT nella CODEX_HOME di Keystone (solo uso personale): disattivato di default */
    useCodexLogin: boolean;
    /** percorso del binario codex (default: quello del pacchetto installato) */
    binPath?: string;
    /** prezzi per la stima della spesa dai token (--codex-prices); assenti = nessuna stima */
    prices?: { inputPerMTok: number; cachedInputPerMTok?: number; outputPerMTok: number };
    recordDir?: string;
  };
}

export const DEFAULT_PORT = 7931;

/** Il cast predefinito: un lead e cinque worker (di default ne lavorano tre). */
export const CAST: ReadonlyArray<{ id: string; name: string; role: Role }> = [
  { id: 'ada', name: 'Ada', role: 'lead' },
  { id: 'bruno', name: 'Bruno', role: 'worker' },
  { id: 'chiara', name: 'Chiara', role: 'worker' },
  { id: 'dario', name: 'Dario', role: 'worker' },
  { id: 'elena', name: 'Elena', role: 'worker' },
  { id: 'fabio', name: 'Fabio', role: 'worker' },
];

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.KEYSTONE_HOME?.trim() || path.join(os.homedir(), '.keystone');
}

/** Il cast con il motore indicato, uguale per tutti oppure diverso per lead e worker (team misto). */
export function defaultAgents(engine: EngineId | { lead: EngineId; worker: EngineId }, workers = 3): AgentConfig[] {
  const lead = CAST.find((c) => c.role === 'lead')!;
  const ws = CAST.filter((c) => c.role === 'worker').slice(0, Math.max(1, Math.min(workers, 5)));
  const of = (role: Role) => (typeof engine === 'string' ? engine : engine[role === 'lead' ? 'lead' : 'worker']);
  return [lead, ...ws].map((c) => ({ ...c, engine: of(c.role) }));
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  return {
    home: defaultHome(env),
    profile: 'default',
    host: '127.0.0.1',
    port: Number(env.KEYSTONE_PORT) || DEFAULT_PORT,
    agents: defaultAgents('sim'),
    maxConcurrent: 3,
    turnTimeoutMs: 45 * 60_000,
    leadReview: true,
    ciTimeoutMs: 10 * 60_000,
    sim: { stepDelayMs: 400 },
    budgetUsdPerGoal: Number(env.KEYSTONE_BUDGET_USD ?? 5) || 0,
    // Opus 5.5 ha effort predefinito 'medium': lo si dichiara esplicitamente
    claude: { useClaudeLogin: false, effort: 'medium', leadEffort: 'high' },
    codex: { useCodexLogin: false, effort: 'medium', leadEffort: 'high' },
  };
}

/**
 * Con il login personale (abbonamento) la spesa riportata è una stima, non quello che si paga:
 * nessun tetto in dollari, a meno che l'utente non ne chieda uno esplicitamente (--budget o
 * KEYSTONE_BUDGET_USD), che allora fa da freno sulla stima. Restituisce la riga da mostrare.
 */
export function applyLoginBudget(cfg: OrchestratorConfig, explicit: boolean): string {
  if (!explicit) {
    cfg.budgetUsdPerGoal = 0;
    return 'login personale: la spesa mostrata è una stima, nessun tetto in dollari (--budget per usarla come freno)';
  }
  return cfg.budgetUsdPerGoal > 0 ? `login personale: tetto di $${cfg.budgetUsdPerGoal} applicato alla spesa stimata` : 'login personale: nessun tetto';
}

/** Limiti predefiniti per obiettivo con il login personale, al posto del tetto in dollari. */
export const LOGIN_GOAL_LIMITS = { turns: 30, minutes: 60 } as const;

/**
 * Con il login personale ogni obiettivo ha un limite di turni e di minuti di lavoro, salvo valori
 * espliciti (--goal-turns / --goal-minutes; 0 = nessun limite). Restituisce la riga da mostrare.
 */
export function applyLoginLimits(cfg: OrchestratorConfig, explicit: { turns?: number; minutes?: number }): string {
  const turns = explicit.turns ?? LOGIN_GOAL_LIMITS.turns;
  const minutes = explicit.minutes ?? LOGIN_GOAL_LIMITS.minutes;
  cfg.goalLimits = { ...(turns > 0 ? { turns } : {}), ...(minutes > 0 ? { minutes } : {}) };
  const parts = [turns > 0 ? `${turns} turni` : 'turni senza limite', minutes > 0 ? `${minutes} minuti di lavoro` : 'tempo senza limite'];
  return `login personale: limite per obiettivo ${parts.join(', ')}`;
}

export function dataDir(cfg: Pick<OrchestratorConfig, 'home' | 'profile'>): string {
  return path.join(cfg.home, cfg.profile);
}
