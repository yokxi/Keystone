import { ENGINE_EXPERIMENTAL, ENGINE_LABELS, type ViewState } from '@keystone/shared';
import { useState } from 'react';
import { money, spendLabel, tokens } from '../lib/format.js';
import { Avatar, LogView, StateBadge } from './common.js';

const ENGINE_LABEL = ENGINE_LABELS;

/** Etichetta dei motori non ancora verificati con un modello reale. */
function Experimental({ engine }: { engine: keyof typeof ENGINE_LABELS }) {
  const text = ENGINE_EXPERIMENTAL[engine];
  return text ? (
    <span className="badge warn" data-testid={`experimental-${engine}`} title={`Il motore ${ENGINE_LABELS[engine]} non è ancora stato provato con un modello vero: usalo solo per prove.`}>
      {text}
    </span>
  ) : null;
}

interface Props {
  state: ViewState;
  selected: string | undefined;
  select: (id: string) => void;
  send: (cmd: Parameters<Window['keystone']['send']>[0]) => Promise<void>;
}

export function Agents({ state, selected, select, send }: Props) {
  const agent = state.agents.find((a) => a.id === selected) ?? state.agents[0];
  const [msg, setMsg] = useState('');
  if (!agent) return <div className="view empty">Nessun agente: l'orchestratore non è ancora connesso.</div>;
  const task = state.tasks.find((t) => t.id === agent.taskId);
  const submit = () => {
    if (!msg.trim()) return;
    void send({ type: 'user.message', to: agent.id, text: msg.trim() });
    setMsg('');
  };
  return (
    <div className="view" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="view-header">
        <h1>Agenti</h1>
        <span className="sub">{state.agents.filter((a) => a.active).length} in servizio</span>
      </div>
      <div className="agents-layout grow">
        <div className="agent-list">
          {state.agents.map((a) => (
            <button key={a.id} className={`card agent-card ${a.id === agent.id ? 'active' : ''}`} onClick={() => select(a.id)}>
              <div className="row">
                <Avatar agent={a} agents={state.agents} size={28} />
                <div className="grow">
                  <div className="agent-name">
                    {a.name} <span className="faint" style={{ fontWeight: 400, fontSize: 12 }}>{a.role === 'lead' ? 'lead' : 'worker'}</span>
                  </div>
                  <div className="agent-model">
                    {ENGINE_LABEL[a.engine]} · <b>{a.model}</b> <Experimental engine={a.engine} />
                  </div>
                </div>
                <StateBadge state={a.state} />
              </div>
              <div className="agent-activity ellipsis">
                {!a.active ? 'fuori turno' : a.paused ? 'in pausa' : a.activity}
                {a.taskId ? ` · ${a.taskId}` : ''}
              </div>
            </button>
          ))}
        </div>
        <div className="card agent-panel">
          <div className="agent-panel-head">
            <Avatar agent={agent} agents={state.agents} size={34} />
            <div>
              <h2 style={{ fontSize: 17 }}>
                {agent.name} <StateBadge state={agent.state} />
              </h2>
              <div className="kv" style={{ marginTop: 4 }}>
                <span>
                  motore <b>{ENGINE_LABEL[agent.engine]}</b> <Experimental engine={agent.engine} />
                </span>
                <span>
                  modello <b>{agent.model}</b>
                </span>
                <span>
                  {spendLabel(state.status?.billing).word} <b>{money(agent.costUsd)}</b>
                </span>
                <span>
                  token <b>{tokens(agent.tokens)}</b>
                </span>
                {task && (
                  <span>
                    task <b>{task.id}</b> {task.title}
                  </span>
                )}
              </div>
            </div>
            <div className="row" style={{ marginLeft: 'auto' }}>
              {agent.active && !agent.paused && (
                <button className="btn small" onClick={() => void send({ type: 'agent.action', agentId: agent.id, action: 'pause' })}>
                  Pausa
                </button>
              )}
              {(agent.paused || !agent.active) && (
                <button className="btn small" onClick={() => void send({ type: 'agent.action', agentId: agent.id, action: 'resume' })}>
                  Riprendi
                </button>
              )}
              {agent.active && (
                <button className="btn small danger" onClick={() => void send({ type: 'agent.action', agentId: agent.id, action: 'stop' })}>
                  Fuori turno
                </button>
              )}
            </div>
          </div>
          <div className="agent-skills" data-testid="agent-skills">
            <span className="muted">skill ricevute nell'ultimo turno</span>
            {agent.skills === undefined ? (
              <span className="faint">nessun turno ancora</span>
            ) : agent.skills.length === 0 ? (
              <span className="faint">nessuna</span>
            ) : (
              agent.skills.map((s) => (
                <span key={`${s.source}:${s.id}`} className={`badge ${s.source === 'repo' ? 'accent' : ''}`} title={s.source === 'repo' ? 'del repository (dal branch di destinazione)' : 'personale'}>
                  {s.name}
                </span>
              ))
            )}
          </div>
          <LogView entries={state.logs[agent.id] ?? []} />
          <div className="message-row">
            <input
              className="input"
              placeholder={`Messaggio a ${agent.name}…`}
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <button className="btn primary" onClick={submit} disabled={!msg.trim()}>
              Invia
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
