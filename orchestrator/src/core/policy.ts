// Policy dei permessi: decide se un agente può usare un tool.
//
//   allow -> si procede senza chiedere
//   ask   -> diventa una decisione "permesso" per l'utente
//   deny  -> rifiutato sempre
//
// PRINCIPIO: tutto ciò che non è esplicitamente consentito chiede.
//
// Consentito senza chiedere (worker, dentro il proprio worktree):
//   letture (Read/Grep/Glob, cat, ls, grep, ...), modifiche ai file (Edit/Write, mkdir, cp, mv,
//   redirezioni), git locale (status, diff, log, add, commit, merge, ...), comandi di sviluppo
//   (npm test, npm run build/lint/..., npx <tool installato>, node <file>, tsc, vitest, pytest,
//   cargo test, go test, ...).
//   Il lead lavora nel checkout dell'utente in sola lettura: solo letture e git in lettura.
//
// Chiede SEMPRE, senza possibilità di "consenti sempre" (vale solo la singola esecuzione):
//   modifiche alla configurazione git (git config <scrittura>, git remote add/set-url, ...),
//   variabili d'ambiente (X=1 cmd, export, set, setx, env, $env:X, unset, ...), hook git e
//   tutto ciò che tocca un percorso .git, `git -c ...` e le altre opzioni globali che cambiano
//   la configurazione o il repository (--git-dir, --work-tree, --exec-path, --config-env).
//
// Chiede SEMPRE anche il codice che arriva dalla rete o dai pacchetti (packageFetch): installazioni
//   e aggiornamenti di dipendenze (npm/pnpm/yarn/bun install|ci|add, pip install, uv, pipx,
//   poetry, cargo install, go get, gem, composer, brew, apt, winget, ...) ed esecuzione di pacchetti
//   scaricati al volo (pnpm/yarn dlx, uvx, bunx, go run pkg@versione, npx di un tool non
//   installato). npx/npm exec/pnpm exec di un tool già installato nel progetto chiede, con
//   "consenti sempre" limitato a quel tool.
//
// Chiede, con "consenti sempre" limitato all'ambito mostrato:
//   percorsi fuori dal worktree (.., assoluti, ~, link simbolici che portano fuori, cd fuori),
//   rete (curl, git fetch, URL, ...), comandi distruttivi (rm, git reset --hard,
//   git clean, find -delete, ...), programmi sconosciuti, codice inline, comandi di sistema.
//
// NON è una sandbox: gli script del repository che un comando consentito esegue (npm test, i suoi
// pre/post script, un Makefile, i test stessi) non passano dalla policy. Vedi docs/sicurezza.md.
//
// Negato sempre: git push in ogni forma visibile (anche dentro bash -c, $(...), alias via -c),
// firma con le chiavi dell'utente, modifiche ai file da parte del lead, sub-agenti.
// Se un push sfugge alla policy (script, hook), lo blocca git stesso: core/gitsafety.ts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isInsideOrEqual } from '../util/fsx.js';
import { GIT_SAFETY_VARS } from './gitsafety.js';
import { parseShell, programName, type SimpleCommand, type Word } from './shell.js';

export type Verdict =
  | { action: 'allow'; reason: string }
  /** ruleKeys: tutte le chiavi necessarie; sticky=false: "consenti sempre" non è possibile */
  | { action: 'ask'; reason: string; ruleKeys: string[]; sticky: boolean }
  | { action: 'deny'; reason: string };

export interface PolicyContext {
  role: 'lead' | 'worker';
  /** worktree (worker) o checkout dell'utente in sola lettura (lead) */
  cwd: string;
  /** cartelle leggibili oltre a cwd (es. la memoria condivisa) */
  readDirs?: string[];
  /** chiavi "consenti sempre" già approvate per questo agente */
  alwaysAllow?: readonly string[];
  /**
   * Percorsi che nessun agente può modificare (negato, non chiesto): il file del guardiano git,
   * il .git/config del repository (che lo include), il collegamento .git del worktree e i dati dei
   * worktree in .git/worktrees.
   */
  protectedPaths?: string[];
}

type Finding = { kind: 'deny'; reason: string } | { kind: 'ask'; reason: string; key: string; sticky: boolean };

const deny = (reason: string): Finding => ({ kind: 'deny', reason });
const ask = (reason: string, key: string, sticky = true): Finding => ({ kind: 'ask', reason, key, sticky });

function hash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export function exactKey(tool: string, text: string): string {
  return `${tool}:exact:${hash(text)}`;
}

// ---- percorsi -------------------------------------------------------------------------------

