// Compila l'app una volta prima della suite dell'interfaccia.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default function setup(): void {
  const appDir = path.resolve(import.meta.dirname, '..');
  execFileSync(process.execPath, [path.join(appDir, 'scripts', 'build.mjs')], { cwd: appDir, stdio: 'inherit' });
}
