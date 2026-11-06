// Motore Codex: un processo `codex app-server` (JSON-RPC su stdio) per ogni turno, versione fissata
// 0.163.0 (@openai/codex). Il protocollo è stato verificato sulla CLI installata (vedi
// docs/motore-codex.md e il test di isolamento).
//
// Regole che questo adattatore garantisce:
//  - Nessuna configurazione dell'utente: CODEX_HOME punta a ~/.keystone/codex-home, quindi Codex
//    non legge ~/.codex (config.toml, server MCP, AGENTS.md globale, skill, plugin). In più, per
//    ogni thread: nessun server MCP, nessuna istruzione dal repository (project_doc_max_bytes 0),
//    ricerca web disattivata, plugin remoti e suggerimenti di tool disattivati, skill di sistema
//    disattivate una per una.
//  - Ogni azione passa dalla policy di Keystone: approvalPolicy "untrusted" (Codex chiede prima dei
//    comandi), e ogni richiesta di approvazione (comando, modifica di file) diventa un
//    permission_request con il vocabolario dei tool Claude (Bash/PowerShell {command}, Edit
//    {file_path}). Anche i tool del team passano dalla policy (mcp__keystone__<tool>). Le richieste
//    di permessi aggiuntivi, di input all'utente e di elicitazione MCP sono rifiutate.
//  - Sandbox di Codex come seconda barriera: lead in sola lettura, worker "workspace-write" con le
//    sole cartelle git necessarie a committare e senza rete. Su Windows serve windows.sandbox
//    "unelevated", altrimenti Codex ripiega in silenzio sulla sola lettura.
//  - Le credenziali non arrivano ai comandi: l'ambiente dei comandi è "core" più le sole variabili
//    di sicurezza git di Keystone (shell_environment_policy).
//  - Spesa: Codex riporta token, non dollari.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import type { EngineEvent, PermissionAnswer, Role } from '@keystone/shared';
import { ensureDir } from '../../util/fsx.js';
import { git } from '../../util/git.js';
import { redactImageData, truncate } from '../../util/text.js';
import { EventChannel, PermissionBroker } from '../channel.js';
import type { AuthCheck, EngineAdapter, EngineTurn, TeamTool, TeamToolResult, TurnSpec } from '../types.js';
import { unwrapShell } from './command.js';
import { RpcClient, type RpcMessage } from './rpc.js';

export const CODEX_VERSION = '0.163.0';
const TEAM_PREFIX = 'mcp__keystone__';

export interface CodexEngineConfig {
  /** cartella di configurazione isolata (CODEX_HOME), dentro ~/.keystone */
  codexHome: string;
  /** percorso del binario codex (default: quello del pacchetto @openai/codex installato) */
  binPath?: string;
  leadModel?: string;
  workerModel?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  leadEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** login ChatGPT fatto con CODEX_HOME=~/.keystone/codex-home (solo uso personale) */
  useCodexLogin?: boolean;
  /** se impostata, ogni turno viene registrato qui (righe JSON-RPC) */
  recordDir?: string;
  /**
   * prezzi in dollari per milione di token, indicati dall'utente: se ci sono, Keystone stima la spesa
   * dai token (Codex non riporta dollari). Nessun prezzo nel codice: cambiano e vanno presi dal listino.
   */
  prices?: CodexPrices;
  /** solo test: variabili aggiunte all'ambiente del processo (es. il proxy) */
  extraEnv?: Record<string, string>;
  /** solo test: configurazione aggiunta a ogni thread (es. un provider di modelli locale) */
  extraConfig?: Record<string, unknown>;
}

export interface CodexPrices {
  /** dollari per milione di token in ingresso (non in cache) */
  inputPerMTok: number;
  /** dollari per milione di token in ingresso letti dalla cache (default: come inputPerMTok) */
  cachedInputPerMTok?: number;
  /** dollari per milione di token in uscita (compresi quelli di ragionamento) */
  outputPerMTok: number;
}

