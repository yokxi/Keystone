// Tipi comuni ai driver di database (SQLite, PostgreSQL, SQL Server).
import type { DbConnection } from '@keystone/shared';

export interface TableRef {
  /** schema (assente con SQLite) */
  schema?: string;
  name: string;
  /** tabella o vista */
  type: 'table' | 'view';
}

export interface TableInfo {
  table: string;
  columns: Array<{ name: string; type: string; nullable: boolean; default?: string; primaryKey?: boolean }>;
  /** chiavi esterne: colonne -> tabella(colonne) */
  foreignKeys: string[];
  /** indici, come testo */
  indexes: string[];
}

/** Righe come testo, già pronte da mostrare (valori nulli = NULL, binari = <binario N byte>). */
export interface QueryResult {
  columns: string[];
  rows: string[][];
  /** ci sono altre righe oltre il limite della connessione */
  truncated: boolean;
}

export interface DbRun {
  conn: DbConnection;
  /** cartella del repository (per i file SQLite relativi) */
  repoPath: string;
  /** la password, solo per i server (dalla memoria dell'orchestratore) */
  password?: string;
  timeoutMs: number;
}

export interface DbDriver {
  tables(run: DbRun): Promise<TableRef[]>;
  describe(run: DbRun, table: string): Promise<TableInfo>;
  query(run: DbRun, sql: string, maxRows: number): Promise<QueryResult>;
}

export class DbError extends Error {
  constructor(
    message: string,
    readonly code: 'config' | 'secret' | 'connect' | 'timeout' | 'refused' | 'query' = 'query',
  ) {
    super(message);
    this.name = 'DbError';
  }
}

/** Le celle oltre questa lunghezza si accorciano subito (prima della formattazione). */
export const CELL_MAX_CHARS = 2000;

/** Un valore di una cella come testo, già accorciato. */
export function cellText(v: unknown): string {
  const s = cellRaw(v);
  return s.length > CELL_MAX_CHARS ? `${s.slice(0, CELL_MAX_CHARS)}…` : s;
}

function cellRaw(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return `<binario ${v.byteLength} byte>`;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** "schema.tabella" o "tabella"; con le virgolette tolte. */
export function splitTable(table: string, defaultSchema?: string): { schema?: string; name: string } {
  const clean = (s: string) => s.trim().replace(/^["[`]|["\]`]$/g, '');
  const i = table.lastIndexOf('.');
  if (i < 0) return { ...(defaultSchema ? { schema: defaultSchema } : {}), name: clean(table) };
  return { schema: clean(table.slice(0, i)), name: clean(table.slice(i + 1)) };
}
