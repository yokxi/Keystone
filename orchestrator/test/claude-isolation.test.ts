// Isolamento dalla configurazione utente di Claude Code, verificato sulla CLI VERA dell'Agent SDK
// (senza rete: chiave finta e indirizzo API inesistente; si legge solo il messaggio di avvio, che la
// CLI emette prima di chiamare l'API, con tool, comandi, skill e server MCP che vede).
//
// Si prepara una home finta con impostazioni (hook e permessi), comandi, skill, CLAUDE.md globale e
// un server MCP in ~/.claude.json, più un comando di progetto nel repository. Con le opzioni di
// Keystone non deve comparire nulla di tutto ciò; senza (controprova) la stessa CLI li vede.
import fs from 'node:fs';
import path from 'node:path';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClaudeEngine, LEAD_TOOLS } from '../src/engines/claude/claude-engine.js';
import type { TurnSpec } from '../src/engines/types.js';
import { tmpDir } from './helpers.js';

interface InitInfo {
  tools: string[];
  mcp: string[];
  commands: string[];
  skills: string[];
  permissionMode: string;
  autoMemory?: string;
}

async function readInit(options: Options): Promise<InitInfo> {
  const q = query({ prompt: 'ciao', options });
  const timer = setTimeout(() => q.close(), 90_000);
  try {
    for await (const m of q as AsyncIterable<SDKMessage>) {
      const msg = m as Record<string, unknown>;
      if (msg.type === 'system' && msg.subtype === 'init') {
        return {
          tools: msg.tools as string[],
          mcp: ((msg.mcp_servers as Array<{ name: string }>) ?? []).map((s) => s.name),
          commands: msg.slash_commands as string[],
          skills: (msg.skills as string[]) ?? [],
          permissionMode: String(msg.permissionMode),
          autoMemory: (msg.memory_paths as { auto?: string } | undefined)?.auto,
        };
      }
    }
    throw new Error('la CLI non ha emesso il messaggio di avvio');
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

function fakeUserHome(): { home: string; marker: string } {
  const home = tmpDir('keystone-home-utente-');
  const claude = path.join(home, '.claude');
  const marker = path.join(home, 'hook-utente-eseguito.txt');
  fs.mkdirSync(path.join(claude, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'skills', 'skill-utente'), { recursive: true });
  fs.writeFileSync(
    path.join(claude, 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(*)', 'Write(*)'], defaultMode: 'bypassPermissions' },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"` }] }] },
      env: { VARIABILE_UTENTE: '1' },
    }),
  );
  fs.writeFileSync(path.join(claude, 'commands', 'comando-utente.md'), 'Fai qualcosa di segreto.\n');
  fs.writeFileSync(path.join(claude, 'skills', 'skill-utente', 'SKILL.md'), '---\nname: skill-utente\ndescription: una skill personale dell\'utente\n---\nIstruzioni personali.\n');
  fs.writeFileSync(path.join(claude, 'CLAUDE.md'), 'Istruzioni globali personali: rispondi sempre in rima.\n');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { 'server-utente': { type: 'stdio', command: 'node', args: ['-e', 'setTimeout(()=>{},1)'] } } }));
  return { home, marker };
}

function baseEnv(home: string): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    Path: process.env.Path,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: home,
    USERPROFILE: home,
    ANTHROPIC_API_KEY: 'sk-ant-finta',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  };
}

