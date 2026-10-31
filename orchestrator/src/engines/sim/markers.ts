// Marcatori che il SOLO motore sim interpreta (nel testo dell'obiettivo o nel titolo di un task),
// per esercitare i flussi senza API. Il resto dell'orchestratore non li conosce: con Claude o Codex
// sono testo qualunque (un test verifica che nessun file fuori da engines/sim li nomini).
export const SIM_MARKERS = {
  /** il worker chiede all'utente (ask_user) prima di scrivere */
  question: '[domanda]',
  /** il worker chiede un permesso che la policy non concede da sola (rete) */
  permission: '[permesso]',
  /** il worker si dichiara bloccato */
  block: '[blocca]',
  /** il worker non modifica nessun file */
  empty: '[vuoto]',
  /** il worker scrive un test che fallisce, e lo corregge quando i test tornano indietro */
  failingTest: '[test-rotto]',
  /** il worker scrive un test che fallisce e non riesce a correggerlo */
  alwaysFailingTest: '[test-sempre-rotto]',
} as const;

export function hasMarker(text: string | undefined, marker: (typeof SIM_MARKERS)[keyof typeof SIM_MARKERS]): boolean {
  return !!text && text.includes(marker);
}
