# Resoconto: installatore e aggiornamenti (8 novembre 2026)

**Stato: codice fatto e testato, prova dell'installatore vero ancora da fare.** Il build
dell'installatore (compressione LZMA di circa 750 MB) è stato fermato dal sistema per memoria
insufficiente, prima di finire. Nessun tag: la parte si chiude dopo la prova manuale qui sotto.

## Cosa è fatto

- **Installatore NSIS** (`app/installer/keystone.nsi`, `app/scripts/installer.mjs`,
  `npm run installer -w app [-- --zip]`): per utente, senza amministratore; cartella `Keystone`
  vuota o con un'installazione precedente; menu Start, desktop facoltativo, "App installate";
  aggiornamento con il disinstallatore della versione precedente; rifiuto con Keystone in
  esecuzione; disinstallazione solo dei file dell'elenco generato, senza toccare `~/.keystone`.
- **`orchestrator.shutdown`** e il pulsante **Ferma orchestratore** in Impostazioni.
- **Controllo degli aggiornamenti** (`app/src/main/updates.ts`): banner e sezione in Impostazioni,
  solo `api.github.com`, nessuno scaricamento, interruttore e `KEYSTONE_NO_UPDATE_CHECK`.
- Documenti: README, `docs/pacchetto.md`, `docs/sicurezza.md`, `docs/protocol.md`,
  `docs/interfaccia.md`, `docs/piano.md`.

## Scelte e perché

- **NSIS direttamente, senza electron-builder**: electron-builder porta `minimatch` con l'avviso
  GHSA-g3hv-75wg-m249 e la correzione trascina `@isaacs/nonrecursive-glob-match`, un pacchetto
  creato il 26 ottobre 2026. Così nessuna dipendenza npm nuova e nessuna eccezione alla regola dei
  14 giorni. NSIS 3.13 (27 settembre 2026) è uno strumento esterno, verificato con l'MD5 di
  SourceForge, che non entra nell'app.
- **Rilevamento di Keystone in esecuzione** aprendo `Keystone.exe` in scrittura: un eseguibile in
  uso non si apre, e l'orchestratore gira come `Keystone.exe`. Niente PowerShell né plugin.
- **Aggiornamenti senza electron-updater**: niente dipendenza nuova e l'ultima parola resta
  all'utente. Il canale non è firmato (limite in `docs/sicurezza.md`).

## Test

- Typecheck pulito.
- Test toccati: 8 file, 117 test passati, tra cui `app/test/updates.test.ts` (8),
  `app/test/installer.test.ts` (3) e `orchestrator/test/server.test.ts` (8, con l'arresto).
- Nuovo test dell'interfaccia ("aggiornamenti spenti da ambiente; Ferma orchestratore chiede
  conferma"): passato.
- Togliendo le protezioni (controllo dell'host del link, spegnimento da ambiente, interruttore) i
  test falliscono.
- Il test dell'elenco di disinstallazione ha trovato un errore vero, corretto prima del commit:
  `$INSTDIR` veniva protetto come testo e il disinstallatore non avrebbe tolto nulla.
- **Non eseguiti** per la memoria: suite completa (due volte), suite completa dell'interfaccia,
  revisore, prova dell'installatore compilato.

## Rischi

- Lo script NSIS è stato accettato da `makensis` (nessun errore di sintassi), ma l'installatore
  compilato non è ancora stato provato.
- `FileOpen` in scrittura come rilevamento di "in esecuzione" va verificato sul PC.
- Repository privato: l'API delle release risponde 404 e l'app mostra "nessuna release
  pubblicata".
