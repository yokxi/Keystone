import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EngineId, Outbound } from '@keystone/shared';
import { afterEach } from 'vitest';
import { buildOrchestrator } from '../src/bootstrap.js';
import { defaultAgents, defaultConfig, type OrchestratorConfig } from '../src/config.js';
import { silentLogger, type Ctx } from '../src/core/context.js';
import type { Orchestrator } from '../src/core/orchestrator.js';
import { Store } from '../src/core/store.js';
import { createDemoRepo } from '../src/demo.js';
import { SimEngine } from '../src/engines/sim/sim-engine.js';
import type { SimScript } from '../src/engines/sim/script.js';
import type { EngineAdapter } from '../src/engines/types.js';

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.pop()!;
    try {
      await fn();
    } catch {
      /* best effort */
    }
  }
});

export function onCleanup(fn: () => Promise<void> | void): void {
  cleanup.push(fn);
}

export function tmpDir(prefix = 'keystone-test-'): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  onCleanup(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }));
  return d;
}

/** Contesto minimo per testare un sottosistema da solo. */
export function testCtx(dir = tmpDir()): Ctx & { events: Outbound[]; clock: { t: number } } {
  const clock = { t: 1_000 };
  const events: Outbound[] = [];
  const store = new Store(dir, { debounceMs: 5, now: () => clock.t });
  return { store, now: () => clock.t, emit: (m) => events.push(m), log: silentLogger, events, clock };
}

export async function demoRepo(dir = tmpDir()): Promise<string> {
  return createDemoRepo(path.join(dir, 'repo'));
}

export interface TestOrchestratorOptions {
  home?: string;
  workers?: number;
  leadReview?: boolean;
  script?: SimScript;
  engines?: Map<EngineId, EngineAdapter>;
  cfg?: Partial<OrchestratorConfig>;
  /** git user.name simulato (default: nessuno, così i test non dipendono dalla macchina) */
  gitUserName?: string;
}

export function testOrchestrator(opts: TestOrchestratorOptions = {}): { o: Orchestrator; cfg: OrchestratorConfig } {
  const cfg: OrchestratorConfig = {
    ...defaultConfig({}),
    home: opts.home ?? tmpDir(),
    profile: 'test',
    agents: defaultAgents('sim', opts.workers ?? 2),
    leadReview: opts.leadReview ?? true,
    userName: 'Aurora',
    ...opts.cfg,
  };
  const engines = opts.engines ?? new Map<EngineId, EngineAdapter>([['sim', new SimEngine({ stepDelayMs: 0, ...(opts.script ? { script: opts.script } : {}) })]]);
  const o = buildOrchestrator(cfg, { logger: silentLogger, engines, storeDebounceMs: 5, resolveGitUserName: () => opts.gitUserName });
  onCleanup(() => o.stop());
  return { o, cfg };
}

export async function waitFor<T>(fn: () => T | undefined | false | null, what: string, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout in attesa di: ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

export const noReply = (): void => undefined;
