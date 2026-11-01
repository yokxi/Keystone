// Eliminazione dei branch degli agenti. UNICO punto in cui Keystone cancella un branch:
//  - solo nomi che iniziano con "Keystone/" (con questa esatta grafia): mai main, mai branch
//    dell'utente, nemmeno "keystone/..." o "feature/Keystone/...";
//  - mai un branch estratto in un checkout o in un worktree;
//  - con `git update-ref -d <ref> <sha>`: il branch viene eliminato solo se punta ancora al commit
//    atteso (quello unito, o quello mostrato all'utente quando ha confermato). Se nel frattempo è
//    cambiato, resta dov'è.
import { BRANCH_PREFIX } from './repos.js';
import { git } from '../util/git.js';

export interface KeystoneBranch {
  name: string;
  sha: string;
}

/** Il nome è un branch di un agente di Keystone: "Keystone/<qualcosa>", e git lo accetta. */
export function isKeystoneBranch(name: string): boolean {
  return name.startsWith(`${BRANCH_PREFIX}/`) && name.length > BRANCH_PREFIX.length + 1 && !name.includes('..') && !/[\s~^:?*[\\]/.test(name) && !name.endsWith('/') && !name.endsWith('.lock');
}

/** I branch Keystone/* del repository, con il commit a cui puntano. */
export async function listKeystoneBranches(repoPath: string): Promise<KeystoneBranch[]> {
  const out = await git(repoPath, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', `refs/heads/${BRANCH_PREFIX}/`], { allowFail: true });
  if (out.code !== 0) return [];
  return out.stdout
    .split('\n')
    .map((l) => l.trim().split('\t'))
    .filter((p): p is [string, string] => p.length === 2 && isKeystoneBranch(p[0]!))
    .map(([name, sha]) => ({ name, sha }));
}

/** I branch estratti da qualche parte (checkout principale e worktree). */
async function checkedOut(repoPath: string): Promise<Set<string>> {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain'], { allowFail: true });
  const set = new Set<string>();
  for (const line of out.stdout.split('\n')) {
    const m = /^branch refs\/heads\/(.+)$/.exec(line.trim());
    if (m) set.add(m[1]!);
  }
  return set;
}

export type DeleteOutcome = { ok: true } | { ok: false; reason: string };

/** Elimina un branch Keystone/* solo se punta ancora a `expectedSha` e non è estratto. */
export async function deleteKeystoneBranch(repoPath: string, branch: string, expectedSha: string): Promise<DeleteOutcome> {
  if (!isKeystoneBranch(branch)) return { ok: false, reason: `${branch} non è un branch di Keystone: non lo tocco` };
  // tutto zeri per git vuol dire "nessun controllo": rifiutato
  if (!/^[0-9a-f]{40,64}$/.test(expectedSha) || /^0+$/.test(expectedSha)) return { ok: false, reason: `commit atteso non valido per ${branch}` };
  if ((await checkedOut(repoPath)).has(branch)) return { ok: false, reason: `${branch} è estratto in un checkout o worktree` };
  const r = await git(repoPath, ['update-ref', '-d', `refs/heads/${branch}`, expectedSha], { allowFail: true });
  if (r.code !== 0) return { ok: false, reason: `${branch} è cambiato o non esiste più: conservato (${(r.stderr || r.stdout).trim().split('\n')[0]})` };
  return { ok: true };
}

/**
 * Elimina TUTTI i branch Keystone/* di un repository (dopo `git worktree prune`). Solo per il
 * repository di prova creato da Keystone, con --reset. Restituisce le righe del resoconto.
 */
export async function deleteAllKeystoneBranches(repoPath: string): Promise<string[]> {
  await git(repoPath, ['worktree', 'prune'], { allowFail: true });
  const report: string[] = [];
  for (const b of await listKeystoneBranches(repoPath)) {
    const r = await deleteKeystoneBranch(repoPath, b.name, b.sha);
    report.push(r.ok ? `branch ${b.name} eliminato` : `branch ${b.name} conservato: ${r.reason}`);
  }
  return report;
}
