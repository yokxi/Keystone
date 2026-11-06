import type { DiffHunk } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import { isTrustedSender, validateCommand } from '../src/main/ipc-validate.js';
import { completeAgent, parseConsole } from '../src/renderer/lib/console.js';
import { collapseContext, diffLogLines } from '../src/renderer/lib/diff-view.js';
import { goalLimitsText, spendLabel } from '../src/renderer/lib/format.js';

const agents = [
  { id: 'ada', name: 'Ada' },
  { id: 'bruno', name: 'Bruno' },
  { id: 'chiara', name: 'Chiara' },
];

describe('console', () => {
  it('testo libero = obiettivo; @agente = messaggio', () => {
    expect(parseConsole('Aggiungi il login con OAuth', agents)).toMatchObject({ kind: 'send', cmd: { type: 'goal.submit', text: 'Aggiungi il login con OAuth' } });
    expect(parseConsole('@bruno ricordati dei test', agents)).toMatchObject({ kind: 'send', cmd: { type: 'user.message', to: 'bruno', text: 'ricordati dei test' } });
    expect(parseConsole('@Chiara ok', agents)).toMatchObject({ cmd: { to: 'chiara' } });
    expect(parseConsole('@all fermatevi un attimo', agents)).toMatchObject({ cmd: { type: 'user.message', to: 'all' } });
    expect(parseConsole('@nessuno ciao', agents)).toMatchObject({ kind: 'error' });
    expect(parseConsole('@bruno', agents)).toMatchObject({ kind: 'error' });
    expect(parseConsole('   ', agents)).toEqual({ kind: 'none' });
  });

  it('comandi per agenti, task e decisioni', () => {
    expect(parseConsole('/pausa @bruno', agents)).toMatchObject({ cmd: { type: 'agent.action', agentId: 'bruno', action: 'pause' } });
    expect(parseConsole('/ferma chiara', agents)).toMatchObject({ cmd: { type: 'agent.action', agentId: 'chiara', action: 'stop' } });
    expect(parseConsole('/task t3 riprova', agents)).toMatchObject({ cmd: { type: 'task.action', taskId: 't3', action: 'retry' } });
    expect(parseConsole('/task T3 priorita 5', agents)).toMatchObject({ cmd: { type: 'task.action', taskId: 't3', action: 'prioritize', arg: '5' } });
    expect(parseConsole('/task t3 priorita alta', agents)).toMatchObject({ kind: 'error' });
    expect(parseConsole('/task t3 assegna @chiara', agents)).toMatchObject({ cmd: { action: 'reassign', arg: 'chiara' } });
    expect(parseConsole('/rispondi d4 2 con i test', agents)).toMatchObject({ cmd: { type: 'decision.answer', decisionId: 'd4', option: '2', text: 'con i test' } });
    expect(parseConsole('/rispondi d4 usa JSON', agents)).toMatchObject({ cmd: { type: 'decision.answer', decisionId: 'd4', text: 'usa JSON' } });
    expect(parseConsole('/pulisci', agents)).toMatchObject({ cmd: { type: 'worktrees.prune' } });
    expect(parseConsole('/repo C:\\progetti\\app', agents)).toEqual({ kind: 'ui', action: 'register-repo', arg: 'C:\\progetti\\app' });
    expect(parseConsole('/boh', agents)).toMatchObject({ kind: 'error' });
  });

  it('ogni comando prodotto dalla console supera la validazione IPC', () => {
    for (const input of ['obiettivo', '@bruno ciao', '/pausa @ada', '/task t1 annulla', '/rispondi d1 1', '/pulisci']) {
      const r = parseConsole(input, agents);
      if (r.kind !== 'send') throw new Error(input);
      expect(validateCommand(r.cmd).ok, input).toBe(true);
    }
  });

  it('Tab completa il nome dopo @', () => {
    expect(completeAgent('@br', 3, agents)).toMatchObject({ value: '@Bruno ', caret: 7 });
    expect(completeAgent('ciao @c', 7, agents)?.options).toEqual(['Chiara']);
    expect(completeAgent('@', 1, agents)?.options).toEqual(['all', 'Ada', 'Bruno', 'Chiara']);
    expect(completeAgent('nessuna chiocciola', 5, agents)).toBeUndefined();
  });
});

