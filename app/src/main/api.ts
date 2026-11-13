// Il contratto tra preload e renderer (window.keystone). Solo tipi: nessun accesso a Node o a
// Electron arriva al renderer, che vede soltanto queste funzioni.
import type { DiffFile, NotifyLevel, RepoPreview, ViewState } from '@keystone/shared';
import type { ValidatedCommand } from './ipc-validate.js';
import type { CredentialKind, EngineAuthStatus, EngineChoice } from './engine-auth.js';
import type { UpdateStatus } from './updates.js';

export type { UpdateStatus } from './updates.js';
export type { CredentialKind, EngineAuthStatus, EngineChoice } from './engine-auth.js';

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
  /** il profilo dell'app (KEYSTONE_PROFILE, default "default") */
  profile: string;
  /** i profili esistenti, tra cui scegliere all'avvio */
  profiles: string[];
  /** app impacchettata (non avviata dai sorgenti) */
  packaged: boolean;
}

export interface KeystoneApi {
  getState(): Promise<ViewState>;
  onState(cb: (s: ViewState) => void): () => void;
  onEvent(cb: (e: UiEvent) => void): () => void;
  send(cmd: ValidatedCommand): Promise<Ack>;
  requestDiff(repoId: string, worktree: string): Promise<{ ok: true; files: DiffFile[] } | { ok: false; error: string }>;
  /** una schermata della verifica visuale di un task (data URL PNG) */
  requestShot(taskId: string, shotId: string): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }>;
  previewRepo(path: string): Promise<{ ok: true; preview: RepoPreview } | { ok: false; error: string }>;
  pickFolder(): Promise<string | undefined>;
  connection(): Promise<ConnectionInfo>;
  /** avvia l'orchestratore con il motore scelto in Impostazioni, con il profilo dell'app o quello indicato */
  startOrchestrator(profile?: string): Promise<Ack>;
  /** ferma l'orchestratore collegato e lo riavvia con il motore scelto (profilo dell'app) */
  restartOrchestrator(): Promise<Ack>;
  /** motore scelto e quali credenziali sono salvate (mai i valori) */
  engineStatus(): Promise<EngineAuthStatus>;
  /**
   * Sceglie il motore e/o salva una credenziale (`value` null = toglila; senza `value` non cambia
   * nulla). Il main la cifra con safeStorage; il renderer non la rilegge mai.
   */
  setEngine(choice: EngineChoice | null, kind?: CredentialKind | null, value?: string | null): Promise<Ack>;
  /**
   * Password di una connessione a database: il main la cifra con safeStorage e la passa
   * all'orchestratore (null = toglila). Il renderer non la rilegge mai.
   */
  setDbPassword(repoId: string, connectionId: string, password: string | null, destination?: string): Promise<Ack>;
  /** Le connessioni che hanno una password ("repoId/connectionId"), mai le password. */
  dbPasswordKeys(): Promise<string[]>;
  /** Ferma l'orchestratore collegato in modo ordinato (salva lo stato ed esce). */
  stopOrchestrator(): Promise<Ack>;
  /** Stato del controllo degli aggiornamenti. */
  updateStatus(): Promise<UpdateStatus>;
  onUpdate(cb: (s: UpdateStatus) => void): () => void;
  /** Controlla adesso (anche con il controllo automatico spento). */
  checkUpdates(): Promise<UpdateStatus>;
  setUpdateCheck(on: boolean): Promise<UpdateStatus>;
  /** Apre nel browser la pagina della release disponibile (il link lo sceglie il main, non il renderer). */
  openRelease(): Promise<boolean>;
}

export const CHANNELS = {
  getState: 'ks:get-state',
  state: 'ks:state',
  event: 'ks:event',
  send: 'ks:send',
  diff: 'ks:diff',
  shot: 'ks:visual-shot',
  preview: 'ks:preview',
  pickFolder: 'ks:pick-folder',
  connection: 'ks:connection',
  start: 'ks:start-orchestrator',
  dbPassword: 'ks:db-password',
  dbPasswordKeys: 'ks:db-password-keys',
  stop: 'ks:stop-orchestrator',
  updateStatus: 'ks:update-status',
  update: 'ks:update',
  updateCheck: 'ks:update-check',
  updateSet: 'ks:update-set',
  openRelease: 'ks:open-release',
  engineStatus: 'ks:engine-status',
  engineSet: 'ks:engine-set',
  restart: 'ks:restart-orchestrator',
} as const;
