// L'ambiente dei processi degli agenti (e di ogni comando che lanciano, compresi test e hook):
// sicurezza git (core/gitsafety.ts) + identità git dell'agente ("Keystone <Nome>").
import path from 'node:path';
import { agentIdentity } from '../util/git.js';
import { gitSafeEnv } from './gitsafety.js';

export { GIT_REDIRECT_VARS } from './gitsafety.js';

export function agentEnv(base: NodeJS.ProcessEnv, who: { agentId: string; name: string; cwd: string }): Record<string, string | undefined> {
  // git non risale oltre la cartella di lavoro alla ricerca di un altro repository
  return gitSafeEnv(base, agentIdentity(who.agentId, who.name), { ceiling: path.dirname(path.resolve(who.cwd)) });
}
