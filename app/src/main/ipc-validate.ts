// Validazione dei comandi che arrivano dal renderer via IPC. Il renderer non è considerato
// affidabile: ogni comando viene verificato con lo stesso schema zod del protocollo prima di
// essere inoltrato all'orchestratore, e alcuni tipi non sono ammessi dal renderer.
import { ClientMessage, type ClientPayload } from '@keystone/shared';

/** Tipi che il renderer può mandare (hello lo gestisce il main). */
const ALLOWED = new Set<string>(['goal.submit', 'user.message', 'decision.answer', 'task.action', 'agent.action', 'diff.request', 'repo.preview', 'repo.add', 'worktrees.prune', 'goal.budget']);

export type ValidatedCommand = ClientPayload extends infer M ? (M extends { id?: string } ? Omit<M, 'id'> : never) : never;

export function validateCommand(payload: unknown): { ok: true; msg: ValidatedCommand } | { ok: false; error: string } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'comando non valido' };
  const type = (payload as { type?: unknown }).type;
  if (typeof type !== 'string' || !ALLOWED.has(type)) return { ok: false, error: `tipo di comando non ammesso: ${String(type)}` };
  // il main aggiunge versione; id e versione dal renderer vengono ignorati
  const { id: _id, v: _v, ...rest } = payload as Record<string, unknown>;
  const parsed = ClientMessage.safeParse({ ...rest, v: 1 });
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'comando'}: ${i.message}`).join('; ') };
  const { v: _v2, id: _id2, ...msg } = parsed.data as Record<string, unknown>;
  return { ok: true, msg: msg as ValidatedCommand };
}

/** Il frame che invia un messaggio IPC è la nostra pagina locale? */
export function isTrustedSender(url: string | undefined, appUrl: string): boolean {
  if (!url) return false;
  try {
    const a = new URL(url);
    const b = new URL(appUrl);
    return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname;
  } catch {
    return false;
  }
}
