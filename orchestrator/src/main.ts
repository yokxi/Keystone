// Avvio dell'orchestratore da riga di comando.
//
//   npm run orchestrator -- --demo                  team simulato su un repository di prova
//   npm run orchestrator -- --repo C:\percorso\repo  team simulato sul tuo repository
//   opzioni: --home <dir> --profile <nome> --port <n> --workers <n> --goal "<testo>"
//            --sim-delay <ms> --reset --config <file> --no-config --show-config
//   le impostazioni si possono scrivere anche in ~/.keystone/config.json (vedi config-file.ts e
//   docs/configurazione.md); la riga di comando ha la precedenza
//   manutenzione: --prune-worktrees, --remove-git-guard <repo>
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { buildOrchestrator } from './bootstrap.js';
import { ENGINE_DISABLED, ENGINE_EXPERIMENTAL } from '@keystone/shared';
import { parseCodexPrices } from './engines/codex/codex-engine.js';
import { dataDir, defaultConfig } from './config.js';
import { applySettings, ConfigFile, configFileWarnings, defaultConfigFile, describeConfigFile, envSettings, loadConfigFile, mergeSettings, type Settings } from './config-file.js';
import { consoleLogger } from './core/context.js';
import { VERSION } from './core/orchestrator.js';
import { createDemoRepo, isKeystoneDemo } from './demo.js';
import { removeGuard } from './core/gitsafety.js';
import { deleteAllKeystoneBranches } from './core/branches.js';
import { claimProfile, readRunInfo, releaseProfile } from './runfile.js';
import { OrchestratorServer } from './server.js';

const HELP = `Keystone orchestratore ${VERSION}

  --demo               crea (se manca) e usa un repository di prova
  --repo <percorso>    registra un repository (radice del repo)
  --goal "<testo>"     invia subito un obiettivo
  --home <dir>         radice dello stato (default: ~/.keystone o KEYSTONE_HOME)
  --profile <nome>     profilo (default: default; con --demo: demo)
  --port <n>           porta WebSocket su 127.0.0.1 (default: 7931 o KEYSTONE_PORT)
  --workers <n>        numero di worker (1-5, default 3)
  --sim-delay <ms>     pausa tra i passi del motore sim (default 400)
  --reset              cancella lo stato del profilo prima di partire
  --ci "<comando>"     comando dei test del repository (default: rilevato, es. npm test)
  --engine sim|claude  motore degli agenti (default sim, senza API)
                       codex: non incluso in questa versione (per prove: KEYSTONE_ENABLE_CODEX=1)
  --lead-engine <m>    motore del lead (team misto); --worker-engine <m> motore dei worker
  --use-codex-login    Codex con il login ChatGPT fatto nella cartella di Keystone (solo uso personale)
  --codex-path <file>  binario codex da usare (default: quello del pacchetto @openai/codex)
  --codex-prices "input=<$>,cached=<$>,output=<$>"  stima della spesa di Codex dai token, in
                       dollari per milione di token (dal listino del modello che usi). Senza:
                       Codex mostra solo token
  --lead-model <id>    modello del lead (claude: default claude-opus-5-5)
  --worker-model <id>  modello dei worker (claude: default claude-sonnet-5-5)
  --effort <livello>   low | medium | high | xhigh | max
  --budget <dollari>   tetto di spesa per obiettivo (default 5, 0 = nessun tetto; o KEYSTONE_BUDGET_USD)
  --use-claude-login   usa il login personale di Claude Code invece della chiave API (solo uso personale)
  --record <cartella>  registra le trascrizioni dei turni Claude (per i test di replay)
  --keep-branches      conserva il branch dell'agente dopo un merge (default: eliminato)
  --user-name "<nome>" il tuo nome per gli agenti (default: git user.name; si cambia anche
                       dalla pagina Impostazioni, che ha la precedenza)
  --goal-turns <n>     limite di turni degli agenti per obiettivo (0 = nessuno; login: default 30)
  --goal-minutes <n>   limite di minuti di lavoro per obiettivo, senza le attese di una tua risposta
                       (0 = nessuno; login: default 60)

manutenzione (non avviano l'orchestratore):
  --prune-worktrees    chiude i worktree di task finiti e rimuove quelli orfani del profilo; poi
                       elenca i branch Keystone/* dei task rifiutati o abbandonati e li elimina
                       dopo conferma (--confirm-branches per confermare senza chiedere)
  --remove-git-guard <repo>  toglie dal .git/config del repository il guardiano di Keystone

  --confirm-guard      conferma senza chiedere la riga da aggiungere al .git/config dei repository
                       passati con --repo (la riga viene comunque mostrata)
  --config <file>      file di configurazione (default: config.json nella radice dello stato)
  --no-config          ignora il file di configurazione
  --show-config        mostra le impostazioni che valgono (file, ambiente, riga di comando) ed esce
  --help               questo aiuto

Le stesse impostazioni (motore, modello ed effort, anche per singolo agente, worker, limiti,
tetto di spesa, porta, login) si possono scrivere in ~/.keystone/config.json: vedi
docs/configurazione.md. La riga di comando ha la precedenza sul file e sull'ambiente.
`;

