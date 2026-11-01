// La review del lead riceve l'esito dei test che Keystone ha eseguito (comando, esito, output
// finale) e deve citarlo: non si fida di quanto riporta il worker.
import type { EngineId, Task } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import { ciReport, CI_TAIL_LINES, reviewPrompt } from '../src/core/prompts.js';
import { SimEngine } from '../src/engines/sim/sim-engine.js';
import type { EngineAdapter } from '../src/engines/types.js';
import { demoRepo, noReply, testOrchestrator, waitFor } from './helpers.js';

const env = { userName: 'Aurora', nameOf: (id: string) => (id === 'bruno' ? 'Bruno' : id), tasks: [] };
const task = { id: 't1', title: 'Saluto', assignee: 'bruno', summary: 'fatto, tutti i test passano' } as Task;

describe('esito dei test nella review', () => {
  it('rapporto strutturato: comando, esito, durata, output finale', () => {
    const output = Array.from({ length: 40 }, (_, i) => `riga ${i + 1}`).join('\n');
    const r = ciReport({ command: 'npm test', pass: false, code: 1, timedOut: false, output, durationMs: 2345 });
    expect(r).toContain('Test eseguiti da Keystone');
    expect(r).toContain('- comando: npm test');
    expect(r).toContain('- esito: FALLITI (codice di uscita 1)');
    expect(r).toContain('- durata: 2.3 s');
    // solo le righe finali
    expect(r).toContain('riga 40');
    expect(r).toContain(`riga ${40 - CI_TAIL_LINES + 1}`);
    expect(r).not.toContain(`riga ${40 - CI_TAIL_LINES}\n`);
    expect(ciReport({ command: 'npm test', pass: false, code: null, timedOut: true, output: '', durationMs: 600_000 })).toContain('FALLITI (tempo massimo superato)');
    expect(ciReport(undefined)).toMatch(/nessuno/);
  });

  it('il prompt della review contiene l\'esito di Keystone e chiede di citarlo, anche se il worker dice altro', () => {
    const p = reviewPrompt(env, task, [], ciReport({ command: 'npm test', pass: false, code: 1, timedOut: false, output: 'AssertionError: 1 !== 2', durationMs: 1000 }));
    expect(p).toContain('Riassunto del worker (quello che dice lui): fatto, tutti i test passano');
    expect(p).toContain('- esito: FALLITI (codice di uscita 1)');
    expect(p).toContain('AssertionError: 1 !== 2');
    expect(p).toMatch(/cita l'esito dei test eseguiti da Keystone/);
    expect(p).toMatch(/non fidarti di quanto riporta il worker/);
  });

  it('nel flusso vero il lead riceve il rapporto dei test eseguiti da Keystone', async () => {
    // il motore sim fa il lavoro come sempre; si registra solo il prompt della review del lead
    const prompts: string[] = [];
    const sim = new SimEngine({ stepDelayMs: 0 });
    const record = (spec: Parameters<SimEngine['startSession']>[0]) => {
      if (spec.role === 'lead' && spec.job.kind === 'review') prompts.push(spec.prompt);
    };
    const spy: EngineAdapter = {
      id: sim.id,
      label: sim.label,
      defaultModel: (r) => sim.defaultModel(r),
      displayModel: (m) => sim.displayModel(m),
      checkAuth: () => sim.checkAuth(),
      startSession: (spec) => (record(spec), sim.startSession(spec)),
      resumeSession: (id, spec) => (record(spec), sim.resumeSession(id, spec)),
    };
    const engines = new Map<EngineId, EngineAdapter>([['sim', spy]]);
    const { o, cfg } = testOrchestrator({ workers: 1, leadReview: true, engines });
    await o.repos.add(await demoRepo(cfg.home), { confirmGuard: true });
    await o.start();
    await o.handle({ v: 1, type: 'goal.submit', text: 'Aggiungi un saluto' }, noReply);
    const d = await waitFor(() => o.decisions.open().find((x) => x.kind === 'merge'), 'decisione di merge');
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain('Test eseguiti da Keystone nel worktree');
    expect(prompts[0]).toContain('- comando: npm test');
    expect(prompts[0]).toContain('- esito: superati');
    // la stessa informazione arriva a te nella decisione di merge
    expect(d.context).toContain('- comando: npm test');
  });
});
