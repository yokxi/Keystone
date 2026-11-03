// Costruisce orchestratore e server a partire dalla configurazione (usato da main.ts e dai test).
import path from 'node:path';
import type { EngineId } from '@keystone/shared';
import { dataDir, type OrchestratorConfig } from './config.js';
import type { Logger } from './core/context.js';
import { Orchestrator, type VisualDeps } from './core/orchestrator.js';
import type { RepoManagerOptions } from './core/repos.js';
import type { TeamMember } from './core/team.js';
import { createEngines, type EngineFactoryOptions } from './engines/registry.js';
import type { EngineAdapter } from './engines/types.js';

export interface BuildOptions {
  logger?: Logger;
  /** motori già pronti (test), al posto di quelli creati dalla configurazione */
  engines?: Map<EngineId, EngineAdapter>;
  engineOptions?: EngineFactoryOptions;
  repoFaults?: RepoManagerOptions['faults'];
  storeDebounceMs?: number;
  /** legge git user.name (test) */
  resolveGitUserName?: () => string | undefined;
  /** verifica visuale simulata (test) */
  visual?: Partial<VisualDeps>;
}

export function buildOrchestrator(cfg: OrchestratorConfig, opts: BuildOptions = {}): Orchestrator {
  const engines =
    opts.engines ??
    createEngines(
      cfg.agents.map((a) => a.engine),
      opts.engineOptions ?? {
        sim: { stepDelayMs: cfg.sim.stepDelayMs },
        // configurazione isolata di Claude Code, in ~/.keystone (mai ~/.claude dell'utente)
        claude: { ...cfg.claude, configDir: path.join(cfg.home, 'claude-config') },
        // configurazione isolata di Codex, in ~/.keystone (mai ~/.codex dell'utente)
        codex: { ...cfg.codex, codexHome: path.join(cfg.home, 'codex-home') },
      },
    );
  const members: TeamMember[] = cfg.agents.map((a) => {
    const engine = engines.get(a.engine);
    if (!engine) throw new Error(`motore ${a.engine} non disponibile per ${a.id}`);
    return { id: a.id, name: a.name, role: a.role, engine, ...(a.model ? { model: a.model } : {}), ...(a.effort ? { effort: a.effort } : {}) };
  });
  return new Orchestrator({
    dataDir: dataDir(cfg),
    members,
    team: {
      maxConcurrent: cfg.maxConcurrent,
      turnTimeoutMs: cfg.turnTimeoutMs,
      leadReview: cfg.leadReview,
      ...(cfg.ciCommand ? { ciCommand: cfg.ciCommand } : {}),
      ciTimeoutMs: cfg.ciTimeoutMs,
    },
    ...(cfg.userName ? { userName: cfg.userName } : {}),
    ...(opts.resolveGitUserName ? { resolveGitUserName: opts.resolveGitUserName } : {}),
    defaultBudgetUsd: cfg.budgetUsdPerGoal,
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.repoFaults ? { repoFaults: opts.repoFaults } : {}),
    ...(cfg.keepMergedBranches ? { keepMergedBranches: true } : {}),
    ...(cfg.goalLimits ? { defaultGoalLimits: cfg.goalLimits } : {}),
    ...(opts.storeDebounceMs !== undefined ? { storeDebounceMs: opts.storeDebounceMs } : {}),
    ...(opts.visual ? { visual: opts.visual } : {}),
  });
}
