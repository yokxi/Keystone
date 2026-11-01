// Il motore Codex sulla CLI VERA (0.163.0), senza rete né credenziali: un "modello" locale
// (codex-mock-model.ts) chiede comandi e tool, e si verifica cosa arriva a Keystone e cosa no.
// Proxy inesistente per tutto il resto: nessuna chiamata esce dalla macchina.
import fs from 'node:fs';
import path from 'node:path';
import type { EngineEvent } from '@keystone/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CodexEngine } from '../src/engines/codex/codex-engine.js';
import type { TurnSpec } from '../src/engines/types.js';
import { git } from '../src/util/git.js';
import { lastToolOutput, mockModel, toolNames } from './codex-mock-model.js';
import { tmpDir } from './helpers.js';

const NO_NET = { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' };
const saved = { key: process.env.OPENAI_API_KEY };
beforeEach(() => {
  process.env.OPENAI_API_KEY = 'sk-finta-non-deve-arrivare-ai-comandi';
});
afterEach(() => {
  if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = saved.key;
});

function spec(cwd: string, role: 'lead' | 'worker', tools: TurnSpec['tools'] = []): TurnSpec {
  return {
    agentId: role === 'lead' ? 'ada' : 'bruno',
    agentName: role === 'lead' ? 'Ada' : 'Bruno',
    role,
    cwd,
    prompt: 'esegui il compito',
    instructions: 'istruzioni di Keystone',
    model: 'modello-finto',
    env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', KEYSTONE_AGENT: 'bruno' },
    writableRoots: [],
    tools,
    job: { kind: role === 'lead' ? 'plan' : 'work', taskId: 't1' },
  };
}

async function drain(turn: ReturnType<CodexEngine['startSession']>, answer: (e: Extract<EngineEvent, { type: 'permission_request' }>) => boolean): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of turn.events) {
    out.push(e);
    if (e.type === 'permission_request') turn.respond(e.requestId, answer(e) ? { allow: true } : { allow: false, message: 'negato dalla policy' });
  }
  return out;
}

const engineFor = (model: { config: Record<string, unknown> }) => new CodexEngine({ codexHome: path.join(tmpDir('keystone-codex-home-'), 'codex-home'), extraEnv: NO_NET, extraConfig: model.config });

