// Le credenziali dei motori (chiave API, token di login) restano alla CLI del motore: non arrivano
// all'ambiente dei comandi degli agenti né ai test del repository che Keystone esegue nel worktree,
// perché quel codice lo scrive l'agente.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineId } from '@keystone/shared';
import { ClaudeEngine } from '../src/engines/claude/claude-engine.js';
import { SimEngine } from '../src/engines/sim/sim-engine.js';
import type { EngineAdapter, TurnSpec } from '../src/engines/types.js';
import { git } from '../src/util/git.js';
import { demoRepo, noReply, testOrchestrator, tmpDir, waitFor } from './helpers.js';

const FAKE = { ANTHROPIC_API_KEY: 'sk-ant-finta-credenziali', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-finto', OPENAI_API_KEY: 'sk-finta' };

class RecordingSim extends SimEngine {
  specs: TurnSpec[] = [];
  override startSession(spec: TurnSpec) {
    this.specs.push(spec);
    return super.startSession(spec);
  }
  override resumeSession(id: string, spec: TurnSpec) {
    this.specs.push(spec);
    return super.resumeSession(id, spec);
  }
}

const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('credenziali dei motori', () => {
  it('i test del repository e i comandi degli agenti non le vedono; il motore le riceve a parte', async () => {
    for (const [k, v] of Object.entries(FAKE)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const sim = new RecordingSim({ stepDelayMs: 0 });
    const { o, cfg } = testOrchestrator({ engines: new Map<EngineId, EngineAdapter>([['sim', sim]]), workers: 1 });
    const repoPath = await demoRepo(cfg.home);
    // sonda: un test del repository che scrive quali credenziali vede
    const out = path.join(tmpDir(), 'env-sonda.json');
    const keys = JSON.stringify(Object.keys(FAKE));
    fs.writeFileSync(
      path.join(repoPath, 'sonda.test.cjs'),
      `const fs=require('fs');fs.writeFileSync(${JSON.stringify(out)},JSON.stringify(Object.fromEntries(${keys}.map(k=>[k,process.env[k]!==undefined]).concat([['PATH',!!(process.env.PATH||process.env.Path)]]))));\n`,
    );
    await git(repoPath, ['add', '-A']);
    await git(repoPath, ['commit', '-q', '-m', 'sonda']);
    await o.repos.add(repoPath, { confirmGuard: true });
    await o.start();
    await o.handle({ v: 1, type: 'goal.submit', text: 'Aggiungi un saluto' }, noReply);
    await waitFor(() => fs.existsSync(out), 'test del repository eseguiti da Keystone', 90_000);

    const seen = JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, boolean>;
    expect(seen.PATH, 'controprova: le variabili normali arrivano').toBe(true);
    expect(seen).toMatchObject({ ANTHROPIC_API_KEY: false, CLAUDE_CODE_OAUTH_TOKEN: false, OPENAI_API_KEY: false });
    const spec = sim.specs[0]!;
    for (const k of Object.keys(FAKE)) expect(spec.env[k], k).toBeUndefined();
    expect(spec.credentials).toMatchObject(FAKE);
    await o.stop();
  }, 120_000);

  it('Claude: alla CLI arriva solo la credenziale della modalità scelta', () => {
    const hooks = { preToolUse: [{ hooks: [async () => ({ continue: true })] }], canUseTool: async () => ({ behavior: 'deny' as const, message: 'x' }), abort: new AbortController() };
    const spec: TurnSpec = { agentId: 'bruno', agentName: 'Bruno', role: 'worker', cwd: tmpDir(), prompt: 'p', instructions: 'i', model: 'claude-sonnet-5-5', env: { PATH: '/bin' }, credentials: { ...FAKE }, writableRoots: [], tools: [], job: { kind: 'work' } };
    const api = new ClaudeEngine({ configDir: path.join(tmpDir(), 'c') }).buildOptions(spec, hooks).env!;
    expect(api.ANTHROPIC_API_KEY).toBe(FAKE.ANTHROPIC_API_KEY);
    expect(api.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(api.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
    const login = new ClaudeEngine({ configDir: path.join(tmpDir(), 'c'), useClaudeLogin: true }).buildOptions(spec, hooks).env!;
    expect(login.CLAUDE_CODE_OAUTH_TOKEN).toBe(FAKE.CLAUDE_CODE_OAUTH_TOKEN);
    expect(login.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