function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^(s|si|sì|y|yes)$/i.test(answer.trim()));
    });
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      demo: { type: 'boolean' },
      repo: { type: 'string', multiple: true },
      goal: { type: 'string' },
      home: { type: 'string' },
      profile: { type: 'string' },
      port: { type: 'string' },
      workers: { type: 'string' },
      'sim-delay': { type: 'string' },
      reset: { type: 'boolean' },
      ci: { type: 'string' },
      'prune-worktrees': { type: 'boolean' },
      'remove-git-guard': { type: 'string' },
      'confirm-guard': { type: 'boolean' },
      'confirm-branches': { type: 'boolean' },
      'keep-branches': { type: 'boolean' },
      'user-name': { type: 'string' },
      'goal-turns': { type: 'string' },
      'goal-minutes': { type: 'string' },
      engine: { type: 'string' },
      'lead-engine': { type: 'string' },
      'worker-engine': { type: 'string' },
      'use-codex-login': { type: 'boolean' },
      'codex-path': { type: 'string' },
      'codex-prices': { type: 'string' },
      'lead-model': { type: 'string' },
      'worker-model': { type: 'string' },
      effort: { type: 'string' },
      budget: { type: 'string' },
      'use-claude-login': { type: 'boolean' },
      record: { type: 'string' },
      config: { type: 'string' },
      'no-config': { type: 'boolean' },
      'show-config': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const log = consoleLogger(process.env.KEYSTONE_DEBUG ? 'debug' : 'info');
  const cfg = defaultConfig();
  if (values.home) cfg.home = path.resolve(values.home);
  cfg.profile = values.profile ?? (values.demo ? 'demo' : 'default');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(cfg.profile)) throw new Error(`profilo non valido: ${cfg.profile} (lettere, cifre, - e _)`);
  const configFile = values.config ? path.resolve(values.config) : defaultConfigFile(cfg.home);
  const fromFile = values['no-config'] ? undefined : loadConfigFile(configFile);
  const settings = mergeSettings(fromFile, envSettings(), cliSettings(values));
  for (const note of applySettings(cfg, settings)) log.info(note);
  // il file di configurazione (quello usato e quello predefinito) è protetto per gli agenti
  cfg.configFiles = [...new Set([configFile, defaultConfigFile(cfg.home)])];
  for (const e of new Set(cfg.agents.map((a) => a.engine))) {
    // motori non inclusi in questa versione (Codex): solo con KEYSTONE_ENABLE_CODEX=1, per prove
    if (ENGINE_DISABLED[e] && !(e === 'codex' && process.env.KEYSTONE_ENABLE_CODEX === '1')) throw new Error(ENGINE_DISABLED[e]);
    if (ENGINE_EXPERIMENTAL[e]) log.warn(`motore ${e}: ${ENGINE_EXPERIMENTAL[e]}. Usalo solo per prove.`);
  }
  // solo da riga di comando: decidono cosa viene eseguito o dove finiscono le trascrizioni
  if (values['codex-path']) cfg.codex.binPath = path.resolve(values['codex-path']);
  if (values.record) cfg.claude.recordDir = cfg.codex.recordDir = path.resolve(values.record);
  if (values.ci) cfg.ciCommand = values.ci;

  if (fromFile) {
    log.info(describeConfigFile(configFile, fromFile));
    for (const w of configFileWarnings(configFile, fromFile)) log.warn(w);
  }

  if (values['show-config']) {
    process.stdout.write(
      [
        `file di configurazione: ${values['no-config'] ? 'ignorato (--no-config)' : fromFile ? configFile : `${configFile} (assente)`}`,
        `impostazioni (file < ambiente < riga di comando): ${JSON.stringify(settings, null, 2)}`,
        `agenti: ${cfg.agents.map((a) => `${a.name} (${a.role}, ${a.engine}${a.model ? `, ${a.model}` : ''}${a.effort ? `, effort ${a.effort}` : ''})`).join('; ')}`,
        `tetto per obiettivo: ${cfg.budgetUsdPerGoal > 0 ? `$${cfg.budgetUsdPerGoal}` : 'nessuno'}; limiti: ${cfg.goalLimits ? JSON.stringify(cfg.goalLimits) : 'nessuno'}`,
        '',
      ].join('\n'),
    );
    return;
  }

  if (values['remove-git-guard']) {
    await removeGuard(path.resolve(values['remove-git-guard']));
    log.info(`guardiano di Keystone rimosso da ${path.resolve(values['remove-git-guard'])}`);
    return;
  }

  const dir = dataDir(cfg);
  const other = readRunInfo(dir);
  if (other) throw new Error(`il profilo "${cfg.profile}" è già usato dall'orchestratore con pid ${other.pid} (porta ${other.port})`);
  if (values.reset && fs.existsSync(dir)) {
    log.info(`reset del profilo ${cfg.profile}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (values['prune-worktrees']) {
    const o = buildOrchestrator(cfg, { logger: log });
    const report = await o.pruneWorktrees();
    for (const line of report) log.info(line);
    log.info(report.length ? `pulizia completata (${report.length} operazioni)` : 'nessun worktree orfano');
    // branch dei task rifiutati o abbandonati: si mostrano e si eliminano solo dopo conferma
    const stale = await o.repos.staleBranches((id) => o.tasks.get(id)?.status);
    if (!stale.length) log.info('nessun branch da eliminare');
    else {
      process.stdout.write(['', 'Branch dei task rifiutati o abbandonati:', ...stale.map((b) => `    ${b.name}  ${b.sha.slice(0, 7)}  (${b.why}${b.taskId ? `, ${b.taskId}` : ''})`), ''].join('\n') + '\n');
      let ok = !!values['confirm-branches'];
      if (!ok && process.stdin.isTTY) ok = await askYesNo(`Elimino questi ${stale.length} branch? [s/N] `);
      if (!ok) log.info('branch conservati (per eliminarli: rispondi "s" oppure usa --confirm-branches)');
      else for (const line of await o.repos.deleteStaleBranches(stale)) log.info(line);
    }
    o.store.close();
    return;
  }

  const o = buildOrchestrator(cfg, { logger: log });
  // l'arresto chiesto dall'app (prima di un aggiornamento) usa lo stesso percorso di Ctrl+C
  const server = new OrchestratorServer(o, { port: cfg.port, log, onShutdown: () => void shutdown() });
  const port = await server.listen();
  claimProfile(dir, { pid: process.pid, port, host: cfg.host, profile: cfg.profile, version: VERSION, startedAt: Date.now() });

  let stopping = false;
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    log.info('arresto: salvo lo stato…');
    try {
      await o.stop();
      await server.close();
    } finally {
      releaseProfile(dir);
      process.exit(code);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('uncaughtException', (e) => {
    log.error(`errore non gestito: ${e.stack ?? e}`);
    void shutdown(1);
  });

  const repos: Array<{ path: string; demo: boolean }> = (values.repo ?? []).map((p) => ({ path: p, demo: false }));
  if (values.demo) {
    const demoDir = path.join(cfg.home, 'demo-repo');
    const created = await createDemoRepo(demoDir);
    // con --reset il repository di prova (creato da Keystone) perde anche i branch degli agenti:
    // solo Keystone/*, mai altri
    if (values.reset && isKeystoneDemo(created, demoDir)) for (const line of await deleteAllKeystoneBranches(created)) log.info(`reset del repository di prova: ${line}`);
    // conferma automatica solo per il repository di prova creato da Keystone (marcatore + percorso)
    repos.unshift({ path: created, demo: isKeystoneDemo(created, demoDir) });
  }
  let goalRepoId: string | undefined;
  for (const r of repos) {
    // la modifica al .git/config si mostra sempre e si applica solo con conferma
    const pv = await o.repos.preview(r.path);
    let confirmed = pv.installed;
    if (!pv.installed) {
      process.stdout.write(
        [
          '',
          `Per registrare ${pv.root} Keystone aggiungerà in fondo a ${pv.configFile}:`,
          '',
          ...pv.lines.map((l) => `    ${l}`),
          '',
          'Serve a bloccare push e credenziali nei worktree degli agenti; il tuo checkout non cambia.',
          `Per toglierla: npm run orchestrator -- --remove-git-guard "${pv.root}"`,
          '',
          '',
        ].join('\n'),
      );
      if (r.demo) confirmed = true; // repository di prova creato da Keystone stesso
      else if (values['confirm-guard']) confirmed = true;
      else if (process.stdin.isTTY) confirmed = await askYesNo('Aggiungo la riga? [s/N] ');
      else throw new Error(`serve una conferma per modificare ${pv.configFile}: rilancia con --confirm-guard (o da un terminale interattivo)`);
    }
    if (!confirmed) throw new Error(`registrazione di ${pv.root} annullata: il .git/config non è stato modificato`);
    const repo = await o.repos.add(r.path, { confirmGuard: true });
    goalRepoId ??= repo.id;
    log.info(`repository: ${repo.name} (${repo.path}, branch ${repo.branch})`);
  }
  await o.start();
  log.info(`Keystone in ascolto su ws://127.0.0.1:${port} · profilo ${cfg.profile} · stato in ${dir}`);
  if (values.goal) await o.handle({ v: 1, type: 'goal.submit', text: values.goal, ...(goalRepoId ? { repoId: goalRepoId } : {}) }, () => undefined);
}

/** Le opzioni da riga di comando come impostazioni, controllate con lo stesso schema del file. */
function cliSettings(values: Record<string, string | boolean | string[] | undefined>): Settings {
  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  const num = (k: string) => (str(k) !== undefined ? Number(str(k)) : undefined);
  const raw: Record<string, unknown> = {
    engine: str('engine'),
    leadEngine: str('lead-engine'),
    workerEngine: str('worker-engine'),
    workers: num('workers'),
    leadModel: str('lead-model'),
    workerModel: str('worker-model'),
    effort: str('effort'),
    budgetUsd: num('budget'),
    goalTurns: num('goal-turns'),
    goalMinutes: num('goal-minutes'),
    port: num('port'),
    simDelayMs: num('sim-delay'),
    keepBranches: values['keep-branches'] ? true : undefined,
    userName: str('user-name')?.trim() || undefined,
    useClaudeLogin: values['use-claude-login'] ? true : undefined,
    useCodexLogin: values['use-codex-login'] ? true : undefined,
  };
  const prices = str('codex-prices');
  if (prices) {
    const p = parseCodexPrices(prices);
    raw.codexPrices = { input: p.inputPerMTok, output: p.outputPerMTok, ...(p.cachedInputPerMTok !== undefined ? { cached: p.cachedInputPerMTok } : {}) };
  }
  const clean = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  const r = ConfigFile.safeParse(clean);
  if (!r.success) {
    const flag: Record<string, string> = { leadEngine: 'lead-engine', workerEngine: 'worker-engine', leadModel: 'lead-model', workerModel: 'worker-model', budgetUsd: 'budget', goalTurns: 'goal-turns', goalMinutes: 'goal-minutes', simDelayMs: 'sim-delay', userName: 'user-name' };
    const i = r.error.issues[0]!;
    const k = String(i.path[0] ?? '');
    // il valore come l'hai scritto (non il numero convertito, che sarebbe NaN)
    const shown = str(flag[k] ?? k) ?? String(clean[k]);
    if (k === 'port') throw new Error(`porta non valida: ${shown}`);
    throw new Error(`--${flag[k] ?? k} non valido: ${shown} (${i.message})`);
  }
  return r.data;
}

main().catch((e) => {
  console.error(`Keystone: ${(e as Error).message}`);
  process.exit(1);
});
