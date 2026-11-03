# Protocollo Keystone (v1)

Questo documento descrive due contratti:

1. **Orchestratore ↔ interfaccia**: messaggi WebSocket tra il processo orchestratore e l'app.
2. **Motori → orchestratore**: eventi normalizzati che ogni motore (sim, Claude, Codex) emette
   durante un turno.

La fonte di verità sono gli schemi zod in `shared/src/protocol.ts` e `shared/src/engine-events.ts`.
Il test `shared/test/protocol.test.ts` fallisce se un tipo di messaggio o di evento non è
documentato qui.

---

## 1. Trasporto

- WebSocket su `ws://127.0.0.1:<porta>` (default `7931`, oppure `KEYSTONE_PORT` o `--port`).
  L'orchestratore ascolta **solo su loopback**.
- Un messaggio JSON per frame: `{ "v": 1, "type": "...", "id"?: "...", ...payload }`.
- **Connessioni rifiutate (HTTP 401):**
  - qualunque richiesta con header `Origin`, anche vuoto o `null`, perché ogni browser lo manda e
    così una pagina web non può pilotare gli agenti;
  - qualunque `Host` diverso da `127.0.0.1`, `localhost` o `[::1]` (protezione dal DNS rebinding).
- **App Electron:** il WebSocket lo apre solo il **processo main** (Node, nessun `Origin`). Il
  renderer comunica con il main esclusivamente via IPC tramite preload/`contextBridge`, con
  `contextIsolation: true` e `nodeIntegration: false`. Vedi `app/src/main/orchestrator-client.ts`.
- **Handshake:** il client manda `hello` e riceve uno `snapshot` completo, poi tutti gli
  aggiornamenti. Prima di `hello` gli altri messaggi vengono rifiutati con `error`. Dopo una
  riconnessione arriva un nuovo snapshot.
- **Ack:** ogni messaggio del client con `id` riceve un `ack` con `re` uguale a quell'`id`,
  `ok`, `error?` e `result?`. Gli errori di validazione arrivano anche come `error`.
- **Persistenza:** l'interfaccia non salva nulla. Lo stato vive nell'orchestratore, sotto
  `~/.keystone/<profilo>/`.

## 2. Entità

| Entità | Campi |
|---|---|
| `Agent` | `id`, `name`, `role` (`lead`/`worker`), `engine` (`sim`/`claude`/`codex`), `model` (nome visualizzato, es. "Opus 5.5"), `state`, `activity`, `taskId?`, `worktree?`, `paused`, `active`, `costUsd`, `tokens` |
| `Task` | `id` (t1…), `title`, `description?`, `status`, `deps[]`, `assignee?`, `priority`, `goalId?`, `repoId?`, `branch?`, `worktree?`, `ci`, `summary?`, `blockedReason?`, `report?` (resoconto del worker), `visualChecks?` (pagine da verificare), `visual?` (esito della verifica visuale: per pagina `before` e `after`, ciascuno con `shot?`, `error?` e `diagnostics?` = `{ console[], errors[], failedRequests[], truncated? }`), `createdBy`, `createdAt`, `updatedAt` |
| `Goal` | `id` (g1…), `text`, `status` (`planning`/`active`/`paused`/`done`/`failed`/`cancelled`; `paused` = fermo perché ha raggiunto il tetto di spesa), `progress` 0..1, `repoId?`, `costUsd` (spesa registrata), `budgetUsd?` (tetto di spesa; assente = nessun tetto), `pausedFrom?`, `createdAt` |
| `Decision` | `id` (d1…), `agentId`, `kind` (`question`/`permission`/`merge`/`budget`), `question`, `options[]`, `context?`, `status` (`open`/`answered`/`cancelled`), `answer?` {`option?`, `text?`}, `cancelReason?`, `taskId?`, `repoId?`, `worktree?`, `tool?`, `command?` (permesso: il comando completo, senza tagli), `alwaysAsk?` (permesso: richiede sempre approvazione, niente "Consenti sempre"), `createdAt`, `answeredAt?` |
| `Repo` | `id`, `name`, `path`, `branch`, `dirty`, `ci`, `worktrees[]`, `mergeTarget?`, `branches?`, `visual?` (`{ command, url, startTimeoutSec, agentScreenshots? }`) |
| `Worktree` | `id` (`<agente>-<task>`), `repoId`, `agentId`, `taskId?`, `branch` (`Keystone/<agente>/<task>-<slug>`), `base`, `path`, `status` (`active`/`merged`/`abandoned`), `files`, `additions`, `deletions` |
| `MemoryEntry` | `id` (`shared/<slug>` o `<agente>/<slug>`), `scope`, `title`, `body` (markdown), `author?`, `updated` |
| `FeedItem` | `ts`, `kind`, `text`, `agentId?`, `to?` |
| `LogEntry` | `ts`, `kind` (`text`/`tool`/`result`/`error`/`diff`/`test`/`permission`), `text` |
| `OrchestratorStatus` | `version`, `auth` (`ok`/`failed`/`unknown`), `message`, `costUsd`, `tokens`, `userName`, `userNameSource`, `profile`, `billing`, `costIncomplete` |
| `DiffFile` | `path`, `oldPath?`, `status` (`added`/`modified`/`deleted`/`renamed`), `binary`, `additions`, `deletions`, `hunks[]` {`header`, `oldStart`, `newStart`, `lines[]` {`kind`: `add`/`del`/`ctx`, `text`, `oldNo?`, `newNo?`}} |

