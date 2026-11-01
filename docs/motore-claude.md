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
  strumenti di terze parti di offrire il login claude.ai. Con `--use-claude-login` lo si usa per sé,
  con il proprio abbonamento:
  - la credenziale è solo il token di `claude setup-token` (serve un abbonamento), passato come
    `CLAUDE_CODE_OAUTH_TOKEN` nel terminale dell'orchestratore. Senza token nessun turno parte e la
    barra di stato spiega come ottenerlo;
  - la CLI **non legge `~/.claude`**: resta nella cartella isolata come in modalità API. Il file
    `~/.claude/.credentials.json` non viene né letto né copiato, perché la CLI rinnova i token e una
    copia potrebbe invalidare il tuo login di Claude Code;
  - le chiavi API non vengono passate alla CLI. In modalità API, invece, il token di login non
    viene passato.
- **Le credenziali restano alla CLI.** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` le toglie dall'ambiente
  dei sottoprocessi: i comandi Bash degli agenti, i server MCP stdio e gli hook non vedono né la
  chiave API né il token. Il test di isolamento lo verifica con un sottoprocesso sonda.
- **Spesa con l'abbonamento.** `total_cost_usd` è una stima di quanto costerebbe via API: con il
  piano non si paga a consumo. L'interfaccia la mostra come "stima … · abbonamento" e, di default,
  non c'è un tetto in dollari: i turni non si fermano per la spesa stimata. Con `--budget <n>`
  esplicito il tetto si applica alla stima, come freno. I limiti di utilizzo del piano restano
  quelli dell'abbonamento: se si raggiungono, il turno finisce in errore.

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
- Vale anche con `--use-claude-login`: stessa cartella isolata, credenziale solo dal token. Il test
  di isolamento ha un caso apposta, con un finto `~/.claude/.credentials.json` nella home, e
  verifica anche che il file non venga copiato.

## Tetto di spesa per obiettivo

- Ogni obiettivo ha un tetto, configurabile con `--budget`, `KEYSTONE_BUDGET_USD`, nel comando
  `goal.submit` o dal tabellone con "tetto …". La barra di stato mostra la spesa dell'obiettivo
  rispetto al tetto.
- **Quote per turno.** Ogni turno parte con una quota riservata, che la CLI riceve come
  `maxBudgetUsd` e non supera (si ferma da sola anche a metà turno):
  - la quota è al massimo una fetta del tetto: tetto / posti, dove i posti sono il lead più i
    worker che possono lavorare insieme, con un minimo di $0.25;
  - e mai più del residuo dell'obiettivo meno le quote dei turni in corso dello stesso obiettivo;
  - se quello che resta non basta (meno del minimo), il turno **aspetta** in coda e parte quando
    un altro turno finisce e libera la sua quota. L'agente lo mostra ("aspetta: la spesa residua è
    riservata ad altri turni").
- Un turno che esaurisce la sua quota, ma non il tetto dell'obiettivo, non è un errore: riprende
  la stessa sessione appena c'è spesa disponibile.
- **Sforamento massimo.** La CLI si ferma *dopo* aver superato la quota, quindi l'ultima chiamata
  al modello di ogni turno può andare oltre. Con turni in parallelo la spesa dell'obiettivo resta
  entro il tetto più una chiamata per turno in corso. L'unico limite rigido è il limite di spesa
  del workspace nella Console Anthropic.
- Raggiunto il tetto:
  - l'obiettivo passa in **pausa** e i turni dei suoi agenti vengono fermati;
  - il lavoro resta salvato: i file sono sul branch dell'agente e la sessione viene conservata per
    riprenderla;
  - arriva una decisione: **Aumenta il tetto** (scrivendo l'importo; senza importo il tetto
    raddoppia) oppure **Lascia in pausa**;
  - alzando il tetto i turni riprendono con la stessa sessione. La pausa sopravvive anche ai
    riavvii.
- **Costi.** Si usa `total_cost_usd` riportato dalla CLI. In una sessione ripresa la CLI riparte
  dal totale salvato nella trascrizione *quando c'è*: allora conta solo l'incremento; se non lo
  ritrova, `total_cost_usd` è solo la spesa del turno. Keystone salva l'ultimo totale della CLI per
  ogni sessione (`engineTotalUsd`) e distingue i due casi così:
  - totale minore del precedente: certamente non ritrovato, si conta tutto;
  - altrimenti si confrontano i token visti nel turno con quelli di `modelUsage`, che segue lo
    stesso ciclo di vita del totale. Molti di più: ritrovato, si conta l'incremento. Quasi uguali:
    non ritrovato, si conta tutto;
  - se non si può dire (niente `modelUsage`, una compattazione nel turno, valori a metà strada) si
    conta in modo **prudente**: tutta la spesa, e la parte forse già contata resta segnata come
    "prudenziale" sull'obiettivo (`costUnreconciledUsd`, visibile accanto alla spesa) finché non
    viene riconciliata. Mai di meno.

## Test senza consumare API: trascrizioni registrate

- I test (`orchestrator/test/claude-engine.test.ts`) riproducono trascrizioni di turni
  (`orchestrator/test/fixtures/claude/*.jsonl`). Il formato è lo stesso che scrive l'adattatore con
  `--record`: messaggi dello stream dell'SDK e richieste di permesso.
- Durante il replay gli hook passano **davvero** dalla policy (anche le richieste a te) e i tool del
  team vengono eseguiti davvero sull'orchestratore. Se un tool viene negato, il suo risultato
  registrato è sostituito da un errore, come farebbe la CLI.
- Le trascrizioni attuali sono costruite a mano sul formato dell'SDK. Quelle vere, registrate con
  `--record`, vanno pulite prima di entrare nel repository:

  ```powershell
  npx tsx orchestrator/scripts/sanitize-transcripts.ts "$env:USERPROFILE\.keystone\trascrizioni-prova"          # anteprima
  npx tsx orchestrator/scripts/sanitize-transcripts.ts "$env:USERPROFILE\.keystone\trascrizioni-prova" --write  # copia in fixtures/claude/real
  ```

  Lo script sostituisce home e nome utente con `<HOME>` e `<USER>` e rifiuta di copiare se resta
  qualcosa che sembra un segreto. Il test `fixtures-secrets.test.ts` fallisce se una trascrizione
  contiene chiavi, token, intestazioni di autenticazione, variabili di credenziali, un dump
  dell'ambiente, percorsi della home o il nome utente.

## Prima prova con il motore reale (da fare insieme)

Su un repository di prova e con un tetto basso:

```powershell
# terminale 1: la chiave vale solo per questo terminale
$env:ANTHROPIC_API_KEY = "sk-ant-..."
npm run orchestrator -- --demo --reset --engine claude --budget 1 --workers 1 --record "$env:USERPROFILE\.keystone\trascrizioni-prova"

# terminale 2
$env:KEYSTONE_PROFILE = "demo"
npm run app
```

`--reset` evita che l'orchestratore riprenda con Claude obiettivi lasciati dal motore sim nel
profilo `demo`. L'app usa il profilo di `KEYSTONE_PROFILE` (default `default`). Se
l'orchestratore collegato ne usa un altro, l'app lo segnala. Il pulsante "Avvia orchestratore"
avvia il motore sim con il profilo dell'app, oppure con uno scelto tra quelli esistenti.

### Con il login personale (abbonamento)

```powershell
# una volta: genera il token (apre il browser per il login; serve un abbonamento Claude)
claude setup-token

# terminale 1: il token vale solo per questo terminale
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
$env:CLAUDE_CODE_OAUTH_TOKEN = "<token di setup-token>"
npm run orchestrator -- --demo --reset --engine claude --use-claude-login --lead-model claude-sonnet-5-5 --workers 1 --record "$env:USERPROFILE\.keystone\trascrizioni-prova"

# terminale 2
$env:KEYSTONE_PROFILE = "demo"
npm run app
```

Senza `--budget` non c'è tetto: la spesa è una stima. Il confronto con la Console si fa solo con una
chiave API.

Obiettivo suggerito: qualcosa di piccolo, per esempio "Aggiungi una funzione saluta_en con un test".
Verificheremo insieme:

- le richieste di permesso;
- il log live;
- la spesa rispetto al tetto;
- la review e il merge;
- le trascrizioni registrate.
