// Prompt e istruzioni per gli agenti (uguali per ogni motore).
import type { Goal, Task, Worktree } from '@keystone/shared';
import type { DiffFile } from '@keystone/shared';
import { lastLines } from '../util/text.js';
import { diffToText } from './diff.js';
import type { TestResult } from './repos.js';

/** Righe finali dell'output dei test mostrate al lead e nella decisione di merge. */
export const CI_TAIL_LINES = 20;

/**
 * L'esito dei test che Keystone ha eseguito nel worktree dopo il turno del worker: comando, esito,
 * durata e output finale. È quello che il lead deve citare, non quanto riporta il worker.
 */
export function ciReport(res: TestResult | undefined): string {
  if (!res) return 'Test eseguiti da Keystone: nessuno (nessun comando di test riconosciuto nel repository).';
  const outcome = res.pass ? 'superati' : res.timedOut ? 'FALLITI (tempo massimo superato)' : `FALLITI (codice di uscita ${res.code ?? '?'})`;
  const tail = lastLines(res.output.trimEnd(), CI_TAIL_LINES);
  return [
    'Test eseguiti da Keystone nel worktree dopo il turno del worker (non riportati dal worker):',
    `- comando: ${res.command}`,
    `- esito: ${outcome}`,
    `- durata: ${(res.durationMs / 1000).toFixed(1)} s`,
    `- output finale (ultime ${CI_TAIL_LINES} righe):`,
    tail ? tail.split('\n').map((l) => `    ${l}`).join('\n') : '    (nessun output)',
  ].join('\n');
}

export interface PromptEnv {
  userName: string;
  nameOf(id: string): string;
  tasks: readonly Task[];
}

/** Il tabellone in forma testuale. Formato riga: "- t3 [todo] Titolo (dettagli)". */
export function boardSummary(env: PromptEnv, goalId?: string): string {
  const ts = env.tasks.filter((t) => !goalId || t.goalId === goalId);
  if (!ts.length) return 'Nessun task.';
  return ts
    .map((t) => {
      const extra = [t.assignee ? `assegnato a ${env.nameOf(t.assignee)}` : 'non assegnato', t.deps.length ? `dipende da ${t.deps.join(', ')}` : '', t.blockedReason ? `bloccato: ${t.blockedReason}` : '']
        .filter(Boolean)
        .join('; ');
      return `- ${t.id} [${t.status}] ${t.title} (${extra})`;
    })
    .join('\n');
}

const COMMON_RULES = (userName: string) =>
  [
    `Lavori in un team orchestrato da Keystone per ${userName}.`,
    'Comunica con i tool del team: send_message (messaggi brevi), ask_user (solo per decisioni che spettano davvero all\'utente), write_memory/read_memory (memoria condivisa), report_status.',
    'Ogni azione rischiosa passa dalla policy dei permessi: se un permesso viene negato non aggirarlo, trova un\'altra strada o chiedi con ask_user.',
    'Non fare mai git push e non cambiare la configurazione git.',
  ].join('\n');

export function leadInstructions(env: PromptEnv, workers: Array<{ id: string; name: string }>): string {
  return [
    COMMON_RULES(env.userName),
    '',
    'Sei il LEAD. Lavori in SOLA LETTURA nel checkout dell\'utente: esplori, pianifichi, rivedi. Non modifichi file.',
    `Worker disponibili: ${workers.map((w) => `${w.name} (id "${w.id}")`).join(', ') || 'nessuno'}.`,
    'Per pianificare: scrivi il piano in memoria condivisa (write_memory, titolo "Piano") e crea i task con create_task, con dipendenze (deps) solo quando servono davvero.',
    'Per rivedere: leggi diff ed esito dei test, poi request_merge se il lavoro è buono, altrimenti update_task con status "doing" e il feedback nel summary.',
    'Il merge lo approva sempre e solo l\'utente.',
  ].join('\n');
}

export function workerInstructions(env: PromptEnv, wt: Worktree): string {
  return [
    COMMON_RULES(env.userName),
    '',
    `Sei un WORKER. Lavori solo nel tuo worktree: ${wt.path} (branch ${wt.branch}, base ${wt.base}).`,
    'Modifica i file, esegui i test, committa sul tuo branch con messaggi chiari.',
    'Quando hai finito chiama update_task con status "review" e un summary (cosa hai cambiato, come l\'hai verificato). Se sei bloccato usa status "blocked" con blocked_reason.',
  ].join('\n');
}

export function planPrompt(env: PromptEnv, goal: Goal): string {
  return [`Nuovo obiettivo di ${env.userName}:`, goal.text, '', 'Tabellone attuale:', boardSummary(env, goal.id), '', 'Esplora il repository, scrivi il piano e crea i task.'].join('\n');
}

export function workPrompt(env: PromptEnv, t: Task, wt: Worktree, continuesFrom?: string): string {
  return [
    `Il tuo task: ${t.id} — ${t.title}`,
    t.description ? `\n${t.description}` : '',
    continuesFrom ? `\nRiprendi il lavoro iniziato da ${env.nameOf(continuesFrom)}: il tuo branch parte dal suo.` : '',
    `\nWorktree: ${wt.path}`,
    '\nQuando hai finito: update_task con status "review" e summary.',
  ].join('');
}

export function reviewPrompt(env: PromptEnv, t: Task, files: DiffFile[], ciNote: string): string {
  return [
    `Rivedi ${t.id} — ${t.title} (worker: ${t.assignee ? env.nameOf(t.assignee) : '?'}).`,
    t.summary ? `Riassunto del worker (quello che dice lui): ${t.summary}` : '',
    '',
    ciNote,
    '',
    'Diff:',
    diffToText(files),
    '',
    `Se va bene: request_merge("${t.id}", summary per ${env.userName}). Altrimenti: update_task("${t.id}", status "doing", summary con le modifiche richieste).`,
    `Nel summary cita l'esito dei test eseguiti da Keystone qui sopra (comando ed esito). Se il riassunto del worker dice altro, vale l'esito di Keystone: non fidarti di quanto riporta il worker.`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export const RESUME_PROMPT = 'L\'orchestratore è stato riavviato mentre lavoravi. Riprendi da dove eri rimasto.';