**Stati di un agente:** `idle`, `thinking`, `reading`, `editing`, `running`, `testing`,
`waiting_user`, `blocked`, `done`, `error`.

**Stati di un task e transizioni ammesse:**

```
todo      → doing, blocked, cancelled, done
doing     → review, blocked, todo, cancelled, done
review    → done, doing, blocked, todo, cancelled
blocked   → todo, doing, review, cancelled
done      → todo        (retry)
cancelled → todo        (retry)
```

Un task entra in `doing` solo se ha un assegnatario e tutte le dipendenze sono `done`. Un task con
worktree diventa `done` solo tramite merge approvato dall'utente.

**Opzioni fisse delle decisioni:**

- merge: `Merge` / `Richiedi modifiche` / `Rifiuta`;
- tetto di spesa raggiunto (`budget`): `Aumenta il tetto` / `Lascia in pausa`. Il `text` della
  risposta può indicare il nuovo tetto in dollari; senza importo il tetto raddoppia;
- download del browser per la verifica visuale (permesso con `tool: "visual.browser"`): `Scarica
  Chromium` / `Nega`. Keystone la apre solo se non trova Edge né Chrome; vedi
  `docs/verifica-visuale.md`;
- permesso: `Consenti una volta` / `Consenti sempre per questo agente` / `Nega`. Per le azioni che
  richiedono sempre approvazione (configurazione git, variabili d'ambiente, hook e `.git`,
  `git -c`) le opzioni sono solo `Consenti una volta` / `Nega`. Il `context` della decisione
  spiega cosa coprirebbe "Consenti sempre". Dettagli in `docs/sicurezza.md`.

## 3. Orchestratore → interfaccia

### `snapshot`
Lo stato completo, inviato in risposta a `hello`.
`{ status, agents[], tasks[], goals[], decisions[], repos[], memory[], feed[], logs: { [agentId]: LogEntry[] } }`
(per i log, solo le ultime righe di ogni agente).

### `agent.upsert`
`{ agent }`: un agente è nuovo o è cambiato (stato, attività, modello, costo…).

### `agent.log`
`{ agentId, entries: LogEntry[] }`: nuove righe del log live di un agente (tool call, risultati,
diff, test, permessi).

### `agent.say`
`{ agentId, to?, text, ts }`: un agente ha mandato un messaggio (a un compagno, a `all` o a
`user`).

### `task.upsert`
`{ task }`: un task è nuovo o è cambiato.

### `goal.upsert`
`{ goal }`: un obiettivo è nuovo o è cambiato (stato, avanzamento).

### `decision.upsert`
`{ decision }`: una decisione è stata aperta, risolta, riaperta o annullata.

### `repo.upsert`
`{ repo }`: repository registrato o aggiornato (branch, modifiche non committate, worktree).

### `memory.upsert`
`{ entry }`: una nota della memoria è stata scritta.

### `feed.add`
`{ item }`: una nuova voce nel feed delle attività.

### `status`
`{ status }`: lo stato globale è cambiato (autenticazione, messaggio, costo e token totali).

### `diff`
`{ requestId, repoId, worktree, files: DiffFile[] }`: risposta a `diff.request`, inviata solo al
client che l'ha chiesta.

### `visual.shot`
`{ requestId, dataUrl?, error? }`: risposta a `visual.shot.request`, inviata solo al client che l'ha
chiesta. `dataUrl` è la schermata come `data:image/png;base64,…`; se la schermata non esiste o non
appartiene alla verifica del task arriva solo `error`.