/** Percorso reale (risolve i link simbolici) della parte esistente di `p`. */
function realish(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** `target` è dentro `root`, sia come percorso scritto sia seguendo i link simbolici? */
export function insideRoot(root: string, target: string): boolean {
  return isInsideOrEqual(root, target) && isInsideOrEqual(realish(root), realish(target));
}

function hasGitSegment(p: string): boolean {
  return p.replace(/\\/g, '/').split('/').some((seg) => seg.toLowerCase() === '.git');
}

const NULL_DEVICES = new Set(['/dev/null', 'nul', '$null', '/dev/stdout', '/dev/stderr']);

interface Scope {
  role: 'lead' | 'worker';
  /** il worktree (o il checkout del lead) */
  root: string;
  readRoots: string[];
  /** cartella corrente virtuale (segue i `cd`); undefined = non nota */
  cwd: string | undefined;
  protectedPaths: string[];
}

/** `abs` è (o è dentro) un percorso protetto? Confronto anche sui percorsi reali (link). */
function isProtected(protectedPaths: readonly string[], abs: string): boolean {
  return protectedPaths.some((p) => insideRoot(p, abs) || isInsideOrEqual(p, abs));
}

function protectedDenial(prog: string, target: string): Finding {
  return deny(`${prog}: ${target} è un percorso protetto di Keystone (guardiano git, configurazione del repository o collegamento del worktree): gli agenti non possono modificarlo`);
}

function checkPath(scope: Scope, word: Word, mode: 'r' | 'w', prog: string): Finding | undefined {
  if (NULL_DEVICES.has(word.text.toLowerCase())) return undefined;
  if (word.dynamic) return ask(`${prog}: percorso non verificabile "${word.text}"`, `Bash:path:${prog}:${hash(word.text)}`, true);
  if (!scope.cwd) return ask(`${prog}: cartella corrente non nota (cd con variabile)`, `Bash:path:${prog}:${hash(word.text)}`, true);
  const abs = path.resolve(scope.cwd, word.text);
  if (mode === 'w' && isProtected(scope.protectedPaths, abs)) return protectedDenial(prog, word.text);
  if (hasGitSegment(path.relative(scope.root, abs)) || hasGitSegment(word.text)) {
    if (mode === 'w') return ask(`${prog} scrive in un percorso .git (configurazione, hook o collegamento del worktree): ${word.text}`, exactKey('Bash', `${prog} .git ${word.text}`), false);
  }
  if (mode === 'r') {
    if (scope.readRoots.some((r) => insideRoot(r, abs))) return undefined;
    return ask(`${prog} legge fuori dalla cartella di lavoro: ${word.text}`, `Bash:outside:${prog}:r:${path.dirname(abs)}`);
  }
  if (scope.role === 'lead') return ask(`${prog}: il lead lavora in sola lettura (scriverebbe ${word.text})`, exactKey('Bash', `${prog} w ${abs}`));
  if (insideRoot(scope.root, abs)) return undefined;
  return ask(`${prog} scrive fuori dal worktree: ${word.text}`, `Bash:outside:${prog}:w:${path.dirname(abs)}`);
}

function looksLikePath(t: string): boolean {
  return /[\\/]/.test(t) || t.startsWith('.') || t.startsWith('~') || /^[A-Za-z]:/.test(t);
}

// ---- programmi ------------------------------------------------------------------------------

const READERS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'tree', 'file', 'stat', 'du', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'less', 'more', 'nl', 'od', 'xxd', 'hexdump', 'md5sum', 'sha1sum', 'sha256sum', 'realpath', 'readlink', 'basename', 'dirname', 'jq', 'column', 'strings',
  'get-content', 'gc', 'get-childitem', 'gci', 'test-path', 'get-item', 'gi', 'resolve-path', 'get-filehash', 'measure-object',
]);
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'findstr', 'select-string', 'sls', 'ag', 'ack']);
const NO_PATHS = new Set(['echo', 'printf', 'true', 'false', 'pwd', 'date', 'whoami', 'hostname', 'uname', 'which', 'where', 'get-command', 'write-output', 'write-host', 'get-location', 'gl', 'sleep', 'start-sleep', 'clear', 'cls', 'exit', 'test', '[', 'seq', 'yes', 'expr']);
const WRITERS = new Set(['mkdir', 'md', 'touch', 'cp', 'copy', 'mv', 'move', 'ren', 'rename', 'tee', 'chmod', 'ln', 'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'copy-item', 'cpi', 'move-item', 'mi', 'rename-item', 'rni', 'mklink']);
const DESTRUCTIVE = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'unlink', 'shred', 'truncate', 'dd', 'mkfs', 'format', 'remove-item', 'ri', 'clear-content', 'wipe']);
const NETWORK = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'start-bitstransfer', 'gh', 'glab', 'hub', 'aws', 'az', 'gcloud', 'kubectl', 'docker', 'podman', 'ping', 'nslookup', 'dig', 'certutil', 'bitsadmin']);
const SYSTEM = new Set(['sudo', 'su', 'doas', 'runas', 'taskkill', 'kill', 'pkill', 'killall', 'stop-process', 'reg', 'regedit', 'sc.exe', 'schtasks', 'systemctl', 'service', 'crontab', 'chown', 'chgrp', 'icacls', 'takeown', 'shutdown', 'reboot', 'start-process', 'saps', 'start', 'open', 'xdg-open', 'explorer', 'osascript', 'launchctl', 'net', 'netsh', 'wmic', 'diskpart', 'bcdedit', 'cipher', 'vssadmin']);
const ENV_PROGRAMS = new Set(['export', 'set', 'setx', 'unset', 'setenv', 'unsetenv', 'set-item', 'si', 'set-variable', 'sv', 'remove-variable', 'declare', 'typeset', 'local', 'readonly', 'source', '.']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh']);
const WRAPPERS = new Set(['timeout', 'nice', 'nohup', 'time', 'command', 'exec', 'builtin', 'stdbuf', 'ionice']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'py', 'ruby', 'perl', 'php', 'deno', 'bun', 'tsx', 'ts-node']);
const DEV_TOOLS = new Set(['tsc', 'vitest', 'jest', 'mocha', 'eslint', 'prettier', 'biome', 'pytest', 'ruff', 'black', 'mypy', 'flake8', 'cargo', 'go', 'dotnet', 'mvn', 'gradle', 'gradlew']);

/** Programmi che il lead (sola lettura) può usare; il resto chiede. */
const LEAD_PROGRAMS = new Set([...READERS, ...PATTERN_FIRST, ...NO_PATHS, ...WRAPPERS, ...SHELLS, 'git', 'find', 'sed', 'cd', 'pushd', 'popd', 'chdir', 'set-location', 'sl', 'env', 'printenv', 'set', 'export', 'unset', 'setx', 'eval', 'xargs']);

/** Script npm che si eseguono senza chiedere (sono comandi di sviluppo del repository). */
const SAFE_SCRIPTS = new Set(['test', 'build', 'lint', 'typecheck', 'check', 'format', 'fmt', 'compile', 'tsc', 'vitest', 'coverage', 'test:unit', 'test:watch']);

/** Sottocomandi che installano, aggiornano o scaricano pacchetti, per gestore. */
const PKG_FETCH: Record<string, string[]> = {
  npm: ['install', 'i', 'in', 'ins', 'inst', 'isntall', 'ci', 'clean-install', 'install-test', 'it', 'install-ci-test', 'cit', 'add', 'update', 'up', 'upgrade', 'udpate', 'create', 'init', 'rebuild', 'rb', 'dedupe', 'ddp'],
  pnpm: ['install', 'i', 'add', 'update', 'up', 'upgrade', 'dlx', 'create', 'rebuild', 'rb', 'import', 'install-test', 'it', 'fetch', 'dedupe'],
  yarn: ['', 'install', 'add', 'up', 'upgrade', 'upgrade-interactive', 'dlx', 'create', 'global', 'import', 'set'],
  bun: ['install', 'i', 'add', 'a', 'update', 'upgrade', 'create', 'c', 'x', 'link', 'pm'],
  pip: ['install', 'download', 'wheel'],
  pip3: ['install', 'download', 'wheel'],
  pipx: ['install', 'run', 'inject', 'upgrade', 'upgrade-all', 'reinstall', 'reinstall-all'],
  uv: ['add', 'sync', 'run', 'tool', 'pip', 'lock', 'python', 'init', 'self'],
  poetry: ['install', 'add', 'update', 'lock', 'sync', 'self'],
  pdm: ['install', 'add', 'update', 'sync', 'lock'],
  conda: ['install', 'create', 'update', 'upgrade', 'env'],
  mamba: ['install', 'create', 'update', 'upgrade', 'env'],
  gem: ['install', 'update', 'fetch'],
  bundle: ['install', 'update', 'add', 'exec'],
  bundler: ['install', 'update', 'add', 'exec'],
  composer: ['install', 'require', 'update', 'create-project', 'global', 'upgrade'],
  brew: ['install', 'upgrade', 'reinstall', 'tap', 'update'],
  apt: ['install', 'upgrade', 'update', 'full-upgrade', 'source'],
  'apt-get': ['install', 'upgrade', 'update', 'dist-upgrade', 'source'],
  dnf: ['install', 'upgrade', 'update'],
  yum: ['install', 'upgrade', 'update'],
  apk: ['add', 'upgrade', 'update'],
  pacman: ['-s', '-sy', '-syu', '-u'],
  winget: ['install', 'upgrade', 'import'],
  choco: ['install', 'upgrade'],
  scoop: ['install', 'update'],
  cargo: ['install', 'binstall', 'add', 'fetch', 'update'],
  go: ['get', 'install', 'mod'],
  deno: ['install', 'add', 'cache'],
  dotnet: ['add', 'restore', 'tool', 'new', 'nuget'],
};
/** Programmi che eseguono un pacchetto scaricato al volo, sempre. */
const PKG_RUNNERS_REMOTE = new Set(['uvx', 'bunx']);