/** "input=1.25,cached=0.125,output=10" -> prezzi; errore chiaro se manca qualcosa. */
export function parseCodexPrices(text: string): CodexPrices {
  const kv = Object.fromEntries(
    text.split(',').map((p) => {
      const [k, v] = p.split('=').map((x) => x.trim());
      const n = Number(v);
      if (!k || !Number.isFinite(n) || n < 0) throw new Error(`prezzo non valido: "${p}" (formato: input=<$/Mtok>,cached=<$/Mtok>,output=<$/Mtok>)`);
      return [k.toLowerCase(), n];
    }),
  );
  for (const k of Object.keys(kv)) if (!['input', 'cached', 'output'].includes(k)) throw new Error(`prezzo sconosciuto: ${k} (input, cached, output)`);
  if (kv.input === undefined || kv.output === undefined) throw new Error('servono almeno input=… e output=… (dollari per milione di token)');
  return { inputPerMTok: kv.input, outputPerMTok: kv.output, ...(kv.cached !== undefined ? { cachedInputPerMTok: kv.cached } : {}) };
}

/** La spesa stimata di una richiesta al modello (i token in ingresso comprendono quelli in cache). */
export function estimateCodexCost(u: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }, p: CodexPrices): number {
  const cached = Math.max(0, u.cachedInputTokens ?? 0);
  const fresh = Math.max(0, (u.inputTokens ?? 0) - cached);
  const usd = (fresh * p.inputPerMTok + cached * (p.cachedInputPerMTok ?? p.inputPerMTok) + Math.max(0, u.outputTokens ?? 0) * p.outputPerMTok) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

/** Variabili di credenziali tolte dall'ambiente del processo di Codex (la chiave passa da login/start). */
const CREDENTIAL_VARS = /^(OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_CLIENT_SECRET|GH_TOKEN|GITHUB_TOKEN|GITLAB_TOKEN)$/i;
/** Variabili dell'ambiente degli agenti da passare esplicitamente ai comandi (Codex filtra quelle che sembrano segreti). */
const COMMAND_VARS = /^(GIT_|KEYSTONE_)/;

/**
 * Funzioni di Codex 0.163.0 attive di default (experimentalFeature/list) che Keystone spegne: ogni
 * azione deve passare dalla policy e dall'utente, senza strade laterali.
 */
export const DISABLED_FEATURES: Record<string, false> = Object.fromEntries(
  [
    // le approvazioni vanno all'utente (cioè a Keystone), mai a un revisore automatico
    'guardian_approval',
    'guardian_reuse_parent_compaction',
    // tool che agiscono fuori dai comandi approvati: lettura di immagini/file, sub-agenti, browser, computer
    'view_image',
    'multi_agent',
    'multi_agent_v2',
    'browser_use',
    'browser_use_full_cdp_access',
    'browser_use_external',
    'computer_use',
    'in_app_browser',
    'browser_annotation_api',
    'in_app_local_automation',
    'image_generation',
    'code_mode_host',
    'goals',
    'worktrees',
    'workspace_dependencies',
    'realtime_conversation',
    // configurazione ed estensioni esterne
    'hooks',
    'plugins',
    'remote_plugin',
    'plugin_sharing',
    'apps',
    'tool_suggest',
    'skill_search',
    'skill_mcp_dependency_install',
    'tool_call_mcp_elicitation',
    'auth_elicitation',
    'memories',
    'remote_control',
    'codex_apps_mcp_2026_07_28',
    // l'istantanea della shell importa l'ambiente del profilo dell'utente
    'shell_snapshot',
    // nessun processo in background oltre al turno
    'daemon_auto_start',
  ].map((f) => [f, false]),
);

/** Il binario nativo del pacchetto @openai/codex per questa piattaforma. */
export function defaultCodexBin(): string {
  const req = createRequire(import.meta.url);
  const triple: Record<string, string> = {
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'linux-x64': 'x86_64-unknown-linux-musl',
    'linux-arm64': 'aarch64-unknown-linux-musl',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
  };
  const key = `${process.platform}-${process.arch}`;
  const pkg = path.dirname(req.resolve(`@openai/codex-${key}/package.json`));
  return path.join(pkg, 'vendor', triple[key] ?? '', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
}

/** "gpt-6.1-sol" -> "GPT-6.1 Sol"; altrimenti il nome com'è. */
export function displayCodexModel(model: string): string {
  const m = /^gpt-([\d.]+)(?:-(.+))?$/i.exec(model.trim());
  if (!m) return model;
  const rest = (m[2] ?? '')
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return `GPT-${m[1]}${rest ? ` ${rest}` : ''}`;
}

/** Effort di Keystone -> effort di Codex (Codex non ha "max"). */
function codexEffort(e: string | undefined): string | undefined {
  if (!e) return undefined;
  return e === 'max' ? 'xhigh' : e;
}

type Json = Record<string, unknown>;
interface ThreadItem {
  type: string;
  id: string;
  [k: string]: unknown;
}

export class CodexEngine implements EngineAdapter {
  readonly id = 'codex' as const;
  readonly label = 'Codex';

  constructor(private cfg: CodexEngineConfig) {}

  /** Codex riporta token, non dollari: la spesa c'è solo come stima, se l'utente ha indicato i prezzi */
  get reportsCost(): boolean {
    return !!this.cfg.prices;
  }

  get billing(): 'api' | 'subscription' | 'estimate' {
    if (this.cfg.useCodexLogin) return 'subscription';
    return this.cfg.prices ? 'estimate' : 'api';
  }

  defaultModel(role: Role): string {
    // vuoto = il modello predefinito di Codex (riportato all'avvio del thread)
    return (role === 'lead' ? this.cfg.leadModel : this.cfg.workerModel) ?? '';
  }

  displayModel(model: string): string {
    return model ? displayCodexModel(model) : 'Codex';
  }

  private bin(): string {
    return this.cfg.binPath ?? defaultCodexBin();
  }

  /** Il processo app-server: il binario, oppure uno script Node (i test usano un server finto). */
  private spawnServer(cwd: string, env: Record<string, string>, stderr: 'pipe' | 'ignore'): ChildProcess {
    const bin = this.bin();
    const script = /\.(c|m)?js$/i.test(bin);
    return spawn(script ? process.execPath : bin, script ? [bin, 'app-server'] : ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', stderr], windowsHide: true });
  }

  /** Ambiente del processo app-server: quello degli agenti, senza credenziali, con CODEX_HOME isolata. */
  processEnv(base: Record<string, string | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) if (v !== undefined && !CREDENTIAL_VARS.test(k) && k.toUpperCase() !== 'CODEX_HOME') out[k] = v;
    out.CODEX_HOME = ensureDir(this.cfg.codexHome);
    return { ...out, ...(this.cfg.extraEnv ?? {}) };
  }

  /** La configurazione di ogni thread: isolamento, sandbox, ambiente dei comandi. */
  threadConfig(spec: Pick<TurnSpec, 'role' | 'env'>, writableRoots: string[]): Json {
    const set: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.env)) if (v !== undefined && COMMAND_VARS.test(k)) set[k] = v;
    return {
      mcp_servers: {},
      project_doc_max_bytes: 0,
      web_search: 'disabled',
      notify: [],
      // niente login shell: non si caricano i profili dell'utente (PowerShell, bash) né le loro variabili
      allow_login_shell: false,
      features: DISABLED_FEATURES,
      shell_environment_policy: { inherit: 'core', set },
      ...(spec.role === 'worker' ? { windows: { sandbox: 'unelevated' }, sandbox_workspace_write: { writable_roots: writableRoots, network_access: false } } : {}),
      ...(this.cfg.extraConfig ?? {}),
    };
  }

  /**
   * Cartelle che il worker deve poter scrivere oltre al worktree per committare: gli oggetti, il
   * suo branch (riferimento e reflog) e la gitdir del worktree. MAI l'intera .git condivisa: config
   * e hooks permetterebbero di eseguire codice nel git dell'utente.
   */
  async writableRoots(cwd: string): Promise<string[]> {
    const gitDir = (await git(cwd, ['rev-parse', '--absolute-git-dir'], { allowFail: true })).stdout.trim();
    const common = path.resolve(cwd, (await git(cwd, ['rev-parse', '--git-common-dir'], { allowFail: true })).stdout.trim() || '.git');
    const branch = (await git(cwd, ['symbolic-ref', '--short', 'HEAD'], { allowFail: true })).stdout.trim();
    const roots = [path.join(common, 'objects')];
    if (branch) {
      const dir = path.dirname(branch);
      roots.push(path.join(common, 'refs', 'heads', dir), path.join(common, 'logs', 'refs', 'heads', dir));
    }
    if (gitDir && path.resolve(gitDir) !== path.resolve(common)) roots.push(gitDir);
    return roots.map((r) => path.resolve(r));
  }

  async checkAuth(): Promise<AuthCheck> {
    if (!this.cfg.useCodexLogin && !apiKeyFrom(process.env)) {
      return { ok: false, message: NO_CODEX_AUTH_MESSAGE(this.cfg.codexHome) };
    }
    if (!this.cfg.useCodexLogin) return { ok: true, account: 'chiave API OpenAI' };
    try {
      const account = await this.readAccount();
      if (account?.type === 'chatgpt') return { ok: true, account: `login ChatGPT di Codex${account.email ? ` (${String(account.email)})` : ''}` };
      return { ok: false, message: NO_CODEX_LOGIN_MESSAGE(this.cfg.codexHome) };
    } catch (e) {
      return { ok: false, message: `Codex non risponde: ${(e as Error).message}` };
    }
  }

  /** L'account registrato nella CODEX_HOME di Keystone (senza avviare un thread). */
  private async readAccount(): Promise<Json | null> {
    const proc = this.spawnServer(ensureDir(this.cfg.codexHome), this.processEnv(process.env), 'ignore');
    const rpc = new RpcClient(proc.stdout!, proc.stdin!, { onNotification: () => undefined, onRequest: async () => Promise.reject(new Error('non gestito')) });
    try {
      await rpc.request('initialize', { clientInfo: { name: 'keystone', title: 'Keystone', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } }, 30_000);
      rpc.notify('initialized');
      const r = await rpc.request<{ account: Json | null }>('account/read', { refreshToken: false }, 30_000);
      return r.account;
    } finally {
      rpc.close();
      proc.kill();
    }
  }

  startSession(spec: TurnSpec): EngineTurn {
    return this.run(spec);
  }

  resumeSession(sessionId: string, spec: TurnSpec): EngineTurn {
    return this.run(spec, sessionId);
  }

  private run(spec: TurnSpec, resume?: string): EngineTurn {
    const channel = new EventChannel<EngineEvent>();
    let ended = false;
    const emit = (e: EngineEvent) => {
      if (ended) return;
      if (e.type === 'turn_end') ended = true;
      channel.push(e);
    };
    const broker = new PermissionBroker(emit);
    const recorder = this.recorder(spec);
    const items = new Map<string, ThreadItem>();
    let proc: ChildProcess | undefined;
    let rpc: RpcClient | undefined;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let aborted: string | undefined;
    let lastText: string | undefined;
    let usageBase: number | undefined;
    let resolveDone!: (status: string, error?: string) => void;
    const done = new Promise<{ status: string; error?: string }>((r) => (resolveDone = (status, error) => r({ status, ...(error ? { error } : {}) })));

    const ask = (tool: string, input: Record<string, unknown>, reason?: string): Promise<PermissionAnswer> => broker.ask(tool, input, reason);
    const ours = (params: unknown) => !!threadId && (params as { threadId?: string; conversationId?: string })?.threadId === threadId;
    const oursLegacy = (params: unknown) => !!threadId && (params as { conversationId?: string })?.conversationId === threadId;

    /** Il comando come lo vede la policy: senza involucro della shell, con il cd se la cartella è un'altra. */
    const policyCommand = (command: string, cwd: string | null | undefined) => {
      const u = unwrapShell(command);
      const abs = cwd ? path.resolve(spec.cwd, cwd) : spec.cwd;
      const inOther = path.resolve(abs) !== path.resolve(spec.cwd);
      return { tool: u.tool, command: inOther ? `cd ${JSON.stringify(abs)} && ${u.command}` : u.command };
    };

    const onRequest = async (method: string, params: unknown): Promise<unknown> => {
      const p = (params ?? {}) as Json;
      switch (method) {
        case 'item/commandExecution/requestApproval': {
          if (!ours(p)) throw new Error('thread sconosciuto');
          if (p.kind === 'writeStdin') return { decision: 'decline' };
          const item = items.get(String(p.itemId));
          const raw = typeof p.command === 'string' ? p.command : typeof item?.command === 'string' ? item.command : '';
          if (!raw) return { decision: 'decline' };
          const c = policyCommand(raw, (p.cwd as string | null | undefined) ?? (item?.cwd as string | undefined));
          const a = await ask(c.tool, { command: c.command }, typeof p.reason === 'string' ? p.reason : undefined);
          return { decision: a.allow ? 'accept' : 'decline' };
        }
        case 'item/fileChange/requestApproval': {
          if (!ours(p)) throw new Error('thread sconosciuto');
          const item = items.get(String(p.itemId));
          const changes = Array.isArray(item?.changes) ? (item!.changes as Array<{ path: string }>) : [];
          const paths = [...changes.map((c) => c.path), ...(typeof p.grantRoot === 'string' && p.grantRoot ? [p.grantRoot] : [])];
          if (!paths.length) return { decision: 'decline' };
          for (const f of paths) {
            const a = await ask('Edit', { file_path: path.resolve(spec.cwd, f) }, typeof p.reason === 'string' ? p.reason : undefined);
            if (!a.allow) return { decision: 'decline' };
          }
          return { decision: 'accept' };
        }
        case 'execCommandApproval': {
          if (!oursLegacy(p)) throw new Error('thread sconosciuto');
          const cmd = Array.isArray(p.command) ? (p.command as string[]).map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ') : '';
          const c = policyCommand(cmd, p.cwd as string | undefined);
          const a = await ask(c.tool, { command: c.command });
          return { decision: a.allow ? 'approved' : { denied: { rejection: a.allow ? '' : a.message } } };
        }
        case 'applyPatchApproval': {
          if (!oursLegacy(p)) throw new Error('thread sconosciuto');
          for (const f of Object.keys((p.fileChanges as Json) ?? {})) {
            const a = await ask('Edit', { file_path: path.resolve(spec.cwd, f) });
            if (!a.allow) return { decision: { denied: { rejection: a.message } } };
          }
          return { decision: 'approved' };
        }
        case 'item/tool/call': {
          if (!ours(p)) throw new Error('thread sconosciuto');
          const name = String(p.tool ?? '');
          const args = (p.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Record<string, unknown>;
          const tool = spec.tools.find((t) => t.name === name);
          if (!tool) return { contentItems: [{ type: 'inputText', text: `tool sconosciuto: ${name}` }], success: false };
          const a = await ask(`${TEAM_PREFIX}${name}`, args);
          if (!a.allow) return { contentItems: [{ type: 'inputText', text: `Permesso negato: ${a.message}` }], success: false };
          const r = await tool.run(args);
          return { contentItems: toolContentItems(r), success: !r.isError };
        }
        case 'item/tool/requestUserInput':
          throw new Error('per chiedere qualcosa all\'utente usa il tool ask_user');
        case 'item/permissions/requestApproval':
          throw new Error('Keystone non concede permessi aggiuntivi: lavora dentro la cartella del task');
        default:
          // elicitazioni MCP, attestazioni, rinnovo dei token e ogni richiesta nuova: rifiutate
          throw new Error(`richiesta non ammessa da Keystone: ${method}`);
      }
    };

    const onNotification = (method: string, params: unknown) => {
      const p = (params ?? {}) as Json;
      if (p.threadId !== undefined && p.threadId !== threadId) return;
      switch (method) {
        case 'item/started': {
          const item = p.item as ThreadItem;
          if (!item?.id) return;
          items.set(item.id, item);
          if (item.type === 'commandExecution' && typeof item.command === 'string') {
            const c = policyCommand(item.command, item.cwd as string | undefined);
            emit({ type: 'tool_call', callId: item.id, tool: c.tool, input: { command: c.command } });
          } else if (item.type === 'fileChange' && Array.isArray(item.changes)) {
            for (const ch of item.changes as Array<{ path: string; kind?: { type?: string }; diff?: string }>) {
              emit({ type: 'tool_call', callId: `${item.id}:${ch.path}`, tool: ch.kind?.type === 'add' ? 'Write' : 'Edit', input: { file_path: ch.path } });
            }
          } else if (item.type === 'dynamicToolCall') {
            emit({ type: 'tool_call', callId: item.id, tool: String(item.tool), input: (item.arguments && typeof item.arguments === 'object' ? item.arguments : {}) as Record<string, unknown> });
          }
          return;
        }
        case 'item/completed': {
          const item = p.item as ThreadItem;
          if (!item?.id) return;
          items.set(item.id, item);
          if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
            lastText = item.text;
            emit({ type: 'text', text: item.text });
          } else if (item.type === 'commandExecution') {
            emit({ type: 'tool_result', callId: item.id, ok: item.status === 'completed' && (item.exitCode === 0 || item.exitCode === null), output: truncate(String(item.aggregatedOutput ?? (item.status === 'declined' ? 'comando non consentito' : '')), 4000) });
          } else if (item.type === 'fileChange' && Array.isArray(item.changes)) {
            for (const ch of item.changes as Array<{ path: string; kind?: { type?: string }; diff?: string }>) {
              const rel = path.relative(spec.cwd, path.resolve(spec.cwd, ch.path)).replace(/\\/g, '/');
              if (item.status === 'completed') emit({ type: 'file_change', path: rel, change: ch.kind?.type === 'add' ? 'add' : ch.kind?.type === 'delete' ? 'delete' : 'modify', ...(ch.diff ? { diff: ch.diff } : {}) });
              emit({ type: 'tool_result', callId: `${item.id}:${ch.path}`, ok: item.status === 'completed', output: item.status === 'completed' ? '' : `modifica ${String(item.status)}` });
            }
          } else if (item.type === 'dynamicToolCall') {
            const text = Array.isArray(item.contentItems) ? (item.contentItems as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n') : '';
            emit({ type: 'tool_result', callId: item.id, ok: item.success !== false, output: truncate(text, 4000) });
          }
          return;
        }
        case 'thread/tokenUsage/updated': {
          const u = (p.tokenUsage ?? {}) as { total?: { totalTokens?: number; inputTokens?: number; outputTokens?: number }; last?: { totalTokens?: number; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } };
          const total = u.total?.totalTokens ?? 0;
          // il totale è del thread (anche dei turni precedenti): si conta l'incremento da quando il turno è partito
          if (usageBase === undefined) usageBase = Math.max(0, total - (u.last?.totalTokens ?? 0));
          const delta = Math.max(0, total - usageBase);
          usageBase = total;
          if (delta > 0) {
            const out = Math.min(delta, u.last?.outputTokens ?? 0);
            // stima in dollari dai token dell'ultima richiesta (verificato: l'incremento del totale è proprio quella)
            const costUsd = this.cfg.prices && u.last ? estimateCodexCost(u.last, this.cfg.prices) * Math.min(1, delta / Math.max(1, u.last.totalTokens ?? delta)) : 0;
            emit({ type: 'usage', inputTokens: delta - out, outputTokens: out, ...(costUsd > 0 ? { costUsd: Math.round(costUsd * 1e6) / 1e6 } : {}) });
          }
          return;
        }
        case 'error': {
          const err = (p.error ?? {}) as { message?: string };
          if (p.willRetry) return;
          const message = err.message ?? 'errore di Codex';
          emit({ type: 'error', message: truncate(message, 2000), ...(isAuthError(message) ? { auth: true } : {}) });
          return;
        }
        case 'turn/completed': {
          const turn = (p.turn ?? {}) as { id?: string; status?: string; error?: { message?: string } | null };
          if (turnId && turn.id && turn.id !== turnId) return;
          resolveDone(turn.status ?? 'completed', turn.error?.message ?? undefined);
          return;
        }
      }
    };

    void (async () => {
      try {
        const writableRoots = spec.role === 'worker' ? await this.writableRoots(spec.cwd) : [];
        proc = this.spawnServer(spec.cwd, this.processEnv(spec.env), 'pipe');
        let stderr = '';
        proc.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
        proc.on('exit', (code) => resolveDone('failed', `il processo di Codex è terminato (codice ${code ?? '?'})${stderr.trim() ? `: ${lastLine(stderr)}` : ''}`));
        proc.on('error', (e) => resolveDone('failed', `impossibile avviare Codex (${this.bin()}): ${e.message}`));
        rpc = new RpcClient(proc.stdout!, proc.stdin!, { onNotification, onRequest, ...(recorder ? { onMessage: (m: RpcMessage, d: 'in' | 'out') => recorder({ t: d, msg: m }) } : {}) });

        await rpc.request('initialize', { clientInfo: { name: 'keystone', title: 'Keystone', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } }, 60_000);
        rpc.notify('initialized');
        await this.ensureAuth(rpc);
        await this.disableSkills(rpc, spec.cwd);

        const model = spec.model || this.defaultModel(spec.role);
        const common = {
          cwd: spec.cwd,
          approvalPolicy: 'untrusted',
          sandbox: spec.role === 'lead' ? 'read-only' : 'workspace-write',
          developerInstructions: `${spec.instructions}\n\n${CODEX_NOTES}`,
          config: this.threadConfig(spec, writableRoots),
          ...(model ? { model } : {}),
        };
        const started = resume
          ? await rpc.request<{ thread: { id: string }; model?: string; sandbox?: unknown }>('thread/resume', { threadId: resume, ...common })
          : await rpc.request<{ thread: { id: string }; model?: string; sandbox?: unknown }>('thread/start', { ...common, dynamicTools: dynamicTools(spec.tools), ephemeral: false });
        threadId = started.thread.id;
        emit({ type: 'session', sessionId: threadId });
        if (started.model) emit({ type: 'model', model: started.model });
        if (spec.role === 'worker' && (started.sandbox as { type?: string } | undefined)?.type !== 'workspaceWrite') {
          throw new Error(`Codex non ha attivato la sandbox con scrittura (${JSON.stringify(started.sandbox)}): turno non avviato`);
        }
        if (aborted) throw new Error('interrotto');
        // l'effort del singolo agente (config.json) vale prima di quello del ruolo
        const effort = codexEffort(spec.effort ?? (spec.role === 'lead' ? (this.cfg.leadEffort ?? this.cfg.effort) : this.cfg.effort));
        const t = await rpc.request<{ turn: { id: string } }>('turn/start', { threadId, input: turnInput(spec), ...(effort ? { effort } : {}) });
        turnId = t.turn.id;
        const res = await done;
        if (aborted || res.status === 'interrupted') emit({ type: 'turn_end', status: 'aborted' });
        else if (res.status === 'completed') emit({ type: 'turn_end', status: 'success', ...(lastText ? { resultText: lastText } : {}) });
        else {
          if (res.error) emit({ type: 'error', message: truncate(res.error, 2000), ...(isAuthError(res.error) ? { auth: true } : {}) });
          emit({ type: 'turn_end', status: 'error' });
        }
      } catch (e) {
        if (aborted) emit({ type: 'turn_end', status: 'aborted' });
        else {
          const message = (e as Error).message ?? String(e);
          emit({ type: 'error', message: truncate(message, 2000), ...(isAuthError(message) ? { auth: true } : {}) });
          emit({ type: 'turn_end', status: 'error' });
        }
      } finally {
        rpc?.close();
        if (proc && proc.exitCode === null) proc.kill();
        channel.close();
      }
    })();

    return {
      events: channel,
      respond: (id, answer) => broker.respond(id, answer),
      abort: (reason) => {
        if (aborted) return;
        aborted = reason;
        broker.abort(reason);
        if (rpc && threadId && turnId) void rpc.request('turn/interrupt', { threadId, turnId }, 10_000).catch(() => undefined);
        const timer = setTimeout(() => {
          if (proc && proc.exitCode === null) proc.kill();
          resolveDone('interrupted');
        }, 5_000);
        timer.unref?.();
      },
    };
  }

  /** Chiave API (modalità predefinita) o login ChatGPT, sempre nella CODEX_HOME di Keystone. */
  private async ensureAuth(rpc: RpcClient): Promise<void> {
    const acc = await rpc.request<{ account: Json | null }>('account/read', { refreshToken: false });
    if (this.cfg.useCodexLogin) {
      if (acc.account?.type !== 'chatgpt') throw new Error(NO_CODEX_LOGIN_MESSAGE(this.cfg.codexHome));
      return;
    }
    const key = apiKeyFrom(process.env);
    if (!key) throw new Error(NO_CODEX_AUTH_MESSAGE(this.cfg.codexHome));
    // la chiave viene registrata solo nella CODEX_HOME di Keystone (auth.json), mai in ~/.codex
    await rpc.request('account/login/start', { type: 'apiKey', apiKey: key });
  }

  /** Disattiva le skill che Codex trova (di sistema, del repository): nessuna istruzione esterna. */
  private async disableSkills(rpc: RpcClient, cwd: string): Promise<void> {
    const list = await rpc.request<{ data?: Array<{ skills?: Array<{ name: string; path: string; enabled: boolean }> }> }>('skills/list', { cwds: [cwd], forceReload: true }).catch(() => ({ data: [] }));
    for (const entry of list.data ?? []) {
      for (const s of entry.skills ?? []) if (s.enabled) await rpc.request('skills/config/write', { path: s.path, enabled: false });
    }
  }

  /** Registratore di trascrizioni (attivo solo con recordDir): una riga JSON per messaggio. */
  private recorder(spec: TurnSpec): ((entry: unknown) => void) | undefined {
    if (!this.cfg.recordDir) return undefined;
    const file = path.join(ensureDir(this.cfg.recordDir), `codex-${spec.agentId}-${spec.job.kind}-${spec.job.taskId ?? spec.job.goalId ?? 'x'}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify({ t: 'turn', engine: 'codex', version: CODEX_VERSION, role: spec.role, kind: spec.job.kind })}\n`);
    return (entry) => {
      // la chiave API di login/start non va mai nelle trascrizioni
      const e = entry as { msg?: RpcMessage };
      if (e.msg?.method === 'account/login/start') return;
      fs.appendFileSync(file, `${JSON.stringify(entry, redactImageData)}\n`);
    };
  }
}

/** Il risultato di un tool del team per Codex: testo e immagini come data URL (inputImage). */
export function toolContentItems(r: TeamToolResult): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [{ type: 'inputText', text: r.text }];
  for (const img of r.images ?? []) {
    let data: Buffer | undefined;
    try {
      data = fs.readFileSync(img.path);
    } catch {
      data = undefined;
    }
    if (!data) items.push({ type: 'inputText', text: `${img.caption}: schermata non disponibile` });
    else items.push({ type: 'inputText', text: img.caption }, { type: 'inputImage', imageUrl: `data:image/png;base64,${data.toString('base64')}` });
  }
  return items;
}

