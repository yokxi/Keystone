# Resoconto — Fase 7 (file di configurazione)

## Cosa è fatto

- `~/.keystone/config.json` (nella radice dello stato, vale per tutti i profili): motore, modello
  ed effort per ruolo e per singolo agente, numero di worker, tetto di spesa, limiti per obiettivo,
  porta, nome dell'utente, login personale, prezzi di Codex, branch conservati, pausa del motore sim.
- Precedenza: predefiniti < file < ambiente (`KEYSTONE_PORT`, `KEYSTONE_BUDGET_USD`) < riga di
  comando. Un'impostazione generale di uno strato più alto sostituisce anche quelle più specifiche
  degli strati sotto (`--engine` batte `leadEngine` e `agents.<id>.engine` del file); nello stesso
  strato vale la più specifica.
- Nuove opzioni: `--config <file>`, `--no-config`, `--show-config` (mostra cosa vale ed esce).
- La logica che era in `main.ts` è ora `applySettings` (`orchestrator/src/config-file.ts`), con i
  test; le opzioni da riga di comando passano dallo stesso schema del file.
- I motori Claude e Codex usano l'effort del singolo agente prima di quello del ruolo (prima
  l'effort per agente arrivava nel turno ma veniva ignorato).
- Documentazione: `docs/configurazione.md`, `docs/sicurezza.md` §6quater, README, `--help`.

## Scelte prese e perché

- **Schema rigido**: una chiave sconosciuta o un valore fuori dai limiti fermano l'avvio. Un errore
  di battitura non deve tornare in silenzio ai valori predefiniti (per esempio un tetto di spesa
  scritto male).
- **Solo da riga di comando** `--codex-path`, `--ci`, `--record` (e `--home`, `--profile`, `--reset`,
  `--repo`, `--confirm-guard`, …): decidono cosa viene eseguito, dove finiscono le trascrizioni o
  confermano modifiche al `.git/config`. Un file che resta sul disco non deve deciderlo.
- **Niente campi per segreti**: le chiavi restano a `safeStorage`; `apiKey` nel file è una chiave
  sconosciuta.
- **Il file è un percorso protetto** per gli agenti (quello predefinito anche se non esiste, e quello
  indicato con `--config`): le scritture sono negate, non chieste.
- **Login personale dal file segnalato** con un avviso a ogni avvio (suggerimento del revisore).
- **`--workers` fuori da 1-5 ora è un errore** invece di essere ridotto in silenzio: cambio di
  comportamento voluto, annotato in `docs/configurazione.md`.
- I messaggi d'errore delle opzioni riportano il valore come l'hai scritto (`porta non valida: abc`).

## Rischi e limiti

- Come per le skill personali, la policy non vede dentro gli script: uno script potrebbe modificare
  `config.json`. Il file si legge solo all'avvio e il log dice da dove viene e cosa imposta.
- Tra il controllo "file normale" e la lettura non c'è atomicità (rischio basso, file protetto).
- Per la Fase 8: se `config.json` non è valido l'orchestratore si ferma con l'errore; l'app dovrà
  mostrarlo.

## Test

- `orchestrator/test/config-file.test.ts`: lettura (assente, BOM, chiavi sconosciute, limiti, JSON
  rotto, segreti e impostazioni solo da riga di comando rifiutati, file troppo grande, cartella,
  link), precedenza (anche generale contro specifico), applicazione per agente, login e Codex,
  ambiente non valido, porta 0, percorso protetto, dal file al turno (modello ed effort), effort con
  Claude. `codex-engine.test.ts`: effort dell'agente con Codex (`max` → `xhigh`).
- Mutazione: togliendo i file di configurazione dai percorsi protetti fallisce il test di
  protezione.
- Risultati finali: typecheck pulito; `npm test` due volte: 36 file, 533 test passati entrambe le
  volte; `npm run test:ui`: 4 test passati.

## Parere del revisore

Nessun bloccante. Da correggere: la riga di comando non batteva `leadEngine` / `leadEffort` /
`agents.*` del file (regressione rispetto al vecchio `main.ts`), corretta con test; resoconto
mancante, scritto; `--workers` fuori dai limiti, annotato. Suggerimenti accolti: avviso sul login
personale dal file, nota sull'atomicità, riga sul modello per singolo agente, test per porta 0 e
`KEYSTONE_BUDGET_USD=0` con il login. Il test "`max` diventa `xhigh` con Codex" c'era già.
