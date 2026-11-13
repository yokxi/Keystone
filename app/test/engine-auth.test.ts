// Motore e credenziale scelti dall'app: mai in chiaro su disco, mai al renderer, e all'orchestratore
// solo la credenziale della scelta (le altre dell'ambiente dell'app vengono tolte). Dall'app non
// parte il motore sim.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkCredential, EngineAuth } from '../src/main/engine-auth.js';
import { orchestratorArgs } from '../src/main/orchestrator-launch.js';

const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(40);
const KEY = 'sk-ant-api03-' + 'b'.repeat(40);

/** cifratura finta ma reversibile, riconoscibile: il valore in chiaro non deve comparire su disco */
const cipher = (available = true) => ({
  available: () => available,
  encrypt: (s: string) => Buffer.from(`cifrato:${Buffer.from(s).toString('hex')}`),
  decrypt: (b: Buffer) => Buffer.from(b.toString().slice('cifrato:'.length), 'hex').toString(),
});

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-engine-auth-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('motore e credenziale dall\'app', () => {
  it('senza una scelta l\'orchestratore non parte (niente motore sim di ripiego)', () => {
    const a = new EngineAuth(path.join(tmp(), 'engine-credentials.json'), cipher());
    expect(a.launch({ PATH: '/bin' })).toMatchObject({ ok: false, error: expect.stringMatching(/scegli il motore/) });
    a.setChoice('claude-login');
    expect(a.launch({ PATH: '/bin' })).toMatchObject({ ok: false, error: expect.stringMatching(/manca il token/) });
  });

  it('abbonamento: solo il token, con --use-claude-login; le chiavi dell\'ambiente dell\'app vengono tolte', () => {
    const file = path.join(tmp(), 'engine-credentials.json');
    const a = new EngineAuth(file, cipher());
    a.setChoice('claude-login');
    expect(a.setCredential('claudeLoginToken', TOKEN)).toBe('salvata');
    expect(a.setCredential('anthropicApiKey', KEY)).toBe('salvata');
    const l = a.launch({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-dell-ambiente', anthropic_auth_token: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'vecchio' });
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    expect(l.args).toEqual(['--engine', 'claude', '--use-claude-login']);
    expect(l.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(l.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(l.env.anthropic_auth_token).toBeUndefined();
    expect(l.env.PATH).toBe('/bin');
  });

  it('chiave API: solo la chiave, senza --use-claude-login', () => {
    const a = new EngineAuth(path.join(tmp(), 'engine-credentials.json'), cipher());
    a.setChoice('claude-api');
    a.setCredential('anthropicApiKey', KEY);
    a.setCredential('claudeLoginToken', TOKEN);
    const l = a.launch({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'vecchio' });
    expect(l).toMatchObject({ ok: true, args: ['--engine', 'claude'] });
    if (!l.ok) return;
    expect(l.env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(l.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // gli argomenti arrivano alla riga di comando dell'orchestratore, senza segreti
    const args = orchestratorArgs({ main: 'main.mjs', bundled: true }, 7931, 'default', l.args);
    expect(args).toEqual(['main.mjs', '--port', '7931', '--profile', 'default', '--engine', 'claude']);
    expect(args.join(' ')).not.toContain('sk-ant');
  });

  it('su disco solo cifrata; lo stato per il renderer non contiene mai i valori', () => {
    const file = path.join(tmp(), 'engine-credentials.json');
    const a = new EngineAuth(file, cipher());
    a.setChoice('claude-login');
    a.setCredential('claudeLoginToken', TOKEN);
    const disk = fs.readFileSync(file, 'utf8');
    expect(disk).not.toContain(TOKEN);
    expect(disk).not.toContain('sk-ant');
    const st = a.status();
    expect(st).toEqual({ choice: 'claude-login', saved: { claudeLoginToken: true, anthropicApiKey: false }, encryption: true });
    expect(JSON.stringify(st)).not.toContain('sk-ant');
    // un'altra istanza (riavvio dell'app) la ritrova
    const b = new EngineAuth(file, cipher());
    const l = b.launch({});
    expect(l.ok && l.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    // tolta: sparisce dal file
    b.setCredential('claudeLoginToken', null);
    expect(b.status().saved.claudeLoginToken).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('cifrato');
  });

  it('senza cifratura del sistema: solo in memoria, mai su disco', () => {
    const file = path.join(tmp(), 'engine-credentials.json');
    const a = new EngineAuth(file, cipher(false));
    a.setChoice('claude-api');
    expect(a.setCredential('anthropicApiKey', KEY)).toBe('solo-memoria');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('sk-ant');
    expect(a.status()).toMatchObject({ saved: { anthropicApiKey: true }, encryption: false });
    expect(a.launch({})).toMatchObject({ ok: true });
    // un'altra istanza (app riavviata) non la trova
    expect(new EngineAuth(file, cipher(false)).launch({})).toMatchObject({ ok: false });
  });

  it('formato controllato, con errori che non ripetono il valore', () => {
    expect(checkCredential('claudeLoginToken', TOKEN)).toBeUndefined();
    expect(checkCredential('anthropicApiKey', KEY)).toBeUndefined();
    expect(checkCredential('anthropicApiKey', TOKEN)).toMatch(/token di login/);
    expect(checkCredential('claudeLoginToken', KEY)).toMatch(/chiave API/);
    expect(checkCredential('claudeLoginToken', 'corto')).toMatch(/non sembra valido/);
    expect(checkCredential('anthropicApiKey', `${KEY} altro`)).toMatch(/non sembra valido/);
    const a = new EngineAuth(path.join(tmp(), 'f.json'), cipher());
    expect(() => a.setCredential('anthropicApiKey', TOKEN)).toThrow(/token di login/);
    try {
      a.setCredential('claudeLoginToken', KEY);
    } catch (e) {
      expect((e as Error).message).not.toContain(KEY);
    }
  });

  it('un file che non è un file normale (link) viene ignorato', () => {
    const d = tmp();
    const real = path.join(d, 'altrove.json');
    fs.writeFileSync(real, JSON.stringify({ choice: 'claude-api', secrets: { anthropicApiKey: Buffer.from('cifrato:00').toString('base64') } }));
    const link = path.join(d, 'engine-credentials.json');
    try {
      fs.symlinkSync(real, link, 'file');
    } catch {
      return; // senza permesso di creare link (Windows senza modalità sviluppatore): niente da provare
    }
    expect(new EngineAuth(link, cipher()).status().choice).toBeUndefined();
  });
});
