import type { RepoPreview, ViewState } from '@keystone/shared';
import { useEffect, useState } from 'react';

interface Props {
  state: ViewState;
  openRegister: (path?: string) => void;
  send: (cmd: Parameters<Window['keystone']['send']>[0]) => Promise<void>;
}

export function Repos({ state, openRegister, send }: Props) {
  return (
    <div className="view">
      <div className="view-header">
        <h1>Repository</h1>
        <span className="sub">gli agenti lavorano in worktree separati; il tuo checkout cambia solo con un merge che approvi</span>
        <div className="actions">
          <button className="btn" onClick={() => void send({ type: 'worktrees.prune' })} title="Chiude i worktree di task finiti e rimuove quelli orfani">
            Pulisci worktree
          </button>
          <button className="btn primary" onClick={() => openRegister()}>
            Registra repository
          </button>
        </div>
      </div>
      {state.repos.length === 0 && <div className="card empty">Nessun repository registrato.</div>}
      {state.repos.map((r) => (
        <div key={r.id} className="card repo-card">
          <div className="row" style={{ marginBottom: 6 }}>
            <h3 style={{ fontSize: 16 }}>{r.name}</h3>
            <span className="badge accent mono">{r.branch}</span>
            {r.dirty ? <span className="badge warn">modifiche non committate</span> : <span className="badge ok">pulito</span>}
            {r.ci !== 'unknown' && <span className={`badge ${r.ci === 'pass' ? 'ok' : r.ci === 'fail' ? 'bad' : 'warn'}`}>test: {r.ci}</span>}
          </div>
          <div className="mono faint" style={{ fontSize: 12, marginBottom: 8 }}>
            {r.path}
          </div>
          {r.worktrees.filter((w) => w.status === 'active').length === 0 && <div className="faint">Nessun worktree attivo.</div>}
          {r.worktrees
            .filter((w) => w.status === 'active')
            .map((w) => (
              <div key={w.id} className="worktree-row">
                <span className="mono ellipsis">{w.branch}</span>
                <span className="muted">
                  {w.files} file <span className="add-n">+{w.additions}</span> <span className="del-n">−{w.deletions}</span>
                </span>
                <span className="badge">{state.agents.find((a) => a.id === w.agentId)?.name ?? w.agentId}</span>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Registrazione di un repository: prima l'anteprima della riga che verrà aggiunta al .git/config
 * (il guardiano git), poi la conferma esplicita. Senza conferma il file non viene toccato.
 */
export function RegisterRepoDialog({ initialPath, close, send }: { initialPath?: string; close: () => void; send: (cmd: Parameters<Window['keystone']['send']>[0]) => Promise<string | undefined> }) {
  const [path, setPath] = useState(initialPath ?? '');
  const [preview, setPreview] = useState<RepoPreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = async (p: string) => {
    setError(undefined);
    setPreview(undefined);
    if (!p.trim()) return;
    setBusy(true);
    const r = await window.keystone.previewRepo(p.trim());
    setBusy(false);
    if (r.ok) setPreview(r.preview);
    else setError(r.error);
  };
  useEffect(() => {
    if (initialPath) void load(initialPath);
  }, [initialPath]);

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    const err = await send({ type: 'repo.add', path: preview.root, confirmGuard: true });
    setBusy(false);
    if (err) setError(err);
    else close();
  };

  return (
    <div className="overlay" onClick={close}>
      <div className="card dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2>Registra un repository</h2>
        <p className="lead">Scegli la cartella principale del repository. Prima di registrarlo ti mostro esattamente cosa cambierà.</p>
        <div className="row" style={{ marginBottom: 14 }}>
          <input className="input mono" placeholder="C:\percorso\del\repository" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void load(path)} />
          <button
            className="btn"
            onClick={async () => {
              const p = await window.keystone.pickFolder();
              if (p) {
                setPath(p);
                void load(p);
              }
            }}
          >
            Sfoglia…
          </button>
          <button className="btn" disabled={busy || !path.trim()} onClick={() => void load(path)}>
            Anteprima
          </button>
        </div>

        {preview && preview.installed && <p className="muted">Il guardiano git è già presente in questo repository: nessuna modifica al .git/config.</p>}
        {preview && !preview.installed && (
          <>
            <p style={{ margin: '0 0 8px' }}>
              Verranno aggiunte <b>in fondo</b> a questo file le righe seguenti (nient'altro cambia):
            </p>
            <div className="config-preview">
              <div className="file">{preview.configFile}</div>
              <pre>
                <span className="faint">… contenuto attuale invariato …</span>
                {'\n'}
                {preview.lines.map((l) => (
                  <span key={l} className="added">
                    + {l.replace(/\t/g, '    ')}
                  </span>
                ))}
              </pre>
            </div>
            <ul className="dialog-list">
              <li>
                Vale <b>solo</b> nei worktree degli agenti (cartelle <span className="mono">ks-…</span>): blocca push, credenziali e firma. Il tuo checkout, il tuo push e i tuoi fetch non cambiano.
              </li>
              <li>
                Include il file di regole di Keystone <span className="mono">{preview.guardFile}</span>, fuori dal repository; gli agenti non possono modificarlo.
              </li>
              <li>
                Per toglierla: <span className="mono">npm run orchestrator -- --remove-git-guard "{preview.root}"</span>, oppure cancella le due righe dal file. Dettagli in docs/sicurezza.md.
              </li>
            </ul>
          </>
        )}
        {error && <div className="decision-error">{error}</div>}
        <div className="dialog-actions">
          <button className="btn" onClick={close}>
            Annulla
          </button>
          <button className="btn primary" disabled={!preview || busy} onClick={() => void confirm()}>
            {preview?.installed ? 'Registra' : 'Conferma e registra'}
          </button>
        </div>
      </div>
    </div>
  );
}
