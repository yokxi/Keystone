// Codex non è incluso in questa versione: l'orchestratore rifiuta di avviarlo, da riga di comando
// e da config.json. Solo KEYSTONE_ENABLE_CODEX=1 (prove di sviluppo) lo riaccende.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const run = (args: string[], env: NodeJS.ProcessEnv = {}) => {
  const e = { ...process.env, ...env };
  if (!('KEYSTONE_ENABLE_CODEX' in env)) delete e.KEYSTONE_ENABLE_CODEX;
  return spawnSync(process.execPath, ['--import', 'tsx', 'orchestrator/src/main.ts', ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60_000, env: e });
};

describe('motore Codex non incluso in questa versione', () => {
  it('--engine codex, --worker-engine codex e config.json con Codex: l\'avvio si ferma con il motivo', () => {
    for (const args of [['--engine', 'codex'], ['--worker-engine', 'codex']]) {
      const r = run(['--home', tmpDir(), ...args, '--show-config']);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr).toMatch(/Codex non è incluso in questa versione/);
    }
    const home = tmpDir();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ agents: { bruno: { engine: 'codex' } } }));
    expect(run(['--home', home, '--show-config']).stderr).toMatch(/Codex non è incluso/);
  });

  it('con KEYSTONE_ENABLE_CODEX=1 (solo prove) si può scegliere; Claude e sim restano normali', () => {
    expect(run(['--home', tmpDir(), '--engine', 'codex', '--show-config'], { KEYSTONE_ENABLE_CODEX: '1' }).status).toBe(0);
    expect(run(['--home', tmpDir(), '--engine', 'claude', '--show-config']).status).toBe(0);
  });
});
