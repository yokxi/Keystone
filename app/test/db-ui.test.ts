// Database in sola lettura (Fase 6c), lato app: password cifrate nel processo main, comandi
// ammessi dal renderer, modulo della connessione.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DbSecrets, type SecretCipher } from '../src/main/db-secrets.js';
import { validateCommand } from '../src/main/ipc-validate.js';
import { dbConnectionFromForm, dbFormFrom, dbIdFromName, emptyDbForm } from '../src/renderer/components/DbConnections.js';
import { tmpDir } from '../../orchestrator/test/helpers.js';

/** Una "cifratura" finta ma reversibile, che non lascia il testo in chiaro. */
const fakeCipher = (available = true): SecretCipher => ({
  available: () => available,
  encrypt: (s) => Buffer.from(`CIFRATO:${Buffer.from(s, 'utf8').reverse().toString('hex')}`),
  decrypt: (b) => {
    const t = b.toString();
    if (!t.startsWith('CIFRATO:')) throw new Error('non decifrabile');
    return Buffer.from(t.slice(8), 'hex').reverse().toString('utf8');
  },
});

const PW = 'Pa55-segretissima';

describe('password dei database nel processo main', () => {
  it('salvate solo cifrate; le chiavi non rivelano la password; tolte quando si toglie la connessione', () => {
    const file = path.join(tmpDir(), 'p', 'db-secrets.json');
    const s = new DbSecrets(file, fakeCipher());
    expect(s.set('r1', 'pg', PW, 'dest-1')).toBe('salvata');
    expect(fs.readFileSync(file, 'utf8')).not.toContain(PW);
    expect(s.keys()).toEqual(['r1/pg']);
    expect(JSON.stringify(s.keys())).not.toContain(PW);
    // una nuova istanza (riavvio dell'app) rilegge e decifra
    expect(new DbSecrets(file, fakeCipher()).all()).toEqual([{ repoId: 'r1', connectionId: 'pg', password: PW, destination: 'dest-1' }]);
    expect(s.set('r1', 'pg', null)).toBe('tolta');
    expect(s.keys()).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('r1/pg');
  });

  it('senza cifratura del sistema: mai su disco, solo in memoria finché l\'app è aperta', () => {
    const file = path.join(tmpDir(), 'db-secrets.json');
    const s = new DbSecrets(file, fakeCipher(false));
    expect(s.set('r1', 'pg', PW, 'dest-1')).toBe('solo-memoria');
    expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').not.toContain(PW);
    expect(s.all()).toEqual([{ repoId: 'r1', connectionId: 'pg', password: PW, destination: 'dest-1' }]);
    expect(new DbSecrets(file, fakeCipher(false)).all()).toEqual([]);
  });

  it('chiavi non valide, file rovinati o cifrati altrove: niente eccezioni, niente password', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'db-secrets.json');
    const s = new DbSecrets(file, fakeCipher());
    expect(() => s.set('../x', 'pg', PW)).toThrow();
    expect(() => s.set('r1', 'PG', PW)).toThrow();
    fs.writeFileSync(file, '{ non è json');
    expect(s.all()).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ 'r1/pg': { secret: Buffer.from('cifrata da un altro PC').toString('base64'), destination: 'd' }, 'r1/vecchio': 'formato senza destinazione', '../../x': 'y' }));
    expect(s.all()).toEqual([]);
    expect(s.keys()).toEqual(['r1/pg']);
  });
});

describe('comandi del renderer per i database', () => {
  const conn = { id: 'pg', name: 'Sviluppo', kind: 'postgres', host: 'localhost', database: 'app', user: 'lettore', maxRows: 50, timeoutSec: 5, approveEachQuery: false, readOnlyUserConfirmed: true };
  it('salvare, togliere e provare sì; la password (db.secret) mai dal renderer', () => {
    expect(validateCommand({ type: 'db.save', repoId: 'r1', connection: conn })).toMatchObject({ ok: true });
    expect(validateCommand({ type: 'db.delete', repoId: 'r1', connectionId: 'pg' })).toMatchObject({ ok: true });
    expect(validateCommand({ type: 'db.test', repoId: 'r1', connectionId: 'pg' })).toMatchObject({ ok: true });
    expect(validateCommand({ type: 'db.secret', repoId: 'r1', connectionId: 'pg', password: 'x' })).toMatchObject({ ok: false });
    // niente password nella configurazione, niente server senza la conferma
    expect(validateCommand({ type: 'db.save', repoId: 'r1', connection: { ...conn, password: 'x' } })).toMatchObject({ ok: false });
    expect(validateCommand({ type: 'db.save', repoId: 'r1', connection: { ...conn, readOnlyUserConfirmed: false } })).toMatchObject({ ok: false });
  });
});

describe('modulo della connessione', () => {
  it('SQLite: basta il file; l\'id nasce dal nome', () => {
    const r = dbConnectionFromForm({ ...emptyDbForm(), name: 'Dati di Prova è', file: 'dati.db' });
    expect(r).toMatchObject({ ok: true, conn: { id: 'dati-di-prova-e', kind: 'sqlite', file: 'dati.db', maxRows: 200, timeoutSec: 15 } });
    expect(dbIdFromName('***')).toBe('db');
  });

  it('server: senza la conferma di sola lettura non si salva; la conferma riparte da "no" quando si modifica', () => {
    const f = { ...emptyDbForm(), name: 'Sviluppo', kind: 'postgres' as const, host: 'localhost', database: 'app', user: 'lettore' };
    const no = dbConnectionFromForm(f);
    expect(no.ok).toBe(false);
    expect(!no.ok && no.error).toMatch(/conferma/);
    const yes = dbConnectionFromForm({ ...f, readOnlyUserConfirmed: true });
    expect(yes).toMatchObject({ ok: true, conn: { kind: 'postgres', readOnlyUserConfirmed: true } });
    expect(dbFormFrom(yes.ok ? yes.conn : (undefined as never)).readOnlyUserConfirmed).toBe(false);
    expect(dbConnectionFromForm({ ...f, readOnlyUserConfirmed: true, maxRows: '999999' }).ok).toBe(false);
    expect(dbConnectionFromForm({ ...f, readOnlyUserConfirmed: true, port: 'abc' }).ok).toBe(false);
  });
});