### `notify`
`{ level: info|warn|need_user, text }`: notifica da mostrare. `need_user` indica che una decisione
aspetta l'utente.

### `ack`
`{ re, ok, error?, result? }`: esito di un messaggio del client che aveva un `id`.

### `error`
`{ message, re? }`: messaggio del client non valido o arrivato prima di `hello`.

## 4. Interfaccia → orchestratore

### `hello`
`{ client, protocol: 1 }`: apre la sessione; la risposta è uno `snapshot`.

### `goal.submit`
`{ text, repoId?, budgetUsd? }`: nuovo obiettivo (senza `repoId` si usa il primo repository
registrato). `budgetUsd` è il tetto di spesa in dollari; se manca vale quello della configurazione
(default 5, `--budget` o `KEYSTONE_BUDGET_USD`; 0 = nessun tetto). Quando la spesa lo raggiunge,
l'obiettivo passa in `paused`: i turni dei suoi agenti vengono fermati e salvati, i lavori in coda
aspettano, e arriva una decisione `budget`. Il motore Claude riceve anche la spesa residua come
limite del turno, così la CLI stessa si ferma al tetto.
Risultato: `{ goalId }`.

### `user.message`
`{ to, text }`: messaggio a un agente (id o nome, `@` facoltativo) oppure a `all`. Se l'agente è
in un turno, il messaggio arriva con il prossimo risultato di un suo tool; altrimenti parte un
turno di follow-up. Risultato: `{ to }`.

### `decision.answer`
`{ decisionId, option?, text? }`: risposta a una decisione. `option` può essere l'etichetta
(senza distinzione tra maiuscole e minuscole) o il numero dell'opzione partendo da 1. Una domanda
accetta anche solo `text`. Se gli effetti falliscono (es. merge rifiutato) la decisione viene
riaperta con il motivo in `context`.

### `task.action`
`{ taskId, action: cancel|retry|prioritize|reassign, arg? }`. Per `prioritize`, `arg` è la nuova
priorità (intero); per `reassign`, `arg` è il worker.

### `agent.action`
`{ agentId, action }`:
- `pause`: interrompe il turno e l'agente tiene il task;
- `resume`: riprende il lavoro;
- `stop`: l'agente va fuori turno e i suoi task tornano sul tabellone (chi li riprende parte dal
  suo branch);
- `spawn`: riporta in servizio un agente fuori turno.

### `diff.request`
`{ requestId, repoId, worktree }`: chiede il diff di un worktree (anche chiuso: in quel caso si usa
il commit del branch salvato al merge, perché il branch può essere stato eliminato). La risposta è
un messaggio `diff`.

### `repo.preview`
`{ path }`: anteprima della registrazione, senza modificare nulla. Verifica che sia la radice di
un repository con almeno un commit e restituisce la modifica che verrà fatta al suo
`.git/config` (il guardiano git, vedi `docs/sicurezza.md`). Risultato:
`{ root, configFile, lines: string[], guardFile, installed }`. `lines` sono esattamente le righe
che verranno aggiunte in fondo a `configFile`; `installed: true` significa che non serve nessuna
modifica.

### `repo.add`
`{ path, confirmGuard? }`: registra un repository. Se il guardiano non è ancora installato serve
`confirmGuard: true`, cioè che l'utente abbia visto l'anteprima (`repo.preview`) e confermato;
senza conferma la registrazione viene rifiutata e il `.git/config` non cambia. Risultato:
`{ repoId }`.

### `goal.budget`
`{ goalId, budgetUsd }`: cambia il tetto di spesa di un obiettivo. Se l'obiettivo era in pausa per il
tetto e ora c'è margine, riprende: i turni fermati ripartono con la stessa sessione. Risultato:
`{ goalId, budgetUsd, status }`.

### `settings.set`
`{ userName }`: il tuo nome come lo usano gli agenti (prompt, domande, richieste di merge) e il
registro. Viene ripulito da a capo e caratteri di controllo (massimo 60 caratteri). `null` o vuoto
torna al predefinito: `--user-name`, poi `git config user.name`, poi il nome utente del sistema.
Vale dai turni successivi. Risultato: `{ userName, userNameSource }`.

### `repo.config`
`{ repoId, mergeTarget?, visual? }`: configurazione di un repository. Ogni campo assente resta
com'è, `null` torna al default; serve almeno uno dei due campi.

- `mergeTarget`: il branch in cui fare i merge. `null` = il branch aperto nel tuo checkout. Il
  branch deve esistere e non può essere `Keystone/*`. I nuovi worktree partono da quel branch. Se
  non è estratto nel tuo checkout, il merge sposta solo il riferimento con `update-ref` e il
  controllo del valore precedente: il tuo checkout non cambia.
