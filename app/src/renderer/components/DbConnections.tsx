// Connessioni a database in sola lettura di un repository (Fase 6c), nella pagina Repository.
//
// La password si scrive qui una volta e va al processo main (cifrata con safeStorage, poi
// all'orchestratore): il renderer non la rilegge mai. Per PostgreSQL e SQL Server serve la tua
// conferma esplicita che l'utente del database ha solo permessi di lettura, ogni volta che salvi.
import { DB_EXPERIMENTAL, DB_KIND_LABEL, DB_KINDS, DB_LIMITS, DbConnection, dbDestination, defaultPort, type DbKind, type Repo } from '@keystone/shared';
import { useEffect, useState } from 'react';

type Send = (cmd: Parameters<Window['keystone']['send']>[0]) => Promise<string | undefined>;

export interface DbForm {
  id: string;
  name: string;
  kind: DbKind;
  file: string;
  host: string;
  port: string;
  database: string;
  user: string;
  tls: boolean;
  trustServerCertificate: boolean;
  maxRows: string;
  timeoutSec: string;
  approveEachQuery: boolean;
  readOnlyUserConfirmed: boolean;
}

/** Un id per gli agenti a partire dal nome: minuscole, cifre, trattini. */
export function dbIdFromName(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'db';
}

export function emptyDbForm(): DbForm {
  return { id: '', name: '', kind: 'sqlite', file: '', host: 'localhost', port: '', database: '', user: '', tls: true, trustServerCertificate: false, maxRows: String(DB_LIMITS.defaultMaxRows), timeoutSec: String(DB_LIMITS.defaultTimeoutSec), approveEachQuery: false, readOnlyUserConfirmed: false };
}

/** Il modulo di una connessione esistente. La conferma di sola lettura riparte sempre da "no". */
export function dbFormFrom(c: DbConnection): DbForm {
  return {
    ...emptyDbForm(),
    id: c.id,
    name: c.name,
    kind: c.kind,
    file: c.file ?? '',
    host: c.host ?? '',
    port: c.port !== undefined ? String(c.port) : '',
    database: c.database ?? '',
    user: c.user ?? '',
    tls: c.tls !== false,
    trustServerCertificate: c.trustServerCertificate === true,
    maxRows: String(c.maxRows),
    timeoutSec: String(c.timeoutSec),
    approveEachQuery: c.approveEachQuery,
    readOnlyUserConfirmed: false,
  };
}

/** Dal modulo alla connessione da salvare, con lo stesso schema dell'orchestratore. */
export function dbConnectionFromForm(f: DbForm): { ok: true; conn: DbConnection } | { ok: false; error: string } {
  const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
  const server = f.kind !== 'sqlite';
  const draft = {
    id: f.id.trim() || dbIdFromName(f.name),
    name: f.name.trim(),
    kind: f.kind,
    ...(server ? {} : { file: f.file.trim() }),
    ...(server
      ? {
          host: f.host.trim(),
          ...(num(f.port) !== undefined ? { port: num(f.port) } : {}),
          database: f.database.trim(),
          user: f.user.trim(),
          ...(f.tls ? {} : { tls: false }),
          ...(f.trustServerCertificate ? { trustServerCertificate: true } : {}),
        }
      : {}),
    maxRows: num(f.maxRows),
    timeoutSec: num(f.timeoutSec),
    approveEachQuery: f.approveEachQuery,
    readOnlyUserConfirmed: server ? f.readOnlyUserConfirmed : false,
  };
  const r = DbConnection.safeParse(draft);
  if (r.success) return { ok: true, conn: r.data };
  const i = r.error.issues[0]!;
  const field: Record<string, string> = { name: 'nome', id: 'id', file: 'file', host: 'server', port: 'porta', database: 'database', user: 'utente', maxRows: 'righe massime', timeoutSec: 'tempo massimo', readOnlyUserConfirmed: 'conferma' };
  const k = String(i.path[0] ?? '');
  return { ok: false, error: `${field[k] ?? k}: ${i.message}` };
}

