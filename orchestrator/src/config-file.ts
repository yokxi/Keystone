// Il file di configurazione ~/.keystone/config.json (Fase 7) e l'applicazione delle impostazioni.
//
// Ordine di precedenza: valori predefiniti < config.json < variabili d'ambiente (KEYSTONE_PORT,
// KEYSTONE_BUDGET_USD) < opzioni da riga di comando.
//
// Sicurezza:
//  - schema rigido: una chiave sconosciuta o un valore fuori dai limiti fermano l'avvio (un errore
//    di battitura non deve tornare in silenzio ai valori predefiniti);
//  - niente chiavi, token o segreti: lo schema non ha campi per loro;
//  - nel file non ci sono le impostazioni che decidono cosa viene eseguito o dove finiscono dati
//    sensibili: il binario di Codex (--codex-path), il comando dei test (--ci) e la cartella delle
//    trascrizioni (--record) restano solo da riga di comando;
//  - il file deve essere un file normale (niente link simbolici o junction), di dimensione
//    limitata, e per gli agenti è un percorso protetto (scritture negate dalla policy).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { applyLoginBudget, applyLoginLimits, CAST, defaultAgents, type OrchestratorConfig } from './config.js';

export const CONFIG_FILE_NAME = 'config.json';
export const CONFIG_FILE_MAX_BYTES = 64 * 1024;

const Engine = z.enum(['sim', 'claude', 'codex']);
const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
/** id di modello: una parola, senza spazi né caratteri di controllo (es. claude-opus-5-5, claude-sonnet-5-5[1m]) */
const ModelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/, 'id di modello non valido');
const AgentId = z.enum(CAST.map((c) => c.id) as [string, ...string[]]);

const AgentOverride = z
  .object({
    engine: Engine.optional(),
    model: ModelId.optional(),
    effort: Effort.optional(),
  })
  .strict();

/** Il contenuto di config.json: tutte le chiavi sono facoltative. */
export const ConfigFile = z
  .object({
    /** motore di tutti gli agenti; leadEngine / workerEngine per un team misto */
    engine: Engine.optional(),
    leadEngine: Engine.optional(),
    workerEngine: Engine.optional(),
    /** numero di worker (1-5) */
    workers: z.number().int().min(1).max(5).optional(),
    /** modello del lead e dei worker, per il motore del loro ruolo */
    leadModel: ModelId.optional(),
    workerModel: ModelId.optional(),
    /** effort di tutti; leadEffort solo per il lead */
    effort: Effort.optional(),
    leadEffort: Effort.optional(),
    /** motore, modello ed effort di un singolo agente (ada, bruno, chiara, dario, elena, fabio) */
    agents: z.partialRecord(AgentId, AgentOverride).optional(),
    /** tetto di spesa per obiettivo in dollari (0 = nessun tetto) */
    budgetUsd: z.number().min(0).max(10_000).optional(),
    /** limiti per obiettivo (0 = nessun limite) */
    goalTurns: z.number().int().min(0).max(10_000).optional(),
    goalMinutes: z.number().min(0).max(100_000).optional(),
    port: z.number().int().min(0).max(65_535).optional(),
    /** pausa tra i passi del motore sim */
    simDelayMs: z.number().int().min(0).max(60_000).optional(),
    keepBranches: z.boolean().optional(),
    /** il tuo nome per gli agenti (la pagina Impostazioni ha la precedenza) */
    userName: z.string().trim().min(1).max(80).regex(/^[^\r\n\t]+$/, 'una riga sola').optional(),
    /** login personale di Claude Code / ChatGPT al posto della chiave API (solo uso personale) */
    useClaudeLogin: z.boolean().optional(),
    useCodexLogin: z.boolean().optional(),
    /** prezzi per stimare la spesa di Codex, in dollari per milione di token */
    codexPrices: z
      .object({
        input: z.number().min(0).max(10_000),
        cached: z.number().min(0).max(10_000).optional(),
        output: z.number().min(0).max(10_000),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ConfigFile = z.infer<typeof ConfigFile>;

/** Le impostazioni da applicare: config.json, ambiente e riga di comando hanno la stessa forma. */
export type Settings = ConfigFile;

export class ConfigFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigFileError';
  }
}

export function defaultConfigFile(home: string): string {
  return path.join(home, CONFIG_FILE_NAME);
}

/**
 * Legge config.json. File assente: nessuna impostazione (`undefined`). File presente ma non
 * valido, non normale o troppo grande: errore, l'avvio si ferma.
 */
export function loadConfigFile(file: string): ConfigFile | undefined {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigFileError(`${file}: non leggibile (${(e as Error).message})`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new ConfigFileError(`${file}: non è un file normale (link simbolico o junction?): non lo leggo`);
  if (st.size > CONFIG_FILE_MAX_BYTES) throw new ConfigFileError(`${file}: troppo grande (${st.size} byte, massimo ${CONFIG_FILE_MAX_BYTES})`);
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ConfigFileError(`${file}: JSON non valido (${(e as Error).message})`);
  }
  const r = ConfigFile.safeParse(json);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 5).map((i) => {
      const where = i.path.length ? i.path.join('.') : '(radice)';
      const unknown = i.code === 'unrecognized_keys' ? `chiave sconosciuta: ${(i as { keys?: string[] }).keys?.join(', ') ?? ''}` : i.message;
      return `${where}: ${unknown}`;
    });
    throw new ConfigFileError(`${file}: configurazione non valida\n  ${issues.join('\n  ')}`);
  }
  return r.data;
}

