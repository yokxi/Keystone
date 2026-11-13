// Riconoscere le variabili d'ambiente con segreti, per tenerle lontane dai comandi degli agenti,
// dai test e dai comandi git nei repository. Le credenziali dei motori passano a parte.

/**
 * Parole che, come pezzo del nome (separato da "_"), indicano un segreto: chiavi API, token di
 * login, credenziali cloud, password. Es. ANTHROPIC_API_KEY, AWS_BEARER_TOKEN_BEDROCK,
 * GOOGLE_APPLICATION_CREDENTIALS, DB_PASSWD, STRIPE_KEY. Per pezzi interi, così KEYSTONE_HOME o
 * TOKENIZER_PATH restano.
 */
const SECRET_WORDS = new Set(['KEY', 'APIKEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASS', 'PASSPHRASE', 'CREDENTIAL', 'CREDENTIALS', 'BEARER', 'PAT', 'COOKIE']);

/** URL con utente e password (es. DATABASE_URL=postgres://u:pw@host/db). */
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^@\s]+@/i;

/**
 * Variabili con segreti: non arrivano mai ai comandi degli agenti né ai test e alle app che
 * Keystone esegue nei loro worktree, perché quel codice lo scrive l'agente.
 */
export function isSecretVar(name: string, value?: string): boolean {
  if (name.toUpperCase().split('_').some((w) => SECRET_WORDS.has(w))) return true;
  return value !== undefined && URL_WITH_PASSWORD.test(value.trim());
}

/** L'ambiente senza segreti (anche per i comandi git che Keystone esegue nei repository). */
export function withoutSecrets(base: NodeJS.ProcessEnv | Record<string, string | undefined>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !isSecretVar(k, v)) out[k] = v;
  return out;
}

/**
 * Le credenziali che servono alla CLI di Claude, e solo quelle: Anthropic, login di Claude Code e
 * i provider cloud supportati (Bedrock, Vertex, Foundry). Altri segreti dell'utente (GITHUB_TOKEN,
 * NPM_TOKEN, …) non arrivano nemmeno alla CLI.
 */
const ENGINE_CREDENTIAL = /^(ANTHROPIC_|CLAUDE_CODE_|AWS_|AZURE_)|^GOOGLE_APPLICATION_CREDENTIALS$/i;

export function engineCredentials(base: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && isSecretVar(k, v) && ENGINE_CREDENTIAL.test(k)) out[k] = v;
  return out;
}

