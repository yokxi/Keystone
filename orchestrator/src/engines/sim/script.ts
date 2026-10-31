// La sceneggiatura predefinita del motore sim. È deterministica e idempotente: un turno ripreso
// dopo un riavvio non duplica task né commit.
//
// I marcatori (markers.ts) nel testo dell'obiettivo o nel titolo di un task esercitano i vari
// flussi: domande, permessi, task bloccati, task senza modifiche, test che falliscono.
//
// Pianificazione: l'obiettivo diviso su ";" o a capo diventa un task per parte (indipendenti);
// un obiettivo semplice diventa due task, il secondo dipendente dal primo.
import { hasMarker, SIM_MARKERS as M } from './markers.js';
import type { SimContext } from './sim-engine.js';

export type SimScript = (ctx: SimContext) => Promise<string | undefined>;

export function planTitles(goal: string): Array<{ title: string; dependsOnPrevious: boolean }> {
  const parts = goal
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length > 1) return parts.map((title) => ({ title, dependsOnPrevious: false }));
  const g = parts[0] ?? goal.trim();
  return [
    { title: `Prepara: ${g}`, dependsOnPrevious: false },
    { title: `Completa: ${g}`, dependsOnPrevious: true },
  ];
}

/** Estrae dall'output di list_tasks le righe "t3 [todo] Titolo ..." -> mappa titolo -> id. */
function existingTasks(listOutput: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of listOutput.split('\n')) {
    const m = /^- (t\d+) \[[a-z]+\] (.+?)(?: \(|$)/.exec(line.trim());
    if (m) out.set(m[2]!, m[1]!);
  }
  return out;
}

async function leadPlan(ctx: SimContext): Promise<string> {
  const goal = ctx.spec.job.title ?? 'obiettivo';
  await ctx.say(ctx.resumed ? 'Riprendo la pianificazione.' : `Leggo il repository per pianificare: ${goal}`);
  await ctx.tool('Glob', { pattern: '**/*' }, async () => (await ctx.git(['ls-files'])).stdout.split('\n').slice(0, 50).join('\n'));
  const board = await ctx.team('list_tasks', {});
  const known = existingTasks(board.text);
  const plan = planTitles(goal);
  let prev: string | undefined;
  const ids: string[] = [];
  for (const p of plan) {
    let id = known.get(p.title);
    if (!id) {
      const res = await ctx.team('create_task', {
        title: p.title,
        description: `Parte dell'obiettivo "${goal}". Criterio: il file keystone-sim/<task>.md descrive il lavoro.`,
        ...(p.dependsOnPrevious && prev ? { deps: [prev] } : {}),
      });
      id = /\b(t\d+)\b/.exec(res.text)?.[1];
      if (!id) throw new Error(`create_task non ha restituito un id: ${res.text}`);
    }
    ids.push(id);
    prev = id;
  }
  await ctx.team('write_memory', {
    title: 'Piano',
    scope: 'shared',
    body: `Obiettivo: ${goal}\n\n${plan.map((p, i) => `- ${ids[i]}: ${p.title}${p.dependsOnPrevious ? ` (dopo ${ids[i - 1]})` : ''}`).join('\n')}`,
  });
  ctx.usage(1200, 300);
  return `Piano pronto: ${ids.join(', ')}.`;
}