/**
 * Codice dalla rete o dai pacchetti: installazioni, aggiornamenti, esecuzioni al volo. Chiede
 * sempre (senza "consenti sempre"), tranne l'esecuzione di un tool già installato nel progetto
 * (npx/npm exec/pnpm exec/yarn exec), che chiede con "consenti sempre" per quel tool.
 */
function packageFetch(scope: Scope, prog: string, a: string[], raw: string): Finding | undefined {
  const sub = (a.find((x) => !x.startsWith('-')) ?? '').toLowerCase();
  const flag = (a.find((x) => x.startsWith('-')) ?? '').toLowerCase();
  if (PKG_RUNNERS_REMOTE.has(prog)) return ask(`${prog}: esegue un pacchetto scaricato dalla rete`, exactKey('Bash', raw), false);
  // esecuzione di un pacchetto: npx / pnpx / npm exec|x / pnpm exec / yarn exec
  const runner = prog === 'npx' || prog === 'pnpx' ? { tool: sub, args: a.slice(a.findIndex((x) => !x.startsWith('-')) + 1) } : (prog === 'npm' && (sub === 'exec' || sub === 'x')) || ((prog === 'pnpm' || prog === 'yarn') && sub === 'exec') ? { tool: (a.slice(a.indexOf(sub) + 1).find((x) => !x.startsWith('-')) ?? '').toLowerCase(), args: [] } : undefined;
  if (runner) {
    if (!runner.tool) return ask(`${prog} senza comando`, exactKey('Bash', raw), false);
    const bin = path.join(scope.cwd ?? scope.root, 'node_modules', '.bin', runner.tool);
    const remote = !(prog === 'pnpm' || prog === 'yarn') && (a.includes('-y') || a.includes('--yes') || a.some((x) => x.startsWith('--package') || x === '-p') || runner.tool.includes('@'));
    const installed = [bin, `${bin}.cmd`].some((x) => fs.existsSync(x));
    if (remote || !installed) return ask(`${prog} ${runner.tool}: il pacchetto non è installato nel progetto e verrebbe scaricato ed eseguito`, exactKey('Bash', raw), false);
    return ask(`${prog} ${runner.tool}: esegue il codice di un pacchetto installato nel progetto`, `Bash:pkg-exec:${runner.tool}`, true);
  }
  if (prog === 'go' && sub === 'run' && a.some((x) => /@[\w.-]+$/.test(x))) return ask('go run pacchetto@versione: scarica ed esegue codice', exactKey('Bash', raw), false);
  if (prog === 'deno' && sub === 'run' && a.some((x) => /^(https?:|npm:|jsr:)/i.test(x))) return ask('deno run di codice remoto', exactKey('Bash', raw), false);
  if ((prog === 'python' || prog === 'python3' || prog === 'py') && a[0] === '-m' && ['pip', 'pipx', 'uv', 'ensurepip', 'venv'].includes(a[1] ?? '')) {
    const inner = (a.slice(2).find((x) => !x.startsWith('-')) ?? '').toLowerCase();
    if (a[1] === 'ensurepip' || a[1] === 'venv' || (PKG_FETCH[a[1] === 'pip' ? 'pip' : a[1]!] ?? []).includes(inner)) return ask(`python -m ${a[1]} ${inner}: installa pacchetti`, exactKey('Bash', raw), false);
    return undefined;
  }
  const subs = PKG_FETCH[prog];
  if (!subs) return undefined;
  const key = prog === 'pacman' ? flag : sub;
  if (prog === 'yarn' && sub === '' && a.length > 0) return undefined; // yarn --version e simili
  if (subs.includes(key) || (prog === 'npm' && sub === 'audit' && a.includes('fix'))) {
    return ask(`${prog} ${key || '(install)'}: installa, aggiorna o scarica pacchetti, che possono eseguire codice`, exactKey('Bash', raw), false);
  }
  return undefined;
}

function urlFinding(prog: string, words: Word[]): Finding | undefined {
  for (const w of words) {
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/\s:@]+@)?([^/\s:]+)/i.exec(w.text) ?? /^[\w.-]+@([\w.-]+):/.exec(w.text);
    if (m) {
      const host = (m[3] ?? m[1] ?? '').toLowerCase();
      if (m[1]?.toLowerCase() === 'file') continue;
      return ask(`${prog} usa la rete (${host})`, `Bash:net:${prog}:${host}`);
    }
  }
  return undefined;
}

// ---- git ------------------------------------------------------------------------------------

const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'blame', 'annotate', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'describe', 'shortlog', 'grep', 'cat-file', 'merge-base', 'diff-tree', 'diff-index', 'diff-files', 'show-ref', 'for-each-ref', 'name-rev', 'whatchanged', 'count-objects', 'check-ignore', 'check-attr', 'version', 'var', 'show-branch', 'range-diff', 'cherry']);
const GIT_LOCAL_WRITE = new Set(['add', 'commit', 'mv', 'merge', 'cherry-pick', 'revert', 'apply', 'am', 'format-patch', 'notes-show', 'restore', 'reset', 'switch', 'checkout', 'stash', 'branch', 'tag', 'rebase', 'rm', 'clean', 'reflog', 'worktree', 'gc', 'prune', 'repack', 'update-ref', 'symbolic-ref', 'replace', 'filter-branch', 'filter-repo', 'notes', 'bisect', 'submodule', 'remote', 'fetch', 'pull', 'clone', 'ls-remote', 'config', 'hook', 'difftool', 'mergetool', 'citool', 'gui', 'gitk', 'help', 'archive', 'bundle', 'init', 'maintenance', 'sparse-checkout', 'lfs', 'subtree']);
const SIGN_SUBS = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'pull']);
/** Opzioni con valore (il valore non è un percorso da controllare). */
const GIT_VALUE_OPTS = new Set(['-m', '--message', '--author', '--date', '--format', '--pretty', '--grep', '-n', '--max-count', '--since', '--until', '--abbrev', '-U', '--unified', '--encoding', '-G', '--diff-filter', '--depth', '--strategy', '-s', '-X', '--strategy-option', '--onto', '--color']);

