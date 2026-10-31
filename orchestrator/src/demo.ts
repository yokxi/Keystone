// Crea un piccolo repository di prova per provare Keystone senza toccare repository veri.
//
// Il repository creato da Keystone ha un marcatore in .git/keystone-demo.json. Solo per un
// repository con quel marcatore, nel percorso previsto, la modifica del guardiano al .git/config
// viene confermata automaticamente: qualunque altro repository richiede la conferma dell'utente.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, samePath, writeJsonAtomic } from './util/fsx.js';
import { git } from './util/git.js';

const MARKER = 'keystone-demo.json';

interface DemoMarker {
  createdBy: 'keystone';
  path: string;
  createdAt: number;
}

export async function createDemoRepo(dir: string, opts: { force?: boolean } = {}): Promise<string> {
  if (fs.existsSync(dir)) {
    // una cartella esistente non creata da Keystone non viene mai toccata
    if (!opts.force || !isKeystoneDemo(dir, dir)) return dir;
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
  const marker: DemoMarker = { createdBy: 'keystone', path: path.resolve(dir), createdAt: Date.now() };
  writeJsonAtomic(path.join(dir, '.git', MARKER), marker);
  return dir;
}

/**
 * `dir` è il repository di prova creato da Keystone nel percorso previsto (`expected`)?
 * Serve il marcatore scritto alla creazione, con lo stesso percorso.
 */
export function isKeystoneDemo(dir: string, expected: string): boolean {
  if (!samePath(dir, expected)) return false;
  try {
    const m = readJson<DemoMarker>(path.join(dir, '.git', MARKER));
    return m?.createdBy === 'keystone' && typeof m.path === 'string' && samePath(m.path, dir);
  } catch {
    return false;
  }
}
