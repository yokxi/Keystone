# Pacchetto dell'app

Keystone si distribuisce con un **installatore per Windows** (`Keystone-Setup-<versione>.exe`) e,
in alternativa, come **app portabile**: una cartella con `Keystone.exe` che avvia da sola
l'orchestratore, senza i sorgenti, senza Node installato e senza `tsx`.

```powershell
npm run package -w app            # app/release/Keystone-win32-x64/
npm run package -w app -- --zip   # anche app/release/Keystone-<versione>-win32-x64.zip
npm run installer -w app          # pacchetto, poi app/release/Keystone-Setup-<versione>.exe (+ .sha256)
```

Lo script usa la distribuzione di Electron e i pacchetti già installati dal lockfile; se il
binario di Electron non è ancora stato scaricato, il pacchetto `electron` lo scarica con i checksum
ufficiali, come al primo `npm run app`. Si impacchetta per la piattaforma su cui si esegue (i binari nativi sono per piattaforma).

## Cosa c'è dentro

| Percorso | Contenuto |
|---|---|
| `Keystone.exe` e i file accanto | la distribuzione di Electron, con l'eseguibile rinominato |
| `resources/app/` | main, preload e renderer compilati (tutto in bundle, niente `node_modules`) |
| `resources/orchestrator/main.mjs` | l'orchestratore in un solo file (`app/scripts/build-orchestrator.mjs`) |
| `resources/orchestrator/node_modules/` | solo i pacchetti con binari nativi o che li cercano accanto a sé: SDK di Claude (con la CLI per piattaforma), Codex (binario nativo), playwright-core, zod (condiviso con l'SDK) e le loro dipendenze |

La dimensione è dominata dai binari di Codex e di Claude Code (circa 750 MB in tutto).

## Come parte l'orchestratore

Il pulsante "Avvia orchestratore" esegue `Keystone.exe` come Node (`ELECTRON_RUN_AS_NODE=1`) su
`resources/orchestrator/main.mjs`, con la porta e il profilo dell'app. Con l'app impacchettata conta
solo il bundle: i sorgenti non vengono mai cercati.

L'uscita dell'orchestratore va in `~/.keystone/<profilo>/orchestrator-avvio.log`, in coda, con una
riga per ogni avvio; oltre 2 MB il file passa a `.1` e ne inizia uno nuovo. Se l'orchestratore si
ferma nei primi secondi (per esempio per un `config.json` non valido, vedi
`docs/configurazione.md`), anche con codice 0, o se il sistema non riesce ad avviarlo, l'app lo dice
con il codice d'uscita o l'errore e le ultime righe del log.

`ELECTRON_RUN_AS_NODE` non arriva ai comandi degli agenti (`orchestrator/src/core/agent-env.ts`):
un'app Electron del repository lanciata dai test partirebbe come Node.

## Fuse di Electron

Le fuse sono opzioni scritte nel binario di Electron. Il pacchetto le imposta così:

| Fuse | Valore | Perché |
|---|---|---|
| RunAsNode | accesa | l'orchestratore gira con il Node di Electron |
| EnableCookieEncryption | accesa | |
| EnableNodeOptionsEnvironmentVariable | spenta | `NODE_OPTIONS` non può iniettare codice nell'app o nell'orchestratore |
| EnableNodeCliInspectArguments | spenta | niente debugger collegabile con `--inspect` |
| OnlyLoadAppFromAsar, EnableEmbeddedAsarIntegrityValidation | spente | l'app è una cartella, non un archivio asar (vedi i limiti) |
| LoadBrowserProcessSpecificV8Snapshot | spenta (valore predefinito) | non serve |
| GrantFileProtocolExtraPrivileges | accesa (valore predefinito) | l'interfaccia si carica da `file://`; spegnerla richiede di servirla con un protocollo dell'app, da valutare |

Lo script controlla che le fuse abbiano i valori predefiniti attesi prima di modificarle; se il
formato non è quello previsto si ferma invece di scrivere nel posto sbagliato. Dopo la scrittura le
rilegge dall'eseguibile.

## Controlli a fine pacchetto

`package.mjs` verifica il risultato con `Keystone.exe` stesso: ogni pacchetto importato dal bundle
si carica e si risolve dentro `resources/orchestrator` (il pacchetto sta nel repository, e senza
questo controllo un pacchetto mancante verrebbe preso in silenzio dal `node_modules` del
repository); i binari di Codex e di Claude Code ci sono.

## Installatore

`app/scripts/installer.mjs` compila `app/installer/keystone.nsi` con **NSIS 3** (`makensis`) sulla
cartella portabile. Niente electron-builder: portava `minimatch` con l'avviso GHSA-g3hv-75wg-m249,
e la versione corretta trascinava un pacchetto nuovissimo (vedi `docs/sicurezza.md`). NSIS è un
programma a parte, non una dipendenza npm, e non entra nell'app.

**NSIS sul PC di chi crea l'installatore.** Lo script cerca `makensis.exe` in quest'ordine:
`MAKENSIS=<percorso>`, il `PATH`, `%USERPROFILE%\strumenti\nsis-<versione>\` (la più recente), le
cartelle standard di Program Files. Basta lo zip ufficiale estratto (nessuna installazione):

```powershell
# NSIS 3.13 (27 settembre 2026), da https://nsis.sourceforge.io/Download
# MD5 dello zip: 530e3623c077cba879ed2ae6e13be362 (quello pubblicato da SourceForge)
Expand-Archive nsis-3.13.zip "$env:USERPROFILE\strumenti"
```

**Cosa fa l'installatore.**

| | |
|---|---|
| Dove | `%LOCALAPPDATA%\Programs\Keystone`, per il solo utente, senza permessi di amministratore. Si può scegliere un'altra cartella: l'app va sempre in una sottocartella `Keystone`, che deve essere vuota o contenere un'installazione precedente |
| Collegamenti | menu Start; desktop facoltativo (casella nell'ultima pagina) |
| App installate | voce in Impostazioni → App → App installate, con versione e disinstallazione |
| Aggiornamento | se trova un'installazione precedente, ne avvia il disinstallatore (che toglie i suoi file), poi copia i nuovi: non restano file vecchi |
| In esecuzione | se `Keystone.exe` è in uso (finestra o orchestratore) chiede di chiuderlo e di fermare l'orchestratore, con Riprova / Annulla |
| Disinstallazione | toglie solo i file e le cartelle dell'elenco generato al momento del pacchetto (`release/.installer/uninstall-list.nsh`), mai cancellazioni ricorsive; una cartella con file tuoi resta. Non tocca `~/.keystone` |
| Silenziosa | `Keystone-Setup-<versione>.exe /S` installa senza finestre (stessi controlli; con Keystone in esecuzione esce con codice 2) |

Accanto all'installatore lo script scrive `Keystone-Setup-<versione>.exe.sha256`, da pubblicare
nella release.

## Aggiornamenti

L'app controlla su GitHub se c'è una release più recente e lo dice in un banner e in Impostazioni →
Aggiornamenti; non scarica e non installa nulla da sola. Regole e limiti in `docs/sicurezza.md`
("Aggiornamenti"). Per pubblicare una versione:

1. alza `version` in `package.json` (e `app/package.json`), committa;
2. `npm run installer -w app -- --zip`: installatore, impronta e zip portabile in `app/release/`;
3. crea su GitHub una release con il tag `v<versione>` (non una bozza né una pre-release), con le
   novità nel testo, e allega `Keystone-Setup-<versione>.exe`, il suo `.sha256` e lo zip portabile.

Le app già installate la vedono al prossimo avvio (o entro un giorno, se restano aperte).

## Limiti

- **Niente firma del codice.** Windows SmartScreen avvisa al primo avvio di `Keystone.exe`.
- **RunAsNode acceso.** Chi può eseguire `Keystone.exe` può usarlo come Node. Non dà più permessi
  di quelli che ha già l'utente (che può eseguire qualunque programma), ma è annotato.
- **Niente asar né controllo d'integrità dell'app.** Chi può scrivere nella cartella dell'app può
  modificarla (anche aggiungendo un `resources/app.asar`, che verrebbe caricato al posto di
  `resources/app`): tienila in una cartella tua, non condivisa.
- `--remote-debugging-port` di Chromium non è bloccato: chi può avviare `Keystone.exe` con quel
  parametro può pilotare la finestra. Vale per chi ha già il tuo account sul PC, che potrebbe
  comunque collegarsi all'orchestratore in locale.
- Chromium per la verifica visuale non è incluso: si scarica in `~/.keystone`, sempre dopo il tuo
  permesso, come in sviluppo.
