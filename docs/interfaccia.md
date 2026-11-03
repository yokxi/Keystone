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
| **Agenti** | Per ogni agente: stato, motore e **modello in uso**, costo e token. Il pannello mostra il log live (tool call, risultati, test, permessi, diff colorati), i comandi pausa, riprendi e fuori turno, e un campo per scrivergli. |
| **Decisioni** | Domande, permessi e merge, dalla più vecchia. I permessi che **richiedono sempre approvazione** (configurazione git, variabili d'ambiente, hook, `.git`, `git -c`) hanno bordo e fondo rossi, l'avviso "Richiede sempre la tua approvazione", il **comando completo** e solo `Consenti una volta` / `Nega`. Gli altri permessi offrono anche "Consenti sempre" e spiegano cosa copre. |
| **Review** | Elenco dei file con le righe aggiunte e tolte, diff con i numeri di riga vecchi e nuovi e il contesto invariato compresso (clic per espanderlo), riassunto e resoconto del worker, note della review del lead ed esito dei test. Se il repository ha la verifica visuale, sopra il diff ci sono le schermate prima/dopo di ogni pagina, affiancate, con didascalia e problemi (clic per ingrandire; vedi `docs/verifica-visuale.md`). Pulsanti `Merge`, `Richiedi modifiche` (con il testo) e `Rifiuta`. |
| **Memoria** | Le note condivise e private degli agenti (piano, decisioni, convenzioni), in markdown. |
| **Repository** | Repository registrati, branch, stato del checkout, worktree attivi e pulizia dei worktree orfani. **Registra repository** mostra prima la riga che verrà aggiunta al `.git/config` (il guardiano git) e registra solo dopo la conferma. Per ogni repository, **merge in** sceglie il branch in cui vanno i merge (default: il branch aperto); se è un altro branch, il merge non tocca il tuo checkout. **Verifica visuale → Configura** imposta comando di avvio, URL locale, tempo massimo di avvio e se il lead vede le schermate. |
| **Impostazioni** | Il tuo nome come lo usano gli agenti (default: `git config user.name`), con la sua provenienza e il ritorno al predefinito. |
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
