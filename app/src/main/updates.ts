// Controllo degli aggiornamenti: l'app chiede a GitHub qual è l'ultima release di Keystone e, se è
// più recente, lo dice. Non scarica e non installa nulla: il pulsante apre la pagina della release
// nel browser e l'installatore lo avvii tu.
//
// Regole (docs/sicurezza.md, "Aggiornamenti"):
// - una sola destinazione, fissa: l'API delle release di yokxi/Keystone; nessun dato inviato oltre
//   a una richiesta GET anonima con un User-Agent generico;
// - si può spegnere (Impostazioni), e con il controllo spento non parte nessuna richiesta;
// - la risposta è un dato non attendibile: si accettano solo una versione x.y.z, un link alla pagina
//   delle release di questo repository e un testo, ripulito e troncato. Il renderer lo mostra come
//   testo semplice, mai come HTML.
import fs from 'node:fs';
import path from 'node:path';

export const RELEASES_API = 'https://api.github.com/repos/yokxi/Keystone/releases/latest';
export const RELEASES_PAGE = 'https://github.com/yokxi/Keystone/releases';
/** ogni quanto si ricontrolla mentre l'app resta aperta */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** il primo controllo, poco dopo l'avvio (non rallenta l'apertura della finestra) */
export const FIRST_CHECK_DELAY_MS = 10_000;
const MAX_NOTES = 4000;
const MAX_BODY_BYTES = 1024 * 1024;

export interface UpdateInfo {
  version: string;
  name: string;
  notes: string;
  /** la pagina della release, sempre sotto RELEASES_PAGE */
  url: string;
  publishedAt?: string;
}

export type CheckResult = { status: 'available'; info: UpdateInfo } | { status: 'none'; latest: string } | { status: 'error'; error: string };

export interface UpdateStatus {
  /** la versione in uso */
  current: string;
  /** controllo automatico attivo (Impostazioni) */
  enabled: boolean;
  /** spento da KEYSTONE_NO_UPDATE_CHECK: l'interruttore non conta */
  forcedOff: boolean;
  checking: boolean;
  lastCheck?: number;
  result?: CheckResult;
}

/** Una versione x.y.z (con o senza "v" davanti). Le pre-release ("1.0.0-beta") non valgono. */
export function parseVersion(v: unknown): [number, number, number] | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^v?(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** true solo se `candidate` è una versione valida e più recente di `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** Testo da mostrare: senza caratteri di controllo (tranne a capo e tab), troncato. */
function cleanText(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}\n…` : t;
}

