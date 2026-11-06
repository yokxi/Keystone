// PostgreSQL con pg (sperimentale: non ancora provato con un server reale).
//
// Ogni operazione apre una connessione, lavora in una transazione READ ONLY (e con
// default_transaction_read_only attivo per la sessione), legge al massimo maxRows + 1 righe con un
// cursore (la tabella non viene caricata tutta in memoria), fa ROLLBACK e chiude. Il tempo massimo
// vale sia per il collegamento sia per l'istruzione (statement_timeout); oltre il tempo (più un
// margine) la query viene annullata sul server da una seconda connessione e il socket chiuso, perché
// la query stessa potrebbe aver cambiato statement_timeout. La garanzia vera resta l'utente con soli
// permessi di lettura.
import pg, { type Client } from 'pg';
import Cursor from 'pg-cursor';
import { cellText, DbError, splitTable, type DbDriver, type DbRun, type QueryResult, type TableInfo, type TableRef } from './types.js';

function clientFor(run: DbRun): Client {
  const c = run.conn;
  const client = new pg.Client({
    host: c.host,
    port: c.port ?? 5432,
    database: c.database,
    user: c.user,
    password: run.password,
    ssl: c.tls === false ? false : { rejectUnauthorized: !c.trustServerCertificate },
    connectionTimeoutMillis: run.timeoutMs,
    statement_timeout: run.timeoutMs,
    query_timeout: run.timeoutMs + 2000,
    application_name: 'keystone (sola lettura)',
    options: '-c default_transaction_read_only=on',
  });
  client.on('error', () => undefined);
  return client;
}

/** Una promessa con un limite di tempo: allo scadere si va avanti comunque. */
const bounded = (p: Promise<unknown>, ms: number) => Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, ms).unref())]);

/** Chiude il socket senza aspettare il server. */
const destroy = (client: Client) => client.connection?.stream?.destroy();

/**
 * Annulla sul server la query della sessione `pid`, da una seconda connessione breve (un utente
 * può annullare le query delle proprie sessioni). Serve perché statement_timeout lo può cambiare
 * anche la query stessa (set_config), e chiudere solo il socket lascerebbe la query a girare.
 */
async function cancelOnServer(run: DbRun, pid: number): Promise<void> {
  const k = clientFor({ ...run, timeoutMs: 5000 });
  try {
    await bounded(k.connect().then(() => k.query('SELECT pg_cancel_backend($1)', [pid])), 6000);
  } finally {
    await bounded(k.end(), 2000);
    destroy(k);
  }
}

async function withReadOnly<T>(run: DbRun, fn: (c: Client) => Promise<T>): Promise<T> {
  if (!run.password) throw new DbError('password non disponibile: aprila nell\'app (le password si leggono solo dall\'app)', 'secret');
  const client = clientFor(run);
  try {
    await client.connect();
  } catch (e) {
    destroy(client);
    throw new DbError(`collegamento non riuscito: ${(e as Error).message}`, 'connect');
  }
  let killer: NodeJS.Timeout | undefined;
  try {
    const who = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = who.rows[0]?.pid;
    // oltre il tempo massimo (più un margine): la query si annulla sul server e il socket si chiude
    killer = setTimeout(() => {
      void (pid ? cancelOnServer(run, pid) : Promise.resolve()).finally(() => destroy(client));
    }, run.timeoutMs + 1000);
    killer.unref();
    await client.query('BEGIN TRANSACTION READ ONLY');
    return await fn(client);
  } catch (e) {
    if (e instanceof DbError) throw e;
    const msg = (e as Error).message;
    throw new DbError(msg, /statement timeout|query read timeout|canceling statement|Connection terminated/i.test(msg) ? 'timeout' : 'query');
  } finally {
    clearTimeout(killer);
    // ROLLBACK e chiusura con un limite: non si resta appesi a un server che non risponde
    await bounded(client.query('ROLLBACK'), 2000);
    await bounded(client.end(), 2000);
    destroy(client);
  }
}

export const postgresDriver: DbDriver = {
  tables(run: DbRun): Promise<TableRef[]> {
    return withReadOnly(run, async (c) => {
      const r = await c.query<{ s: string; n: string; t: string }>(
        "SELECT table_schema AS s, table_name AS n, table_type AS t FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1, 2 LIMIT 2000",
      );
      return r.rows.map((x) => ({ schema: x.s, name: x.n, type: x.t === 'VIEW' ? 'view' : 'table' }));
    });
  },
  describe(run: DbRun, table: string): Promise<TableInfo> {
    const { schema, name } = splitTable(table, 'public');
    return withReadOnly(run, async (c) => {
      const cols = await c.query<{ n: string; t: string; nul: string; d: string | null }>(
        'SELECT column_name AS n, data_type AS t, is_nullable AS nul, column_default AS d FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
        [schema, name],
      );
      if (!cols.rows.length) throw new DbError(`tabella sconosciuta: ${schema}.${name}`, 'query');
      const keys = await c.query<{ k: string; col: string; ft: string | null; fc: string | null }>(
        `SELECT tc.constraint_type AS k, kcu.column_name AS col, ccu.table_schema || '.' || ccu.table_name AS ft, ccu.column_name AS fc
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
           LEFT JOIN information_schema.constraint_column_usage ccu ON tc.constraint_type = 'FOREIGN KEY' AND ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.table_schema
          WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')`,
        [schema, name],
      );
      const pk = new Set(keys.rows.filter((k) => k.k === 'PRIMARY KEY').map((k) => k.col));
      const idx = await c.query<{ d: string }>('SELECT indexdef AS d FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname', [schema, name]);
      return {
        table: `${schema}.${name}`,
        columns: cols.rows.map((x) => ({ name: x.n, type: x.t, nullable: x.nul === 'YES', ...(x.d !== null ? { default: x.d } : {}), ...(pk.has(x.n) ? { primaryKey: true } : {}) })),
        foreignKeys: keys.rows.filter((k) => k.k === 'FOREIGN KEY').map((k) => `${k.col} -> ${k.ft ?? '?'}(${k.fc ?? '?'})`),
        indexes: idx.rows.map((x) => x.d),
      };
    });
  },
  query(run: DbRun, sql: string, maxRows: number): Promise<QueryResult> {
    return withReadOnly(run, async (c) => {
      const cursor = c.query(new Cursor(sql, [], { rowMode: 'array' }));
      try {
        const rows = (await cursor.read(maxRows + 1)) as unknown[][];
        const fields = ((cursor as unknown as { _result?: { fields?: Array<{ name: string }> } })._result?.fields ?? []).map((f) => f.name);
        return { columns: fields, rows: rows.slice(0, maxRows).map((r) => r.map(cellText)), truncated: rows.length > maxRows };
      } finally {
        await cursor.close().catch(() => undefined);
      }
    });
  },
};
