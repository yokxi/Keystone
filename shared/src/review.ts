// Riassunto della review: i rischi che Keystone rileva da solo (oltre ai problemi aperti dichiarati
// dal worker). Funzione pura, usata dall'interfaccia e nei test.
import { isConsoleProblem, onlyAfter } from './visual-diagnostics.js';
import type { DiffFile, Task } from './protocol.js';
import { REPO_SKILLS_DIR } from './skills.js';

export interface ReviewRisk {
  level: 'bad' | 'warn';
  text: string;
}

const DEPENDENCY_FILES = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|Gemfile(\.lock)?|composer\.(json|lock)|[^/]+\.csproj|packages\.config|pom\.xml|build\.gradle(\.kts)?)$/i;
const CI_FILES = /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.yml$|azure-pipelines\.yml$|\.circleci\/|Jenkinsfile$)/i;
const KEYSTONE_FILES = /(^|\/)\.keystone\//i;

const pathsOf = (files: readonly DiffFile[]) => files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])).map((p) => p.replace(/\\/g, '/'));

/** I rischi del lavoro di un task, dal più grave. */
export function reviewRisks(task: Task | undefined, files: readonly DiffFile[] | undefined): ReviewRisk[] {
  const out: ReviewRisk[] = [];
  const ps = files ? pathsOf(files) : [];
  const skills = ps.filter((p) => p.toLowerCase().startsWith(`${REPO_SKILLS_DIR}/`));
  if (skills.length) out.push({ level: 'bad', text: `Modifica le skill del repository (regole per gli agenti): ${[...new Set(skills)].join(', ')}. Dopo il merge le riceveranno tutti gli agenti.` });
  const otherKeystone = ps.filter((p) => KEYSTONE_FILES.test(p) && !skills.includes(p));
  if (otherKeystone.length) out.push({ level: 'warn', text: `Modifica file di Keystone nel repository: ${[...new Set(otherKeystone)].join(', ')}` });
  if (task) {
    if (task.ci === 'fail') out.push({ level: 'bad', text: 'I test eseguiti da Keystone sono falliti.' });
    else if (task.ci === 'unknown') out.push({ level: 'warn', text: 'Nessun test eseguito da Keystone (nessun comando di test riconosciuto).' });
    else if (task.ci === 'running') out.push({ level: 'warn', text: 'I test sono ancora in corso.' });
    const v = task.visual;
    if (v?.status === 'failed') out.push({ level: 'bad', text: `Verifica visuale non riuscita${v.note ? `: ${v.note}` : ''}.` });
    if (v?.status === 'done') {
      const failed = v.checks.filter((c) => c.after.error || c.after.shot?.error).length;
      if (failed) out.push({ level: 'bad', text: `Verifica visuale: ${failed} pagine con passaggi non riusciti dopo le modifiche.` });
      const fresh = v.checks.reduce((n, c) => {
        if (!c.after.diagnostics) return n;
        const f = onlyAfter(c.before.diagnostics, c.after.diagnostics);
        return n + f.errors.length + f.console.filter(isConsoleProblem).length + f.failedRequests.length;
      }, 0);
      if (fresh) out.push({ level: 'warn', text: `Verifica visuale: ${fresh} errori, avvisi o richieste fallite nuovi dopo le modifiche.` });
    }
  }
  const deps = ps.filter((p) => DEPENDENCY_FILES.test(p));
  if (deps.length) out.push({ level: 'warn', text: `Cambia le dipendenze: ${[...new Set(deps)].join(', ')}` });
  const ci = ps.filter((p) => CI_FILES.test(p));
  if (ci.length) out.push({ level: 'warn', text: `Cambia la configurazione della CI: ${[...new Set(ci)].join(', ')}` });
  const deleted = (files ?? []).filter((f) => f.status === 'deleted');
  if (deleted.length) out.push({ level: 'warn', text: `Cancella ${deleted.length} file: ${deleted.slice(0, 5).map((f) => f.path).join(', ')}${deleted.length > 5 ? '…' : ''}` });
  const binary = (files ?? []).filter((f) => f.binary);
  if (binary.length) out.push({ level: 'warn', text: `File binari (non mostrati nel diff): ${binary.slice(0, 5).map((f) => f.path).join(', ')}${binary.length > 5 ? '…' : ''}` });
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
}
