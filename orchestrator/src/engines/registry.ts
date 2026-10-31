// Crea gli adattatori dei motori. Un'istanza per tipo di motore, condivisa dagli agenti che lo usano.
import type { EngineId } from '@keystone/shared';
import { SimEngine, type SimEngineOptions } from './sim/sim-engine.js';
import type { EngineAdapter } from './types.js';

export interface EngineFactoryOptions {
  sim?: SimEngineOptions;
}

export function createEngines(ids: Iterable<EngineId>, opts: EngineFactoryOptions = {}): Map<EngineId, EngineAdapter> {
  const out = new Map<EngineId, EngineAdapter>();
  for (const id of new Set(ids)) {
    switch (id) {
      case 'sim':
        out.set(id, new SimEngine(opts.sim));
        break;
      case 'claude':
        throw new Error('il motore Claude arriva in Fase 5: per ora usa --engine sim');
      case 'codex':
        throw new Error('il motore Codex arriva in Fase 6: per ora usa --engine sim');
    }
  }
  return out;
}
