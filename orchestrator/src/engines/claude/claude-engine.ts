// Motore Claude: un `query()` dell'Claude Agent SDK (versione fissata 0.3.302) per ogni turno.
//
// Regole che questo adattatore garantisce:
//  - OGNI chiamata a un tool passa dalla policy di Keystone: un hook PreToolUse (senza filtro,
//    quindi per tutti i tool, compresi Read e i tool del team) chiede all'orchestratore e aspetta la
//    risposta; canUseTool fa lo stesso come seconda barriera. permissionMode è sempre 'default'
//    (senza, l'SDK potrebbe partire in modalità 'auto' con un classificatore): nessuna modalità che
//    salti i permessi esiste, nemmeno come opzione, e assertNoPermissionBypass() lo verifica.
//  - Nessuna configurazione dell'utente di Claude Code: CLAUDE_CONFIG_DIR punta a una cartella di
//    Keystone (niente ~/.claude: impostazioni, hook, comandi, agenti, skill, CLAUDE.md globale, MCP
//    di ~/.claude.json), settingSources: [] (niente impostazioni da file), strictMcpConfig (solo il
//    server MCP di Keystone), skills: [] e nessun plugin. Il test di isolamento lo verifica sulla
//    CLI vera. Vale anche con il login personale (opzionale): la credenziale arriva solo come
//    CLAUDE_CODE_OAUTH_TOKEN, mai dai file di ~/.claude.
//  - Le credenziali (chiave API o token di login) servono alla CLI, non agli agenti:
//    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB le toglie dall'ambiente dei sottoprocessi (Bash, server MCP
//    stdio, hook). Il test di isolamento lo verifica.
//  - Tool: solo quelli di base per ruolo (il lead non ha Edit/Write) più i tool del team; niente
//    sub-agenti, web, skill.
//  - Spesa: maxBudgetUsd = la quota riservata al turno dal team (mai più del residuo
//    dell'obiettivo meno le quote dei turni in corso), così la CLI stessa si ferma.
//  - Costi di una sessione ripresa: vedi sessionCostDelta (prudente quando non si può sapere).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, query as sdkQuery, tool as sdkTool, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent, PermissionAnswer, Role } from '@keystone/shared';
import { ensureDir } from '../../util/fsx.js';
import { redactImageData, truncate } from '../../util/text.js';
import { EventChannel, PermissionBroker } from '../channel.js';
import type { AuthCheck, EngineAdapter, EngineTurn, TeamTool, TeamToolResult, TurnSpec } from '../types.js';
import { detectApiAuth, detectClaudeLogin, envForAuth, NO_API_AUTH_MESSAGE, NO_LOGIN_TOKEN_MESSAGE } from './auth.js';
import { DEFAULT_LEAD_MODEL, DEFAULT_WORKER_MODEL, displayClaudeModel } from './models.js';
import { VERSION } from '../../version.js';

export const MCP_SERVER = 'keystone';
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;
const HOOK_TIMEOUT_S = 7 * 24 * 3600; // la risposta dell'utente può arrivare dopo molto tempo

/** Tool di base per ruolo. Il lead lavora in sola lettura nel checkout dell'utente. */
export const LEAD_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
export const WORKER_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'TodoWrite'];
/** Esclusi sempre, anche se una versione futura dell'SDK li aggiungesse ai preset. */
export const DISALLOWED_TOOLS = ['Agent', 'Task', 'Workflow', 'Skill', 'WebSearch', 'WebFetch', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree', 'CronCreate', 'ScheduleWakeup', 'PushNotification', 'SendMessage', 'Monitor', 'DesignSync'];

export interface ClaudeEngineConfig {
  leadModel?: string;
  workerModel?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  leadEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTurnsLead?: number;
  maxTurnsWorker?: number;
  /** login personale di Claude Code al posto della chiave API (solo uso personale, disattivato di default) */
  useClaudeLogin?: boolean;
  /** cartella di configurazione isolata per la CLI (CLAUDE_CONFIG_DIR) */
  configDir: string;
  /** se impostata, ogni turno viene registrato qui come trascrizione JSONL (per i test di replay) */
  recordDir?: string;
}

/** La funzione che avvia un turno: quella dell'SDK, o un replay di una trascrizione nei test. */
export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }, ctx: { tools: TeamTool[] }) => AsyncIterable<SDKMessage> & { close(): void };

