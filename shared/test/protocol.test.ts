import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyServerMessage, CLIENT_MESSAGE_TYPES, emptyViewState, ENGINE_EVENT_TYPES, EngineEvent, parseClientMessage, parseServerMessage, SERVER_MESSAGE_TYPES } from '../src/index.js';

const DOC = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'docs', 'protocol.md'), 'utf8');

describe('docs/protocol.md è allineato agli schemi', () => {
  it.each([...SERVER_MESSAGE_TYPES, ...CLIENT_MESSAGE_TYPES])('il messaggio %s è documentato', (type) => {
    expect(DOC).toContain(`### \`${type}\``);
  });

  it.each(ENGINE_EVENT_TYPES)('l\'evento del motore %s è documentato', (type) => {
    expect(DOC).toContain(`### \`${type}\``);
  });
});

describe('parseClientMessage', () => {
  it('accetta messaggi validi', () => {
    const r = parseClientMessage(JSON.stringify({ v: 1, type: 'goal.submit', text: ' Aggiungi OAuth ', id: 'a1' }));
    expect(r).toEqual({ ok: true, msg: { v: 1, type: 'goal.submit', text: 'Aggiungi OAuth', id: 'a1' } });
  });

  it('rifiuta JSON non valido, tipi sconosciuti, versioni diverse e campi mancanti senza lanciare', () => {
    expect(parseClientMessage('{x')).toEqual({ ok: false, error: 'JSON non valido' });
    expect(parseClientMessage(JSON.stringify({ v: 1, type: 'boh' })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ v: 2, type: 'hello', client: 'x', protocol: 1 })).ok).toBe(false);
    const r = parseClientMessage(JSON.stringify({ v: 1, type: 'decision.answer', id: 'q' }));
    expect(r).toMatchObject({ ok: false, id: 'q' });
    expect(parseClientMessage(JSON.stringify({ v: 1, type: 'task.action', taskId: 't1', action: 'rm -rf' })).ok).toBe(false);
  });

  it('parseServerMessage valida i messaggi del server', () => {
    expect(parseServerMessage(JSON.stringify({ v: 1, type: 'notify', level: 'info', text: 'ok' })).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ v: 1, type: 'notify', level: 'urlo', text: 'ok' })).ok).toBe(false);
  });
});

describe('EngineEvent', () => {
  it('valida gli eventi dei motori', () => {
    expect(EngineEvent.safeParse({ type: 'usage', inputTokens: 10, outputTokens: 2, costUsd: 0.01 }).success).toBe(true);
    expect(EngineEvent.safeParse({ type: 'usage', inputTokens: -1, outputTokens: 2 }).success).toBe(false);
    expect(EngineEvent.safeParse({ type: 'turn_end', status: 'boh' }).success).toBe(false);
  });
});

describe('applyServerMessage (stato della vista)', () => {
  it('snapshot, upsert e log producono lo stato atteso senza modificare quello precedente', () => {
    const s0 = emptyViewState();
    const agent = { id: 'ada', name: 'Ada', role: 'lead' as const, engine: 'sim' as const, model: 'Sim', state: 'idle' as const, activity: '', paused: false, active: true, costUsd: 0, tokens: 0 };
    const s1 = applyServerMessage(s0, {
      v: 1,
      type: 'snapshot',
      status: { version: '0.1.0', auth: 'ok', message: '', costUsd: 0, tokens: 0, userName: 'Aurora' },
      agents: [agent],
      tasks: [],
      goals: [],
      decisions: [],
      repos: [],
      memory: [],
      skills: [],
      feed: [],
      logs: {},
    });
    expect(s1.connected).toBe(true);
    const s2 = applyServerMessage(s1, { v: 1, type: 'agent.upsert', agent: { ...agent, state: 'thinking' } });
    expect(s2.agents).toHaveLength(1);
    expect(s2.agents[0]?.state).toBe('thinking');
    expect(s1.agents[0]?.state).toBe('idle');
    const s3 = applyServerMessage(s2, { v: 1, type: 'agent.log', agentId: 'ada', entries: [{ ts: 1, kind: 'text', text: 'ciao' }] });
    expect(s3.logs.ada).toEqual([{ ts: 1, kind: 'text', text: 'ciao' }]);
    expect(applyServerMessage(s3, { v: 1, type: 'notify', level: 'info', text: 'x' })).toBe(s3);
  });
});
