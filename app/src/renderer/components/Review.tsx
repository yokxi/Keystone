import type { Decision, DiffFile, ViewState } from '@keystone/shared';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { collapseContext } from '../lib/diff-view.js';

export interface ReviewTarget {
  repoId: string;
  worktree: string;
  taskId?: string;
  decisionId?: string;
}

interface Props {
  state: ViewState;
  target: ReviewTarget | undefined;
  answer: (d: Decision, option?: string, text?: string) => Promise<string | undefined>;
  close: () => void;
}

const STATUS_CHAR = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const;

function FileDiff({ f }: { f: DiffFile }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  return (
    <div className="card diff-file" id={`file-${f.path}`}>
      <div className="diff-file-head">
        <span className={`file-status ${f.status}`}>{STATUS_CHAR[f.status]}</span>
        <span className="grow ellipsis">{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</span>
        <span className="add-n">+{f.additions}</span>
        <span className="del-n">−{f.deletions}</span>
      </div>
      {f.binary ? (
        <div className="empty">File binario</div>
      ) : (
        <table className="diff-table">
          <tbody>
            {f.hunks.map((h, hi) => {
              const key = `${f.path}#${hi}`;
              const rows = collapseContext(h, 3, key);
              return (
                <Fragment key={key}>
                  <tr className="hunk">
                    <td className="ln" />
                    <td className="ln" />
                    <td className="code">{h.header}</td>
                  </tr>
                  {rows.flatMap((r, ri) => {
                    if (r.type === 'fold' && !open.has(r.id)) {
                      return [
                        <tr key={`${key}-f${ri}`} className="fold" onClick={() => setOpen((s) => new Set(s).add(r.id))}>
                          <td colSpan={3}>… {r.count} righe invariate (clic per mostrarle)</td>
                        </tr>,
                      ];
                    }
                    if (r.type === 'fold') {
                      // espanso: righe di contesto nascoste, ricostruite dall'hunk
                      const before = rows.slice(0, ri).reduce((s, x) => s + (x.type === 'line' ? 1 : x.count), 0);
                      return h.lines.slice(before, before + r.count).map((l, li) => (
                        <tr key={`${key}-e${ri}-${li}`}>
                          <td className="ln">{l.oldNo ?? ''}</td>
                          <td className="ln">{l.newNo ?? ''}</td>
                          <td className="code"> {l.text}</td>
                        </tr>
                      ));
                    }
                    const l = r.line;
                    return [
                      <tr key={`${key}-${ri}`} className={l.kind}>
                        <td className="ln">{l.oldNo ?? ''}</td>
                        <td className="ln">{l.newNo ?? ''}</td>
                        <td className="code">
                          {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                          {l.text}
                        </td>
                      </tr>,
                    ];
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function Review({ state, target, answer, close }: Props) {
  const [files, setFiles] = useState<DiffFile[]>();
  const [error, setError] = useState<string>();
  const [active, setActive] = useState<string>();
  const [changes, setChanges] = useState('');
  const [busy, setBusy] = useState(false);
  const decision = target?.decisionId ? state.decisions.find((d) => d.id === target.decisionId) : state.decisions.find((d) => d.kind === 'merge' && d.status === 'open' && d.worktree === target?.worktree);
  const task = state.tasks.find((t) => t.id === (target?.taskId ?? decision?.taskId));
  const repo = state.repos.find((r) => r.id === target?.repoId);
  const wt = repo?.worktrees.find((w) => w.id === target?.worktree);

  useEffect(() => {
    if (!target) return;
    setFiles(undefined);
    setError(undefined);
    void window.keystone.requestDiff(target.repoId, target.worktree).then((r) => (r.ok ? setFiles(r.files) : setError(r.error)));
  }, [target?.repoId, target?.worktree, wt?.files, wt?.status]);

  const totals = useMemo(() => (files ?? []).reduce((s, f) => ({ a: s.a + f.additions, d: s.d + f.deletions }), { a: 0, d: 0 }), [files]);

  if (!target) return <div className="view empty">Scegli un task con un worktree dal tabellone, o una decisione di merge.</div>;

  const act = async (option: string, text?: string) => {
    if (!decision) return;
    setBusy(true);
    const err = await answer(decision, option, text);
    setBusy(false);
    if (err) setError(err);
  };
  const canDecide = decision?.status === 'open';

  return (
    <div className="view" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="view-header">
        <button className="btn small ghost" onClick={close}>
          ← Indietro
        </button>
        <h1>Review {task ? `${task.id} · ${task.title}` : target.worktree}</h1>
        {wt && (
          <span className="sub mono">
            {wt.branch} → {wt.base}
          </span>
        )}
      </div>
      <div className="review grow">
        <div className="review-side">
          <div className="card file-list">
            <div className="row" style={{ padding: '4px 8px 8px', fontSize: 12.5 }}>
              <b>{files?.length ?? '…'} file</b>
              <span className="add-n">+{totals.a}</span>
              <span className="del-n">−{totals.d}</span>
            </div>
            {(files ?? []).map((f) => (
              <button
                key={f.path}
                className={`file-item ${active === f.path ? 'active' : ''}`}
                onClick={() => {
                  setActive(f.path);
                  document.getElementById(`file-${f.path}`)?.scrollIntoView({ block: 'start' });
                }}
              >
                <span className={`file-status ${f.status}`}>{STATUS_CHAR[f.status]}</span>
                <span className="grow ellipsis">{f.path}</span>
                <span className="add-n">+{f.additions}</span>
                <span className="del-n">−{f.deletions}</span>
              </button>
            ))}
          </div>
          {task?.summary && (
            <div className="card summary-box">
              <h4>Riassunto del worker</h4>
              <pre>{task.summary}</pre>
            </div>
          )}
          {decision?.context && (
            <div className="card summary-box">
              <h4>Note della review e test</h4>
              <pre>{decision.context}</pre>
            </div>
          )}
          {decision && (
            <div className="card summary-box">
              <h4>Decisione {decision.id}</h4>
              {canDecide ? (
                <>
                  <div className="decision-actions" style={{ marginBottom: 10 }}>
                    <button className="btn ok" disabled={busy} onClick={() => void act('Merge')}>
                      Merge
                    </button>
                    <button className="btn danger" disabled={busy} onClick={() => void act('Rifiuta')}>
                      Rifiuta
                    </button>
                  </div>
                  <textarea className="input" rows={3} placeholder="Cosa va cambiato…" value={changes} onChange={(e) => setChanges(e.target.value)} />
                  <button className="btn" style={{ marginTop: 6 }} disabled={busy || !changes.trim()} onClick={() => void act('Richiedi modifiche', changes.trim())}>
                    Richiedi modifiche
                  </button>
                </>
              ) : (
                <div className="muted">{decision.status === 'answered' ? `Risposta: ${[decision.answer?.option, decision.answer?.text].filter(Boolean).join(' — ')}` : `Chiusa: ${decision.cancelReason ?? ''}`}</div>
              )}
              {error && <div className="decision-error">{error}</div>}
            </div>
          )}
        </div>
        <div className="review-main">
          {error && !decision && <div className="card empty">{error}</div>}
          {!files && !error && <div className="card empty">Carico il diff…</div>}
          {files?.length === 0 && <div className="card empty">Nessuna modifica in questo worktree.</div>}
          {files?.map((f) => (
            <FileDiff key={f.path} f={f} />
          ))}
        </div>
      </div>
    </div>
  );
}
