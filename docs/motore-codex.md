# Motore Codex

Adattatore per **`codex app-server`** (JSON-RPC su stdio) del pacchetto `@openai/codex`, versione
fissata **0.163.0** (pubblicata il 15 ottobre 2026). Codice: `orchestrator/src/engines/codex/`.

Il protocollo è sperimentale e cambia tra versioni. Metodi, parametri e funzioni sono stati
verificati sulla CLI installata: tipi generati con `codex app-server generate-ts` e sonde sul
binario vero. Cambiando versione vanno riverificati, e i test sulla CLI vera servono a questo.

## Avvio

```powershell
# terminale 1: la chiave vale solo per questo terminale
$env:OPENAI_API_KEY = "sk-..."
npm run orchestrator -- --demo --reset --engine codex --workers 1

# team misto: lead Claude, worker Codex
npm run orchestrator -- --demo --lead-engine claude --worker-engine codex --workers 2
```

| Opzione | Default | |
|---|---|---|
| `--engine codex` | `sim` | motore di tutti gli agenti |
| `--lead-engine`, `--worker-engine` | il valore di `--engine` | team misto (sim, claude, codex) |
| `--lead-model`, `--worker-model` | il modello predefinito di Codex | valgono per il motore di quel ruolo |
| `--effort low…max` | worker `medium`, lead `high` | `max` diventa `xhigh` |
| `--use-codex-login` | disattivato | login ChatGPT, solo per uso personale |
| `--codex-path <file>` | il binario del pacchetto | un altro binario `codex` |
| `--goal-turns`, `--goal-minutes` | 30 e 60 | il freno per obiettivo (vedi sotto) |

Il modello predefinito è quello di Codex: Keystone non scrive nomi di modello nel codice e mostra
quello che Codex riporta all'avvio del thread.

## Un turno

Un processo `codex app-server` per turno, con questa sequenza:

1. `initialize` (con `experimentalApi`), poi la notifica `initialized`.
2. `account/read`, ed eventualmente `account/login/start`.
3. Le skill trovate vengono disattivate con `skills/list` e `skills/config/write`.
4. `thread/start`, oppure `thread/resume` con l'id del thread salvato.
5. `turn/start`, poi si attende `turn/completed`.

Per interrompere: `turn/interrupt`, poi il processo viene chiuso.

## Autenticazione

- **Predefinita: chiave API OpenAI.** `OPENAI_API_KEY` (o `CODEX_API_KEY`) nel terminale
  dell'orchestratore.
  - Keystone la passa a Codex con `account/login/start`. Codex non la legge dall'ambiente: è stato
    verificato.
  - Codex la salva in `auth.json` dentro `~/.keystone/codex-home`, mai in `~/.codex`.
  - Il processo di Codex non riceve la chiave nell'ambiente, e i comandi degli agenti non la vedono.
- **Login ChatGPT** (`--use-codex-login`, solo uso personale). Si fa una volta, nella cartella di
  Keystone, e Keystone non legge mai `~/.codex`:

  ```powershell
  $env:CODEX_HOME = "$env:USERPROFILE\.keystone\codex-home"; npx codex login
  ```

## Nessuna configurazione dell'utente

- `CODEX_HOME` punta a `~/.keystone/codex-home`, anche se nell'ambiente c'è quella dell'utente.
  Codex quindi non legge `~/.codex`: niente `config.toml`, server MCP, `AGENTS.md` globale, skill,
  plugin o login.
- Ogni thread ha in più questa configurazione:
  - `mcp_servers: {}`;
  - `project_doc_max_bytes: 0`, così non legge nemmeno l'`AGENTS.md` del repository;
  - `web_search: "disabled"`;
  - `notify: []`;
  - `allow_login_shell: false`, che evita di caricare il profilo di PowerShell o bash dell'utente.
- Funzioni di Codex attive di default e spente da Keystone (`DISABLED_FEATURES`):
  - `guardian_approval`: le approvazioni non vanno a un revisore automatico;
  - `view_image`, `multi_agent`, `browser_use`, `computer_use`, `image_generation`,
    `code_mode_host`, `goals`, `worktrees`, `workspace_dependencies`;
  - `hooks`, `plugins`, `apps`, `tool_suggest`, `skill_search`, `memories`;
  - `shell_snapshot`, che importerebbe l'ambiente del profilo;
  - `daemon_auto_start`.
- **Verifica sulla CLI vera** (`orchestrator/test/codex-real.test.ts`), senza rete. Si prepara un
  `~/.codex` finto con modello, `approval_policy = "never"`, `sandbox_mode = "danger-full-access"`,
  un server MCP e un `AGENTS.md`, più un `AGENTS.md` nel repository. Con Keystone:
  - al modello non arriva nulla di tutto ciò, né la skill di sistema `imagegen`;
  - il comando chiede comunque l'approvazione;
  - nella home dell'utente non viene scritto nulla.

  La controprova, con la stessa CLI senza isolamento, vede modello, istruzioni e server MCP
  dell'utente.

