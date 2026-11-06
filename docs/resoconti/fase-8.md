# Resoconto — Fase 8 (pacchetto dell'app)

## Cosa è fatto

- **Bundle dell'orchestratore** (`app/scripts/build-orchestrator.mjs`): un solo file ES
  (`main.mjs`, circa 700 KB) che gira con il Node di Electron, senza sorgenti né `tsx`. Restano fuori
  dal bundle, copiati con le loro dipendenze seguite come le risolverebbe Node, l'SDK di Claude (con
  la CLI per piattaforma), Codex (binario nativo), playwright-core e zod (condiviso con l'SDK).
- **App portabile** (`npm run package -w app`, con `--zip` anche l'archivio): la distribuzione di
  Electron con `Keystone.exe`, `resources/app` (solo i file compilati) e `resources/orchestrator`.
- **Fuse di Electron**: `NODE_OPTIONS` e `--inspect` spenti, cookie cifrati; RunAsNode acceso perché
  l'orchestratore gira con il Node di Electron. Controllo dei valori prima e rilettura dopo.
- **Controlli a fine pacchetto**: ogni pacchetto importato dal bundle si carica con `Keystone.exe` e
  si risolve dentro il pacchetto, non dal repository; i binari di Codex e Claude ci sono.
- **Avvio dall'app**: l'app impacchettata avvia solo il bundle. L'uscita dell'orchestratore va in
  `~/.keystone/<profilo>/orchestrator-avvio.log` (in coda, con un limite di 2 MB). Un'uscita nei
  primi 2,5 secondi (anche con codice 0) o un errore del sistema nell'avviarlo vengono mostrati
  nell'app con le ultime righe del log: per esempio un `config.json` non valido.
- **Ambiente degli agenti**: `ELECTRON_RUN_AS_NODE` non arriva ai loro comandi.
- Documenti: `docs/pacchetto.md`, `docs/sicurezza.md` §6quinquies, README, piano.

## Scelte prese e perché

- **Niente installatore per ora, app portabile.** electron-builder 26.18 porta `minimatch` con
  l'avviso GHSA-g3hv-75wg-m249 (moderato). La versione corretta (11.0.1) è uscita il 27 ottobre 2026,
  meno di 14 giorni fa, e trascina una dipendenza nuova; in più npm non applicava l'override sul
  lockfile esistente senza rigenerarne interi rami. Invece di accumulare eccezioni alla regola delle
  versioni ho scritto un pacchetto senza dipendenze nuove. L'installatore è tra le cose da fare
  (dal 10 novembre 2026). Durante i tentativi ho riportato lockfile e `node_modules` esattamente allo
  stato del commit (`npm ci`): nessuna dipendenza cambiata in questa fase.
- **Fuse scritte direttamente** (formato documentato di Electron) invece di aggiungere
  `@electron/fuses`: poche righe, con controllo del formato prima e rilettura dopo.
- **RunAsNode acceso**: l'orchestratore deve sopravvivere alla chiusura della finestra (processo
  staccato), quindi non può essere un `utilityProcess` dell'app.
- **Segnaposto neutro** nelle Impostazioni ("es. Maria"), per non avere il nome dell'utente nel
  pacchetto.

## Rischi e limiti

- Niente firma del codice (SmartScreen avvisa), niente asar né controllo d'integrità della cartella
  dell'app, `--remote-debugging-port` non bloccato, `GrantFileProtocolExtraPrivileges` acceso
  (interfaccia da `file://`): tutti documentati in `docs/pacchetto.md`.
- Dimensione: circa 790 MB, quasi tutti i binari di Codex e Claude Code.
- Il pacchetto si costruisce per la piattaforma su cui si esegue.

## Prove reali

- Orchestratore impacchettato eseguito con `Keystone.exe` fuori dal repository: si avvia con i motori
  sim, claude e codex (senza obiettivi, quindi senza consumare API); con sim un obiettivo arriva fino
  alla decisione di merge, con i test eseguiti da Keystone.
- App impacchettata in modalità smoke, collegata all'orchestratore impacchettato: le 14 schermate
  (7 viste, tema chiaro e scuro) mostrano tabellone, agenti con il log e la decisione di merge.
- `NODE_OPTIONS=--require …` inietta codice con l'Electron normale e non con `Keystone.exe`.
- `config.json` non valido: l'orchestratore impacchettato esce con codice 1 e il messaggio.
- Mutazioni: togliendo la rimozione di `ELECTRON_RUN_AS_NODE` fallisce il suo test; togliendo `zod`
  dal pacchetto, Node lo prenderebbe dal repository, e il controllo di `package.mjs` lo rileva.

## Test

- `app/test/package.test.ts`: dove l'app cerca l'orchestratore (impacchettata e in sviluppo),
  argomenti, uscita anticipata (codice diverso da 0, codice 0, eseguibile mancante), ultime righe
  del log, log in coda con limite, fuse (scrittura e formato inatteso senza scrivere).
- `orchestrator/test/agent-env.test.ts`: niente `ELECTRON_RUN_AS_NODE` nell'ambiente degli agenti.
- Risultati finali: typecheck pulito; `npm test` due volte: 38 file, 541 test passati entrambe le
  volte; `npm run test:ui`: 4 test passati.
- **Test instabile, causa probabile non confermata.** In un'esecuzione della suite 4 flussi lunghi
  con il motore sim e merge git (`branches`, `sim-flow`, `sim-markers`) sono falliti dopo circa 27 s,
  cioè al limite di 20 s di `waitFor`; nelle altre sei esecuzioni (complete o dei soli tre file,
  anche subito dopo aver ricostruito il pacchetto) sono passati. La logica non dipende dall'ordine:
  l'ipotesi più probabile è un picco di carico della macchina (scansione antivirus degli 800 MB del
  pacchetto appena scritti) che ha rallentato git. Correzione: il limite predefinito di `waitFor`
  passa a 45 s, sotto i 60 s di ogni test.

## Parere del revisore

Nessun bloccante. Da correggere, tutto corretto: errore di spawn perso (l'app diceva "avviato"),
descrittore del log non chiuso in caso di errore, uscita con codice 0 considerata riuscita,
resoconto mancante, fuse `GrantFileProtocolExtraPrivileges` e `LoadBrowserProcessSpecificV8Snapshot`
non documentate. Test mancanti aggiunti: controllo delle dipendenze sul pacchetto vero, rilettura
delle fuse, spawn fallito e codice 0. Suggerimenti accolti: log in coda con limite, elenco esplicito
dei pacchetti nativi, nota su `app.asar`, segnaposto neutro.
