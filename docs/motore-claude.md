# Motore Claude

Adattatore basato sul **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, versione fissata
**0.3.302**, pubblicata il 16 ottobre 2026). Codice: `orchestrator/src/engines/claude/`.

## Avvio

```powershell
setx ANTHROPIC_API_KEY sk-ant-...        # poi apri un terminale nuovo
npm run orchestrator -- --engine claude --repo C:\percorso\repo --budget 2
```

| Opzione | Default | |
|---|---|---|
| `--engine claude` | `sim` | motore degli agenti |
| `--lead-model <id>` | `claude-opus-5-5` (Claude Opus 5.5) | modello del lead |
| `--worker-model <id>` | `claude-sonnet-5-5` (Claude Sonnet 5.5) | modello dei worker |
| `--effort low…max` | worker `medium`, lead `high` | Opus 5.5 ha `medium` come default dell'API: lo si dichiara sempre |
| `--budget <dollari>` | `5` (`KEYSTONE_BUDGET_USD`) | tetto di spesa per obiettivo; `0` = nessun tetto |
| `--use-claude-login` | disattivato | login personale di Claude Code, solo per uso personale |
| `--record <cartella>` | — | registra le trascrizioni dei turni (per i test di replay) |

Gli identificativi dei modelli sono quelli della documentazione aggiornata (6 ottobre 2026):
`claude-opus-5-5` e `claude-sonnet-5-5`, esatti, senza suffissi di data. Nell'interfaccia compaiono
come "Opus 5.5" e "Sonnet 5.5" accanto a ogni agente.

## Autenticazione

- **Predefinita: API.** `ANTHROPIC_API_KEY`, oppure un provider cloud supportato dall'SDK con le sue
  credenziali:
  - `CLAUDE_CODE_USE_BEDROCK=1` (Amazon Bedrock);
  - `CLAUDE_CODE_USE_VERTEX=1` (Google Vertex AI);
  - `CLAUDE_CODE_USE_FOUNDRY=1` (Microsoft Foundry);
  - `CLAUDE_CODE_USE_ANTHROPIC_AWS=1` (Claude Platform on AWS);
  - oppure un gateway con `ANTHROPIC_AUTH_TOKEN` e `ANTHROPIC_BASE_URL`.
- Senza credenziali, la barra di stato lo dice chiaramente e nessun turno parte. Il motore sim
  funziona comunque.
- **Il login personale di Claude Code è disattivato di default.** Anthropic non consente agli
  strumenti di terze parti di offrire il login claude.ai. Con `--use-claude-login` lo si usa per sé:
  in quel caso le chiavi API non vengono passate alla CLI. In modalità API, invece, il token di
  login (`CLAUDE_CODE_OAUTH_TOKEN`) non viene passato.

## Ogni tool passa dalla policy di Keystone

- Un hook **PreToolUse senza filtro** intercetta ogni chiamata a un tool, comprese le letture e i
  tool del team. Chiede all'orchestratore e aspetta la risposta: la policy decide, oppure chiede a
  te. `canUseTool` fa lo stesso, come seconda barriera.
- `permissionMode` è sempre `'default'`. Se non lo si passa, l'SDK può partire in modalità `auto`,
  in cui è un classificatore ad approvare le chiamate. Non esiste una modalità che salti i permessi,
  nemmeno come opzione: `assertNoPermissionBypass()` rifiuta `bypassPermissions`, `acceptEdits`,
  `auto`, `dontAsk`, `plan`, `allowDangerouslySkipPermissions`, `allowedTools` e un hook limitato a
  certi tool. I test lo verificano, e un altro test controlla che il sorgente non contenga queste
  opzioni.
- Tool disponibili:
  - lead: `Read`, `Grep`, `Glob`, `Bash` (in sola lettura per la policy);
  - worker: anche `Edit`, `Write`, `TodoWrite`;
  - tutti: i tool del team (`mcp__keystone__…`);
  - sempre esclusi: sub-agenti, web, skill e gli altri tool di servizio della CLI.
