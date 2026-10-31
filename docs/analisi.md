# Analisi di AgentCraft (riferimento per Keystone)

> Fonte: <https://github.com/blendi-remade/agentcraft> (licenza MIT), commit `8fe3ad2`, clonato in
> `../agentcraft-ref` solo in lettura. Ho studiato `README.md`, `docs/SPEC.md`, `docs/protocol.md`,
> `foreman/` (tutto `src/`) e `tools/`. Ho ignorato `mod/` e `assets-src/` (Minecraft).
> Keystone riprende il **procedimento**, non il codice.

---

## 1. Architettura

```
┌───────────────────────┐   WebSocket 127.0.0.1:7878    ┌───────────────────────────────────────────┐
│ Vista (mod Minecraft, │  ───────────────────────────► │ Foreman (Node 22 + TS, processo separato) │
│ TUI, CLI tools)       │  hello / goal.submit / ...    │                                           │
│ solo rendering +      │  ◄─────────────────────────── │  Foreman core (foreman.ts)                │
│ input utente          │  snapshot + *.upsert          │   ├─ TaskGraph      taskgraph.ts           │
└───────────────────────┘                               │   ├─ MessageBus     bus.ts                 │
                                                        │   ├─ Memory         memory.ts (markdown)   │
                                                        │   ├─ DecisionQueue  decisions.ts           │
                                                        │   ├─ RepoManager    repos.ts (worktree,    │
                                                        │   │                  diff, merge, CI)      │
                                                        │   ├─ Store          store.ts (state.json)  │
                                                        │   ├─ Notifier       notifiche desktop      │
                                                        │   └─ Backend        sim | team(engines)    │
                                                        │         Team (agents/team.ts)              │
                                                        │           ├─ Engine claude (Agent SDK)     │
                                                        │           └─ Engine codex (app-server)     │
                                                        └───────────────────────────────────────────┘
```

Principi chiave:

- **Il Foreman è l'unica fonte di verità.** È un processo indipendente: gli agenti continuano a
  lavorare anche a vista chiusa. La vista non contiene logica di business: disegna lo stato e
  manda "intenti" dell'utente.
- **`Ctx`** (`context.ts`) è il contesto iniettato in ogni sottosistema: `store`, `now()`,
  `emit(msg)`, `log`. Ogni mutazione di stato passa per un metodo che fa `store.markDirty()` +
  `emit({type:'x.upsert', ...})`. È questo il meccanismo che tiene sincronizzate persistenza e UI.
- **Il backend** implementa un'interfaccia `Backend` (`start`, `stop`, `submitGoal`,
  `onUserMessage`, `onDecisionSettled`, `onMergeConflict?`, `onTaskAction`, `onAgentAction`).
  Esistono due backend: `SimBackend` (scriptato) e il `Team` (agenti reali), che a sua volta usa
  uno o più **Engine** (Claude/Codex) scelti per singolo agente.
- **Il cast è fisso**: un lead (`marlow`) e fino a 5 worker con nome (`juniper`, `kit`, `wren`,
  `rowan`, `tove`). Il team effettivo è un sottoinsieme configurabile.

## 2. Flusso di un obiettivo

1. **Submit.** L'utente scrive un testo nella console, la vista manda `goal.submit {text, repoId?}`
   e il Foreman crea un `Goal` (status `planning`) e chiama `backend.submitGoal`.
2. **Plan (lead).** Il lead lavora in un job `plan` direttamente nel **checkout dell'utente**, ma in
   sola lettura (tool `Read/Grep/Glob/Bash` e la policy nega ogni scrittura). Esplora il repo,
   scrive `Plan: ...` in memoria condivisa (`write_memory`), crea i task con dipendenze e
   assegnatari (`create_task`) e se serve fa domande all'utente (`ask_user`). A fine turno: il goal
   ha task e diventa `active`; se non ne ha diventa `cancelled`, o `failed` se il turno è fallito.
3. **Scheduling.** `schedule()` scorre `tasks.ready(goal)` (stato `todo` con dipendenze tutte
   `done`, ordinati per priorità e poi per età) e assegna ogni task a un worker libero, rispettando
   `maxConcurrent` (3 di default). Se il task ha un assegnatario si aspetta proprio lui.
