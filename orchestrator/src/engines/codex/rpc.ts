// JSON-RPC 2.0 di `codex app-server` su stdio: un oggetto JSON per riga, senza il campo "jsonrpc".
// Il client manda richieste e notifiche; il server manda risposte, notifiche e richieste proprie
// (approvazioni, chiamate ai tool del team), a cui il client risponde.
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export type RpcId = number | string;
export interface RpcMessage {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`${method}: ${message} (${code})`);
  }
}

export interface RpcHandlers {
  /** una notifica del server */
  onNotification(method: string, params: unknown): void;
  /** una richiesta del server: il risultato (o un errore lanciato) diventa la risposta */
  onRequest(method: string, params: unknown): Promise<unknown>;
  /** ogni messaggio in arrivo, così com'è (per le trascrizioni) */
  onMessage?(msg: RpcMessage, direction: 'in' | 'out'): void;
}

export class RpcClient {
  private next = 1;
  private pending = new Map<RpcId, { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;

  constructor(
    private input: Readable,
    private output: Writable,
    private handlers: RpcHandlers,
  ) {
    const rl = readline.createInterface({ input });
    rl.on('line', (line) => this.receive(line));
    rl.on('close', () => this.close(new Error('il processo di Codex ha chiuso la connessione')));
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`${method}: connessione chiusa`));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: nessuna risposta in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, ...(params !== undefined ? { params } : {}) });
  }

  close(reason = new Error('connessione chiusa')): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(reason);
    }
  }

  private send(msg: RpcMessage): void {
    if (this.closed) return;
    this.handlers.onMessage?.(msg, 'out');
    this.output.write(`${JSON.stringify(msg)}\n`);
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      return; // righe non JSON (avvisi): ignorate
    }
    this.handlers.onMessage?.(msg, 'in');
    if (msg.method && msg.id !== undefined) {
      const id = msg.id;
      this.handlers
        .onRequest(msg.method, msg.params)
        .then((result) => this.send({ id, result }))
        .catch((e: Error) => this.send({ id, error: { code: -32000, message: e.message || 'rifiutato' } }));
      return;
    }
    if (msg.method) {
      this.handlers.onNotification(msg.method, msg.params);
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(p.method, msg.error.code, msg.error.message));
      else p.resolve(msg.result);
    }
  }
}
