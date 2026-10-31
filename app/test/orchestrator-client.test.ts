import { describe, expect, it } from 'vitest';
import { OrchestratorClient } from '../src/main/orchestrator-client.js';
import { silentLogger } from '../../orchestrator/src/core/context.js';
import { OrchestratorServer } from '../../orchestrator/src/server.js';
import { demoRepo, onCleanup, testOrchestrator, waitFor } from '../../orchestrator/test/helpers.js';

async function startServer(home?: string, port = 0) {
  const { o, cfg } = testOrchestrator({ workers: 1, ...(home ? { home } : {}) });
  if (!home) await o.repos.add(await demoRepo(cfg.home), { confirmGuard: true });
  await o.start();
  const server = new OrchestratorServer(o, { port, log: silentLogger });
  const p = await server.listen();
  onCleanup(() => server.close());
  return { o, server, port: p, home: cfg.home };
}

describe('OrchestratorClient (processo main di Electron)', () => {
  it('riceve lo snapshot, applica gli aggiornamenti e restituisce gli ack', async () => {
    const { port } = await startServer();
    const client = new OrchestratorClient({ url: `ws://127.0.0.1:${port}`, retryDelayMs: 50 });
    onCleanup(() => client.close());
    client.connect();
    await waitFor(() => client.state.connected, 'connessione');
    expect(client.state.agents.map((a) => a.id)).toEqual(['ada', 'bruno']);
    const ack = await client.request({ type: 'goal.submit', text: 'Aggiungi un saluto' });
    expect(ack).toEqual({ ok: true, result: { goalId: 'g1' } });
    await waitFor(() => client.state.decisions.find((d) => d.kind === 'merge'), 'decisione di merge nella vista');
    expect(client.state.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(client.state.logs.bruno?.length).toBeGreaterThan(0);
    const bad = await client.request({ type: 'user.message', to: 'nessuno', text: 'x' });
    expect(bad.ok).toBe(false);
  });

  it('senza orchestratore i comandi falliscono subito; si riconnette quando torna, con un nuovo snapshot', async () => {
    const first = await startServer();
    const client = new OrchestratorClient({ url: `ws://127.0.0.1:${first.port}`, retryDelayMs: 50, maxDelayMs: 200 });
    onCleanup(() => client.close());
    client.connect();
    await waitFor(() => client.state.connected, 'prima connessione');
    await first.server.close();
    await first.o.stop();
    await waitFor(() => !client.state.connected, 'disconnessione');
    expect(await client.request({ type: 'goal.submit', text: 'x' })).toEqual({ ok: false, error: 'orchestratore non connesso' });
    // l'orchestratore riparte sulla stessa porta e con lo stesso stato
    await startServer(first.home, first.port);
    await waitFor(() => client.state.connected, 'riconnessione', 20_000);
    expect(client.state.agents.length).toBe(2);
  });
});
