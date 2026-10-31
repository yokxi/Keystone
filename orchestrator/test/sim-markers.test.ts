// I marcatori del sim ([blocca], [vuoto], ...) sono attivi SOLO con il motore sim.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EngineEvent, EngineId, Role } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import { EventChannel, PermissionBroker } from '../src/engines/channel.js';
import { SIM_MARKERS } from '../src/engines/sim/markers.js';
import type { AuthCheck, EngineAdapter, EngineTurn, TurnSpec } from '../src/engines/types.js';
import { git } from '../src/util/git.js';
import { demoRepo, noReply, testOrchestrator, waitFor } from './helpers.js';

const SRC = path.resolve(import.meta.dirname, '..', 'src');

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/**
 * Un motore "reale" di prova (si presenta come Codex): non sa nulla dei marcatori. Il lead crea un
 * task con il testo dell'obiettivo, il worker scrive un file e chiede la review, il lead propone
 * il merge. Così si vede cosa fa l'orchestratore con i marcatori quando il motore non è il sim.
 */
class PlainEngine implements EngineAdapter {
  readonly id = 'codex' as const;
  readonly label = 'Motore di prova';
  defaultModel(_r: Role) {
    return 'prova';
  }
  displayModel() {
    return 'Prova';
  }
  async checkAuth(): Promise<AuthCheck> {
    return { ok: true, account: 'test' };
  }
  startSession(spec: TurnSpec): EngineTurn {
    return this.run(spec);
  }
  resumeSession(_id: string, spec: TurnSpec): EngineTurn {
    return this.run(spec);
  }
  private run(spec: TurnSpec): EngineTurn {
    const ch = new EventChannel<EngineEvent>();
    const broker = new PermissionBroker((e) => ch.push(e));
    const tool = (name: string) => spec.tools.find((t) => t.name === name)!;
    void (async () => {
      ch.push({ type: 'session', sessionId: randomUUID() });
      if (spec.role === 'lead' && spec.job.kind === 'plan') {
        await tool('create_task').run({ title: spec.job.title ?? 'task', description: 'dal motore di prova' });
      } else if (spec.role === 'worker' && spec.job.kind === 'work') {
        const ok = await broker.ask('Write', { file_path: path.join(spec.cwd, 'lavoro.txt') });
        if (ok.allow) {
          fs.writeFileSync(path.join(spec.cwd, 'lavoro.txt'), `${spec.job.title}\n`);
          await git(spec.cwd, ['add', '-A'], { env: spec.env as NodeJS.ProcessEnv });
          await git(spec.cwd, ['commit', '-q', '-m', 'lavoro'], { env: spec.env as NodeJS.ProcessEnv });
        }
        await tool('update_task').run({ task_id: spec.job.taskId, status: 'review', summary: 'fatto' });
      } else if (spec.role === 'lead' && spec.job.kind === 'review') {
        await tool('request_merge').run({ task_id: spec.job.taskId, summary: 'ok' });
      }
      ch.push({ type: 'turn_end', status: 'success' });
      ch.close();
    })();
    return { events: ch, respond: (id, a) => broker.respond(id, a), abort: () => ch.close() };
  }
}

describe('marcatori del sim', () => {
  it('nessun file fuori da engines/sim li conosce', () => {
    const offenders: string[] = [];
    for (const f of filesUnder(SRC)) {
      if (f.includes(`${path.sep}engines${path.sep}sim${path.sep}`)) continue;
      const text = fs.readFileSync(f, 'utf8');
      for (const m of Object.values(SIM_MARKERS)) if (text.includes(m)) offenders.push(`${path.relative(SRC, f)}: ${m}`);
    }
    expect(offenders).toEqual([]);
  });

  it('con un motore che non è il sim sono testo qualunque: [blocca] e [vuoto] non bloccano né svuotano il task', async () => {
    const engines = new Map<EngineId, EngineAdapter>([['codex', new PlainEngine()]]);
    const { o, cfg } = testOrchestrator({ engines, cfg: { agents: [{ id: 'ada', name: 'Ada', role: 'lead', engine: 'codex' }, { id: 'bruno', name: 'Bruno', role: 'worker', engine: 'codex' }] } });
    await o.repos.add(await demoRepo(cfg.home));
    await o.start();
    await o.handle({ v: 1, type: 'goal.submit', text: `Pubblica il pacchetto ${SIM_MARKERS.block} ${SIM_MARKERS.empty} ${SIM_MARKERS.alwaysFailingTest}` }, noReply);
    const m = await waitFor(() => o.decisions.open().find((d) => d.kind === 'merge'), 'decisione di merge');
    const t = o.tasks.get(m.taskId!)!;
    expect(t.status).toBe('review'); // non bloccato
    expect(t.blockedReason).toBeUndefined();
    expect(o.repos.findWorktree(t.repoId!, t.worktree!)?.files).toBe(1); // non vuoto
    expect(o.decisions.list().some((d) => d.kind === 'question' || d.kind === 'permission')).toBe(false);
  });

  it('con il motore sim, invece, [blocca] blocca il task', async () => {
    const { o, cfg } = testOrchestrator({ workers: 1 });
    await o.repos.add(await demoRepo(cfg.home));
    await o.start();
    await o.handle({ v: 1, type: 'goal.submit', text: `Pubblica ${SIM_MARKERS.block}; Altro ${SIM_MARKERS.empty}` }, noReply);
    await waitFor(() => o.tasks.get('t1')?.status === 'blocked', 't1 bloccato');
  });
});
