// Il contratto tra preload e renderer (window.keystone). Solo tipi: nessun accesso a Node o a
// Electron arriva al renderer, che vede soltanto queste funzioni.
import type { DiffFile, NotifyLevel, RepoPreview, ViewState } from '@keystone/shared';
import type { ValidatedCommand } from './ipc-validate.js';

export interface Ack {
  ok: boolean;
  error?: string;
  result?: Record<string, unknown>;
}

export type UiEvent = { type: 'notify'; level: NotifyLevel; text: string } | { type: 'say'; agentId: string; to?: string; text: string; ts: number };

export interface ConnectionInfo {
  url: string;
  /** l'app può avviare l'orchestratore (sviluppo: sorgenti presenti) */
  canStart: boolean;
}

export interface KeystoneApi {
  getState(): Promise<ViewState>;
  onState(cb: (s: ViewState) => void): () => void;
  onEvent(cb: (e: UiEvent) => void): () => void;
  send(cmd: ValidatedCommand): Promise<Ack>;
  requestDiff(repoId: string, worktree: string): Promise<{ ok: true; files: DiffFile[] } | { ok: false; error: string }>;
  previewRepo(path: string): Promise<{ ok: true; preview: RepoPreview } | { ok: false; error: string }>;
  pickFolder(): Promise<string | undefined>;
  connection(): Promise<ConnectionInfo>;
  startOrchestrator(): Promise<Ack>;
}

export const CHANNELS = {
  getState: 'ks:get-state',
  state: 'ks:state',
  event: 'ks:event',
  send: 'ks:send',
  diff: 'ks:diff',
  preview: 'ks:preview',
  pickFolder: 'ks:pick-folder',
  connection: 'ks:connection',
  start: 'ks:start-orchestrator',
} as const;
