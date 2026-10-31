import type { Task, TaskStatus, ViewState } from '@keystone/shared';
import { useState } from 'react';
import { STATUS_LABEL } from '../lib/format.js';
import { Avatar } from './common.js';

const COLUMNS: TaskStatus[] = ['todo', 'doing', 'review', 'blocked', 'done'];

interface Props {
  state: ViewState;
  send: (cmd: Parameters<Window['keystone']['send']>[0]) => Promise<void>;
  openReview: (t: Task) => void;
}

function CiBadge({ ci }: { ci: Task['ci'] }) {
  if (ci === 'unknown') return null;
  const map = { running: ['warn', 'test in corso'], pass: ['ok', 'test ok'], fail: ['bad', 'test falliti'] } as const;
  const [cls, label] = map[ci];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function TaskCard({ t, state, send, openReview }: { t: Task } & Props) {
  const agent = state.agents.find((a) => a.id === t.assignee);
  const workers = state.agents.filter((a) => a.role === 'worker');
  const [reassign, setReassign] = useState(false);
  return (
    <div className="card task">
      <div className="task-top">
        <span className="mono">{t.id}</span>
        {t.priority !== 0 && <span className="badge accent">priorità {t.priority}</span>}
        <span style={{ marginLeft: 'auto' }}>{agent && <Avatar agent={agent} agents={state.agents} size={20} />}</span>
      </div>
      <div className="task-title">{t.title}</div>
      <div className="task-meta">
        {agent && <span className="muted">{agent.name}</span>}
        {t.deps.length > 0 && <span className="badge">dopo {t.deps.join(', ')}</span>}
        <CiBadge ci={t.ci} />
      </div>
      {t.blockedReason && <div className="task-blocked">{t.blockedReason}</div>}
      <div className="task-actions">
        {t.worktree && (
          <button className="btn small" onClick={() => openReview(t)}>
            Diff
          </button>
        )}
        {(t.status === 'blocked' || t.status === 'cancelled' || t.status === 'done') && (
          <button className="btn small" onClick={() => void send({ type: 'task.action', taskId: t.id, action: 'retry' })}>
            Riprova
          </button>
        )}
        {t.status !== 'done' && t.status !== 'cancelled' && (
          <>
            <button className="btn small" onClick={() => void send({ type: 'task.action', taskId: t.id, action: 'prioritize', arg: String(t.priority + 1) })} title="Aumenta la priorità">
              ↑
            </button>
            <button className="btn small" onClick={() => setReassign((r) => !r)}>
              Assegna
            </button>
            <button className="btn small danger" onClick={() => void send({ type: 'task.action', taskId: t.id, action: 'cancel' })}>
              Annulla
            </button>
          </>
        )}
      </div>
      {reassign && (
        <div className="task-actions">
          {workers
            .filter((w) => w.id !== t.assignee)
            .map((w) => (
              <button
                key={w.id}
                className="btn small"
                onClick={() => {
                  setReassign(false);
                  void send({ type: 'task.action', taskId: t.id, action: 'reassign', arg: w.id });
                }}
              >
                {w.name}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

export function Board(props: Props) {
  const { state } = props;
  const [showCancelled, setShowCancelled] = useState(false);
  const goal = [...state.goals].reverse().find((g) => g.status === 'planning' || g.status === 'active') ?? state.goals[state.goals.length - 1];
  const tasks = state.tasks.filter((t) => !goal || t.goalId === goal.id || !t.goalId);
  const cols: TaskStatus[] = showCancelled ? [...COLUMNS, 'cancelled'] : COLUMNS;
  return (
    <div className="view">
      <div className="view-header">
        <h1>Tabellone</h1>
        <span className="sub">{tasks.length} task</span>
        <div className="actions">
          <button className="btn small ghost" onClick={() => setShowCancelled((s) => !s)}>
            {showCancelled ? 'Nascondi annullati' : 'Mostra annullati'}
          </button>
        </div>
      </div>
      {goal ? (
        <div className="card goal-bar">
          <span className={`badge ${goal.status === 'done' ? 'ok' : goal.status === 'failed' ? 'bad' : goal.status === 'planning' ? 'info' : 'accent'}`}>{goal.status === 'planning' ? 'pianificazione' : goal.status === 'active' ? 'in corso' : goal.status === 'done' ? 'completato' : goal.status === 'failed' ? 'fallito' : 'chiuso'}</span>
          <span className="goal-text grow ellipsis" title={goal.text}>
            {goal.text}
          </span>
          <div className="progress">
            <div style={{ width: `${Math.round(goal.progress * 100)}%` }} />
          </div>
          <span className="muted mono">{Math.round(goal.progress * 100)}%</span>
        </div>
      ) : (
        <div className="card goal-bar muted">Nessun obiettivo: scrivilo nella console qui sotto.</div>
      )}
      <div className="board" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(190px, 1fr))` }}>
        {cols.map((c) => {
          const list = tasks.filter((t) => t.status === c).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
          return (
            <div key={c} className="column">
              <div className="column-head">
                {STATUS_LABEL[c]}
                <span className="n">{list.length}</span>
              </div>
              {list.map((t) => (
                <TaskCard key={t.id} t={t} {...props} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