function classifyGit(scope: Scope, words: Word[], raw: string): Finding[] {
  const out: Finding[] = [];
  let i = 1;
  // opzioni globali prima del sottocomando
  while (i < words.length && words[i]!.text.startsWith('-')) {
    const opt = words[i]!.text;
    if (opt === '-c' || opt.startsWith('--config-env')) {
      const val = opt === '-c' ? (words[i + 1]?.text ?? '') : opt;
      if (/\bpush\b|send-pack/i.test(val)) out.push(deny(`git -c ${val}: un alias o una configurazione che fa push non è consentito`));
      if (/^include(if)?\b/i.test(val)) out.push(deny(`git -c ${val}: gli include della configurazione git (il guardiano) non si toccano`));
      out.push(ask(`git ${opt} ${val}: cambia la configurazione git per questo comando`, exactKey('Bash', raw), false));
      i += opt === '-c' ? 2 : 1;
      continue;
    }
    if (opt === '-C') {
      const dir = words[i + 1];
      if (dir) {
        const f = checkPath(scope, dir, 'r', 'git -C');
        if (f) out.push(f);
        else if (scope.cwd && dir.text) scope = { ...scope, cwd: path.resolve(scope.cwd, dir.text) };
      }
      i += 2;
      continue;
    }
    if (/^--(git-dir|work-tree|namespace|exec-path|super-prefix|index-file)/.test(opt)) {
      out.push(ask(`git ${opt}: punta git verso un altro repository o eseguibile`, exactKey('Bash', raw), false));
      i += opt.includes('=') ? 1 : 2;
      continue;
    }
    i++; // --no-pager, -P, --literal-pathspecs, ...
  }
  const subWord = words[i];
  if (!subWord) return out;
  if (subWord.dynamic) return [...out, ask('git con un sottocomando non verificabile', exactKey('Bash', raw), false)];
  const sub = subWord.text.toLowerCase();
  const args = words.slice(i + 1);
  const a = args.map((w) => w.text);
  const has = (...flags: string[]) => a.some((x) => flags.includes(x) || flags.some((f) => f.startsWith('--') && x.startsWith(`${f}=`)));

  if (sub === 'push' || sub === 'send-pack' || sub === 'http-push' || ((sub === 'lfs' || sub === 'subtree') && a[0] === 'push')) {
    return [deny('git push non è mai consentito agli agenti: il merge lo approva l\'utente e nulla viene pubblicato')];
  }
  if (SIGN_SUBS.has(sub) && (has('-S', '--gpg-sign') || a.some((x) => /^-S./.test(x) || x.startsWith('--gpg-sign=')))) {
    return [deny('gli agenti non firmano i commit con le chiavi dell\'utente')];
  }
  if (sub === 'tag' && has('-s', '--sign', '-u', '--local-user')) return [deny('gli agenti non firmano i tag con le chiavi dell\'utente')];

  // percorsi passati a git: quelli che sembrano percorsi vengono controllati
  const pathArgs = (mode: 'r' | 'w') => {
    for (let k = 0; k < args.length; k++) {
      const w = args[k]!;
      if (GIT_VALUE_OPTS.has(w.text)) {
        k++;
        continue;
      }
      if (w.text.startsWith('-')) {
        const eq = w.text.indexOf('=');
        if (eq > 0 && looksLikePath(w.text.slice(eq + 1)) && /^--(output|file|git-dir|work-tree)/.test(w.text)) {
          const f = checkPath(scope, { ...w, text: w.text.slice(eq + 1) }, 'w', `git ${sub}`);
          if (f) out.push(f);
        }
        continue;
      }
      if (w.dynamic || looksLikePath(w.text)) {
        const f = checkPath(scope, w, mode, `git ${sub}`);
        if (f) out.push(f);
      }
    }
  };

  if (GIT_READ.has(sub)) {
    if (has('--output', '--ext-diff', '--textconv') && sub !== 'status') out.push(ask(`git ${sub} con --output/--ext-diff può scrivere o eseguire programmi`, exactKey('Bash', raw)));
    pathArgs('r');
    return out;
  }
  if (sub === 'config') {
    // il guardiano: nessuna chiave include/includeIf e nessun file protetto, nemmeno con conferma
    if (a.some((x) => /^include(if)?\b/i.test(x))) return [deny('git config: gli include della configurazione git (il guardiano di Keystone) non si possono modificare')];
    const fileIdx = a.findIndex((x) => x === '--file' || x === '-f' || x.startsWith('--file='));
    if (fileIdx >= 0) {
      const f = a[fileIdx]!.startsWith('--file=') ? a[fileIdx]!.slice(7) : (a[fileIdx + 1] ?? '');
      if (f && scope.cwd && isProtected(scope.protectedPaths, path.resolve(scope.cwd, f))) return [protectedDenial('git config --file', f)];
    }
    const reads = ['--get', '--get-all', '--get-regexp', '--list', '-l', '--get-urlmatch', 'get', 'list', '--show-origin', '--show-scope', '--name-only', '--null', '-z', '--type', '--bool', '--int', '--path', '--global', '--local', '--system', '--worktree'];
    const nonOpts = a.filter((x) => !x.startsWith('-'));
    const readOnly = a.every((x) => !x.startsWith('-') || reads.some((r) => x === r || x.startsWith(`${r}=`))) && (has('--get', '--get-all', '--get-regexp', '--list', '-l', '--get-urlmatch') || nonOpts[0] === 'get' || nonOpts[0] === 'list' || nonOpts.length === 1);
    if (readOnly) return out;
    return [...out, ask('git config modifica la configurazione git', exactKey('Bash', raw), false)];
  }
  if (sub === 'hook' || (sub === 'remote' && a[0] && !['-v', '--verbose', 'show', 'get-url'].includes(a[0])) || sub === 'worktree' && a[0] !== 'list') {
    return [...out, ask(`git ${sub} ${a[0] ?? ''}: cambia hook, remote o worktree del repository condiviso`, exactKey('Bash', raw), false)];
  }
  if (['fetch', 'pull', 'clone', 'ls-remote'].includes(sub) || (sub === 'submodule' && ['update', 'add', 'sync'].includes(a[0] ?? '')) || (sub === 'remote' && a[0] === 'update') || (sub === 'lfs' && ['fetch', 'pull'].includes(a[0] ?? ''))) {
    return [...out, ask(`git ${sub}: accesso alla rete`, `Bash:net:git ${sub}`)];
  }
  if (scope.role === 'lead') return [...out, ask(`git ${sub}: il lead lavora in sola lettura nel checkout dell'utente`, exactKey('Bash', raw))];

  // worker
  if (['gc', 'prune', 'repack', 'update-ref', 'symbolic-ref', 'replace', 'filter-branch', 'filter-repo', 'notes', 'maintenance', 'sparse-checkout', 'init', 'submodule', 'citool', 'gui', 'gitk', 'help', 'difftool', 'mergetool', 'bundle', 'lfs', 'subtree'].includes(sub)) {
    return [...out, ask(`git ${sub}: tocca il repository condiviso o apre programmi esterni`, exactKey('Bash', raw), false)];
  }
  if (sub === 'bisect' && a[0] === 'run') return [...out, ask('git bisect run esegue comandi', exactKey('Bash', raw), false)];
  if (sub === 'rebase') {
    if (has('-x', '--exec')) return [...out, ask('git rebase --exec esegue comandi', exactKey('Bash', raw), false)];
    if (has('--update-refs', '--root')) return [...out, ask(`git rebase ${a.join(' ')}: sposta altri branch`, exactKey('Bash', raw), false)];
    out.push(ask('git rebase riscrive la storia del branch', 'Bash:git rebase'));
    return out;
  }
  if (sub === 'reset' && has('--hard')) out.push(ask('git reset --hard scarta le modifiche', 'Bash:destructive:git reset --hard'));
  if (sub === 'clean') out.push(ask('git clean cancella file non tracciati', 'Bash:destructive:git clean'));
  if (sub === 'rm' && !has('--cached')) out.push(ask('git rm cancella file', 'Bash:destructive:git rm'));
  if (sub === 'restore' && !has('--staged', '-S') ) out.push(ask('git restore scarta le modifiche ai file', 'Bash:destructive:git restore'));
  if (sub === 'checkout' || sub === 'switch') {
    if (a.includes('--') || a.includes('.') || has('-f', '--force', '--discard-changes')) out.push(ask(`git ${sub} scarta modifiche`, `Bash:destructive:git ${sub}`));
    else if (has('-b', '-B', '-c', '-C', '--orphan', '--detach')) out.push(ask(`git ${sub}: crea branch o stacca HEAD nel repository condiviso`, exactKey('Bash', raw)));
    else if (a.some((x) => !x.startsWith('-'))) out.push(ask(`git ${sub} ${a.join(' ')}: cambia branch nel worktree`, `Bash:git ${sub}:${a.filter((x) => !x.startsWith('-')).join(' ')}`));
  }
  if (sub === 'branch') {
    const listing = a.every((x) => ['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--list', '-l', '--show-current', '--contains', '--merged', '--no-merged', '--sort', '--format', '--color', '--no-color'].some((f) => x === f || x.startsWith(`${f}=`)) || (!x.startsWith('-') && has('--list', '-l', '--contains', '--merged', '--no-merged')));
    if (!listing) out.push(ask(`git branch ${a.join(' ')}: modifica i branch del repository condiviso`, exactKey('Bash', raw), has('-D', '-d', '--delete', '-f', '--force', '-m', '-M', '--move') ? false : true));
  }
  if (sub === 'tag' && a.some((x) => !['-l', '--list', '-n', '--sort', '--contains', '--points-at'].includes(x) && !has('-l', '--list'))) out.push(ask(`git tag ${a.join(' ')}: crea o cancella tag nel repository condiviso`, exactKey('Bash', raw), false));
  if (sub === 'stash' && !['list', 'show'].includes(a[0] ?? '')) out.push(ask('git stash usa uno stash condiviso con il tuo checkout', `Bash:git stash${a[0] ? ` ${a[0]}` : ''}`, !['drop', 'clear'].includes(a[0] ?? '')));
  if (sub === 'reflog' && ['expire', 'delete'].includes(a[0] ?? '')) out.push(ask(`git reflog ${a[0]} cancella la storia dei riferimenti`, exactKey('Bash', raw), false));
  if (!GIT_LOCAL_WRITE.has(sub)) out.push(ask(`git ${sub}: sottocomando non riconosciuto`, exactKey('Bash', raw)));
  pathArgs('w');
  return out;
}

