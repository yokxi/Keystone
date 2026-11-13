// Prompt e istruzioni per gli agenti (uguali per ogni motore).
import { isConsoleProblem, onlyAfter, type FailedRequest, type Goal, type PageDiagnostics, type Task, type VisualReport, type Worktree } from '@keystone/shared';
import type { VisualTryResult } from './visual.js';
import type { DiffFile } from '@keystone/shared';
import { lastLines, truncate } from '../util/text.js';
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
    lines.push(...diagnosticsVsBefore(c.before.diagnostics, c.after.diagnostics));
  }
  for (const p of r.problems) lines.push(`- problema: ${p}`);
  return lines.join('\n');
}

/** Voci mostrate al massimo per tipo (errori, console, richieste) nei testi per gli agenti. */
const DIAG_LIST_MAX = 5;

export function requestText(r: FailedRequest): string {
  return `${r.method ?? 'GET'} ${r.url} → ${r.blocked ? 'bloccata (non locale)' : (r.status ?? r.failure ?? 'fallita')}`;
}

const firstLine = (s: string) => truncate(s.split('\n')[0] ?? s, 200);

/** Righe "  - …" per un elenco, con "e altre N" oltre il massimo. */
function listLines(label: string, items: string[]): string[] {
  const out = items.slice(0, DIAG_LIST_MAX).map((x) => `    - ${label}: ${x}`);
  if (items.length > DIAG_LIST_MAX) out.push(`    - … e altre ${items.length - DIAG_LIST_MAX} (${label})`);
  return out;
}

/**
 * La diagnostica di una pagina per il lead: in evidenza ciò che compare solo "dopo" (errori JS,
 * errori e avvisi in console, richieste fallite); il resto solo come conteggio.
 */
function diagnosticsVsBefore(before: PageDiagnostics | undefined, after: PageDiagnostics | undefined): string[] {
  if (!after) return [];
  const fresh = onlyAfter(before, after);
  const freshConsole = fresh.console.filter(isConsoleProblem);
  const lines: string[] = [];
  if (before && (fresh.errors.length || freshConsole.length || fresh.failedRequests.length)) {
    lines.push(`  solo dopo: ${fresh.errors.length} errori JavaScript, ${freshConsole.length} errori/avvisi in console, ${fresh.failedRequests.length} richieste fallite`);
    lines.push(...listLines('errore JS', fresh.errors.map(firstLine)), ...listLines('console', freshConsole.map((c) => `[${c.type}] ${firstLine(c.text)}`)), ...listLines('richiesta', fresh.failedRequests.map(requestText)));
  }
  const total = after.errors.length + after.console.filter(isConsoleProblem).length + after.failedRequests.length;
  const shown = fresh.errors.length + freshConsole.length + fresh.failedRequests.length;
  if (!before && total) lines.push(`  dopo: ${after.errors.length} errori JavaScript, ${after.console.filter(isConsoleProblem).length} errori/avvisi in console, ${after.failedRequests.length} richieste fallite (lato "prima" non disponibile per il confronto)`);
  else if (total > shown) lines.push(`  presenti anche prima: ${total - shown} tra errori, avvisi e richieste fallite`);
  if (after.truncated) lines.push('  (diagnostica troncata: troppe voci)');
  return lines;
}

/** Il resoconto di una prova dell'interfaccia (try_ui) per il worker. */
export function tryReport(r: VisualTryResult, opts: { withImages: boolean }): string {
  const lines = [`Prova dell'interfaccia eseguita da Keystone nel tuo worktree (${(r.durationMs / 1000).toFixed(1)} s): ${r.status === 'done' ? 'eseguita' : `NON RIUSCITA (${r.note ?? '?'})`}`];
  for (const p of r.pages) {
    const s = p.side;
    const outcome = s.error ? `passaggio non riuscito: ${s.error}` : 'passaggi riusciti';
    lines.push(`- ${p.name}${p.caption ? ` (atteso: ${p.caption})` : ''}: ${outcome}`);
    const d = s.diagnostics;
    if (!d) continue;
    const problems = d.console.filter(isConsoleProblem);
    lines.push(...listLines('errore JS', d.errors.map(firstLine)), ...listLines('console', problems.map((c) => `[${c.type}] ${firstLine(c.text)}`)), ...listLines('richiesta', d.failedRequests.map(requestText)));
    const others = d.console.length - problems.length;
    if (others) lines.push(`    - altri messaggi in console: ${others}`);
    if (!d.errors.length && !problems.length && !d.failedRequests.length) lines.push('    - nessun errore, avviso o richiesta fallita');
    if (d.truncated) lines.push('    - (diagnostica troncata: troppe voci)');
  }
  for (const p of r.problems) lines.push(`- problema: ${p}`);
  if (r.pages.some((p) => p.side.shot)) lines.push(opts.withImages ? 'Le schermate sono allegate, nello stesso ordine delle pagine.' : "Schermate non allegate: l'utente non ha attivato le schermate per gli agenti in questo repository.");
  return truncate(lines.join('\n'), 8000);
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

/**
 * Come lavorare senza far chiedere permessi inutili all'utente: le forme che la policy consente
 * da sola (fase 10). Ogni richiesta ferma il lavoro finché l'utente non risponde.
 */
export const WORK_WITHOUT_ASKING = [
  'Ogni comando che la policy non riconosce come sicuro ferma il lavoro finché l\'utente non risponde. Per non disturbarlo:',
  '- per leggere usa Read, Grep e Glob, o comandi semplici (ls, cat, git log, git diff); evita $(…) e backtick che usano l\'output di un altro comando;',
  '- resta nella tua cartella di lavoro: niente /tmp, cartelle esterne o programmi installati nel sistema (browser, editor);',
  '- usa gli script del progetto (npm test, npm run build) invece di npx.',
].join('\n');

const COMMON_RULES = (userName: string) =>
  [
    `Lavori in un team orchestrato da Keystone per ${userName}.`,
    'Comunica con i tool del team: send_message (messaggi brevi), ask_user (solo per decisioni che spettano davvero all\'utente), write_memory/read_memory (memoria condivisa), report_status.',
    'Ogni azione rischiosa passa dalla policy dei permessi: se un permesso viene negato non aggirarlo, trova un\'altra strada o chiedi con ask_user.',
    'Non fare mai git push e non cambiare la configurazione git.',
    '',
    WORK_WITHOUT_ASKING,
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
    'Crea task che cambiano il codice, il minimo necessario (anche uno solo se il lavoro è piccolo). Non creare task solo per provare, testare o fare schermate: Keystone esegue i test e la verifica visuale su ogni task.',
  ].join('\n');
}

export function workerInstructions(env: PromptEnv, wt: Worktree): string {
  return [
    COMMON_RULES(env.userName),
    '',
    `Sei un WORKER. Lavori solo nel tuo worktree: ${wt.path} (branch ${wt.branch}, base ${wt.base}).`,
    'Modifica i file con Edit e Write, non con script (python -, node -e, here-doc verso un interprete): gli script chiedono il permesso all\'utente.',
    'Esegui i test con gli script del progetto e committa sul tuo branch con messaggi chiari: git add -A && git commit -m "titolo" -m "dettagli".',
    'Non avviare browser, server o schermate: i test e la verifica visuale li esegue Keystone dopo il tuo turno.',
    'Se il repository ha la verifica visuale, durante il lavoro puoi provare le pagine con try_ui: Keystone avvia l\'app dal tuo worktree e ti dice esito, console, errori JavaScript e richieste fallite. Le prove per turno sono poche.',
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
