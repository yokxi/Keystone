// Memoria condivisa: note markdown su disco, leggibili e modificabili anche a mano.
//
//   <dir>/shared/<slug>.md          visibile a tutto il team
//   <dir>/agents/<agente>/<slug>.md visibile solo a quell'agente
//
// Ogni file inizia con un'intestazione minima (title / author / updated). I file aggiunti o
// modificati a mano vengono riletti con reload(); senza intestazione, il titolo è il primo
// heading o il nome del file.
import fs from 'node:fs';
import path from 'node:path';
import type { MemoryEntry } from '@keystone/shared';
import { ensureDir, writeFileAtomic } from '../util/fsx.js';
import { slugify } from '../util/text.js';
import type { Ctx } from './context.js';

export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryError';
  }
}

const HEADER_START = '---\n';
const HEADER_END = '\n---\n';

function parse(raw: string): { title?: string; author?: string; updated?: number; body: string } {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith(HEADER_START)) return { body: text.replace(/\n$/, '') };
  const end = text.indexOf(HEADER_END, HEADER_START.length - 1);
  if (end < 0) return { body: text.replace(/\n$/, '') };
  const out: { title?: string; author?: string; updated?: number; body: string } = { body: text.slice(end + HEADER_END.length).replace(/\n$/, '') };
  for (const line of text.slice(HEADER_START.length, end).split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key === 'title' && value) out.title = value;
    else if (key === 'author' && value) out.author = value;
    else if (key === 'updated' && /^\d+$/.test(value)) out.updated = Number(value);
  }
  return out;
}

function render(e: MemoryEntry): string {
  return `${HEADER_START}title: ${e.title.replace(/\n/g, ' ')}\nauthor: ${e.author ?? ''}\nupdated: ${e.updated}${HEADER_END}${e.body}\n`;
}

export interface WriteMemory {
  /** "shared" oppure l'id dell'agente */
  scope: string;
  title: string;
  body: string;
  author?: string;
  mode?: 'replace' | 'append';
}

export class Memory {
  readonly dir: string;
  private entries = new Map<string, MemoryEntry>();

  constructor(
    private ctx: Ctx,
    dir: string,
  ) {
    this.dir = ensureDir(dir);
    ensureDir(path.join(dir, 'shared'));
    ensureDir(path.join(dir, 'agents'));
    this.reload();
  }

  private fileOf(scope: string, slug: string): string {
    if (scope === 'shared') return path.join(this.dir, 'shared', `${slug}.md`);
    if (!/^[a-z0-9_-]+$/i.test(scope)) throw new MemoryError(`scope non valido: ${scope}`);
    return path.join(this.dir, 'agents', scope, `${slug}.md`);
  }

  /** Rilegge tutti i file da disco (anche quelli modificati a mano). */
  reload(): void {
    this.entries.clear();
    const readDir = (dir: string, scope: string) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        const file = path.join(dir, f);
        const slug = f.slice(0, -3);
        const p = parse(fs.readFileSync(file, 'utf8'));
        const heading = /^#\s+(.+)$/m.exec(p.body)?.[1]?.trim();
        const entry: MemoryEntry = {
          id: `${scope}/${slug}`,
          scope,
          title: p.title ?? heading ?? slug,
          body: p.body,
          updated: p.updated ?? Math.round(fs.statSync(file).mtimeMs),
          ...(p.author ? { author: p.author } : {}),
        };
        this.entries.set(entry.id, entry);
      }
    };
    readDir(path.join(this.dir, 'shared'), 'shared');
    const agentsDir = path.join(this.dir, 'agents');
    for (const a of fs.readdirSync(agentsDir)) {
      if (fs.statSync(path.join(agentsDir, a)).isDirectory()) readDir(path.join(agentsDir, a), a);
    }
  }

  list(): MemoryEntry[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): MemoryEntry | undefined {
    return this.entries.get(id);
  }

  /** Note che un agente può vedere: quelle condivise e le sue. */
  visibleTo(agentId: string): MemoryEntry[] {
    return this.list().filter((e) => e.scope === 'shared' || e.scope === agentId);
  }

  search(query: string, agentId: string): MemoryEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.visibleTo(agentId).filter((e) => {
      const hay = `${e.title}\n${e.body}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  write(w: WriteMemory): MemoryEntry {
    const title = w.title.trim();
    if (!title) throw new MemoryError('il titolo della nota è vuoto');
    const slug = slugify(title, 60);
    const id = `${w.scope}/${slug}`;
    const prev = this.entries.get(id);
    const body = w.mode === 'append' && prev ? `${prev.body}\n\n${w.body}` : w.body;
    const entry: MemoryEntry = { id, scope: w.scope, title, body, updated: this.ctx.now(), ...(w.author ? { author: w.author } : {}) };
    writeFileAtomic(this.fileOf(w.scope, slug), render(entry));
    this.entries.set(id, entry);
    this.ctx.emit({ type: 'memory.upsert', entry });
    return entry;
  }
}
