// Installatore NSIS (app/scripts/installer.mjs): l'elenco del disinstallatore toglie solo i file
// del pacchetto, mai cartelle intere; i percorsi sono protetti per NSIS; makensis si trova senza
// installazioni globali.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findMakensis, instPath, nsisEscape, uninstallList } from '../scripts/installer.mjs';
import { tmpDir } from '../../orchestrator/test/helpers.js';

describe('installatore: disinstallazione', () => {
  it('un Delete per file e un RMDir non ricorsivo per cartella, dalla più profonda', () => {
    const src = tmpDir();
    fs.mkdirSync(path.join(src, 'resources', 'app', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(src, 'Keystone.exe'), '');
    fs.writeFileSync(path.join(src, 'resources', 'app', 'dist', 'main.cjs'), '');
    const lines = uninstallList(src).trim().split('\r\n');
    expect(lines).toEqual([
      'Delete "$INSTDIR\\Keystone.exe"',
      'Delete "$INSTDIR\\resources\\app\\dist\\main.cjs"',
      'RMDir "$INSTDIR\\resources\\app\\dist"',
      'RMDir "$INSTDIR\\resources\\app"',
      'RMDir "$INSTDIR\\resources"',
    ]);
    // mai una cancellazione ricorsiva: una cartella con file tuoi resta
    expect(lines.some((l) => /RMDir \/r|\/REBOOTOK|\*/.test(l))).toBe(false);
  });

  it('$ e virgolette nei nomi non diventano variabili o comandi NSIS', () => {
    expect(nsisEscape('a$PLUGINSDIR.txt')).toBe('a$$PLUGINSDIR.txt');
    expect(nsisEscape('x"y')).toBe('x$\\"y');
    expect(() => nsisEscape('a\nDelete x')).toThrow(/a capo/);
    // $INSTDIR resta la variabile: solo la parte relativa è protetta
    expect(instPath('$x\\b')).toBe('"$INSTDIR\\$$x\\b"');
    const src = tmpDir();
    fs.writeFileSync(path.join(src, 'prezzo$1.txt'), '');
    expect(uninstallList(src)).toContain('Delete "$INSTDIR\\prezzo$$1.txt"');
  });
});

describe('installatore: makensis', () => {
  const sep = path.delimiter;
  it('MAKENSIS ha la precedenza; poi PATH, %USERPROFILE%\\strumenti (la versione più recente), Program Files', () => {
    const have = new Set<string>();
    const exists = (p: string) => have.has(p);
    const exe = process.platform === 'win32' ? 'makensis.exe' : 'makensis';
    const tools = path.join('U', 'strumenti');
    const list = (d: string) => (d === tools ? ['nsis-3.9', 'nsis-3.13', 'altro'] : []);
    const env = { USERPROFILE: 'U', PATH: `A${sep}B`, ProgramFiles: 'PF' } as NodeJS.ProcessEnv;
    expect(findMakensis(env, exists, list)).toBeUndefined();
    have.add(path.join('PF', 'NSIS', exe));
    expect(findMakensis(env, exists, list)).toBe(path.join('PF', 'NSIS', exe));
    have.add(path.join(tools, 'nsis-3.9', exe));
    have.add(path.join(tools, 'nsis-3.13', exe));
    expect(findMakensis(env, exists, list)).toBe(path.join(tools, 'nsis-3.13', exe));
    have.add(path.join('B', exe));
    expect(findMakensis(env, exists, list)).toBe(path.join('B', exe));
    have.add('X');
    expect(findMakensis({ ...env, MAKENSIS: 'X' }, exists, list)).toBe('X');
    // un MAKENSIS sbagliato non ricade in silenzio su un altro makensis
    expect(findMakensis({ ...env, MAKENSIS: 'nessuno' }, exists, list)).toBeUndefined();
  });
});
