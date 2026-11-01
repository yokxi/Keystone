// Configurazione dell'orchestratore. Fase 2: valori predefiniti + opzioni da riga di comando.
// Il file ~/.keystone/config.json (motore e modello per agente, effort, numero di worker) arriva
// in Fase 7.
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

export function defaultAgents(engine: EngineId, workers = 3): AgentConfig[] {
  const lead = CAST.find((c) => c.role === 'lead')!;
  const ws = CAST.filter((c) => c.role === 'worker').slice(0, Math.max(1, Math.min(workers, 5)));
  return [lead, ...ws].map((c) => ({ ...c, engine }));
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

export function dataDir(cfg: Pick<OrchestratorConfig, 'home' | 'profile'>): string {
  return path.join(cfg.home, cfg.profile);
}