/** Limite dell'API per un'immagine in base64 (5 MB). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Il risultato di un tool del team per l'SDK: il testo e, se ci sono, le immagini (base64). */
export function toolResultContent(r: TeamToolResult): Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' }> {
  const out: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' }> = [{ type: 'text', text: r.text }];
  for (const img of r.images ?? []) {
    const data = readImage(img.path);
    if (typeof data === 'string') out.push({ type: 'text', text: `${img.caption}: ${data}` });
    else out.push({ type: 'text', text: img.caption }, { type: 'image', data: data.toString('base64'), mimeType: 'image/png' });
  }
  return out;
}

/** Il file di un'immagine, o il motivo per cui non si può allegare. */
function readImage(file: string): Buffer | string {
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch {
    return 'schermata non disponibile';
  }
  return Math.ceil(data.length / 3) * 4 > MAX_IMAGE_BYTES ? 'schermata troppo grande per essere allegata' : data;
}

/**
 * Il messaggio dell'utente con testo e immagini (blocchi image in base64, ognuno preceduto dalla
 * sua didascalia). Un'immagine mancante o troppo grande diventa una riga di testo che lo dice.
 */
export function userMessageWithImages(prompt: string, images: Array<{ path: string; caption: string }>): SDKUserMessage {
  type Block = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } };
  const content: Block[] = [{ type: 'text', text: prompt }];
  for (const img of images) {
    const data = readImage(img.path);
    if (typeof data === 'string') content.push({ type: 'text', text: `${img.caption}: ${data}` });
    else content.push({ type: 'text', text: img.caption }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: data.toString('base64') } });
  }
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}

interface TurnAccounting {
  seenUsage: Set<string>;
  observedTokens: number;
  compacted: boolean;
  base: number;
  resumed: boolean;
}

const realQuery: QueryFn = (params) => sdkQuery(params);

export function assertNoPermissionBypass(options: Options): void {
  if (options.permissionMode !== 'default') throw new Error(`permissionMode deve essere "default" (trovato ${String(options.permissionMode)})`);
  if ((options as { allowDangerouslySkipPermissions?: boolean }).allowDangerouslySkipPermissions) throw new Error('allowDangerouslySkipPermissions non è ammesso');
  if (options.allowedTools?.length) throw new Error('allowedTools non è ammesso: ogni tool passa dalla policy');
  if ((options as { permissionPrompts?: string }).permissionPrompts === 'none') throw new Error('permissionPrompts "none" non è ammesso');
  if (!options.hooks?.PreToolUse?.length || options.hooks.PreToolUse.some((m) => m.matcher)) throw new Error('serve un hook PreToolUse per tutti i tool');
  if (!options.canUseTool) throw new Error('serve canUseTool');
}

export interface CostInput {
  /** totale della sessione registrato al turno precedente (0 o assente: sessione nuova) */
  base: number;
  /** total_cost_usd del risultato di questo turno */
  total: number;
  /** il turno riprende una sessione esistente */
  resumed: boolean;
  /** token visti nei messaggi di questo turno (solo il ciclo principale) */
  observedTokens: number;
  /** token di modelUsage del risultato (cumulativi come total_cost_usd) */
  modelTokens: number;
  /** nel turno c'è stata una compattazione (chiamate in più non visibili nei messaggi) */
  compacted: boolean;
}

export interface CostDelta {
  /** spesa da contare per questo turno */
  delta: number;
  /** parte di delta contata per prudenza (forse già contata in un turno precedente) */
  unreconciled: number;
  how: 'new' | 'restored' | 'not_restored' | 'unknown';
}

