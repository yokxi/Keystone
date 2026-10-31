// Motore simulato: un EngineAdapter come gli altri, ma il "ragionamento" è una sceneggiatura.
// Tutto il resto è reale: chiede i permessi come un motore vero, chiama i tool del team, scrive
// file nel worktree e committa con git usando l'ambiente dell'agente (quindi con la sua identità).
// Serve a sviluppare e testare l'orchestratore senza consumare API.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EngineEvent, PermissionAnswer, Role } from '@keystone/shared';
import { isInsideOrEqual } from '../../util/fsx.js';
import { git } from '../../util/git.js';
import { truncate } from '../../util/text.js';
import { EventChannel, PermissionBroker } from '../channel.js';
import type { AuthCheck, EngineAdapter, EngineTurn, TeamToolResult, TurnSpec } from '../types.js';
import { defaultSimScript, type SimScript } from './script.js';

export class SimAborted extends Error {
  constructor(reason: string) {
    super(`turno interrotto: ${reason}`);
  }
}

export interface SimEngineOptions {
  /** pausa tra un passo e l'altro (0 nei test, qualche centinaio di ms per la demo) */
  stepDelayMs?: number;
  /** sceneggiatura alternativa (test) */
  script?: SimScript;
}

/** Le primitive che una sceneggiatura usa per agire. */
export interface SimContext {
  spec: TurnSpec;
  sessionId: string;
  resumed: boolean;
  say(text: string): Promise<void>;
  /** Emette tool_call + tool_result attorno a `fn`. */
  tool(name: string, input: Record<string, unknown>, fn: () => Promise<string>): Promise<string>;
  /** Chiama un tool del team (send_message, update_task, ...). */
  team(name: string, args: Record<string, unknown>): Promise<TeamToolResult>;
  /** Chiede un permesso, come farebbe un motore reale prima di usare un tool. */
  permission(tool: string, input: Record<string, unknown>, reason?: string): Promise<PermissionAnswer>;
  /** Scrive un file nella cartella di lavoro (chiede il permesso "Edit" prima). */
  writeFile(relPath: string, content: string): Promise<boolean>;
  readFile(relPath: string): string | undefined;
  /** git nella cartella di lavoro, con l'ambiente dell'agente. */
  git(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  usage(inputTokens: number, outputTokens: number): void;
  step(): Promise<void>;
}

export class SimEngine implements EngineAdapter {
  readonly id = 'sim' as const;
  readonly label = 'Sim';

  constructor(private opts: SimEngineOptions = {}) {}

  defaultModel(_role: Role): string {
    return 'sim';
  }

  displayModel(_model: string): string {
    return 'Sim';
  }

  async checkAuth(): Promise<AuthCheck> {
    return { ok: true, account: 'simulato (nessuna API)' };
  }

  startSession(spec: TurnSpec): EngineTurn {
    return this.run(`sim-${crypto.randomUUID()}`, spec, false);
  }

  resumeSession(sessionId: string, spec: TurnSpec): EngineTurn {
    return this.run(sessionId, spec, true);
  }

  private run(sessionId: string, spec: TurnSpec, resumed: boolean): EngineTurn {
    const channel = new EventChannel<EngineEvent>();
    const emit = (e: EngineEvent) => channel.push(e);
    const broker = new PermissionBroker(emit);
    const abort = new AbortController();
    const delay = this.opts.stepDelayMs ?? 0;
    let calls = 0;

    const check = () => {
      if (abort.signal.aborted) throw new SimAborted(String(abort.signal.reason ?? 'stop'));
    };
    const step = async () => {
      check();
      if (delay > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, delay);
          abort.signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });
      } else await Promise.resolve();
      check();
    };

    const ctx: SimContext = {
      spec,
      sessionId,
      resumed,
      step,
      async say(text) {
        await step();
        emit({ type: 'text', text });
      },
      async tool(name, input, fn) {
        await step();
        const callId = `c${++calls}`;
        emit({ type: 'tool_call', callId, tool: name, input });
        try {
          const out = await fn();
          emit({ type: 'tool_result', callId, ok: true, output: truncate(out, 4000) });
          return out;
        } catch (e) {
          if (e instanceof SimAborted) throw e;
          emit({ type: 'tool_result', callId, ok: false, output: (e as Error).message });
          throw e;
        }
      },
      async team(name, args) {
        const t = spec.tools.find((x) => x.name === name);
        if (!t) throw new Error(`tool del team sconosciuto: ${name}`);
        await step();
        const callId = `c${++calls}`;
        emit({ type: 'tool_call', callId, tool: name, input: args });
        const parsed = t.schema.safeParse(args);
        if (!parsed.success) {
          emit({ type: 'tool_result', callId, ok: false, output: parsed.error.message });
          return { text: parsed.error.message, isError: true };
        }
        const res = await t.run(parsed.data as Record<string, unknown>);
        check();
        emit({ type: 'tool_result', callId, ok: !res.isError, output: truncate(res.text, 4000) });
        return res;
      },
      async permission(tool, input, reason) {
        await step();
        const a = await broker.ask(tool, input, reason);
        check();
        return a;
      },
      async writeFile(relPath, content) {
        const abs = path.resolve(spec.cwd, relPath);
        if (!isInsideOrEqual(spec.cwd, abs)) throw new Error(`il sim scrive solo nella cartella di lavoro: ${relPath}`);
        const answer = await ctx.permission('Write', { file_path: abs, content: truncate(content, 200) });
        if (!answer.allow) {
          emit({ type: 'text', text: `Non posso scrivere ${relPath}: ${answer.message}` });
          return false;
        }
        const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
        if (before === content) return true;
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        emit({ type: 'file_change', path: relPath.replace(/\\/g, '/'), change: before === undefined ? 'add' : 'modify', diff: simpleDiff(relPath, before, content) });
        return true;
      },
      readFile(relPath) {
        const abs = path.resolve(spec.cwd, relPath);
        return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
      },
      async git(args) {
        return git(spec.cwd, args, { env: spec.env as NodeJS.ProcessEnv, allowFail: true });
      },
      usage(inputTokens, outputTokens) {
        emit({ type: 'usage', inputTokens, outputTokens, costUsd: 0 });
      },
    };

    const script = this.opts.script ?? defaultSimScript;
    void (async () => {
      emit({ type: 'session', sessionId });
      emit({ type: 'model', model: 'sim' });
      try {
        const resultText = await script(ctx);
        emit({ type: 'turn_end', status: 'success', ...(resultText ? { resultText } : {}) });
      } catch (e) {
        if (e instanceof SimAborted || abort.signal.aborted) emit({ type: 'turn_end', status: 'aborted' });
        else {
          emit({ type: 'error', message: (e as Error).message });
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
        abort.abort(reason);
        broker.abort(reason);
      },
    };
  }
}

/** Diff unificato minimale (file intero) per l'evento file_change. */
function simpleDiff(relPath: string, before: string | undefined, after: string): string {
  const p = relPath.replace(/\\/g, '/');
  const oldLines = before === undefined ? [] : before.replace(/\n$/, '').split('\n');
  const newLines = after.replace(/\n$/, '').split('\n');
  return [
    `--- ${before === undefined ? '/dev/null' : `a/${p}`}`,
    `+++ b/${p}`,
    `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
  ].join('\n');
}
