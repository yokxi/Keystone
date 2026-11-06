import { describe, expect, it } from 'vitest';
import { matchesGlob, parseSkillFile, pathsInText, reviewRisks, serializeSkill, skillApplies, skillIdFromName, type DiffFile, type SkillDraft, type Task } from '../src/index.js';

const draft: SkillDraft = { name: 'Messaggi di commit', description: 'come scriverli', appliesTo: 'worker', when: ['lavoro'], files: ['src/**', '*.sql'], enabled: true, body: 'Scrivi i messaggi in italiano.\n\n- breve\n- chiaro' };

describe('file di skill', () => {
  it('serializeSkill e parseSkillFile sono l\'uno l\'inverso dell\'altro (anche con CRLF e BOM)', () => {
    const text = serializeSkill(draft);
    expect(parseSkillFile(text)).toEqual({ ok: true, draft });
    expect(parseSkillFile(`﻿${text.replace(/\n/g, '\r\n')}`)).toEqual({ ok: true, draft });
  });

  it('valori predefiniti: per tutti, sempre, attiva', () => {
    const r = parseSkillFile('---\nnome: Base\n---\nTesto');
    expect(r).toEqual({ ok: true, draft: { name: 'Base', appliesTo: 'tutti', when: ['sempre'], files: [], enabled: true, body: 'Testo' } });
  });

  it.each([
    ['senza intestazione', 'Testo', "manca l'intestazione"],
    ['chiave sconosciuta', '---\nnome: A\nmodello: opus\n---\nT', 'chiave sconosciuta'],
    ['chiave ripetuta', '---\nnome: A\nnome: B\n---\nT', 'chiave ripetuta'],
    ['senza nome', '---\nper: lead\n---\nT', 'manca il nome'],
    ['ruolo sconosciuto', '---\nnome: A\nper: tutti-i-motori\n---\nT', 'per:'],
    ['fase sconosciuta', '---\nnome: A\nquando: sempre, dopo\n---\nT', 'quando:'],
    ['attiva non valida', '---\nnome: A\nattiva: forse\n---\nT', '"attiva" vale sì o no'],
    ['testo vuoto', '---\nnome: A\n---\n   \n', 'testo: vuoto'],
    ['testo troppo lungo', `---\nnome: A\n---\n${'x'.repeat(8001)}`, 'testo:'],
  ])('rifiuta: %s', (_n, text, error) => {
    const r = parseSkillFile(text);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toContain(error);
  });

  it('attiva: no', () => {
    const r = parseSkillFile('---\nnome: A\nattiva: no\n---\nT');
    expect(r.ok && r.draft.enabled).toBe(false);
  });

  it('id dal nome: minuscole, senza accenti, liberi', () => {
    expect(skillIdFromName('Perché è così: regole!')).toBe('perche-e-cosi-regole');
    expect(skillIdFromName('A', new Set(['a', 'a-2']))).toBe('a-3');
    expect(skillIdFromName('???')).toBe('skill');
  });
});

