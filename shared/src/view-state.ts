// Stato della vista lato interfaccia: lo snapshot iniziale più gli aggiornamenti incrementali.
// Funzione pura, usata dal processo main di Electron (e nei test).
import type { Agent, Decision, FeedItem, Goal, LogEntry, MemoryEntry, OrchestratorStatus, Repo, ServerMessage, Task } from './protocol.js';
import type { Skill } from './skills.js';

export interface ViewState {
  connected: boolean;
  status?: OrchestratorStatus;
  agents: Agent[];
  tasks: Task[];
  goals: Goal[];
  decisions: Decision[];
  repos: Repo[];
  memory: MemoryEntry[];
  feed: FeedItem[];
  skills: Skill[];
  logs: Record<string, LogEntry[]>;
}

export const VIEW_FEED_LIMIT = 300;
export const VIEW_LOG_LIMIT = 500;

export function emptyViewState(): ViewState {
  return { connected: false, agents: [], tasks: [], goals: [], decisions: [], repos: [], memory: [], feed: [], skills: [], logs: {} };
}

function upsert<T>(list: T[], item: T, key: (x: T) => string): T[] {
  const k = key(item);
  const i = list.findIndex((x) => key(x) === k);
  if (i < 0) return [...list, item];
  const out = list.slice();
  out[i] = item;
  return out;
}

/** Applica un messaggio del server e restituisce il nuovo stato (non modifica `s`). */
export function applyServerMessage(s: ViewState, m: ServerMessage): ViewState {
  switch (m.type) {
    case 'snapshot':
      return {
        connected: true,
        status: m.status,
        agents: m.agents,
        tasks: m.tasks,
        goals: m.goals,
        decisions: m.decisions,
        repos: m.repos,
        memory: m.memory,
        feed: m.feed.slice(-VIEW_FEED_LIMIT),
        skills: m.skills,
        logs: m.logs,
      };
    case 'status':
      return { ...s, status: m.status };
    case 'agent.upsert':
      return { ...s, agents: upsert(s.agents, m.agent, (a) => a.id) };
    case 'agent.log': {
      const prev = s.logs[m.agentId] ?? [];
      return { ...s, logs: { ...s.logs, [m.agentId]: [...prev, ...m.entries].slice(-VIEW_LOG_LIMIT) } };
    }
    case 'task.upsert':
      return { ...s, tasks: upsert(s.tasks, m.task, (t) => t.id) };
    case 'goal.upsert':
      return { ...s, goals: upsert(s.goals, m.goal, (g) => g.id) };
    case 'decision.upsert':
      return { ...s, decisions: upsert(s.decisions, m.decision, (d) => d.id) };
    case 'repo.upsert':
      return { ...s, repos: upsert(s.repos, m.repo, (r) => r.id) };
    case 'memory.upsert':
      return { ...s, memory: upsert(s.memory, m.entry, (e) => e.id) };
    case 'skills':
      return { ...s, skills: m.skills };
    case 'feed.add':
      return { ...s, feed: [...s.feed, m.item].slice(-VIEW_FEED_LIMIT) };
    default:
      // agent.say, diff, notify, ack, error: eventi, non stato
      return s;
  }
}