const LEAD_ID = CAST.find((c) => c.role === 'lead')!.id;

/**
 * Le impostazioni più specifiche che un'impostazione generale sostituisce: chi ha la precedenza (la
 * riga di comando sul file) vince anche su quelle. Esempio: `--engine sim` vale anche se il file ha
 * `leadEngine: "codex"` o `agents.bruno.engine: "codex"`.
 */
function clearSpecific(out: Settings, key: keyof Settings): void {
  const agents = (pick: (id: string) => boolean, field: 'engine' | 'model' | 'effort') => {
    if (!out.agents) return;
    for (const [id, o] of Object.entries(out.agents)) if (o && pick(id)) delete o[field];
  };
  const all = () => true;
  const lead = (id: string) => id === LEAD_ID;
  const worker = (id: string) => id !== LEAD_ID;
  if (key === 'engine') {
    delete out.leadEngine;
    delete out.workerEngine;
    agents(all, 'engine');
  } else if (key === 'leadEngine') agents(lead, 'engine');
  else if (key === 'workerEngine') agents(worker, 'engine');
  else if (key === 'effort') {
    delete out.leadEffort;
    agents(all, 'effort');
  } else if (key === 'leadEffort') agents(lead, 'effort');
  else if (key === 'leadModel') agents(lead, 'model');
  else if (key === 'workerModel') agents(worker, 'model');
}

/**
 * Unisce le impostazioni in ordine di precedenza crescente; `agents` si unisce agente per agente.
 * Dentro uno stesso strato vale la più specifica (agents > leadEngine > engine); tra strati diversi
 * vince lo strato più alto, che sostituisce anche le impostazioni più specifiche di quelli sotto.
 */
export function mergeSettings(...layers: Array<Settings | undefined>): Settings {
  const out: Settings = {};
  for (const l of layers) {
    if (!l) continue;
    // prima le generali, poi le specifiche dello stesso strato (che non devono essere cancellate)
    for (const k of Object.keys(l) as Array<keyof Settings>) if (l[k] !== undefined) clearSpecific(out, k);
    for (const [k, v] of Object.entries(l) as Array<[keyof Settings, unknown]>) {
      if (v === undefined) continue;
      if (k === 'agents') {
        const merged: NonNullable<Settings['agents']> = { ...(out.agents ?? {}) };
        for (const [id, o] of Object.entries(v as NonNullable<Settings['agents']>)) merged[id] = { ...(merged[id] ?? {}), ...o };
        // un agente rimasto senza impostazioni non serve
        for (const [id, o] of Object.entries(merged)) if (!o || !Object.keys(o).length) delete merged[id];
        out.agents = merged;
      } else (out as Record<string, unknown>)[k] = v;
    }
  }
  if (out.agents) {
    for (const [id, o] of Object.entries(out.agents)) if (!o || !Object.keys(o).length) delete out.agents[id];
    if (!Object.keys(out.agents).length) delete out.agents;
  }
  return out;
}

/** Le impostazioni dalle variabili d'ambiente (le stesse che legge defaultConfig). */
export function envSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const out: Settings = {};
  const port = env.KEYSTONE_PORT?.trim();
  if (port) out.port = Number(port);
  const budget = env.KEYSTONE_BUDGET_USD?.trim();
  if (budget) out.budgetUsd = Number(budget);
  return out;
}

/**
 * Applica le impostazioni alla configurazione. `explicitBudget`: il tetto è stato chiesto
 * esplicitamente (file, ambiente o riga di comando), e vale anche con il login personale.
 * Restituisce le righe da mostrare all'avvio.
 */