// ---- comandi --------------------------------------------------------------------------------

function inlineCode(prog: string, a: string[]): boolean {
  if (prog === 'node' || prog === 'deno' || prog === 'bun' || prog === 'tsx' || prog === 'ts-node') return a.some((x) => /^(-e|-p|--eval|--print|-r|--require|--import|--loader|--experimental-loader)$/.test(x) || /^--(eval|print|require|import)=/.test(x));
  if (prog.startsWith('python') || prog === 'py') return a.some((x) => x === '-c');
  if (prog === 'ruby' || prog === 'perl' || prog === 'php') return a.some((x) => x === '-e' || x === '-r' || x === '-E');
  return false;
}

function classifyCommand(scope: Scope, cmd: SimpleCommand, depth: number): Finding[] {
  const out: Finding[] = [];
  const raw = [...cmd.assignments, ...cmd.words.map((w) => w.text)].join(' ');

  if (cmd.assignments.length) {
    const touchesSafety = cmd.assignments.some((a) => GIT_SAFETY_VARS.some((v) => a.toUpperCase().startsWith(v)));
    out.push(ask(`imposta variabili d'ambiente${touchesSafety ? ' della sicurezza git' : ''}: ${cmd.assignments.join(' ')}`, exactKey('Bash', raw), false));
  }
  for (const r of cmd.redirects) {
    if (!r.target) continue;
    const mode = r.op.includes('<') && r.op !== '<>' ? 'r' : 'w';
    const f = checkPath(scope, r.target, mode, `redirezione ${r.op}`);
    if (f) out.push(f);
  }
  if (!cmd.words.length) return out;

  const first = cmd.words[0]!;
  if (first.dynamic) return [...out, ask(`programma non verificabile: ${first.text}`, exactKey('Bash', raw), false)];
  if (/^\$env:/i.test(first.text) || /^\[(system\.)?environment\]::/i.test(first.text)) return [...out, ask(`modifica variabili d'ambiente: ${raw}`, exactKey('Bash', raw), false)];
  const prog = programName(first.text);
  const words = cmd.words;
  const rest = words.slice(1);
  const a = rest.map((w) => w.text);

  // il programma stesso indicato con un percorso fuori dal worktree
  if (/[\\/]/.test(first.text) && !SHELLS.has(prog)) {
    const f = checkPath(scope, first, 'r', prog);
    if (f) out.push(ask(`esegue un programma fuori dalla cartella di lavoro: ${first.text}`, exactKey('Bash', raw)));
  }

  const recurse = (inner: string) => out.push(...classifyText(scope, inner, depth + 1));

  // il lead è in sola lettura nel checkout dell'utente: solo programmi che leggono
  if (scope.role === 'lead' && !LEAD_PROGRAMS.has(prog)) {
    return [...out, ask(`${prog}: il lead lavora in sola lettura nel checkout dell'utente`, exactKey('Bash', raw))];
  }

  if (WRAPPERS.has(prog)) {
    let k = 0;
    while (k < rest.length && (rest[k]!.text.startsWith('-') || /^\d+[smhd]?$/.test(rest[k]!.text))) k++;
    if (k < rest.length) out.push(...classifyCommand(scope, { ...cmd, assignments: [], words: rest.slice(k), redirects: [] }, depth + 1));
    return out;
  }
  if (prog === 'env' || prog === 'printenv') {
    const assigns = rest.filter((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text));
    const flags = rest.filter((w) => w.text.startsWith('-'));
    const cmdStart = rest.findIndex((w) => !w.text.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text));
    if (assigns.length || flags.length) out.push(ask(`env modifica le variabili d'ambiente: ${raw}`, exactKey('Bash', raw), false));
    if (cmdStart >= 0) out.push(...classifyCommand(scope, { ...cmd, assignments: [], words: rest.slice(cmdStart), redirects: [] }, depth + 1));
    else out.push(ask(`${prog} mostra tutte le variabili d'ambiente (possono contenere segreti)`, `Bash:${prog}`));
    return out;
  }
  if (ENV_PROGRAMS.has(prog)) {
    if (prog === 'set' && (rest.length === 0 || /^-[eux]+$|^-o$|^\+[eux]+$/.test(a[0] ?? ''))) {
      if (rest.length === 0) out.push(ask('set mostra le variabili (possono contenere segreti)', 'Bash:set'));
      return out; // set -e / set -o pipefail: opzioni della shell
    }
    if ((prog === 'source' || prog === '.') && rest[0]) {
      out.push(ask(`${prog} esegue uno script nella shell corrente`, exactKey('Bash', raw), false));
      return out;
    }
    return [...out, ask(`modifica variabili d'ambiente: ${raw}`, exactKey('Bash', raw), false)];
  }
  if (prog === 'eval') {
    recurse(a.join(' '));
    out.push(ask('eval esegue testo come comando', exactKey('Bash', raw)));
    return out;
  }
  if (SHELLS.has(prog)) {
    const ci = a.findIndex((x) => /^(-c|-lc|-ic|\/c|\/k|-command|-c)$/i.test(x) || /^-(c|command)$/i.test(x));
    if (ci >= 0) {
      const inner = prog === 'cmd' ? a.slice(ci + 1).join(' ') : (a[ci + 1] ?? '');
      recurse(inner);
      return out;
    }
    if (a.some((x) => /^-(encodedcommand|e|ec)$/i.test(x))) return [...out, ask(`${prog} con comando codificato`, exactKey('Bash', raw), false)];
    if (cmd.stdinScript || rest.length === 0) return [...out, ask(`${prog} esegue uno script ricevuto in input`, exactKey('Bash', raw), false)];
    const script = rest.find((w) => !w.text.startsWith('-'));
    if (script) {
      const f = checkPath(scope, script, 'r', prog);
      if (f) out.push(f);
    }
    return [...out, ask(`${prog} esegue lo script ${script?.text ?? ''}`, exactKey('Bash', raw))];
  }
  if (prog === 'git') {
    out.push(...classifyGit(scope, words, raw));
    return out;
  }
  if (prog === 'cd' || prog === 'pushd' || prog === 'chdir' || prog === 'set-location' || prog === 'sl') {
    const target = rest.find((w) => !w.text.startsWith('-'));
    if (!target) {
      scope.cwd = undefined; // cd senza argomenti: home
      return out;
    }
    if (target.dynamic) {
      scope.cwd = undefined;
      return out;
    }
    scope.cwd = path.resolve(scope.cwd ?? scope.root, target.text);
    return out;
  }
  if (prog === 'popd') {
    scope.cwd = undefined;
    return out;
  }

  const net = urlFinding(prog, rest);
  if (NETWORK.has(prog)) return [...out, ask(`${prog}: accesso alla rete`, net?.kind === 'ask' ? net.key : `Bash:net:${prog}`)];
  if (net) out.push(net);
  if (SYSTEM.has(prog)) return [...out, ask(`${prog}: comando di sistema o di gestione dei processi`, exactKey('Bash', raw), prog === 'setx' ? false : true)];
  const pkg = packageFetch(scope, prog, a, raw);
  if (pkg) return [...out, pkg];

  const paths = (mode: 'r' | 'w', from = 0) => {
    for (let k = from; k < rest.length; k++) {
      const w = rest[k]!;
      if (w.text.startsWith('-') && !w.dynamic) {
        const eq = w.text.indexOf('=');
        if (eq > 0 && looksLikePath(w.text.slice(eq + 1))) {
          const f = checkPath(scope, { ...w, text: w.text.slice(eq + 1) }, mode, prog);
          if (f) out.push(f);
        }
        continue;
      }
      const f = checkPath(scope, w, mode, prog);
      if (f) out.push(f);
    }
  };

  if (NO_PATHS.has(prog)) return out;
  if (READERS.has(prog)) {
    paths('r');
    return out;
  }
  if (PATTERN_FIRST.has(prog)) {
    const usesE = a.some((x) => x === '-e' || x === '-f' || x === '--regexp' || x === '-Pattern' || x === '-pattern');
    let skipped = usesE;
    for (let k = 0; k < rest.length; k++) {
      const w = rest[k]!;
      if (w.text.startsWith('-')) {
        if (['-e', '-f', '--regexp', '--file', '-pattern', '-path', '-literalpath', '-g', '--glob', '-t', '--type', '-m', '-A', '-B', '-C'].includes(w.text.toLowerCase())) {
          if (w.text === '-f' || w.text === '--file' || /^-(literal)?path$/i.test(w.text)) {
            const next = rest[k + 1];
            if (next) {
              const f = checkPath(scope, next, 'r', prog);
              if (f) out.push(f);
            }
          }
          k++;
        }
        continue;
      }
      if (!skipped) {
        skipped = true; // il pattern
        continue;
      }
      const f = checkPath(scope, w, 'r', prog);
      if (f) out.push(f);
    }
    return out;
  }
  if (prog === 'sed') {
    const inPlace = a.some((x) => /^-i/.test(x) || x === '--in-place');
    const hasE = a.includes('-e') || a.includes('-f');
    let skipped = hasE;
    for (let k = 0; k < rest.length; k++) {
      const w = rest[k]!;
      if (w.text.startsWith('-')) {
        if (w.text === '-e' || w.text === '-f') k++;
        continue;
      }
      if (!skipped) {
        skipped = true;
        if (/(^|;)\s*[0-9,$]*\s*[wWe]\b|\/[wWe]\s/.test(w.text)) out.push(ask('sed con w/e scrive file o esegue comandi', exactKey('Bash', raw)));
        continue;
      }
      const f = checkPath(scope, w, inPlace ? 'w' : 'r', 'sed');
      if (f) out.push(f);
    }
    return out;
  }
  if (prog === 'find') {
    let k = 0;
    while (k < rest.length && !/^[-(!]/.test(rest[k]!.text)) {
      const f = checkPath(scope, rest[k]!, 'r', 'find');
      if (f) out.push(f);
      k++;
    }
    if (k === 0) {
      /* find senza punto di partenza: la cartella corrente */
    }
    if (a.some((x) => x === '-delete')) out.push(ask('find -delete cancella file', 'Bash:destructive:find -delete'));
    if (a.some((x) => ['-exec', '-execdir', '-ok', '-okdir'].includes(x))) {
      const ei = a.findIndex((x) => ['-exec', '-execdir', '-ok', '-okdir'].includes(x));
      const end = a.findIndex((x, j) => j > ei && (x === ';' || x === '+' || x === '\\;'));
      const innerWords = rest.slice(ei + 1, end < 0 ? undefined : end).filter((w) => w.text !== '{}');
      if (innerWords.length) out.push(...classifyCommand(scope, { assignments: [], words: innerWords, redirects: [], stdinScript: false }, depth + 1));
      out.push(ask('find -exec esegue un comando su file non noti in anticipo', exactKey('Bash', raw)));
    }
    if (a.some((x) => /^-f(print|ls|printf)/.test(x))) out.push(ask('find -fprint scrive file', exactKey('Bash', raw)));
    return out;
  }
  if (prog === 'xargs') {
    const ci = rest.findIndex((w, j) => !w.text.startsWith('-') && !(j > 0 && /^-[IdnLPs]$/.test(rest[j - 1]!.text)));
    if (ci >= 0) out.push(...classifyCommand(scope, { assignments: [], words: rest.slice(ci), redirects: [], stdinScript: false }, depth + 1));
    out.push(ask('xargs esegue un comando su argomenti non noti in anticipo', exactKey('Bash', raw)));
    return out;
  }
  if (WRITERS.has(prog)) {
    if (scope.role === 'lead') return [...out, ask(`${prog}: il lead lavora in sola lettura`, exactKey('Bash', raw))];
    if (prog === 'ln' || prog === 'mklink') {
      // un link può portare fuori: anche il bersaglio deve essere dentro il worktree
      paths('w');
      return out;
    }
    if (prog === 'cp' || prog === 'copy' || prog === 'copy-item' || prog === 'cpi') {
      const nonOpts = rest.filter((w) => !w.text.startsWith('-'));
      nonOpts.slice(0, -1).forEach((w) => {
        const f = checkPath(scope, w, 'r', prog);
        if (f) out.push(f);
      });
      const dest = nonOpts.at(-1);
      if (dest) {
        const f = checkPath(scope, dest, 'w', prog);
        if (f) out.push(f);
      }
      return out;
    }
    paths('w');
    return out;
  }
  if (DESTRUCTIVE.has(prog)) {
    out.push(ask(`${prog}: comando distruttivo`, `Bash:destructive:${prog}`));
    paths('w');
    return out;
  }
  if (INTERPRETERS.has(prog)) {
    if (inlineCode(prog, a)) return [...out, ask(`${prog} esegue codice scritto nel comando`, exactKey('Bash', raw))];
    const script = rest.find((w) => !w.text.startsWith('-'));
    if ((prog.startsWith('python') || prog === 'py') && a[0] === '-m') {
      const mod = a[1] ?? '';
      if (['pytest', 'unittest', 'mypy', 'ruff', 'black', 'flake8', 'compileall', 'doctest'].includes(mod)) return out;
      if (['pip', 'venv', 'http.server', 'ensurepip'].includes(mod)) return [...out, ask(`python -m ${mod}: rete o ambiente di sistema`, `Bash:net:python -m ${mod}`)];
      return [...out, ask(`python -m ${mod}`, `Bash:python -m ${mod}`)];
    }
    if (!script) return [...out, ask(`${prog} interattivo o con input da stdin`, exactKey('Bash', raw))];
    const f = checkPath(scope, script, 'r', prog);
    if (f) out.push(ask(`${prog} esegue uno script fuori dalla cartella di lavoro: ${script.text}`, exactKey('Bash', raw)));
    if (cmd.stdinScript) out.push(ask(`${prog} riceve codice su stdin`, exactKey('Bash', raw)));
    return out;
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(prog)) {
    const sub = a.find((x) => !x.startsWith('-')) ?? '';
    const scriptName = sub === 'run' || sub === 'run-script' ? (a[a.indexOf(sub) + 1] ?? '') : sub;
    if (['test', 't', 'tst'].includes(sub) || ((sub === 'run' || sub === 'run-script') && SAFE_SCRIPTS.has(scriptName))) return out;
    if (prog !== 'npm' && SAFE_SCRIPTS.has(sub)) return out; // pnpm test, yarn build
    if (['install', 'i', 'ci', 'add', 'update', 'up', 'upgrade', 'publish', 'view', 'info', 'show', 'outdated', 'audit', 'login', 'adduser', 'whoami', 'search', 'pack', 'exec', 'dlx', 'create', 'init', 'remove', 'uninstall', 'rm', 'link', 'unlink', 'dedupe', 'prune', 'rebuild'].includes(sub)) {
      return [...out, ask(`${prog} ${sub}: rete o modifica delle dipendenze`, `Bash:net:${prog} ${sub}`)];
    }
    if (sub === 'run' || sub === 'run-script') return [...out, ask(`${prog} run ${scriptName}: esegue uno script del repository`, `Bash:${prog} run:${scriptName}`)];
    if (sub === 'ls' || sub === 'list' || sub === 'config' && a[1] === 'get' || sub === 'help' || sub === 'version' || sub === '--version') return out;
    return [...out, ask(`${prog} ${sub}`, exactKey('Bash', raw))];
  }
  if (prog === 'npx' || prog === 'pnpx') {
    const tool = a.find((x) => !x.startsWith('-'));
    if (!tool) return [...out, ask('npx senza comando', exactKey('Bash', raw))];
    const bin = path.join(scope.cwd ?? scope.root, 'node_modules', '.bin', tool);
    const installed = [bin, `${bin}.cmd`].some((p) => fs.existsSync(p)) && !a.includes('-y') && !a.includes('--yes') && !a.some((x) => x.startsWith('--package') || x === '-p');
    if (!installed) return [...out, ask(`npx ${tool}: il tool non è installato nel progetto, verrebbe scaricato`, `Bash:net:npx:${tool}`)];
    const toolIdx = rest.findIndex((w) => w.text === tool);
    for (const w of rest.slice(toolIdx + 1)) {
      if (!w.text.startsWith('-') && (w.dynamic || looksLikePath(w.text))) {
        const f = checkPath(scope, w, 'w', `npx ${tool}`);
        if (f) out.push(f);
      }
    }
    return out;
  }
  if (DEV_TOOLS.has(prog)) {
    const sub = a.find((x) => !x.startsWith('-')) ?? '';
    if (prog === 'cargo' && ['install', 'publish', 'login', 'fetch', 'update', 'search', 'add', 'yank', 'owner'].includes(sub)) return [...out, ask(`cargo ${sub}: rete`, `Bash:net:cargo ${sub}`)];
    if (prog === 'go' && ['get', 'install', 'mod'].includes(sub)) return [...out, ask(`go ${sub}: rete`, `Bash:net:go ${sub}`)];
    if (prog === 'go' && sub === 'run') return out;
    if (prog === 'dotnet' && ['add', 'restore', 'tool', 'nuget', 'new'].includes(sub)) return [...out, ask(`dotnet ${sub}: rete`, `Bash:net:dotnet ${sub}`)];
    if ((prog === 'mvn' || prog === 'gradle' || prog === 'gradlew') && /deploy|publish|release/.test(a.join(' '))) return [...out, ask(`${prog}: pubblicazione`, `Bash:net:${prog}`)];
    for (const raw of rest) {
      // go: "./..." e "pkg/..." sono schemi di pacchetti ("tutti i sottopacchetti"), non percorsi:
      // si controlla la cartella che coprono ("./..." -> ".", "./internal/..." -> "./internal")
      const w = prog === 'go' && !raw.dynamic && /(^|[\\/])\.\.\.$/.test(raw.text) ? { ...raw, text: raw.text.replace(/[\\/]?\.\.\.$/, '') || '.' } : raw;
      if (!w.text.startsWith('-') && (w.dynamic || /[\\/]/.test(w.text) || w.text.startsWith('..') || /^[A-Za-z]:/.test(w.text))) {
        const f = checkPath(scope, w, 'w', prog);
        if (f) out.push(f);
      }
    }
    if (scope.role === 'lead' && !['tsc', 'mypy', 'ruff', 'flake8'].includes(prog)) out.push(ask(`${prog}: il lead lavora in sola lettura`, exactKey('Bash', raw)));
    return out;
  }
  if (prog === 'make') return [...out, ask('make esegue comandi definiti nel Makefile', `Bash:make:${a.join(' ')}`)];
  if (prog === 'awk' || prog === 'gawk') return [...out, ask('awk può scrivere file ed eseguire comandi', exactKey('Bash', raw))];
  // tutto il resto: chiede
  return [...out, ask(`programma non riconosciuto dalla policy: ${prog}`, exactKey('Bash', raw))];
}

