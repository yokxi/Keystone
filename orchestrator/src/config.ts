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
  userName?: string;
  sim: { stepDelayMs: number };
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
    sim: { stepDelayMs: 400 },
  };
}

export function dataDir(cfg: Pick<OrchestratorConfig, 'home' | 'profile'>): string {
  return path.join(cfg.home, cfg.profile);
}
