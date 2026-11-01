// Profili dell'orchestratore visti dall'app. Il pulsante "Avvia orchestratore" deve usare il
// profilo dell'app (KEYSTONE_PROFILE, default "default") oppure uno scelto esplicitamente tra
// quelli esistenti: mai un profilo implicito diverso da quello che l'app mostra.
// Niente Electron qui, così si può testare.
import fs from 'node:fs';
import path from 'node:path';

/** Stesse regole dei nomi accettati dall'orchestratore per --profile: niente percorsi. */
export function isValidProfileName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name);
}

/** I profili esistenti sotto la radice dello stato: cartelle con uno state.json. */
export function listProfiles(home: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && isValidProfileName(e.name) && fs.existsSync(path.join(home, e.name, 'state.json')))
    .map((e) => e.name)
    .sort();
}

/**
 * Il profilo con cui avviare l'orchestratore. Senza scelta: quello dell'app. Una scelta diversa è
 * ammessa solo se è un nome valido di un profilo esistente (o quello dell'app).
 */
export function resolveStartProfile(appProfile: string, requested: unknown, home: string): { ok: true; profile: string } | { ok: false; error: string } {
  if (requested === undefined || requested === null || requested === '') return { ok: true, profile: appProfile };
  if (!isValidProfileName(requested)) return { ok: false, error: 'nome di profilo non valido' };
  if (requested !== appProfile && !listProfiles(home).includes(requested)) return { ok: false, error: `il profilo "${requested}" non esiste` };
  return { ok: true, profile: requested };
}

/** Argomenti per avviare l'orchestratore dai sorgenti con il profilo indicato. */
export function orchestratorArgs(main: string, port: number, profile: string): string[] {
  return ['--import', 'tsx', main, '--port', String(port), '--profile', profile];
}
