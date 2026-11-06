// L'ambiente dei processi degli agenti (e di ogni comando che lanciano, compresi test e hook):
// sicurezza git (core/gitsafety.ts) + identità git dell'agente ("Keystone <Nome>").
import path from 'node:path';
import { agentIdentity } from '../util/git.js';
import { gitSafeEnv } from './gitsafety.js';

export { GIT_REDIRECT_VARS } from './gitsafety.js';

/**
 * Variabili dell'orchestratore che non devono arrivare ai comandi degli agenti: con l'app
 * impacchettata l'orchestratore gira con il Node di Electron (ELECTRON_RUN_AS_NODE), e un'app
 * Electron del repository lanciata dai test partirebbe come Node.
 */
export const ORCHESTRATOR_ONLY_VARS = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE'] as const;

export function agentEnv(base: NodeJS.ProcessEnv, who: { agentId: string; name: string; cwd: string }): Record<string, string | undefined> {
  const clean: NodeJS.ProcessEnv = { ...base };
  for (const k of Object.keys(clean)) if ((ORCHESTRATOR_ONLY_VARS as readonly string[]).includes(k.toUpperCase())) delete clean[k];
  // git non risale oltre la cartella di lavoro alla ricerca di un altro repository
  return gitSafeEnv(clean, agentIdentity(who.agentId, who.name), { ceiling: path.dirname(path.resolve(who.cwd)) });
}
