// Interfaccia unica dei motori (sim, Claude, Codex).
//
// Un motore esegue TURNI. Un turno parte da un prompt, in una sessione nuova o ripresa, e produce
// uno stream di eventi normalizzati (EngineEvent, vedi shared/src/engine-events.ts) che termina
// sempre con `turn_end`.
//
//   avvia sessione    -> startSession(spec)
//   riprendi sessione -> resumeSession(sessionId, spec)
//   invia messaggio   -> tra un turno e l'altro: resumeSession(sessionId, spec con il messaggio
//                        come prompt); durante un turno: i messaggi arrivano allegati al risultato
//                        dei tool del team (vedi core/tools.ts)
//   stream di eventi  -> EngineTurn.events
//   permessi          -> evento `permission_request` + EngineTurn.respond(requestId, risposta)
//
// Tutto ciò che sta attorno al turno (task, worktree, scheduling, review, merge, ripresa dopo un
// riavvio) è del team (core/team.ts) ed è identico per ogni motore: per questo un team può
// mescolarli.
import type { EngineEvent, EngineId, PermissionAnswer, Role } from '@keystone/shared';
import type { z } from 'zod';
import type { JobKind } from '../core/store.js';

export type { EngineEvent, PermissionAnswer };

export interface TeamToolResult {
  text: string;
  isError?: boolean;
}

/** Un tool del team (send_message, ask_user, ...): il motore lo espone all'agente con questo schema. */
export interface TeamTool {
  name: string;
  description: string;
  schema: z.ZodObject;
  run(args: Record<string, unknown>): Promise<TeamToolResult>;
}

export interface TurnSpec {
  agentId: string;
  agentName: string;
  role: Role;
  /** lead: il checkout dell'utente (sola lettura); worker: il suo worktree */
  cwd: string;
  prompt: string;
  /** ruolo, regole e contesto, aggiunti alle istruzioni di sistema del motore */
  instructions: string;
  model: string;
  effort?: string;
  /** ambiente del processo dell'agente e di ogni comando che lancia (identità git, sicurezza) */
  env: Record<string, string | undefined>;
  /** cartelle scrivibili oltre a `cwd` (es. la gitdir del worktree, per committare) */
  writableRoots: string[];
  tools: TeamTool[];
  /**
   * Il lavoro di cui fa parte il turno. I motori reali non ne hanno bisogno (è tutto nel prompt);
   * il motore sim lo usa per scegliere la sceneggiatura.
   */
  job: { kind: JobKind; taskId?: string; goalId?: string; /** testo dell'obiettivo (plan) o titolo del task */ title?: string };
}

export interface EngineTurn {
  readonly events: AsyncIterable<EngineEvent>;
  /** Risponde a un evento `permission_request`. */
  respond(requestId: string, answer: PermissionAnswer): void;
  /** Interrompe il turno: lo stream termina con `turn_end` status "aborted". */
  abort(reason: string): void;
}

export type AuthCheck = { ok: true; account: string } | { ok: false; message: string };

export interface EngineAdapter {
  readonly id: EngineId;
  /** nome visualizzato, es. "Claude" */
  readonly label: string;
  /** modello predefinito per un ruolo (se la configurazione non ne indica uno) */
  defaultModel(role: Role): string;
  /** nome del modello come lo mostra l'interfaccia (es. "claude-opus-5-5" -> "Opus 5.5") */
  displayModel(model: string): string;
  checkAuth(): Promise<AuthCheck>;
  startSession(spec: TurnSpec): EngineTurn;
  resumeSession(sessionId: string, spec: TurnSpec): EngineTurn;
}
