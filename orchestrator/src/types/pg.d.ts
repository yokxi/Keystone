// Tipi minimi di pg e pg-cursor, solo per quello che usa core/db/postgres.ts (si evitano due
// pacchetti @types in più).
declare module 'pg' {
  export interface ClientConfig {
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    ssl?: boolean | { rejectUnauthorized?: boolean };
    connectionTimeoutMillis?: number;
    statement_timeout?: number;
    query_timeout?: number;
    application_name?: string;
    options?: string;
  }
  export interface QueryResult<R> {
    rows: R[];
  }
  export class Client {
    constructor(config: ClientConfig);
    connect(): Promise<void>;
    query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    query<T>(submittable: T): T;
    end(): Promise<void>;
    on(event: 'error', fn: (e: Error) => void): this;
    /** interno di pg: il socket, per chiuderlo senza aspettare il server */
    connection?: { stream?: { destroy(): void } };
  }
  const pg: { Client: typeof Client };
  export default pg;
}

declare module 'pg-cursor' {
  export default class Cursor {
    constructor(text: string, values?: unknown[], config?: { rowMode?: 'array' });
    read(rows: number): Promise<unknown[]>;
    close(): Promise<void>;
  }
}
