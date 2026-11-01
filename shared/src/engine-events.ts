// Eventi normalizzati emessi da ogni motore (sim, Claude, Codex) durante un turno.
//
// Ogni adattatore traduce il proprio stream (messaggi dell'Agent SDK, notifiche JSON-RPC di
// Codex, sceneggiatura del sim) in questi eventi. L'orchestratore li consuma in un solo punto
// (core/team.ts) e ne ricava log, stato degli agenti, costi e richieste di permesso, senza sapere
// quale motore li ha prodotti. Sono descritti in docs/protocol.md.
import { z } from 'zod';

const JsonObject = z.record(z.string(), z.unknown());

/** Il motore conosce l'id della sessione (da salvare per riprenderla). */
export const SessionEvent = z.object({ type: z.literal('session'), sessionId: z.string().min(1) });
/** Il modello effettivamente in uso (es. "claude-opus-5-5"). */
export const ModelEvent = z.object({ type: z.literal('model'), model: z.string().min(1) });
/** Testo dell'agente (ragionamento visibile o risposta). */
export const TextEvent = z.object({ type: z.literal('text'), text: z.string() });
/**
 * L'agente chiama un tool. `tool` usa un vocabolario comune: Read, Grep, Glob, Edit, Write, Bash,
 * PowerShell, oppure il nome di un tool del team (send_message, update_task, ...).
 */
export const ToolCallEvent = z.object({ type: z.literal('tool_call'), callId: z.string(), tool: z.string(), input: JsonObject });
/** Esito di una tool call. */
export const ToolResultEvent = z.object({ type: z.literal('tool_result'), callId: z.string(), ok: z.boolean(), output: z.string() });
/** Un file è stato modificato (path relativo alla cartella di lavoro). */
export const FileChangeEvent = z.object({
  type: z.literal('file_change'),
  path: z.string(),
  change: z.enum(['add', 'modify', 'delete']),
  /** diff unificato del cambiamento, se il motore lo conosce */
  diff: z.string().optional(),
});
/**
 * Il motore chiede se può usare un tool. Il turno resta in attesa finché l'orchestratore non
 * risponde con `EngineTurn.respond(requestId, answer)` (la policy decide, o chiede all'utente).
 */
export const PermissionRequestEvent = z.object({
  type: z.literal('permission_request'),
  requestId: z.string(),
  tool: z.string(),
  input: JsonObject,
  /** motivazione fornita dal motore, se c'è */
  reason: z.string().optional(),
});
/** Consumo del turno: valori INCREMENTALI (da sommare), non cumulativi. */
export const UsageEvent = z.object({
  type: z.literal('usage'),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** costo in dollari, se il motore lo riporta (Codex riporta solo token) */
  costUsd: z.number().nonnegative().optional(),
  /** totale cumulativo della sessione secondo il motore: la base per l'incremento del turno dopo */
  sessionTotalUsd: z.number().nonnegative().optional(),
  /**
   * parte di `costUsd` contata per prudenza: il motore non sa dire se la sessione ripresa aveva
   * ritrovato la spesa precedente, quindi la considera consumata (può essere contata due volte)
   */
  unreconciledUsd: z.number().nonnegative().optional(),
});
/** Errore non fatale o fatale; `auth` = errore di autenticazione. */
export const ErrorEvent = z.object({ type: z.literal('error'), message: z.string(), auth: z.boolean().optional() });
/** Fine del turno: sempre l'ultimo evento. */
export const TurnEndEvent = z.object({
  type: z.literal('turn_end'),
  /** budget: il turno ha esaurito la quota di spesa che gli era stata riservata (non il tetto dell'obiettivo) */
  status: z.enum(['success', 'error', 'aborted', 'max_turns', 'budget']),
  /** testo finale dell'agente */
  resultText: z.string().optional(),
});

export const EngineEvent = z.discriminatedUnion('type', [
  SessionEvent,
  ModelEvent,
  TextEvent,
  ToolCallEvent,
  ToolResultEvent,
  FileChangeEvent,
  PermissionRequestEvent,
  UsageEvent,
  ErrorEvent,
  TurnEndEvent,
]);
export type EngineEvent = z.infer<typeof EngineEvent>;
export type TurnEndStatus = z.infer<typeof TurnEndEvent>['status'];

export const ENGINE_EVENT_TYPES = EngineEvent.options.map((o) => o.shape.type.value);

/** Risposta a una richiesta di permesso. */
export type PermissionAnswer = { allow: true } | { allow: false; message: string };