/**
 * La spesa del turno a partire da total_cost_usd. Per una sessione ripresa la CLI riparte dal totale
 * salvato nella trascrizione "quando c'è": se l'ha ritrovato, l'incremento è total - base; se no,
 * total è solo la spesa di questo turno. Quando total < base è certo che non l'ha ritrovato.
 * Altrimenti si confrontano i token del turno con quelli di modelUsage (che seguono lo stesso
 * ciclo di vita di total_cost_usd): se modelUsage ne ha molti di più, la CLI ha ritrovato i turni
 * precedenti; se sono quasi gli stessi, no. Se non si può dire, si conta in modo PRUDENTE: tutta la
 * spesa, segnando base come "non riconciliata" (forse contata due volte), mai di meno.
 */
export function sessionCostDelta(c: CostInput): CostDelta {
  const total = Math.max(0, c.total);
  const base = Math.max(0, c.base);
  if (!c.resumed || base === 0) return { delta: total, unreconciled: 0, how: 'new' };
  if (total < base) return { delta: total, unreconciled: 0, how: 'not_restored' };
  const evidence = !c.compacted && c.observedTokens > 0 && c.modelTokens > 0;
  if (evidence) {
    const share = Math.min(1, c.observedTokens / c.modelTokens);
    const prior = base / Math.max(total, 1e-9); // quota della spesa che sarebbe dei turni precedenti
    if (share <= 1 - 0.5 * prior) return { delta: total - base, unreconciled: 0, how: 'restored' };
    if (share >= 1 - 0.1 * prior) return { delta: total, unreconciled: 0, how: 'not_restored' };
  }
  return { delta: total, unreconciled: Math.min(base, total), how: 'unknown' };
}

function modelUsageTokens(mu: unknown): number {
  if (!mu || typeof mu !== 'object') return 0;
  let n = 0;
  for (const u of Object.values(mu as Record<string, Record<string, unknown>>)) {
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']) if (typeof u?.[k] === 'number') n += u[k] as number;
  }
  return n;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

function normalizeToolName(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

/** Diff unificato minimo per gli eventi file_change di Edit/Write. */
function editDiff(file: string, oldText: string | undefined, newText: string): string {
  const oldLines = oldText === undefined ? [] : oldText.replace(/\n$/, '').split('\n');
  const newLines = newText.replace(/\n$/, '').split('\n');
  return [`--- ${oldText === undefined ? '/dev/null' : `a/${file}`}`, `+++ b/${file}`, `@@ -1,${oldLines.length} +1,${newLines.length} @@`, ...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)].join('\n');
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).filter(Boolean).join('\n');
  return '';
}

export class ClaudeEngine implements EngineAdapter {
  readonly id = 'claude' as const;
  readonly label = 'Claude';

  /** con il login personale la spesa riportata è una stima: si paga l'abbonamento */
  get billing(): 'api' | 'subscription' {
    return this.cfg.useClaudeLogin ? 'subscription' : 'api';
  }

  constructor(
    private cfg: ClaudeEngineConfig,
    private queryFn: QueryFn = realQuery,
  ) {}

  defaultModel(role: Role): string {
    return role === 'lead' ? (this.cfg.leadModel ?? DEFAULT_LEAD_MODEL) : (this.cfg.workerModel ?? DEFAULT_WORKER_MODEL);
  }

  displayModel(model: string): string {
    return displayClaudeModel(model);
  }

  async checkAuth(): Promise<AuthCheck> {
    if (this.cfg.useClaudeLogin) {
      const login = detectClaudeLogin(process.env);
      return login.ok ? { ok: true, account: login.source } : { ok: false, message: NO_LOGIN_TOKEN_MESSAGE };
    }
    const api = detectApiAuth(process.env);
    return api.ok ? { ok: true, account: api.source } : { ok: false, message: NO_API_AUTH_MESSAGE };
  }