/** La risposta dell'API, validata. undefined = non è una release accettabile. */
export function parseRelease(json: unknown): UpdateInfo | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return undefined;
  const v = parseVersion(r.tag_name);
  if (!v) return undefined;
  const version = v.join('.');
  const url = typeof r.html_url === 'string' ? r.html_url : '';
  // solo la pagina di una release di questo repository: niente altri siti, niente credenziali o porte
  let ok = false;
  try {
    const u = new URL(url);
    ok = u.protocol === 'https:' && u.host === 'github.com' && !u.username && !u.password && u.pathname.startsWith('/yokxi/Keystone/releases/') && !u.pathname.includes('..');
  } catch {
    ok = false;
  }
  if (!ok) return undefined;
  const publishedAt = typeof r.published_at === 'string' && !Number.isNaN(Date.parse(r.published_at)) ? r.published_at : undefined;
  return { version, name: cleanText(r.name, 200) || `Keystone ${version}`, notes: cleanText(r.body, MAX_NOTES), url, ...(publishedAt ? { publishedAt } : {}) };
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'error' }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Una richiesta all'API delle release. Non lancia mai: gli errori tornano come risultato. */
export async function checkForUpdate(current: string, fetchFn: FetchLike, timeoutMs = 15_000): Promise<CheckResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(RELEASES_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Keystone-app' },
      signal: ctrl.signal,
      redirect: 'error',
    });
    if (res.status === 404) return { status: 'error', error: 'nessuna release pubblicata' };
    if (!res.ok) return { status: 'error', error: `GitHub ha risposto ${res.status}` };
    const body = await res.text();
    if (body.length > MAX_BODY_BYTES) return { status: 'error', error: 'risposta troppo grande' };
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return { status: 'error', error: 'risposta non valida' };
    }
    const info = parseRelease(json);
    if (!info) return { status: 'error', error: 'release non valida' };
    return isNewer(info.version, current) ? { status: 'available', info } : { status: 'none', latest: info.version };
  } catch (e) {
    return { status: 'error', error: ctrl.signal.aborted ? 'tempo scaduto' : `rete non raggiungibile (${(e as Error).message})` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * La preferenza "controlla gli aggiornamenti", nel file delle impostazioni dell'app
 * (~/.keystone/app-settings.json, uguale per tutti i profili). Predefinito: attivo.
 */
export class AppSettings {
  constructor(private file: string) {}

  private read(): Record<string, unknown> {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^﻿/, '')) as unknown;
      return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  get updateCheck(): boolean {
    return this.read().updateCheck !== false;
  }

  setUpdateCheck(on: boolean): void {
    const next = { ...this.read(), updateCheck: on };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}

/** Spento da ambiente (test, CI, chi non vuole nessuna richiesta di rete): vale sopra l'interruttore. */
export function updateCheckForcedOff(env: NodeJS.ProcessEnv): boolean {
  const v = env.KEYSTONE_NO_UPDATE_CHECK?.trim().toLowerCase();
  return !!v && v !== '0' && v !== 'false';
}

/**
 * Il controllo nel processo main: stato, controllo automatico (se attivo) e controllo a richiesta.
 * `fetchFn` e i timer si passano dall'esterno, così i test non toccano la rete.
 */
export class UpdateChecker {
  private status: UpdateStatus;
  private timers: NodeJS.Timeout[] = [];
  private listeners = new Set<(s: UpdateStatus) => void>();

  constructor(
    private opts: { current: string; settings: AppSettings; fetchFn: FetchLike; forcedOff: boolean; now?: () => number },
  ) {
    this.status = { current: opts.current, enabled: opts.settings.updateCheck, forcedOff: opts.forcedOff, checking: false };
  }

  get state(): UpdateStatus {
    return this.status;
  }

  onChange(cb: (s: UpdateStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }

  /** Il controllo automatico è permesso: interruttore acceso e non spento da ambiente. */
  get automatic(): boolean {
    return this.status.enabled && !this.status.forcedOff;
  }

  /** Avvia i controlli automatici (il primo dopo `firstDelayMs`), se permessi. */
  schedule(firstDelayMs = FIRST_CHECK_DELAY_MS, intervalMs = CHECK_INTERVAL_MS): void {
    this.stop();
    if (!this.automatic) return;
    const first = setTimeout(() => void this.check(), firstDelayMs);
    const every = setInterval(() => void this.check(), intervalMs);
    first.unref?.();
    every.unref?.();
    this.timers = [first, every];
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  setEnabled(on: boolean): void {
    this.opts.settings.setUpdateCheck(on);
    this.set({ enabled: on });
    if (on) this.schedule();
    else this.stop();
  }

  /** Un controllo, automatico o a richiesta. Spento da ambiente: nessuna richiesta, mai. */
  async check(): Promise<UpdateStatus> {
    if (this.status.forcedOff) return this.status;
    if (this.status.checking) return this.status;
    this.set({ checking: true });
    const result = await checkForUpdate(this.opts.current, this.opts.fetchFn);
    this.set({ checking: false, result, lastCheck: (this.opts.now ?? Date.now)() });
    return this.status;
  }

  /** Il link da aprire nel browser: solo quello di una release valida, mai un URL dal renderer. */
  releaseUrl(): string | undefined {
    const r = this.status.result;
    return r?.status === 'available' ? r.info.url : undefined;
  }
}
