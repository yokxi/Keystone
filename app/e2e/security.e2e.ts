// Comportamenti di sicurezza dell'interfaccia, verificati sull'app Electron vera collegata a un
// orchestratore (motore sim):
//  1. i permessi che richiedono sempre approvazione sono rossi, hanno solo "Consenti una volta" e
//     "Nega" e mostrano il comando completo;
//  2. la registrazione di un repository mostra le righe del guardiano e, senza conferma, non
//     modifica il .git/config;
//  3. il merge parte solo dal pulsante nella schermata di review;
//  4. la review si apre sul riassunto (diff in una scheda a parte) e "Richiedi modifiche" può
//     salvare la correzione come skill, che poi l'agente riceve.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../orchestrator/src/core/context.js';
import type { Orchestrator } from '../../orchestrator/src/core/orchestrator.js';
import { OrchestratorServer } from '../../orchestrator/src/server.js';
import { gitOut } from '../../orchestrator/src/util/git.js';
import { demoRepo, noReply, onCleanup, testOrchestrator, tmpDir, waitFor } from '../../orchestrator/test/helpers.js';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const electronPath = createRequire(import.meta.url)('electron') as unknown as string;

async function setup(opts: { workers?: number; goal?: string } = {}) {
  const { o, cfg } = testOrchestrator({ workers: opts.workers ?? 1 });
  const repo = await demoRepo(cfg.home);
  await o.repos.add(repo, { confirmGuard: true });
  await o.start();
  const server = new OrchestratorServer(o, { port: 0, log: silentLogger });
  const port = await server.listen();
  onCleanup(() => server.close());
  const app: ElectronApplication = await electron.launch({
    executablePath: electronPath,
    args: [APP_DIR],
    env: { ...process.env, KEYSTONE_HOME: cfg.home, KEYSTONE_PROFILE: cfg.profile, KEYSTONE_PORT: String(port) },
  });
  onCleanup(() => app.close());
  const page = await app.firstWindow();
  await page.getByRole('button', { name: /Ada/ }).first().waitFor({ timeout: 30_000 }); // connesso: il team è in barra laterale
  if (opts.goal) await o.handle({ v: 1, type: 'goal.submit', text: opts.goal }, noReply);
  return { o, repo, page, home: cfg.home };
}

const nav = (page: Page, name: string) => page.locator('.sidebar .nav-item', { hasText: name }).click();

async function waitDecisions(o: Orchestrator, pred: (kinds: string[]) => boolean, what: string) {
  await waitFor(() => pred(o.decisions.open().map((d) => (d.kind === 'permission' && d.alwaysAsk ? 'strict' : d.kind))), what, 60_000);
}