describe('isolamento dalla configurazione utente di Claude Code (CLI vera, senza rete)', () => {
  it('con le opzioni di Keystone: niente impostazioni, hook, comandi, skill o server MCP dell\'utente', async () => {
    const { home, marker } = fakeUserHome();
    const repo = tmpDir('keystone-repo-');
    fs.mkdirSync(path.join(repo, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'commands', 'comando-progetto.md'), 'comando del repository\n');

    // controprova: la stessa CLI, senza le barriere di Keystone, vede la configurazione dell'utente
    const control = await readInit({ cwd: repo, model: 'claude-sonnet-5-5', permissionMode: 'default', env: baseEnv(home) });
    expect(control.commands, 'la controprova deve vedere il comando dell\'utente').toContain('comando-utente');
    expect(control.mcp).toContain('server-utente');

    // Keystone: le opzioni costruite dall'adattatore
    const engine = new ClaudeEngine({ configDir: path.join(tmpDir(), 'claude-config') });
    const spec: TurnSpec = {
      agentId: 'ada',
      agentName: 'Ada',
      role: 'lead',
      cwd: repo,
      prompt: 'ciao',
      instructions: 'istruzioni di Keystone',
      model: 'claude-opus-5-5',
      env: baseEnv(home),
      writableRoots: [],
      tools: [{ name: 'list_tasks', description: 'tabellone', schema: z.object({}), run: async () => ({ text: 'nessun task' }) }],
      job: { kind: 'plan' },
    };
    const options = engine.buildOptions(spec, {
      preToolUse: [{ hooks: [async () => ({ continue: true })] }],
      canUseTool: async () => ({ behavior: 'deny', message: 'test' }),
      abort: new AbortController(),
    });
    if (fs.existsSync(marker)) fs.rmSync(marker);
    const isolated = await readInit(options);

    expect(isolated.permissionMode).toBe('default'); // nonostante defaultMode: bypassPermissions dell'utente
    expect(isolated.commands).not.toContain('comando-utente');
    expect(isolated.commands).not.toContain('comando-progetto');
    expect(isolated.skills).not.toContain('skill-utente');
    expect(isolated.mcp).toEqual(['keystone']);
    // solo i tool di base del ruolo più i tool del team di Keystone
    const builtins = isolated.tools.filter((t) => !t.startsWith('mcp__'));
    expect(builtins.sort()).toEqual([...LEAD_TOOLS].sort());
    expect(isolated.tools.filter((t) => t.startsWith('mcp__'))).toEqual(['mcp__keystone__list_tasks']);
    // l'hook SessionStart dell'utente non è stato eseguito
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.existsSync(marker)).toBe(false);
  }, 240_000);

  it('con il login personale: la CLI non legge ~/.claude (solo il token), e la configurazione dell\'utente resta invisibile', async () => {
    const { home, marker } = fakeUserHome();
    // credenziali del login nella home finta: Keystone non deve usarle né copiarle
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'finto-da-file', refreshToken: 'finto' } }));
    const repo = tmpDir('keystone-repo-');
    const configDir = path.join(tmpDir(), 'claude-config');
    const engine = new ClaudeEngine({ configDir, useClaudeLogin: true });
    const env: Record<string, string | undefined> = { ...baseEnv(home), ...LOGIN_ENV };
    delete env.ANTHROPIC_API_KEY;
    const options = keystoneOptions(engine, repo, env);

    expect(options.env?.CLAUDE_CONFIG_DIR).toBe(configDir);
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(LOGIN_ENV.CLAUDE_CODE_OAUTH_TOKEN);
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.settingSources).toEqual([]);

    if (fs.existsSync(marker)) fs.rmSync(marker);
    const init = await readInit(options);
    expect(init.permissionMode).toBe('default');
    expect(init.commands).not.toContain('comando-utente');
    expect(init.skills).not.toContain('skill-utente');
    expect(init.mcp).toEqual(['keystone']);
    expect(init.autoMemory, 'memoria automatica della CLI disattivata').toBeUndefined();
    expect(init.tools.filter((t) => !t.startsWith('mcp__')).sort()).toEqual([...LEAD_TOOLS].sort());
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.existsSync(marker)).toBe(false);
    // il file delle credenziali dell'utente non è stato copiato nella cartella isolata
    expect(fs.existsSync(path.join(configDir, '.credentials.json'))).toBe(false);
  }, 240_000);

  for (const mode of ['api', 'login'] as const) {
    it(`i sottoprocessi della CLI non vedono la credenziale (${mode === 'api' ? 'chiave API' : 'token di login'})`, async () => {
      const { home } = fakeUserHome();
      const repo = tmpDir('keystone-repo-');
      const out = path.join(tmpDir(), 'env-sonda.json');
      // sonda: un server MCP stdio, quindi un sottoprocesso della CLI come Bash, che scrive quali
      // variabili vede e poi resta in attesa
      const probe = path.join(tmpDir(), 'sonda.cjs');
      fs.writeFileSync(
        probe,
        `const fs=require('fs');const k=['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','VARIABILE_INNOCUA'];` +
          `fs.writeFileSync(${JSON.stringify(out)},JSON.stringify(Object.fromEntries(k.map(x=>[x,process.env[x]!==undefined]))));setTimeout(()=>{},60000);`,
      );
      const engine = new ClaudeEngine({ configDir: path.join(tmpDir(), 'claude-config'), useClaudeLogin: mode === 'login' });
      const env: Record<string, string | undefined> = { ...baseEnv(home), VARIABILE_INNOCUA: '1', ...(mode === 'login' ? LOGIN_ENV : {}) };
      if (mode === 'login') delete env.ANTHROPIC_API_KEY;
      const options = keystoneOptions(engine, repo, env);
      expect(options.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
      // solo per la prova: un server in più accanto a quello di Keystone
      options.mcpServers = { ...options.mcpServers, sonda: { type: 'stdio', command: process.execPath, args: [probe] } };
      const q = query({ prompt: 'ciao', options });
      const timer = setTimeout(() => q.close(), 90_000);
      try {
        const it = (q as AsyncIterable<SDKMessage>)[Symbol.asyncIterator]();
        void it.next();
        const start = Date.now();
        while (!fs.existsSync(out) && Date.now() - start < 60_000) await new Promise((r) => setTimeout(r, 100));
      } finally {
        clearTimeout(timer);
        q.close();
      }
      const seen = JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, boolean>;
      expect(seen.VARIABILE_INNOCUA, 'controprova: le variabili normali arrivano').toBe(true);
      expect(seen).toMatchObject({ ANTHROPIC_API_KEY: false, ANTHROPIC_AUTH_TOKEN: false, CLAUDE_CODE_OAUTH_TOKEN: false });
    }, 240_000);
  }
});

/** Login personale finto, senza rete: anche le chiamate di servizio della CLI vanno su un proxy inesistente. */
const LOGIN_ENV = { CLAUDE_CODE_OAUTH_TOKEN: 'token-di-login-finto', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' };

function keystoneOptions(engine: ClaudeEngine, repo: string, env: Record<string, string | undefined>): Options {
  const spec: TurnSpec = {
    agentId: 'ada',
    agentName: 'Ada',
    role: 'lead',
    cwd: repo,
    prompt: 'ciao',
    instructions: 'istruzioni di Keystone',
    model: 'claude-sonnet-5-5',
    env,
    writableRoots: [],
    tools: [{ name: 'list_tasks', description: 'tabellone', schema: z.object({}), run: async () => ({ text: 'nessun task' }) }],
    job: { kind: 'plan' },
  };
  return engine.buildOptions(spec, {
    preToolUse: [{ hooks: [async () => ({ continue: true })] }],
    canUseTool: async () => ({ behavior: 'deny', message: 'test' }),
    abort: new AbortController(),
  });
}
