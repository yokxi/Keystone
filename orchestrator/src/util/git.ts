// Esecuzione di git per l'orchestratore. Le chiamate dell'orchestratore stesso usano l'ambiente
// normale; i processi degli agenti ricevono un ambiente dedicato (identità dell'agente, e in
// Fase 3 il blocco del push), costruito in core/agent-env.ts.
import { execFile } from 'node:child_process';
import { capitalize } from './text.js';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  env?: NodeJS.ProcessEnv;
  /** non lanciare se git esce con codice diverso da 0 */
  allowFail?: boolean;
  timeoutMs?: number;
  input?: string;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(`git ${args.join(' ')} è fallito (${result.code}): ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`);
    this.name = 'GitError';
  }
}

export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
        const res: GitResult = { code, stdout: String(stdout), stderr: String(stderr) };
        if (err && typeof (err as { code?: unknown }).code !== 'number' && !opts.allowFail) {
          reject(new GitError(args, { ...res, stderr: `${res.stderr}${(err as Error).message}` }));
          return;
        }
        if (code !== 0 && !opts.allowFail) reject(new GitError(args, res));
        else resolve(res);
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** stdout di git senza spazi finali; lancia se git fallisce. */
export async function gitOut(cwd: string, args: string[], opts: Omit<GitOptions, 'allowFail'> = {}): Promise<string> {
  return (await git(cwd, args, opts)).stdout.trimEnd();
}

/** Variabili d'ambiente per un'identità git (autore e committer). */
export function identityEnv(name: string, email: string): Record<string, string> {
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

/** Gli agenti committano come "Keystone <Nome>" <id@keystone.local>, mai con l'identità dell'utente. */
export function agentIdentity(agentId: string, displayName?: string): Record<string, string> {
  return identityEnv(`Keystone ${displayName ?? capitalize(agentId)}`, `${agentId}@keystone.local`);
}
