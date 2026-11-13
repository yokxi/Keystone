# Configurazione: `~/.keystone/config.json`

Le impostazioni che si passano da riga di comando si possono scrivere una volta per tutte in
`config.json`, nella radice dello stato di Keystone (`~/.keystone`, oppure `KEYSTONE_HOME` o
`--home`). Il file vale per tutti i profili e anche quando l'orchestratore lo avvia l'app.

## Precedenza

valori predefiniti < `config.json` < variabili d'ambiente (`KEYSTONE_PORT`,
`KEYSTONE_BUDGET_USD`) < opzioni da riga di comando.

Un'impostazione generale di uno strato più alto sostituisce anche quelle più specifiche degli strati
sotto: `--engine sim` vale per tutti anche se il file ha `leadEngine` o `agents.bruno.engine`;
`--effort low` sostituisce `leadEffort` e gli `effort` dei singoli agenti del file; `--lead-model`
e `--worker-model` sostituiscono il `model` degli agenti di quel ruolo. Dentro lo stesso strato vale
la più specifica: nel file, `agents.bruno.engine` batte `workerEngine`, che batte `engine`.

- `--config <file>` usa un altro file al posto di `~/.keystone/config.json`.
- `--no-config` lo ignora (anche se c'è `--config`).
- `--show-config` mostra cosa vale (file usato, impostazioni unite, agenti con motore, modello ed
  effort, tetto e limiti) ed esce senza avviare nulla.

## Esempio

```json
{
  "engine": "claude",
  "workers": 3,
  "leadModel": "claude-opus-5-5",
  "workerModel": "claude-sonnet-5-5",
  "effort": "medium",
  "leadEffort": "high",
  "agents": {
    "chiara": { "engine": "codex", "model": "gpt-5.5", "effort": "high" }
  },
  "budgetUsd": 5,
  "goalTurns": 30,
  "goalMinutes": 60,
  "userName": "Aurora"
}
```

## Le chiavi

Tutte facoltative. Corrispondono alle opzioni da riga di comando indicate.

| Chiave | Valori | Opzione |
|---|---|---|
| `engine` | `sim`, `claude`, `codex` (motore di tutti) | `--engine` |
| `leadEngine`, `workerEngine` | come sopra, per un team misto | `--lead-engine`, `--worker-engine` |
| `workers` | da 1 a 5 | `--workers` |
| `leadModel`, `workerModel` | id del modello, per il motore del ruolo | `--lead-model`, `--worker-model` |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` (tutti) | `--effort` |
| `leadEffort` | come sopra, solo per il lead | — |
| `agents` | per singolo agente (`ada`, `bruno`, `chiara`, `dario`, `elena`, `fabio`): `engine`, `model`, `effort` | — |
| `budgetUsd` | tetto di spesa per obiettivo in dollari, 0 = nessuno | `--budget` |
| `goalTurns`, `goalMinutes` | limiti per obiettivo, 0 = nessuno | `--goal-turns`, `--goal-minutes` |
| `port` | porta su 127.0.0.1 | `--port` |
| `simDelayMs` | pausa tra i passi del motore sim | `--sim-delay` |
| `keepBranches` | `true`: conserva il branch dell'agente dopo il merge | `--keep-branches` |
| `mergePerTask` | `true`: una decisione di merge per ogni task, invece di una per obiettivo (Fase 11) | — |
| `userName` | il tuo nome per gli agenti (una riga; la pagina Impostazioni ha la precedenza) | `--user-name` |
| `useClaudeLogin`, `useCodexLogin` | `true`: login personale al posto della chiave API (solo uso personale) | `--use-claude-login`, `--use-codex-login` |
| `codexPrices` | `{ "input": …, "cached": …, "output": … }` in dollari per milione di token | `--codex-prices` |

Le impostazioni di un agente in `agents` valgono prima di quelle del ruolo. `leadModel` e
`workerModel` valgono per il motore del ruolo (`leadEngine` / `workerEngine`): un agente spostato
su un altro motore con `agents` prende il modello predefinito di quel motore, se non ne indichi uno.
Per dare un modello a un singolo agente spostato su un altro motore si usa `agents.<id>.model`.
Un agente oltre il numero di `workers` viene ignorato, e l'avvio lo segnala. `workers` fuori da
1-5 è un errore, anche da riga di comando (prima `--workers 9` veniva ridotto a 5 in silenzio).
`useClaudeLogin` e `useCodexLogin` scritti nel file vengono segnalati con un avviso a ogni avvio.

## Regole

- **Schema rigido.** Una chiave sconosciuta (anche un errore di battitura), un valore fuori dai
  limiti o un JSON non valido fermano l'avvio con l'errore: Keystone non torna in silenzio ai valori
  predefiniti. Il file può iniziare con il BOM; i commenti non sono ammessi (è JSON).
- **Niente segreti.** Il file non ha campi per chiavi API o token: le chiavi si salvano solo con
  `safeStorage` (vedi `docs/sicurezza.md`). Una chiave come `apiKey` è sconosciuta e ferma l'avvio.
- **Solo da riga di comando**: `--codex-path` (il binario di Codex), `--ci` (il comando dei test) e
  `--record` (la cartella delle trascrizioni). Decidono cosa viene eseguito o dove finiscono dati
  sensibili, quindi non stanno in un file che resta sul disco tra un avvio e l'altro. Restano solo
  da riga di comando anche `--home`, `--profile`, `--reset`, `--demo`, `--repo`, `--goal`,
  `--confirm-guard` e i comandi di manutenzione.
- **File normale.** Un link simbolico, una junction, una cartella o un file più grande di 64 KB non
  vengono letti.
- **Protetto per gli agenti.** `~/.keystone/config.json` (e il file indicato con `--config`) sono
  percorsi protetti nella policy: scriverci o cancellarli è negato, non chiesto. Il limite è quello
  di sempre: la policy non vede dentro gli script (`docs/sicurezza.md` §5). Il file si legge solo
  all'avvio, e il log di avvio dice da dove viene la configurazione e quali chiavi imposta.
