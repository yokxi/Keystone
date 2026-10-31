import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEED_LIMIT, LOG_TAIL, Store } from '../src/core/store.js';
import { tmpDir } from './helpers.js';

describe('Store', () => {
  it('parte vuoto e salva lo stato su disco in modo atomico', () => {
    const dir = tmpDir();
    const s = new Store(dir, { debounceMs: 1 });
    expect(s.data.tasks).toEqual([]);
    expect(s.nextId('t')).toBe('t1');
    expect(s.nextId('t')).toBe('t2');
    s.flush();
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    expect(raw.counters.t).toBe(2);
    // nessun file temporaneo lasciato in giro
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('sopravvive a un riavvio: lo stato viene ricaricato', () => {
    const dir = tmpDir();
    const a = new Store(dir);
    a.data.goals.push({ id: 'g1', text: 'obiettivo', status: 'active', progress: 0.5, createdAt: 1 });
    a.markDirty();
    a.close();
    const b = new Store(dir);
    expect(b.data.goals[0]?.text).toBe('obiettivo');
    expect(b.data.team.inflight).toEqual({});
  });

  it('scrive con debounce e flush() scrive subito', async () => {
    const dir = tmpDir();
    const s = new Store(dir, { debounceMs: 30 });
    s.nextId('x');
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(true);
    s.nextId('x');
    s.flush();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).counters.x).toBe(2);
  });

  it('se state.json è corrotto usa il backup e conserva il file rotto', () => {
    const dir = tmpDir();
    const a = new Store(dir);
    a.nextId('t');
    a.flush();
    a.nextId('t');
    a.flush(); // ora state.json.bak contiene t=1, state.json t=2
    a.close();
    fs.writeFileSync(path.join(dir, 'state.json'), '{"version":1, troncato');
    const warnings: string[] = [];
    const b = new Store(dir, { onWarn: (m) => warnings.push(m) });
    expect(b.data.counters.t).toBe(1);
    expect(warnings.join('\n')).toMatch(/ripristinato/);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
  });

  it('se anche il backup manca riparte da uno stato vuoto senza perdere il file rotto', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'state.json'), 'non json');
    const s = new Store(dir, { onWarn: () => undefined });
    expect(s.data.version).toBe(1);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
  });

  it('limita il feed', () => {
    const s = new Store(tmpDir());
    for (let i = 0; i < FEED_LIMIT + 20; i++) s.pushFeed({ ts: i, kind: 'system', text: String(i) });
    expect(s.data.feed).toHaveLength(FEED_LIMIT);
    expect(s.data.feed[0]?.text).toBe('20');
  });

  it('la prima riga di log di un agente compare una volta sola nella coda', () => {
    const s = new Store(tmpDir());
    s.appendLog('bruno', [{ ts: 1, kind: 'text', text: 'prima' }]);
    s.appendLog('bruno', [{ ts: 2, kind: 'text', text: 'seconda' }]);
    expect(s.logTail('bruno').map((e) => e.text)).toEqual(['prima', 'seconda']);
  });

  it('salva i log in JSONL e ne ricostruisce la coda dopo un riavvio, saltando righe troncate', () => {
    const dir = tmpDir();
    const a = new Store(dir);
    for (let i = 0; i < LOG_TAIL + 10; i++) a.appendLog('bruno', [{ ts: i, kind: 'text', text: `riga ${i}` }]);
    expect(a.logTail('bruno')).toHaveLength(LOG_TAIL);
    a.close();
    fs.appendFileSync(path.join(dir, 'logs', 'bruno.jsonl'), '{"ts":999,"kind":"te');
    const b = new Store(dir);
    const tail = b.logTail('bruno');
    expect(tail).toHaveLength(LOG_TAIL);
    expect(tail[tail.length - 1]?.text).toBe(`riga ${LOG_TAIL + 9}`);
  });
});
