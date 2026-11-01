// Il comando che Codex chiede di eseguire arriva spesso avvolto nella shell (`powershell -Command
// "…"`, `bash -lc '…'`, `cmd /c …`). La policy di Keystone deve vedere il comando INTERNO: si toglie
// l'involucro e si dice quale shell lo eseguirà.
import path from 'node:path';

export interface UnwrappedCommand {
  tool: 'Bash' | 'PowerShell';
  command: string;
}

/** Divide una riga di comando come la scrive Codex (virgolette doppie e singole). */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && (s[i + 1] === '"' || s[i + 1] === '\\')) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

const PS = new Set(['powershell', 'pwsh']);
const SH = new Set(['bash', 'sh', 'zsh', 'dash']);

/**
 * Toglie l'involucro della shell. Se il comando non è avvolto, lo restituisce com'è (Bash). Un
 * involucro con opzioni che non conosciamo resta intero: la policy vedrà la shell e chiederà.
 */
export function unwrapShell(command: string): UnwrappedCommand {
  const args = splitArgs(command.trim());
  const prog = path.basename((args[0] ?? '').replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  if (PS.has(prog)) {
    let i = 1;
    while (i < args.length && /^-(nologo|noprofile|noninteractive|nop|noni|executionpolicy|ep)$/i.test(args[i]!)) i += /^-(executionpolicy|ep)$/i.test(args[i]!) ? 2 : 1;
    if (i < args.length && /^-(command|c)$/i.test(args[i]!) && i + 2 === args.length) return { tool: 'PowerShell', command: args[i + 1]! };
    return { tool: 'PowerShell', command };
  }
  if (SH.has(prog)) {
    const flags = args[1] ?? '';
    if (/^-[lic]*c[lic]*$/.test(flags) && args.length === 3) return { tool: 'Bash', command: args[2]! };
    return { tool: 'Bash', command };
  }
  if (prog === 'cmd') {
    if (/^\/[cC]$/.test(args[1] ?? '') && args.length >= 3) return { tool: 'Bash', command: args.slice(2).join(' ') };
  }
  return { tool: 'Bash', command };
}
