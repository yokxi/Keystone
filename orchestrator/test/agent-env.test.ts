// L'ambiente dei comandi degli agenti non eredita le variabili che servono solo all'orchestratore
// impacchettato (gira con il Node di Electron).
import { describe, expect, it } from 'vitest';
import { agentEnv, engineCredentials, withoutSecrets } from '../src/core/agent-env.js';
import { tmpDir } from './helpers.js';

describe('ambiente degli agenti', () => {
  it('niente ELECTRON_RUN_AS_NODE (in qualunque maiuscola), il resto resta', () => {
    const env = agentEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', MIA_VARIABILE: 'x' }, { agentId: 'bruno', name: 'Bruno', cwd: tmpDir() });
    expect(Object.keys(env).filter((k) => /^electron_/i.test(k))).toEqual([]);
    expect(env.MIA_VARIABILE).toBe('x');
    expect(env.PATH).toBe('/bin');
  });

  it('niente chiavi dei motori, token, credenziali cloud o password: i test del repository girano con questo ambiente', () => {
    const engine = {
      ANTHROPIC_API_KEY: 'sk-ant-finta',
      anthropic_auth_token: 'finto',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-finto',
      AWS_SECRET_ACCESS_KEY: 'finta',
      AWS_SESSION_TOKEN: 'finto',
      AWS_BEARER_TOKEN_BEDROCK: 'finto',
      AZURE_CLIENT_SECRET: 'finto',
      GOOGLE_APPLICATION_CREDENTIALS: 'C:\chiavi\gcp.json',
    };
    const others = {
      OPENAI_API_KEY: 'sk-finta',
      CODEX_API_KEY: 'finta',
      GITHUB_TOKEN: 'ghp_finto',
      NPM_TOKEN: 'finto',
      STRIPE_KEY: 'finta',
      PRIVATE_KEY: 'finta',
      DB_PASSWORD: 'finta',
      DB_PASSWD: 'finta',
      SMTP_PASS: 'finta',
      SSH_PASSPHRASE: 'finta',
      MY_APIKEY: 'finta',
      DATABASE_URL: 'postgres://utente:segreta@db.local:5432/app',
    };
    const innocue = { PATH: '/bin', MIA_VARIABILE: 'x', KEYSTONE_HOME: '/k', TOKENIZER_PATH: '/t', PWD: '/w', AWS_REGION: 'eu-west-1', DATABASE_HOST: 'db.local', HOMEPAGE_URL: 'https://example.com/a:b' };
    const env = agentEnv({ ...innocue, ...engine, ...others }, { agentId: 'bruno', name: 'Bruno', cwd: tmpDir() });
    for (const k of [...Object.keys(engine), ...Object.keys(others)]) expect(env[k], k).toBeUndefined();
    for (const [k, v] of Object.entries(innocue)) expect(env[k], k).toBe(v);
    // anche i comandi git di Keystone nei repository (hook, filtri) girano senza segreti
    expect(Object.keys(withoutSecrets({ ...innocue, ...engine, ...others })).sort()).toEqual(Object.keys(innocue).sort());
    // alla CLI del motore arrivano solo le credenziali dei motori, non GITHUB_TOKEN, NPM_TOKEN, …
    expect(engineCredentials({ ...innocue, ...engine, ...others })).toEqual(engine);
  });
});