describe('diff', () => {
  it('comprime le lunghe sequenze di contesto, tenendo 3 righe attorno alle modifiche', () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ kind: 'ctx' as const, text: `r${i}`, oldNo: i + 1, newNo: i + 1 }));
    lines[10] = { kind: 'add', text: 'nuova', newNo: 11 } as never;
    const hunk: DiffHunk = { header: '@@', oldStart: 1, newStart: 1, lines };
    const rows = collapseContext(hunk, 3, 'h');
    expect(rows[0]).toEqual({ type: 'fold', count: 7, id: 'h:7' });
    expect(rows.filter((r) => r.type === 'line')).toHaveLength(7);
    expect(rows.at(-1)).toMatchObject({ type: 'fold', count: 6 });
  });

  it('una piega di una sola riga viene mostrata per intero', () => {
    const hunk: DiffHunk = {
      header: '@@',
      oldStart: 1,
      newStart: 1,
      lines: [{ kind: 'ctx', text: 'a', oldNo: 1, newNo: 1 }, { kind: 'ctx', text: 'b', oldNo: 2, newNo: 2 }, { kind: 'del', text: 'c', oldNo: 3 }, ...['d', 'e', 'f', 'g'].map((t, i) => ({ kind: 'ctx' as const, text: t, oldNo: 4 + i, newNo: 3 + i }))],
    };
    expect(collapseContext(hunk, 3).every((r) => r.type === 'line')).toBe(true);
  });

  it('colora le righe di un diff nel log', () => {
    expect(diffLogLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-vecchia\n+nuova\n uguale').map((l) => l.cls)).toEqual(['meta', 'meta', 'hunk', 'del', 'add', 'ctx']);
  });
});

