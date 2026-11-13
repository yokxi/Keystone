// Flussi completi con il motore sim: obiettivo -> piano -> worktree -> commit -> review -> decisioni.
import fs from 'node:fs';
import path from 'node:path';
import type { Decision } from '@keystone/shared';
import { describe, expect, it } from 'vitest';
import type { Orchestrator } from '../src/core/orchestrator.js';
import { gitOut } from '../src/util/git.js';
import { demoRepo, noReply, testOrchestrator, waitFor } from './helpers.js';

async function setup(opts: Parameters<typeof testOrchestrator>[0] = {}) {
  const { o, cfg } = testOrchestrator(opts);
  const repo = await demoRepo(cfg.home);
  await o.repos.add(repo, { confirmGuard: true });
  await o.start();
  return { o, repo, cfg };
}

const submit = (o: Orchestrator, text: string) => o.handle({ v: 1, type: 'goal.submit', text }, noReply);
const openDecision = (o: Orchestrator, pred: (d: Decision) => boolean) => o.decisions.open().find(pred);
const answer = (o: Orchestrator, id: string, option?: string, text?: string) =>
  o.handle({ v: 1, type: 'decision.answer', decisionId: id, ...(option ? { option } : {}), ...(text ? { text } : {}) }, noReply);

describe('flusso con il motore sim', () => {
  it('obiettivo semplice: piano con dipendenza, lavoro nel worktree, review, decisione di merge', async () => {
    const { o, repo } = await setup();
    const headBefore = await gitOut(repo, ['rev-parse', 'HEAD']);
    const res = await submit(o, 'Aggiungi un saluto in inglese');
    expect(res).toEqual({ goalId: 'g1' });

    const merge = await waitFor(() => openDecision(o, (d) => d.kind === 'merge'), 'decisione di merge');
    expect(merge).toMatchObject({ taskId: 't1', agentId: 'ada', options: ['Merge', 'Richiedi modifiche', 'Rifiuta'] });
    await o.team.idle();

    const [t1, t2] = o.tasks.list();
    expect(t1).toMatchObject({ id: 't1', title: 'Prepara: Aggiungi un saluto in inglese', status: 'review', assignee: 'bruno' });
    expect(t2).toMatchObject({ id: 't2', status: 'todo', deps: ['t1'] }); // aspetta il merge di t1
    expect(o.goal('g1')).toMatchObject({ status: 'active', progress: 0.375 });

    // il lavoro è un commit vero sul branch dell'agente, con la sua identità
    expect(t1!.branch).toBe('Keystone/bruno/t1-prepara-aggiungi-un-saluto-in');
    expect(await gitOut(repo, ['log', '-1', '--format=%an <%ae>|%s', t1!.branch!])).toBe('Keystone Bruno <bruno@keystone.local>|t1: Prepara: Aggiungi un saluto in inglese');
    expect(await gitOut(repo, ['show', `${t1!.branch}:keystone-sim/t1.md`])).toContain('Lavoro svolto da Bruno');

    // il checkout dell'utente non è stato toccato
    expect(await gitOut(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await gitOut(repo, ['status', '--porcelain'])).toBe('');
    expect(fs.existsSync(path.join(repo, 'keystone-sim'))).toBe(false);

    // memoria condivisa, log e stato degli agenti
    expect(o.memory.get('shared/piano')?.body).toContain('t2: Completa: Aggiungi un saluto in inglese (dopo t1)');
    expect(o.store.logTail('bruno').some((l) => l.kind === 'diff')).toBe(true);
    expect(o.agent('bruno')).toMatchObject({ engine: 'sim', model: 'Sim' });
    expect(o.status.tokens).toBeGreaterThan(0);
  });

  it('merge approvato: il task si chiude, il dipendente parte e l\'obiettivo si completa', async () => {
    const { o, repo } = await setup();
    await submit(o, 'Aggiungi un saluto');
    const m1 = await waitFor(() => openDecision(o, (d) => d.kind === 'merge' && d.taskId === 't1'), 'merge di t1');
    expect(m1.context).toMatch(/Test eseguiti da Keystone[^\n]*\n- comando: npm test\n- esito: superati/);
    await answer(o, m1.id, 'Merge');
    expect(o.tasks.get('t1')?.status).toBe('done');
    expect(await gitOut(repo, ['status', '--porcelain'])).toBe('');
    expect(fs.existsSync(path.join(repo, 'keystone-sim', 't1.md'))).toBe(true);
    // t2 dipendeva da t1: ora parte, e parte dal codice già unito
    const m2 = await waitFor(() => openDecision(o, (d) => d.kind === 'merge' && d.taskId === 't2'), 'merge di t2');
    await answer(o, m2.id, 'Merge');
    expect(o.goal('g1')).toMatchObject({ status: 'done', progress: 1 });
    expect(await gitOut(repo, ['status', '--porcelain'])).toBe('');
    expect(fs.existsSync(path.join(repo, 'keystone-sim', 't2.md'))).toBe(true);
    const merges = (await gitOut(repo, ['log', '--merges', '--format=%an|%s'])).split('\n');
    expect(merges).toHaveLength(2);
    // il merge approvato è dell'utente: la sua identità git, non quella di un agente
    const userName = await gitOut(repo, ['config', 'user.name']);
    expect(merges.every((l) => l.startsWith(`${userName}|Merge Keystone/`))).toBe(true);
    // due cicli completi con i test del repository e due merge: ~14 s da solo, ma con la suite in
    // parallelo può superare i 60 s predefiniti (fallito una volta così il 13 novembre 2026)
  }, 120_000);

  it('merge rifiutato perché il checkout ha modifiche: la decisione si riapre con il motivo', async () => {
    const { o, repo } = await setup();
    await submit(o, 'Aggiungi un saluto');
    const m = await waitFor(() => openDecision(o, (d) => d.kind === 'merge'), 'decisione di merge');
    fs.appendFileSync(path.join(repo, 'index.js'), '// modifica in corso dell\'utente\n');
    const headBefore = await gitOut(repo, ['rev-parse', 'HEAD']);
    await answer(o, m.id, 'Merge');
    expect(o.decisions.get(m.id)).toMatchObject({ status: 'open' });
    expect(o.decisions.get(m.id)?.context).toMatch(/modifiche non committate/);
    expect(o.tasks.get('t1')?.status).toBe('review');
    expect(await gitOut(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    // l'utente committa le sue modifiche e riprova: ora il merge passa
    await gitOut(repo, ['-c', 'user.name=U', '-c', 'user.email=u@u', 'commit', '-qam', 'lavoro dell\'utente']);
    await answer(o, m.id, 'Merge');
    expect(o.tasks.get('t1')?.status).toBe('done');
  });

  it('conflitto al merge: il branch torna al worker, che unisce la base, risolve e richiede la review', async () => {
    const { o, repo } = await setup();
    await submit(o, 'Aggiungi un saluto');
    const m1 = await waitFor(() => openDecision(o, (d) => d.kind === 'merge'), 'prima decisione');
    // nel frattempo sulla base arriva un altro lavoro che tocca lo stesso file
    fs.mkdirSync(path.join(repo, 'keystone-sim'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'keystone-sim', 't1.md'), '# Versione arrivata prima sulla base\n');
    await gitOut(repo, ['add', '-A']);
    await gitOut(repo, ['-c', 'user.name=U', '-c', 'user.email=u@u', 'commit', '-qm', 'lavoro parallelo']);
    await answer(o, m1.id, 'Merge');
    expect(o.decisions.get(m1.id)).toMatchObject({ status: 'cancelled' });
    expect(o.decisions.get(m1.id)?.cancelReason).toMatch(/conflitto.*rimandato a Bruno/);
    const m2 = await waitFor(() => openDecision(o, (d) => d.kind === 'merge' && d.id !== m1.id), 'nuova decisione dopo la risoluzione');
    expect(m2.taskId).toBe('t1');
    const branch = o.tasks.get('t1')!.branch!;
    const resolved = await gitOut(repo, ['show', `${branch}:keystone-sim/t1.md`]);
    expect(resolved).toContain('Versione arrivata prima sulla base');
    expect(resolved).toContain('Lavoro svolto da Bruno');
    expect(resolved).not.toMatch(/^(<{7}|>{7})/m);
    await answer(o, m2.id, 'Merge');
    expect(o.tasks.get('t1')?.status).toBe('done');
    expect(await gitOut(repo, ['status', '--porcelain'])).toBe('');
  });

  it('test falliti: il task torna al worker una volta e, corretto, va in review', async () => {
    const { o } = await setup({ workers: 1 });
    await submit(o, 'Aggiungi un test [test-rotto]; Altro [vuoto]');
    const m = await waitFor(() => openDecision(o, (d) => d.kind === 'merge' && d.taskId === 't1'), 'merge di t1', 60_000);
    expect(o.tasks.get('t1')?.ci).toBe('pass');
    expect(o.store.data.team.ciFixes.t1).toBe(1);
    expect(o.store.logTail('bruno').some((l) => l.text.startsWith('test FALLITI'))).toBe(true);
    expect(m.context).toMatch(/- esito: superati/);
  });

  it('test che falliscono anche dopo la correzione: in review con il fallimento annotato', async () => {
    const { o } = await setup({ workers: 1 });
    await submit(o, 'Aggiungi un test [test-sempre-rotto]; Altro [vuoto]');
    const m = await waitFor(() => openDecision(o, (d) => d.kind === 'merge' && d.taskId === 't1'), 'merge di t1', 60_000);
    const t = o.tasks.get('t1')!;
    expect(t.ci).toBe('fail');
    expect(t.summary).toMatch(/i test falliscono ancora/);
    expect(m.context).toMatch(/- esito: FALLITI \(codice di uscita \d+\)/);
    expect(o.store.data.team.ciFixes.t1).toBe(1); // rimandato al worker una sola volta
  });

  it('worktrees.prune dal protocollo chiude i worktree di task finiti', async () => {
    const { o } = await setup();
    await submit(o, 'Aggiungi un saluto');
    await waitFor(() => openDecision(o, (d) => d.kind === 'merge'), 'decisione');
    await o.team.idle();
    await o.handle({ v: 1, type: 'task.action', taskId: 't2', action: 'cancel' }, noReply);
    const t1 = o.tasks.get('t1')!;
    const res = await o.handle({ v: 1, type: 'worktrees.prune' }, noReply);
    // t1 è in review: il suo worktree resta
    expect(o.repos.findWorktree(t1.repoId!, t1.worktree!)?.status).toBe('active');
    expect(Array.isArray(res?.report)).toBe(true);
  });

  it('obiettivo in più parti: task indipendenti lavorati in parallelo da worker diversi', async () => {
    const { o } = await setup({ workers: 3 });
    await submit(o, 'Aggiungi la data; Aggiungi l\'ora; Aggiungi il fuso orario');
    await waitFor(() => o.decisions.open().filter((d) => d.kind === 'merge').length === 3, 'tre decisioni di merge');
    await o.team.idle();
    const assignees = o.tasks.list().map((t) => t.assignee);
    expect(new Set(assignees).size).toBe(3);
    expect(o.tasks.list().every((t) => t.status === 'review')).toBe(true);
  });

  it('[domanda]: il worker chiede all\'utente e usa la risposta', async () => {
    const { o, repo } = await setup({ workers: 1 });
    await submit(o, 'Scegli il formato [domanda]; Altro lavoro');
    const q = await waitFor(() => openDecision(o, (d) => d.kind === 'question'), 'domanda');
    expect(q).toMatchObject({ agentId: 'bruno', options: ['A', 'B'], taskId: 't1' });
    expect(o.agent('bruno')?.state).toBe('waiting_user');
    await answer(o, q.id, '2', 'perché è più semplice');
    await waitFor(() => openDecision(o, (d) => d.kind === 'merge' && d.taskId === 't1'), 'merge di t1');
    const branch = o.tasks.get('t1')!.branch!;
    expect(await gitOut(repo, ['show', `${branch}:keystone-sim/t1.md`])).toContain('Aurora ha risposto: B — perché è più semplice');
  });

  it('[permesso]: un comando di rete diventa una richiesta; "Nega" viene rispettato', async () => {
    const { o, repo } = await setup({ workers: 1 });
    await submit(o, 'Verifica il servizio [permesso]; Altro');
    const p = await waitFor(() => openDecision(o, (d) => d.kind === 'permission'), 'richiesta di permesso');
    expect(p.question).toContain('curl https://example.com');
    expect(p.options).toEqual(['Consenti una volta', 'Consenti sempre per questo agente', 'Nega']);
    await answer(o, p.id, 'Nega');
    await waitFor(() => openDecision(o, (d) => d.kind === 'merge' && d.taskId === 't1'), 'merge di t1');
    expect(await gitOut(repo, ['show', `${o.tasks.get('t1')!.branch}:keystone-sim/t1.md`])).toContain('non autorizzato');
    expect(o.store.data.permissionRules.bruno ?? []).toEqual([]);
  });

  it('"Consenti sempre" memorizza la regola per quell\'agente', async () => {
    const { o } = await setup({ workers: 1 });
    await submit(o, 'Verifica [permesso]; Verifica ancora [permesso]');
    const p1 = await waitFor(() => openDecision(o, (d) => d.kind === 'permission'), 'primo permesso');
    await answer(o, p1.id, 'Consenti sempre per questo agente');
    expect(o.store.data.permissionRules.bruno).toHaveLength(1);
    // il secondo task chiede lo stesso comando: non serve più chiedere
    await waitFor(() => o.decisions.open().filter((d) => d.kind === 'merge').length === 1, 'merge del primo task');
    await o.team.idle();
    expect(o.decisions.list().filter((d) => d.kind === 'permission')).toHaveLength(1);
  });

  it('"Richiedi modifiche": il worker rivede il task e arriva una nuova decisione di merge', async () => {
    const { o, repo } = await setup();
    await submit(o, 'Aggiungi un saluto');
    const m1 = await waitFor(() => openDecision(o, (d) => d.kind === 'merge'), 'prima decisione');
    await answer(o, m1.id, 'Richiedi modifiche', 'aggiungi anche un esempio');
    const m2 = await waitFor(() => openDecision(o, (d) => d.kind === 'merge' && d.id !== m1.id), 'seconda decisione');
    expect(m2.taskId).toBe('t1');
    expect(await gitOut(repo, ['show', `${o.tasks.get('t1')!.branch}:keystone-sim/t1.md`])).toContain('aggiungi anche un esempio');
  });

  it('"Rifiuta": il worktree viene chiuso, il task annullato, il branch conservato', async () => {
    const { o, repo } = await setup();
    await submit(o, 'Aggiungi un saluto');
    const m = await waitFor(() => openDecision(o, (d) => d.kind === 'merge'), 'decisione');
    const t = o.tasks.get('t1')!;
    const wtPath = o.repos.requireWorktree(t.repoId!, t.worktree!).path;
    await answer(o, m.id, 'Rifiuta', 'non serve');
    expect(o.tasks.get('t1')?.status).toBe('cancelled');
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(await gitOut(repo, ['branch', '--list', t.branch!])).toContain(t.branch!);
    expect(o.agent('bruno')?.taskId).toBeUndefined();
  });

  it('[vuoto]: un task senza modifiche si chiude senza chiedere un merge', async () => {
    const { o } = await setup({ workers: 1 });
    await submit(o, 'Analizza il codice [vuoto]; Un altro task [vuoto]');
    await waitFor(() => o.tasks.list().length === 2 && o.tasks.list().every((t) => t.status === 'done'), 'task completati');
    expect(o.decisions.list().filter((d) => d.kind === 'merge')).toHaveLength(0);
    expect(o.goal('g1')).toMatchObject({ status: 'done', progress: 1 });
  });

  it('[blocca]: il task resta bloccato e l\'agente lo segnala', async () => {
    const { o } = await setup({ workers: 1 });
    await submit(o, 'Pubblica il pacchetto [blocca]; Altro [vuoto]');
    await waitFor(() => o.tasks.get('t1')?.status === 'blocked', 't1 bloccato');
    await o.team.idle();
    expect(o.tasks.get('t1')?.blockedReason).toMatch(/decisione esterna/);
  });

  it('un messaggio a un worker senza task viene girato al lead, che risponde', async () => {
    const { o } = await setup();
    await submit(o, 'Aggiungi un saluto');
    await waitFor(() => openDecision(o, (d) => d.kind === 'merge'), 'decisione');
    await o.team.idle();
    await o.handle({ v: 1, type: 'user.message', to: '@chiara', text: 'ricordati dei test' }, noReply);
    await o.team.idle();
    const said = o.store.data.messages.filter((m) => m.to === 'user').map((m) => `${m.from}: ${m.text}`);
    expect(said).toContain('chiara: Non sto lavorando a un task: giro il messaggio a Ada.');
    expect(said).toContain('ada: Ricevuto, ne tengo conto.');
  });

  it('mettere in pausa e riprendere un agente', async () => {
    const { o } = await setup({ workers: 1, script: undefined });
    await o.handle({ v: 1, type: 'agent.action', agentId: 'bruno', action: 'pause' }, noReply);
    await submit(o, 'Aggiungi un saluto');
    await waitFor(() => o.goal('g1')?.status === 'active', 'piano pronto');
    await o.team.idle();
    expect(o.tasks.get('t1')?.status).toBe('todo'); // Bruno è in pausa: nessuno lo prende
    await o.handle({ v: 1, type: 'agent.action', agentId: 'bruno', action: 'resume' }, noReply);
    await waitFor(() => openDecision(o, (d) => d.kind === 'merge'), 'decisione dopo la ripresa');
  });

  it('fermare un agente rimette il suo task sul tabellone e chi lo riprende parte dal suo branch', async () => {
    const { o, repo } = await setup({ workers: 2 });
    await submit(o, 'Scegli [domanda]; Altro [vuoto]');
    const q = await waitFor(() => openDecision(o, (d) => d.kind === 'question'), 'domanda');
    const first = o.tasks.get('t1')!.assignee!;
    await o.handle({ v: 1, type: 'agent.action', agentId: first, action: 'stop' }, noReply);
    expect(o.decisions.get(q.id)?.status).toBe('cancelled');
    expect(o.agent(first)).toMatchObject({ active: false });
    // il task passa all'altro worker, che fa di nuovo la domanda
    const q2 = await waitFor(() => openDecision(o, (d) => d.kind === 'question'), 'nuova domanda');
    const second = o.tasks.get('t1')!.assignee!;
    expect(second).not.toBe(first);
    await answer(o, q2.id, 'A');
    await waitFor(() => openDecision(o, (d) => d.kind === 'merge' && d.taskId === 't1'), 'merge');
    expect(o.tasks.get('t1')!.branch).toContain(`Keystone/${second}/`);
    expect(await gitOut(repo, ['status', '--porcelain'])).toBe('');
  });

  it('task.action: annullare, riprovare, cambiare priorità', async () => {
    const { o } = await setup({ workers: 1 });
    await submit(o, 'Pubblica [blocca]; Altro [vuoto]');
    await waitFor(() => o.tasks.get('t1')?.status === 'blocked', 'bloccato');
    await o.team.idle();
    await o.handle({ v: 1, type: 'task.action', taskId: 't1', action: 'prioritize', arg: '5' }, noReply);
    expect(o.tasks.get('t1')?.priority).toBe(5);
    await o.handle({ v: 1, type: 'task.action', taskId: 't1', action: 'cancel' }, noReply);
    expect(o.tasks.get('t1')?.status).toBe('cancelled');
    await o.handle({ v: 1, type: 'task.action', taskId: 't1', action: 'retry' }, noReply);
    await waitFor(() => o.tasks.get('t1')?.status === 'blocked', 'di nuovo bloccato dopo il retry');
    await expect(o.handle({ v: 1, type: 'task.action', taskId: 't9', action: 'cancel' }, noReply)).rejects.toThrow(/nessun task/);
  });

  it('un obiettivo senza repository registrato viene rifiutato', async () => {
    const { o } = testOrchestrator();
    await o.start();
    await expect(submit(o, 'qualcosa')).rejects.toThrow(/nessun repository/);
  });
});
