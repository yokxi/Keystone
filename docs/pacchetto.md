# Pacchetto dell'app

Keystone si distribuisce come **app portabile**: una cartella con `Keystone.exe` che avvia da sola
l'orchestratore, senza i sorgenti, senza Node installato e senza `tsx`.

```powershell
npm run package -w app            # app/release/Keystone-win32-x64/
npm run package -w app -- --zip   # anche app/release/Keystone-<versione>-win32-x64.zip
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

## Limiti

- **Niente installatore per ora.** `electron-builder` (installatore NSIS) porta con sé `minimatch`
  in versioni con un avviso di sicurezza moderato (GHSA-g3hv-75wg-m249); la versione corretta
  (11.0.1) è uscita il 27 ottobre 2026, meno di 14 giorni fa, e trascina una dipendenza nuova.
  Invece di aggiungere eccezioni alla regola delle versioni si distribuisce l'app portabile;
  l'installatore si aggiunge quando le versioni corrette avranno almeno 14 giorni (vedi
  `docs/piano.md`).
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