describe('motore Codex sulla CLI vera (modello locale, senza rete)', () => {
  it('anche i comandi di sola lettura passano dalla policy; il diniego torna al modello', async () => {
    const model = await mockModel([
      { call: 'exec_command', args: { cmd: 'Get-Content README.md' } },
      { call: 'exec_command', args: { cmd: 'ls' } },
      { call: 'exec_command', args: { cmd: 'git status' } },
      { message: 'fatto' },
    ]);
    const repo = tmpDir('keystone-codex-repo-');
    fs.writeFileSync(path.join(repo, 'README.md'), 'ciao\n');
    await git(repo, ['init', '-q']);
    const asked: string[] = [];
    const events = await drain(engineFor(model).startSession(spec(repo, 'lead')), (e) => {
      asked.push(`${e.tool}: ${String(e.input.command)}`);
      return false;
    });
    expect(asked).toEqual(['PowerShell: Get-Content README.md', 'PowerShell: ls', 'PowerShell: git status']);
    // il modello ha ricevuto il rifiuto, non il contenuto
    expect(lastToolOutput(model.requests[1]!)).toMatch(/rejected/i);
    expect(lastToolOutput(model.requests[1]!)).not.toContain('ciao');
    expect(events.at(-1)).toEqual({ type: 'turn_end', status: 'success', resultText: 'fatto' });
    expect(events).toContainEqual({ type: 'model', model: 'modello-finto' });
  }, 180_000);

  it('al modello arrivano solo i comandi e i tool del team: niente immagini, sub-agenti, obiettivi, web', async () => {
    const model = await mockModel([{ message: 'ok' }]);
    const repo = tmpDir('keystone-codex-repo-');
    await git(repo, ['init', '-q']);
    const tools: TurnSpec['tools'] = [{ name: 'list_tasks', description: 'il tabellone', schema: z.object({}), run: async () => ({ text: 'nessun task' }) }];
    await drain(engineFor(model).startSession(spec(repo, 'lead', tools)), () => false);
    const names = toolNames(model.requests[0]!);
    expect(names).toContain('exec_command');
    expect(names.some((n) => n.includes('list_tasks'))).toBe(true);
    for (const banned of ['view_image', 'multi_agent', 'spawn_agent', 'create_goal', 'get_goal', 'update_goal', 'web_search', 'image_generation', 'browser']) {
      expect(names.some((n) => n.includes(banned)), `${banned} in ${names.join(', ')}`).toBe(false);
    }
    // nessuna istruzione esterna: solo quelle di Keystone
    const instructions = JSON.stringify(model.requests[0]!.input ?? '') + String(model.requests[0]!.instructions ?? '');
    expect(instructions).toContain('istruzioni di Keystone');
  }, 180_000);

  it('i tool del team passano dalla policy e girano davvero; il worker scrive solo con approvazione', async () => {
    const ran: string[] = [];
    const tools: TurnSpec['tools'] = [{ name: 'list_tasks', description: 'il tabellone', schema: z.object({}), run: async () => (ran.push('list_tasks'), { text: 't1 [doing] Saluto' }) }];
    const model = await mockModel([
      (req) => ({ call: toolNames(req).find((n) => n.includes('list_tasks'))!.split('.').pop()!, args: {} }),
      { call: 'exec_command', args: { cmd: "Set-Content -Path saluto.txt -Value 'ciao'" } },
      { call: 'exec_command', args: { cmd: 'Get-ChildItem env: | ForEach-Object { $_.Name }' } },
      { call: 'exec_command', args: { cmd: 'git add saluto.txt; git -c user.name=Bruno -c user.email=bruno@keystone.local commit -q -m saluto' } },
      { message: 'fatto' },
    ]);
    // come in Keystone: il worker lavora in un worktree su Keystone/<agente>/<task>, con la .git condivisa altrove
    const main = tmpDir('keystone-codex-repo-');
    await git(main, ['init', '-q', '-b', 'main']);
    await git(main, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'inizio']);
    const repo = path.join(tmpDir('keystone-codex-wt-'), 'ks-bruno-t1');
    await git(main, ['worktree', 'add', '-q', '-b', 'Keystone/bruno/t1-saluto', repo]);
    const asked: string[] = [];
    const events = await drain(engineFor(model).startSession(spec(repo, 'worker', tools)), (e) => {
      asked.push(`${e.tool}: ${String(e.input.command ?? e.input.file_path ?? '')}`);
      return true;
    });
    expect(asked[0]).toBe('mcp__keystone__list_tasks: ');
    expect(ran).toEqual(['list_tasks']);
    expect(lastToolOutput(model.requests[1]!)).toContain('t1 [doing] Saluto');
    expect(asked).toContain("PowerShell: Set-Content -Path saluto.txt -Value 'ciao'");
    expect(fs.readFileSync(path.join(repo, 'saluto.txt'), 'utf8').trim()).toBe('ciao');
    // l'ambiente dei comandi: le variabili di sicurezza git sì, la chiave no
    const envNames = lastToolOutput(model.requests[3]!);
    expect(envNames).toContain('GIT_CONFIG_COUNT');
    expect(envNames).not.toContain('OPENAI_API_KEY');
    expect(envNames).not.toContain('CODEX_API_KEY');
    // il commit dentro la sandbox funziona: le cartelle scrivibili bastano (oggetti, branch, gitdir del worktree)
    expect((await git(main, ['log', '-1', '--format=%s', 'Keystone/bruno/t1-saluto'])).stdout.trim()).toBe('saluto');
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', status: 'success' });
    // i token del turno sono contati
    expect(events.filter((e) => e.type === 'usage').length).toBeGreaterThan(0);
  }, 180_000);
});

describe('stima della spesa dai token (CLI vera)', () => {
  it('con i prezzi indicati, ogni richiesta al modello diventa una spesa stimata', async () => {
    const model = await mockModel([{ call: 'exec_command', args: { cmd: 'ls' } }, { message: 'ok' }]);
    const repo = tmpDir('keystone-codex-repo-');
    await git(repo, ['init', '-q']);
    const engine = new CodexEngine({ codexHome: path.join(tmpDir('keystone-codex-home-'), 'codex-home'), extraEnv: NO_NET, extraConfig: model.config, prices: { inputPerMTok: 2, outputPerMTok: 8 } });
    const events = await drain(engine.startSession(spec(repo, 'lead')), () => false);
    const cost = events.filter((e) => e.type === 'usage').reduce((s, e) => s + ((e as { costUsd?: number }).costUsd ?? 0), 0);
    // il modello locale riporta 100 token in ingresso e 20 in uscita per richiesta; le richieste sono 2
    expect(model.requests).toHaveLength(2);
    expect(cost).toBeCloseTo((2 * (100 * 2 + 20 * 8)) / 1_000_000, 9);
  }, 180_000);
});

