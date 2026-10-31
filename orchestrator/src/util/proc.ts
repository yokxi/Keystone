// Esecuzione di un comando di shell con timeout: allo scadere viene terminato l'intero albero di
// processi (su Windows con taskkill /T, altrove con il gruppo di processi).
import { spawn, spawnSync } from 'node:child_process';

export interface ShellResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

const MAX_OUTPUT = 512 * 1024;

export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* già terminato */
  }
}

export function runShell(command: string, opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<ShellResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: opts.cwd, env: opts.env, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const add = (d: Buffer) => {
      if (output.length < MAX_OUTPUT) output += d.toString('utf8');
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, opts.timeoutMs);
    timer.unref?.();
    const done = (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut, durationMs: Date.now() - start });
    };
    child.on('error', (e) => {
      output += `\n${e.message}`;
      done(null);
    });
    child.on('close', (code) => done(code));
  });
}
