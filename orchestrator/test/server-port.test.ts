import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, defaultConfig } from '../src/config.js';
import { silentLogger } from '../src/core/context.js';
import { OrchestratorServer, PortInUseError } from '../src/server.js';
import { onCleanup, testOrchestrator, tmpDir } from './helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

async function occupyPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  onCleanup(() => new Promise<void>((r) => srv.close(() => r())));
  return (srv.address() as net.AddressInfo).port;
}

describe('porta del server', () => {
  it('7931 di default, configurabile con KEYSTONE_PORT', () => {
    expect(DEFAULT_PORT).toBe(7931);
    expect(defaultConfig({}).port).toBe(7931);
    expect(defaultConfig({ KEYSTONE_PORT: '8123' }).port).toBe(8123);
  });

  it('se la porta è occupata, errore chiaro con il rimedio', async () => {
    const port = await occupyPort();
    const { o } = testOrchestrator();
    const server = new OrchestratorServer(o, { port, log: silentLogger });
    const err = await server.listen().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortInUseError);
    expect((err as Error).message).toMatch(new RegExp(`porta ${port} è già in uso.*--port.*KEYSTONE_PORT`));
  });

  it('dalla riga di comando: messaggio chiaro e uscita con errore, senza traccia dello stack', async () => {
    const port = await occupyPort();
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'orchestrator/src/main.ts', '--home', tmpDir(), '--port', String(port)], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(new RegExp(`Keystone: la porta ${port} è già in uso`));
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it('una porta non valida viene rifiutata', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'orchestrator/src/main.ts', '--home', tmpDir(), '--port', 'abc'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/porta non valida: abc/);
  });
});
