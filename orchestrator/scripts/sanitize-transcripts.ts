// Pulisce le trascrizioni registrate con --record e le copia tra le fixture dei test.
//
//   npx tsx orchestrator/scripts/sanitize-transcripts.ts <cartella-registrazioni> [--write]
//
// Sostituisce percorsi della home e nome utente con <HOME> e <USER>. Se dopo la pulizia resta
// qualcosa che sembra un segreto (chiavi, token, intestazioni, variabili di credenziali, dump
// dell'ambiente) NON copia nulla ed elenca file e righe, senza mostrare il valore.
// Senza --write mostra solo cosa farebbe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLeaks, sanitizeLocal } from '../test/transcript-secrets.js';

const [src, ...flags] = process.argv.slice(2);
if (!src) {
  process.stderr.write('uso: npx tsx orchestrator/scripts/sanitize-transcripts.ts <cartella> [--write]\n');
  process.exit(2);
}
const write = flags.includes('--write');
const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'claude', 'real');
const home = os.homedir();
const user = os.userInfo().username;

const files = fs.readdirSync(src).filter((f) => f.endsWith('.jsonl'));
let problems = 0;
const ready: Array<{ name: string; text: string }> = [];
for (const f of files) {
  // si pulisce ogni stringa dopo il parsing (anche le chiavi): niente sequenze di escape rotte
  const clean = (v: unknown): unknown =>
    typeof v === 'string'
      ? sanitizeLocal(v, home, user)
      : Array.isArray(v)
        ? v.map(clean)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [sanitizeLocal(k, home, user), clean(x)]))
          : v;
  const lines = fs
    .readFileSync(path.join(src, f), 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  const text = `${lines.map((l) => JSON.stringify(clean(JSON.parse(l)))).join('\n')}\n`;
  const leaks = findLeaks(text);
  if (leaks.length) {
    problems += leaks.length;
    for (const l of leaks) process.stdout.write(`${f}:${l.line}: ${l.name} (${l.excerpt})\n`);
  }
  ready.push({ name: f.replace(/-\d{13}-[0-9a-f]{6}\.jsonl$/, '.jsonl'), text });
}
if (problems) {
  process.stdout.write(`\n${problems} problemi: nessun file copiato. Controlla a mano le righe indicate.\n`);
  process.exit(1);
}
for (const r of ready) process.stdout.write(`${write ? 'copio' : 'copierei'} ${r.name} (${r.text.split('\n').length - 1} righe)\n`);
if (write) {
  fs.mkdirSync(dest, { recursive: true });
  for (const r of ready) fs.writeFileSync(path.join(dest, r.name), r.text);
  process.stdout.write(`fatto: ${ready.length} file in ${path.relative(process.cwd(), dest)}\n`);
}