## Ogni azione passa dalla policy di Keystone

- `approvalPolicy: "untrusted"`. Verificato con un turno vero: anche i comandi di sola lettura
  (`Get-Content`, `ls`, `git status`) inviano la richiesta di approvazione.
- Le richieste di Codex diventano permessi di Keystone, con il vocabolario dei tool Claude:

  | Richiesta di Codex | Per la policy |
  |---|---|
  | `item/commandExecution/requestApproval` | `Bash`/`PowerShell {command}`, con il comando **interno** (senza l'involucro `powershell -Command` o `bash -lc`; con `cd` se la cartella è un'altra) |
  | `item/fileChange/requestApproval` | `Edit {file_path}` per ogni file, più la cartella in più che Codex chiede, se c'è |
  | `item/tool/call` (tool del team) | `mcp__keystone__<tool>`, poi il tool gira sull'orchestratore |
  | `item/tool/requestUserInput` | rifiutata: l'agente deve usare `ask_user` |
  | `item/permissions/requestApproval`, elicitazioni MCP, attestazioni, rinnovo dei token, ogni altra richiesta | rifiutate |
  | richieste di un thread non avviato da Keystone | rifiutate |

- Un diniego torna a Codex come `decline`: il modello riceve "rejected", non il contenuto.
- Al modello arrivano solo `exec_command` e i tool del team. Il test verifica che non ci siano
  `view_image`, sub-agenti, obiettivi, ricerca web, generazione di immagini e browser.

## Sandbox di Codex (seconda barriera)

- Il lead lavora in `read-only`.
- Il worker lavora in `workspace-write` senza rete. Le cartelle scrivibili oltre al worktree sono
  quelle che servono a committare: `objects/`, `refs/heads/Keystone/<agente>/` e il suo reflog, la
  gitdir del worktree. **Mai** l'intera `.git` condivisa (`config` e `hooks`).
- **Windows:** `workspace-write` richiede `windows.sandbox = "unelevated"`. Senza, Codex ripiega
  in silenzio sulla sola lettura: è stato verificato. Keystone lo imposta, e se Codex non attiva la
  scrittura il turno del worker non parte.
- **Windows, limite della sandbox non elevata:** non può rendere scrivibile una sottocartella di
  una zona in sola lettura. Con i worktree di Keystone va bene, perché la `.git` condivisa sta fuori
  dalla cartella del task. Il test lo verifica con un commit vero dentro la sandbox.
- L'ambiente dei comandi è `shell_environment_policy.inherit = "core"`, più le sole variabili di
  sicurezza git di Keystone (`GIT_*`, `KEYSTONE_*`). Vanno passate esplicitamente, perché Codex
  filtra quelle che sembrano segreti, come `GIT_CONFIG_KEY_0`. La chiave API non c'è: verificato.

## Spesa e limiti

- Codex riporta **token, non dollari**. L'interfaccia lo dice ("Codex: solo token"): il consumo di
  Codex non è compreso nella cifra in dollari.
- Il tetto in dollari quindi non frena Codex. Con Codex ogni obiettivo ha un limite di **30 turni**
  e **60 minuti di lavoro** (`--goal-turns`, `--goal-minutes`, `0` = nessun limite). Con un team
  tutto Codex il tetto in dollari è disattivato, salvo `--budget` esplicito.
- Token: `thread/tokenUsage/updated` porta il totale del thread, compresi i turni precedenti, e
  l'ultima richiesta. Si conta solo l'incremento dall'inizio del turno, verificato con il modello
  locale.

## Test

- `orchestrator/test/codex-engine.test.ts`: traduzione del protocollo con un app-server finto
  (`fixtures/codex/fake-app-server.mjs`), con gli stessi nomi di metodo della 0.163.0. Copre
  handshake e login, inoltro dei permessi, dinieghi, ripresa, interruzione, conteggio dei token, e
  un team lead e worker Codex.
- `orchestrator/test/codex-real.test.ts`: **CLI vera**, con un modello locale che parla la Responses
  API (`codex-mock-model.ts`) e un proxy inesistente per tutto il resto. Copre i comandi che
  passano dalla policy, i tool offerti al modello, l'ambiente dei comandi, il commit nella sandbox
  e l'isolamento con controprova. Nessuna chiave, nessuna rete.

## Limiti noti

- Il protocollo `app-server` è sperimentale: ogni aggiornamento di `@openai/codex` va accompagnato
  dai test sulla CLI vera.
- La prova con un modello vero (chiave API o login ChatGPT) non è ancora stata fatta.
- Solo Windows x64 è stato verificato. Gli altri sistemi usano lo stesso codice, ma la sandbox di
  Codex funziona diversamente.
