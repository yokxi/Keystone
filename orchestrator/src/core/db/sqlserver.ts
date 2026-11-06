// SQL Server con tedious (sperimentale: non ancora provato con un server reale).
//
// SQL Server non ha transazioni in sola lettura: la garanzia è solo l'utente con soli permessi di
// lettura, confermato da te nella configurazione. In più: ApplicationIntent=ReadOnly (con i gruppi
// di disponibilità porta su una replica di sola lettura), lettura di al massimo maxRows + 1 righe
// (poi la richiesta viene annullata), tempo massimo di collegamento e di richiesta, una connessione
// per operazione.
import { Connection, Request, TYPES } from 'tedious';

/** I metadati di una colonna che servono qui (tedious non esporta il tipo dal modulo principale). */
interface ColumnMetaData {
  colName: string;
}
import { cellText, DbError, splitTable, type DbDriver, type DbRun, type QueryResult, type TableInfo, type TableRef } from './types.js';

function connect(run: DbRun): Promise<Connection> {
  const c = run.conn;
  if (!run.password) return Promise.reject(new DbError("password non disponibile: aprila nell'app (le password si leggono solo dall'app)", 'secret'));
  const conn = new Connection({
    server: c.host!,
    authentication: { type: 'default', options: { userName: c.user!, password: run.password } },
    options: {
      port: c.port ?? 1433,
      database: c.database!,
      encrypt: c.tls !== false,
      trustServerCertificate: c.trustServerCertificate === true,
      readOnlyIntent: true,
      connectTimeout: run.timeoutMs,
      requestTimeout: run.timeoutMs,
      appName: 'keystone (sola lettura)',
      rowCollectionOnRequestCompletion: false,
      useColumnNames: false,
    },
  });
  return new Promise((resolve, reject) => {
    conn.on('error', () => undefined);
    conn.connect((err) => {
      if (!err) return resolve(conn);
      conn.close();
      reject(new DbError(`collegamento non riuscito: ${err.message}`, 'connect'));
    });
  });
}

/** Esegue una richiesta e raccoglie al massimo maxRows + 1 righe, poi la annulla. */
function exec(conn: Connection, sql: string, maxRows: number, params: Array<[string, string]> = []): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    const rows: string[][] = [];
    let columns: string[] = [];
    let truncated = false;
    const req = new Request(sql, (err) => {
      if (err && !truncated) {
        reject(new DbError(err.message, /timeout/i.test(err.message) ? 'timeout' : 'query'));
        return;
      }
      resolve({ columns, rows, truncated });
    });
    for (const [n, v] of params) req.addParameter(n, TYPES.NVarChar, v);
    req.on('columnMetadata', (cols: ColumnMetaData[] | Record<string, ColumnMetaData>) => {
      columns = (Array.isArray(cols) ? cols : Object.values(cols)).map((x) => x.colName);
    });
    req.on('row', (cols: Array<{ value: unknown }>) => {
      if (truncated) return;
      if (rows.length >= maxRows) {
        truncated = true;
        conn.cancel();
        return;
      }
      rows.push(cols.map((x) => cellText(x.value)));
    });
    conn.execSql(req);
  });
}

async function withConn<T>(run: DbRun, fn: (c: Connection) => Promise<T>): Promise<T> {
  const conn = await connect(run);
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}

export const sqlserverDriver: DbDriver = {
  tables(run: DbRun): Promise<TableRef[]> {
    return withConn(run, async (c) => {
      const r = await exec(c, 'SELECT TOP 2000 TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY 1, 2', 2000);
      return r.rows.map(([s, n, t]) => ({ schema: s!, name: n!, type: t === 'VIEW' ? 'view' : 'table' }));
    });
  },
  describe(run: DbRun, table: string): Promise<TableInfo> {
    const { schema, name } = splitTable(table, 'dbo');
    const p: Array<[string, string]> = [
      ['s', schema!],
      ['t', name],
    ];
    return withConn(run, async (c) => {
      const cols = await exec(c, 'SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @s AND TABLE_NAME = @t ORDER BY ORDINAL_POSITION', 5000, p);
      if (!cols.rows.length) throw new DbError(`tabella sconosciuta: ${schema}.${name}`, 'query');
      const keys = await exec(
        c,
        `SELECT tc.CONSTRAINT_TYPE, kcu.COLUMN_NAME, ccu.TABLE_SCHEMA + '.' + ccu.TABLE_NAME, ccu.COLUMN_NAME
           FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
           JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
           LEFT JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND rc.CONSTRAINT_SCHEMA = tc.TABLE_SCHEMA
           LEFT JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu ON ccu.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME
          WHERE tc.TABLE_SCHEMA = @s AND tc.TABLE_NAME = @t AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'FOREIGN KEY')`,
        5000,
        p,
      );
      const pk = new Set(keys.rows.filter((k) => k[0] === 'PRIMARY KEY').map((k) => k[1]));
      const idx = await exec(
        c,
        `SELECT i.name, i.is_unique, STRING_AGG(col.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal)
           FROM sys.indexes i
           JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
           JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
          WHERE i.object_id = OBJECT_ID(QUOTENAME(@s) + '.' + QUOTENAME(@t)) AND i.name IS NOT NULL
          GROUP BY i.name, i.is_unique ORDER BY i.name`,
        500,
        p,
      );
      return {
        table: `${schema}.${name}`,
        columns: cols.rows.map(([n, t, nul, d]) => ({ name: n!, type: t!, nullable: nul === 'YES', ...(d && d !== 'NULL' ? { default: d } : {}), ...(pk.has(n) ? { primaryKey: true } : {}) })),
        foreignKeys: keys.rows.filter((k) => k[0] === 'FOREIGN KEY').map((k) => `${k[1]} -> ${k[2]}(${k[3]})`),
        indexes: idx.rows.map(([n, u, cs]) => `${n}${u === 'true' ? ' (unico)' : ''}: ${cs}`),
      };
    });
  },
  query(run: DbRun, sql: string, maxRows: number): Promise<QueryResult> {
    return withConn(run, (c) => exec(c, sql, maxRows));
  },
};
