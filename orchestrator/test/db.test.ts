// Accesso al database in sola lettura (Fase 6c): SQLite vero (node:sqlite), PostgreSQL e SQL Server
// con driver finti (nessun server reale disponibile), password solo in memoria, registro,
// approvazione, strumenti degli agenti, pulizia delle trascrizioni.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DbConnection, type DbConnection as Conn } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import { DbManager } from '../src/core/db/manager.js';
import { checkReadOnlySql } from '../src/core/db/sql-check.js';
import { sqliteDriver } from '../src/core/db/sqlite.js';
import type { DbDriver } from '../src/core/db/types.js';
import { classify } from '../src/core/policy.js';
import { teamTools } from '../src/core/tools.js';
import { demoRepo, noReply, testOrchestrator, tmpDir, waitFor } from './helpers.js';
import { dropDbResults, findLeaks, DB_RESULT_REMOVED } from './transcript-secrets.js';

const sqliteConn = (over: Partial<Conn> = {}): Conn => ({ id: 'locale', name: 'Dati di prova', kind: 'sqlite', file: 'dati.db', maxRows: 3, timeoutSec: 10, approveEachQuery: false, readOnlyUserConfirmed: false, ...over });
const pgConn = (over: Partial<Conn> = {}): Conn => ({ id: 'pg', name: 'Sviluppo', kind: 'postgres', host: 'localhost', database: 'app', user: 'lettore', maxRows: 50, timeoutSec: 5, approveEachQuery: false, readOnlyUserConfirmed: true, ...over });