export function applySettings(cfg: OrchestratorConfig, s: Settings): string[] {
  const notes: string[] = [];
  const leadEngine = s.leadEngine ?? s.engine ?? 'sim';
  const workerEngine = s.workerEngine ?? s.engine ?? 'sim';
  cfg.agents = defaultAgents({ lead: leadEngine, worker: workerEngine }, s.workers ?? 3);
  // per agente: motore, modello ed effort
  for (const [id, o] of Object.entries(s.agents ?? {})) {
    const a = cfg.agents.find((x) => x.id === id);
    if (!a || !o) {
      notes.push(`config: l'agente ${id} non è nel team (${cfg.agents.length - 1} worker): impostazioni ignorate`);
      continue;
    }
    if (o.engine) a.engine = o.engine;
    if (o.model) a.model = o.model;
    if (o.effort) a.effort = o.effort;
  }
  // modello del ruolo: vale per il motore di quel ruolo
  if (s.leadModel) cfg[leadEngine === 'codex' ? 'codex' : 'claude'].leadModel = s.leadModel;
  if (s.workerModel) cfg[workerEngine === 'codex' ? 'codex' : 'claude'].workerModel = s.workerModel;
  if (s.effort) {
    cfg.claude.effort = cfg.claude.leadEffort = s.effort;
    cfg.codex.effort = cfg.codex.leadEffort = s.effort;
  }
  if (s.leadEffort) cfg.claude.leadEffort = cfg.codex.leadEffort = s.leadEffort;
  if (s.useCodexLogin) cfg.codex.useCodexLogin = true;
  if (s.codexPrices) cfg.codex.prices = { inputPerMTok: s.codexPrices.input, ...(s.codexPrices.cached !== undefined ? { cachedInputPerMTok: s.codexPrices.cached } : {}), outputPerMTok: s.codexPrices.output };
  if (s.budgetUsd !== undefined) {
    if (!Number.isFinite(s.budgetUsd) || s.budgetUsd < 0) throw new ConfigFileError(`tetto di spesa non valido: ${s.budgetUsd}`);
    cfg.budgetUsdPerGoal = s.budgetUsd;
  }
  for (const [k, v] of [['goalTurns', s.goalTurns], ['goalMinutes', s.goalMinutes]] as const) {
    if (v !== undefined && (!Number.isFinite(v) || v < 0 || (k === 'goalTurns' && !Number.isInteger(v)))) throw new ConfigFileError(`${k} non valido: ${v}`);
  }
  const explicitLimits = { ...(s.goalTurns !== undefined ? { turns: s.goalTurns } : {}), ...(s.goalMinutes !== undefined ? { minutes: s.goalMinutes } : {}) };
  const engines = new Set(cfg.agents.map((a) => a.engine));
  if (s.useClaudeLogin) {
    cfg.claude.useClaudeLogin = true;
    notes.push(applyLoginBudget(cfg, s.budgetUsd !== undefined));
    notes.push(applyLoginLimits(cfg, explicitLimits));
  } else if (engines.has('codex')) {
    // Codex riporta solo token, non dollari: il freno sono i turni e il tempo
    notes.push(applyLoginLimits(cfg, explicitLimits).replace('login personale', 'Codex'));
    if ([...engines].every((e) => e === 'codex') && !cfg.codex.prices && s.budgetUsd === undefined) {
      cfg.budgetUsdPerGoal = 0;
      notes.push('Codex riporta token, non dollari: nessun tetto di spesa');
    }
  } else if (explicitLimits.turns || explicitLimits.minutes) {
    cfg.goalLimits = { ...(explicitLimits.turns ? { turns: explicitLimits.turns } : {}), ...(explicitLimits.minutes ? { minutes: explicitLimits.minutes } : {}) };
  }
  if (s.keepBranches) cfg.keepMergedBranches = true;
  if (s.userName?.trim()) cfg.userName = s.userName.trim();
  if (s.simDelayMs !== undefined) cfg.sim.stepDelayMs = s.simDelayMs;
  if (s.port !== undefined) {
    if (!Number.isInteger(s.port) || s.port < 0 || s.port > 65535) throw new ConfigFileError(`porta non valida: ${s.port}`);
    cfg.port = s.port;
  }
  return notes;
}

/** Avvisi su impostazioni del file che conviene vedere bene all'avvio. */
export function configFileWarnings(file: string, c: ConfigFile): string[] {
  const out: string[] = [];
  if (c.useClaudeLogin) out.push(`${file} attiva il login personale di Claude Code (useClaudeLogin): solo uso personale`);
  if (c.useCodexLogin) out.push(`${file} attiva il login ChatGPT di Codex (useCodexLogin): solo uso personale`);
  return out;
}

/** Una riga che riassume cosa imposta il file, per il log di avvio. */
export function describeConfigFile(file: string, c: ConfigFile): string {
  const keys = Object.keys(c);
  return keys.length ? `configurazione da ${file}: ${keys.join(', ')}` : `configurazione da ${file}: vuota`;
}
