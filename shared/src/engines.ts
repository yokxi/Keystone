// Stato di maturità dei motori, uguale per interfaccia, riga di comando e documentazione.
//
// L'etichetta "sperimentale" di un motore si toglie SOLO dopo una prova reale con un modello vero
// (vedi docs/piano.md, "Da fare prima della pubblicazione").
import type { EngineId } from './protocol.js';

export const ENGINE_LABELS: Record<EngineId, string> = { sim: 'Sim', claude: 'Claude', codex: 'Codex' };

/** Motori non ancora verificati con un modello reale: il testo da mostrare accanto al nome. */
export const ENGINE_EXPERIMENTAL: Partial<Record<EngineId, string>> = {
  codex: 'sperimentale · non ancora verificato con un modello reale',
};

/**
 * Motori non inclusi in questa versione: il codice c'è ed è testato, ma non si possono scegliere
 * finché non sono provati con un modello reale. Si riattivano togliendoli da qui (o, solo per
 * sviluppo e prove, con KEYSTONE_ENABLE_CODEX=1).
 */
export const ENGINE_DISABLED: Partial<Record<EngineId, string>> = {
  codex: 'il motore Codex non è incluso in questa versione: arriverà in un rilascio successivo, dopo la prova con un modello reale',
};
