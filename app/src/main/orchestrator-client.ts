// Client dell'orchestratore per il processo MAIN di Electron (Node, non il renderer).
//
// Il renderer non apre mai il WebSocket: parla con il main solo via IPC (preload + contextBridge,
// contextIsolation attivo, nodeIntegration disattivato; Fase 4). Il main usa questo client, che:
//  - si connette a ws://127.0.0.1:<porta> senza header Origin (l'orchestratore rifiuta i browser)
//  - manda hello, applica snapshot e aggiornamenti a una ViewState
//  - si riconnette da solo con backoff (l'orchestratore può riavviarsi: arriva un nuovo snapshot)
//  - restituisce l'ack di ogni comando come Promise
import { applyServerMessage, emptyViewState, parseServerMessage, PROTOCOL_VERSION, type ClientPayload as Payload, type ServerMessage, type ViewState } from '@keystone/shared';
import WebSocket from 'ws';

type ClientPayload = Payload extends infer M ? (M extends { id?: string } ? Omit<M, 'id'> : never) : never;

export interface Ack {
  ok: boolean;
  error?: string;
  result?: Record<string, unknown>;
}

export interface OrchestratorClientOptions {
  url: string;
  clientName?: string;
  /** attesa iniziale tra i tentativi di riconnessione (raddoppia fino a maxDelayMs) */
  retryDelayMs?: number;
  maxDelayMs?: number;
  ackTimeoutMs?: number;
}

export class OrchestratorClient {
  state: ViewState = emptyViewState();
  private ws: WebSocket | undefined;
  private seq = 0;
  private pending = new Map<string, { resolve: (a: Ack) => void; timer: NodeJS.Timeout }>();
  private stateListeners = new Set<(s: ViewState) => void>();
  private messageListeners = new Set<(m: ServerMessage) => void>();
  private closed = false;
  private delay: number;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(private opts: OrchestratorClientOptions) {
    this.delay = opts.retryDelayMs ?? 500;
  }

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.on('open', () => {
      this.delay = this.opts.retryDelayMs ?? 500;
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', client: this.opts.clientName ?? 'keystone-app', protocol: PROTOCOL_VERSION }));
    });
    ws.on('message', (data) => this.onMessage(String(data)));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => undefined); // segue sempre "close"
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.failPending('client chiuso');
  }

  onState(l: (s: ViewState) => void): () => void {
    this.stateListeners.add(l);
    return () => this.stateListeners.delete(l);
  }

  /** Tutti i messaggi del server, anche quelli che non sono stato (notify, diff, agent.say). */
  onMessage$(l: (m: ServerMessage) => void): () => void {
    this.messageListeners.add(l);
    return () => this.messageListeners.delete(l);
  }

  /** Manda un comando e restituisce il suo ack. */
  request(msg: ClientPayload): Promise<Ack> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.state.connected) return Promise.resolve({ ok: false, error: 'orchestratore non connesso' });
    const id = `c${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'nessuna risposta dall\'orchestratore' });
      }, this.opts.ackTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, timer });
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id, ...msg }));
    });
  }

  private onMessage(raw: string): void {
    const parsed = parseServerMessage(raw);
    if (!parsed.ok) return; // un messaggio malformato non deve rompere la vista
    const m = parsed.msg;
    if (m.type === 'ack') {
      const p = this.pending.get(m.re);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(m.re);
        p.resolve({ ok: m.ok, ...(m.error ? { error: m.error } : {}), ...(m.result ? { result: m.result } : {}) });
      }
    }
    const next = applyServerMessage(this.state, m);
    if (next !== this.state) {
      this.state = next;
      for (const l of this.stateListeners) l(this.state);
    }
    for (const l of this.messageListeners) l(m);
  }

  private onClose(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = undefined;
    this.failPending('connessione persa');
    if (this.state.connected) {
      this.state = { ...this.state, connected: false };
      for (const l of this.stateListeners) l(this.state);
    }
    if (this.closed) return;
    this.retryTimer = setTimeout(() => this.connect(), this.delay);
    this.delay = Math.min(this.delay * 2, this.opts.maxDelayMs ?? 10_000);
  }

  private failPending(error: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error });
      this.pending.delete(id);
    }
  }
}
