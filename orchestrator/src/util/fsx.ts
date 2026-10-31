// Utility di file system: scritture atomiche (sopravvivono a crash a metà scrittura).
import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Scrive `data` in `file` in modo atomico: file temporaneo nella stessa cartella, fsync, rename.
 * Un crash lascia o il file vecchio o quello nuovo, mai uno troncato. Su Windows il rename può
 * fallire per un attimo (antivirus, indicizzazione): si ritenta qualche volta.
 */
export function writeFileAtomic(file: string, data: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* ignora */
        }
        throw e;
      }
      sleepSync(25 * (attempt + 1));
    }
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Legge un JSON; `undefined` se il file non esiste. Lancia se il contenuto non è JSON valido. */
export function readJson<T>(file: string): T | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return JSON.parse(raw) as T;
}

/** `child` è dentro `parent` (o coincide)? Confronto su path risolti, case-insensitive su Windows. */
export function isInsideOrEqual(parent: string, child: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function samePath(a: string, b: string): boolean {
  return isInsideOrEqual(a, b) && isInsideOrEqual(b, a);
}
