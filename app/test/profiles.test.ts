// Il pulsante "Avvia orchestratore" usa il profilo dell'app o uno scelto tra quelli esistenti.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isValidProfileName, listProfiles, orchestratorArgs, resolveStartProfile } from '../src/main/profiles.js';
import { testOrchestrator, tmpDir } from '../../orchestrator/test/helpers.js';

function home(): string {
  const h = tmpDir();
  for (const p of ['default', 'demo']) {
    fs.mkdirSync(path.join(h, p), { recursive: true });
    fs.writeFileSync(path.join(h, p, 'state.json'), '{}');
  }
  // non sono profili: niente state.json, o nome non valido
  fs.mkdirSync(path.join(h, 'git'));
  fs.mkdirSync(path.join(h, 'demo-repo'));
  fs.mkdirSync(path.join(h, '.nascosto'));
  fs.writeFileSync(path.join(h, '.nascosto', 'state.json'), '{}');
  return h;
}

describe('profili dell\'app', () => {
  it('elenca solo le cartelle con uno stato', () => {
    expect(listProfiles(home())).toEqual(['default', 'demo']);
    expect(listProfiles(path.join(tmpDir(), 'manca'))).toEqual([]);
  });

  it('senza scelta usa il profilo dell\'app; una scelta va bene solo se il profilo esiste', () => {
    const h = home();
    expect(resolveStartProfile('demo', undefined, h)).toEqual({ ok: true, profile: 'demo' });
    expect(resolveStartProfile('default', '', h)).toEqual({ ok: true, profile: 'default' });
    expect(resolveStartProfile('default', 'demo', h)).toEqual({ ok: true, profile: 'demo' });
    // il profilo dell'app va bene anche se non ha ancora uno stato
    expect(resolveStartProfile('nuovo', 'nuovo', h)).toEqual({ ok: true, profile: 'nuovo' });
    expect(resolveStartProfile('default', 'altro', h)).toMatchObject({ ok: false });
    expect(resolveStartProfile('default', '../fuori', h)).toMatchObject({ ok: false });
    expect(resolveStartProfile('default', 42, h)).toMatchObject({ ok: false });
  });

  it('i nomi non possono essere percorsi', () => {
    for (const bad of ['', '..', 'a/b', 'a\\b', '-x', '.x', 'C:', 'x'.repeat(41)]) expect(isValidProfileName(bad)).toBe(false);
    for (const ok of ['default', 'demo', 'prova_2', 'A-1']) expect(isValidProfileName(ok)).toBe(true);
  });

  it('l\'orchestratore avviato dall\'app riceve porta e profilo scelti', () => {
    expect(orchestratorArgs('main.ts', 7931, 'demo')).toEqual(['--import', 'tsx', 'main.ts', '--port', '7931', '--profile', 'demo']);
  });

  it('l\'orchestratore dichiara il suo profilo, così l\'app può accorgersi di un profilo diverso', () => {
    const { o } = testOrchestrator();
    expect(o.status.profile).toBe('test');
  });
});