describe('a chi e quando si applica una skill', () => {
  it('schemi di file: ** tra le cartelle, * nel nome, senza / vale per il nome in qualsiasi cartella', () => {
    expect(matchesGlob(['src/**'], 'src/a/b.ts')).toBe(true);
    expect(matchesGlob(['src/**'], 'lib/src/a.ts')).toBe(false);
    expect(matchesGlob(['src/*.ts'], 'src/a/b.ts')).toBe(false);
    expect(matchesGlob(['**/test/*.ts'], 'a/b/test/x.ts')).toBe(true);
    expect(matchesGlob(['**/test/*.ts'], 'test/x.ts')).toBe(true);
    expect(matchesGlob(['*.sql'], 'db/migrations/001.SQL')).toBe(true);
    expect(matchesGlob(['src/a?.ts'], 'src\\ab.ts')).toBe(true);
    expect(matchesGlob(['a.ts'], 'xa.ts')).toBe(false);
  });

  it('schemi costruiti apposta non bloccano: tempo polinomiale, non esponenziale', () => {
    const deep = `${'a/'.repeat(60)}b`;
    const evil = [`${'**/'.repeat(60)}x`, `${'*a'.repeat(90)}x`, `${'**/*a*/'.repeat(25)}x`];
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) expect(matchesGlob(evil, deep)).toBe(false);
    expect(matchesGlob([`${'*a'.repeat(90)}*`], 'a'.repeat(200))).toBe(true);
    expect(performance.now() - t0).toBeLessThan(2000);
    // ** ripetuti valgono come uno solo
    expect(matchesGlob(['**/**/b'], 'a/a/b')).toBe(true);
    expect(matchesGlob(['src/**/**'], 'src')).toBe(true);
  });

  it('percorsi citati nel testo', () => {
    expect(pathsInText('Correggi src/api/users.ts e il file schema.sql, poi i test.')).toEqual(['src/api/users.ts', 'schema.sql']);
  });

  it('ruolo, fase e file', () => {
    const ctx = { role: 'worker' as const, phase: 'lavoro' as const, files: [], text: '' };
    const base: SkillDraft = { ...draft, files: [] };
    expect(skillApplies(base, ctx)).toBe(true);
    expect(skillApplies(base, { ...ctx, role: 'lead', phase: 'review' })).toBe(false);
    expect(skillApplies({ ...base, appliesTo: 'tutti', when: ['sempre'] }, { ...ctx, role: 'lead', phase: 'piano' })).toBe(true);
    expect(skillApplies({ ...base, appliesTo: 'lead', when: ['review'] }, { ...ctx, role: 'lead', phase: 'piano' })).toBe(false);
    // con gli schemi: solo se il lavoro tocca i file, o la richiesta li cita
    const sql = { ...base, files: ['*.sql'] };
    expect(skillApplies(sql, ctx)).toBe(false);
    expect(skillApplies(sql, { ...ctx, files: ['db/001.sql'] })).toBe(true);
    expect(skillApplies(sql, { ...ctx, text: 'aggiungi una colonna in db/002.sql' })).toBe(true);
  });
});

describe('rischi nel riassunto della review', () => {
  const file = (p: string, over: Partial<DiffFile> = {}): DiffFile => ({ path: p, status: 'modified', binary: false, additions: 1, deletions: 0, hunks: [], ...over });
  const task = { id: 't1', title: 'x', status: 'review', deps: [], priority: 0, ci: 'pass', createdBy: 'ada', createdAt: 1, updatedAt: 1 } as Task;

  it('le modifiche alle skill del repository sono il rischio più grave', () => {
    const r = reviewRisks(task, [file('src/a.ts'), file('.keystone/skills/regole.md'), file('package.json')]);
    expect(r[0]).toMatchObject({ level: 'bad' });
    expect(r[0]!.text).toContain('.keystone/skills/regole.md');
    expect(r.map((x) => x.text).join('\n')).toContain('Cambia le dipendenze: package.json');
  });

  it('anche una skill rinominata fuori dalla cartella conta', () => {
    expect(reviewRisks(task, [file('docs/x.md', { status: 'renamed', oldPath: '.keystone/skills/x.md' })])[0]!.text).toContain('skill del repository');
  });

  it('test falliti, mancanti, file cancellati e binari', () => {
    expect(reviewRisks({ ...task, ci: 'fail' }, [])[0]).toEqual({ level: 'bad', text: 'I test eseguiti da Keystone sono falliti.' });
    expect(reviewRisks({ ...task, ci: 'unknown' }, []).map((x) => x.text)).toContain('Nessun test eseguito da Keystone (nessun comando di test riconosciuto).');
    const r = reviewRisks(task, [file('a.png', { binary: true }), file('old.ts', { status: 'deleted' })]).map((x) => x.text);
    expect(r.some((t) => t.startsWith('Cancella 1 file: old.ts'))).toBe(true);
    expect(r.some((t) => t.startsWith('File binari'))).toBe(true);
    expect(reviewRisks(task, [file('src/a.ts')])).toEqual([]);
  });
});
