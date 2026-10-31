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
//    CLI vera. Con il login personale (opzionale) la cartella di configurazione resta quella
//    dell'utente, perché lì vivono le credenziali: valgono comunque le altre barriere.
//  - Tool: solo quelli di base per ruolo (il lead non ha Edit/Write) più i tool del team; niente
//    sub-agenti, web, skill.
//  - Spesa: maxBudgetUsd = spesa residua dell'obiettivo, così la CLI stessa si ferma al tetto.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, query as sdkQuery, tool as sdkTool, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent, PermissionAnswer, Role } from '@keystone/shared';
import { ensureDir } from '../../util/fsx.js';
import { truncate } from '../../util/text.js';
import { EventChannel, PermissionBroker } from '../channel.js';
import type { AuthCheck, EngineAdapter, EngineTurn, TeamTool, TurnSpec } from '../types.js';
import { detectApiAuth, envForAuth, NO_API_AUTH_MESSAGE } from './auth.js';
import { DEFAULT_LEAD_MODEL, DEFAULT_WORKER_MODEL, displayClaudeModel } from './models.js';

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
export type QueryFn = (params: { prompt: string; options: Options }, ctx: { tools: TeamTool[] }) => AsyncIterable<SDKMessage> & { close(): void };

const realQuery: QueryFn = (params) => sdkQuery(params);

export function assertNoPermissionBypass(options: Options): void {
  if (options.permissionMode !== 'default') throw new Error(`permissionMode deve essere "default" (trovato ${String(options.permissionMode)})`);
  if ((options as { allowDangerouslySkipPermissions?: boolean }).allowDangerouslySkipPermissions) throw new Error('allowDangerouslySkipPermissions non è ammesso');
  if (options.allowedTools?.length) throw new Error('allowedTools non è ammesso: ogni tool passa dalla policy');
  if ((options as { permissionPrompts?: string }).permissionPrompts === 'none') throw new Error('permissionPrompts "none" non è ammesso');
  if (!options.hooks?.PreToolUse?.length || options.hooks.PreToolUse.some((m) => m.matcher)) throw new Error('serve un hook PreToolUse per tutti i tool');
  if (!options.canUseTool) throw new Error('serve canUseTool');
}

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
    if (this.cfg.useClaudeLogin) return { ok: true, account: 'login personale di Claude Code (abilitato esplicitamente)' };
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
      CLAUDE_AGENT_SDK_CLIENT_APP: 'keystone/0.1.0',
      // la CLI non legge ~/.claude dell'utente (con il login personale le credenziali stanno lì)
      ...(this.cfg.useClaudeLogin ? {} : { CLAUDE_CONFIG_DIR: configDir }),
      DISABLE_AUTOUPDATER: '1',
    };
    const effort = role === 'lead' ? (this.cfg.leadEffort ?? this.cfg.effort) : this.cfg.effort;
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
          version: '0.1.0',
          tools: spec.tools.map((t) =>
            sdkTool(t.name, t.description, t.schema.shape, async (args: Record<string, unknown>) => {
              const r = await t.run(args);
              return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
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

    const q = this.queryFn({ prompt: spec.prompt, options }, { tools: spec.tools });
    const toolNames = new Map<string, string>();
    const seenUsage = new Set<string>();
    let baseline = spec.sessionCostUsd ?? 0;

    void (async () => {
      let ended = false;
      try {
        for await (const msg of q) {
          if (abort.signal.aborted) break;
          recorder?.({ t: 'msg', msg });
          for (const ev of this.map(msg, toolNames, seenUsage, () => baseline, (v) => (baseline = v))) {
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
  private *map(msg: SDKMessage, toolNames: Map<string, string>, seenUsage: Set<string>, getBaseline: () => number, setBaseline: (v: number) => void): Generator<EngineEvent> {
    const m = msg as Record<string, unknown> & { type: string; subtype?: string };
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
      if (u && message?.id && !seenUsage.has(message.id)) {
        seenUsage.add(message.id);
        yield { type: 'usage', inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0 };
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
      // total_cost_usd è cumulativo per la sessione: si conta solo l'incremento rispetto al già registrato
      const base = getBaseline();
      const delta = total >= base ? total - base : total;
      setBaseline(total >= base ? total : base + total);
      if (delta > 0) yield { type: 'usage', inputTokens: 0, outputTokens: 0, costUsd: Math.round(delta * 1e6) / 1e6 };
      const sub = m.subtype;
      const errors = Array.isArray(m.errors) ? (m.errors as string[]) : [];
      if (sub === 'success') yield { type: 'turn_end', status: 'success', ...(typeof m.result === 'string' ? { resultText: m.result } : {}) };
      else if (sub === 'error_max_turns') yield { type: 'turn_end', status: 'max_turns' };
      else {
        const message = sub === 'error_max_budget_usd' ? 'raggiunto il tetto di spesa disponibile per questo turno' : errors.join('; ') || String(sub);
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
    return (entry) => fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  }
}