async function workerWork(ctx: SimContext): Promise<string> {
  const taskId = ctx.spec.job.taskId ?? 't?';
  const title = ctx.spec.job.title ?? taskId;
  await ctx.say(ctx.resumed ? `Riprendo ${taskId}.` : `Inizio ${taskId}: ${title}`);
  await ctx.tool('Read', { file_path: 'README.md' }, async () => ctx.readFile('README.md') ?? '(nessun README)');

  if (hasMarker(title, M.block)) {
    await ctx.team('update_task', { task_id: taskId, status: 'blocked', blocked_reason: 'serve una decisione esterna (sim)' });
    return `${taskId} bloccato.`;
  }

  let note = '';
  if (hasMarker(title, M.question)) {
    // ripreso dopo un riavvio con la risposta nel prompt: come farebbe un modello, non richiede
    const earlier = ctx.resumed ? /Risposta: (.+?)\. \(La domanda/.exec(ctx.spec.prompt)?.[1] : undefined;
    if (earlier) note = `\nScelta dell'utente (ricevuta prima del riavvio): ${earlier}\n`;
    else {
      const res = await ctx.team('ask_user', { question: `Per ${taskId}: preferisci la variante A o B?`, options: ['A', 'B'], context: title });
      note = `\nScelta dell'utente: ${res.text}\n`;
    }
  }
  if (hasMarker(title, M.permission)) {
    const a = await ctx.permission('Bash', { command: 'curl https://example.com' }, 'controllo di un servizio esterno');
    note += a.allow ? '\nControllo esterno eseguito.\n' : '\nControllo esterno non autorizzato: ne faccio a meno.\n';
  }

  if (!hasMarker(title, M.empty)) {
    const file = `keystone-sim/${taskId}.md`;
    await ctx.writeFile(file, `# ${title}\n\nLavoro svolto da ${ctx.spec.agentName} (motore sim).\n${note}`);
    if (hasMarker(title, M.failingTest) || hasMarker(title, M.alwaysFailingTest)) await ctx.writeFile(testFile(taskId), simTest(false));
    await ctx.tool('Bash', { command: 'git add -A && git commit' }, async () => {
      await ctx.git(['add', '-A']);
      const st = await ctx.git(['status', '--porcelain']);
      if (!st.stdout.trim()) return 'niente da committare';
      const c = await ctx.git(['commit', '-q', '-m', `${taskId}: ${title}`]);
      if (c.code !== 0) throw new Error(`commit fallito: ${c.stderr.trim()}`);
      return 'commit creato';
    });
  }
  ctx.usage(2400, 600);
  await ctx.team('update_task', { task_id: taskId, status: 'review', summary: hasMarker(title, M.empty) ? 'Analisi senza modifiche ai file.' : `Creato keystone-sim/${taskId}.md.` });
  return `${taskId} pronto per la review.`;
}

async function workerFollowup(ctx: SimContext): Promise<string> {
  const taskId = ctx.spec.job.taskId;
  if (!taskId) {
    await ctx.team('send_message', { to: 'user', text: 'Ricevuto.' });
    return 'ok';
  }
  const title = ctx.spec.job.title ?? '';
  // conflitto con la base: unisce la base nel worktree e risolve tenendo entrambe le parti
  const conflict = /in conflitto[\s\S]*`git merge ([^`\s]+)`/.exec(ctx.spec.prompt);
  if (conflict) {
    const base = conflict[1]!;
    await ctx.tool('Bash', { command: `git merge ${base}` }, async () => {
      const m = await ctx.git(['merge', '--no-edit', base]);
      if (m.code === 0) return 'merge senza conflitti';
      const files = (await ctx.git(['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').map((f) => f.trim()).filter(Boolean);
      for (const f of files) {
        const text = ctx.readFile(f) ?? '';
        // tiene le righe di entrambe le parti, senza i marcatori di conflitto
        await ctx.writeFile(f, text.split('\n').filter((l) => !/^(<{7}|={7}|>{7})( |$)/.test(l)).join('\n'));
      }
      await ctx.git(['add', '-A']);
      const c = await ctx.git(['commit', '-q', '--no-edit']);
      if (c.code !== 0) throw new Error(`commit del merge fallito: ${c.stderr.trim()}`);
      return `conflitti risolti in: ${files.join(', ')}`;
    });
    await ctx.team('update_task', { task_id: taskId, status: 'review', summary: `Unito ${base} e risolti i conflitti.` });
    return `${taskId}: conflitto risolto.`;
  }
  // test tornati indietro: il worker corregge il test (salvo il marcatore dei test sempre rotti)
  if (/test sono falliti/.test(ctx.spec.prompt) && hasMarker(title, M.failingTest)) await ctx.writeFile(testFile(taskId), simTest(true));
  const file = `keystone-sim/${taskId}.md`;
  const before = ctx.readFile(file) ?? `# ${ctx.spec.job.title ?? taskId}\n`;
  // il feedback ricevuto (prime righe del prompt) finisce nel file, così la revisione è verificabile
  const feedback = ctx.spec.prompt.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ') || 'revisione';
  await ctx.writeFile(file, `${before.replace(/\n*$/, '\n')}\nRevisione: ${feedback.slice(0, 300)}\n`);
  await ctx.tool('Bash', { command: 'git commit' }, async () => {
    await ctx.git(['add', '-A']);
    const c = await ctx.git(['commit', '-q', '-m', `${taskId}: revisione`]);
    return c.code === 0 ? 'commit creato' : 'niente da committare';
  });
  await ctx.team('update_task', { task_id: taskId, status: 'review', summary: 'Revisione applicata.' });
  return `${taskId} rivisto.`;
}

async function leadReview(ctx: SimContext): Promise<string> {
  const taskId = ctx.spec.job.taskId ?? 't?';
  await ctx.say(`Rivedo ${taskId}.`);
  await ctx.team('request_merge', { task_id: taskId, summary: `${ctx.spec.job.title ?? taskId}: modifiche verificate dal lead (sim).` });
  ctx.usage(1500, 200);
  return `Merge di ${taskId} proposto.`;
}

async function leadFollowup(ctx: SimContext): Promise<string> {
  await ctx.team('send_message', { to: 'user', text: 'Ricevuto, ne tengo conto.' });
  return 'ok';
}

export const defaultSimScript: SimScript = async (ctx) => {
  const { role, job } = ctx.spec;
  if (role === 'lead') {
    if (job.kind === 'plan') return leadPlan(ctx);
    if (job.kind === 'review') return leadReview(ctx);
    return leadFollowup(ctx);
  }
  if (job.kind === 'work') return workerWork(ctx);
  return workerFollowup(ctx);
};

function testFile(taskId: string): string {
  return `keystone-sim/${taskId}.test.js`;
}

/** Un test per node --test che fallisce o passa (CommonJS: funziona in ogni progetto). */
function simTest(pass: boolean): string {
  return ["const test = require('node:test');", "const assert = require('node:assert');", '', "test('verifica del sim', () => {", `  assert.strictEqual(${pass ? 1 : 2}, 1);`, '});', ''].join('\n');
}
