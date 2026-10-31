// Il contratto di EngineAdapter, verificato sul motore sim. Gli stessi controlli varranno per
// gli adattatori Claude e Codex (Fasi 5 e 6).
import { EngineEvent } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventChannel, PermissionBroker } from '../src/engines/channel.js';
import { SimEngine } from '../src/engines/sim/sim-engine.js';
import type { EngineTurn, TeamTool, TurnSpec } from '../src/engines/types.js';
import { demoRepo, tmpDir } from './helpers.js';

function spec(cwd: string, over: Partial<TurnSpec> = {}): TurnSpec {
  const tools: TeamTool[] = [
    { name: 'update_task', description: '', schema: z.object({ task_id: z.string(), status: z.string().optional(), summary: z.string().optional() }), run: async () => ({ text: 'ok' }) },
    { name: 'send_message', description: '', schema: z.object({ to: z.string(), text: z.string() }), run: async () => ({ text: 'ok' }) },
  ];
  return {
    agentId: 'bruno',
    agentName: 'Bruno',
    role: 'worker',
    cwd,
    prompt: 'lavora',
    instructions: '',
    model: 'sim',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Keystone Bruno', GIT_AUTHOR_EMAIL: 'bruno@keystone.local', GIT_COMMITTER_NAME: 'Keystone Bruno', GIT_COMMITTER_EMAIL: 'bruno@keystone.local' },
    writableRoots: [],
    tools,
    job: { kind: 'work', taskId: 't1', title: 'Prova' },
    ...over,
  };
}

async function drain(turn: EngineTurn, onEvent?: (e: EngineEvent) => void): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of turn.events) {
    out.push(e);
    if (e.type === 'permission_request') turn.respond(e.requestId, { allow: true });
    onEvent?.(e);
  }
  return out;
}

describe('contratto EngineAdapter (motore sim)', () => {
  it('emette eventi validi: session per primo, turn_end per ultimo', async () => {
    const repo = await demoRepo();
    const events = await drain(new SimEngine().startSession(spec(repo)));
    for (const e of events) expect(EngineEvent.safeParse(e).success).toBe(true);
    expect(events[0]?.type).toBe('session');
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', status: 'success' });
    expect(events.filter((e) => e.type === 'turn_end')).toHaveLength(1);
    // ogni tool_call ha il suo tool_result
    const calls = events.filter((e) => e.type === 'tool_call').map((e) => (e as { callId: string }).callId);
    const results = events.filter((e) => e.type === 'tool_result').map((e) => (e as { callId: string }).callId);
    expect(results.sort()).toEqual(calls.sort());
    expect(events.some((e) => e.type === 'file_change')).toBe(true);
    expect(events.some((e) => e.type === 'usage')).toBe(true);
  });

  it('resumeSession riusa l\'id di sessione', async () => {
    const repo = await demoRepo();
    const events = await drain(new SimEngine().resumeSession('sim-123', spec(repo)));
    expect(events[0]).toEqual({ type: 'session', sessionId: 'sim-123' });
  });

  it('aspetta la risposta alle richieste di permesso; un rifiuto impedisce la scrittura', async () => {
    const repo = await demoRepo();
    const turn = new SimEngine().startSession(spec(repo));
    const events: EngineEvent[] = [];
    for await (const e of turn.events) {
      events.push(e);
      if (e.type === 'permission_request') {
        await new Promise((r) => setTimeout(r, 30)); // il turno resta fermo finché non si risponde
        turn.respond(e.requestId, { allow: false, message: 'no' });
      }
    }
    expect(events.some((e) => e.type === 'file_change')).toBe(false);
    expect(events.at(-1)?.type).toBe('turn_end');
  });

  it('abort() chiude il turno con status "aborted" e nega i permessi in attesa', async () => {
    const repo = await demoRepo();
    const turn = new SimEngine({ stepDelayMs: 5 }).startSession(spec(repo));
    const events: EngineEvent[] = [];
    for await (const e of turn.events) {
      events.push(e);
      if (e.type === 'permission_request') turn.abort('stop');
    }
    expect(events.at(-1)).toEqual({ type: 'turn_end', status: 'aborted' });
  });

  it('i commit del sim usano l\'identità dell\'agente passata nell\'ambiente', async () => {
    const repo = await demoRepo(tmpDir());
    await drain(new SimEngine().startSession(spec(repo)));
    const { gitOut } = await import('../src/util/git.js');
    expect(await gitOut(repo, ['log', '-1', '--format=%an <%ae>'])).toBe('Keystone Bruno <bruno@keystone.local>');
  });
});

describe('EventChannel e PermissionBroker', () => {
  it('EventChannel consegna in ordine anche gli eventi arrivati prima del consumatore', async () => {
    const ch = new EventChannel<number>();
    ch.push(1);
    ch.push(2);
    setTimeout(() => {
      ch.push(3);
      ch.close();
    }, 5);
    const got: number[] = [];
    for await (const v of ch) got.push(v);
    expect(got).toEqual([1, 2, 3]);
  });

  it('PermissionBroker: risposte, id sconosciuti ignorati, abort nega tutto', async () => {
    const emitted: EngineEvent[] = [];
    const b = new PermissionBroker((e) => emitted.push(e));
    const p1 = b.ask('Bash', { command: 'ls' });
    const p2 = b.ask('Bash', { command: 'rm -rf x' });
    b.respond('p999', { allow: true });
    b.respond('p1', { allow: true });
    expect(await p1).toEqual({ allow: true });
    b.abort('pause');
    expect(await p2).toMatchObject({ allow: false });
    expect(await b.ask('Read', {})).toMatchObject({ allow: false });
    expect(emitted).toHaveLength(2);
  });
});
