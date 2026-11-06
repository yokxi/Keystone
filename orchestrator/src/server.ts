// Server WebSocket: ws://127.0.0.1:<porta>, solo localhost.
//
// Un client manda `hello` e riceve lo `snapshot`, poi ogni aggiornamento. Ogni messaggio con `id`
// riceve un `ack`. Sono rifiutati con HTTP 401: qualunque richiesta con header Origin (ogni
// browser lo manda, anche come "null"), così una pagina web non può pilotare gli agenti, e
// qualunque Host che non sia loopback (DNS rebinding). L'app Electron si connette dal processo
// main (Node), che non manda Origin.
import http, { type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { parseClientMessage, PROTOCOL_VERSION, ServerMessage, type Outbound } from '@keystone/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from './core/context.js';
import { ClientError, type Orchestrator } from './core/orchestrator.js';

export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(`la porta ${port} è già in uso (forse è già attivo un altro orchestratore Keystone o un altro programma): chiudilo, oppure scegli un'altra porta con --port <n> o la variabile KEYSTONE_PORT`);
    this.name = 'PortInUseError';
  }
}

const LOOPBACK_HOST =/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** Motivo per rifiutare la connessione, oppure undefined per accettarla. */
export function refuseReason(req: Pick<IncomingMessage, 'headers'>): string | undefined {
  const origin = req.headers.origin;
  if (origin !== undefined) return `origine browser non ammessa (${origin || 'vuota'})`;
  const host = req.headers.host ?? '';
  if (!LOOPBACK_HOST.test(host)) return `Host non locale (${host || 'assente'})`;
  return undefined;
}

export interface ServerOptions {
  port: number;
  log: Logger;
  /** valida anche i messaggi in uscita (test/sviluppo) */
  validateOutbound?: boolean;
}

interface Client {
  ws: WebSocket;
  id: number;
  ready: boolean;
}

export class OrchestratorServer {
  private http = http.createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Keystone: serve una connessione WebSocket\n');
  });
  private wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  private clients = new Set<Client>();
  private seq = 0;
  private unsubscribe: (() => void) | undefined;
  port = 0;

  constructor(
    private o: Orchestrator,
    private opts: ServerOptions,
  ) {
    this.http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const why = refuseReason(req);
      if (why) {
        this.opts.log.warn(`connessione rifiutata: ${why}`);
        // dopo l'upgrade il server http non gestisce più gli errori del socket: un client che
        // resetta la connessione (ECONNRESET) non deve far cadere l'orchestratore
        socket.on('error', () => socket.destroy());
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE') {
          reject(new PortInUseError(this.opts.port));
        } else if (e.code === 'EACCES') {
          reject(new Error(`la porta ${this.opts.port} non è utilizzabile (permesso negato): scegline un'altra con --port <n> o KEYSTONE_PORT`));
        } else reject(e);
      };
      this.http.once('error', onError);
      this.http.listen(this.opts.port, '127.0.0.1', () => {
        this.http.off('error', onError);
        resolve();
      });
    });
    const addr = this.http.address();
    this.port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
    this.unsubscribe = this.o.onOutbound((m) => this.broadcast(m));
    return this.port;
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private accept(ws: WebSocket): void {
    const client: Client = { ws, id: ++this.seq, ready: false };
    this.clients.add(client);
    ws.on('message', (data) => void this.onMessage(client, String(data)));
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', (e) => this.opts.log.debug(`client ${client.id}: ${e.message}`));
  }

  private send(client: Client, m: Outbound): void {
    const full = { v: PROTOCOL_VERSION, ...m };
    if (this.opts.validateOutbound) {
      const r = ServerMessage.safeParse(full);
      if (!r.success) {
        this.opts.log.error(`messaggio in uscita non valido (${m.type}): ${r.error.message}`);
        throw new Error(`messaggio in uscita non valido (${m.type})`);
      }
    }
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(full));
  }

  private broadcast(m: Outbound): void {
    for (const c of this.clients) if (c.ready) this.send(c, m);
  }

  private async onMessage(client: Client, raw: string): Promise<void> {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.send(client, { type: 'error', message: parsed.error, ...(parsed.id ? { re: parsed.id } : {}) });
      if (parsed.id) this.send(client, { type: 'ack', re: parsed.id, ok: false, error: parsed.error });
      return;
    }
    const msg = parsed.msg;
    if (msg.type !== 'hello' && !client.ready) {
      this.send(client, { type: 'error', message: 'manda prima "hello"', ...(msg.id ? { re: msg.id } : {}) });
      return;
    }
    try {
      const result = await this.o.handle(msg, (m) => {
        this.send(client, m);
        // da qui in poi il client riceve gli aggiornamenti: nessuno va perso tra snapshot e iscrizione
        if (m.type === 'snapshot') client.ready = true;
      });
      if (msg.id) this.send(client, { type: 'ack', re: msg.id, ok: true, ...(result ? { result } : {}) });
    } catch (e) {
      const known = e instanceof ClientError;
      const text = known ? (e as Error).message : 'errore interno dell\'orchestratore';
      if (!known) this.opts.log.error(`${msg.type}: ${(e as Error).stack ?? e}`);
      if (msg.id) this.send(client, { type: 'ack', re: msg.id, ok: false, error: text });
      else this.send(client, { type: 'error', message: text });
    }
  }
}