function makeSqlite(dir: string, file = 'dati.db'): string {
  const p = path.join(dir, file);
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE clienti (id INTEGER PRIMARY KEY, nome TEXT NOT NULL, citta TEXT DEFAULT 'Roma');
           CREATE TABLE ordini (id INTEGER PRIMARY KEY, cliente INTEGER REFERENCES clienti(id), totale REAL, nota BLOB);
           CREATE INDEX ordini_cliente ON ordini(cliente);
           CREATE VIEW grandi AS SELECT * FROM ordini WHERE totale > 100;`);
  const ins = db.prepare('INSERT INTO clienti (nome, citta) VALUES (?, ?)');
  for (let i = 1; i <= 5; i++) ins.run(`Cliente ${i}`, i % 2 ? 'Roma' : null);
  db.prepare('INSERT INTO ordini (cliente, totale, nota) VALUES (1, 250.5, ?)').run(new Uint8Array([1, 2, 3]));
  db.close();
  return p;
}

const hash = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

describe('controllo del testo della query (solo un aiuto)', () => {
  it('ammette le letture, anche con parole vietate dentro stringhe e commenti', () => {
    for (const q of [
      'SELECT * FROM clienti',
      'select nome from clienti where nome = \'DROP TABLE x\' -- update\n',
      "WITH t AS (SELECT 1) SELECT * FROM t;",
      'EXPLAIN SELECT 1',
      'SELECT replace(nome, \'a\', \'b\') FROM clienti',
      'SELECT "update" FROM t /* delete */',
      'SELECT $$ insert $$',
    ]) expect(checkReadOnlySql(q, 'postgres'), q).toBeUndefined();
    expect(checkReadOnlySql('PRAGMA table_info(clienti)', 'sqlite')).toBeUndefined();
  });

  it('rifiuta scritture, più istruzioni, SELECT INTO, PRAGMA fuori da SQLite', () => {
    for (const q of [
      'DELETE FROM clienti',
      'SELECT 1; DROP TABLE clienti',
      'SELECT * INTO copia FROM clienti',
      'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x',
      'SELECT * FROM t FOR UPDATE',
      "SELECT 1 /* */; EXEC xp_cmdshell 'dir'",
      'VACUUM INTO \'x.db\'',
      'ATTACH \'x.db\' AS z',
      '',
      '   -- solo un commento',
    ]) expect(checkReadOnlySql(q, 'sqlite'), q).toBeDefined();
    expect(checkReadOnlySql('PRAGMA table_info(t)', 'postgres')).toMatch(/solo per SQLite/);
  });
});

describe('SQLite: sola lettura garantita dal file e dall\'authorizer, non dal testo', () => {
  it('tabelle, descrizione, query con limite di righe; valori nulli e binari', async () => {
    const dir = tmpDir();
    makeSqlite(dir);
    const run = { conn: sqliteConn(), repoPath: dir, timeoutMs: 10_000 };
    const tables = await sqliteDriver.tables(run);
    expect(tables).toEqual([
      { name: 'clienti', type: 'table' },
      { name: 'grandi', type: 'view' },
      { name: 'ordini', type: 'table' },
    ]);
    const info = await sqliteDriver.describe(run, 'ordini');
    expect(info.columns.find((c) => c.name === 'id')).toMatchObject({ primaryKey: true });
    expect(info.foreignKeys).toEqual(['cliente -> clienti(id)']);
    expect(info.indexes[0]).toContain('ordini_cliente: cliente');
    const r = await sqliteDriver.query(run, 'SELECT id, citta FROM clienti ORDER BY id', 3);
    expect(r).toEqual({ columns: ['id', 'citta'], rows: [['1', 'Roma'], ['2', 'NULL'], ['3', 'Roma']], truncated: true });
    expect((await sqliteDriver.query(run, 'SELECT nota FROM ordini', 3)).rows).toEqual([['<binario 3 byte>']]);
  });

  it('anche saltando il controllo del testo: niente scritture, VACUUM INTO, ATTACH, PRAGMA che cambiano, estensioni; il file non cambia', async () => {
    const dir = tmpDir();
    const file = makeSqlite(dir);
    const before = hash(file);
    const run = { conn: sqliteConn(), repoPath: dir, timeoutMs: 10_000 };
    const out = path.join(dir, 'copia.db');
    for (const q of [
      "INSERT INTO clienti (nome) VALUES ('x')",
      'DELETE FROM clienti',
      'DROP TABLE ordini',
      'CREATE TABLE z (a)',
      `VACUUM INTO '${out.replace(/\\/g, '/')}'`,
      `ATTACH '${out.replace(/\\/g, '/')}' AS z`,
      'PRAGMA query_only = 0',
      'PRAGMA journal_mode = WAL',
      "SELECT load_extension('x')",
    ]) await expect(sqliteDriver.query(run, q, 10), q).rejects.toThrow();
    expect(fs.existsSync(out)).toBe(false);
    expect(hash(file)).toBe(before);
  });

  it('una query troppo lunga viene interrotta allo scadere del tempo, senza bloccare l\'orchestratore', async () => {
    const dir = tmpDir();
    makeSqlite(dir);
    const run = { conn: sqliteConn({ timeoutSec: 1 }), repoPath: dir, timeoutMs: 1000 };
    let ticks = 0;
    const t = setInterval(() => ticks++, 50);
    const start = Date.now();
    await expect(sqliteDriver.query(run, 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n', 10)).rejects.toThrow(/tempo scaduto/);
    clearInterval(t);
    expect(Date.now() - start).toBeLessThan(8000);
    // il ciclo degli eventi ha continuato a girare durante la query
    expect(ticks).toBeGreaterThan(5);
  });

  it('il file deve esistere: un percorso sbagliato non crea un database vuoto', async () => {
    const dir = tmpDir();
    await expect(sqliteDriver.tables({ conn: sqliteConn({ file: 'manca.db' }), repoPath: dir, timeoutMs: 5000 })).rejects.toThrow(/non esiste/);
    expect(fs.existsSync(path.join(dir, 'manca.db'))).toBe(false);
  });
});

describe('configurazione delle connessioni', () => {
  it('server: serve la conferma esplicita dell\'utente in sola lettura; SQLite: serve il file', () => {
    expect(DbConnection.safeParse(pgConn()).success).toBe(true);
    expect(DbConnection.safeParse(pgConn({ readOnlyUserConfirmed: false })).error?.issues[0]?.message).toMatch(/solo permessi di lettura/);
    expect(DbConnection.safeParse(sqliteConn({ file: undefined })).success).toBe(false);
    expect(DbConnection.safeParse({ ...pgConn(), password: 'x' }).success).toBe(false); // niente password nella configurazione
    expect(DbConnection.safeParse(pgConn({ maxRows: 100_000 })).success).toBe(false);
    expect(DbConnection.safeParse(pgConn({ id: '../x' })).success).toBe(false);
    expect(DbConnection.safeParse(pgConn({ name: 'a\nb' })).success).toBe(false);
  });
});

/** Un driver finto che ricorda cosa riceve. */
function fakeDriver(log: Array<{ op: string; password?: string; sql?: string }>, fail?: (pw?: string) => string): DbDriver {
  return {
    tables: async (r) => {
      log.push({ op: 'tables', ...(r.password ? { password: r.password } : {}) });
      if (fail) throw new Error(fail(r.password));
      return [{ schema: 'public', name: 'clienti', type: 'table' }];
    },
    describe: async (r, table) => {
      log.push({ op: 'describe', ...(r.password ? { password: r.password } : {}) });
      return { table, columns: [{ name: 'id', type: 'int', nullable: false }], foreignKeys: [], indexes: [] };
    },
    query: async (r, sql) => {
      log.push({ op: 'query', sql, ...(r.password ? { password: r.password } : {}) });
      if (fail) throw new Error(fail(r.password));
      return { columns: ['id'], rows: [['1']], truncated: false };
    },
  };
}

describe('password solo in memoria', () => {
  it('db.secret: la password arriva al driver ma non a stato, snapshot, registro, log, risultati o errori', async () => {
    const SECRET = 'P4ssw0rd-segretissima';
    const { o, cfg } = testOrchestrator({ workers: 1 });
    const calls: Array<{ op: string; password?: string }> = [];
    (o.db as unknown as { d: { drivers: unknown } }).d.drivers = { postgres: fakeDriver(calls, (pw) => `password authentication failed for user "lettore" (password "${pw}")`) };
    const repoPath = await demoRepo(cfg.home);
    const repo = await o.repos.add(repoPath, { confirmGuard: true });
    await o.start();
    await o.handle({ v: 1, type: 'db.save', repoId: repo.id, connection: pgConn() }, noReply);
    const ack = await o.handle({ v: 1, type: 'db.secret', repoId: repo.id, connectionId: 'pg', password: SECRET }, noReply);
    expect(JSON.stringify(ack)).not.toContain(SECRET);
    await expect(o.handle({ v: 1, type: 'db.test', repoId: repo.id, connectionId: 'pg' }, noReply)).rejects.toThrow(/\*\*\*/);
    await expect(o.db.run(repo.id, 'pg', { kind: 'query', sql: 'SELECT 1' }, 'bruno')).rejects.toThrow(/\*\*\*/);
    expect(calls.every((c) => c.password === SECRET)).toBe(true);
    o.store.flush();
    const everything = [
      fs.readFileSync(path.join(cfg.home, cfg.profile, 'state.json'), 'utf8'),
      JSON.stringify(o.snapshot()),
      fs.readFileSync(path.join(cfg.home, cfg.profile, 'db-queries.jsonl'), 'utf8'),
      ...fs.readdirSync(path.join(cfg.home, cfg.profile, 'logs')).map((f) => fs.readFileSync(path.join(cfg.home, cfg.profile, 'logs', f), 'utf8')),
    ].join('\n');
    expect(everything).not.toContain(SECRET);
    expect(everything).toContain('lettore');
    // tolta la connessione, la password sparisce dalla memoria
    await o.handle({ v: 1, type: 'db.delete', repoId: repo.id, connectionId: 'pg' }, noReply);
    expect(o.db.hasSecret(repo.id, 'pg')).toBe(false);
  });

  it('senza password (orchestratore senza app) un server non si collega e lo dice', async () => {
    const m = new DbManager({ repos: () => [{ id: 'r1', name: 'r', path: tmpDir(), branch: 'main', dirty: false, ci: 'unknown', worktrees: [], db: [pgConn()] }], logFile: path.join(tmpDir(), 'q.jsonl'), now: () => Date.now() });
    await expect(m.run('r1', 'pg', { kind: 'tables' }, 'bruno')).rejects.toThrow(/password non disponibile/);
  });
});

describe('strumenti degli agenti, registro, approvazione', () => {
  async function setup(conn: Conn) {
    const { o, cfg } = testOrchestrator({ workers: 1 });
    const repoPath = await demoRepo(cfg.home);
    makeSqlite(repoPath);
    const repo = await o.repos.add(repoPath, { confirmGuard: true });
    await o.start();
    await o.handle({ v: 1, type: 'db.save', repoId: repo.id, connection: conn }, noReply);
    const hooks = { onReview: () => undefined, onChangesRequested: () => undefined, onTasksChanged: () => undefined, onDecisionOpened: () => undefined };
    const guard = { aborted: () => false, reason: () => undefined, whenAborted: new Promise<void>(() => undefined) };
    const tools = (id: string, role: 'lead' | 'worker') => teamTools(o, id, role, hooks, guard);
    const registry = () => fs.readFileSync(path.join(cfg.home, cfg.profile, 'db-queries.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    return { o, repo, tools, registry };
  }

  it('gli strumenti ci sono solo con connessioni configurate, per lead e worker, e la policy li ammette', async () => {
    const { o, tools } = await setup(sqliteConn());
    for (const [id, role] of [[o.leadId, 'lead'], ['bruno', 'worker']] as const) {
      expect(tools(id, role).map((t) => t.name)).toEqual(expect.arrayContaining(['db_tables', 'db_describe', 'db_query']));
      for (const n of ['db_tables', 'db_describe', 'db_query']) expect(classify(`mcp__keystone__${n}`, {}, { role, cwd: tmpDir() }).action).toBe('allow');
    }
    const { o: o2 } = testOrchestrator({ workers: 1 });
    const hooks = { onReview: () => undefined, onChangesRequested: () => undefined, onTasksChanged: () => undefined, onDecisionOpened: () => undefined };
    const guard = { aborted: () => false, reason: () => undefined, whenAborted: new Promise<void>(() => undefined) };
    expect(teamTools(o2, 'bruno', 'worker', hooks, guard).map((t) => t.name).filter((n) => n.startsWith('db_'))).toEqual([]);
  });

  it('una query: risultato con intestazione e righe, nel registro (senza risultati) e nel log dell\'agente', async () => {
    const { o, tools, registry } = await setup(sqliteConn());
    const q = tools('bruno', 'worker').find((t) => t.name === 'db_query')!;
    const r = await q.run({ connection: 'locale', sql: 'SELECT nome FROM clienti ORDER BY id' });
    expect(r.isError).toBeUndefined();
    expect(r.text).toMatch(/^Connessione "Dati di prova" \(SQLite, sola lettura\)/);
    expect(r.text).toContain('Cliente 1');
    expect(r.text).toContain('limite della connessione: 3');
    const last = registry().at(-1)!;
    expect(last).toMatchObject({ agentId: 'bruno', connectionId: 'locale', op: 'query', text: 'SELECT nome FROM clienti ORDER BY id', rows: 3, outcome: 'ok' });
    expect(JSON.stringify(registry())).not.toContain('Cliente 1');
    expect(o.store.logTail('bruno').some((e) => e.text.includes('database locale: 3 righe'))).toBe(true);
    // rifiutata dal controllo: registrata come tale
    const bad = await q.run({ connection: 'locale', sql: 'DELETE FROM clienti' });
    expect(bad.isError).toBe(true);
    expect(registry().at(-1)).toMatchObject({ outcome: 'refused' });
    // connessione sconosciuta: elenca quelle disponibili
    expect((await q.run({ connection: 'altra', sql: 'SELECT 1' })).text).toContain('disponibili: locale');
  });

  it('con "approva ogni query": la query aspetta la tua risposta; negata non viene eseguita', async () => {
    const { o, tools, registry } = await setup(sqliteConn({ approveEachQuery: true }));
    const q = tools('bruno', 'worker').find((t) => t.name === 'db_query')!;
    const p1 = q.run({ connection: 'locale', sql: 'SELECT count(*) FROM clienti' });
    const d1 = await waitFor(() => o.decisions.open().find((d) => d.kind === 'permission' && d.tool === 'db_query'), 'richiesta di approvazione');
    expect(d1.command).toBe('SELECT count(*) FROM clienti');
    expect(d1.options).toEqual(['Consenti una volta', 'Nega']);
    await o.handle({ v: 1, type: 'decision.answer', decisionId: d1.id, option: 'Nega', text: 'non ora' }, noReply);
    const r1 = await p1;
    expect(r1.isError).toBe(true);
    expect(r1.text).toContain('non ora');
    expect(registry().at(-1)).toMatchObject({ outcome: 'denied' });
    const p2 = q.run({ connection: 'locale', sql: 'SELECT count(*) FROM clienti' });
    const d2 = await waitFor(() => o.decisions.open().find((d) => d.kind === 'permission' && d.tool === 'db_query'), 'seconda richiesta');
    await o.handle({ v: 1, type: 'decision.answer', decisionId: d2.id, option: 'Consenti una volta' }, noReply);
    expect((await p2).text).toContain('5');
    expect(registry().at(-1)).toMatchObject({ outcome: 'ok' });
  });
});

describe('trascrizioni: i risultati del database non entrano nelle fixture', () => {
  it('la pulizia toglie i risultati dei tool db_* (la query resta); un risultato rimasto viene trovato', () => {
    const result = 'Connessione "Dati di prova" (SQLite, sola lettura) · 3 ms\n\nnome\n---\nMario Rossi';
    const msgs = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__keystone__db_query', input: { connection: 'locale', sql: 'SELECT nome FROM clienti' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: result }] }] }, tool_use_result: result },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'altro risultato' }] } },
    ];
    const clean = JSON.stringify(dropDbResults(msgs));
    expect(clean).not.toContain('Mario Rossi');
    expect(clean).toContain(DB_RESULT_REMOVED);
    expect(clean).toContain('SELECT nome FROM clienti');
    expect(clean).toContain('altro risultato');
    expect(findLeaks(JSON.stringify(msgs)).map((l) => l.name)).toContain('risultato del database');
    expect(findLeaks(clean).map((l) => l.name)).not.toContain('risultato del database');
  });
});

describe('correzioni della revisione', () => {
  it('SQLite in modalità WAL: leggere non crea file accanto al database (niente -wal e -shm nel repository)', async () => {
    const dir = tmpDir();
    const p = path.join(dir, 'dati.db');
    const w = new DatabaseSync(p);
    w.exec("PRAGMA journal_mode = WAL; CREATE TABLE a (x); INSERT INTO a VALUES (1);");
    w.close();
    for (const f of [`${p}-wal`, `${p}-shm`]) fs.rmSync(f, { force: true });
    const before = fs.readdirSync(dir).sort();
    const r = await sqliteDriver.query({ conn: sqliteConn(), repoPath: dir, timeoutMs: 10_000 }, 'SELECT x FROM a', 10);
    expect(r.rows).toEqual([['1']]);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });

  it('valori enormi: zeroblob e randomblob negati; le celle lunghe si accorciano già nel thread', async () => {
    const dir = tmpDir();
    makeSqlite(dir);
    const run = { conn: sqliteConn(), repoPath: dir, timeoutMs: 10_000 };
    await expect(sqliteDriver.query(run, 'SELECT zeroblob(100000000)', 1)).rejects.toThrow();
    await expect(sqliteDriver.query(run, 'SELECT length(randomblob(100000000))', 1)).rejects.toThrow();
    // un valore enorme costruito in memoria nativa: crolla il lettore, non l'orchestratore
    await expect(sqliteDriver.query({ ...run, timeoutMs: 60_000 }, "SELECT printf('%800000000c', 'x')", 1)).rejects.toThrow(/lettore SQLite|troppo grande|too big|memory/i);
    expect((await sqliteDriver.query(run, 'SELECT 1', 1)).rows).toEqual([['1']]);
    const long = await sqliteDriver.query(run, "SELECT printf('%.5000c', 'x') AS lungo", 1);
    expect(long.rows[0]![0]!.length).toBeLessThanOrEqual(2001);
    // un nome di tabella con virgolette non rompe la descrizione
    await expect(sqliteDriver.describe(run, 'cli"enti')).rejects.toThrow(/sconosciuta/);
  });

  it('al massimo 4 operazioni sul database insieme: la quinta è rifiutata e registrata', async () => {
    const log = path.join(tmpDir(), 'q.jsonl');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const slow: DbDriver = { tables: async () => (await hold, []), describe: async () => { throw new Error('x'); }, query: async () => (await hold, { columns: [], rows: [], truncated: false }) };
    const m = new DbManager({ repos: () => [{ id: 'r1', name: 'r', path: tmpDir(), branch: 'main', dirty: false, ci: 'unknown', worktrees: [], db: [sqliteConn()] }], logFile: log, now: () => Date.now(), drivers: { sqlite: slow } });
    const running = [1, 2, 3, 4].map(() => m.run('r1', 'locale', { kind: 'tables' }, 'bruno'));
    await expect(m.run('r1', 'locale', { kind: 'tables' }, 'bruno')).rejects.toThrow(/troppe operazioni/);
    release();
    await Promise.all(running);
    // finite quelle in corso, si riparte
    await m.run('r1', 'locale', { kind: 'tables' }, 'bruno');
    expect(fs.readFileSync(log, 'utf8')).toContain('"outcome":"refused"');
  });

  it('il controllo del testo ferma anche le funzioni che cambiano la sessione o leggono file del server (solo un aiuto)', () => {
    for (const q of ["SELECT set_config('statement_timeout', '0', false), pg_sleep(100)", "SELECT pg_read_file('/etc/passwd')", 'SELECT * FROM dblink(\'x\', \'y\')', 'SELECT pg_terminate_backend(1)', 'SELECT xp_dirtree(\'c:\\\')'])
      expect(checkReadOnlySql(q, 'postgres'), q).toBeDefined();
  });

  it('richiesta di approvazione annullata: non diventa un "Nega" dell\'utente, la query non parte, il registro lo dice', async () => {
    const { o, cfg } = testOrchestrator({ workers: 1 });
    const repoPath = await demoRepo(cfg.home);
    makeSqlite(repoPath);
    const repo = await o.repos.add(repoPath, { confirmGuard: true });
    await o.start();
    await o.handle({ v: 1, type: 'db.save', repoId: repo.id, connection: sqliteConn({ approveEachQuery: true }) }, noReply);
    const hooks = { onReview: () => undefined, onChangesRequested: () => undefined, onTasksChanged: () => undefined, onDecisionOpened: () => undefined };
    const guard = { aborted: () => false, reason: () => undefined, whenAborted: new Promise<void>(() => undefined) };
    const q = teamTools(o, 'bruno', 'worker', hooks, guard).find((t) => t.name === 'db_query')!;
    const p = q.run({ connection: 'locale', sql: 'SELECT 1' });
    const d = await waitFor(() => o.decisions.open().find((x) => x.tool === 'db_query'), 'richiesta');
    o.decisions.cancel(d.id, 'turno fermato');
    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.text).toContain('annullata (turno fermato)');
    expect(r.text).not.toContain('non ha approvato');
    const reg = fs.readFileSync(path.join(cfg.home, cfg.profile, 'db-queries.jsonl'), 'utf8');
    expect(reg).toContain('"outcome":"denied"');
    expect(reg).toContain('richiesta annullata');
  });

  it('db.secret: la password ha almeno 4 caratteri (sotto non si potrebbe togliere dai messaggi)', async () => {
    const { ClientMessage } = await import('@keystone/shared');
    const base = { v: 1, type: 'db.secret', repoId: 'r1', connectionId: 'pg' };
    expect(ClientMessage.safeParse({ ...base, password: 'abc' }).success).toBe(false);
    expect(ClientMessage.safeParse({ ...base, password: 'abcd' }).success).toBe(true);
    expect(ClientMessage.safeParse({ ...base, password: null }).success).toBe(true);
  });
});

describe('la password vale solo per la destinazione per cui è stata data', () => {
  it('cambiare server di una connessione (anche da un altro client locale) fa dimenticare la password; db.secret per un\'altra destinazione è rifiutato', async () => {
    const { dbDestination } = await import('@keystone/shared');
    const { o, cfg } = testOrchestrator({ workers: 1 });
    const calls: Array<{ op: string; password?: string }> = [];
    (o.db as unknown as { d: { drivers: unknown } }).d.drivers = { postgres: fakeDriver(calls) };
    const repoPath = await demoRepo(cfg.home);
    const repo = await o.repos.add(repoPath, { confirmGuard: true });
    await o.start();
    await o.handle({ v: 1, type: 'db.save', repoId: repo.id, connection: pgConn() }, noReply);
    const dest = dbDestination(pgConn());
    await o.handle({ v: 1, type: 'db.secret', repoId: repo.id, connectionId: 'pg', password: 'segreta-1', destination: dest }, noReply);
    expect(o.db.hasSecret(repo.id, 'pg')).toBe(true);
    // un client manda la stessa connessione con un altro server: la password non deve andarci
    await o.handle({ v: 1, type: 'db.save', repoId: repo.id, connection: pgConn({ host: 'altro.example' }) }, noReply);
    expect(o.db.hasSecret(repo.id, 'pg')).toBe(false);
    await expect(o.handle({ v: 1, type: 'db.test', repoId: repo.id, connectionId: 'pg' }, noReply)).resolves.toBeDefined();
    expect(calls.at(-1)?.password).toBeUndefined();
    // e una password data per la destinazione vecchia è rifiutata
    await expect(o.handle({ v: 1, type: 'db.secret', repoId: repo.id, connectionId: 'pg', password: 'segreta-1', destination: dest }, noReply)).rejects.toThrow(/cambiata/);
    // cambiare solo limiti o nome non tocca la password
    await o.handle({ v: 1, type: 'db.secret', repoId: repo.id, connectionId: 'pg', password: 'segreta-2', destination: dbDestination(pgConn({ host: 'altro.example' })) }, noReply);
    await o.handle({ v: 1, type: 'db.save', repoId: repo.id, connection: pgConn({ host: 'altro.example', maxRows: 10, name: 'Nuovo nome' }) }, noReply);
    expect(o.db.hasSecret(repo.id, 'pg')).toBe(true);
    for (const change of [{ user: 'admin' }, { database: 'prod' }, { port: 6543 }, { tls: false }, { trustServerCertificate: true }]) {
      const c = pgConn({ host: 'altro.example', ...change });
      expect(dbDestination(c), JSON.stringify(change)).not.toBe(dbDestination(pgConn({ host: 'altro.example' })));
    }
  });
});
