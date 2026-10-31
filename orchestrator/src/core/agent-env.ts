// L'ambiente dei processi degli agenti (e di ogni comando che lanciano).
//
// Fase 2: identità git dell'agente ("Keystone <Nome>"), niente prompt di credenziali, e rimozione
// delle variabili che puntano git verso un altro repository. In Fase 3 qui si aggiunge il blocco
// del push a livello git.
import path from 'node:path';
import { agentIdentity } from '../util/git.js';

/** Variabili che dirottano git verso un altro repository, indice o working tree. */
export const GIT_REDIRECT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CONFIG',
];

export function agentEnv(base: NodeJS.ProcessEnv, who: { agentId: string; name: string; cwd: string }): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const k of Object.keys(env)) if (GIT_REDIRECT_VARS.includes(k.toUpperCase())) delete env[k];
  const sep = process.platform === 'win32' ? ';' : ':';
  return {
    ...env,
    ...agentIdentity(who.agentId, who.name),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    // git non risale oltre la cartella di lavoro alla ricerca di un repository
    GIT_CEILING_DIRECTORIES: [path.dirname(path.resolve(who.cwd)), base.GIT_CEILING_DIRECTORIES].filter(Boolean).join(sep),
  };
}
