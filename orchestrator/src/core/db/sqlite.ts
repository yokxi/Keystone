// SQLite con node:sqlite, in un PROCESSO FIGLIO.
//
// Sola lettura su tre livelli:
//  - il file si apre in sola lettura e "immutable": SQLite non crea file accanto (con un database
//    in modalità WAL, la sola lettura normale creerebbe -wal e -shm nella cartella, magari nel tuo
//    repository). Limite: si presume che nessuno scriva sul file mentre Keystone lo legge, e le
//    modifiche ancora nel file -wal non si vedono;
//  - un authorizer ammette solo letture: SELECT, lettura di colonne, funzioni, CTE ricorsive e i
//    PRAGMA che descrivono le tabelle. Tutto il resto è negato, anche quello che funzionerebbe su
//    un file aperto in sola lettura: VACUUM INTO (scrive un altro file), ATTACH (legge altri file),
//    PRAGMA che cambiano impostazioni, estensioni;
//  - il controllo del testo (sql-check.ts), solo come aiuto.
//
// Perché un processo e non un thread: una query può costruire valori enormi in memoria nativa
// (per esempio printf con una larghezza di 800 milioni), che nessun limite di node:sqlite o di V8
// ferma; nel processo dell'orchestratore lo farebbero crollare, con tutti gli agenti. Nel processo
// figlio un crollo resta lì e diventa un errore della query. Il figlio parte con l'ambiente vuoto
// (niente variabili dell'orchestratore), un limite di memoria JavaScript, un tempo massimo (poi
// viene terminato) e un limite ai dati che può restituire.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DbError, splitTable, type DbDriver, type DbRun, type QueryResult, type TableInfo, type TableRef } from './types.js';

/** Dati massimi che il processo di lettura può restituire (le righe oltre si tagliano). */
export const SQLITE_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

/** Codice del processo di lettura (CommonJS, passato con -e: niente file separato da impacchettare). */
const CHILD = String.raw`
const { DatabaseSync, constants: c } = require('node:sqlite');
const { pathToFileURL } = require('node:url');
const DENY_FUNCTIONS = new Set(['zeroblob', 'randomblob', 'load_extension', 'fts3_tokenizer', 'writefile', 'readfile', 'edit']);
const CELL_MAX = 2000;
const OUT_MAX = 4 * 1024 * 1024;
const PRAGMAS = new Set(['table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list']);
const ALLOW = new Set([c.SQLITE_SELECT, c.SQLITE_READ, c.SQLITE_FUNCTION, c.SQLITE_RECURSIVE].filter((x) => x !== undefined));
const cut = (s) => s.length > CELL_MAX ? s.slice(0, CELL_MAX) + '…' : s;
const cell = (v) => v === null || v === undefined ? 'NULL' : typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? '<binario ' + v.byteLength + ' byte>' : cut(String(v));
const quoteId = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const out = (o) => { process.stdout.write(JSON.stringify(o)); };
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let db;
  try {
    const job = JSON.parse(input);
    const url = pathToFileURL(job.file);
    url.searchParams.set('immutable', '1');
    db = new DatabaseSync(url, { readOnly: true, allowExtension: false });
    db.setAuthorizer((action, a1, a2) => {
      if (action === c.SQLITE_FUNCTION && DENY_FUNCTIONS.has(String(a2).toLowerCase())) return c.SQLITE_DENY;
      if (ALLOW.has(action)) return c.SQLITE_OK;
      if (action === c.SQLITE_PRAGMA && PRAGMAS.has(String(a1).toLowerCase())) return c.SQLITE_OK;
      return c.SQLITE_DENY;
    });
    if (job.op === 'tables') {
      const rows = db.prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 2000").all();
      out({ ok: true, tables: rows.map((r) => ({ name: String(r.name), type: r.type === 'view' ? 'view' : 'table' })) });
    } else if (job.op === 'describe') {
      const t = job.table;
      const q = (p) => db.prepare('PRAGMA ' + p + '(' + quoteId(t) + ')').all();
      const cols = q('table_info');
      if (!cols.length) throw new Error('tabella sconosciuta: ' + t);
      const fks = q('foreign_key_list');
      const idx = q('index_list');
      const indexes = idx.map((i) => {
        const parts = db.prepare('PRAGMA index_info(' + quoteId(i.name) + ')').all().map((x) => String(x.name));
        return String(i.name) + (i.unique ? ' (unico)' : '') + ': ' + parts.join(', ');
      });
      out({ ok: true, info: {
        table: t,
        columns: cols.map((x) => ({ name: String(x.name), type: String(x.type || ''), nullable: !x.notnull, ...(x.dflt_value !== null ? { default: String(x.dflt_value) } : {}), ...(x.pk ? { primaryKey: true } : {}) })),
        foreignKeys: fks.map((f) => String(f.from) + ' -> ' + String(f.table) + '(' + String(f.to) + ')'),
        indexes,
      } });
    } else {
      const st = db.prepare(job.sql);
      const columns = st.columns().map((x) => String(x.name));
      st.setReturnArrays(true);
      const rows = [];
      let truncated = false;
      let size = 0;
      for (const r of st.iterate()) {
        if (rows.length >= job.maxRows || size > OUT_MAX) { truncated = true; break; }
        const row = r.map(cell);
        size += row.reduce((s, x) => s + x.length + 4, 0);
        rows.push(row);
      }
      out({ ok: true, result: { columns, rows, truncated } });
    }
  } catch (e) {
    out({ ok: false, error: String(e && e.message || e) });
  } finally {
    try { db && db.close(); } catch {}
  }
});
`;

