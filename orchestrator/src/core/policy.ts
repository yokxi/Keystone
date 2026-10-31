// Policy dei permessi: decide se un agente può usare un tool.
//
//   allow -> si procede senza chiedere
//   ask   -> diventa una decisione "permesso" per l'utente
//   deny  -> rifiutato sempre
//
// Principio: TUTTO CIÒ CHE NON È ESPLICITAMENTE CONSENTITO CHIEDE.
//
// Fase 2 (questa versione) consente solo:
//  - letture (Read/Grep/Glob) dentro la cartella di lavoro o le cartelle di lettura extra (memoria)
//  - scritture (Edit/Write) dentro il worktree, solo per i worker
// e nega le scritture del lead e ogni comando che contiene "git push". Qualunque comando di shell
// chiede. In Fase 3 arrivano il classificatore dei comandi (comandi di sviluppo sicuri,
// percorsi fuori dal worktree, rete, comandi distruttivi, configurazione git, `git -c`, ...) e le
// chiavi "consenti sempre" con ambito preciso.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isInsideOrEqual } from '../util/fsx.js';

export type Verdict =
  | { action: 'allow'; reason: string }
  | { action: 'ask'; reason: string; ruleKey: string }
  | { action: 'deny'; reason: string };

export interface PolicyContext {
  role: 'lead' | 'worker';
  /** worktree (worker) o checkout dell'utente in sola lettura (lead) */
  cwd: string;
  /** cartelle leggibili oltre a cwd */
  readDirs?: string[];
  /** chiavi "consenti sempre" già approvate per questo agente */
  alwaysAllow?: readonly string[];
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** Percorso reale (risolve i link simbolici) della parte esistente di `p`. */
function realish(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function inside(root: string, target: string): boolean {
  return isInsideOrEqual(root, path.resolve(root, target)) && isInsideOrEqual(realish(root), realish(path.resolve(root, target)));
}

function pathOf(input: Record<string, unknown>): string | undefined {
  for (const k of ['file_path', 'path', 'notebook_path']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

export function exactKey(tool: string, input: Record<string, unknown>): string {
  const h = crypto.createHash('sha256').update(`${tool}\n${JSON.stringify(input)}`).digest('hex').slice(0, 16);
  return `${tool}:exact:${h}`;
}

export function classify(tool: string, input: Record<string, unknown>, ctx: PolicyContext): Verdict {
  const verdict = classifyRaw(tool, input, ctx);
  if (verdict.action === 'ask' && ctx.alwaysAllow?.includes(verdict.ruleKey)) return { action: 'allow', reason: `consentito sempre (${verdict.ruleKey})` };
  return verdict;
}

function classifyRaw(tool: string, input: Record<string, unknown>, ctx: PolicyContext): Verdict {
  if (READ_TOOLS.has(tool)) {
    const p = pathOf(input) ?? '.';
    const roots = [ctx.cwd, ...(ctx.readDirs ?? [])];
    if (roots.some((r) => inside(r, path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p)))) return { action: 'allow', reason: 'lettura dentro la cartella di lavoro' };
    const dir = path.dirname(path.resolve(ctx.cwd, p));
    return { action: 'ask', reason: `lettura fuori dalla cartella di lavoro: ${p}`, ruleKey: `Read:${dir}` };
  }
  if (WRITE_TOOLS.has(tool)) {
    if (ctx.role === 'lead') return { action: 'deny', reason: 'il lead non modifica file: lavora in sola lettura nel checkout dell\'utente' };
    const p = pathOf(input);
    if (!p) return { action: 'ask', reason: `${tool} senza percorso`, ruleKey: exactKey(tool, input) };
    if (inside(ctx.cwd, path.resolve(ctx.cwd, p))) return { action: 'allow', reason: 'modifica dentro il worktree' };
    const dir = path.dirname(path.resolve(ctx.cwd, p));
    return { action: 'ask', reason: `scrittura fuori dal worktree: ${p}`, ruleKey: `Write:${dir}` };
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = typeof input.command === 'string' ? input.command : '';
    if (/\bgit\b[\s\S]*\bpush\b/i.test(command)) return { action: 'deny', reason: 'git push non è mai consentito' };
    return { action: 'ask', reason: `comando di shell: ${command.slice(0, 200)}`, ruleKey: exactKey(tool, { command }) };
  }
  if (tool === 'WebFetch' || tool === 'WebSearch') return { action: 'ask', reason: 'accesso alla rete', ruleKey: exactKey(tool, input) };
  return { action: 'ask', reason: `tool non riconosciuto: ${tool}`, ruleKey: exactKey(tool, input) };
}

/** Descrizione breve di una chiamata, per il testo della richiesta di permesso. */
export function describeCall(tool: string, input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return `${tool}: ${input.command}`;
  const p = pathOf(input);
  if (p) return `${tool} ${p}`;
  return `${tool} ${JSON.stringify(input).slice(0, 160)}`;
}
