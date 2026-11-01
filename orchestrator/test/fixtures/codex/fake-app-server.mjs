// Un `codex app-server` finto per i test del motore Codex: parla lo stesso JSON-RPC (una riga JSON
// per messaggio, senza "jsonrpc"), con i nomi dei metodi verificati sulla CLI 0.163.0.
//
// Lo scenario arriva da FAKE_CODEX_SCENARIO (file JSON):
//   { account: {...}|null, sandbox: {...}, model, steps: [ { notify, params } | { request, params, expect? } ], turnStatus, turnError }
// Ogni messaggio ricevuto dal client viene scritto in FAKE_CODEX_LOG (JSONL), insieme alle
// risposte alle richieste del server e all'ambiente del processo (per le asserzioni).
import fs from 'node:fs';
import readline from 'node:readline';

const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_SCENARIO, 'utf8'));
const logFile = process.env.FAKE_CODEX_LOG;
const log = (entry) => fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
log({ t: 'env', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CODEX_HOME|OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY|GIT_CONFIG_COUNT|PATH)$/i.test(k)).map(([k, v]) => [k.toUpperCase(), k.toUpperCase() === 'PATH' ? '(c)' : v])) });

let THREAD = 'th-finto-1';
const TURN = 'tu-finto-1';
let next = 1000;
const waiting = new Map();
let account = scenario.account ?? null;
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const request = (method, params) =>
  new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

async function playTurn() {
  send({ method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress', items: [] } } });
  for (const step of scenario.steps ?? []) {
    const params = JSON.parse(JSON.stringify(step.params ?? {}).replaceAll('$THREAD', THREAD).replaceAll('$TURN', TURN));
    if (step.notify) send({ method: step.notify, params });
    if (step.request) {
      const res = await request(step.request, params);
      log({ t: 'response', method: step.request, res });
    }
    if (step.wait) await new Promise((r) => setTimeout(r, step.wait));
  }
  if (scenario.hang) return; // per i test di interruzione: il turno non finisce da solo
  send({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, status: scenario.turnStatus ?? 'completed', error: scenario.turnError ? { message: scenario.turnError } : null, items: [] } } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  log({ t: 'in', msg: m });
  if (m.id !== undefined && !m.method) {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    w?.(m.result ?? { error: m.error });
    return;
  }
  if (!m.method || m.id === undefined) return;
  const reply = (result) => send({ id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return reply({ userAgent: 'finto/0.163.0', codexHome: process.env.CODEX_HOME, platformFamily: 'windows', platformOs: 'windows' });
    case 'account/read':
      return reply({ account, requiresOpenaiAuth: true, workspaceRouting: null });
    case 'account/login/start':
      account = { type: 'apiKey' };
      return reply({ type: 'apiKey' });
    case 'skills/list':
      return reply({ data: [{ cwd: m.params.cwds?.[0] ?? '', skills: scenario.skills ?? [], errors: [] }] });
    case 'skills/config/write':
      return reply({});
    case 'thread/start':
    case 'thread/resume':
      if (m.params.threadId) THREAD = m.params.threadId;
      return reply({ thread: { id: m.params.threadId ?? THREAD, turns: [] }, model: scenario.model ?? 'gpt-finto-1', sandbox: scenario.sandbox ?? (m.params.sandbox === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [], networkAccess: false } : { type: 'readOnly', networkAccess: false }) });
    case 'turn/start':
      reply({ turn: { id: TURN, status: 'inProgress', items: [] } });
      void playTurn();
      return;
    case 'turn/interrupt':
      reply({});
      send({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, status: 'interrupted', error: null, items: [] } } });
      return;
    default:
      send({ id: m.id, error: { code: -32601, message: `metodo sconosciuto nel server finto: ${m.method}` } });
  }
});