/** Il file del database: assoluto, oppure relativo alla cartella del repository. Deve esistere. */
export function sqliteFile(file: string, repoPath: string): string {
  const abs = path.resolve(repoPath, file);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new DbError(`il file SQLite non esiste: ${abs}`, 'config');
  }
  if (!st.isFile()) throw new DbError(`non è un file: ${abs}`, 'config');
  return abs;
}

function runChild<T>(job: Record<string, unknown>, timeoutMs: number, pick: (m: Record<string, unknown>) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    // ambiente vuoto: solo quello che serve perché l'eseguibile (Node, o Keystone.exe) faccia da Node
    const child = spawn(process.execPath, ['--max-old-space-size=256', '-e', CHILD], {
      env: { ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let outText = '';
    let errText = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new DbError(`tempo scaduto (${Math.round(timeoutMs / 1000)} s): query interrotta`, 'timeout'))), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      outText += d;
      if (outText.length > SQLITE_OUTPUT_MAX_BYTES) finish(() => reject(new DbError('il risultato è troppo grande: restringi la query', 'query')));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      if (errText.length < 4000) errText += d;
    });
    child.on('error', (e) => finish(() => reject(new DbError(`il lettore SQLite non è partito: ${e.message}`, 'query'))));
    child.on('close', (code) => {
      finish(() => {
        let m: Record<string, unknown> | undefined;
        try {
          m = JSON.parse(outText) as Record<string, unknown>;
        } catch {
          m = undefined;
        }
        if (m?.ok) resolve(pick(m));
        else if (m) reject(new DbError(String(m.error), 'query'));
        // il processo è crollato (memoria esaurita, per esempio): la query fallisce, l'orchestratore no
        else reject(new DbError(`la query ha fatto fermare il lettore SQLite (codice ${code}): probabilmente un valore troppo grande. Restringi la query`, 'query'));
      });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(job));
  });
}

// metodi async: anche un errore di configurazione (file mancante) arriva come promessa rifiutata
export const sqliteDriver: DbDriver = {
  async tables(run: DbRun): Promise<TableRef[]> {
    const file = sqliteFile(run.conn.file ?? '', run.repoPath);
    return runChild({ op: 'tables', file }, run.timeoutMs, (m) => m.tables as TableRef[]);
  },
  async describe(run: DbRun, table: string): Promise<TableInfo> {
    const file = sqliteFile(run.conn.file ?? '', run.repoPath);
    return runChild({ op: 'describe', file, table: splitTable(table).name }, run.timeoutMs, (m) => m.info as TableInfo);
  },
  async query(run: DbRun, sql: string, maxRows: number): Promise<QueryResult> {
    const file = sqliteFile(run.conn.file ?? '', run.repoPath);
    return runChild({ op: 'query', file, sql, maxRows }, run.timeoutMs, (m) => m.result as QueryResult);
  },
};
