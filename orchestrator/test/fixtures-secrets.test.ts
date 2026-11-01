// Le trascrizioni registrate finiscono nel repository: nessuna può contenere chiavi, token,
// intestazioni di autenticazione, variabili d'ambiente di credenziali, percorsi della home o il
// nome utente.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findLeaks, sanitizeLocal } from './transcript-secrets.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude');

describe('trascrizioni registrate', () => {
  // anche le sottocartelle (le trascrizioni vere stanno in fixtures/claude/real)
  const files = (fs.readdirSync(FIXTURES, { recursive: true }) as string[]).filter((f) => f.endsWith('.jsonl'));

  it('ci sono trascrizioni da controllare', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f}: niente segreti né dati locali`, () => {
      const text = fs.readFileSync(path.join(FIXTURES, f), 'utf8');
      expect(findLeaks(text)).toEqual([]);
      // il nome utente di chi esegue i test non compare (anche se le trascrizioni vengono da un'altra macchina)
      const user = os.userInfo().username;
      if (user.length >= 3) expect(new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)).toBe(false);
    });
  }

  it('il controllo riconosce davvero chiavi e intestazioni (controprova)', () => {
    const fake = ['sk-ant-api03-', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'].join('');
    for (const leak of [
      `{"t":"msg","msg":{"text":"${fake}"}}`,
      '{"headers":{"Authorization": "x"}}',
      '{"headers":{"x-api-key":"x"}}',
      'curl -H "Bearer abcdefghijklmnopqrstuvwxyz"',
      '{"env":{"ANTHROPIC_API_KEY":"..."}}',
      'USERPROFILE=C:\\Users\\qualcuno',
      '{"cwd":"C:\\\\Users\\\\qualcuno\\\\repo"}',
      '{"cwd":"/home/qualcuno/repo"}',
    ]) {
      expect(findLeaks(leak).length, leak).toBeGreaterThan(0);
    }
    expect(findLeaks('{"cwd":"<HOME>\\\\.keystone\\\\demo-repo","by":"<USER>"}')).toEqual([]);
  });

  it('la pulizia sostituisce la home in tutte le forme e il nome utente', () => {
    const home = 'C:\\Users\\mario';
    const raw = ['C:\\Users\\mario\\repo', 'C:\\\\Users\\\\mario\\\\repo', 'C:/Users/mario/repo', '/c/Users/mario/repo', 'c:\\Users\\mario\\x', 'autore Mario'].join('\n');
    const out = sanitizeLocal(raw, home, 'mario');
    expect(out).toBe(['<HOME>\\repo', '<HOME>\\\\repo', '<HOME>/repo', '<HOME>/repo', '<HOME>\\x', 'autore <USER>'].join('\n'));
    expect(findLeaks(out)).toEqual([]);
  });
});
