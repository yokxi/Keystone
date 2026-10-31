// Mattoni comuni per gli adattatori: una coda di eventi consumabile con `for await`, e il
// registro delle richieste di permesso in attesa di risposta.
import type { EngineEvent, PermissionAnswer } from '@keystone/shared';

/** Coda push -> AsyncIterable. Un solo consumatore. */
export class EventChannel<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | undefined;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w({ value, done: false });
    } else this.buffer.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w({ value: undefined, done: true });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const v = this.buffer.shift();
        if (v !== undefined) return Promise.resolve({ value: v, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

/**
 * Richieste di permesso in attesa. L'adattatore chiama `ask()` (che emette l'evento e aspetta),
 * l'orchestratore risponde con `respond()`. Se il turno viene interrotto, tutte le richieste
 * aperte vengono negate.
 */
export class PermissionBroker {
  private open = new Map<string, (a: PermissionAnswer) => void>();
  private seq = 0;
  private abortedReason: string | undefined;

  constructor(private emit: (e: EngineEvent) => void) {}

  ask(tool: string, input: Record<string, unknown>, reason?: string): Promise<PermissionAnswer> {
    if (this.abortedReason !== undefined) return Promise.resolve({ allow: false, message: `turno interrotto: ${this.abortedReason}` });
    const requestId = `p${++this.seq}`;
    return new Promise((resolve) => {
      this.open.set(requestId, resolve);
      this.emit({ type: 'permission_request', requestId, tool, input, ...(reason ? { reason } : {}) });
    });
  }

  respond(requestId: string, answer: PermissionAnswer): void {
    const r = this.open.get(requestId);
    if (!r) return;
    this.open.delete(requestId);
    r(answer);
  }

  abort(reason: string): void {
    this.abortedReason = reason;
    for (const [id, r] of this.open) {
      this.open.delete(id);
      r({ allow: false, message: `turno interrotto: ${reason}` });
    }
  }

  get pending(): number {
    return this.open.size;
  }
}
