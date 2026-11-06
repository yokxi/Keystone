// Pacchetto dell'app (Fase 8): dove l'app cerca l'orchestratore, come lo avvia, come spiega un
// avvio fallito, e le fuse di Electron.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { earlyExit, findOrchestrator, openStartLog, orchestratorArgs, START_LOG_MAX_BYTES, startLogFile, tailLines } from '../src/main/orchestrator-launch.js';
import { flipFuses } from '../scripts/fuses.mjs';
import { tmpDir } from '../../orchestrator/test/helpers.js';

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';

describe('app impacchettata: orchestratore', () => {
  it('impacchettata: solo il bundle in resources/orchestrator, mai i sorgenti', () => {
    const res = tmpDir();
    expect(findOrchestrator({ packaged: true, resourcesPath: res, appDistDir: path.join(res, 'app', 'dist', 'main') })).toBeUndefined();
    fs.mkdirSync(path.join(res, 'orchestrator'));
    fs.writeFileSync(path.join(res, 'orchestrator', 'main.mjs'), '');
    const e = findOrchestrator({ packaged: true, resourcesPath: res, appDistDir: '' })!;
    expect(e).toEqual({ cwd: path.join(res, 'orchestrator'), main: path.join(res, 'orchestrator', 'main.mjs'), bundled: true });
    expect(orchestratorArgs(e, 7931, 'demo')).toEqual([e.main, '--port', '7931', '--profile', 'demo']);
  });

  it('in sviluppo: i sorgenti con tsx (questo repository)', () => {
    const e = findOrchestrator({ packaged: false, resourcesPath: '', appDistDir: path.resolve(__dirname, '..', 'dist', 'main') })!;
    expect(e.bundled).toBe(false);
    expect(e.main.endsWith(path.join('orchestrator', 'src', 'main.ts'))).toBe(true);
    expect(orchestratorArgs(e, 1, 'p').slice(0, 2)).toEqual(['--import', 'tsx']);
  });

  it('un avvio fallito si vede: codice d\'uscita e ultime righe del log', async () => {
    const home = tmpDir();
    const log = startLogFile(home, 'demo');
    expect(log).toBe(path.join(home, 'demo', 'orchestrator-avvio.log'));
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const fd = fs.openSync(log, 'w');
    const child = spawn(process.execPath, ['-e', 'console.error("\\u001b[31mKeystone: config.json non valido\\u001b[0m"); process.exit(3)'], { stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    expect(await earlyExit(child, 10_000)).toEqual({ code: 3 });
    expect(tailLines(log)).toBe('Keystone: config.json non valido');
    // un processo che resta vivo: nessun errore
    const alive = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    expect(await earlyExit(alive, 300)).toBeUndefined();
    alive.kill();
    expect(tailLines(path.join(home, 'manca.log'))).toBe('');
  });

  it("un'uscita con codice 0 nei primi secondi è un avvio fallito; un eseguibile mancante pure", async () => {
    const zero = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    expect(await earlyExit(zero, 10_000)).toEqual({ code: 0 });
    const missing = spawn(path.join(tmpDir(), 'non-esiste.exe'), [], { stdio: 'ignore' });
    const r = await earlyExit(missing, 10_000);
    expect(r?.error).toMatch(/ENOENT/);
  });

  it('il log d\'avvio si aggiunge in coda con un\'intestazione e ricomincia oltre il limite', () => {
    const file = path.join(tmpDir(), 'p', 'orchestrator-avvio.log');
    fs.closeSync(openStartLog(file, new Date('2026-11-06T10:00:00Z')));
    fs.appendFileSync(file, 'riga del primo avvio\n');
    fs.closeSync(openStartLog(file, new Date('2026-11-06T11:00:00Z')));
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('riga del primo avvio');
    expect(text).toContain('avvio dall\'app: 2026-11-06T11:00:00.000Z');
    fs.appendFileSync(file, 'x'.repeat(START_LOG_MAX_BYTES + 1));
    fs.closeSync(openStartLog(file, new Date('2026-11-06T12:00:00Z')));
    expect(fs.statSync(file).size).toBeLessThan(200);
    expect(fs.existsSync(`${file}.1`)).toBe(true);
  });
});

describe('app impacchettata: fuse di Electron', () => {
  function fakeExe(fuses: string): string {
    const file = path.join(tmpDir(), 'electron.exe');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('MZ...prima...'), Buffer.from(SENTINEL), Buffer.from([1, fuses.length]), Buffer.from(fuses), Buffer.from('...dopo')]));
    return file;
  }
  const read = (file: string) => {
    const b = fs.readFileSync(file);
    const at = b.indexOf(SENTINEL) + SENTINEL.length;
    return b.subarray(at + 2, at + 2 + b[at + 1]!).toString('ascii');
  };

  it('spegne NODE_OPTIONS e --inspect, accende i cookie cifrati, lascia RunAsNode e il resto', () => {
    const exe = fakeExe('10110001r1');
    flipFuses(exe, () => undefined);
    expect(read(exe)).toBe('11000001r1');
    expect(fs.readFileSync(exe).subarray(0, 13).toString()).toBe('MZ...prima...');
  });

  it('formato inatteso: non scrive nulla', () => {
    for (const f of ['00110001', '1011']) {
      const exe = fakeExe(f);
      const before = fs.readFileSync(exe);
      expect(() => flipFuses(exe, () => undefined)).toThrow(/fuse di Electron/);
      expect(fs.readFileSync(exe).equals(before)).toBe(true);
    }
    const none = path.join(tmpDir(), 'x.exe');
    fs.writeFileSync(none, 'niente');
    expect(() => flipFuses(none, () => undefined)).toThrow(/sentinella/);
  });
});