- I tool del team sono consentiti dalla policy perché sono codice di Keystone. Qualunque altro
  server MCP viene negato.

## Nessuna configurazione dell'utente di Claude Code

- `CLAUDE_CONFIG_DIR` punta a `~/.keystone/claude-config`. La CLI non legge `~/.claude`: niente
  impostazioni, hook, comandi, agenti, skill, `CLAUDE.md` globale né server MCP di `~/.claude.json`.
- In più: `settingSources: []` (nessuna impostazione da file, nemmeno quelle del repository),
  `strictMcpConfig: true` (solo il server MCP di Keystone), `skills: []`, nessun plugin.
- Il **test di isolamento** (`orchestrator/test/claude-isolation.test.ts`) gira sulla CLI vera,
  senza rete:
  - prepara una home finta con impostazioni (hook e `defaultMode: bypassPermissions`), un comando,
    una skill, un `CLAUDE.md` e un server MCP, più un comando di progetto nel repository;
  - verifica che con le opzioni di Keystone la CLI non veda nulla di tutto ciò e che l'hook non
    parta;
  - come controprova, verifica che la stessa CLI senza isolamento veda comando e server MCP
    dell'utente.
- Eccezione: con `--use-claude-login` la cartella di configurazione resta quella dell'utente,
  perché lì stanno le credenziali. Restano comunque `settingSources: []`, `strictMcpConfig`,
  `skills: []` e la policy.

## Tetto di spesa per obiettivo

- Ogni obiettivo ha un tetto, configurabile con `--budget`, `KEYSTONE_BUDGET_USD`, nel comando
  `goal.submit` o dal tabellone con "tetto …". La barra di stato mostra la spesa dell'obiettivo
  rispetto al tetto.
- La CLI riceve come `maxBudgetUsd` la spesa residua dell'obiettivo, quindi si ferma da sola al
  tetto anche a metà turno.
- Raggiunto il tetto:
  - l'obiettivo passa in **pausa** e i turni dei suoi agenti vengono fermati;
  - il lavoro resta salvato: i file sono sul branch dell'agente e la sessione viene conservata per
    riprenderla;
  - arriva una decisione: **Aumenta il tetto** (scrivendo l'importo; senza importo il tetto
    raddoppia) oppure **Lascia in pausa**;
  - alzando il tetto i turni riprendono con la stessa sessione. La pausa sopravvive anche ai
    riavvii.
- Costi: si usa `total_cost_usd` riportato dalla CLI, cumulativo per sessione, e si somma solo
  l'incremento rispetto al valore già registrato.

## Test senza consumare API: trascrizioni registrate

- I test (`orchestrator/test/claude-engine.test.ts`) riproducono trascrizioni di turni
  (`orchestrator/test/fixtures/claude/*.jsonl`). Il formato è lo stesso che scrive l'adattatore con
  `--record`: messaggi dello stream dell'SDK e richieste di permesso.
- Durante il replay gli hook passano **davvero** dalla policy (anche le richieste a te) e i tool del
  team vengono eseguiti davvero sull'orchestratore. Se un tool viene negato, il suo risultato
  registrato è sostituito da un errore, come farebbe la CLI.
- Le trascrizioni attuali sono costruite a mano sul formato dell'SDK. Durante la prima prova reale
  registreremo trascrizioni vere con `--record` e le aggiungeremo ai test.

## Prima prova con il motore reale (da fare insieme)

Su un repository di prova e con un tetto basso:

```powershell
npm run orchestrator -- --demo --engine claude --budget 1 --workers 1 --record .\trascrizioni
npm run app
```

Obiettivo suggerito: qualcosa di piccolo, per esempio "Aggiungi una funzione saluta_en con un test".
Verificheremo insieme:

- le richieste di permesso;
- il log live;
- la spesa rispetto al tetto;
- la review e il merge;
- le trascrizioni registrate.
