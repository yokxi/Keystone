// I tool del team, uguali per ogni motore:
//   send_message, ask_user, write_memory, read_memory, update_task, report_status, list_tasks
//   solo lead: create_task, request_merge
//   solo worker: submit_report (resoconto strutturato e pagine da verificare visivamente)
// Ogni risultato porta con sé i messaggi non letti dell'agente: così un messaggio arriva anche
// a metà turno.
import { VisualCheck, type AgentState, type TaskStatus } from '@keystone/shared';
import { z } from 'zod';
import type { TeamTool, TeamToolResult } from '../engines/types.js';
import { truncate } from '../util/text.js';
import { formatInbox } from './bus.js';
import type { Orchestrator } from './orchestrator.js';
import { boardSummary } from './prompts.js';

export interface ToolHooks {
  /** un worker ha portato il suo task in review */
  onReview(agentId: string, taskId: string): void;
  /** il lead ha chiesto modifiche a un task in review */
  onChangesRequested(taskId: string, feedback: string): void;
  /** il tabellone è cambiato (nuovi task, stati...) */
  onTasksChanged(): void;
  /** una decisione aperta dal turno (per annullarla se il turno viene interrotto) */
  onDecisionOpened(decisionId: string): void;
}

/** Il turno a cui appartengono i tool: se è interrotto, i tool non agiscono più. */
export interface TurnGuard {
  aborted(): boolean;
  /** perché è stato interrotto (pause, stop, shutdown, cancel, timeout) */
  reason(): string | undefined;
  /** si risolve quando il turno viene interrotto */
  whenAborted: Promise<void>;
}

function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<TeamToolResult>): TeamTool {
  return { name, description, schema: z.object(shape), run: run as (args: Record<string, unknown>) => Promise<TeamToolResult> };
}

