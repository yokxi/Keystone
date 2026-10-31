// Persistenza. Tutto ciò che l'orchestratore sa vive sotto `dir` e sopravvive a riavvii e crash:
//
//   <dir>/state.json        stato completo (scrittura atomica, con debounce)
//   <dir>/state.json.bak    la versione precedente, usata se state.json fosse illeggibile
//   <dir>/logs/<agente>.jsonl  log degli agenti, solo in aggiunta, ruotati a LOG_MAX_BYTES
//   <dir>/memory/...        memoria in markdown (core/memory.ts)
//   <dir>/worktrees/...     worktree git dei task (core/repos.ts)
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Decision, FeedItem, Goal, LogEntry, Repo, Task } from '@keystone/shared';
import { ensureDir, readJson, writeFileAtomic } from '../util/fsx.js';

export interface BusMessage {
  id: string;
  ts: number;
  /** id di un agente oppure "user" */
  from: string;
  /** id di un agente, "user" oppure "all" */
  to: string;
  text: string;
  /** agenti che hanno già letto il messaggio */
  readBy: string[];
}

export interface SessionRecord {
  sessionId: string;
  engine: string;
  model?: string;
  updatedAt: number;
}

export type JobKind = 'plan' | 'work' | 'review' | 'followup';

/** Un turno in corso, salvato per riprenderlo dopo un riavvio. */
export interface InflightJob {
  kind: JobKind;
  sessionKey: string;
  prompt: string;
  taskId?: string;
  goalId?: string;
  startedAt: number;
}

export interface TeamState {
  inflight: Record<string, InflightJob>;
  /** solleciti già inviati per task (worker che finisce il turno senza update_task) */
  nudges: Record<string, number>;
  /** volte in cui un task è tornato al worker per test falliti */
  ciFixes: Record<string, number>;
}

/** Dati di un worktree unito, per mostrarne ancora il diff. Chiave: `<repo>/<worktree>`. */
export interface WorktreeMeta {
  forkSha?: string;
  mergedSha?: string;
}

export interface StateData {
  version: 1;
  createdAt: number;
  agents: Agent[];
  tasks: Task[];
  goals: Goal[];
  decisions: Decision[];
  repos: Repo[];
  feed: FeedItem[];
  messages: BusMessage[];
  counters: Record<string, number>;
  /** chiave: `<agente>:<task>` oppure `<lead>:<goal>` */
  sessions: Record<string, SessionRecord>;
  /** agentId -> chiavi di regola "consenti sempre" */
  permissionRules: Record<string, string[]>;
  team: TeamState;
  worktreeMeta: Record<string, WorktreeMeta>;
}

export const FEED_LIMIT = 300;
export const MESSAGE_LIMIT = 500;
export const DECISION_LIMIT = 500;
export const LOG_TAIL = 200;
export const LOG_MAX_BYTES = 8 * 1024 * 1024;
const TAIL_READ_BYTES = 256 * 1024;

export function emptyState(now: number): StateData {
  return {
    version: 1,
    createdAt: now,
    agents: [],
    tasks: [],
    goals: [],
    decisions: [],
    repos: [],
    feed: [],
    messages: [],
    counters: {},
    sessions: {},
    permissionRules: {},
    team: { inflight: {}, nudges: {}, ciFixes: {} },
    worktreeMeta: {},
  };
}

/** Completa uno stato caricato da disco con i campi che una versione precedente non aveva. */
function normalize(raw: Partial<StateData>, now: number): StateData {
  const base = emptyState(now);
  const out = { ...base, ...raw } as StateData;
  out.team = { ...base.team, ...(raw.team ?? {}) };
  return out;
}

function readTailLines(file: string, maxBytes: number): string[] {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, maxBytes);
    if (!len) return [];
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    // se non si parte dall'inizio del file, la prima riga è parziale
    if (len < size) text = text.slice(text.indexOf('\n') + 1);
    return text.split('\n').filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export interface StoreOptions {
  /** attesa prima di scrivere dopo una modifica (raggruppa le modifiche ravvicinate) */
  debounceMs?: number;
  now?: () => number;
  onWarn?: (msg: string) => void;
}

