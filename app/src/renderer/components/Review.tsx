import { consoleKey, errorKey, isConsoleProblem, onlyAfter, requestKey, reviewRisks, type Decision, type DiffFile, type FailedRequest, type PageDiagnostics, type SkillAudience, type Task, type ViewState, type VisualReport } from '@keystone/shared';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { collapseContext } from '../lib/diff-view.js';
import { AUDIENCE_LABEL, freeSkillId, PlaceNote, PlaceSelect, saveCommand, type SkillPlace } from './Skills.js';

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
  /** comando all'orchestratore; restituisce l'errore, se c'è */
  send: (cmd: Parameters<Window['keystone']['send']>[0]) => Promise<string | undefined>;
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

/** Una schermata, caricata solo quando serve (dal main, che la chiede all'orchestratore). */
function Shot({ taskId, side, label, onOpen }: { taskId: string; side: VisualReport['checks'][number]['before']; label: string; onOpen: (src: string) => void }) {
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState<string>();
  const id = side.shot?.id;
  useEffect(() => {
    setSrc(undefined);
    setError(undefined);
    if (!id) return;
    let alive = true;
    void window.keystone.requestShot(taskId, id).then((r) => {
      if (!alive) return;
      if (r.ok) setSrc(r.dataUrl);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [taskId, id]);
  const problem = side.shot?.error ?? side.error;
  return (
    <figure className="shot">
      <figcaption>
        <b>{label}</b>
        {problem && (
          <span className="badge bad" title={problem}>
            {side.shot ? 'passaggio non riuscito' : 'nessuna schermata'}
          </span>
        )}
      </figcaption>
      {src ? (
        <button className="shot-img" onClick={() => onOpen(src)} title="Ingrandisci">
          <img src={src} alt={label} />
        </button>
      ) : (
        <div className="shot-empty">{id ? (error ?? 'carico…') : 'nessuna schermata'}</div>
      )}
      {problem && <div className="shot-problem">{problem}</div>}
    </figure>
  );
}

const requestLabel = (r: FailedRequest) => `${r.method ?? 'GET'} ${r.url} → ${r.blocked ? 'bloccata (non locale)' : (r.status ?? r.failure ?? 'fallita')}`;

/** Console, errori JavaScript e richieste fallite di un lato; "solo dopo" segna le voci nuove. */
function DiagColumn({ label, d, fresh }: { label: string; d: PageDiagnostics | undefined; fresh?: { console: Set<string>; errors: Set<string>; requests: Set<string> } }) {
  if (!d) return <div className="diag-col faint">{label}: nessun dato</div>;
  const problems = d.console.filter(isConsoleProblem);
  const others = d.console.filter((c) => !isConsoleProblem(c));
  const isNew = (set: Set<string> | undefined, key: string) => (set?.has(key) ? <span className="badge bad">solo dopo</span> : null);
  const empty = !d.errors.length && !problems.length && !d.failedRequests.length;
  return (
    <div className="diag-col">
      <div className="diag-title">{label}</div>
      {empty && <div className="faint">nessun errore, avviso o richiesta fallita</div>}
      {d.errors.map((e, i) => (
        <div key={`e${i}`} className="diag-item error">
          {isNew(fresh?.errors, errorKey(e))} <b>errore JS</b> <pre>{e}</pre>
        </div>
      ))}
      {problems.map((c, i) => (
        <div key={`c${i}`} className={`diag-item ${c.type === 'error' ? 'error' : 'warn'}`}>
          {isNew(fresh?.console, consoleKey(c))} <b>console {c.type}</b> <pre>{c.text}</pre>
        </div>
      ))}
      {d.failedRequests.map((r, i) => (
        <div key={`r${i}`} className={`diag-item ${r.blocked ? '' : 'error'}`}>
          {isNew(fresh?.requests, requestKey(r))} <b>richiesta</b> <span className="mono">{requestLabel(r)}</span>
        </div>
      ))}
      {others.length > 0 && (
        <details className="diag-others">
          <summary>altri {others.length} messaggi in console</summary>
          {others.map((c, i) => (
            <div key={`o${i}`} className="diag-item">
              {isNew(fresh?.console, consoleKey(c))} <span className="faint">{c.type}</span> <pre>{c.text}</pre>
            </div>
          ))}
        </details>
      )}
      {d.truncated && <div className="faint">diagnostica troncata: troppe voci</div>}
    </div>
  );
}

/** Diagnostica di una pagina, prima e dopo affiancate, con il riepilogo di ciò che è nuovo. */
function PageDiag({ check }: { check: VisualReport['checks'][number] }) {
  const b = check.before.diagnostics;
  const a = check.after.diagnostics;
  if (!b && !a) return null;
  const fresh = onlyAfter(b, a);
  const freshProblems = fresh.errors.length + fresh.console.filter(isConsoleProblem).length + fresh.failedRequests.length;
  const sets = { console: new Set(fresh.console.map(consoleKey)), errors: new Set(fresh.errors.map(errorKey)), requests: new Set(fresh.failedRequests.map(requestKey)) };
  return (
    <details className="diag" open={freshProblems > 0} data-testid="page-diagnostics">
      <summary>
        Console, errori e rete{' '}
        {b && a ? (
          freshProblems > 0 ? (
            <span className="badge bad">
              solo dopo: {fresh.errors.length} errori JS · {fresh.console.filter(isConsoleProblem).length} errori/avvisi in console · {fresh.failedRequests.length} richieste fallite
            </span>
          ) : (
            <span className="badge ok">niente di nuovo dopo</span>
          )
        ) : (
          <span className="badge">confronto non disponibile</span>
        )}
      </summary>
      <div className="diag-pair">
        <DiagColumn label="Prima" d={b} />
        <DiagColumn label="Dopo" d={a} {...(b ? { fresh: sets } : {})} />
      </div>
    </details>
  );
}

const VISUAL_STATUS: Record<VisualReport['status'], { label: string; cls: string }> = {
  running: { label: 'in corso', cls: 'warn' },
  done: { label: 'eseguita', cls: 'ok' },
  skipped: { label: 'non eseguita', cls: '' },
  failed: { label: 'non riuscita', cls: 'bad' },
};

/** Verifica visuale: schermate prima/dopo affiancate per ogni pagina, con didascalia e problemi. */
function VisualPanel({ task, visual }: { task: Task; visual: VisualReport }) {
  const [zoom, setZoom] = useState<{ src: string; label: string }>();
  const st = VISUAL_STATUS[visual.status];
  return (
    <div className="card visual-panel" data-testid="visual-panel">
      <div className="visual-head">
        <h4>Verifica visuale</h4>
        <span className={`badge ${st.cls}`}>{st.label}</span>
        {visual.note && <span className="muted">{visual.note}</span>}
      </div>
      {visual.problems.length > 0 && (
        <ul className="visual-problems">
          {visual.problems.map((p, i) => (
            <li key={i}>
              <pre>{p}</pre>
            </li>
          ))}
        </ul>
      )}
      {visual.checks.map((c, i) => (
        <div key={i} className="visual-check">
          <div className="visual-check-head">
            <b>{c.name}</b>
            {c.caption && <span className="muted">atteso: {c.caption}</span>}
          </div>
          <div className="shot-pair">
            <Shot taskId={task.id} side={c.before} label="Prima" onOpen={(src) => setZoom({ src, label: `${c.name} · prima` })} />
            <Shot taskId={task.id} side={c.after} label="Dopo" onOpen={(src) => setZoom({ src, label: `${c.name} · dopo` })} />
          </div>
          <PageDiag check={c} />
        </div>
      ))}
      {zoom && (
        <div className="overlay" onClick={() => setZoom(undefined)} role="dialog" aria-modal="true" aria-label={zoom.label}>
          <figure className="shot-zoom" onClick={(e) => e.stopPropagation()}>
            <figcaption>
              {zoom.label}
              <button className="btn small" onClick={() => setZoom(undefined)}>
                Chiudi
              </button>
            </figcaption>
            <img src={zoom.src} alt={zoom.label} />
          </figure>
        </div>
      )}
    </div>
  );
}

const CI_LABEL: Record<Task['ci'], { label: string; cls: string }> = {
  pass: { label: 'superati', cls: 'ok' },
  fail: { label: 'falliti', cls: 'bad' },
  running: { label: 'in corso', cls: 'warn' },
  unknown: { label: 'non eseguiti', cls: '' },
};

/** Le prime parole della correzione, come nome della skill. */
function nameFromText(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' ');
  return (words.length > 80 ? `${words.slice(0, 80)}…` : words) || 'Correzione dalla review';
}

/** Il riassunto della review: richiesta, cosa è stato fatto e perché, file, test, schermate, rischi. */
function ReviewSummary({ task, decision, files, showFile }: { task: Task | undefined; decision: Decision | undefined; files: DiffFile[] | undefined; showFile: (path: string) => void }) {
  const r = task?.report;
  const risks = reviewRisks(task, files);
  const ci = task ? CI_LABEL[task.ci] : undefined;
  return (
    <div className="review-summary" data-testid="review-summary">
      <div className="card summary-box">
        <h4>Richiesta</h4>
        <pre>{r?.request || task?.description || task?.title || '—'}</pre>
      </div>
      <div className="card summary-box" data-testid="work-report">
        <h4>Cosa è stato fatto e perché</h4>
        {r ? (
          <dl className="report">
            <dt>Cosa ha cambiato</dt>
            <dd>{r.changes}</dd>
            <dt>Perché</dt>
            <dd>{r.why}</dd>
            <dt>Come l’ha verificato (secondo il worker)</dt>
            <dd>{r.verification}</dd>
          </dl>
        ) : (
          <pre>{task?.summary ?? 'Il worker non ha mandato un resoconto.'}</pre>
        )}
        {r && task?.summary && (
          <details className="diag-others">
            <summary>riassunto del worker</summary>
            <pre>{task.summary}</pre>
          </details>
        )}
      </div>
      <div className="card summary-box">
        <h4>
          File toccati {files ? `(${files.length})` : ''}
          {files && (
            <>
              {' '}
              <span className="add-n">+{files.reduce((n, f) => n + f.additions, 0)}</span> <span className="del-n">−{files.reduce((n, f) => n + f.deletions, 0)}</span>
            </>
          )}
        </h4>
        {!files && <div className="faint">carico…</div>}
        {files?.length === 0 && <div className="faint">nessuna modifica</div>}
        {files?.map((f) => (
          <button key={f.path} className="file-item" onClick={() => showFile(f.path)} title="Apri nel diff">
            <span className={`file-status ${f.status}`}>{STATUS_CHAR[f.status]}</span>
            <span className="grow ellipsis">{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</span>
            <span className="add-n">+{f.additions}</span>
            <span className="del-n">−{f.deletions}</span>
          </button>
        ))}
      </div>
      <div className="card summary-box" data-testid="review-tests">
        <h4>
          Test eseguiti da Keystone {ci && <span className={`badge ${ci.cls}`}>{ci.label}</span>}
        </h4>
        {decision?.context ? <pre>{decision.context}</pre> : <div className="faint">Nessuna nota: la review del lead non è ancora arrivata.</div>}
      </div>
      {task?.visual && <VisualPanel task={task} visual={task.visual} />}
      <div className="card summary-box" data-testid="review-risks">
        <h4>Rischi</h4>
        {risks.length === 0 && !r?.openIssues && <div className="faint">Nessun rischio rilevato da Keystone e nessun problema aperto dichiarato dal worker.</div>}
        <ul className="risk-list">
          {risks.map((x, i) => (
            <li key={i} className={x.level}>
              {x.text}
            </li>
          ))}
          {r?.openIssues && (
            <li className="warn">
              Problemi aperti secondo il worker: <span style={{ whiteSpace: 'pre-wrap' }}>{r.openIssues}</span>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

export function Review({ state, target, answer, send, close }: Props) {
  const [files, setFiles] = useState<DiffFile[]>();
  const [error, setError] = useState<string>();
  const [active, setActive] = useState<string>();
  const [tab, setTab] = useState<'summary' | 'diff'>('summary');
  const [changes, setChanges] = useState('');
  const [asSkill, setAsSkill] = useState(false);
  const [skillName, setSkillName] = useState('');
  const [skillFor, setSkillFor] = useState<SkillAudience>('worker');
  const [skillPlace, setSkillPlace] = useState<SkillPlace>('personal');
  const [busy, setBusy] = useState(false);
  const decision = target?.decisionId ? state.decisions.find((d) => d.id === target.decisionId) : state.decisions.find((d) => d.kind === 'merge' && d.status === 'open' && d.worktree === target?.worktree);
  const task = state.tasks.find((t) => t.id === (target?.taskId ?? decision?.taskId));
  // merge dell'intero obiettivo (Fase 11): niente task, il worktree è quello dell'obiettivo
  const goal = !task && decision?.goalId ? state.goals.find((g) => g.id === decision.goalId) : undefined;
  const repo = state.repos.find((r) => r.id === target?.repoId);
  const wt = repo?.worktrees.find((w) => w.id === target?.worktree);

  useEffect(() => {
    if (!target) return;
    setFiles(undefined);
    setError(undefined);
    void window.keystone.requestDiff(target.repoId, target.worktree).then((r) => (r.ok ? setFiles(r.files) : setError(r.error)));
  }, [target?.repoId, target?.worktree, wt?.files, wt?.status]);

  // una review nuova si apre sempre sul riassunto
  useEffect(() => setTab('summary'), [target?.repoId, target?.worktree]);

  const totals = useMemo(() => (files ?? []).reduce((s, f) => ({ a: s.a + f.additions, d: s.d + f.deletions }), { a: 0, d: 0 }), [files]);

  if (!target) return <div className="view empty">Scegli un task con un worktree dal tabellone, o una decisione di merge.</div>;

  const act = async (option: string, text?: string) => {
    if (!decision) return;
    setBusy(true);
    const err = await answer(decision, option, text);
    setBusy(false);
    if (err) setError(err);
  };
  const requestChanges = async () => {
    const text = changes.trim();
    if (!decision || !text) return;
    setError(undefined);
    if (asSkill) {
      // prima la skill: se non si salva, la richiesta di modifiche non parte (puoi togliere la spunta)
      const name = skillName.trim() || nameFromText(text);
      const when = skillFor === 'worker' ? (['lavoro'] as const) : skillFor === 'lead' ? (['review'] as const) : (['sempre'] as const);
      setBusy(true);
      const err = await send(saveCommand(skillPlace, freeSkillId(state, skillPlace, name), { name, appliesTo: skillFor, when: [...when], files: [], enabled: true, body: text }, true));
      setBusy(false);
      if (err) {
        setError(`Skill non salvata: ${err}`);
        return;
      }
    }
    await act('Richiedi modifiche', text);
  };
  const showFile = (p: string) => {
    setTab('diff');
    setActive(p);
    requestAnimationFrame(() => document.getElementById(`file-${p}`)?.scrollIntoView({ block: 'start' }));
  };
  const canDecide = decision?.status === 'open';

  return (
    <div className="view" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="view-header">
        <button className="btn small ghost" onClick={close}>
          ← Indietro
        </button>
        <h1>Review {task ? `${task.id} · ${task.title}` : goal ? `obiettivo ${goal.id} · ${goal.text.length > 80 ? `${goal.text.slice(0, 80)}…` : goal.text}` : target.worktree}</h1>
        {wt && (
          <span className="sub mono">
            {wt.branch} → {wt.base}
          </span>
        )}
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'summary'} className={`tab ${tab === 'summary' ? 'active' : ''}`} onClick={() => setTab('summary')}>
          Riassunto
        </button>
        <button role="tab" aria-selected={tab === 'diff'} className={`tab ${tab === 'diff' ? 'active' : ''}`} onClick={() => setTab('diff')}>
          Diff {files ? `· ${files.length} file` : ''} <span className="add-n">+{totals.a}</span> <span className="del-n">−{totals.d}</span>
        </button>
      </div>
      <div className="review grow">
        <div className="review-side">
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
                  <label className="row" style={{ gap: 6, marginTop: 6, fontSize: 13 }}>
                    <input type="checkbox" checked={asSkill} data-testid="save-as-skill" onChange={(e) => setAsSkill(e.target.checked)} />
                    Salva la correzione come skill
                  </label>
                  {asSkill && (
                    <div className="skill-inline" data-testid="skill-inline">
                      <input className="input small" placeholder={nameFromText(changes)} value={skillName} maxLength={100} onChange={(e) => setSkillName(e.target.value)} aria-label="Nome della skill" />
                      <select className="input small" value={skillFor} onChange={(e) => setSkillFor(e.target.value as SkillAudience)} aria-label="Per chi">
                        {(['worker', 'lead', 'tutti'] as const).map((a) => (
                          <option key={a} value={a}>
                            per {AUDIENCE_LABEL[a]}
                          </option>
                        ))}
                      </select>
                      <PlaceSelect state={state} value={skillPlace} onChange={setSkillPlace} />
                      <PlaceNote state={state} place={skillPlace} />
                    </div>
                  )}
                  <button className="btn" style={{ marginTop: 6 }} disabled={busy || !changes.trim()} onClick={() => void requestChanges()}>
                    Richiedi modifiche{asSkill ? ' e salva la skill' : ''}
                  </button>
                </>
              ) : (
                <div className="muted">{decision.status === 'answered' ? `Risposta: ${[decision.answer?.option, decision.answer?.text].filter(Boolean).join(' — ')}` : `Chiusa: ${decision.cancelReason ?? ''}`}</div>
              )}
              {error && <div className="decision-error">{error}</div>}
            </div>
          )}
          {tab === 'diff' && (
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
          )}
        </div>
        <div className="review-main">
          {error && !decision && <div className="card empty">{error}</div>}
          {tab === 'summary' && <ReviewSummary task={task} decision={decision} files={files} showFile={showFile} />}
          {tab === 'diff' && (
            <>
              {!files && !error && <div className="card empty">Carico il diff…</div>}
              {files?.length === 0 && <div className="card empty">Nessuna modifica in questo worktree.</div>}
              {files?.map((f) => (
                <FileDiff key={f.path} f={f} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
