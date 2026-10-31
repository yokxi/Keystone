// Avvio dell'orchestratore da riga di comando.
//
//   npm run orchestrator -- --demo                  team simulato su un repository di prova
//   npm run orchestrator -- --repo C:\percorso\repo  team simulato sul tuo repository
//   opzioni: --home <dir> --profile <nome> --port <n> --workers <n> --goal "<testo>"
//            --sim-delay <ms> --reset
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildOrchestrator } from './bootstrap.js';
import { dataDir, defaultAgents, defaultConfig } from './config.js';
import { consoleLogger } from './core/context.js';
import { VERSION } from './core/orchestrator.js';
import { createDemoRepo } from './demo.js';
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
  --help               questo aiuto
`;

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
  if (values.port) cfg.port = Number(values.port);
  if (values.workers) cfg.agents = defaultAgents('sim', Number(values.workers));
  if (values['sim-delay']) cfg.sim.stepDelayMs = Number(values['sim-delay']);

  const dir = dataDir(cfg);
  const other = readRunInfo(dir);
  if (other) throw new Error(`il profilo "${cfg.profile}" è già usato dall'orchestratore con pid ${other.pid} (porta ${other.port})`);
  if (values.reset && fs.existsSync(dir)) {
    log.info(`reset del profilo ${cfg.profile}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const o = buildOrchestrator(cfg, { logger: log });
  const server = new OrchestratorServer(o, { port: cfg.port, log });
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

  const repos = [...(values.repo ?? [])];
  if (values.demo) repos.unshift(await createDemoRepo(path.join(cfg.home, 'demo-repo')));
  for (const r of repos) {
    const repo = await o.repos.add(r);
    log.info(`repository: ${repo.name} (${repo.path}, branch ${repo.branch})`);
  }
  await o.start();
  log.info(`Keystone in ascolto su ws://127.0.0.1:${port} · profilo ${cfg.profile} · stato in ${dir}`);
  if (values.goal) await o.handle({ v: 1, type: 'goal.submit', text: values.goal }, () => undefined);
}

main().catch((e) => {
  console.error(`Keystone: ${(e as Error).message}`);
  process.exit(1);
});
