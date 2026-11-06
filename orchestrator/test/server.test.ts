import { ServerMessage, type ClientPayload } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import net from 'node:net';
import WebSocket from 'ws';
import { silentLogger } from '../src/core/context.js';
import { OrchestratorServer, refuseReason } from '../src/server.js';
import { demoRepo, onCleanup, testOrchestrator, waitFor } from './helpers.js';

async function setup() {
  const { o, cfg } = testOrchestrator({ workers: 1 });
  await o.repos.add(await demoRepo(cfg.home), { confirmGuard: true });
  await o.start();
  const server = new OrchestratorServer(o, { port: 0, log: silentLogger, validateOutbound: true });
  const port = await server.listen();
  onCleanup(() => server.close());
  return { o, port };
}

interface TestClient {
  ws: WebSocket;
  received: Array<Record<string, unknown>>;
  send(m: ClientPayload): void;
  next(pred: (m: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>>;
}

async function connect(port: number, headers: Record<string, string> = {}): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  const received: Array<Record<string, unknown>> = [];
  ws.on('message', (d) => received.push(JSON.parse(String(d)) as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    // `on`, non `once`: dopo un rifiuto il server chiude la connessione e su Windows può arrivare
    // anche un ECONNRESET, un secondo errore che senza ascoltatore resterebbe non gestito
    ws.on('error', reject);
    ws.once('unexpected-response', (req, res) => {
      reject(new Error(`HTTP ${res.statusCode}`));
      res.resume();
      req.destroy();
    });
  });
  onCleanup(() => ws.close());
  return {
    ws,
    received,
    send: (m) => ws.send(JSON.stringify({ v: 1, ...m })),
    next: (pred, what) => waitFor(() => received.find(pred), what),
  };
}

describe('server WebSocket', () => {
  it('rifiuta i browser (qualunque Origin, anche "null") e gli Host non locali', async () => {
    const { port } = await setup();
    await expect(connect(port, { Origin: 'https://evil.example' })).rejects.toThrow(/401/);
    await expect(connect(port, { Origin: 'null' })).rejects.toThrow(/401/);
    await expect(connect(port, { Host: 'evil.example:80' })).rejects.toThrow(/401/);
    expect(refuseReason({ headers: { host: 'localhost:7931' } })).toBeUndefined();
    expect(refuseReason({ headers: { host: '[::1]:7931' } })).toBeUndefined();
    expect(refuseReason({ headers: { host: '127.0.0.1.evil.com' } })).toMatch(/Host/);
  });

  it('un client rifiutato che resetta la connessione non fa cadere il server', async () => {
    const { port } = await setup();
    for (let i = 0; i < 20; i++) {
      const sock = net.connect(port, '127.0.0.1');
      sock.on('error', () => undefined);
      await new Promise<void>((r) => sock.once('connect', () => r()));
      const lines = ['GET / HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Origin: https://evil.example', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', ''];
      sock.write(lines.join(String.fromCharCode(13, 10)));
      sock.resetAndDestroy();
    }
    await new Promise((r) => setTimeout(r, 300));
    const c = await connect(port);
    c.send({ type: 'hello', client: 'test', protocol: 1 });
    await c.next((m) => m.type === 'snapshot', 'snapshot dopo i reset');
  });

  it('ascolta solo su 127.0.0.1', async () => {
    const { port } = await setup();
    // un client che si presenta come localhost viene accettato
    const c = await connect(port);
    c.send({ type: 'hello', client: 'test', protocol: 1 });
    await c.next((m) => m.type === 'snapshot', 'snapshot');
  });

  it('hello -> snapshot; prima di hello niente; JSON non valido -> errore', async () => {
    const { port } = await setup();
    const c = await connect(port);
    c.send({ type: 'goal.submit', text: 'troppo presto', id: 'x1' });
    await c.next((m) => m.type === 'error' && m.re === 'x1', 'errore prima di hello');
    c.ws.send('{non json');
    await c.next((m) => m.type === 'error' && m.message === 'JSON non valido', 'errore JSON');
    c.send({ type: 'hello', client: 'test', protocol: 1, id: 'h' });
    const snap = await c.next((m) => m.type === 'snapshot', 'snapshot');
    expect((snap.agents as unknown[]).length).toBe(2);
    expect(ServerMessage.safeParse(snap).success).toBe(true);
    await c.next((m) => m.type === 'ack' && m.re === 'h' && m.ok === true, 'ack di hello');
  });

  it('messaggi non validi ricevono un ack negativo con il motivo', async () => {
    const { port } = await setup();
    const c = await connect(port);
    c.send({ type: 'hello', client: 'test', protocol: 1 });
    await c.next((m) => m.type === 'snapshot', 'snapshot');
    c.ws.send(JSON.stringify({ v: 1, type: 'goal.submit', text: '', id: 'g0' }));
    const ack = await c.next((m) => m.type === 'ack' && m.re === 'g0', 'ack');
    expect(ack.ok).toBe(false);
    c.send({ type: 'user.message', to: 'nessuno', text: 'ciao', id: 'u1' });
    expect(await c.next((m) => m.type === 'ack' && m.re === 'u1', 'ack')).toMatchObject({ ok: false, error: 'nessun agente "nessuno"' });
  });

  it('un obiettivo via WebSocket arriva fino alla decisione di merge, con ogni messaggio valido per lo schema', async () => {
    const { port } = await setup();
    const c = await connect(port);
    c.send({ type: 'hello', client: 'test', protocol: 1 });
    await c.next((m) => m.type === 'snapshot', 'snapshot');
    c.send({ type: 'goal.submit', text: 'Aggiungi un saluto', id: 'g1' });
    expect(await c.next((m) => m.type === 'ack' && m.re === 'g1', 'ack')).toMatchObject({ ok: true, result: { goalId: 'g1' } });
    const d = await c.next((m) => m.type === 'decision.upsert' && (m.decision as { kind: string }).kind === 'merge', 'decisione di merge');
    for (const m of c.received) expect(ServerMessage.safeParse(m).success, JSON.stringify(m).slice(0, 200)).toBe(true);
    const types = new Set(c.received.map((m) => m.type));
    for (const t of ['goal.upsert', 'task.upsert', 'agent.upsert', 'agent.log', 'repo.upsert', 'memory.upsert', 'feed.add', 'notify', 'status']) expect(types, t).toContain(t);
    // diff del worktree su richiesta
    const decision = d.decision as { repoId: string; worktree: string };
    c.send({ type: 'diff.request', requestId: 'r1', repoId: decision.repoId, worktree: decision.worktree });
    const diff = await c.next((m) => m.type === 'diff' && m.requestId === 'r1', 'diff');
    expect((diff.files as Array<{ path: string }>).map((f) => f.path)).toEqual(['keystone-sim/t1.md']);
  });

  it('più client ricevono gli stessi aggiornamenti', async () => {
    const { port, o } = await setup();
    const a = await connect(port);
    const b = await connect(port);
    for (const c of [a, b]) c.send({ type: 'hello', client: 'test', protocol: 1 });
    await a.next((m) => m.type === 'snapshot', 'snapshot a');
    await b.next((m) => m.type === 'snapshot', 'snapshot b');
    o.notify('info', 'ciao a tutti');
    await a.next((m) => m.type === 'notify' && m.text === 'ciao a tutti', 'notify a');
    await b.next((m) => m.type === 'notify' && m.text === 'ciao a tutti', 'notify b');
  });
});