export class Store {
  readonly dir: string;
  readonly file: string;
  readonly logsDir: string;
  data: StateData;
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private closed = false;
  private tails = new Map<string, LogEntry[]>();
  private readonly debounceMs: number;

  constructor(dir: string, opts: StoreOptions = {}) {
    this.dir = ensureDir(dir);
    this.file = path.join(dir, 'state.json');
    this.logsDir = ensureDir(path.join(dir, 'logs'));
    this.debounceMs = opts.debounceMs ?? 100;
    const now = (opts.now ?? Date.now)();
    this.data = this.load(now, opts.onWarn ?? (() => undefined));
  }

  private load(now: number, warn: (msg: string) => void): StateData {
    for (const f of [this.file, `${this.file}.bak`]) {
      try {
        const raw = readJson<Partial<StateData>>(f);
        if (raw === undefined) continue;
        if (raw.version !== 1) throw new Error(`versione di stato non supportata: ${String(raw.version)}`);
        if (f !== this.file) warn(`state.json illeggibile: ripristinato da ${path.basename(f)}`);
        return normalize(raw, now);
      } catch (e) {
        // il file corrotto viene conservato per analisi, mai sovrascritto in silenzio
        const keep = `${f}.corrupt-${now}`;
        try {
          fs.copyFileSync(f, keep);
        } catch {
          /* ignora */
        }
        warn(`${path.basename(f)} non è leggibile (${(e as Error).message}); copia in ${path.basename(keep)}`);
      }
    }
    return emptyState(now);
  }

  /** Prossimo id con prefisso: t1, t2, ... (contatori persistiti). */
  nextId(prefix: string): string {
    const n = (this.data.counters[prefix] ?? 0) + 1;
    this.data.counters[prefix] = n;
    this.markDirty();
    return `${prefix}${n}`;
  }

  markDirty(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Scrive subito lo stato su disco (se è cambiato). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const json = `${JSON.stringify(this.data, null, 2)}\n`;
    // la versione precedente diventa il backup, poi la nuova la sostituisce in modo atomico
    try {
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    } catch {
      /* il backup è un aiuto, non un requisito */
    }
    writeFileAtomic(this.file, json);
  }

  close(): void {
    this.flush();
    this.closed = true;
  }

  // ---- liste con limite ----

  pushFeed(item: FeedItem): void {
    this.data.feed.push(item);
    if (this.data.feed.length > FEED_LIMIT) this.data.feed.splice(0, this.data.feed.length - FEED_LIMIT);
    this.markDirty();
  }

  pushMessage(m: BusMessage): void {
    this.data.messages.push(m);
    if (this.data.messages.length > MESSAGE_LIMIT) this.data.messages.splice(0, this.data.messages.length - MESSAGE_LIMIT);
    this.markDirty();
  }

  // ---- log degli agenti ----

  private logFile(agentId: string): string {
    return path.join(this.logsDir, `${agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
  }

  appendLog(agentId: string, entries: LogEntry[]): void {
    if (!entries.length) return;
    const file = this.logFile(agentId);
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl'));
    } catch {
      /* rotazione al prossimo giro */
    }
    fs.appendFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    const tail = this.logTail(agentId);
    tail.push(...entries);
    if (tail.length > LOG_TAIL) tail.splice(0, tail.length - LOG_TAIL);
  }

  /** Le ultime righe di log di un agente (lette da disco la prima volta). */
  logTail(agentId: string): LogEntry[] {
    let tail = this.tails.get(agentId);
    if (!tail) {
      tail = [];
      for (const line of readTailLines(this.logFile(agentId), TAIL_READ_BYTES)) {
        try {
          tail.push(JSON.parse(line) as LogEntry);
        } catch {
          /* riga troncata da un crash: si salta */
        }
      }
      tail.splice(0, Math.max(0, tail.length - LOG_TAIL));
      this.tails.set(agentId, tail);
    }
    return tail;
  }
}
