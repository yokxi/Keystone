// Accesso al database in sola lettura (Fase 6c): connessioni, password in memoria, esecuzione
// con i limiti, registro.
//
//  - Le connessioni stanno nel record del repository (senza password).
//  - Le password arrivano dall'app (db.secret) e restano SOLO in memoria: mai nello stato, nei log,
//    nel registro, nei messaggi d'errore (vengono tolte), nei prompt o nell'ambiente degli agenti.
//  - Ogni operazione degli agenti finisce nel registro (~/.keystone/<profilo>/db-queries.jsonl):
//    testo, agente, connessione, durata, righe, esito. I risultati no.
//  - I risultati vanno al modello: per questo si usano solo database di sviluppo o con dati
//    anonimizzati (avviso nell'interfaccia e in docs/sicurezza.md).
import fs from 'node:fs';
import path from 'node:path';
import { DB_KIND_LABEL, DbConnection, dbDestination, type DbKind, type Repo } from '@keystone/shared';
import { postgresDriver } from './postgres.js';
import { checkReadOnlySql } from './sql-check.js';
import { sqliteDriver } from './sqlite.js';
import { sqlserverDriver } from './sqlserver.js';
import { DbError, type DbDriver, type QueryResult, type TableInfo, type TableRef } from './types.js';

export type DbOp = { kind: 'tables' } | { kind: 'describe'; table: string } | { kind: 'query'; sql: string };

export interface DbLogEntry {
  ts: number;
  agentId: string;
  repoId: string;
  connectionId: string;
  op: DbOp['kind'];
  /** la query, o la tabella descritta */
  text?: string;
  durationMs: number;
  rows?: number;
  outcome: 'ok' | 'error' | 'refused' | 'denied' | 'timeout';
  error?: string;
}

export interface DbOpResult {
  /** il testo per l'agente */
  text: string;
  rows: number;
  durationMs: number;
}

/** Limiti del testo restituito all'agente. */
export const DB_TEXT_LIMITS = { cellChars: 200, totalChars: 40_000 } as const;
export const DB_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Operazioni sul database contemporanee, per tutto l'orchestratore (ognuna apre un thread o una connessione). */
export const DB_MAX_CONCURRENT = 4;

const DRIVERS: Record<DbKind, DbDriver> = { sqlite: sqliteDriver, postgres: postgresDriver, sqlserver: sqlserverDriver };

export interface DbManagerDeps {
  repos: () => readonly Repo[];
  /** il file del registro */
  logFile: string;
  now: () => number;
  /** solo test: driver al posto di quelli veri */
  drivers?: Partial<Record<DbKind, DbDriver>>;
}

export class DbManager {
  /** password in memoria: chiave "repoId/connectionId", con la destinazione per cui sono state date */
  private readonly secrets = new Map<string, { password: string; destination: string }>();
  private running = 0;

  constructor(private readonly d: DbManagerDeps) {}

  connections(repoId: string | undefined): DbConnection[] {
    if (!repoId) return [];
    return this.d.repos().find((r) => r.id === repoId)?.db ?? [];
  }

  find(repoId: string, connectionId: string): { repo: Repo; conn: DbConnection } {
    const repo = this.d.repos().find((r) => r.id === repoId);
    const conn = repo?.db?.find((c) => c.id === connectionId);
    if (!repo || !conn) {
      const ids = this.connections(repoId).map((c) => c.id);
      throw new DbError(`connessione sconosciuta: ${connectionId}${ids.length ? ` (disponibili: ${ids.join(', ')})` : ' (nessuna connessione configurata per questo repository)'}`, 'config');
    }
    return { repo, conn };
  }

  /**
   * La password di una connessione, per la sua destinazione attuale. Se `destination` è indicata e
   * non è quella della connessione (cambiata nel frattempo), la password è rifiutata.
   */
  setSecret(repoId: string, connectionId: string, password: string | null, destination?: string): void {
    const key = `${repoId}/${connectionId}`;
    if (password === null) {
      this.secrets.delete(key);
      return;
    }
    const current = dbDestination(this.find(repoId, connectionId).conn);
    if (destination !== undefined && destination !== current) throw new DbError('la connessione è cambiata: scrivi di nuovo la password', 'secret');
    this.secrets.set(key, { password, destination: current });
  }

  hasSecret(repoId: string, connectionId: string): boolean {
    return this.passwordFor(repoId, connectionId) !== undefined;
  }