4. **Work (worker).** `startWork` crea un worktree su `agentcraft/<agente>/<task>-<slug>` sotto
   `<home>/<profile>/worktrees/<repo>/<agente>-<task>`, porta il task in `doing` e accoda un job
   `work`. Il worker modifica, testa, comunica con `send_message` e chiude con
   `update_task(status:"review", summary)`. Se finisce il turno senza farlo riceve **un solo**
   sollecito ("nudge"). Dopo il sollecito: se ha modificato file va comunque in review, altrimenti
   il task diventa `blocked`.
5. **CI.** `ciThenReview` esegue il comando di test del repo, rilevato automaticamente o passato con
   `--ci`, nel worktree e con l'ambiente git-safety. Al primo fallimento rimanda il task al worker
   (`ciFixes[t] < 1`); al secondo prosegue verso la review con l'esito `fail` annotato.
6. **Review (lead).** Il lead riceve diff, risultato CI e storico del task, poi chiama
   `request_merge(task, summary)` oppure `update_task(status:"doing")` per chiedere modifiche. Se
   non dà un verdetto si apre comunque una decisione di merge: **mai merge automatico**.
7. **Decisione di merge (utente).** Le opzioni sono esattamente `Merge` / `Request changes` /
   `Reject`.
   - `Merge`: `repos.merge()` costruisce il commit fuori dal working tree e fa fast-forward (vedi §5).
   - Conflitto: `backend.onMergeConflict` rimanda il task al worker con l'istruzione "`git merge
     <base>` nel tuo worktree, risolvi tenendo entrambi i lati, testa, committa". Il task rifà CI e
     review e arriva una nuova decisione.
   - `Request changes`: un follow-up al worker con il testo dell'utente.
   - `Reject`: il worktree viene abbandonato e il branch conservato.
8. **Fine goal.** Quando tutti i task non cancellati sono `done` il goal è completo e gli agenti
   passano allo stato `done`.

Un task che non ha modificato nessun file (un report, un'indagine) viene chiuso `done` senza
chiedere un merge vuoto (`closeIfNoChanges`).

## 3. Modelli dati principali

Definiti con **zod** in `protocol.ts` (da qui deriva anche `docs/protocol.md`). Versione semplificata:

| Entità | Campi principali |
|---|---|
| **Agent** | `id, name, role(lead/worker), state, station, activity, taskId?, repoId?, worktree?, paused, active, engine?, model?` |
| **Task** | `id(t1..), title, description?, status, deps[], assignee?, priority, goalId?, repoId?, branch?, worktree?, ci(unknown/running/pass/fail), summary?, blockedReason?, startBranch?, createdBy, createdAt, updatedAt` |
| **Goal** | `id(g1..), text, status(planning/active/done/failed/cancelled), progress 0..1, repoId?` |
| **Decision** | `id(d1..), agentId, kind(question/permission/merge), question, options[], context?, status(open/answered/cancelled), answer?{option?,text?}, taskId?, repoId?, worktree?, tool?` |
| **Repo** | `id, name, path, branch, dirty, ci, worktrees[]` |
| **Worktree** | `id, agentId, taskId?, branch, base, path, status(active/merged/abandoned), files, additions, deletions` |
| **MemoryEntry** | `id(shared/<slug> o <agente>/<slug>), scope(shared o agentId), title, body, author, updated` |
| **FeedItem** | `ts, kind(goal/plan/task/message/decision/merge/ci/memory/system/error/user), text, agentId?, to?` |
| **LogEntry** | `ts, kind(text/tool/result/error/diff), text` |

**Stati dei task e transizioni ammesse** (`TRANSITIONS` in `taskgraph.ts`):

```
todo    → doing, blocked, cancelled, done
doing   → review, blocked, todo, done, cancelled
review  → done, doing, blocked, todo, cancelled
blocked → todo, doing, cancelled, review
done    → todo            (retry)
cancelled → todo          (retry)
```

Regole: si entra in `doing` solo con un assegnatario e tutte le dipendenze `done`. Un task con
worktree diventa `done` **solo tramite merge approvato** (`viaMerge`). Le dipendenze vengono
validate (devono esistere, niente auto-dipendenze, niente cicli via DFS). Il progresso del goal è
una media pesata (done=1, review=0.75, doing=0.4, altri 0; i cancellati sono esclusi).

**Persistenza** (`store.ts`), sotto `<home>/<profile>/`:

```
state.json           agents, tasks, decisions, repos, goals, feed (≤300), messages (≤500),
                     counters (per gli id), sessions, worktreeMeta, permissionRules, backend (opaco)