describe('isolamento dalla configurazione utente di Codex (CLI vera, senza rete)', () => {
  function userCodexHome(): string {
    const home = path.join(tmpDir('keystone-codex-utente-'), '.codex');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "modello-utente"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[mcp_servers.server-utente]\ncommand = "node"\nargs = ["-e", "1"]\n');
    fs.writeFileSync(path.join(home, 'AGENTS.md'), 'ISTRUZIONI PERSONALI GLOBALI DELL\'UTENTE\n');
    return home;
  }

  it('anche con CODEX_HOME dell\'utente nell\'ambiente: niente sua configurazione, istruzioni, server MCP o skill; le approvazioni restano', async () => {
    const userHome = userCodexHome();
    const model = await mockModel([{ call: 'exec_command', args: { cmd: 'Get-Content README.md' } }, { message: 'ok' }]);
    const repo = tmpDir('keystone-codex-repo-');
    await git(repo, ['init', '-q']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'ciao\n');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'ISTRUZIONI DEL REPOSITORY\n');
    const s = spec(repo, 'lead');
    s.env = { ...s.env, CODEX_HOME: userHome };
    const asked: string[] = [];
    const engine = engineFor(model);
    const events = await drain(engine.startSession(s), (e) => (asked.push(String(e.input.command)), false));
    const first = JSON.stringify(model.requests[0]);
    expect(first).not.toContain('ISTRUZIONI PERSONALI GLOBALI');
    expect(first).not.toContain('ISTRUZIONI DEL REPOSITORY');
    expect(first).not.toContain('server-utente');
    expect(first).not.toContain('imagegen'); // le skill di sistema di Codex sono disattivate
    expect(model.requests[0]!.model).toBe('modello-finto'); // non il modello dell'utente
    // approval_policy = "never" dell'utente non vale: il comando ha chiesto
    expect(asked).toEqual(['Get-Content README.md']);
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', status: 'success' });
    // la home dell'utente non è stata toccata: nessun login scritto lì
    expect(fs.existsSync(path.join(userHome, 'auth.json'))).toBe(false);
  }, 180_000);

  it('controprova: la stessa CLI con la CODEX_HOME dell\'utente vede le sue istruzioni e il suo server MCP', async () => {
    const userHome = userCodexHome();
    const model = await mockModel([{ message: 'ok' }]);
    const repo = tmpDir('keystone-codex-repo-');
    await git(repo, ['init', '-q']);
    // senza isolamento: CODEX_HOME dell'utente, nessuna configurazione di Keystone
    const { spawn } = await import('node:child_process');
    const { RpcClient } = await import('../src/engines/codex/rpc.js');
    const { defaultCodexBin } = await import('../src/engines/codex/codex-engine.js');
    const p = spawn(defaultCodexBin(), ['app-server'], { cwd: repo, env: { ...process.env, ...NO_NET, CODEX_HOME: userHome }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const rpc = new RpcClient(p.stdout!, p.stdin!, { onNotification: () => undefined, onRequest: async () => Promise.reject(new Error('no')) });
    try {
      await rpc.request('initialize', { clientInfo: { name: 'keystone-test', title: null, version: '0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
      rpc.notify('initialized');
      const th = await rpc.request<{ model: string; instructionSources: string[]; approvalPolicy: unknown }>('thread/start', { cwd: repo, ephemeral: true, config: model.config });
      expect(th.model).toBe('modello-utente');
      expect(th.instructionSources.some((x) => x.endsWith('AGENTS.md'))).toBe(true);
      const mcp = await rpc.request<{ data: Array<{ name: string }> }>('mcpServerStatus/list', {});
      expect(mcp.data.map((x) => x.name)).toContain('server-utente');
    } finally {
      rpc.close();
      p.kill();
    }
  }, 180_000);
});