  /** La password, solo se la connessione va ancora dove andava quando è stata data; altrimenti la dimentica. */
  private passwordFor(repoId: string, connectionId: string): string | undefined {
    const key = `${repoId}/${connectionId}`;
    const s = this.secrets.get(key);
    if (!s) return undefined;
    const conn = this.d.repos().find((r) => r.id === repoId)?.db?.find((c) => c.id === connectionId);
    if (!conn || dbDestination(conn) !== s.destination) {
      this.secrets.delete(key);
      return undefined;
    }
    return s.password;
  }

  /** Toglie la password di una connessione cancellata o di un repository rimosso. */
  forget(repoId: string, connectionId?: string): void {
    for (const k of [...this.secrets.keys()]) if (connectionId ? k === `${repoId}/${connectionId}` : k.startsWith(`${repoId}/`)) this.secrets.delete(k);
  }

  /** Toglie le password note da un testo (messaggi d'errore dei driver). */
  scrub(text: string): string {
    let out = text;
    // le password hanno almeno 4 caratteri (protocollo db.secret)
    for (const { password: pw } of this.secrets.values()) if (pw.length >= 4) out = out.split(pw).join('***');
    return out;
  }

  /**
   * Esegue un'operazione per un agente, con i limiti della connessione. Non chiede approvazioni:
   * lo fanno i tool (core/tools.ts), che poi registrano anche i dinieghi con `record`.
   */
  async run(repoId: string, connectionId: string, op: DbOp, agentId: string): Promise<DbOpResult> {
    const start = this.d.now();
    const text = op.kind === 'query' ? op.sql : op.kind === 'describe' ? op.table : undefined;
    const base = { agentId, repoId, connectionId, op: op.kind, ...(text !== undefined ? { text } : {}) };
    let conn: DbConnection;
    let repo: Repo;
    try {
      ({ repo, conn } = this.find(repoId, connectionId));
      if (op.kind === 'query') {
        const why = checkReadOnlySql(op.sql, conn.kind);
        if (why) throw new DbError(`query rifiutata: ${why}. Nota: questo controllo è solo un aiuto; la garanzia è l'utente del database con soli permessi di lettura.`, 'refused');
      }
    } catch (e) {
      const err = e as DbError;
      this.record({ ...base, ts: start, durationMs: 0, outcome: err.code === 'refused' ? 'refused' : 'error', error: err.message });
      throw err;
    }
    if (this.running >= DB_MAX_CONCURRENT) {
      const msg = `troppe operazioni sul database in corso (al massimo ${DB_MAX_CONCURRENT} insieme): riprova tra poco`;
      this.record({ ...base, ts: start, durationMs: 0, outcome: 'refused', error: msg });
      throw new DbError(msg, 'refused');
    }
    const driver = this.d.drivers?.[conn.kind] ?? DRIVERS[conn.kind];
    const password = this.passwordFor(repoId, connectionId);
    const timeoutMs = conn.timeoutSec * 1000;
    const runCfg = { conn, repoPath: repo.path, timeoutMs, ...(password ? { password } : {}) };
    this.running++;
    try {
      // un limite in più, oltre a quelli dei driver: l'operazione non può restare appesa
      const work: Promise<TableRef[] | TableInfo | QueryResult> = op.kind === 'tables' ? driver.tables(runCfg) : op.kind === 'describe' ? driver.describe(runCfg, op.table) : driver.query(runCfg, op.sql, conn.maxRows);
      const out = await withTimeout(work, timeoutMs + 5000);
      const durationMs = this.d.now() - start;
      const rows = op.kind === 'tables' ? (out as TableRef[]).length : op.kind === 'describe' ? (out as TableInfo).columns.length : (out as QueryResult).rows.length;
      this.record({ ...base, ts: start, durationMs, rows, outcome: 'ok' });
      const head = `Connessione "${conn.name}" (${DB_KIND_LABEL[conn.kind]}, sola lettura) · ${durationMs} ms`;
      const body = op.kind === 'tables' ? formatTables(out as TableRef[]) : op.kind === 'describe' ? formatTableInfo(out as TableInfo) : formatResult(out as QueryResult, conn.maxRows);
      return { text: `${head}\n\n${body}`, rows, durationMs };
    } catch (e) {
      const err = e instanceof DbError ? e : new DbError((e as Error).message, 'query');
      const message = this.scrub(err.message);
      this.record({ ...base, ts: start, durationMs: this.d.now() - start, outcome: err.code === 'timeout' ? 'timeout' : 'error', error: message });
      throw new DbError(message, err.code);
    } finally {
      this.running--;
    }
  }