- `visual`: la verifica visuale, `{ command, url, startTimeoutSec, agentScreenshots? }`. `null` =
  disattivata. `url` deve essere locale (`localhost`, `127.0.0.1` o `[::1]`), `startTimeoutSec`
  tra 5 e 600. `agentScreenshots: true` allega le schermate alla review del lead e ai risultati di `try_ui` del
  worker. Dettagli in
  `docs/verifica-visuale.md`.

Risultato: `{ repoId, mergeTarget, visual }` (i valori dopo la modifica, `null` se assenti).

### `visual.shot.request`
`{ requestId, taskId, shotId }`: chiede una schermata della verifica visuale di un task. `shotId`
è uno degli id nell'esito `task.visual` (es. `before-1`, `after-2`): altri id non vengono
serviti, e un percorso non può mai arrivare dal client. La risposta è un messaggio `visual.shot`.
Risultato: `{ found }`.

### `worktrees.prune`
`{}`: pulizia manuale dei worktree. Chiude i worktree attivi di task finiti, annullati o
scomparsi (il lavoro viene salvato sul branch, che resta), rimuove le cartelle orfane ed esegue
`git worktree prune`. I worktree su cui un agente sta lavorando non vengono toccati. Risultato:
`{ report: string[] }`. Non elimina branch. Da riga di comando: `npm run orchestrator --
--prune-worktrees`, che in più elenca i branch dei task rifiutati o abbandonati e li elimina dopo
conferma.

---

## 5. Eventi dei motori (EngineEvent)

Ogni adattatore implementa `EngineAdapter` (`orchestrator/src/engines/types.ts`):

| Operazione | Metodo |
|---|---|
| avvia sessione | `startSession(spec): EngineTurn` |
| riprendi sessione | `resumeSession(sessionId, spec): EngineTurn` |
| invia messaggio | tra un turno e l'altro: `resumeSession(sessionId, spec)` con il messaggio come prompt; durante un turno: allegato ai risultati dei tool del team |
| stream di eventi | `EngineTurn.events: AsyncIterable<EngineEvent>` |
| risposta a un permesso | `EngineTurn.respond(requestId, { allow: true } \| { allow: false, message })` |
| interruzione | `EngineTurn.abort(reason)`: lo stream termina con `turn_end` `aborted` |

Ogni turno emette prima `session` e chiude sempre con un solo `turn_end`. A ogni `tool_call`
corrisponde un `tool_result` con lo stesso `callId`. Il test `orchestrator/test/engine-contract.test.ts`
verifica queste regole; varrà per tutti i motori.

### `session`
`{ sessionId }`: l'id della sessione (sessione Claude, thread Codex, id del sim), salvato per
poterla riprendere.

### `model`
`{ model }`: il modello effettivamente in uso (es. `claude-opus-5-5`). L'interfaccia lo mostra
nella forma restituita da `EngineAdapter.displayModel()`.

### `text`
`{ text }`: testo dell'agente.

### `tool_call`
`{ callId, tool, input }`: l'agente usa un tool. Il vocabolario è comune a tutti i motori:
`Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash`, `PowerShell`, oppure un tool del team
(`send_message`, `ask_user`, `write_memory`, `read_memory`, `update_task`, `report_status`,
`list_tasks`, `create_task`, `request_merge`, `submit_report`, `try_ui`). `submit_report` e `try_ui`
sono solo dei worker, `create_task` e `request_merge` solo del lead.

### `tool_result`
`{ callId, ok, output }`: esito di una tool call.

### `file_change`
`{ path, change: add|modify|delete, diff? }`: un file è stato modificato (path relativo alla
cartella di lavoro, diff unificato se il motore lo conosce).

### `permission_request`
`{ requestId, tool, input, reason? }`: il motore chiede se può usare un tool e il turno resta in
attesa. L'orchestratore applica la policy e, se la policy non può decidere da sola, apre una
decisione `permission` per l'utente. Poi risponde con `respond()`.

### `usage`
`{ inputTokens, outputTokens, costUsd? }`: consumo **incrementale** da sommare (non cumulativo).
Codex riporta solo i token.

### `error`
`{ message, auth? }`: errore. Con `auth: true` è un errore di autenticazione e l'orchestratore
smette di avviare turni finché non viene riavviato.

### `turn_end`
`{ status: success|error|aborted|max_turns, resultText? }`: fine del turno, sempre l'ultimo
evento.
