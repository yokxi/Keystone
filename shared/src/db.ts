// Accesso al database in sola lettura (Fase 6c): la configurazione di una connessione.
//
// Le connessioni si configurano per repository. La password non sta mai qui: l'app la cifra con
// safeStorage e la passa all'orchestratore, che la tiene solo in memoria (messaggio db.secret).
import { z } from 'zod';

export const DB_KINDS = ['sqlite', 'postgres', 'sqlserver'] as const;
export type DbKind = (typeof DB_KINDS)[number];

export const DB_KIND_LABEL: Record<DbKind, string> = { sqlite: 'SQLite', postgres: 'PostgreSQL', sqlserver: 'SQL Server' };

/** Motori di database non ancora provati con un server reale. */
export const DB_EXPERIMENTAL: Partial<Record<DbKind, string>> = {
  postgres: 'sperimentale · non ancora verificato con un server reale',
  sqlserver: 'sperimentale · non ancora verificato con un server reale',
};

export const DB_LIMITS = { maxRows: 5000, defaultMaxRows: 200, maxTimeoutSec: 300, defaultTimeoutSec: 15, perRepo: 10 } as const;

export const DB_CONNECTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const oneLine = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n\t\0]+$/, 'una riga sola');

export const DbConnection = z
  .object({
    /** usato dagli agenti per indicare la connessione (minuscole, cifre, trattini) */
    id: z.string().regex(DB_CONNECTION_ID_RE, 'id: minuscole, cifre e trattini'),
    name: oneLine(80),
    kind: z.enum(DB_KINDS),
    /** SQLite: il file, assoluto o relativo alla cartella del repository */
    file: oneLine(1000).optional(),
    /** PostgreSQL e SQL Server */
    host: oneLine(255).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    database: oneLine(128).optional(),
    user: oneLine(128).optional(),
    /** connessione cifrata (TLS): sì di default */
    tls: z.boolean().optional(),
    /** accetta un certificato del server non verificato (solo per server di sviluppo) */
    trustServerCertificate: z.boolean().optional(),
    maxRows: z.number().int().min(1).max(DB_LIMITS.maxRows),
    timeoutSec: z.number().int().min(1).max(DB_LIMITS.maxTimeoutSec),
    /** ogni query degli agenti chiede la tua approvazione */
    approveEachQuery: z.boolean(),
    /**
     * Hai confermato che l'utente del database ha solo permessi di lettura: è la garanzia vera.
     * Obbligatorio per PostgreSQL e SQL Server.
     */
    readOnlyUserConfirmed: z.boolean(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const need = (k: keyof typeof c, why: string) => {
      if (c[k] === undefined) ctx.addIssue({ code: 'custom', path: [k], message: why });
    };
    if (c.kind === 'sqlite') {
      need('file', 'serve il file del database');
      for (const k of ['host', 'port', 'database', 'user'] as const) if (c[k] !== undefined) ctx.addIssue({ code: 'custom', path: [k], message: 'non vale per SQLite' });
    } else {
      need('host', 'serve il server');
      need('database', 'serve il nome del database');
      need('user', "serve l'utente");
      if (c.file !== undefined) ctx.addIssue({ code: 'custom', path: ['file'], message: 'vale solo per SQLite' });
      if (!c.readOnlyUserConfirmed) ctx.addIssue({ code: 'custom', path: ['readOnlyUserConfirmed'], message: "conferma che l'utente del database ha solo permessi di lettura" });
    }
  });
export type DbConnection = z.infer<typeof DbConnection>;

/**
 * La destinazione di una connessione: dove va la password. Se cambia (altro server, utente,
 * database, cifratura…), una password data per la destinazione precedente non vale più.
 */
export function dbDestination(c: Pick<DbConnection, 'kind' | 'file' | 'host' | 'port' | 'database' | 'user' | 'tls' | 'trustServerCertificate'>): string {
  return JSON.stringify([c.kind, c.file ?? '', (c.host ?? '').toLowerCase(), c.port ?? defaultPort(c.kind) ?? 0, c.database ?? '', c.user ?? '', c.tls !== false, c.trustServerCertificate === true]);
}

export function defaultPort(kind: DbKind): number | undefined {
  return kind === 'postgres' ? 5432 : kind === 'sqlserver' ? 1433 : undefined;
}
