// Blocco del push (e della firma con le chiavi dell'utente) a livello di git, non solo filtrando
// i comandi. Due livelli indipendenti, più la policy che vede i comandi:
//
// 1. AMBIENTE dei processi degli agenti (e di ogni processo figlio: script, test, hook):
//      GIT_ALLOW_PROTOCOL=keystone-none     nessun trasporto ammesso. Ha la precedenza su qualunque
//                                           configurazione, anche su `git -c protocol.allow=...`
//      GIT_CONFIG_COUNT/KEY_n/VALUE_n       configurazione con precedenza su .git/config e globale:
//                                           protocol.allow=never, ogni URL di push riscritto verso un
//                                           indirizzo inesistente, nessun credential helper, ssh
//                                           disattivato, nessuna firma
//      niente prompt di credenziali, niente agent SSH, niente token nell'ambiente
//
// 2. GUARDIANO nel repository (sopravvive a un ambiente svuotato con `env -i` o sovrascritto):
//      nel .git/config dell'utente un `includeIf "gitdir/i:<.git>/worktrees/ks-*"` che include un file
//      di Keystone con le stesse regole. Vale SOLO nei worktree degli agenti (cartelle "ks-..."):
//      il checkout dell'utente e i suoi push non cambiano. Se il file di Keystone sparisce, git
//      ignora l'include: il repository dell'utente non si rompe.
//
// Per aggirare il blocco servono insieme la manomissione dell'ambiente E della configurazione;
// la policy chiede approvazione per entrambe quando le vede (`git -c`, variabili d'ambiente,
// .git/config). Non è una sandbox del sistema operativo.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../util/fsx.js';
import { git, gitOut } from '../util/git.js';

export const PUSH_BLOCK_URL = 'keystone-push-blocked:///';
export const NO_PROGRAM = 'keystone-disabled-program';
/** Prefisso delle cartelle dei worktree degli agenti (il guardiano si aggancia a questo nome). */
export const WORKTREE_PREFIX = 'ks-';

/** Le regole, valide sia come configurazione d'ambiente sia nel file incluso. */
export const GUARD_RULES: ReadonlyArray<readonly [string, string]> = [
  // livello "trasporto": nessun protocollo, ogni URL di push verso un indirizzo inesistente
  ['protocol.allow', 'never'],
  [`url.${PUSH_BLOCK_URL}.pushInsteadOf`, ''],
  // livello "credenziali": nessun helper (il valore vuoto azzera quelli configurati prima),
  // nessun programma per chiedere password, ssh che fallisce sempre
  ['credential.helper', ''],
  ['credential.interactive', 'never'],
  ['core.askPass', NO_PROGRAM],
  ['core.sshCommand', NO_PROGRAM],
  ['commit.gpgSign', 'false'],
  ['tag.gpgSign', 'false'],
  ['gpg.program', NO_PROGRAM],
  ['gpg.ssh.program', NO_PROGRAM],
  ['gpg.x509.program', NO_PROGRAM],
];

/** Variabili che rimandano git a un altro repository: tolte dall'ambiente degli agenti. */
export const GIT_REDIRECT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CONFIG'];

/** Credenziali e canali di autenticazione che un agente non deve ereditare. */
export const CREDENTIAL_VARS = [
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'SSH_ASKPASS',
  'SSH_ASKPASS_REQUIRE',
  'GIT_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_CONFIG_PARAMETERS',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GITLAB_TOKEN',
  'GITLAB_PRIVATE_TOKEN',
  'BITBUCKET_TOKEN',
  'AZURE_DEVOPS_EXT_PAT',
  'SYSTEM_ACCESSTOKEN',
  'GCM_CREDENTIAL_STORE',
  'GCM_PROVIDER',
  'GIT_HTTP_EXTRA_HEADER',
];

/** Variabili il cui nome indica un'agent SSH o un token di accesso a un servizio git. */
export function isCredentialVar(name: string): boolean {
  const n = name.toUpperCase();
  return CREDENTIAL_VARS.includes(n) || /(^|_)(GH|GITHUB|GITLAB|GITEA|BITBUCKET|GIT)(_[A-Z0-9]+)*_(TOKEN|PAT)$/.test(n) || n.startsWith('SSH_AUTH') || n.startsWith('GCM_');
}

/** Variabili della sicurezza git: la policy chiede approvazione per ogni comando che le tocca. */
export const GIT_SAFETY_VARS = ['GIT_ALLOW_PROTOCOL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CEILING_DIRECTORIES', 'GIT_PROTOCOL_FROM_USER', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH', ...GIT_REDIRECT_VARS];

/**
 * L'ambiente di un processo agente: `base` (di solito process.env) senza redirezioni git e
 * credenziali, più le regole di sicurezza e `extra` (es. l'identità git dell'agente).
 */
export function gitSafeEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}, opts: { ceiling?: string } = {}): Record<string, string | undefined> {
  const drop = new Set([...GIT_REDIRECT_VARS, ...CREDENTIAL_VARS, 'GIT_CONFIG_COUNT']);
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) {
    const K = k.toUpperCase();
    if (drop.has(K) || isCredentialVar(K) || K.startsWith('GIT_CONFIG_KEY_') || K.startsWith('GIT_CONFIG_VALUE_')) continue;
    env[k] = v;
  }
  env.GIT_ALLOW_PROTOCOL = 'keystone-none';
  env.GIT_CONFIG_COUNT = String(GUARD_RULES.length);
  GUARD_RULES.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  if (opts.ceiling) {
    const sep = process.platform === 'win32' ? ';' : ':';
    env.GIT_CEILING_DIRECTORIES = [opts.ceiling, base.GIT_CEILING_DIRECTORIES].filter(Boolean).join(sep);
  }
  return { ...env, ...extra };
}

