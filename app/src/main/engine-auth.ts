// Il motore degli agenti e la sua credenziale, scelti dalle Impostazioni dell'app.
//
//  - Motori disponibili in questa versione: Claude, con la chiave API oppure con il token
//    dell'abbonamento (`claude setup-token`, solo uso personale). Codex non è incluso
//    (shared/engines.ts) e il motore sim non si avvia dall'app: gli agenti lavorano davvero.
//  - Le credenziali si salvano SOLO cifrate con safeStorage (DPAPI su Windows), in
//    ~/.keystone/engine-credentials.json. Se la cifratura del sistema non è disponibile restano
//    in memoria finché l'app è aperta, mai in chiaro su disco.
//  - Il renderer le manda una volta e non le rilegge mai: vede solo quali sono salvate.
//  - All'orchestratore arriva solo la credenziale della modalità scelta, nell'ambiente del suo
//    processo; quelle già presenti nell'ambiente dell'app vengono tolte. Da lì passano solo alla
//    CLI di Claude (TurnSpec.credentials), mai ai comandi degli agenti.
//
// Niente Electron qui (la cifratura è passata da main.ts), così si può testare.
import fs from 'node:fs';
import path from 'node:path';
import type { SecretCipher } from './db-secrets.js';

export type EngineChoice = 'claude-login' | 'claude-api';
export type CredentialKind = 'claudeLoginToken' | 'anthropicApiKey';

export const ENGINE_CHOICES: readonly EngineChoice[] = ['claude-login', 'claude-api'];
const KINDS: readonly CredentialKind[] = ['claudeLoginToken', 'anthropicApiKey'];

/** La credenziale che serve a ciascuna scelta. */
export const CREDENTIAL_OF: Record<EngineChoice, CredentialKind> = { 'claude-login': 'claudeLoginToken', 'claude-api': 'anthropicApiKey' };

/** Variabili di credenziali Claude che l'orchestratore non deve ereditare dall'ambiente dell'app. */
export const CLAUDE_CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

export interface EngineAuthStatus {
  choice?: EngineChoice;
  /** quali credenziali ci sono (mai i valori) */
  saved: Record<CredentialKind, boolean>;
  /** false: la cifratura del sistema non è disponibile, le credenziali valgono solo finché l'app è aperta */
  encryption: boolean;
}

interface Stored {
  choice?: EngineChoice;
  secrets: Partial<Record<CredentialKind, string>>;
}

/** Controlla il formato senza rivelare il valore negli errori. */
export function checkCredential(kind: CredentialKind, value: string): string | undefined {
  const v = value.trim();
  if (v.length < 20 || v.length > 1000 || /\s/.test(v)) return 'il valore non sembra valido (niente spazi, da 20 a 1000 caratteri)';
  const isLogin = v.startsWith('sk-ant-oat');
  if (kind === 'anthropicApiKey') {
    if (isLogin) return 'questo è un token di login (sk-ant-oat…), non una chiave API: scegli "Abbonamento Claude"';
    if (!v.startsWith('sk-ant-')) return 'una chiave API di Anthropic inizia con sk-ant-';
  } else if (!isLogin) {
    return v.startsWith('sk-ant-') ? 'questa è una chiave API, non il token di "claude setup-token": scegli "Chiave API"' : 'il token di "claude setup-token" inizia con sk-ant-oat';
  }
  return undefined;
}

export type EngineSetInput = { choice?: EngineChoice; credential?: { kind: CredentialKind; value: string | null } };

/**
 * Valida la richiesta del renderer (non affidabile). Una credenziale va indicata con il suo valore,
 * oppure con null esplicito per toglierla: un valore mancante non cancella nulla.
 */
export function parseEngineSet(choice: unknown, kind: unknown, value: unknown): { ok: true; input: EngineSetInput } | { ok: false; error: string } {
  const input: EngineSetInput = {};
  if (choice !== undefined && choice !== null) {
    if (typeof choice !== 'string' || !ENGINE_CHOICES.includes(choice as EngineChoice)) return { ok: false, error: 'motore non disponibile' };
    input.choice = choice as EngineChoice;
  }
  if (kind !== undefined && kind !== null) {
    if (typeof kind !== 'string' || !KINDS.includes(kind as CredentialKind)) return { ok: false, error: 'credenziale non valida' };
    if (value === undefined) return { ok: false, error: 'manca il valore della credenziale' };
    if (value !== null && (typeof value !== 'string' || value.length > 1000)) return { ok: false, error: 'valore non valido' };
    input.credential = { kind: kind as CredentialKind, value };
  } else if (value !== undefined && value !== null) {
    return { ok: false, error: 'valore senza credenziale' };
  }
  if (!input.choice && !input.credential) return { ok: false, error: 'niente da salvare' };
  return { ok: true, input };
}

