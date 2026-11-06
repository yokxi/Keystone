// Password delle connessioni a database (Fase 6c), nel processo main dell'app.
//
//  - Si salvano SOLO cifrate con safeStorage (DPAPI su Windows), in
//    ~/.keystone/<profilo>/db-secrets.json. Se la cifratura del sistema non è disponibile, la
//    password non si salva (mai in chiaro): vale solo finché l'app resta aperta.
//  - Il renderer le manda una volta (campo password) e non le rilegge mai: può solo sapere quali
//    connessioni hanno una password salvata.
//  - All'orchestratore arrivano col messaggio db.secret, a ogni collegamento, e restano nella sua
//    memoria.
//
// Niente Electron qui (la cifratura è passata da main.ts), così si può testare.
import fs from 'node:fs';
import path from 'node:path';

export interface SecretCipher {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export const DB_SECRET_KEY_RE = /^[A-Za-z0-9_-]{1,64}\/[a-z0-9][a-z0-9-]{0,39}$/;

/** Su disco: la password cifrata e la destinazione per cui vale (dbDestination). */
interface Stored {
  secret: string;
  destination: string;
}
interface Entry {
  password: string;
  destination: string;
}

export class DbSecrets {
  /** password non salvabili (cifratura non disponibile): solo in memoria, finché l'app è aperta */
  private readonly volatile = new Map<string, Entry>();

  constructor(
    private readonly file: string,
    private readonly cipher: SecretCipher,
  ) {}

  static key(repoId: string, connectionId: string): string {
    const k = `${repoId}/${connectionId}`;
    if (!DB_SECRET_KEY_RE.test(k)) throw new Error('connessione non valida');
    return k;
  }

  private readFile(): Record<string, Stored> {
    try {
      const st = fs.lstatSync(this.file);
      if (!st.isFile() || st.size > 1024 * 1024) return {};
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
      const ok = (v: unknown): v is Stored => !!v && typeof v === 'object' && typeof (v as Stored).secret === 'string' && typeof (v as Stored).destination === 'string';
      return Object.fromEntries(Object.entries(j as Record<string, unknown>).filter(([k, v]) => DB_SECRET_KEY_RE.test(k) && ok(v))) as Record<string, Stored>;
    } catch {
      return {};
    }
  }

  private writeFile(data: Record<string, Stored>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /**
   * Salva (o toglie, con null) la password. Restituisce dove è finita: "salvata" (cifrata su disco)
   * o "solo-memoria" (cifratura non disponibile).
   */
  set(repoId: string, connectionId: string, password: string | null, destination = ''): 'salvata' | 'solo-memoria' | 'tolta' {
    const k = DbSecrets.key(repoId, connectionId);
    const data = this.readFile();
    if (password === null) {
      this.volatile.delete(k);
      if (k in data) {
        delete data[k];
        this.writeFile(data);
      }
      return 'tolta';
    }
    if (!this.cipher.available()) {
      this.volatile.set(k, { password, destination });
      if (k in data) {
        delete data[k];
        this.writeFile(data);
      }
      return 'solo-memoria';
    }
    data[k] = { secret: this.cipher.encrypt(password).toString('base64'), destination };
    this.volatile.delete(k);
    this.writeFile(data);
    return 'salvata';
  }

  /** Quali connessioni hanno una password (salvata o solo in memoria). Mai le password. */
  keys(): string[] {
    return [...new Set([...Object.keys(this.readFile()), ...this.volatile.keys()])].sort();
  }

  /** Tutte le password, per mandarle all'orchestratore. Quelle che non si decifrano si saltano. */
  all(): Array<{ repoId: string; connectionId: string; password: string; destination: string }> {
    const out = new Map<string, Entry>();
    if (this.cipher.available()) {
      for (const [k, v] of Object.entries(this.readFile())) {
        try {
          out.set(k, { password: this.cipher.decrypt(Buffer.from(v.secret, 'base64')), destination: v.destination });
        } catch {
          /* cifrata da un altro utente o PC: si salta */
        }
      }
    }
    for (const [k, v] of this.volatile) out.set(k, v);
    return [...out].map(([k, e]) => {
      const i = k.indexOf('/');
      return { repoId: k.slice(0, i), connectionId: k.slice(i + 1), ...e };
    });
  }
}
