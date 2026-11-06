// Controllo del testo di una query: SOLO UN AIUTO, non una garanzia.
//
// La garanzia della sola lettura è l'utente del database con soli permessi di lettura (confermato
// da te nella configurazione), più, dove il database lo permette, la transazione in sola lettura
// (PostgreSQL) o l'apertura in sola lettura con un authorizer che ammette solo letture (SQLite).
// Questo controllo serve a fermare presto gli errori evidenti e a dare all'agente un messaggio
// chiaro; un testo scritto apposta può superarlo, e la documentazione non lo presenta come sicuro.
import type { DbKind } from '@keystone/shared';

/** Parole che indicano una scrittura o un cambio di stato (fuori da stringhe e commenti). */
const WRITE_WORDS = [
  'insert', 'update', 'delete', 'merge', 'upsert', 'truncate', 'drop', 'alter', 'create', 'rename',
  'grant', 'revoke', 'deny', 'exec', 'execute', 'call', 'copy', 'attach', 'detach', 'vacuum', 'reindex',
  'analyze', 'cluster', 'lock', 'set', 'reset', 'into', 'commit', 'rollback', 'begin', 'savepoint', 'release',
  'prepare', 'deallocate', 'listen', 'notify', 'backup', 'restore', 'shutdown', 'kill',
  'dbcc', 'bulk', 'openrowset', 'opendatasource', 'openquery', 'xp_cmdshell', 'sp_executesql', 'waitfor',
  // funzioni che cambiano impostazioni della sessione, leggono file del server o toccano altre sessioni
  'set_config', 'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file', 'lo_import', 'lo_export',
  'dblink', 'dblink_exec', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile',
];
const FIRST_WORDS = ['select', 'with', 'values', 'table', 'explain', 'show', 'pragma', 'describe'];

/** Toglie commenti e contenuto delle stringhe, così le parole dentro i dati non contano. */
export function stripSqlNoise(sql: string): string {
  let out = '';
  for (let i = 0; i < sql.length; ) {
    const c = sql[i]!;
    const n = sql[i + 1];
    if (c === '-' && n === '-') {
      const e = sql.indexOf('\n', i);
      i = e < 0 ? sql.length : e;
      out += ' ';
    } else if (c === '/' && n === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e < 0 ? sql.length : e + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      // stringhe e identificatori tra virgolette: il contenuto non conta ('' raddoppiato = virgoletta)
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] === close) {
          if (sql[j + 1] === close) j++;
          else break;
        }
      }
      out += c === "'" ? "''" : ' x ';
      i = j + 1;
    } else if (c === '$') {
      // PostgreSQL: $$...$$ o $tag$...$tag$
      const m = /^\$([A-Za-z_]*)\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const e = sql.indexOf(tag, i + tag.length);
        i = e < 0 ? sql.length : e + tag.length;
        out += "''";
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** undefined = sembra una lettura; altrimenti il motivo per cui la query viene rifiutata. */
export function checkReadOnlySql(sql: string, kind: DbKind): string | undefined {
  const text = stripSqlNoise(sql).trim().replace(/;\s*$/, '');
  if (!text) return 'query vuota';
  if (text.length > 20_000) return 'query troppo lunga (massimo 20 000 caratteri)';
  if (text.includes(';')) return 'una sola istruzione per volta (niente ";" in mezzo)';
  const words = text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
  const first = words[0] ?? '';
  if (!FIRST_WORDS.includes(first)) return `sono ammesse solo letture (SELECT, WITH, EXPLAIN…): "${first.toUpperCase()}" non lo è`;
  if (first === 'pragma' && kind !== 'sqlite') return 'PRAGMA vale solo per SQLite';
  const bad = words.find((w) => WRITE_WORDS.includes(w) || /^(xp|sp)_/.test(w));
  if (bad) return `la query contiene "${bad.toUpperCase()}", che indica una scrittura o un cambio di stato: sono ammesse solo letture`;
  return undefined;
}
