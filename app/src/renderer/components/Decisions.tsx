import type { Decision, ViewState } from '@keystone/shared';
import { useState } from 'react';
import { ago } from '../lib/format.js';
import { Avatar } from './common.js';

interface Props {
  state: ViewState;
  answer: (d: Decision, option?: string, text?: string) => Promise<string | undefined>;
  openMerge: (d: Decision) => void;
}

const KIND_LABEL = { question: 'Domanda', permission: 'Permesso', merge: 'Merge' } as const;

function DecisionCard({ d, state, answer, openMerge }: { d: Decision } & Props) {
  const agent = state.agents.find((a) => a.id === d.agentId);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const act = async (option?: string, t?: string) => {
    setBusy(true);
    setError(undefined);
    const err = await answer(d, option, t);
    setBusy(false);
    if (err) setError(err);
  };
  const strict = d.kind === 'permission' && d.alwaysAsk === true;
  return (
    <div className={`card decision ${d.kind} ${strict ? 'strict' : ''}`} data-testid={`decision-${d.id}`}>
      <div className="decision-head">
        {agent && <Avatar agent={agent} agents={state.agents} size={20} />}
        <b style={{ color: 'var(--text)' }}>{agent?.name ?? d.agentId}</b>
        <span className={`badge ${d.kind === 'merge' ? 'ok' : d.kind === 'permission' ? 'warn' : 'info'}`}>{KIND_LABEL[d.kind]}</span>
        {d.taskId && <span className="badge">{d.taskId}</span>}
        <span className="mono faint">{d.id}</span>
        <span style={{ marginLeft: 'auto' }} className="faint">
          {ago(d.createdAt)}
        </span>
      </div>

      {strict && (
        <div className="strict-banner">
          <span className="icon">⚠</span>
          <div>
            Richiede sempre la tua approvazione
            <small>Configurazione git, variabili d'ambiente, hook o file .git: puoi consentire solo questa singola esecuzione.</small>
          </div>
        </div>
      )}

      {d.kind === 'permission' ? (
        <>
          <div className="decision-q">{agent?.name ?? d.agentId} chiede di eseguire:</div>
          <div className="command-block">{d.command ?? d.question}</div>
        </>
      ) : (
        <div className="decision-q">{d.question}</div>
      )}
      {d.context && <div className="decision-context">{d.context}</div>}

      {d.kind === 'question' && (
        <>
          <div className="decision-actions" style={{ marginBottom: 8 }}>
            {d.options.map((o, i) => (
              <button key={o} className={`btn ${i === 0 ? 'primary' : ''}`} disabled={busy} onClick={() => void act(o, text.trim() || undefined)}>
                {o}
              </button>
            ))}
          </div>
          <div className="row">
            <input className="input" placeholder={d.options.length ? 'Nota facoltativa…' : 'La tua risposta…'} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && void act(undefined, text.trim())} />
            <button className="btn" disabled={busy || !text.trim()} onClick={() => void act(undefined, text.trim())}>
              Rispondi
            </button>
          </div>
        </>
      )}

      {d.kind === 'permission' && (
        <div className="decision-actions">
          <button className="btn primary" disabled={busy} onClick={() => void act(d.options[0])}>
            {d.options[0]}
          </button>
          {d.options
            .slice(1)
            .filter((o) => o !== 'Nega')
            .map((o) => (
              <button key={o} className="btn" disabled={busy} onClick={() => void act(o)}>
                {o}
              </button>
            ))}
          <button className="btn danger" disabled={busy} onClick={() => void act('Nega', text.trim() || undefined)}>
            Nega
          </button>
          <input className="input grow" style={{ width: 'auto' }} placeholder="Motivo del rifiuto (facoltativo)" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
      )}

      {d.kind === 'merge' && (
        <div className="decision-actions">
          <button className="btn primary" onClick={() => openMerge(d)}>
            Apri la review
          </button>
          <span className="faint">Merge, Richiedi modifiche o Rifiuta dalla schermata di review.</span>
        </div>
      )}
      {error && <div className="decision-error">{error}</div>}
    </div>
  );
}

export function Decisions(props: Props) {
  const open = props.state.decisions.filter((d) => d.status === 'open').sort((a, b) => a.createdAt - b.createdAt);
  const recent = props.state.decisions.filter((d) => d.status !== 'open').slice(-8).reverse();
  return (
    <div className="view">
      <div className="view-header">
        <h1>Decisioni</h1>
        <span className="sub">{open.length ? `${open.length} aspettano te, dalla più vecchia` : 'nessuna in attesa'}</span>
      </div>
      <div className="decisions">
        {open.length === 0 && <div className="card empty">Nessuna decisione in attesa. Gli agenti ti chiameranno qui quando serve.</div>}
        {open.map((d) => (
          <DecisionCard key={d.id} d={d} {...props} />
        ))}
        {recent.length > 0 && <div className="side-section" style={{ margin: '18px 0 0' }}>Recenti</div>}
        {recent.map((d) => (
          <div key={d.id} className="card" style={{ padding: '8px 12px', fontSize: 13 }}>
            <span className="mono faint">{d.id}</span> {KIND_LABEL[d.kind]} · {d.kind === 'permission' ? (d.command ?? d.question) : d.question}{' '}
            <span className={`badge ${d.status === 'answered' ? 'ok' : ''}`}>{d.status === 'answered' ? [d.answer?.option, d.answer?.text].filter(Boolean).join(' — ') : 'annullata'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
