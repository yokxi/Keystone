// Lo stato sopravvive a riavvii e crash: i turni interrotti riprendono con la stessa sessione e
// lo stesso tipo di lavoro.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { EngineId } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import type { StateData } from '../src/core/store.js';
import { SimEngine } from '../src/engines/sim/sim-engine.js';
import type { EngineAdapter } from '../src/engines/types.js';
import { demoRepo, noReply, onCleanup, testOrchestrator, tmpDir, waitFor } from './helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function slowSim(stepDelayMs: number): Map<EngineId, EngineAdapter> {
  return new Map<EngineId, EngineAdapter>([['sim', new SimEngine({ stepDelayMs })]]);
}

describe('ripresa dopo riavvio', () => {
  it('arresto a metà lavoro: al riavvio il worker riprende la stessa sessione e il task arriva in review', async () => {
    const home = tmpDir();
    const a = testOrchestrator({ home, workers: 1, engines: slowSim(60) });
    const repo = await demoRepo(home);
    await a.o.repos.add(repo, { confirmGuard: true });
    await a.o.start();
    await a.o.handle({ v: 1, type: 'goal.submit', text: 'Aggiungi un saluto' }, noReply);
    await waitFor(() => a.o.tasks.get('t1')?.status === 'doing' && a.o.store.data.team.inflight.bruno, 'bruno al lavoro su t1');
    const session = a.o.store.data.sessions['bruno:t1']?.sessionId;
    expect(session).toBeTruthy();
    await a.o.stop();
    expect(a.o.store.data.team.inflight.bruno?.kind).toBe('work');

    const b = testOrchestrator({ home, workers: 1 });
    await b.o.start();
    await waitFor(() => b.o.decisions.open().find((d) => d.kind === 'merge' && d.taskId === 't1'), 'merge di t1 dopo il riavvio');
    expect(b.o.store.data.sessions['bruno:t1']?.sessionId).toBe(session);
    expect(b.o.store.logTail('bruno').some((l) => l.text.startsWith('Riprende work t1'))).toBe(true);
  });

  it('una domanda aperta resta aperta dopo il riavvio; la risposta riprende la sessione', async () => {
    const home = tmpDir();
    const a = testOrchestrator({ home, workers: 1 });
    await a.o.repos.add(await demoRepo(home), { confirmGuard: true });
    await a.o.start();
    await a.o.handle({ v: 1, type: 'goal.submit', text: 'Scegli [domanda]; Altro [vuoto]' }, noReply);
    const q = await waitFor(() => a.o.decisions.open().find((d) => d.kind === 'question'), 'domanda');
    await a.o.stop();

    const b = testOrchestrator({ home, workers: 1 });
    await b.o.start();
    expect(b.o.decisions.get(q.id)?.status).toBe('open');
    expect(b.o.agent('bruno')?.state).toBe('waiting_user');
    await b.o.handle({ v: 1, type: 'decision.answer', decisionId: q.id, option: 'A' }, noReply);
    await waitFor(() => b.o.decisions.open().find((d) => d.kind === 'merge' && d.taskId === 't1'), 'merge di t1');
  });

  it('le richieste di permesso di un processo che non c\'è più vengono annullate e richieste di nuovo', async () => {
    const home = tmpDir();
    const a = testOrchestrator({ home, workers: 1 });
    await a.o.repos.add(await demoRepo(home), { confirmGuard: true });
    await a.o.start();
    await a.o.handle({ v: 1, type: 'goal.submit', text: 'Verifica [permesso]; Altro [vuoto]' }, noReply);
    const p = await waitFor(() => a.o.decisions.open().find((d) => d.kind === 'permission'), 'permesso');
    await a.o.stop();

    const b = testOrchestrator({ home, workers: 1 });
    await b.o.start();
    expect(b.o.decisions.get(p.id)?.status).toBe('cancelled');
    expect(b.o.decisions.get(p.id)?.cancelReason).toMatch(/riavviato|shutdown/);
    const again = await waitFor(() => b.o.decisions.open().find((d) => d.kind === 'permission'), 'nuova richiesta di permesso');
    expect(again.id).not.toBe(p.id);
  });

  it('pianificazione interrotta: al riavvio il lead la riprende senza duplicare i task', async () => {
    const home = tmpDir();
    const a = testOrchestrator({ home, workers: 1, engines: slowSim(80) });
    await a.o.repos.add(await demoRepo(home), { confirmGuard: true });
    await a.o.start();
    await a.o.handle({ v: 1, type: 'goal.submit', text: 'Uno; Due; Tre' }, noReply);
    await waitFor(() => a.o.tasks.list().length >= 1, 'primo task creato');
    await a.o.stop();
    expect(a.o.goal('g1')?.status).toBe('planning');

    const b = testOrchestrator({ home, workers: 1 });
    await b.o.start();
    await waitFor(() => b.o.goal('g1')?.status === 'active', 'obiettivo attivo');
    expect(b.o.tasks.list().map((t) => t.title)).toEqual(['Uno', 'Due', 'Tre']);
  });

  it('crash vero: processo terminato di forza durante il lavoro, il nuovo avvio completa il task', async () => {
    const home = tmpDir();
    const child = spawn(process.execPath, ['--import', 'tsx', 'orchestrator/src/main.ts', '--demo', '--home', home, '--port', '0', '--workers', '1', '--sim-delay', '150', '--goal', 'Aggiungi un saluto'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    onCleanup(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    const stateFile = path.join(home, 'demo', 'state.json');
    const readState = (): StateData | undefined => {
      try {
        return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as StateData;
      } catch {
        return undefined;
      }
    };
    await waitFor(() => readState()?.team.inflight.bruno?.kind === 'work', `bruno al lavoro (output: ${out})`, 60_000);
    child.kill('SIGKILL'); // nessun salvataggio finale: un crash
    await new Promise((r) => child.once('exit', r));

    const b = testOrchestrator({ home, workers: 1, cfg: { profile: 'demo' } });
    await b.o.start();
    await waitFor(() => b.o.decisions.open().find((d) => d.kind === 'merge' && d.taskId === 't1'), 'merge di t1 dopo il crash', 60_000);
    // il file di lock lasciato dal processo morto non blocca il profilo
    expect(fs.existsSync(path.join(home, 'demo', 'orchestrator.json'))).toBe(true);
  });
});