  /** Scrive una riga nel registro (senza risultati né password). */
  record(entry: DbLogEntry): void {
    const clean: DbLogEntry = { ...entry, ...(entry.text ? { text: this.scrub(entry.text).slice(0, 20_000) } : {}), ...(entry.error ? { error: this.scrub(entry.error).slice(0, 2000) } : {}) };
    try {
      fs.mkdirSync(path.dirname(this.d.logFile), { recursive: true });
      try {
        if (fs.statSync(this.d.logFile).size > DB_LOG_MAX_BYTES) fs.renameSync(this.d.logFile, `${this.d.logFile}.1`);
      } catch {
        /* il registro non c'è ancora */
      }
      fs.appendFileSync(this.d.logFile, `${JSON.stringify(clean)}\n`);
    } catch {
      /* il registro non deve fermare il lavoro */
    }
  }

  /** Prova una connessione dall'interfaccia: elenca le tabelle. */
  async test(repoId: string, connectionId: string): Promise<string> {
    const { repo, conn } = this.find(repoId, connectionId);
    const driver = this.d.drivers?.[conn.kind] ?? DRIVERS[conn.kind];
    const password = this.passwordFor(repoId, connectionId);
    try {
      const t = await withTimeout(driver.tables({ conn, repoPath: repo.path, timeoutMs: conn.timeoutSec * 1000, ...(password ? { password } : {}) }), conn.timeoutSec * 1000 + 5000);
      return `collegamento riuscito: ${t.length} tabelle o viste`;
    } catch (e) {
      throw new DbError(this.scrub((e as Error).message), (e as DbError).code ?? 'connect');
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new DbError(`tempo scaduto (${Math.round(ms / 1000)} s)`, 'timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e as Error);
      },
    );
  });
}

const cell = (s: string) => {
  const one = s.replace(/\r?\n/g, '⏎').replace(/\|/g, '\\|');
  return one.length > DB_TEXT_LIMITS.cellChars ? `${one.slice(0, DB_TEXT_LIMITS.cellChars)}…` : one;
};

export function formatResult(r: QueryResult, maxRows: number): string {
  if (!r.columns.length && !r.rows.length) return 'Nessuna riga.';
  const lines = [r.columns.map(cell).join(' | '), r.columns.map(() => '---').join(' | ')];
  let used = lines.join('\n').length;
  let shown = 0;
  for (const row of r.rows) {
    const line = row.map(cell).join(' | ');
    if (used + line.length + 1 > DB_TEXT_LIMITS.totalChars) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  const notes: string[] = [];
  notes.push(`${r.rows.length} righe${r.truncated ? ` (limite della connessione: ${maxRows}; ce ne sono altre, restringi la query)` : ''}`);
  if (shown < r.rows.length) notes.push(`mostrate le prime ${shown}: il resto supera la lunghezza massima del risultato`);
  return `${lines.join('\n')}\n\n${notes.join('; ')}.`;
}

export function formatTables(t: TableRef[]): string {
  if (!t.length) return 'Nessuna tabella.';
  const lines = t.map((x) => `- ${x.schema ? `${x.schema}.` : ''}${x.name}${x.type === 'view' ? ' (vista)' : ''}`);
  return `${lines.join('\n')}${t.length >= 2000 ? '\n\nElenco limitato alle prime 2000: usa db_query sulle tabelle di sistema per cercarne altre.' : ''}`;
}

export function formatTableInfo(t: TableInfo): string {
  const cols = t.columns.map((c) => `- ${c.name}: ${c.type || '?'}${c.nullable ? '' : ' NOT NULL'}${c.primaryKey ? ' (chiave primaria)' : ''}${c.default !== undefined ? ` default ${c.default}` : ''}`);
  return [
    `Tabella ${t.table}`,
    '',
    'Colonne:',
    ...cols,
    ...(t.foreignKeys.length ? ['', 'Chiavi esterne:', ...t.foreignKeys.map((f) => `- ${f}`)] : []),
    ...(t.indexes.length ? ['', 'Indici:', ...t.indexes.map((i) => `- ${i}`)] : []),
  ].join('\n');
}

/** Valida una connessione da salvare (oltre allo schema): il file SQLite, i limiti per repository. */
export function validateConnection(c: DbConnection, existing: readonly DbConnection[], maxPerRepo: number): DbConnection {
  const parsed = DbConnection.parse(c);
  if (!existing.some((x) => x.id === parsed.id) && existing.length >= maxPerRepo) throw new DbError(`al massimo ${maxPerRepo} connessioni per repository`, 'config');
  return parsed;
}