// ---- guardiano nel repository ------------------------------------------------------------

function guardFileContent(): string {
  const bySection = new Map<string, string[]>();
  for (const [key, value] of GUARD_RULES) {
    // "url.<x>.pushInsteadOf" -> [url "<x>"] pushInsteadOf ; "gpg.ssh.program" -> [gpg "ssh"] program
    const first = key.indexOf('.');
    const last = key.lastIndexOf('.');
    const section = first === last ? key.slice(0, first) : `${key.slice(0, first)} "${key.slice(first + 1, last)}"`;
    const name = key.slice(last + 1);
    const lines = bySection.get(section) ?? [];
    lines.push(`\t${name} = ${value === '' ? '""' : value}`);
    bySection.set(section, lines);
  }
  const body = [...bySection].map(([s, lines]) => `[${s}]\n${lines.join('\n')}`).join('\n');
  return `# Generato da Keystone: regole per i worktree degli agenti (non modificare).\n# Il push e la firma sono disattivati; il checkout dell'utente non è interessato.\n${body}\n`;
}

/** Scrive (o aggiorna) il file di regole incluso dai repository. */
export function writeGuardFile(file: string): void {
  const content = guardFileContent();
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
  writeFileAtomic(file, content);
}

function slash(p: string): string {
  return p.replace(/\\/g, '/');
}

/** La chiave includeIf per i worktree degli agenti di un repository. */
export async function guardKey(repoPath: string): Promise<string> {
  const common = path.resolve(repoPath, await gitOut(repoPath, ['rev-parse', '--git-common-dir']));
  // senza barra finale: "x/" diventerebbe "x/**" e non corrisponderebbe alla cartella stessa
  return `includeIf.gitdir/i:${slash(common)}/worktrees/${WORKTREE_PREFIX}*.path`;
}

export interface GuardPreview {
  /** il file che verrebbe modificato: il .git/config del repository */
  configFile: string;
  /** le righe che verrebbero aggiunte in fondo al file */
  lines: string[];
  /** il file di regole di Keystone che la riga include */
  guardFile: string;
  /** il guardiano è già installato (nessuna modifica necessaria) */
  installed: boolean;
}

/** Cosa farebbe installGuard(), senza farlo: da mostrare all'utente prima di chiedere conferma. */
export async function previewGuard(repoPath: string, guardFile: string): Promise<GuardPreview> {
  const common = path.resolve(repoPath, await gitOut(repoPath, ['rev-parse', '--git-common-dir']));
  const key = await guardKey(repoPath);
  const sub = key.slice('includeIf.'.length, -'.path'.length);
  return {
    configFile: path.join(common, 'config'),
    lines: [`[includeIf "${sub}"]`, `\tpath = ${slash(guardFile)}`],
    guardFile: slash(guardFile),
    installed: await guardInstalled(repoPath, guardFile),
  };
}

export async function guardInstalled(repoPath: string, guardFile: string): Promise<boolean> {
  const key = await guardKey(repoPath);
  const current = (await git(repoPath, ['config', '--local', '--get-all', key], { allowFail: true })).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return current.includes(slash(guardFile));
}

/**
 * Installa il guardiano nel .git/config del repository (idempotente). Va chiamato solo dopo che
 * l'utente ha visto l'anteprima e confermato. La riga viene aggiunta in fondo al file, così le
 * sue regole (credential.helper vuoto, ...) vengono dopo quelle già presenti.
 */
export async function installGuard(repoPath: string, guardFile: string): Promise<void> {
  writeGuardFile(guardFile);
  if (await guardInstalled(repoPath, guardFile)) return;
  await git(repoPath, ['config', '--local', '--add', await guardKey(repoPath), slash(guardFile)]);
}

/** Rimuove il guardiano dal .git/config del repository (la riga e la sezione che la contiene). */
export async function removeGuard(repoPath: string): Promise<void> {
  const key = await guardKey(repoPath);
  await git(repoPath, ['config', '--local', '--unset-all', key], { allowFail: true });
  await git(repoPath, ['config', '--local', '--remove-section', key.slice(0, -'.path'.length)], { allowFail: true });
}

/** Il guardiano è attivo in questo worktree? (verificato prima di affidarlo a un agente) */
export async function guardActive(worktreePath: string): Promise<boolean> {
  // ambiente "nudo": deve valere anche senza le variabili di sicurezza
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) if (process.env[k] !== undefined) env[k] = process.env[k];
  const r = await git(worktreePath, ['config', '--get', 'protocol.allow'], { env, allowFail: true });
  return r.stdout.trim() === 'never';
}