export function teamTools(o: Orchestrator, agentId: string, role: 'lead' | 'worker', hooks: ToolHooks, guard: TurnGuard): TeamTool[] {
  const user = o.userName;
  const reply = (text: string, isError = false): TeamToolResult => {
    const inbox = o.bus.inbox(agentId, { markRead: true });
    const extra = inbox.length ? `\n\n[Nuovi messaggi]\n${formatInbox(inbox, (id) => o.nameOf(id), user)}` : '';
    return { text: text + extra, ...(isError ? { isError: true } : {}) };
  };
  const fail = (text: string) => reply(`Errore: ${text}`, true);
  const env = () => ({ userName: user, nameOf: (id: string) => o.nameOf(id), tasks: o.tasks.list() });

  const tools: TeamTool[] = [
    tool(
      'send_message',
      `Manda un messaggio breve a un compagno (id o nome), a "lead", a "all" o a "user" (${user}). Per le domande all'utente usa ask_user.`,
      { to: z.string().min(1), text: z.string().min(1) },
      async ({ to, text }) => {
        let target = to.trim().toLowerCase();
        if (target === 'lead') target = o.leadId;
        if (target !== 'all' && target !== 'user') {
          const id = o.resolveAgentId(target);
          if (!id) return fail(`non c'è nessun compagno "${to}". Team: ${o.agents().map((a) => a.id).join(', ')}`);
          target = id;
        }
        if (target === agentId) return fail('non puoi scrivere a te stesso');
        o.bus.send(agentId, target, text);
        return reply(`Inviato a ${target}.`);
      },
    ),
    tool(
      'ask_user',
      `Fai una domanda a ${user} e ASPETTA la risposta. Solo per decisioni che spettano davvero all'utente. Metti per prima l'opzione consigliata.`,
      { question: z.string().min(1), options: z.array(z.string()).max(6).optional(), context: z.string().optional() },
      async ({ question, options, context }) => {
        const before = o.agent(agentId);
        const d = o.createDecision({ agentId, kind: 'question', question, options: options ?? [], ...(context ? { context } : {}), ...(before?.taskId ? { taskId: before.taskId } : {}) });
        hooks.onDecisionOpened(d.id);
        o.setAgent(agentId, { state: 'waiting_user', activity: 'aspetta una tua risposta' });
        // allo spegnimento la domanda resta aperta (al riavvio la risposta riprende la sessione),
        // ma il turno non deve restare appeso ad aspettarla
        const done = await Promise.race([o.decisions.wait(d.id), guard.whenAborted.then(() => undefined)]);
        if (!done || guard.aborted()) return fail(`il turno è stato interrotto prima della risposta di ${user}`);
        o.setAgent(agentId, { state: 'thinking' as AgentState, activity: 'ha ricevuto la risposta' });
        if (done.status === 'cancelled') return reply(`La domanda è stata annullata (${done.cancelReason ?? ''}). Decidi tu e annota l'ipotesi.`);
        const ans = [done.answer?.option, done.answer?.text].filter(Boolean).join(' — ');
        return reply(`${user} ha risposto: ${ans}`);
      },
    ),
    tool(
      'write_memory',
      'Scrive una nota markdown in memoria. scope "shared" (tutto il team) o "private" (solo tu). mode "append" aggiunge in coda a una nota con lo stesso titolo.',
      { title: z.string().min(1), body: z.string(), scope: z.enum(['shared', 'private']).optional(), mode: z.enum(['replace', 'append']).optional() },
      async ({ title, body, scope, mode }) => {
        const e = o.memory.write({ scope: scope === 'private' ? agentId : 'shared', title, body, author: agentId, mode: mode ?? 'replace' });
        o.bus.feed('memory', `${o.nameOf(agentId)} ha scritto in memoria: ${e.title}`, { agentId });
        return reply(`Nota salvata: ${e.id}.`);
      },
    ),
    tool(
      'read_memory',
      'Legge la memoria. Con id: quella nota. Con query: le note che la contengono. Senza niente: l\'elenco delle note visibili.',
      { id: z.string().optional(), query: z.string().optional() },
      async ({ id, query }) => {
        if (id) {
          const e = o.memory.get(id) ?? o.memory.get(`shared/${id}`) ?? o.memory.get(`${agentId}/${id}`);
          if (!e || (e.scope !== 'shared' && e.scope !== agentId)) return fail(`nessuna nota ${id}`);
          return reply(`# ${e.title} (${e.id})\n\n${e.body}`);
        }
        const list = query ? o.memory.search(query, agentId) : o.memory.visibleTo(agentId);
        if (!list.length) return reply('Nessuna nota.');
        if (query && list.length <= 3) return reply(list.map((e) => `# ${e.title} (${e.id})\n\n${truncate(e.body, 3000)}`).join('\n\n---\n\n'));
        return reply(list.map((e) => `- ${e.id}: ${e.title}`).join('\n'));
      },
    ),
    tool(
      'update_task',
      role === 'lead'
        ? 'Aggiorna un task: status (todo|doing|blocked|cancelled; "doing" su un task in review = chiedi modifiche), summary, assignee, title, description.'
        : 'Aggiorna il TUO task: status "review" quando hai finito (con summary), "blocked" con blocked_reason, oppure "doing".',
      {
        task_id: z.string().min(1),
        status: z.enum(['todo', 'doing', 'review', 'blocked', 'cancelled']).optional(),
        summary: z.string().optional(),
        blocked_reason: z.string().optional(),
        assignee: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
      },
      async (a) => {
        const t = o.tasks.get(a.task_id);
        if (!t) return fail(`nessun task ${a.task_id}.\n${boardSummary(env())}`);
        if (role === 'worker') {
          if (t.assignee !== agentId) return fail(`${t.id} non è un tuo task`);
          const current = o.agent(agentId)?.taskId;
          if (current && current !== t.id) return fail(`stai lavorando su ${current}: puoi aggiornare solo quello`);
          if (a.status && !['review', 'blocked', 'doing'].includes(a.status)) return fail('un worker può impostare solo review, blocked o doing');
          if (a.assignee || a.title || a.description) return fail('solo il lead può cambiare assegnatario, titolo o descrizione');
        }
        try {
          if (a.assignee) {
            const id = o.resolveAgentId(a.assignee);
            if (!id) return fail(`nessun agente ${a.assignee}`);
            if (id === o.leadId) return fail('i task vanno assegnati ai worker');
            o.tasks.update(t.id, { assignee: id });
          }
          if (a.title) o.tasks.update(t.id, { title: a.title });
          if (a.description) o.tasks.update(t.id, { description: a.description });
          if (a.summary) o.tasks.update(t.id, { summary: a.summary });
          if (a.status && a.status !== t.status) {
            const prev = t.status;
            o.tasks.setStatus(t.id, a.status as TaskStatus, {
              force: role === 'lead' || a.status === 'review',
              ...(a.blocked_reason ? { reason: a.blocked_reason } : {}),
              ...(a.summary ? { summary: a.summary } : {}),
            });
            o.bus.feed('task', `${o.nameOf(agentId)}: ${t.id} ${prev} → ${a.status}`, { agentId });
            if (a.status === 'review' && role === 'worker') hooks.onReview(agentId, t.id);
            if (a.status === 'doing' && prev === 'review' && role === 'lead') hooks.onChangesRequested(t.id, a.summary ?? 'vedi i commenti della review');
          }
          hooks.onTasksChanged();
          return reply(`${t.id} aggiornato: ${o.tasks.require(t.id).status}.`);
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    ),
    tool('report_status', 'Dice al team cosa stai facendo (una riga breve, mostrata nel tuo pannello).', { activity: z.string().min(1).max(120) }, async ({ activity }) => {
      o.setAgent(agentId, { activity });
      return reply('ok');
    }),
    tool('list_tasks', 'Mostra il tabellone (id, stato, assegnatario, dipendenze).', {}, async () => reply(boardSummary(env()))),
  ];

  if (role === 'worker') {
    tools.push(
      tool(
        'submit_report',
        'Prima di mettere il task in review: il resoconto strutturato del lavoro e, se il repository ha la verifica visuale, le pagine da controllare. ' +
          'Keystone (non tu) avvia l’app dal branch di partenza e dal tuo worktree, esegue i passaggi e confronta le schermate. ' +
          'visual_checks: [{ name, path (es. "/" o "/impostazioni", sempre relativo all’app), steps: [{ action: "click"|"fill"|"press"|"wait"|"goto", selector?, value?, key?, path? }], caption: cosa si dovrebbe vedere }].',
        {
          task_id: z.string().min(1),
          request: z.string().min(1).max(4000).describe('la richiesta originale, con parole tue'),
          changes: z.string().min(1).max(8000).describe('cosa hai cambiato'),
          why: z.string().min(1).max(8000).describe('perché, e le alternative scartate'),
          verification: z.string().min(1).max(8000).describe('come l’hai verificato (test, comandi, controlli)'),
          open_issues: z.string().max(4000).describe('problemi aperti o rischi; "nessuno" se non ce ne sono'),
          visual_checks: z.array(VisualCheck).max(10).optional(),
        },
        async (a) => {
          const t = o.tasks.get(a.task_id);
          if (!t) return fail(`nessun task ${a.task_id}`);
          if (t.assignee !== agentId) return fail(`${t.id} non è un tuo task`);
          for (const c of a.visual_checks ?? []) {
            for (const p of [c.path, ...c.steps.flatMap((s) => (s.action === 'goto' ? [s.path] : []))]) {
              if (!p.startsWith('/') || p.startsWith('//')) return fail(`percorso "${p}" non valido: deve iniziare con / (una pagina della stessa app)`);
            }
          }
          o.tasks.update(t.id, {
            report: { request: a.request, changes: a.changes, why: a.why, verification: a.verification, openIssues: a.open_issues },
            ...(a.visual_checks ? { visualChecks: a.visual_checks } : {}),
          });
          const repo = t.repoId ? o.repos.get(t.repoId) : undefined;
          const note = a.visual_checks?.length ? (repo?.visual ? ` Keystone verificherà ${a.visual_checks.length} pagine.` : ' (la verifica visuale non è configurata per questo repository: le pagine sono annotate ma non verificate)') : '';
          return reply(`Resoconto registrato per ${t.id}.${note} Ora: update_task("${t.id}", status "review", summary).`);
        },
      ),
    );
  }

  if (role === 'lead') {
    tools.push(
      tool(
        'create_task',
        'Crea un task per un worker. deps = id dei task che devono essere completati prima. Restituisce l\'id del nuovo task.',
        {
          title: z.string().min(1),
          description: z.string().describe('cosa fare e criteri di accettazione'),
          deps: z.array(z.string()).optional(),
          assignee: z.string().optional(),
          priority: z.number().int().optional(),
        },
        async ({ title, description, deps, assignee, priority }) => {
          const goal = o.currentGoal();
          let who: string | undefined;
          if (assignee) {
            who = o.resolveAgentId(assignee);
            if (!who) return fail(`nessun worker ${assignee}`);
            if (who === o.leadId) return fail('i task vanno assegnati ai worker, non a te');
          }
          try {
            const t = o.tasks.create({
              title,
              description,
              deps: deps ?? [],
              createdBy: agentId,
              ...(who ? { assignee: who } : {}),
              ...(priority !== undefined ? { priority } : {}),
              ...(goal ? { goalId: goal.id } : {}),
              ...(goal?.repoId ? { repoId: goal.repoId } : {}),
            });
            o.bus.feed('task', `${o.nameOf(agentId)} ha creato ${t.id}: ${t.title}`, { agentId });
            hooks.onTasksChanged();
            return reply(`Creato ${t.id}.`);
          } catch (e) {
            return fail((e as Error).message);
          }
        },
      ),
      tool(
        'request_merge',
        `Dopo la review di un task in "review": manda a ${user} la decisione di merge. Decide ${user}; non aspetti.`,
        { task_id: z.string().min(1), summary: z.string().min(1).describe(`2-4 righe per ${user}: cosa cambia, come è stato verificato, rischi`) },
        async ({ task_id, summary }) => {
          const t = o.tasks.get(task_id);
          if (!t) return fail(`nessun task ${task_id}`);
          if (t.status !== 'review') return fail(`${t.id} è ${t.status}, non in review`);
          if (!t.worktree || !t.repoId) return fail(`${t.id} non ha un worktree da unire`);
          const open = o.decisions.open().find((d) => d.kind === 'merge' && d.taskId === t.id);
          if (open) return reply(`La decisione di merge ${open.id} per ${t.id} aspetta già ${user}.`);
          const d = await o.openMergeDecision(t, summary);
          if (!d) {
            hooks.onTasksChanged();
            return reply(`${t.id} non ha modificato nessun file: chiuso come completato, niente da unire.`);
          }
          return reply(`Decisione di merge ${d.id} inviata a ${user}.`);
        },
      ),
    );
  }

  // un turno interrotto non deve più cambiare nulla, anche se il motore continua per un attimo
  for (const t of tools) {
    const inner = t.run;
    t.run = async (args) => (guard.aborted() ? fail('il tuo turno è stato interrotto: non è cambiato nulla') : inner(args));
  }
  return tools;
}