describe('interfaccia: comportamenti di sicurezza', () => {
  it('permesso che richiede sempre approvazione: rosso, solo "Consenti una volta" e "Nega", comando completo', async () => {
    const { o, page } = await setup({ workers: 2, goal: 'Normalizza i fine riga [permesso-config]; Verifica il servizio [permesso]' });
    await waitDecisions(o, (k) => k.includes('strict') && k.includes('permission'), 'un permesso rigido e uno normale');
    await nav(page, 'Decisioni');

    const strictDecision = o.decisions.open().find((d) => d.alwaysAsk)!;
    const strict = page.getByTestId(`decision-${strictDecision.id}`);
    await expect.poll(() => strict.getAttribute('class')).toContain('strict');
    expect(await strict.locator('.strict-banner').textContent()).toContain('Richiede sempre la tua approvazione');
    // il comando completo, esattamente com'è
    expect((await strict.locator('.command-block').textContent())?.trim()).toBe(strictDecision.command);
    // solo due pulsanti: nessun "Consenti sempre"
    const buttons = (await strict.locator('.decision-actions button').allTextContents()).map((t) => t.trim());
    expect(buttons).toEqual(['Consenti una volta', 'Nega']);
    // il colore del bordo è quello "rigido", diverso dagli altri permessi
    const strictBorder = await strict.evaluate((el) => getComputedStyle(el).borderTopColor);

    const normalDecision = o.decisions.open().find((d) => d.kind === 'permission' && !d.alwaysAsk)!;
    const normal = page.getByTestId(`decision-${normalDecision.id}`);
    expect(await normal.getAttribute('class')).not.toContain('strict');
    expect(await normal.locator('.decision-actions button').allTextContents()).toContain('Consenti sempre per questo agente');
    expect(await normal.evaluate((el) => getComputedStyle(el).borderTopColor)).not.toBe(strictBorder);

    await strict.getByRole('button', { name: 'Consenti una volta' }).click();
    await waitFor(() => o.decisions.get(strictDecision.id)?.status === 'answered', 'risposta registrata');
    expect(o.decisions.get(strictDecision.id)?.answer?.option).toBe('Consenti una volta');
    expect(o.store.data.permissionRules.bruno ?? []).toEqual([]); // niente regola permanente
  });

  it('registrazione di un repository: mostra le righe del guardiano; senza conferma il .git/config non cambia', async () => {
    const { o, page } = await setup();
    const other = await demoRepo(tmpDir());
    const configFile = path.join(other, '.git', 'config');
    const before = fs.readFileSync(configFile, 'utf8');
    const expected = await o.repos.preview(other);

    await nav(page, 'Repository');
    await page.getByRole('button', { name: 'Registra repository' }).click();
    await page.getByPlaceholder('C:\\percorso\\del\\repository').fill(other);
    await page.getByRole('button', { name: 'Anteprima' }).click();
    const preview = page.locator('.config-preview');
    await preview.waitFor();
    const shown = (await preview.textContent()) ?? '';
    for (const line of expected.lines) expect(shown).toContain(line.trim());
    expect(shown).toContain(expected.configFile);

    await page.getByRole('button', { name: 'Annulla' }).click();
    await page.waitForTimeout(500);
    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
    expect(o.repos.list()).toHaveLength(1);

    // controprova: con la conferma la riga viene aggiunta
    await page.getByRole('button', { name: 'Registra repository' }).click();
    await page.getByPlaceholder('C:\\percorso\\del\\repository').fill(other);
    await page.getByRole('button', { name: 'Anteprima' }).click();
    await page.getByRole('button', { name: 'Conferma e registra' }).click();
    await waitFor(() => o.repos.list().length === 2, 'repository registrato');
    expect(fs.readFileSync(configFile, 'utf8')).toContain('includeIf');
  });

  it('il merge parte solo dal pulsante nella review', async () => {
    const { o, repo, page } = await setup({ goal: 'Aggiungi un saluto' });
    await waitDecisions(o, (k) => k.includes('merge'), 'decisione di merge');
    const d = o.decisions.open().find((x) => x.kind === 'merge')!;
    const head = await gitOut(repo, ['rev-parse', 'HEAD']);

    // nella coda delle decisioni non c'è un pulsante di merge: solo "Apri la review"
    await nav(page, 'Decisioni');
    const card = page.getByTestId(`decision-${d.id}`);
    expect((await card.locator('button').allTextContents()).map((t) => t.trim())).toEqual(['Apri la review']);

    // dalla console il merge non parte: rimanda alla review
    const input = page.getByPlaceholder('Scrivi un obiettivo, @agente messaggio, oppure /aiuto');
    await input.fill(`/rispondi ${d.id} 1`);
    await input.press('Enter');
    await page.getByText('rispondi dalla schermata di review').waitFor();
    expect(o.decisions.get(d.id)?.status).toBe('open');
    expect(await gitOut(repo, ['rev-parse', 'HEAD'])).toBe(head);

    // la console ha aperto la review, sul riassunto: il diff è nella sua scheda
    await page.getByTestId('review-summary').waitFor();
    await page.getByRole('tab', { name: /Diff/ }).click();
    await page.locator('.diff-file').first().waitFor();
    await page.locator('.review-side').getByRole('button', { name: 'Merge', exact: true }).click();
    await waitFor(() => o.tasks.get(d.taskId!)?.status === 'done', 'task unito', 60_000);
    expect(await gitOut(repo, ['rev-parse', 'HEAD'])).not.toBe(head);
    expect(await gitOut(repo, ['status', '--porcelain'])).toBe('');
  });

  it('review sul riassunto; "Richiedi modifiche" salva la correzione come skill e il worker la riceve', async () => {
    const { o, page, home } = await setup({ goal: 'Aggiungi un saluto' });
    await waitDecisions(o, (k) => k.includes('merge'), 'decisione di merge');
    const d = o.decisions.open().find((x) => x.kind === 'merge')!;
    await nav(page, 'Decisioni');
    await page.getByTestId(`decision-${d.id}`).getByRole('button', { name: 'Apri la review' }).click();

    // si apre sul riassunto: richiesta, file, test, rischi; niente diff finché non si apre la scheda
    const summary = page.getByTestId('review-summary');
    await summary.waitFor();
    await page.getByTestId('review-risks').waitFor();
    await page.getByTestId('review-tests').waitFor();
    expect(await page.locator('.diff-file').count()).toBe(0);
    await page.getByRole('tab', { name: /Diff/ }).click();
    await page.locator('.diff-file').first().waitFor();
    await page.getByRole('tab', { name: 'Riassunto' }).click();
    await summary.waitFor();

    // la correzione diventa una skill personale
    await page.getByPlaceholder('Cosa va cambiato…').fill('Scrivi sempre i commenti in italiano');
    await page.getByTestId('save-as-skill').check();
    await page.getByTestId('skill-inline').waitFor();
    await page.getByRole('button', { name: 'Richiedi modifiche e salva la skill' }).click();
    const file = path.join(home, 'skills', 'scrivi-sempre-i-commenti-in-italiano.md');
    await waitFor(() => fs.existsSync(file), 'file della skill');
    expect(fs.readFileSync(file, 'utf8')).toContain('per: worker');
    await waitFor(() => o.decisions.get(d.id)?.status === 'answered', 'richiesta di modifiche');
    expect(o.decisions.get(d.id)?.answer).toEqual({ option: 'Richiedi modifiche', text: 'Scrivi sempre i commenti in italiano' });

    // la pagina Skill la mostra
    await nav(page, 'Skill');
    await page.getByTestId('skill-list').getByText('Scrivi sempre i commenti in italiano').waitFor();

    // il worker riprende il task con la skill, e il suo pannello lo dice
    await waitFor(() => o.agent('bruno')?.skills?.some((s) => s.id === 'scrivi-sempre-i-commenti-in-italiano'), 'skill consegnata al worker', 60_000);
    await nav(page, 'Agenti');
    await page.locator('.agent-card', { hasText: 'Bruno' }).click();
    await page.getByTestId('agent-skills').getByText('Scrivi sempre i commenti in italiano').waitFor();
  });
});