  startSession(spec: TurnSpec): EngineTurn {
    return this.run(spec);
  }

  resumeSession(sessionId: string, spec: TurnSpec): EngineTurn {
    return this.run(spec, sessionId);
  }

  /** Le opzioni dell'SDK per un turno (esportate per i test di isolamento). */
  buildOptions(spec: TurnSpec, hooks: { preToolUse: NonNullable<Options['hooks']>['PreToolUse']; canUseTool: NonNullable<Options['canUseTool']>; abort: AbortController }, resume?: string): Options {
    const role = spec.role;
    const configDir = ensureDir(path.join(this.cfg.configDir));
    const env: Record<string, string | undefined> = {
      ...spec.env,
      // le credenziali arrivano solo alla CLI (envForAuth sceglie quelle della modalità)
      ...spec.credentials,
      CLAUDE_AGENT_SDK_CLIENT_APP: `keystone/${VERSION}`,
      // la CLI non legge ~/.claude dell'utente, in nessuna modalità
      CLAUDE_CONFIG_DIR: configDir,
      // chiave API e token di login restano alla CLI: Bash, server MCP stdio e hook non li vedono
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      // niente memoria automatica della CLI: la memoria del team è quella di Keystone (read/write_memory)
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      DISABLE_AUTOUPDATER: '1',
    };
    // l'effort del singolo agente (config.json) vale prima di quello del ruolo
    const effort = (spec.effort as Options['effort']) ?? (role === 'lead' ? (this.cfg.leadEffort ?? this.cfg.effort) : this.cfg.effort);
    const model = spec.model || this.defaultModel(role);
    const options: Options = {
      cwd: spec.cwd,
      model,
      ...(effort ? { effort } : {}),
      maxTurns: role === 'lead' ? (this.cfg.maxTurnsLead ?? 40) : (this.cfg.maxTurnsWorker ?? 80),
      ...(spec.budgetUsd !== undefined ? { maxBudgetUsd: Math.max(0.01, Math.round(spec.budgetUsd * 100) / 100) } : {}),
      permissionMode: 'default',
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
      plugins: [],
      tools: role === 'lead' ? LEAD_TOOLS : WORKER_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      mcpServers: {
        [MCP_SERVER]: createSdkMcpServer({
          name: MCP_SERVER,
          version: VERSION,
          tools: spec.tools.map((t) =>
            sdkTool(t.name, t.description, t.schema.shape, async (args: Record<string, unknown>) => {
              const r = await t.run(args);
              return { content: toolResultContent(r), ...(r.isError ? { isError: true } : {}) };
            }),
          ),
        }),
      },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.instructions },
      hooks: { PreToolUse: hooks.preToolUse ?? [] },
      canUseTool: hooks.canUseTool,
      abortController: hooks.abort,
      env: envForAuth(env, !!this.cfg.useClaudeLogin),
      persistSession: true,
      ...(resume ? { resume } : {}),
    };
    assertNoPermissionBypass(options);
    return options;
  }

  private run(spec: TurnSpec, resume?: string): EngineTurn {
    const channel = new EventChannel<EngineEvent>();
    const emit = (e: EngineEvent) => channel.push(e);
    const broker = new PermissionBroker(emit);
    const abort = new AbortController();
    const recorder = this.recorder(spec);

    // decisioni già prese per un tool_use (l'hook decide; canUseTool non chiede due volte)
    const decided = new Map<string, PermissionAnswer>();
    const gateKey = (name: string, input: unknown) => `${name}\n${JSON.stringify(input)}`;
    const ask = async (toolUseId: string | undefined, name: string, input: Record<string, unknown>): Promise<PermissionAnswer> => {
      const key = toolUseId ?? gateKey(name, input);
      const prev = decided.get(key) ?? decided.get(gateKey(name, input));
      if (prev) return prev;
      const answer = await broker.ask(name, input);
      decided.set(key, answer);
      decided.set(gateKey(name, input), answer);
      return answer;
    };
    const preToolUse: NonNullable<Options['hooks']>['PreToolUse'] = [
      {
        // nessun matcher: vale per ogni tool
        timeout: HOOK_TIMEOUT_S,
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'PreToolUse') return { continue: true };
            const toolInput = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>;
            recorder?.({ t: 'hook', toolUseId: input.tool_use_id, toolName: input.tool_name, input: toolInput });
            const a = await ask(input.tool_use_id, input.tool_name, toolInput);
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: a.allow ? 'allow' : 'deny', ...(a.allow ? {} : { permissionDecisionReason: a.message }) } };
          },
        ],
      },
    ];
    const canUseTool: NonNullable<Options['canUseTool']> = async (name, input, opts) => {
      const toolUseId = (opts as { toolUseID?: string }).toolUseID;
      const a = await ask(toolUseId, name, input);
      return a.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: a.message };
    };

    let options: Options;
    try {
      options = this.buildOptions(spec, { preToolUse, canUseTool, abort }, resume);
    } catch (e) {
      queueMicrotask(() => {
        emit({ type: 'error', message: (e as Error).message });
        emit({ type: 'turn_end', status: 'error' });
        channel.close();
      });
      return { events: channel, respond: () => undefined, abort: () => undefined };
    }

    // con immagini il prompt è un messaggio con blocchi: l'input resta aperto fino alla fine del
    // turno (le richieste di permesso e i tool del team passano dallo stesso canale)
    let endInput: () => void = () => undefined;
    const inputOpen = new Promise<void>((r) => (endInput = r));
    const prompt: string | AsyncIterable<SDKUserMessage> = spec.images?.length
      ? (async function* () {
          yield userMessageWithImages(spec.prompt, spec.images!);
          await inputOpen;
        })()
      : spec.prompt;
    const q = this.queryFn({ prompt, options }, { tools: spec.tools });
    const toolNames = new Map<string, string>();
    const acc: TurnAccounting = { seenUsage: new Set(), observedTokens: 0, compacted: false, base: spec.sessionCostUsd ?? 0, resumed: !!resume };

    void (async () => {
      let ended = false;
      try {
        for await (const msg of q) {
          if (abort.signal.aborted) break;
          recorder?.({ t: 'msg', msg });
          if (msg.type === 'result') endInput();
          for (const ev of this.map(msg, toolNames, acc)) {
            if (ev.type === 'turn_end') ended = true;
            emit(ev);
          }
        }
        if (abort.signal.aborted) emit({ type: 'turn_end', status: 'aborted' });
        else if (!ended) emit({ type: 'turn_end', status: 'error' });
      } catch (e) {
        if (abort.signal.aborted) emit({ type: 'turn_end', status: 'aborted' });
        else {
          const message = (e as Error).message ?? String(e);
          emit({ type: 'error', message: truncate(message, 2000), ...(/auth|401|api key|credential|login/i.test(message) ? { auth: true } : {}) });
          emit({ type: 'turn_end', status: 'error' });
        }
      } finally {
        endInput();
        channel.close();
      }
    })();

    return {
      events: channel,
      respond: (id, answer) => broker.respond(id, answer),
      abort: (reason) => {
        if (abort.signal.aborted) return;
        broker.abort(reason);
        abort.abort(reason);
        try {
          q.close();
        } catch {
          /* già chiuso */
        }
      },
    };
  }

  /** Traduce un messaggio dell'SDK negli eventi normalizzati. */
  private *map(msg: SDKMessage, toolNames: Map<string, string>, acc: TurnAccounting): Generator<EngineEvent> {
    const m = msg as Record<string, unknown> & { type: string; subtype?: string };
    if (m.type === 'system' && m.subtype === 'compact_boundary') acc.compacted = true;
    if (m.type === 'system' && m.subtype === 'init') {
      if (typeof m.session_id === 'string') yield { type: 'session', sessionId: m.session_id };
      if (typeof m.model === 'string') yield { type: 'model', model: m.model };
      return;
    }
    if (m.type === 'assistant') {
      const message = m.message as { id?: string; content?: Array<Record<string, unknown>>; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
      if (typeof m.error === 'string') yield { type: 'error', message: `errore del modello: ${m.error}`, ...(m.error === 'authentication_failed' || m.error === 'oauth_org_not_allowed' ? { auth: true } : {}) };
      for (const block of message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) yield { type: 'text', text: block.text };
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
          toolNames.set(block.id, block.name);
          yield { type: 'tool_call', callId: block.id, tool: normalizeToolName(block.name), input };
          const file = typeof input.file_path === 'string' ? input.file_path : undefined;
          if (file && (block.name === 'Write' || block.name === 'Edit' || block.name === 'MultiEdit')) {
            const rel = file.replace(/\\/g, '/');
            if (block.name === 'Write') yield { type: 'file_change', path: rel, change: 'modify', diff: editDiff(rel, undefined, String(input.content ?? '')) };
            else yield { type: 'file_change', path: rel, change: 'modify', ...(typeof input.new_string === 'string' ? { diff: editDiff(rel, String(input.old_string ?? ''), input.new_string) } : {}) };
          }
        }
      }
      const u = message?.usage;
      if (u && message?.id && !acc.seenUsage.has(message.id)) {
        acc.seenUsage.add(message.id);
        const inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        acc.observedTokens += inputTokens + (u.output_tokens ?? 0);
        yield { type: 'usage', inputTokens, outputTokens: u.output_tokens ?? 0 };
      }
      return;
    }
    if (m.type === 'user') {
      const content = (m.message as { content?: unknown })?.content;
      if (!Array.isArray(content)) return;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        yield { type: 'tool_result', callId: block.tool_use_id, ok: block.is_error !== true, output: truncate(resultText(block.content), 4000) };
      }
      return;
    }
    if (m.type === 'result') {
      const total = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : 0;
      const c = sessionCostDelta({ base: acc.base, total, resumed: acc.resumed, observedTokens: acc.observedTokens, modelTokens: modelUsageTokens(m.modelUsage), compacted: acc.compacted });
      // la base del turno dopo è il totale come lo conosce la CLI (che lo salva nella trascrizione)
      acc.base = total;
      yield {
        type: 'usage',
        inputTokens: 0,
        outputTokens: 0,
        ...(c.delta > 0 ? { costUsd: round6(c.delta) } : {}),
        sessionTotalUsd: round6(total),
        ...(c.unreconciled > 0 ? { unreconciledUsd: round6(c.unreconciled) } : {}),
      };
      const sub = m.subtype;
      const errors = Array.isArray(m.errors) ? (m.errors as string[]) : [];
      if (sub === 'success') yield { type: 'turn_end', status: 'success', ...(typeof m.result === 'string' ? { resultText: m.result } : {}) };
      else if (sub === 'error_max_turns') yield { type: 'turn_end', status: 'max_turns' };
      else if (sub === 'error_max_budget_usd') yield { type: 'turn_end', status: 'budget' };
      else {
        const message = errors.join('; ') || String(sub);
        yield { type: 'error', message };
        yield { type: 'turn_end', status: 'error' };
      }
    }
  }

  /** Registratore di trascrizioni (attivo solo con recordDir): una riga JSON per voce. */
  private recorder(spec: TurnSpec): ((entry: unknown) => void) | undefined {
    if (!this.cfg.recordDir) return undefined;
    const file = path.join(ensureDir(this.cfg.recordDir), `${spec.agentId}-${spec.job.kind}-${spec.job.taskId ?? spec.job.goalId ?? 'x'}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify({ t: 'turn', role: spec.role, kind: spec.job.kind, title: spec.job.title ?? '' })}\n`);
    return (entry) => fs.appendFileSync(file, `${JSON.stringify(entry, redactImageData)}\n`);
  }
}
