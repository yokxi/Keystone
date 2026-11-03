// Prompt e istruzioni per gli agenti (uguali per ogni motore).
import type { Goal, Task, VisualReport, Worktree } from '@keystone/shared';
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

/**
 * L'esito della verifica visuale in testo (log, feed, review del lead, decisione di merge). Prima
 * riga: il riassunto.
 */
export function visualSummary(r: VisualReport): string {
  if (r.status === 'running') return 'Verifica visuale: in corso';
  if (r.status === 'skipped') return `Verifica visuale: non eseguita (${r.note ?? 'motivo sconosciuto'})`;
  const failedChecks = r.checks.filter((c) => c.before.error || c.after.error || c.after.shot?.error);
  const head =
    r.status === 'failed'
      ? `Verifica visuale: NON RIUSCITA (${r.note ?? "l'app non si è avviata"})`
      : `Verifica visuale eseguita da Keystone: ${r.checks.length} pagine${failedChecks.length ? `, ${failedChecks.length} con passaggi non riusciti` : ''}${r.problems.length ? `, ${r.problems.length} problemi` : ''}`;
  const lines = [head];
  for (const c of r.checks) {
    const side = (label: string, x: VisualReport['checks'][number]['before']) => `${label}: ${x.shot ? (x.shot.error ? `schermata, passaggio non riuscito (${x.shot.error})` : 'schermata') : `nessuna schermata (${x.error ?? '?'})`}`;
    lines.push(`- ${c.name}${c.caption ? ` (atteso: ${c.caption})` : ''}: ${side('prima', c.before)}; ${side('dopo', c.after)}`);
  }
  for (const p of r.problems) lines.push(`- problema: ${p}`);
  return lines.join('\n');
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
    'Quando hai finito: prima submit_report (richiesta, cosa hai cambiato e perché, come l\'hai verificato, problemi aperti; se il task tocca l\'interfaccia web, le pagine da verificare in visual_checks), poi update_task con status "review" e un summary. Se sei bloccato usa status "blocked" con blocked_reason.',
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
    '\nQuando hai finito: submit_report, poi update_task con status "review" e summary.',
  ].join('');
}

/** Il resoconto strutturato del worker (submit_report), in testo. */
export function workReportText(t: Task): string {
  const r = t.report;
  if (!r) return '';
  return [
    'Resoconto del worker (quello che dice lui, da verificare):',
    `- richiesta: ${r.request}`,
    `- cosa ha cambiato: ${r.changes}`,
    `- perché: ${r.why}`,
    `- come l'ha verificato: ${r.verification}`,
    `- problemi aperti: ${r.openIssues || 'nessuno'}`,
  ].join('\n');
}

export function reviewPrompt(env: PromptEnv, t: Task, files: DiffFile[], ciNote: string, opts: { withImages?: boolean } = {}): string {
  return [
    `Rivedi ${t.id} — ${t.title} (worker: ${t.assignee ? env.nameOf(t.assignee) : '?'}).`,
    t.summary ? `Riassunto del worker (quello che dice lui): ${t.summary}` : '',
    workReportText(t),
    '',
    ciNote,
    t.visual ? `\n${visualSummary(t.visual)}` : '',
    opts.withImages ? 'Le schermate prima/dopo sono allegate a questo messaggio, nello stesso ordine delle pagine qui sopra. Confrontale con quanto atteso.' : '',
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
