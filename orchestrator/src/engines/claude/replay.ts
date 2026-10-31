// Riproduzione di trascrizioni registrate del motore Claude, per i test senza API.
//
// Formato (JSONL, lo stesso che scrive ClaudeEngine con recordDir):
//   {"t":"turn", ...}                         intestazione (ignorata)
//   {"t":"msg","msg":<SDKMessage>}            un messaggio dello stream dell'SDK
//   {"t":"hook","toolUseId","toolName","input"} la CLI chiede il permesso per un tool
//
// Durante il replay l'hook PreToolUse viene chiamato DAVVERO (quindi passa dalla policy e
// dall'utente come in un turno vero), e i tool del team (mcp__keystone__*) vengono eseguiti
// davvero sull'orchestratore. Se un tool è negato, il suo tool_result registrato viene sostituito
// da un errore, come farebbe la CLI.
import fs from 'node:fs';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TeamTool } from '../types.js';
import type { QueryFn } from './claude-engine.js';

export type TranscriptEntry = { t: 'turn'; [k: string]: unknown } | { t: 'msg'; msg: Record<string, unknown> } | { t: 'hook'; toolUseId: string; toolName: string; input: Record<string, unknown> };

export function loadTranscript(file: string): TranscriptEntry[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TranscriptEntry);
}

export interface ReplayRecord {
  /** le opzioni con cui il motore ha avviato il turno (per verificarle nei test) */
  options?: Options;
  prompt?: string;
  decisions: Array<{ toolUseId: string; toolName: string; decision: string; reason?: string }>;
  closed: boolean;
}

/**
 * Una QueryFn che riproduce, turno dopo turno, le trascrizioni indicate. `record` raccoglie cosa è
 * successo (opzioni, decisioni dell'hook), per le asserzioni dei test.
 */
export function replayQuery(turns: TranscriptEntry[][], records: ReplayRecord[] = []): QueryFn {
  let next = 0;
  return ({ prompt, options }, ctx) => {
    const entries = turns[Math.min(next++, turns.length - 1)] ?? [];
    const rec: ReplayRecord = { options, prompt, decisions: [], closed: false };
    records.push(rec);
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
    const signal = options.abortController?.signal ?? new AbortController().signal;
    const denied = new Map<string, string>();
    const toolNames = new Map<string, string>();
    async function* gen(): AsyncGenerator<SDKMessage> {
      for (const e of entries) {
        if (rec.closed || signal.aborted) return;
        if (e.t === 'turn') continue;
        if (e.t === 'hook') {
          toolNames.set(e.toolUseId, e.toolName);
          if (!hook) throw new Error('replay: nessun hook PreToolUse registrato dal motore');
          const out = (await hook({ hook_event_name: 'PreToolUse', tool_name: e.toolName, tool_input: e.input, tool_use_id: e.toolUseId, session_id: 'replay', transcript_path: '', cwd: options.cwd ?? '' } as never, e.toolUseId, { signal })) as {
            hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
          };
          const decision = out.hookSpecificOutput?.permissionDecision ?? 'none';
          rec.decisions.push({ toolUseId: e.toolUseId, toolName: e.toolName, decision, ...(out.hookSpecificOutput?.permissionDecisionReason ? { reason: out.hookSpecificOutput.permissionDecisionReason } : {}) });
          if (decision !== 'allow') denied.set(e.toolUseId, out.hookSpecificOutput?.permissionDecisionReason ?? 'negato');
          continue;
        }
        const msg = structuredClone(e.msg);
        if (msg.type === 'user') {
          const content = (msg.message as { content?: unknown })?.content;
          if (Array.isArray(content)) {
            for (const block of content as Array<Record<string, unknown>>) {
              if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
              const id = block.tool_use_id;
              if (denied.has(id)) {
                block.content = `Permesso negato: ${denied.get(id)}`;
                block.is_error = true;
                continue;
              }
              const name = toolNames.get(id) ?? '';
              const team = name.startsWith('mcp__keystone__') ? ctx.tools.find((t: TeamTool) => `mcp__keystone__${t.name}` === name) : undefined;
              if (team) {
                // il tool del team viene eseguito davvero sull'orchestratore
                const input = findToolInput(entries, id);
                const r = await team.run(input);
                block.content = [{ type: 'text', text: r.text }];
                block.is_error = !!r.isError;
              }
            }
          }
        }
        yield msg as unknown as SDKMessage;
      }
    }
    const it = gen();
    return Object.assign(it, {
      close() {
        rec.closed = true;
      },
    });
  };
}

function findToolInput(entries: TranscriptEntry[], toolUseId: string): Record<string, unknown> {
  for (const e of entries) {
    if (e.t === 'hook' && e.toolUseId === toolUseId) return e.input;
  }
  return {};
}
