// Interprete della console: il testo libero è un obiettivo, "@agente messaggio" parla a un agente,
// i comandi con "/" fanno il resto. Funzione pura (testata in app/test/console.test.ts).
import type { ValidatedCommand } from '../../main/ipc-validate.js';

export interface AgentRef {
  id: string;
  name: string;
}

export type ConsoleResult =
  | { kind: 'send'; cmd: ValidatedCommand; echo: string }
  | { kind: 'ui'; action: 'register-repo' | 'help'; arg?: string }
  | { kind: 'error'; message: string }
  | { kind: 'none' };

export const HELP: Array<[string, string]> = [
  ['testo libero', 'nuovo obiettivo per il lead'],
  ['@agente messaggio', 'messaggio a un agente (@all per tutti)'],
  ['/pausa @agente', 'mette in pausa (il task resta suo)'],
  ['/riprendi @agente', 'riprende un agente in pausa o fuori turno'],
  ['/ferma @agente', 'fuori turno: i suoi task tornano sul tabellone'],
  ['/attiva @agente', 'riporta in servizio un agente'],
  ['/task t3 annulla | riprova | priorita 5 | assegna @agente', 'azioni su un task'],
  ['/rispondi d4 <opzione o testo>', 'risponde a una decisione'],
  ['/repo [percorso]', 'registra un repository (mostra prima la modifica a .git/config)'],
  ['/pulisci', 'chiude i worktree di task finiti e rimuove quelli orfani'],
  ['/aiuto', 'questo elenco'],
];

const AGENT_ACTIONS: Record<string, 'pause' | 'resume' | 'stop' | 'spawn'> = {
  pausa: 'pause',
  pause: 'pause',
  riprendi: 'resume',
  resume: 'resume',
  ferma: 'stop',
  stop: 'stop',
  attiva: 'spawn',
  spawn: 'spawn',
};

const TASK_ACTIONS: Record<string, 'cancel' | 'retry' | 'prioritize' | 'reassign'> = {
  annulla: 'cancel',
  cancel: 'cancel',
  riprova: 'retry',
  retry: 'retry',
  priorita: 'prioritize',
  priorità: 'prioritize',
  prioritize: 'prioritize',
  assegna: 'reassign',
  riassegna: 'reassign',
  reassign: 'reassign',
};

function resolveAgent(token: string | undefined, agents: AgentRef[]): AgentRef | undefined {
  if (!token) return undefined;
  const q = token.replace(/^@/, '').toLowerCase();
  return agents.find((a) => a.id.toLowerCase() === q || a.name.toLowerCase() === q);
}

export function parseConsole(input: string, agents: AgentRef[]): ConsoleResult {
  const text = input.trim();
  if (!text) return { kind: 'none' };

  if (text.startsWith('@')) {
    const m = /^@(\S+)\s+([\s\S]+)$/.exec(text);
    if (!m) return { kind: 'error', message: 'scrivi il messaggio dopo il nome: @agente messaggio' };
    const target = m[1]!.toLowerCase();
    if (target === 'all' || target === 'tutti') return { kind: 'send', cmd: { type: 'user.message', to: 'all', text: m[2]!.trim() }, echo: `→ tutti: ${m[2]!.trim()}` };
    const a = resolveAgent(target, agents);
    if (!a) return { kind: 'error', message: `nessun agente "${m[1]}" (agenti: ${agents.map((x) => x.name).join(', ')})` };
    return { kind: 'send', cmd: { type: 'user.message', to: a.id, text: m[2]!.trim() }, echo: `→ ${a.name}: ${m[2]!.trim()}` };
  }

  if (text.startsWith('/')) {
    const [rawCmd, ...args] = text.slice(1).split(/\s+/);
    const cmd = (rawCmd ?? '').toLowerCase();
    if (cmd in AGENT_ACTIONS) {
      const a = resolveAgent(args[0], agents);
      if (!a) return { kind: 'error', message: `uso: /${cmd} @agente` };
      return { kind: 'send', cmd: { type: 'agent.action', agentId: a.id, action: AGENT_ACTIONS[cmd]! }, echo: `/${cmd} ${a.name}` };
    }
    if (cmd === 'task') {
      const [taskId, action, arg] = args;
      const act = TASK_ACTIONS[(action ?? '').toLowerCase()];
      if (!taskId || !/^t\d+$/i.test(taskId) || !act) return { kind: 'error', message: 'uso: /task t3 annulla | riprova | priorita 5 | assegna @agente' };
      if (act === 'prioritize' && !/^-?\d+$/.test(arg ?? '')) return { kind: 'error', message: 'uso: /task t3 priorita <numero>' };
      if (act === 'reassign') {
        const a = resolveAgent(arg, agents);
        if (!a) return { kind: 'error', message: 'uso: /task t3 assegna @agente' };
        return { kind: 'send', cmd: { type: 'task.action', taskId: taskId.toLowerCase(), action: act, arg: a.id }, echo: `/task ${taskId} assegna ${a.name}` };
      }
      return { kind: 'send', cmd: { type: 'task.action', taskId: taskId.toLowerCase(), action: act, ...(arg ? { arg } : {}) }, echo: `/task ${taskId} ${action}${arg ? ` ${arg}` : ''}` };
    }
    if (cmd === 'rispondi' || cmd === 'answer') {
      const [id, ...rest] = args;
      if (!id || !/^d\d+$/i.test(id) || !rest.length) return { kind: 'error', message: 'uso: /rispondi d4 <numero o etichetta dell\'opzione> [testo]' };
      const first = rest[0]!;
      const isOption = /^\d+$/.test(first);
      const textPart = (isOption ? rest.slice(1) : rest).join(' ');
      return {
        kind: 'send',
        cmd: { type: 'decision.answer', decisionId: id.toLowerCase(), ...(isOption ? { option: first } : {}), ...(textPart ? { text: textPart } : {}) },
        echo: `/rispondi ${id} ${rest.join(' ')}`,
      };
    }
    if (cmd === 'repo') return { kind: 'ui', action: 'register-repo', ...(args.length ? { arg: args.join(' ') } : {}) };
    if (cmd === 'pulisci' || cmd === 'prune') return { kind: 'send', cmd: { type: 'worktrees.prune' }, echo: '/pulisci' };
    if (cmd === 'aiuto' || cmd === 'help' || cmd === '?') return { kind: 'ui', action: 'help' };
    return { kind: 'error', message: `comando sconosciuto: /${cmd} (scrivi /aiuto)` };
  }

  return { kind: 'send', cmd: { type: 'goal.submit', text }, echo: `Obiettivo: ${text}` };
}

/** Completamento dei nomi degli agenti dopo "@" (Tab). */
export function completeAgent(input: string, caret: number, agents: AgentRef[]): { value: string; caret: number; options: string[] } | undefined {
  const before = input.slice(0, caret);
  const m = /(^|\s)@(\w*)$/.exec(before);
  if (!m) return undefined;
  const prefix = m[2]!.toLowerCase();
  const options = ['all', ...agents.map((a) => a.name)].filter((n) => n.toLowerCase().startsWith(prefix));
  if (!options.length) return undefined;
  const chosen = options[0]!;
  const start = before.length - prefix.length;
  const value = `${input.slice(0, start)}${chosen} ${input.slice(caret)}`;
  return { value, caret: start + chosen.length + 1, options };
}