function DbConnectionForm({ repo, initial, isNew, send, onDone }: { repo: Repo; initial: DbForm; isNew: boolean; send: Send; onDone: () => void }) {
  const [f, setF] = useState<DbForm>(initial);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof DbForm>(k: K, v: DbForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const server = f.kind !== 'sqlite';
  const check = dbConnectionFromForm(f);
  const clash = isNew && check.ok && repo.db?.some((c) => c.id === check.conn.id) ? `esiste già una connessione "${check.conn.id}"` : undefined;
  // la password vale per una destinazione: se la cambi, va riscritta (la vecchia non viene usata)
  const before = !isNew ? repo.db?.find((c) => c.id === initial.id) : undefined;
  const moved = server && before && check.ok && dbDestination(before) !== dbDestination(check.conn) && !password ? 'hai cambiato server, utente, database o cifratura: scrivi di nuovo la password' : undefined;
  const invalid = clash ?? (check.ok ? moved : check.error);
  const pid = (k: string) => `db-${repo.id}-${k}`;

  const save = async () => {
    if (!check.ok || clash) return;
    setBusy(true);
    setError(undefined);
    const err = await send({ type: 'db.save', repoId: repo.id, connection: check.conn });
    if (!err && server && password) {
      const a = await window.keystone.setDbPassword(repo.id, check.conn.id, password, dbDestination(check.conn));
      setPassword('');
      if (!a.ok) {
        setBusy(false);
        setError(`connessione salvata, ma la password no: ${a.error ?? '?'}`);
        return;
      }
    }
    setBusy(false);
    // la password non resta nello stato dell'interfaccia, nemmeno dopo un errore
    setPassword('');
    if (err) setError(err);
    else onDone();
  };

  return (
    <div data-testid={`db-form-${repo.id}`}>
      <div className="db-warning" role="note">
        <strong>I risultati delle query vengono inviati al fornitore del modello.</strong> Usa solo database di sviluppo o con dati anonimizzati, mai di produzione.
      </div>
      <div className="grid">
        <label htmlFor={pid('name')}>Nome</label>
        <input id={pid('name')} className="input small" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Database di sviluppo" />
        <label htmlFor={pid('id')}>Id per gli agenti</label>
        <input id={pid('id')} className="input mono small" value={f.id} disabled={!isNew} onChange={(e) => set('id', e.target.value)} placeholder={dbIdFromName(f.name || 'db')} />
        <label htmlFor={pid('kind')}>Tipo</label>
        <select
          id={pid('kind')}
          className="input small"
          value={f.kind}
          disabled={!isNew}
          onChange={(e) => {
            const k = e.target.value as DbKind;
            setF((x) => ({ ...x, kind: k, port: x.port || (defaultPort(k) ? String(defaultPort(k)) : '') }));
          }}
        >
          {DB_KINDS.map((k) => (
            <option key={k} value={k}>
              {DB_KIND_LABEL[k]}
              {DB_EXPERIMENTAL[k] ? ' (sperimentale)' : ''}
            </option>
          ))}
        </select>
        {!server ? (
          <>
            <label htmlFor={pid('file')}>File</label>
            <input id={pid('file')} className="input mono small" value={f.file} onChange={(e) => set('file', e.target.value)} placeholder="dati/sviluppo.db (relativo al repository) o percorso assoluto" />
          </>
        ) : (
          <>
            <label htmlFor={pid('host')}>Server</label>
            <input id={pid('host')} className="input mono small" value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="localhost" />
            <label htmlFor={pid('port')}>Porta</label>
            <input id={pid('port')} className="input small" style={{ width: 90 }} inputMode="numeric" value={f.port} onChange={(e) => set('port', e.target.value)} placeholder={String(defaultPort(f.kind) ?? '')} />
            <label htmlFor={pid('db')}>Database</label>
            <input id={pid('db')} className="input mono small" value={f.database} onChange={(e) => set('database', e.target.value)} />
            <label htmlFor={pid('user')}>Utente</label>
            <input id={pid('user')} className="input mono small" value={f.user} onChange={(e) => set('user', e.target.value)} placeholder="un utente con soli permessi di lettura" />
            <label htmlFor={pid('pw')}>Password</label>
            <input id={pid('pw')} type="password" autoComplete="off" className="input small" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={isNew ? '' : 'lascia vuoto per non cambiarla'} />
            <span />
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={f.tls} onChange={(e) => set('tls', e.target.checked)} />
              Connessione cifrata (TLS)
            </label>
            <span />
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={f.trustServerCertificate} onChange={(e) => set('trustServerCertificate', e.target.checked)} />
              Accetta un certificato non verificato <span className="faint">(solo server di sviluppo)</span>
            </label>
          </>
        )}
        <label htmlFor={pid('rows')}>Righe massime per query</label>
        <input id={pid('rows')} className="input small" style={{ width: 90 }} inputMode="numeric" value={f.maxRows} onChange={(e) => set('maxRows', e.target.value)} />
        <label htmlFor={pid('to')}>Tempo massimo (s)</label>
        <input id={pid('to')} className="input small" style={{ width: 90 }} inputMode="numeric" value={f.timeoutSec} onChange={(e) => set('timeoutSec', e.target.value)} />
        <span />
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={f.approveEachQuery} onChange={(e) => set('approveEachQuery', e.target.checked)} />
          Approvo io ogni query degli agenti
        </label>
      </div>
      {server && (
        <label className="db-confirm row" style={{ gap: 8 }} data-testid="db-readonly-confirm">
          <input type="checkbox" checked={f.readOnlyUserConfirmed} onChange={(e) => set('readOnlyUserConfirmed', e.target.checked)} />
          <span>
            Confermo che l'utente <strong>{f.user || '…'}</strong> ha <strong>solo permessi di lettura</strong> su questo database. È la garanzia vera: Keystone aggiunge una transazione in sola
            lettura dove il database la permette (PostgreSQL, non SQL Server) e un controllo del testo delle query, che è solo un aiuto.
          </span>
        </label>
      )}
      <p className="note">
        Gli agenti leggono con gli strumenti di Keystone (tabelle, descrizione, query), mai con un client proprio, e non vedono la password. Ogni query va nel registro e nel log dell'agente.
        {server ? " La password si salva cifrata con il sistema (Windows) e arriva all'orchestratore solo in memoria." : " Il file si apre in sola lettura: niente scritture né altri file."}
        {DB_EXPERIMENTAL[f.kind] ? ` ${DB_KIND_LABEL[f.kind]}: ${DB_EXPERIMENTAL[f.kind]}.` : ''} Dettagli in docs/database.md.
      </p>
      {(error ?? invalid) && <div className="decision-error">{error ?? invalid}</div>}
      <div className="decision-actions" style={{ marginTop: 8 }}>
        <button className="btn primary small" data-testid="db-save" disabled={busy || !!invalid} onClick={() => void save()}>
          Salva
        </button>
        <button className="btn small" disabled={busy} onClick={onDone}>
          Annulla
        </button>
      </div>
    </div>
  );
}

/** La sezione "Database" di un repository. */
export function DbConnections({ repo, send }: { repo: Repo; send: Send }) {
  const [editing, setEditing] = useState<{ form: DbForm; isNew: boolean } | undefined>();
  const [keys, setKeys] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ id: string; text: string; ok: boolean }>();
  const [busy, setBusy] = useState(false);
  const conns = repo.db ?? [];
  const refreshKeys = () => void window.keystone.dbPasswordKeys().then(setKeys, () => setKeys([]));
  useEffect(refreshKeys, [repo.db]);

  const test = async (id: string) => {
    setBusy(true);
    setMsg(undefined);
    const a = await window.keystone.send({ type: 'db.test', repoId: repo.id, connectionId: id });
    setBusy(false);
    setMsg({ id, ok: a.ok, text: a.ok ? String(a.result?.text ?? 'ok') : (a.error ?? 'non riuscita') });
  };
  const remove = async (c: DbConnection) => {
    if (!confirm(`Togliere la connessione "${c.name}"? Anche la password salvata viene cancellata.`)) return;
    setBusy(true);
    const err = await send({ type: 'db.delete', repoId: repo.id, connectionId: c.id });
    setBusy(false);
    if (err) setMsg({ id: c.id, ok: false, text: err });
    refreshKeys();
  };

  return (
    <div className="visual-config" data-testid={`db-config-${repo.id}`}>
      <div className="row">
        <span className="muted">database in sola lettura</span>
        {!conns.length && <span className="faint">nessuno</span>}
        {!editing && conns.length < DB_LIMITS.perRepo && (
          <button className="btn small" style={{ marginLeft: 'auto' }} data-testid="db-add" onClick={() => setEditing({ form: emptyDbForm(), isNew: true })}>
            Aggiungi connessione
          </button>
        )}
      </div>
      {!editing &&
        conns.map((c) => {
          const server = c.kind !== 'sqlite';
          const hasPw = keys.includes(`${repo.id}/${c.id}`);
          return (
            <div key={c.id} className="db-row" data-testid={`db-row-${c.id}`}>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <strong>{c.name}</strong>
                <span className="mono faint">{c.id}</span>
                <span className="badge">{DB_KIND_LABEL[c.kind]}</span>
                {DB_EXPERIMENTAL[c.kind] && <span className="badge warn">sperimentale</span>}
                {server && (hasPw ? <span className="badge ok">password salvata</span> : <span className="badge bad">senza password</span>)}
                {c.approveEachQuery && <span className="badge">approvi ogni query</span>}
                <span className="faint">
                  {server ? `${c.user}@${c.host}${c.port ? `:${c.port}` : ''}/${c.database}` : c.file} · {c.maxRows} righe · {c.timeoutSec} s
                </span>
                <span style={{ marginLeft: 'auto' }} className="row">
                  <button className="btn small" disabled={busy} onClick={() => void test(c.id)}>
                    Prova
                  </button>
                  <button className="btn small" disabled={busy} onClick={() => setEditing({ form: dbFormFrom(c), isNew: false })}>
                    Modifica
                  </button>
                  <button className="btn small danger" disabled={busy} onClick={() => void remove(c)}>
                    Togli
                  </button>
                </span>
              </div>
              {msg?.id === c.id && <div className={msg.ok ? 'note' : 'decision-error'}>{msg.text}</div>}
            </div>
          );
        })}
      {editing && (
        <DbConnectionForm
          repo={repo}
          initial={editing.form}
          isNew={editing.isNew}
          send={send}
          onDone={() => {
            setEditing(undefined);
            refreshKeys();
          }}
        />
      )}
    </div>
  );
}
