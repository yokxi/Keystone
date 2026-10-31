// Parser del diff unificato di git -> struttura per la schermata di review (file, hunk, righe
// con numeri di riga vecchi e nuovi).
import type { DiffFile, DiffHunk } from '@keystone/shared';

function unquote(p: string): string {
  // git mette tra virgolette i path con caratteri speciali
  if (p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1).replace(/\\(["\\])/g, '$1');
  return p;
}

function stripPrefix(p: string): string {
  const u = unquote(p);
  return u.startsWith('a/') || u.startsWith('b/') ? u.slice(2) : u;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (\S+|"[^"]*") (\S+|"[^"]*")$/.exec(line);
      const b = m ? stripPrefix(m[2]!) : line.slice(11);
      file = { path: b, status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed';
        file.oldPath = unquote(line.slice('rename from '.length));
      } else if (line.startsWith('rename to ')) file.path = unquote(line.slice('rename to '.length));
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true;
      else if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) file.path = stripPrefix(line.slice(4).trim());
    }
    const h = HUNK_RE.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[3]);
      hunk = { header: line, oldStart: oldNo, newStart: newNo, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
      file.additions++;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
      file.deletions++;
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
    // "\ No newline at end of file" e righe vuote finali: ignorate
  }
  // numeri di riga 0 (file vuoti) non sono validi nello schema: si tolgono
  for (const f of files)
    for (const hk of f.hunks)
      for (const l of hk.lines) {
        if (l.oldNo === 0) delete l.oldNo;
        if (l.newNo === 0) delete l.newNo;
      }
  return files;
}

/** Il diff in forma testuale compatta, per i prompt (review del lead). */
export function diffToText(files: DiffFile[], maxChars = 60_000): string {
  const out: string[] = [];
  for (const f of files) {
    out.push(`=== ${f.status} ${f.oldPath ? `${f.oldPath} -> ` : ''}${f.path} (+${f.additions} -${f.deletions})`);
    if (f.binary) out.push('(file binario)');
    for (const h of f.hunks) {
      out.push(h.header);
      for (const l of h.lines) out.push(`${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`);
    }
  }
  const s = out.join('\n');
  return s.length > maxChars ? `${s.slice(0, maxChars)}\n… (diff troncato)` : s;
}
