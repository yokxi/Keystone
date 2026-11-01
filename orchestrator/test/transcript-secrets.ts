// Cosa non deve mai finire in una trascrizione registrata (orchestrator/test/fixtures/claude/).
// Usato dal test delle fixture e dallo script di pulizia (orchestrator/scripts/sanitize-transcripts.ts).

/** Segreti: chiavi, token, intestazioni di autenticazione, variabili d'ambiente di credenziali. */
export const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'chiave Anthropic', re: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: 'chiave in stile sk-', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'token OAuth di Claude', re: /\b(sk-ant-oat|CLAUDE_CODE_OAUTH_TOKEN)\b/ },
  { name: 'intestazione Authorization', re: /\bauthorization\b\s*["']?\s*[:=]/i },
  { name: 'intestazione x-api-key', re: /\bx-api-key\b/i },
  { name: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/ },
  { name: 'variabile di credenziali', re: /\b(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|AZURE_[A-Z_]*KEY|GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY)\b/ },
  { name: 'chiave AWS', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'token GitHub', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'chiave privata', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // un dump dell'ambiente (env / set / Get-ChildItem env:) ha sempre queste variabili
  { name: 'dump dell\'ambiente', re: /\b(USERPROFILE|APPDATA|LOCALAPPDATA|COMPUTERNAME)=/ },
];

/** Dati locali: percorsi della home e nome utente vanno sostituiti con segnaposto. */
export const LOCAL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'percorso utente Windows', re: /[A-Za-z]:(\\\\|\\|\/)+Users(\\\\|\\|\/)+(?!<USER>)[^\\/"'\s]+/i },
  { name: 'percorso utente POSIX', re: /\/(home|Users)\/(?!<USER>)[^/"'\s]+/ },
];

export function findLeaks(text: string, patterns = [...SECRET_PATTERNS, ...LOCAL_PATTERNS]): Array<{ name: string; line: number; excerpt: string }> {
  const out: Array<{ name: string; line: number; excerpt: string }> = [];
  // unica eccezione: il messaggio init dell'SDK dice DA DOVE viene la chiave (es. "ANTHROPIC_API_KEY"),
  // non il suo valore. Solo un nome di variabile o "none" è ammesso.
  const allowed = (l: string) => l.replace(/"apiKeySource"\s*:\s*"(?:[A-Z][A-Z0-9_]{0,60}|none|user|project|org|temporary)"/g, '"apiKeySource":"<ok>"');
  text.split('\n').map(allowed).forEach((l, i) => {
    for (const p of patterns) {
      const m = p.re.exec(l);
      // l'estratto non riporta il valore trovato
      if (m) out.push({ name: p.name, line: i + 1, excerpt: `${l.slice(Math.max(0, m.index - 20), m.index)}[…]` });
    }
  });
  return out;
}

/**
 * Sostituisce percorsi della home e nome utente con segnaposto, in tutte le forme (\, \\ in JSON,
 * /, maiuscole diverse della lettera di unità).
 */
export function sanitizeLocal(text: string, home: string, user: string): string {
  let out = text;
  const forms = new Set<string>();
  const fwd = home.replace(/\\/g, '/');
  forms.add(home);
  forms.add(fwd);
  forms.add(home.replace(/\\/g, '\\\\'));
  if (/^[A-Za-z]:/.test(home)) {
    // /c/Users/... (git bash) e c:\... minuscolo
    forms.add(`/${home[0]!.toLowerCase()}${fwd.slice(2)}`);
    for (const f of [...forms]) forms.add(f[0] === '/' ? f : f[0]!.toLowerCase() + f.slice(1));
  }
  for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join('<HOME>');
  if (user.length >= 3) out = out.replace(new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '<USER>');
  return out;
}