describe('validazione IPC nel processo main', () => {
  it('accetta solo comandi ammessi e conformi allo schema', () => {
    expect(validateCommand({ type: 'goal.submit', text: 'x' })).toEqual({ ok: true, msg: { type: 'goal.submit', text: 'x' } });
    expect(validateCommand({ type: 'repo.add', path: 'C:\\r', confirmGuard: true })).toMatchObject({ ok: true });
    expect(validateCommand({ type: 'settings.set', userName: 'Aurora' })).toMatchObject({ ok: true });
    expect(validateCommand({ type: 'settings.set', userName: null })).toMatchObject({ ok: true });
    expect(validateCommand({ type: 'settings.set', userName: 42 })).toMatchObject({ ok: false });
    expect(validateCommand({ type: 'repo.config', repoId: 'r1', mergeTarget: 'sviluppo' })).toMatchObject({ ok: true });
    expect(validateCommand({ type: 'repo.config', repoId: 'r1', mergeTarget: null })).toMatchObject({ ok: true });
    // mergeTarget è facoltativo: basta la verifica visuale (o null per disattivarla)
    expect(validateCommand({ type: 'repo.config', repoId: 'r1', visual: { command: 'npm run dev', url: 'http://localhost:5173', startTimeoutSec: 60 } })).toEqual({
      ok: true,
      msg: { type: 'repo.config', repoId: 'r1', visual: { command: 'npm run dev', url: 'http://localhost:5173', startTimeoutSec: 60 } },
    });
    expect(validateCommand({ type: 'repo.config', repoId: 'r1', visual: null })).toMatchObject({ ok: true });
    expect(validateCommand({ type: 'repo.config', repoId: 'r1', visual: { command: 'x', url: 'http://localhost', startTimeoutSec: 1 } })).toMatchObject({ ok: false });
    // senza nessun campo da cambiare: rifiutato
    expect(validateCommand({ type: 'repo.config', repoId: 'r1' })).toMatchObject({ ok: false });
    // le schermate passano da un canale dedicato del main, non dal renderer
    expect(validateCommand({ type: 'visual.shot.request', requestId: 'q', taskId: 't1', shotId: 'after-1' })).toMatchObject({ ok: false });
    // skill: id e posto validati; un percorso non può arrivare dal renderer
    const draft = { name: 'Regola', appliesTo: 'worker', when: ['lavoro'], files: [], enabled: true, body: 'testo' };
    expect(validateCommand({ type: 'skill.save', source: 'personal', skillId: 'regola', create: true, draft })).toMatchObject({ ok: true });
    expect(validateCommand({ type: 'skill.save', source: 'repo', repoId: 'r1', skillId: 'regola', create: false, draft })).toMatchObject({ ok: true });
    expect(validateCommand({ type: 'skill.save', source: 'repo', skillId: 'regola', create: true, draft })).toMatchObject({ ok: false });
    expect(validateCommand({ type: 'skill.save', source: 'personal', repoId: 'r1', skillId: 'regola', create: true, draft })).toMatchObject({ ok: false });
    for (const skillId of ['../config', '..', 'a/b', 'A', 'a\\b', '']) expect(validateCommand({ type: 'skill.delete', source: 'personal', skillId }), skillId).toMatchObject({ ok: false });
    expect(validateCommand({ type: 'skill.save', source: 'personal', skillId: 'x', create: true, draft: { ...draft, name: 'a\nb' } })).toMatchObject({ ok: false });
    expect(validateCommand({ type: 'skill.toggle', source: 'personal', skillId: 'regola', enabled: null })).toMatchObject({ ok: true });
    expect(validateCommand({ type: 'skills.refresh' })).toMatchObject({ ok: true });
    // conferma di una skill personale: solo id e impronta, niente percorsi né contenuti
    expect(validateCommand({ type: 'skill.confirm', skillId: 'regola', hash: 'a'.repeat(64) })).toMatchObject({ ok: true });
    for (const hash of ['', 'a'.repeat(63), 'G'.repeat(64), '../'.repeat(22)]) expect(validateCommand({ type: 'skill.confirm', skillId: 'regola', hash }), hash).toMatchObject({ ok: false });
    expect(validateCommand({ type: 'skill.confirm', skillId: '../x', hash: 'a'.repeat(64) })).toMatchObject({ ok: false });
    expect(validateCommand({ type: 'hello', client: 'x', protocol: 1 })).toMatchObject({ ok: false });
    expect(validateCommand({ type: 'snapshot' })).toMatchObject({ ok: false });
    expect(validateCommand({ type: 'task.action', taskId: 't1', action: 'rm -rf' })).toMatchObject({ ok: false });
    expect(validateCommand({ type: 'goal.submit', text: '' })).toMatchObject({ ok: false });
    expect(validateCommand(null)).toMatchObject({ ok: false });
    expect(validateCommand('goal.submit')).toMatchObject({ ok: false });
    expect(validateCommand([1, 2])).toMatchObject({ ok: false });
  });

  it('versione e id inviati dal renderer vengono ignorati', () => {
    expect(validateCommand({ type: 'worktrees.prune', v: 99, id: 'finto' })).toEqual({ ok: true, msg: { type: 'worktrees.prune' } });
  });

  it('accetta IPC solo dalla pagina locale dell\'app', () => {
    const app = 'file:///C:/Keystone/app/dist/renderer/index.html';
    expect(isTrustedSender('file:///C:/Keystone/app/dist/renderer/index.html?smoke=1', app)).toBe(true);
    expect(isTrustedSender('https://evil.example/index.html', app)).toBe(false);
    expect(isTrustedSender('file:///C:/altro/index.html', app)).toBe(false);
    expect(isTrustedSender(undefined, app)).toBe(false);
  });
});

describe('spesa', () => {
  it('con l\'abbonamento la spesa è una stima, a consumo è un costo', () => {
    expect(spendLabel('subscription')).toMatchObject({ word: 'stima', suffix: ' · abbonamento' });
    expect(spendLabel('api')).toMatchObject({ word: 'costo', suffix: '' });
    expect(spendLabel(undefined)).toMatchObject({ word: 'costo', suffix: '' });
    expect(spendLabel('api', true)).toMatchObject({ word: 'costo', suffix: ' · Codex: solo token' });
    expect(spendLabel('estimate')).toMatchObject({ word: 'stima', suffix: ' · Codex: token × prezzi indicati' });
  });

  it("limiti di turni e di tempo dell'obiettivo", () => {
    expect(goalLimitsText({})).toBe('');
    expect(goalLimitsText({ turnLimit: 30, turnsUsed: 3, minuteLimit: 60, activeMs: 125_000 })).toBe(' · turni 3/30 · 2/60 min');
  });
});