logs/<agente>.jsonl  log append-only, rotazione a 8 MB (un file .1 conservato)
memory/shared/*.md   memoria condivisa: markdown con front-matter, modificabile a mano
memory/agents/<id>/*.md
worktrees/<repo>/<agente>-<task>/
foreman.json         pid/porta del Foreman attivo (lock di profilo: due istanze sono rifiutate)
```

`state.json` viene scritto **in modo atomico** (file temporaneo, `fsync`, `rename`), con debounce di
circa 100 ms e flush all'uscita. `sessions[<agente>:<task>]` e `sessions[lead:<goal>]` salvano
`sessionId`, `engine`, `model`, `turns`, `costUsd` e `lastResult`.

**Messaggi** (`bus.ts`): `{id, from, to(agentId/"user"/"all"), text, readBy[]}`. L'inbox di un agente
è l'insieme dei messaggi non letti indirizzati a lui o ad `all`. I messaggi non letti vengono
**appesi al risultato di ogni tool del team** (così arrivano a metà turno) e al prompt del turno
successivo. Un messaggio dell'utente arrivato dopo l'ultima tool call fa partire un follow-up a fine
turno (`deliverPending`).

## 4. Protocollo orchestratore ↔ UI

- Trasporto: WebSocket su `ws://127.0.0.1:<porta>`, un JSON per frame, ogni messaggio
  `{v:1, type, id?, ...payload}`.
- **Sicurezza del WS:** viene rifiutata qualunque richiesta con header `Origin` (compreso `null`) e
  qualunque `Host` che non sia loopback, per bloccare pagine web e DNS rebinding. La vista non manda
  `Origin`.
- **Handshake:** il client manda `hello`, il server risponde con uno `snapshot` completo (agents,
  tasks, decisions, repos, memory, goals, feed, coda dei log per agente, `foreman` status). Da quel
  momento arrivano solo upsert incrementali. In caso di riconnessione arriva un nuovo snapshot.
- **Server → client:** `snapshot`, `agent.upsert`, `agent.log`, `agent.say`, `task.upsert`,
  `decision.upsert`, `repo.upsert`, `memory.upsert`, `goal.upsert`, `feed.add`, `diff` (risposta a
  `diff.request`: file → hunk → righe `{kind:add/del/ctx, text, oldNo?, newNo?}`), `notify`,
  `foreman.status` (backend, auth, messaggio per il banner, costo), `ack {re, ok, error?, result?}`
  ed `error`.
- **Client → server:** `hello`, `goal.submit`, `user.message {to, text}`, `decision.answer
  {decisionId, option?, text?}`, `task.action {reassign/cancel/retry/prioritize}`, `agent.action
  {pause/resume/stop/spawn}`, `diff.request`, `repo.add`.
- Ogni messaggio client con `id` riceve un `ack`. Gli schemi zod validano l'input e, nei test, anche
  l'output. `docs/protocol.md` è **generato** dagli schemi e `npm run check` fallisce se non è
  allineato.
- La console (mod/TUI) interpreta i comandi lato client: testo libero = goal, `@nome msg`,
  `/answer`, `/diff`, `/pause`, `/task`, `/status`…

## 5. Sicurezza git

**Worktree per task.** `RepoManager` serializza le operazioni per repo (una coda per repo), rifiuta
cartelle che non sono la radice di un repository e conserva sempre i branch dopo merge o reject.

**Merge solo su approvazione** (`repos.doMerge`):

1. Si procede solo se la decisione è `kind=merge`, `answered`, `option === 'Merge'` e punta a
   quel worktree.
2. Il lavoro rimasto non committato nel worktree viene committato sul branch dell'agente.
3. Si rifiuta se il checkout che ha la base in uso ha modifiche tracciate non committate (`dirty`)
   o se `git merge-tree --write-tree` segnala un conflitto (codice 1, con la lista dei file).
4. Il commit di merge viene costruito **fuori dal working tree**: `merge-tree` + `commit-tree`,
   con l'identità git **dell'utente** (ha approvato lui) e firmato se la sua configurazione firma.
5. Applicazione: `git merge --ff-only <sha>` nel checkout, oppure `update-ref` se la base non è in
   uso in nessun checkout. Se qualcosa fallisce, il working tree dell'utente resta intatto.
6. Il worktree passa a `merged`, la cartella viene rimossa e il branch resta.

Esiste anche una variante `--merge-style squash`.

**Push bloccato a livello git** (`gitsafety.ts`). Ogni processo che un agente può influenzare (la
CLI dell'agente, i suoi comandi, la CI) riceve un ambiente con:

- `GIT_ALLOW_PROTOCOL=agentcraft-none` → nessun trasporto: push, fetch, clone e ls-remote falliscono;
- configurazione a livello di ambiente (`GIT_CONFIG_COUNT/KEY_n/VALUE_n`, che ha **precedenza** sia su
  `.git/config` sia sulla configurazione globale): `protocol.allow=never`,
  `url.<dead>.pushInsteadOf=""`, `commit.gpgsign=false`, `tag.gpgsign=false`, `gpg.*program=<inesistente>`;
- `GIT_CEILING_DIRECTORIES=<cartella padre del worktree>`: git non risale verso altri repository;
- vengono rimosse le variabili `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`… ereditate;
- `GIT_TERMINAL_PROMPT=0` e `GCM_INTERACTIVE=never`;
- l'identità dell'agente: `GIT_AUTHOR_NAME/EMAIL` e `GIT_COMMITTER_*` = `AgentCraft Kit <kit@agentcraft.local>`.

Le chiamate git del Foreman stesso **non** usano questo ambiente. Non è una sandbox: uno script può
rimuovere le variabili apposta, ma la policy nega i comandi che le nominano.

**Policy dei permessi** (`policy.ts`, circa 2150 righe, la parte più grossa). È una funzione pura
`classifyToolUse(tool, input, ctx)` che restituisce `allow`, `ask` con `ruleKeys[]` oppure `deny`:

- **allow:** letture e modifiche dentro il worktree, comandi di sviluppo sicuri (`npm test`, `git
  status/diff/add/commit/merge`, `ls`, `grep`…), `npx` di tool già installati, file temporanei;
- **ask:** tutto ciò che sta fuori dal worktree (path assoluti, `..`, `~`, variabili, redirezioni, `cd`
  fuori), rete (`curl`, `npm install`, `git fetch`), comandi distruttivi (`rm -r`, `git reset
  --hard`, `git clean`), git che tocca lo stato condiviso (`branch -D`, `tag`, `stash`, `config`),
  codice inline (`node -e`), binari sconosciuti;
- **deny:** `git push` in qualunque forma o travestimento, firma, modifica delle variabili di
  sicurezza, scritture del lead, subagent.

Al suo interno c'è un piccolo parser di shell (quoting, heredoc, sostituzioni `$(...)`, `cd`
virtuale, wrapper come `env`/`xargs`/`bash -c`/`eval`). "Always allow for this agent" salva solo le
chiavi con scope preciso (es. `Bash:outside:cat:r:<dir>`, `Bash:net:curl:<host>`,
`Bash:exact:<hash>`) in `permissionRules[agentId]`.

Il "gate" (`team.permissionGate`) applica la policy. Se il verdetto è `ask` crea una decisione
`permission` con le opzioni `Allow once` / `Always allow for this agent` / `Deny` e il testo di cosa
copre "Always", poi **attende** la risposta dell'utente prima di rispondere all'engine.

## 6. Come sono astratti i motori

```ts
interface Engine {
  id: 'claude' | 'codex'; label: string;
  model(role): string;
  checkAuth(): Promise<{ok:true, account} | {ok:false, message}>;
  runTurn(spec: TurnSpec): Promise<TurnStats>;   // UN turno = un processo
  authFailedMessage(detail): string;
}
TurnSpec = { agentId, role, cwd, prompt, instructions, resume?, env, writableRoots?,
             abort: AbortController, turn: TurnHandle,
             permission: PermissionGate,            // (toolName, input, signal) → allow/deny
             tools: AgentTool[],                    // tool del team, definiti con zod
             onProcess(child), onSession(id), onModel?(m) }
TurnStats = { sessionId?, resultText?, subtype?, isError, costUsd?, numTurns?, tokens?, authFailed?, errors[] }
```

- **Il modello è "a turni", non a sessione persistente.** Ogni job (plan, work, review, followup)
  corrisponde a una chiamata `runTurn`. La continuità viene da `resume: sessionId`, salvato per
  coppia (agente, task) o (lead, goal). Una sessione appartiene all'engine che l'ha creata.
- **Lo stream degli eventi non esce dall'engine:** ogni engine ha uno *StreamMapper* che traduce il
  proprio stream in chiamate al Foreman (`agentLog`, `setAgent` con stato e stazione). Il
  `PermissionGate` usa **il vocabolario dei tool Claude** (`Bash {command}`, `Edit {file_path}`) e
  gli altri engine vi mappano le proprie azioni, così la policy è una sola.
- **Tool del team** (`agents/tools.ts`), definiti una volta con zod: `send_message`, `ask_user`
  (bloccante), `write_memory`, `read_memory`, `update_task`, `report_status`, `list_tasks`, e per il
  lead anche `create_task` e `request_merge`. Se il turno viene abortito, i tool rifiutano di agire.

### Engine Claude (`agents/claude/`)

- Un `query()` del Claude Agent SDK per ogni turno, con:
  - `settingSources: []`: nessuna impostazione o MCP utente;
  - `permissionMode: 'default'` con **`canUseTool` → PermissionGate** (niente `allowedTools`: ogni
    chiamata passa dalla policy);
  - `tools` per ruolo (il lead non ha `Edit/Write`);
  - `disallowedTools: ['Bash(git push:*)', 'Task', 'Agent', 'WebSearch', 'WebFetch']`;
  - `mcpServers: { agentcraft: createSdkMcpServer(tools del team) }` (MCP in-process);
  - `systemPrompt: {type:'preset', preset:'claude_code', append: instructions}`;
  - `model`, `effort`, `maxTurns`, `maxBudgetUsd`, `resume`, `abortController`;
  - `spawnClaudeCodeProcess`: la CLI viene avviata in proprio per conoscerne il pid e poter
    terminare l'intero albero di processi quando il turno viene interrotto.
- **Autenticazione** (`auth.ts`): di default solo via API (`ANTHROPIC_API_KEY`, oppure
  `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY/ANTHROPIC_AWS`, oppure `ANTHROPIC_AUTH_TOKEN` +
  `ANTHROPIC_BASE_URL`). Il login claude.ai è **opt-in** (`--use-claude-login`), perché Anthropic non
  permette ai tool di terze parti di offrirlo. In modalità API viene rimossa
  `CLAUDE_CODE_OAUTH_TOKEN`; in modalità login vengono rimosse le chiavi API. Il controllo usa
  `query().accountInfo()` con un timeout di 45 s.
- Costo: `total_cost_usd` è cumulativo per sessione, quindi si accumula il delta e il totale viene
  ricostruito al riavvio sommando le sessioni.
- Default: lead `opus`, worker `sonnet`, effort `medium`, maxTurns 40 per il lead e 80 per i worker.

### Engine Codex (`agents/codex/`)

- Un processo **`codex app-server`** per turno, JSON-RPC 2.0 su stdio (un JSON per riga, senza il
  campo `"jsonrpc"`). Il thread Codex è durevole: il suo id fa da `sessionId` e il turno successivo
  usa `thread/resume`.
- Sequenza: `initialize` → `initialized` → `config/read` → `thread/start` (o `thread/resume`) →
  `thread/name/set` → `turn/start` → si attende la notifica `turn/completed`. Per interrompere si usa
  `turn/interrupt` e poi si chiude il processo.
- Opzioni del thread:
  - `approvalPolicy: 'untrusted'`: Codex chiede prima di ogni comando non banale;
  - `sandbox: 'read-only'` per il lead, `'workspace-write'` per i worker;
  - `developerInstructions` = istruzioni + note specifiche per Codex;
  - `dynamicTools` = i tool del team (schema JSON da zod);
  - `config` con gli override che **isolano dalla configurazione dell'utente**: tutti gli
    `mcp_servers` e i `plugins` trovati nella sua config vengono disattivati, insieme alle feature
    `apps`, `browser_use`, `computer_use`, `hooks`, `image_generation`, `memories`, `multi_agent`,
    `plugins`, `skill_*`; inoltre `web_search:'disabled'`, `notify:[]` e
    `sandbox_workspace_write:{writable_roots, network_access:false}`;
  - `shell_environment_policy.set` = le variabili git-safety, passate **esplicitamente** perché
    Codex filtra le variabili che sembrano segreti (`GIT_CONFIG_KEY_0`).
- Richieste dal server a cui il Foreman risponde:
  - `item/commandExecution/requestApproval`: si toglie il wrapper `powershell -Command` o `bash -lc`
    (`shellCommand`) e il comando interno passa al PermissionGate come `Bash`/`PowerShell`;
  - `item/fileChange/requestApproval`: ogni path passa al gate come `Edit`;
  - `item/tool/call`: esegue il tool del team corrispondente;
  - `item/tool/requestUserInput`: rifiutata, l'agente deve usare `ask_user`;
  - le richieste che arrivano da thread non avviati da AgentCraft vengono rifiutate.
- `writableRoots` di un worker: `objects/`, `refs/heads/<branch-dir>/` e i relativi reflog, la gitdir
  del worktree, la cartella temporanea. **Mai** l'intera `.git` condivisa, perché `config` e `hooks`
  permetterebbero di eseguire codice nel git dell'utente.
- Windows: il server usa un `LOCALAPPDATA` dedicato per aggirare un bug del sandbox Codex, e agli
  agenti viene detto di usare `npm.cmd`/`npx.cmd`.
- Autenticazione: `account/read` (ChatGPT o chiave API OpenAI tramite `codex login`). Il binario
  viene cercato tramite `--codex-path`, poi sul PATH, poi nell'app desktop Codex. Il costo è espresso
  in token, non in dollari.

### Team misti

`TeamEngines = { lead: Engine, worker: Engine, byAgent?: Record<agentId, Engine> }`, configurato con
`--lead-engine`, `--worker-engine` e `--engines kit=codex,...`. Il resto del team (scheduling, CI,
review, merge) non sa quale engine stia girando. Il nome del modello effettivo viene riportato con
`onModel` e finisce in `agent.model`, così la UI lo mostra sulla targhetta dell'agente.

### Backend sim

**Non è un Engine ma un Backend separato.** `SimDirector` offre primitive che agiscono sullo stato
reale (worktree veri, modifiche vere ai file, `npm test` vero, decisioni e merge veri), e
`scenario.ts` è una sceneggiatura deterministica di 22 "beat" su un repo demo. Le risposte
dell'utente cambiano l'esito. Il progresso viene salvato per beat, così al riavvio lo scenario
riprende da dove era rimasto. PRNG con seed per la riproducibilità.

## 7. Ripresa dopo riavvio o crash

- `inflight[agentId] = {kind, sessionKey, taskId?, goalId?}` viene salvato all'inizio di ogni turno.
  All'avvio (`team.recover`):
  - i job interrotti vengono **ripresi con la stessa sessione e lo stesso tipo di job**, così ciò che
    deve succedere dopo il turno avviene comunque;
  - le decisioni `permission` aperte vengono annullate (il processo che le aveva chieste è morto e
    l'agente riproverà);
  - le `question` aperte restano aperte e la risposta riprende la sessione;
  - riconciliazione: un goal `planning` senza nessuno che lo pianifica viene ripianificato, un task
    `doing` senza turno torna sulla board, un task in `review` senza decisione rifà CI e review.
- Le decisioni hanno waiter solo in memoria: dopo un riavvio la risposta passa per
  `onDecisionSettled` e riprende la sessione.

## 8. Altri aspetti utili

- **Controllo degli agenti:** `pause` interrompe il turno e mantiene il task; `stop` manda l'agente
  "fuori turno" (ritira le sue domande e rimette i task sulla board); `spawn` lo riporta in servizio.
  Nel **passaggio di consegne** il nuovo worker riparte dal branch del precedente, dopo che i
  processi del vecchio turno sono terminati davvero.
- **Terminazione dei processi:** snapshot dell'albero al momento dell'abort; un pid viene ucciso
  solo se il suo tempo di creazione corrisponde ancora.
- Timeout per turno, scheduler con backoff 2–60 s in caso di errori di avvio, notifiche desktop
  quando serve una decisione.
- `tools/`: launcher PowerShell, `foremancli.mjs` e una TUI (`npm run tui`) che si connette
  esattamente come la vista: utile anche a noi per i test end-to-end senza UI.
- Test: circa 480 test vitest con SDK finto (`claude-*.test.ts`) e un **finto Codex app-server**
  (`test/fixtures/fake-codex.mjs`). Ottimo modello da seguire.

---

## 9. Implicazioni per Keystone

| Tema | AgentCraft | Proposta Keystone |
|---|---|---|
| Interfaccia motore | `runTurn(spec) → TurnStats` con callback e mapper interni | La spec chiede un `EngineAdapter` con avvio, ripresa, invio messaggio e **stream di eventi**. Propongo `runTurn(spec): AsyncIterable<EngineEvent>`, con eventi tipizzati `text`, `tool_call`, `tool_result`, `file_change`, `permission_request`, `usage`, `turn_end`, e permessi e tool del team come callback nella spec. In questo modo il team traduce gli eventi in log/stato in un punto solo, invece di avere un mapper per ogni engine. |
| Sim | Backend a sé con sceneggiatura e director | **Sim come EngineAdapter** (come richiesto): un motore scriptato che produce eventi e fa vere modifiche git nel worktree. Vantaggio: il codice del team (scheduling, CI, review, merge) viene esercitato anche senza API. |
| Vista | Mod Java | Electron + React; il protocollo è lo stesso concetto (snapshot + upsert, ack). Il renderer Electron è un browser e manderebbe `Origin`: la connessione WS va fatta dal **main process** (Node, nessun Origin) e inoltrata al renderer via IPC/preload, così il controllo anti-browser resta attivo. |
| Nomi | `agentcraft/<agente>/<task>`, `AgentCraft <Nome>`, `~/.agentcraft` | `Keystone/<agente>/<task>`, `Keystone <Nome>`, `~/.keystone/config.json` |
| Policy | Circa 2150 righe di parser shell | Partirei da una versione più compatta ma con lo stesso principio: **nel dubbio si chiede**. Allow solo per whitelist nel worktree, deny assoluto su push e firma, e chiavi "Always" con scope preciso. Il push resta comunque bloccato dall'ambiente git anche se la policy sbaglia. |
| Protocollo | zod + documentazione generata e verificata in CI | Stessa cosa: schemi zod condivisi tra orchestratore e app (pacchetto `shared/` o import diretto) e `docs/protocol.md` generato. |
| Persistenza | `state.json` atomico + JSONL + markdown | Stessa cosa. |

Rischi da tenere d'occhio:

- **Windows:** worktree "occupati" da processi ancora vivi (servono retry nella rimozione), wrapper
  `powershell -Command` di Codex, `npm.cmd`.
- **Codex app-server:** il protocollo JSON-RPC è sperimentale (`experimentalApi: true`) e i nomi di
  metodi e feature cambiano tra versioni. Andrà verificato sulla versione installata in Fase 6.
- **Agent SDK:** le opzioni (`spawnClaudeCodeProcess`, `effort`, `settingSources`) vanno verificate
  sulla versione corrente in Fase 5.
