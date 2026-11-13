// L'ambiente dei comandi degli agenti non eredita le variabili che servono solo all'orchestratore
// impacchettato (gira con il Node di Electron).
import { describe, expect, it } from 'vitest';
import { agentEnv, secretVars } from '../src/core/agent-env.js';
import { tmpDir } from './helpers.js';

describe('ambiente degli agenti', () => {
  it('niente ELECTRON_RUN_AS_NODE (in qualunque maiuscola), il resto resta', () => {
    const env = agentEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', MIA_VARIABILE: 'x' }, { agentId: 'bruno', name: 'Bruno', cwd: tmpDir() });
    expect(Object.keys(env).filter((k) => /^electron_/i.test(k))).toEqual([]);
    expect(env.MIA_VARIABILE).toBe('x');
    expect(env.PATH).toBe('/bin');
  });

  it('niente chiavi dei motori, token o credenziali cloud: i test del repository girano con questo ambiente', () => {
    const secrets = {
      ANTHROPIC_API_KEY: 'sk-ant-finta',
      anthropic_auth_token: 'finto',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-finto',
      OPENAI_API_KEY: 'sk-finta',
      CODEX_API_KEY: 'finta',
      AWS_SECRET_ACCESS_KEY: 'finta',
      AWS_SESSION_TOKEN: 'finto',
      AZURE_CLIENT_SECRET: 'finto',
      DB_PASSWORD: 'finta',
    };
    const env = agentEnv({ PATH: '/bin', MIA_VARIABILE: 'x', ...secrets }, { agentId: 'bruno', name: 'Bruno', cwd: tmpDir() });
    for (const k of Object.keys(secrets)) expect(env[k], k).toBeUndefined();
    expect(env.MIA_VARIABILE).toBe('x');
    // le credenziali restano disponibili a parte, per la sola CLI del motore
    expect(secretVars({ PATH: '/bin', ...secrets })).toEqual(secrets);
  });
});
