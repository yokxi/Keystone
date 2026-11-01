// Autenticazione del motore Claude.
//
// Predefinita: autenticazione via API, come richiede la documentazione dell'Agent SDK per gli
// strumenti di terze parti: ANTHROPIC_API_KEY oppure un provider cloud supportato dall'SDK
// (Amazon Bedrock, Google Vertex AI, Microsoft Foundry, Claude Platform on AWS) o un gateway.
// Il login personale di Claude Code (abbonamento claude.ai) è DISATTIVATO di default: si usa solo
// se l'utente lo abilita esplicitamente, per uso personale. Anche allora la CLI NON legge ~/.claude:
// la credenziale arriva come CLAUDE_CODE_OAUTH_TOKEN (generato con `claude setup-token`) e la
// cartella di configurazione resta quella isolata di Keystone. Il file ~/.claude/.credentials.json
// non viene né letto né copiato: la CLI rinnova i token e una copia potrebbe invalidare il login
// dell'utente.

/** Variabili che fanno usare all'SDK un provider cloud al posto dell'API Claude. */
export const PROVIDER_SWITCHES: Record<string, string> = {
  CLAUDE_CODE_USE_BEDROCK: 'Amazon Bedrock',
  CLAUDE_CODE_USE_VERTEX: 'Google Vertex AI',
  CLAUDE_CODE_USE_FOUNDRY: 'Microsoft Foundry',
  CLAUDE_CODE_USE_ANTHROPIC_AWS: 'Claude Platform on AWS',
};

/** Variabili che portano il login claude.ai nella CLI: tolte se il login non è abilitato. */
export const CLAUDE_LOGIN_VARS = ['CLAUDE_CODE_OAUTH_TOKEN'];

/** Variabili di chiave API: tolte con il login personale (altrimenti scavalcherebbero il login). */
export const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export type ApiAuth = { ok: true; source: string } | { ok: false };

const truthy = (v: string | undefined) => !!v && v !== '0' && v.toLowerCase() !== 'false';

export function detectApiAuth(env: NodeJS.ProcessEnv | Record<string, string | undefined>): ApiAuth {
  if (env.ANTHROPIC_API_KEY?.trim()) return { ok: true, source: 'chiave API' };
  for (const [k, name] of Object.entries(PROVIDER_SWITCHES)) if (truthy(env[k])) return { ok: true, source: name };
  if (env.ANTHROPIC_AUTH_TOKEN?.trim() && env.ANTHROPIC_BASE_URL?.trim()) return { ok: true, source: 'gateway API' };
  return { ok: false };
}

/**
 * L'ambiente della CLI per la modalità scelta: in modalità API nessun token di login claude.ai;
 * con il login personale nessuna chiave API. I valori non vengono mai registrati nei log.
 */
export function envForAuth(env: Record<string, string | undefined>, useClaudeLogin: boolean): Record<string, string | undefined> {
  const out = { ...env };
  const drop = useClaudeLogin ? API_KEY_VARS : CLAUDE_LOGIN_VARS;
  for (const k of Object.keys(out)) if (drop.includes(k.toUpperCase())) delete out[k];
  return out;
}

/** Il login personale: solo il token di `claude setup-token`, mai i file di ~/.claude. */
export function detectClaudeLogin(env: NodeJS.ProcessEnv | Record<string, string | undefined>): ApiAuth {
  return env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ? { ok: true, source: 'login personale di Claude Code (token di setup-token)' } : { ok: false };
}

export const NO_LOGIN_TOKEN_MESSAGE =
  'login personale abilitato ma manca CLAUDE_CODE_OAUTH_TOKEN: esegui una volta "claude setup-token" (serve un abbonamento Claude), ' +
  'poi nel terminale dell\'orchestratore $env:CLAUDE_CODE_OAUTH_TOKEN = "<token>" e riavvia. ' +
  'Keystone non legge ~/.claude: gli agenti non vedono impostazioni, hook, server MCP, skill o comandi personali.';

export const NO_API_AUTH_MESSAGE =
  'nessuna credenziale API per Claude: imposta ANTHROPIC_API_KEY (da console.anthropic.com) oppure un provider cloud ' +
  '(CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX / CLAUDE_CODE_USE_FOUNDRY con le sue credenziali), poi riavvia l\'orchestratore. ' +
  'Il login personale di Claude Code è disattivato di default (--use-claude-login, solo per uso personale). Il motore sim funziona senza credenziali.';
