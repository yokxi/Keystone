// Crea un piccolo repository di prova per provare Keystone senza toccare repository veri.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './util/git.js';

export async function createDemoRepo(dir: string, opts: { force?: boolean } = {}): Promise<string> {
  if (fs.existsSync(dir)) {
    if (!opts.force) return dir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Progetto demo\n\nRepository di prova per Keystone.\n');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'keystone-demo', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, 'index.js'), "export function saluta(nome) {\n  return `Ciao, ${nome}!`;\n}\n");
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Keystone Demo', GIT_AUTHOR_EMAIL: 'demo@keystone.local', GIT_COMMITTER_NAME: 'Keystone Demo', GIT_COMMITTER_EMAIL: 'demo@keystone.local' };
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['add', '-A']);
  await git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Commit iniziale'], { env });
  return dir;
}
