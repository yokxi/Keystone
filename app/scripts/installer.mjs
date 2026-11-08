// Installatore per Windows: compila app/installer/keystone.nsi con NSIS (makensis) sulla cartella
// dell'app portabile.
//
//   npm run installer -w app                   -> pacchetto portabile, poi app/release/Keystone-Setup-<versione>.exe
//   npm run installer -w app -- --zip          -> anche lo zip portabile (per la release)
//   npm run installer -w app -- --skip-package -> usa la cartella portabile già creata
//
// NSIS non è una dipendenza npm: è un programma a parte (https://nsis.sourceforge.io, versione 3).
// Lo script lo cerca in quest'ordine: la variabile MAKENSIS, il PATH, %USERPROFILE%\strumenti\nsis-*\,
// le cartelle d'installazione standard. Niente electron-builder: vedi docs/pacchetto.md.
//
// Accanto all'installatore scrive <nome>.sha256 (l'impronta da pubblicare nella release).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(appDir, '..');

/** Un testo letterale per NSIS (senza virgolette intorno): $ e " vanno protetti. */
export function nsisEscape(s) {
  if (/[\r\n]/.test(s)) throw new Error(`percorso con un a capo: ${JSON.stringify(s)}`);
  return s.replace(/\$/g, '$$$$').replace(/"/g, '$\\"');
}

/** Un percorso dentro la cartella d'installazione, tra virgolette: "$INSTDIR\<rel protetto>". */
export function instPath(rel) {
  return `"$INSTDIR\\${nsisEscape(rel)}"`;
}

/**
 * L'elenco per il disinstallatore: un Delete per ogni file, poi un RMDir (non ricorsivo) per ogni
 * cartella, dalla più profonda. Così si toglie solo ciò che l'installatore ha messo.
 */
export function uninstallList(srcDir) {
  const files = [];
  const dirs = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(srcDir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}\\${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new Error(`collegamento simbolico nel pacchetto: ${r}`);
      if (e.isDirectory()) {
        dirs.push(r);
        walk(r);
      } else files.push(r);
    }
  };
  walk('');
  dirs.sort((a, b) => b.split('\\').length - a.split('\\').length || b.localeCompare(a));
  return [...files.map((f) => `Delete ${instPath(f)}`), ...dirs.map((d) => `RMDir ${instPath(d)}`)].join('\r\n') + '\r\n';
}

/** Il makensis da usare, o undefined. */
export function findMakensis(env = process.env, exists = fs.existsSync, listDir = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : [])) {
  if (env.MAKENSIS) return exists(env.MAKENSIS) ? env.MAKENSIS : undefined;
  const exe = process.platform === 'win32' ? 'makensis.exe' : 'makensis';
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) if (dir && exists(path.join(dir, exe))) return path.join(dir, exe);
  const tools = path.join(env.USERPROFILE ?? os.homedir(), 'strumenti');
  // la versione più recente tra quelle estratte (nsis-3.13, nsis-3.12, …)
  const versions = listDir(tools)
    .filter((n) => /^nsis-\d+\.\d+$/.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) if (exists(path.join(tools, v, exe))) return path.join(tools, v, exe);
  for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles]) if (base && exists(path.join(base, 'NSIS', exe))) return path.join(base, 'NSIS', exe);
  return undefined;
}

function main() {
  if (process.platform !== 'win32') throw new Error("l'installatore NSIS si crea solo su Windows");
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`versione non valida per l'installatore: ${version}`);
  const platform = `${process.platform}-${process.arch}`;
  const src = path.join(appDir, 'release', `Keystone-${platform}`);

  const makensis = findMakensis();
  if (!makensis) throw new Error('NSIS non trovato: indica makensis.exe con MAKENSIS=<percorso> oppure estrai NSIS 3 in %USERPROFILE%\\strumenti\\nsis-<versione> (vedi docs/pacchetto.md)');

  if (!process.argv.includes('--skip-package')) execFileSync(process.execPath, [path.join(appDir, 'scripts', 'package.mjs'), ...(process.argv.includes('--zip') ? ['--zip'] : [])], { cwd: root, stdio: 'inherit' });
  if (!fs.existsSync(path.join(src, 'Keystone.exe'))) throw new Error(`manca l'app portabile in ${src}: lancia prima npm run package -w app`);

  const work = path.join(appDir, 'release', '.installer');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const unlist = path.join(work, 'uninstall-list.nsh');
  // NSIS legge gli include Unicode con il BOM
  fs.writeFileSync(unlist, '﻿' + uninstallList(src), 'utf8');

  const out = path.join(appDir, 'release', `Keystone-Setup-${version}.exe`);
  fs.rmSync(out, { force: true });
  console.log(`installatore: ${makensis}`);
  execFileSync(makensis, ['/V2', '/INPUTCHARSET', 'UTF8', `/DVERSION=${version}`, `/DSRC=${src}`, `/DOUTFILE=${out}`, `/DUNLIST=${unlist}`, `/DICON=${path.join(appDir, 'assets', 'icon.ico')}`, path.join(appDir, 'installer', 'keystone.nsi')], { stdio: 'inherit' });
  if (!fs.existsSync(out)) throw new Error('makensis non ha scritto l\'installatore');

  const hash = createHash('sha256').update(fs.readFileSync(out)).digest('hex');
  fs.writeFileSync(`${out}.sha256`, `${hash}  ${path.basename(out)}\n`);
  console.log(`installatore pronto: ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(0)} MB)\nSHA-256: ${hash}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
