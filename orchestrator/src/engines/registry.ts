// Crea gli adattatori dei motori. Un'istanza per tipo di motore, condivisa dagli agenti che lo usano.
import type { EngineId } from '@keystone/shared';
import { ClaudeEngine, type ClaudeEngineConfig } from './claude/claude-engine.js';
import { CodexEngine, type CodexEngineConfig } from './codex/codex-engine.js';
import { SimEngine, type SimEngineOptions } from './sim/sim-engine.js';
import type { EngineAdapter } from './types.js';

export interface EngineFactoryOptions {
  sim?: SimEngineOptions;
  claude?: ClaudeEngineConfig;
  codex?: CodexEngineConfig;
}

export function createEngines(ids: Iterable<EngineId>, opts: EngineFactoryOptions = {}): Map<EngineId, EngineAdapter> {
  const out = new Map<EngineId, EngineAdapter>();
  for (const id of new Set(ids)) {
    switch (id) {
      case 'sim':
        out.set(id, new SimEngine(opts.sim));
        break;
      case 'claude':
        if (!opts.claude) throw new Error('configurazione del motore Claude mancante');
        out.set(id, new ClaudeEngine(opts.claude));
        break;
      case 'codex':
        if (!opts.codex) throw new Error('configurazione del motore Codex mancante');
        out.set(id, new CodexEngine(opts.codex));
        break;
    }
  }
  return out;
}
