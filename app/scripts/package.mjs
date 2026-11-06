// Pacchetto portabile dell'app (Fase 8): una cartella con Keystone.exe che avvia da sola
// l'orchestratore impacchettato, senza i sorgenti e senza Node installato.
//
//   npm run package -w app            -> app/release/Keystone-<piattaforma>/
//   npm run package -w app -- --zip   -> anche app/release/Keystone-<versione>-<piattaforma>.zip
//
// Come è fatto:
//   Keystone.exe e i file di Electron   la distribuzione di Electron già installata (node_modules/electron)
//   resources/app/                      main, preload e renderer compilati (tutto in bundle, niente node_modules)
//   resources/orchestrator/             bundle dell'orchestratore + node_modules dei pacchetti con binari nativi
//
// Fuse di Electron (opzioni scritte nel binario): si spengono il passaggio di NODE_OPTIONS e degli
// argomenti --inspect, e si accende la cifratura dei cookie. RunAsNode resta acceso perché
// l'orchestratore gira con il Node di Electron (ELECTRON_RUN_AS_NODE): vedi docs/pacchetto.md.
//
// Nessuna dipendenza in più: tutto viene da node_modules, installato dal lockfile. Se il binario di
// Electron non è ancora stato scaricato, il pacchetto electron lo scarica (con i checksum ufficiali),
// come al primo `npm run app`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTERNAL } from './externals.mjs';
import { flipFuses, readFuses } from './fuses.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(appDir, '..');
const require = createRequire(import.meta.url);
const platform = `${process.platform}-${process.arch}`;
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const outDir = path.join(appDir, 'release', `Keystone-${platform}`);
const exeName = process.platform === 'win32' ? 'Keystone.exe' : 'keystone';

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false });

// 1. compilazione: app (produzione) e orchestratore
run(process.execPath, [path.join(appDir, 'scripts', 'build.mjs'), '--prod']);
const staging = path.join(appDir, 'release', '.orchestrator');
run(process.execPath, [path.join(appDir, 'scripts', 'build-orchestrator.mjs'), '--out', staging]);

// 2. la distribuzione di Electron
const electronExe = require('electron'); // percorso dell'eseguibile
const electronDist = path.dirname(electronExe);
fs.rmSync(outDir, { recursive: true, force: true });
fs.cpSync(electronDist, outDir, { recursive: true });
// l'app di esempio di Electron non serve (e non deve poter partire al posto di Keystone)
fs.rmSync(path.join(outDir, 'resources', 'default_app.asar'), { force: true });
fs.renameSync(path.join(outDir, path.basename(electronExe)), path.join(outDir, exeName));

// 3. l'app: solo i file compilati
const resApp = path.join(outDir, 'resources', 'app');
for (const d of ['main', 'preload', 'renderer']) fs.cpSync(path.join(appDir, 'dist', d), path.join(resApp, 'dist', d), { recursive: true, filter: (f) => !f.endsWith('.map') });
const appPkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(resApp, 'package.json'), JSON.stringify({ name: 'keystone', productName: 'Keystone', version, description: appPkg.description, main: appPkg.main, private: true }, null, 2) + '\n');

// 4. l'orchestratore
fs.renameSync(staging, path.join(outDir, 'resources', 'orchestrator'));

// 5. fuse, rilette dall'eseguibile scritto
const exe = path.join(outDir, exeName);
flipFuses(exe);
const fuses = readFuses(exe);
if (!fuses.startsWith('11000001')) throw new Error(`fuse di Electron non scritte come previsto: ${fuses}`);

// 6. controlli sul risultato, con l'eseguibile vero: ogni pacchetto che il bundle importa si carica
//    da resources/orchestrator (non dal repository), e i binari dei motori ci sono
const orchDir = path.join(outDir, 'resources', 'orchestrator');
const bundle = fs.readFileSync(path.join(orchDir, 'main.mjs'), 'utf8');
const imports = [...new Set([...bundle.matchAll(/(?:from |import\()"((?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._/-]+)?)"/g)].map((m) => m[1]).filter((s) => !s.startsWith('node:')))];
for (const p of imports) if (!EXTERNAL.some((e) => p === e || p.startsWith(`${e}/`))) throw new Error(`il bundle importa ${p}, che non è tra i pacchetti copiati`);
const check = imports.map((p) => `await import(${JSON.stringify(p)});`).join(' ');
// il pacchetto è dentro il repository: se un pacchetto mancasse in resources/orchestrator, Node lo
// troverebbe risalendo fino al node_modules del repository. Per questo si controlla dove si risolve
const where = `${check} const r = (p) => import.meta.resolve(p); console.log(JSON.stringify(${JSON.stringify(imports)}.map(r)));`;
const resolved = JSON.parse(execFileSync(exe, ['--input-type=module', '-e', where], { cwd: orchDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }).trim().split('\n').pop());
const orchUrl = new URL(`file:///${orchDir.replace(/\\/g, '/').replace(/^\//, '')}/`).href.toLowerCase();
for (const [i, u] of resolved.entries()) if (!u.toLowerCase().startsWith(orchUrl)) throw new Error(`${imports[i]} si risolve fuori dal pacchetto: ${u}`);
const triple = { 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc', 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl', 'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin' }[platform];
const win = process.platform === 'win32';
for (const bin of [
  path.join(orchDir, 'node_modules', '@openai', `codex-${platform}`, 'vendor', triple ?? '?', 'bin', win ? 'codex.exe' : 'codex'),
  path.join(orchDir, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${platform}`, win ? 'claude.exe' : 'claude'),
]) if (!fs.existsSync(bin)) throw new Error(`manca il binario ${bin}`);
console.log(`controlli: fuse ${fuses}; ${imports.length} pacchetti importati dal bundle si caricano dal pacchetto; binari di Codex e Claude presenti`);

// 7. licenze di Electron e Chromium: restano quelle della distribuzione (LICENSE, LICENSES.chromium.html)
console.log(`pacchetto pronto: ${outDir}`);

if (process.argv.includes('--zip')) {
  const zip = path.join(appDir, 'release', `Keystone-${version}-${platform}.zip`);
  fs.rmSync(zip, { force: true });
  // tar di Windows (bsdtar) crea zip con -a; altrove si usa zip
  if (process.platform === 'win32') run('tar.exe', ['-a', '-c', '-f', zip, '-C', path.dirname(outDir), path.basename(outDir)]);
  else run('zip', ['-r', '-q', zip, path.basename(outDir)]);
  console.log(`archivio: ${zip}`);
}