function classifyText(scope: Scope, text: string, depth: number): Finding[] {
  if (depth > 6) return [ask('comando annidato troppo in profondità', exactKey('Bash', text), false)];
  const parsed = parseShell(text);
  const out: Finding[] = [];
  if (parsed.error) out.push(ask(`comando non analizzabile (${parsed.error})`, exactKey('Bash', text), false));
  for (const sub of parsed.substitutions) {
    out.push(...classifyText({ ...scope }, sub, depth + 1));
    out.push(ask('il comando usa l\'output di un altro comando: il risultato non è verificabile in anticipo', exactKey('Bash', text)));
  }
  for (const c of parsed.commands) out.push(...classifyCommand(scope, c, depth));
  return out;
}

/** Classifica un comando di shell (Bash o PowerShell). */
export function classifyShell(command: string, ctx: PolicyContext): Finding[] {
  const scope: Scope = { role: ctx.role, root: path.resolve(ctx.cwd), readRoots: [ctx.cwd, ...(ctx.readDirs ?? [])], cwd: path.resolve(ctx.cwd), protectedPaths: ctx.protectedPaths ?? [] };
  if (!command.trim()) return [ask('comando vuoto', exactKey('Bash', command))];
  return classifyText(scope, command, 0);
}

// ---- punto di ingresso ----------------------------------------------------------------------

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
/** I tool del team (core/tools.ts): sempre consentiti, sono codice di Keystone. */
const TEAM_TOOLS = new Set(['send_message', 'ask_user', 'write_memory', 'read_memory', 'update_task', 'report_status', 'list_tasks', 'create_task', 'request_merge']);
const LEAD_ONLY_TOOLS = new Set(['create_task', 'request_merge']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function pathOf(input: Record<string, unknown>): string | undefined {
  for (const k of ['file_path', 'path', 'notebook_path']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function combine(findings: Finding[], alwaysAllow: readonly string[]): Verdict {
  const denied = findings.find((f) => f.kind === 'deny');
  if (denied) return { action: 'deny', reason: denied.reason };
  const asks = findings.filter((f): f is Extract<Finding, { kind: 'ask' }> => f.kind === 'ask');
  if (!asks.length) return { action: 'allow', reason: 'consentito dalla policy' };
  const keys = [...new Set(asks.map((f) => f.key))];
  const sticky = asks.every((f) => f.sticky);
  if (sticky && keys.every((k) => alwaysAllow.includes(k))) return { action: 'allow', reason: `consentito sempre (${keys.join(', ')})` };
  const reasons = [...new Set(asks.map((f) => f.reason))];
  return { action: 'ask', reason: reasons.join('; '), ruleKeys: keys, sticky };
}

export function classify(tool: string, input: Record<string, unknown>, ctx: PolicyContext): Verdict {
  const always = ctx.alwaysAllow ?? [];
  const root = path.resolve(ctx.cwd);
  if (tool === 'Task' || tool === 'Agent') return { action: 'deny', reason: 'gli agenti non avviano sub-agenti' };
  if (tool === 'TodoWrite') return { action: 'allow', reason: 'lista di cose da fare dell\'agente' };
  // i tool del team sono codice di Keystone (server MCP in-process "keystone"); ogni altro MCP è negato
  if (tool.startsWith('mcp__')) {
    const m = /^mcp__keystone__([a-z_]+)$/.exec(tool);
    if (m && TEAM_TOOLS.has(m[1]!) && (ctx.role === 'lead' || !LEAD_ONLY_TOOLS.has(m[1]!))) return { action: 'allow', reason: 'tool del team di Keystone' };
    return { action: 'deny', reason: `server MCP non ammesso: ${tool} (gli agenti hanno solo i tool del team di Keystone)` };
  }
  if (TEAM_TOOLS.has(tool)) return { action: 'allow', reason: 'tool del team di Keystone' };
  if (READ_TOOLS.has(tool)) {
    const p = pathOf(input) ?? (typeof input.pattern === 'string' && tool === 'Glob' ? String(input.pattern) : '.');
    const abs = path.resolve(root, p.replace(/[*?[{].*$/, '') || '.');
    if ([ctx.cwd, ...(ctx.readDirs ?? [])].some((r) => insideRoot(r, abs))) return { action: 'allow', reason: 'lettura dentro la cartella di lavoro' };
    return combine([ask(`lettura fuori dalla cartella di lavoro: ${p}`, `Read:${path.dirname(abs)}`)], always);
  }
  if (WRITE_TOOLS.has(tool)) {
    if (ctx.role === 'lead') return { action: 'deny', reason: 'il lead non modifica file: lavora in sola lettura nel checkout dell\'utente' };
    const p = pathOf(input);
    if (!p) return combine([ask(`${tool} senza percorso`, exactKey(tool, JSON.stringify(input)), false)], always);
    const abs = path.resolve(root, p);
    if (isProtected(ctx.protectedPaths ?? [], abs)) return { action: 'deny', reason: (protectedDenial(tool, p) as { reason: string }).reason };
    if (hasGitSegment(path.relative(root, abs))) return combine([ask(`${tool} su un percorso .git (configurazione, hook o collegamento del worktree): ${p}`, exactKey(tool, abs), false)], always);
    if (insideRoot(root, abs)) return { action: 'allow', reason: 'modifica dentro il worktree' };
    return combine([ask(`scrittura fuori dal worktree: ${p}`, `Write:${path.dirname(abs)}`)], always);
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = typeof input.command === 'string' ? input.command : '';
    return combine(classifyShell(command, ctx), always);
  }
  if (tool === 'WebFetch' || tool === 'WebSearch') {
    let host = 'web';
    try {
      host = new URL(String(input.url ?? '')).hostname || 'web';
    } catch {
      /* nessun URL */
    }
    return combine([ask(`${tool}: accesso alla rete (${host})`, `${tool}:${host}`)], always);
  }
  return combine([ask(`tool non riconosciuto dalla policy: ${tool}`, exactKey(tool, JSON.stringify(input)))], always);
}

/** Descrizione breve di una chiamata, per il testo della richiesta di permesso. */
export function describeCall(tool: string, input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return `${tool}: ${input.command}`;
  const p = pathOf(input);
  if (p) return `${tool} ${p}`;
  return `${tool} ${JSON.stringify(input).slice(0, 160)}`;
}

/** Spiega cosa copre una chiave "consenti sempre". */
export function describeRuleKey(key: string): string {
  const [tool, kind, ...rest] = key.split(':');
  const tail = rest.join(':');
  if (kind === 'exact') return 'solo questo comando, esattamente com\'è scritto';
  if (kind === 'outside') {
    const [prog, mode, ...dir] = rest;
    return `${prog} che ${mode === 'r' ? 'legge' : 'scrive'} nella cartella ${dir.join(':')}`;
  }
  if (kind === 'net') return `accesso alla rete con ${tail}`;
  if (kind === 'destructive') return `${tail} dentro il worktree`;
  if (kind === 'path') return `${tail ? rest[0] : ''} con quel percorso non verificabile`;
  if (tool === 'Read') return `lettura nella cartella ${[kind, ...rest].join(':')}`;
  if (tool === 'Write') return `scrittura nella cartella ${[kind, ...rest].join(':')}`;
  return key;
}

