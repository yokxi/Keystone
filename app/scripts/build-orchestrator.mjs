// Bundle dell'orchestratore per l'app impacchettata (Fase 8): un solo file ES in
// app/dist/orchestrator/main.mjs, che gira con il Node di Electron (ELECTRON_RUN_AS_NODE) senza i
// sorgenti e senza tsx.
//
// Restano fuori dal bundle (e vengono copiati accanto, in node_modules, con le loro dipendenze) i
// pacchetti che contengono binari o che li cercano accanto a sé: l'SDK di Claude (CLI nativa per
// piattaforma), Codex (binario nativo) e playwright-core (CLI per scaricare Chromium), più zod, che
// l'SDK di Claude usa come dipendenza "peer": il codice di Keystone e l'SDK devono usare la stessa
// copia (gli schemi dei tool passano dall'uno all'altro). Le versioni
// copiate sono quelle installate dal lockfile: nessun download.
//
//   node app/scripts/build-orchestrator.mjs [--out <cartella>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { EXTERNAL, PLATFORM_PREFIXES, platformPackages } from './externals.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outArg = process.argv.indexOf('--out');
const outDir = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'app', 'dist', 'orchestrator');

/** Pacchetti per piattaforma (binari nativi): solo quello della piattaforma che si impacchetta. */
const PLATFORM = `${process.platform}-${process.arch}`;
const PLATFORM_PACKAGES = platformPackages(PLATFORM);

const isExternal = (id) => EXTERNAL.some((p) => id === p || id.startsWith(`${p}/`));

fs.rmSync(outDir, { recursive: true, force: true });
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    ssr: path.join(root, 'orchestrator', 'src', 'main.ts'),
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    target: 'node22',
    minify: false,
    rollupOptions: {
      // le dipendenze native facoltative di ws non servono
      external: (id) => isExternal(id) || id.startsWith('node:') || id === 'bufferutil' || id === 'utf-8-validate',
      output: { format: 'es', entryFileNames: 'main.mjs' },
    },
  },
  ssr: { noExternal: true, target: 'node' },
});

// ---- node_modules dei pacchetti esterni ----------------------------------------------------

const nm = path.join(root, 'node_modules');
const copied = new Set();
const walked = new Set();
// solo i pacchetti nativi noti (elenco esplicito in externals.mjs), per le altre piattaforme
const skipDep = (dep) => PLATFORM_PREFIXES.some((p) => dep.startsWith(p)) && !PLATFORM_PACKAGES.includes(dep);

/**
 * Dove Node troverebbe `dep` partendo dal pacchetto in `fromDir`: prima nel suo node_modules, poi
 * risalendo fino al node_modules della radice. Restituisce la cartella, o undefined se manca (una
 * dipendenza facoltativa per un'altra piattaforma, per esempio).
 */
function resolveFrom(fromDir, dep) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const cand = path.join(dir, 'node_modules', ...dep.split('/'));
    if (fs.existsSync(path.join(cand, 'package.json'))) return cand;
    if (path.resolve(dir) === path.resolve(root) || path.dirname(dir) === dir) return undefined;
  }
}

/** Le dipendenze del pacchetto (facoltative e "peer" comprese), seguite come farebbe Node. */
function walk(pkgDir) {
  if (walked.has(pkgDir)) return;
  walked.add(pkgDir);
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]) {
    if (skipDep(dep)) continue;
    const found = resolveFrom(pkgDir, dep);
    if (!found) continue;
    if (path.resolve(found) === path.resolve(nm, ...dep.split('/'))) copyPackage(dep);
    else walk(found); // annidato: copiato con il pacchetto che lo contiene, ma le sue dipendenze vanno seguite
  }
}

/** Copia un pacchetto del node_modules della radice (con i suoi node_modules annidati) e segue le dipendenze. */
function copyPackage(name) {
  if (copied.has(name)) return;
  const src = path.join(nm, ...name.split('/'));
  if (!fs.existsSync(path.join(src, 'package.json'))) return;
  copied.add(name);
  fs.cpSync(src, path.join(outDir, 'node_modules', ...name.split('/')), { recursive: true, dereference: true });
  walk(src);
}
for (const p of [...EXTERNAL, ...PLATFORM_PACKAGES]) copyPackage(p);
for (const p of PLATFORM_PACKAGES) if (!copied.has(p)) throw new Error(`manca ${p}: impossibile impacchettare per ${PLATFORM}`);

// un package.json minimo: il bundle è un modulo ES e risolve i pacchetti esterni qui accanto
const appPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ name: 'keystone-orchestrator', version: appPkg.version, private: true, type: 'module', main: 'main.mjs' }, null, 2) + '\n');
console.log(`orchestratore impacchettato in ${outDir} (${[...copied].length} pacchetti in node_modules)`);
