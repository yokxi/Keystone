import type { Agent, AgentState, LogEntry } from '@keystone/shared';
import { useEffect, useRef } from 'react';
import { diffLogLines } from '../lib/diff-view.js';
import { STATE_LABEL, time } from '../lib/format.js';

const PALETTE = ['#2f6fdb', '#1f8a4c', '#b26b00', '#7a4fd0', '#c23b32', '#0f8a8a'];

export function agentColor(id: string, agents: readonly Agent[]): string {
  const i = Math.max(0, agents.findIndex((a) => a.id === id));
  return PALETTE[i % PALETTE.length]!;
}

export function Avatar({ agent, agents, size = 22 }: { agent: Agent; agents: readonly Agent[]; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, background: agentColor(agent.id, agents), fontSize: size * 0.48 }} title={agent.name}>
      {agent.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function StateBadge({ state }: { state: AgentState }) {
  return <span className={`state ${state}`}>{STATE_LABEL[state]}</span>;
}

const LOG_ICON: Record<LogEntry['kind'], string> = { text: '·', tool: '›', result: '↳', error: '✕', diff: '±', test: '⚑', permission: '⚿' };

/** Log live di un agente: tool call, risultati, test, permessi e diff colorati. */
export function LogView({ entries }: { entries: readonly LogEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries]);
  return (
    <div
      className="log"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {entries.length === 0 && <div className="empty">Nessuna attività ancora.</div>}
      {entries.map((e, i) => (
        <div key={i} className={`log-entry ${e.kind}`}>
          <span className="log-time">{time(e.ts)}</span>
          <span className="log-icon">{LOG_ICON[e.kind]}</span>
          {e.kind === 'diff' ? (
            <div className="diff-block">
              {diffLogLines(e.text).map((l, j) => (
                <div key={j} className={`dl ${l.cls}`}>
                  {l.text || ' '}
                </div>
              ))}
            </div>
          ) : (
            <span className="log-text">{e.text}</span>
          )}
        </div>
      ))}
    </div>
  );
}
