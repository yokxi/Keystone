// Diagnostica della verifica visuale: cosa compare solo "dopo" (nel worktree dell'agente) e non
// "prima" (nel branch di partenza). Usata dall'interfaccia e dai testi per il lead.
import type { ConsoleEntry, FailedRequest, PageDiagnostics } from './protocol.js';

/** Senza la query (cache-busting dei dev server, es. ?t=123) e senza origine: stessa risorsa, stesso id. */
function resourceKey(url: string): string {
  try {
    const u = new URL(url);
    return u.host && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ? u.pathname : `${u.host}${u.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

export const consoleKey = (c: ConsoleEntry): string => `${c.type}:${c.text.trim()}`;
/** Un errore JavaScript: conta la prima riga (il messaggio), non lo stack con righe e colonne. */
export const errorKey = (e: string): string => (e.split('\n')[0] ?? e).trim();
export const requestKey = (r: FailedRequest): string => `${r.method ?? 'GET'} ${resourceKey(r.url)} ${r.blocked ? 'bloccata' : (r.status ?? r.failure ?? '')}`;

export interface OnlyAfter {
  console: ConsoleEntry[];
  errors: string[];
  failedRequests: FailedRequest[];
}

/**
 * Le voci di "dopo" che non compaiono "prima". Senza diagnostica "prima" (il lato non è stato
 * eseguito) non si può dire cosa è nuovo: il risultato è vuoto.
 */
export function onlyAfter(before: PageDiagnostics | undefined, after: PageDiagnostics | undefined): OnlyAfter {
  if (!before || !after) return { console: [], errors: [], failedRequests: [] };
  const bc = new Set(before.console.map(consoleKey));
  const be = new Set(before.errors.map(errorKey));
  const br = new Set(before.failedRequests.map(requestKey));
  return {
    console: after.console.filter((c) => !bc.has(consoleKey(c))),
    errors: after.errors.filter((e) => !be.has(errorKey(e))),
    failedRequests: after.failedRequests.filter((r) => !br.has(requestKey(r))),
  };
}

/** Messaggi di console che contano per la review (errori e avvisi). */
export const isConsoleProblem = (c: ConsoleEntry): boolean => c.type === 'error' || c.type === 'warning' || c.type === 'assert';