/** L'input del turno: il prompt e, se ci sono, le immagini locali (localImage), ognuna con la sua didascalia. */
export function turnInput(spec: Pick<TurnSpec, 'prompt' | 'images'>): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [{ type: 'text', text: spec.prompt, text_elements: [] }];
  for (const img of spec.images ?? []) {
    if (!fs.existsSync(img.path)) {
      input.push({ type: 'text', text: `${img.caption}: schermata non disponibile`, text_elements: [] });
      continue;
    }
    input.push({ type: 'text', text: img.caption, text_elements: [] }, { type: 'localImage', path: img.path });
  }
  return input;
}

/** I tool del team come dynamicTools di Codex (schema JSON dallo schema zod). */
export function dynamicTools(tools: TeamTool[]): Json[] {
  return tools.map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.schema) }));
}

function apiKeyFrom(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string | undefined {
  return env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || undefined;
}

function isAuthError(message: string): boolean {
  return /\b401\b|unauthori[sz]ed|invalid api key|not logged in|login|authentication|requiresOpenaiAuth/i.test(message);
}

function lastLine(s: string): string {
  return truncate(s.trim().split('\n').filter((l) => !/PATH aliases/.test(l)).slice(-1)[0] ?? '', 300);
}

const CODEX_NOTES = [
  'Note per questo ambiente:',
  '- ogni comando e ogni modifica passano dalla policy di Keystone: se un\'azione viene negata, trova un\'altra strada o chiedi con ask_user;',
  '- su Windows usa npm.cmd e npx.cmd invece di npm e npx;',
  '- non hai accesso alla rete;',
  '- non fare mai git push.',
].join('\n');

export const NO_CODEX_AUTH_MESSAGE = (home: string) =>
  'nessuna credenziale per Codex: imposta OPENAI_API_KEY (o CODEX_API_KEY) nel terminale dell\'orchestratore e riavvia. ' +
  `La chiave viene registrata solo nella cartella di Keystone (${home}), mai in ~/.codex. ` +
  'Per il login ChatGPT usa --use-codex-login (vedi docs/motore-codex.md).';

export const NO_CODEX_LOGIN_MESSAGE = (home: string) =>
  `login ChatGPT di Codex abilitato ma non trovato nella cartella di Keystone: esegui una volta, in PowerShell, $env:CODEX_HOME = "${home}"; npx codex login ` +
  '(serve un piano ChatGPT), poi riavvia. Keystone non legge ~/.codex.';
