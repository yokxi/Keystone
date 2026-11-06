// Dove sta l'orchestratore e come si avvia (Fase 8). Niente Electron qui, così si può testare.
//
//  - app impacchettata: il bundle in <resources>/orchestrator/main.mjs, con accanto i node_modules
//    dei pacchetti con binari nativi (app/scripts/build-orchestrator.mjs). Gira con il Node di
//    Electron (ELECTRON_RUN_AS_NODE), senza sorgenti e senza tsx;
//  - sviluppo: i sorgenti (orchestrator/src/main.ts) con tsx, se ci sono.
import fs from 'node:fs';
import path from 'node:path';

export interface OrchestratorEntry {
  /** cartella di lavoro del processo */
  cwd: string;
  /** file da eseguire */
  main: string;
  /** true: il bundle dell'app impacchettata; false: i sorgenti con tsx */
  bundled: boolean;
}

/**
 * L'orchestratore da avviare. Con l'app impacchettata conta solo il bundle (mai i sorgenti, anche
 * se ci fossero accanto); in sviluppo i sorgenti, se ci sono anche tsx e il main.
 */
export function findOrchestrator(o: { packaged: boolean; resourcesPath: string; appDistDir: string }): OrchestratorEntry | undefined {
  if (o.packaged) {
    const dir = path.join(o.resourcesPath, 'orchestrator');
    const main = path.join(dir, 'main.mjs');
    return fs.existsSync(main) ? { cwd: dir, main, bundled: true } : undefined;
  }
  // app/dist/main -> radice del repository
  const root = path.resolve(o.appDistDir, '..', '..', '..');
  const main = path.join(root, 'orchestrator', 'src', 'main.ts');
  return fs.existsSync(main) && fs.existsSync(path.join(root, 'node_modules', 'tsx')) ? { cwd: root, main, bundled: false } : undefined;
}

/** Argomenti per avviare l'orchestratore con il profilo indicato, sulla porta a cui l'app è collegata. */
export function orchestratorArgs(entry: Pick<OrchestratorEntry, 'main' | 'bundled'>, port: number, profile: string): string[] {
  return [...(entry.bundled ? [] : ['--import', 'tsx']), entry.main, '--port', String(port), '--profile', profile];
}

/** Il file in cui finisce l'uscita dell'orchestratore avviato dall'app (in ~/.keystone, mai nel repository). */
export function startLogFile(home: string, profile: string): string {
  return path.join(home, profile, 'orchestrator-avvio.log');
}

/** Le ultime righe non vuote di un file (per spiegare un avvio fallito), senza codici di colore. */
export function tailLines(file: string, n = 8, maxBytes = 16_384): string {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return buf
        .toString('utf8')
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-9;]*m/g, '')
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .slice(-n)
        .join('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Oltre questa dimensione il log d'avvio ricomincia da capo (l'orchestratore ci scrive finché vive). */
export const START_LOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Apre il log d'avvio in aggiunta, con una riga d'intestazione. Se è diventato troppo grande lo
 * sposta in `.1` (la versione precedente) e ne inizia uno nuovo. Restituisce il descrittore.
 */
export function openStartLog(file: string, now: Date): number {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > START_LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    /* il log non c'è ancora */
  }
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, `\n--- avvio dall'app: ${now.toISOString()} ---\n`);
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  return fd;
}

/**
 * Aspetta che il processo appena avviato resti vivo per `ms`. L'orchestratore non esce da solo,
 * quindi qualsiasi uscita in quel tempo è un avvio fallito (anche con codice 0), e così un errore
 * del sistema nell'avviarlo (eseguibile mancante, bloccato dall'antivirus). Se resta vivo, undefined.
 */
export function earlyExit(
  child: { once(ev: 'exit', fn: (code: number | null) => void): unknown; once(ev: 'error', fn: (e: Error) => void): unknown; exitCode: number | null },
  ms: number,
): Promise<{ code?: number; error?: string } | undefined> {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode });
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { code?: number; error?: string } | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(r);
    };
    const t = setTimeout(() => finish(undefined), ms);
    child.once('exit', (code) => finish({ code: code ?? 1 }));
    child.once('error', (e) => finish({ error: e.message }));
  });
}
