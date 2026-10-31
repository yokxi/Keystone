import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatInbox, MessageBus } from '../src/core/bus.js';
import { Memory } from '../src/core/memory.js';
import { testCtx, tmpDir } from './helpers.js';

describe('MessageBus', () => {
  it('consegna i messaggi diretti e a tutti, una sola volta', () => {
    const ctx = testCtx();
    const bus = new MessageBus(ctx);
    bus.send('ada', 'bruno', 'parti da t1');
    bus.send('user', 'all', 'ricordate i test');
    bus.send('bruno', 'all', 'ok');
    const inbox = bus.inbox('bruno', { markRead: true });
    expect(inbox.map((m) => m.text)).toEqual(['parti da t1', 'ricordate i test']);
    expect(bus.inbox('bruno')).toEqual([]);
    expect(bus.inbox('chiara').map((m) => m.text)).toEqual(['ricordate i test', 'ok']);
    expect(ctx.events.some((e) => e.type === 'agent.say' && e.agentId === 'ada')).toBe(true);
    expect(ctx.events.filter((e) => e.type === 'feed.add')).toHaveLength(3);
  });

  it('formatta l\'inbox per i prompt', () => {
    const ctx = testCtx();
    const bus = new MessageBus(ctx);
    bus.send('user', 'bruno', 'ciao');
    const text = formatInbox(bus.inbox('bruno'), (id) => id.toUpperCase(), 'Aurora');
    expect(text).toBe('- da Aurora (utente): ciao');
  });
});

describe('Memory', () => {
  it('scrive note condivise e private su disco, con intestazione, e le rilegge dopo un riavvio', () => {
    const dir = tmpDir();
    const ctx = testCtx();
    const m = new Memory(ctx, dir);
    m.write({ scope: 'shared', title: 'Piano', body: '- t1\n- t2', author: 'ada' });
    m.write({ scope: 'bruno', title: 'Appunti', body: 'privato' });
    expect(fs.readFileSync(path.join(dir, 'shared', 'piano.md'), 'utf8')).toMatch(/^---\ntitle: Piano\nauthor: ada\n/);
    const again = new Memory(ctx, dir);
    expect(again.get('shared/piano')?.body).toBe('- t1\n- t2');
    expect(again.visibleTo('bruno').map((e) => e.id)).toEqual(['bruno/appunti', 'shared/piano']);
    expect(again.visibleTo('chiara').map((e) => e.id)).toEqual(['shared/piano']);
  });

  it('append aggiunge in coda; search filtra per parole', () => {
    const m = new Memory(testCtx(), tmpDir());
    m.write({ scope: 'shared', title: 'Convenzioni', body: 'usa vitest' });
    m.write({ scope: 'shared', title: 'Convenzioni', body: 'niente default export', mode: 'append' });
    expect(m.get('shared/convenzioni')?.body).toBe('usa vitest\n\nniente default export');
    expect(m.search('VITEST', 'bruno')).toHaveLength(1);
    expect(m.search('jest mocha', 'bruno')).toHaveLength(0);
  });

  it('legge anche i file aggiunti a mano, senza intestazione', () => {
    const dir = tmpDir();
    const m = new Memory(testCtx(), dir);
    fs.writeFileSync(path.join(dir, 'shared', 'regole.md'), '# Regole del repo\n\nTab da 2 spazi.\n');
    m.reload();
    expect(m.get('shared/regole')).toMatchObject({ title: 'Regole del repo', body: '# Regole del repo\n\nTab da 2 spazi.' });
  });

  it('rifiuta scope che potrebbero uscire dalla cartella della memoria', () => {
    const m = new Memory(testCtx(), tmpDir());
    expect(() => m.write({ scope: '../fuori', title: 'x', body: 'y' })).toThrow(/scope non valido/);
  });
});
