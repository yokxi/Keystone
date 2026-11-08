# Interfaccia desktop

L'app (`app/`, Electron + React) è solo vista e comandi: lo stato lo possiede l'orchestratore. Se
chiudi l'app gli agenti continuano a lavorare; quando la riapri, l'app si ricollega da sola.

## Avvio (sviluppo)

```powershell
npm run orchestrator -- --demo      # orchestratore con un repository di prova e il motore sim
npm run app                          # compila e apre l'app
```

L'app trova l'orchestratore leggendo `~/.keystone/<profilo>/orchestrator.json`; in alternativa usa
`KEYSTONE_PORT` o la porta predefinita 7931. Il profilo si sceglie con `KEYSTONE_PROFILE` (con
`--demo` è `demo`). Se l'orchestratore non è raggiungibile compare un avviso, con un pulsante per
avviarlo dai sorgenti.

## Schermate

| Schermata | Cosa mostra |
|---|---|
| **Console** (sempre in basso) | Testo libero = nuovo obiettivo; `@agente messaggio`; comandi `/pausa`, `/riprendi`, `/ferma`, `/attiva`, `/task t3 …`, `/rispondi d4 …`, `/repo`, `/pulisci`, `/aiuto`. Tab completa i nomi degli agenti, ↑ e ↓ scorrono la cronologia. Qui compaiono anche i messaggi degli agenti per te e le notifiche. |
| **Tabellone** | L'obiettivo con l'avanzamento e il kanban (da fare, in corso, in review, bloccati, completati; gli annullati a richiesta). Ogni scheda mostra assegnatario, dipendenze, esito dei test e motivo del blocco, con le azioni: diff, riprova, priorità, assegna, annulla. |
| **Agenti** | Per ogni agente: stato, motore e **modello in uso**, costo e token. Il pannello mostra le skill ricevute nell'ultimo turno, il log live (tool call, risultati, test, permessi, diff colorati), i comandi pausa, riprendi e fuori turno, e un campo per scrivergli. |
| **Decisioni** | Domande, permessi e merge, dalla più vecchia. I permessi che **richiedono sempre approvazione** (configurazione git, variabili d'ambiente, hook, `.git`, `git -c`) hanno bordo e fondo rossi, l'avviso "Richiede sempre la tua approvazione", il **comando completo** e solo `Consenti una volta` / `Nega`. Gli altri permessi offrono anche "Consenti sempre" e spiegano cosa copre. |
| **Review** | Si apre sulla scheda **Riassunto**: richiesta, cosa è stato fatto e perché (resoconto del worker), file toccati (clic per aprirli nel diff), esito dei test eseguiti da Keystone con le note della review del lead, schermate prima/dopo con "Console, errori e rete" se il repository ha la verifica visuale (vedi `docs/verifica-visuale.md`), e **Rischi**: quelli che Keystone rileva da solo (modifiche alle skill del repository, test falliti o mancanti, verifica visuale non riuscita o con errori nuovi, dipendenze, CI, file cancellati o binari) e i problemi aperti dichiarati dal worker. La scheda **Diff** ha l'elenco dei file e il diff con i numeri di riga e il contesto invariato compresso (clic per espanderlo). Pulsanti `Merge`, `Richiedi modifiche` (con il testo, e l'opzione "Salva la correzione come skill") e `Rifiuta`. |
| **Skill** | Le regole per gli agenti: del repository (`.keystone/skills/`, condivise con git, valgono dopo il commit sul branch di destinazione) e personali (`~/.keystone/skills/`). Crea, modifica, cancella, attiva o disattiva solo per te. Le skill personali create o cambiate fuori dall'app sono **da confermare**: gli agenti le ricevono solo dopo **Conferma**. Vedi `docs/skill.md`. |
| **Memoria** | Le note condivise e private degli agenti (piano, decisioni, convenzioni), in markdown. |
| **Repository** | Repository registrati, branch, stato del checkout, worktree attivi e pulizia dei worktree orfani. **Registra repository** mostra prima la riga che verrà aggiunta al `.git/config` (il guardiano git) e registra solo dopo la conferma. Per ogni repository, **merge in** sceglie il branch in cui vanno i merge (default: il branch aperto); se è un altro branch, il merge non tocca il tuo checkout. **Verifica visuale → Configura** imposta comando di avvio, URL locale, tempo massimo di avvio e se gli agenti vedono le schermate (il lead nella review, il worker con la prova interfaccia).  Sezione **database in sola lettura**: connessioni SQLite, PostgreSQL e SQL Server con avviso sui dati inviati al fornitore, conferma dell'utente in sola lettura (mai già spuntata), password cifrata dall'app, **Prova**. Vedi `docs/database.md`. |
| **Impostazioni** | Il tuo nome come lo usano gli agenti (default: `git config user.name`), con la sua provenienza e il ritorno al predefinito. **Aggiornamenti**: versione in uso, interruttore del controllo automatico, "Controlla ora", le novità della versione disponibile e il pulsante che apre la pagina della release (vedi `docs/pacchetto.md`). **Ferma orchestratore**: arresto ordinato, con conferma (e l'elenco degli agenti al lavoro), prima di aggiornare o disinstallare. |
| **Banner aggiornamento** | Se c'è una versione più recente: "È disponibile Keystone x.y.z", con il pulsante per le Impostazioni. |
| **Barra di stato** | Connessione, stato dell'autenticazione dei motori, decisioni in attesa, costo e token totali, tema (sistema, chiaro, scuro). |

Quando una decisione aspetta te e l'app non è in primo piano, arriva una notifica di Windows.

## Sicurezza dell'app

- Il renderer non ha accesso a Node: `contextIsolation`, `sandbox`, `nodeIntegration: false`,
  nessun `webview`.
- Il WebSocket lo apre solo il **processo main**. Il renderer comunica con il main solo via IPC
  tramite preload e `contextBridge` (`window.keystone`), su canali fissi.
- Il main **valida ogni comando** del renderer con lo stesso schema zod del protocollo e accetta
  solo i tipi ammessi (`app/src/main/ipc-validate.ts`). Ignora anche i messaggi IPC che non
  arrivano dalla pagina locale dell'app.
- La pagina ha una Content Security Policy che consente solo risorse locali. La navigazione e
  l'apertura di nuove finestre sono bloccate, e i permessi del browser (fotocamera, notifiche web,
  …) sono negati.

## Verifica visiva

Con `KEYSTONE_SMOKE_DIR=<cartella>` l'app cattura una schermata di ogni vista in tema chiaro e
scuro, poi si chiude. Le viste si scelgono con `KEYSTONE_SMOKE_VIEWS`, e con
`KEYSTONE_SMOKE_REPO=<repo>` si sceglie il repository mostrato nella finestra di registrazione.