export class EngineAuth {
  private readonly volatile = new Map<CredentialKind, string>();
  private volatileChoice: EngineChoice | undefined;

  constructor(
    private readonly file: string,
    private readonly cipher: SecretCipher,
  ) {}

  private read(): Stored {
    try {
      const st = fs.lstatSync(this.file);
      // un file normale e piccolo: niente link simbolici o junction
      if (!st.isFile() || st.size > 64 * 1024) return { secrets: {} };
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Stored> | null;
      if (!j || typeof j !== 'object' || Array.isArray(j)) return { secrets: {} };
      const secrets: Stored['secrets'] = {};
      for (const k of KINDS) {
        const v = (j.secrets as Record<string, unknown> | undefined)?.[k];
        if (typeof v === 'string' && /^[A-Za-z0-9+/=]+$/.test(v)) secrets[k] = v;
      }
      return { ...(j.choice && ENGINE_CHOICES.includes(j.choice) ? { choice: j.choice } : {}), secrets };
    } catch {
      return { secrets: {} };
    }
  }

  private write(data: Stored): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  status(): EngineAuthStatus {
    const d = this.read();
    const choice = this.volatileChoice ?? d.choice;
    const saved = Object.fromEntries(KINDS.map((k) => [k, this.volatile.has(k) || (this.cipher.available() && !!d.secrets[k])])) as Record<CredentialKind, boolean>;
    return { ...(choice ? { choice } : {}), saved, encryption: this.cipher.available() };
  }

  setChoice(choice: EngineChoice): void {
    if (!ENGINE_CHOICES.includes(choice)) throw new Error('motore non disponibile');
    const d = this.read();
    this.volatileChoice = undefined;
    this.write({ ...d, choice });
  }

  /** Applica una richiesta validata: prima la credenziale (se è rifiutata il motore non cambia), poi la scelta. */
  apply(input: EngineSetInput): { stored?: 'salvata' | 'solo-memoria' | 'tolta'; status: EngineAuthStatus } {
    const stored = input.credential ? this.setCredential(input.credential.kind, input.credential.value) : undefined;
    if (input.choice) this.setChoice(input.choice);
    return { ...(stored ? { stored } : {}), status: this.status() };
  }

  /** Salva (o toglie, con null) una credenziale. "salvata": cifrata su disco; "solo-memoria": cifratura non disponibile. */
  setCredential(kind: CredentialKind, value: string | null): 'salvata' | 'solo-memoria' | 'tolta' {
    if (!KINDS.includes(kind)) throw new Error('credenziale non valida');
    const d = this.read();
    if (value === null) {
      this.volatile.delete(kind);
      if (d.secrets[kind]) {
        delete d.secrets[kind];
        this.write(d);
      }
      return 'tolta';
    }
    const err = checkCredential(kind, value);
    if (err) throw new Error(err);
    if (!this.cipher.available()) {
      this.volatile.set(kind, value.trim());
      if (d.secrets[kind]) {
        delete d.secrets[kind];
        this.write(d);
      }
      return 'solo-memoria';
    }
    d.secrets[kind] = this.cipher.encrypt(value.trim()).toString('base64');
    this.volatile.delete(kind);
    this.write(d);
    return 'salvata';
  }

  private secret(kind: CredentialKind): string | undefined {
    const mem = this.volatile.get(kind);
    if (mem) return mem;
    const enc = this.read().secrets[kind];
    if (!enc || !this.cipher.available()) return undefined;
    try {
      return this.cipher.decrypt(Buffer.from(enc, 'base64'));
    } catch {
      return undefined; // cifrata da un altro utente o PC
    }
  }

  /**
   * Argomenti e ambiente per avviare l'orchestratore con il motore scelto. L'ambiente è quello
   * dell'app senza credenziali Claude, più la sola credenziale della scelta.
   */
  launch(baseEnv: NodeJS.ProcessEnv): { ok: true; args: string[]; env: NodeJS.ProcessEnv } | { ok: false; error: string } {
    const { choice } = this.status();
    if (!choice) return { ok: false, error: 'scegli il motore degli agenti in Impostazioni (abbonamento Claude o chiave API) prima di avviare l\'orchestratore' };
    const value = this.secret(CREDENTIAL_OF[choice]);
    if (!value) return { ok: false, error: choice === 'claude-login' ? 'manca il token dell\'abbonamento: incollalo in Impostazioni → Motore degli agenti' : 'manca la chiave API: incollala in Impostazioni → Motore degli agenti' };
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(baseEnv)) if (!CLAUDE_CREDENTIAL_VARS.includes(k.toUpperCase())) env[k] = v;
    if (choice === 'claude-login') env.CLAUDE_CODE_OAUTH_TOKEN = value;
    else env.ANTHROPIC_API_KEY = value;
    return { ok: true, args: ['--engine', 'claude', ...(choice === 'claude-login' ? ['--use-claude-login'] : [])], env };
  }
}
