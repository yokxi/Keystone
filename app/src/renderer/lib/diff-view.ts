// Preparazione del diff per la schermata di review: le lunghe sequenze di righe di contesto
// vengono compresse (si tengono `keep` righe attorno alle modifiche). Funzione pura.
import type { DiffHunk, DiffLine } from '@keystone/shared';

export type ViewRow = { type: 'line'; line: DiffLine } | { type: 'fold'; count: number; id: string };

export function collapseContext(hunk: DiffHunk, keep = 3, hunkKey = ''): ViewRow[] {
  const lines = hunk.lines;
  const near = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === 'ctx') return;
    for (let k = Math.max(0, i - keep); k <= Math.min(lines.length - 1, i + keep); k++) near[k] = true;
  });
  const rows: ViewRow[] = [];
  let run = 0;
  const flush = (i: number) => {
    if (run > 0) rows.push({ type: 'fold', count: run, id: `${hunkKey}:${i}` });
    run = 0;
  };
  lines.forEach((l, i) => {
    if (l.kind !== 'ctx' || near[i]) {
      flush(i);
      rows.push({ type: 'line', line: l });
    } else run++;
  });
  flush(lines.length);
  // un solo "…1 riga" non risparmia spazio: meglio mostrarla
  return rows.flatMap((r, i) => {
    if (r.type === 'fold' && r.count <= 1) {
      const start = rows.slice(0, i).reduce((s, x) => s + (x.type === 'line' ? 1 : x.count), 0);
      return lines.slice(start, start + r.count).map((line) => ({ type: 'line' as const, line }));
    }
    return [r];
  });
}

/** Righe di un'entrata di log di tipo diff, con la classe per colorarle. */
export function diffLogLines(text: string): Array<{ cls: 'add' | 'del' | 'hunk' | 'meta' | 'ctx'; text: string }> {
  return text.split('\n').map((t) => {
    if (t.startsWith('+++') || t.startsWith('---')) return { cls: 'meta' as const, text: t };
    if (t.startsWith('@@')) return { cls: 'hunk' as const, text: t };
    if (t.startsWith('+')) return { cls: 'add' as const, text: t };
    if (t.startsWith('-')) return { cls: 'del' as const, text: t };
    return { cls: 'ctx' as const, text: t };
  });
}
