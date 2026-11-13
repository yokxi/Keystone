# Resoconto — Fase 9 (motore reale dall'app e repository per obiettivo)

Nata da un problema segnalato nell'uso: chiedendo dall'app un lavoro su un repository, la proposta
di merge conteneva solo `keystone-sim/t10.md`, nel codice non c'erano modifiche e lo stesso merge
veniva chiesto due volte.

## Le cause

1. **Motore sim.** Senza `~/.keystone/config.json` l'orchestratore avviato dall'app usava il
   motore sim. Il sim non legge la richiesta: scrive `keystone-sim/<task>.md` e lo committa.
2. **Due merge.** Il sim divide ogni obiettivo semplice in due task ("Prepara" e "Completa"), con
   una review ciascuno.
3. **Repository sbagliato.** `goal.submit` dall'interfaccia non indicava il repository, e
   l'orchestratore usava il primo registrato. Tutti e 5 gli obiettivi sono finiti in
   `multiplayer-card-game`, anche quelli su `grandmas-cookbook` e `family-recipes-db`.

## Cosa è fatto

- **`#repository` nella console.** Si scrive `in #grandmas-cookbook adatta il layout`, con Tab che
  completa il nome. Con più repository il tag è obbligatorio; con due tag la console rifiuta
  l'obiettivo. Anche l'orchestratore rifiuta un `goal.submit` senza `repoId` quando i repository
  sono più di uno. `--goal` da riga di comando usa il repository di `--repo`.
- **Motore e credenziale dalle Impostazioni.** Due scelte:
  - abbonamento Claude, con il token di `claude setup-token`;
  - chiave API Anthropic.

  La credenziale è cifrata con `safeStorage` e il renderer non la rilegge. Il pulsante "Riavvia
  orchestratore con questo motore" applica la scelta. Senza una scelta l'app non avvia
  l'orchestratore: dall'app il motore sim non parte più.
- **Difetto di sicurezza corretto.** L'ho trovato durante il lavoro. I test del repository, che
  Keystone esegue nel worktree e che contengono codice scritto dall'agente, ricevevano
  `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY` e gli altri segreti
  dell'ambiente dell'orchestratore. Ora:
  - `agentEnv` toglie ogni segreto;
  - il motore riceve a parte solo le credenziali dei motori;
  - anche i comandi git di Keystone girano senza segreti.

## Scelte prese e perché

- **Il tag `#nome` e non un menu a tendina.** Hai chiesto di "taggare" il repository. Il tag si
  scrive nel testo, funziona da tastiera e non entra in conflitto con `@agente`. Un `#` che non è
  un repository (`#12`) resta testo.
- **Il tag diventa il nome del repository nel testo inviato.** Il lead legge
  `in grandmas-cookbook …`, quindi la frase resta naturale.
- **Solo Claude tra i motori.** Codex è escluso da questa versione (`shared/engines.ts`) finché non
  viene provato con un modello reale. Hai chiesto di mostrare solo i motori disponibili.
- **Il sim resta nel codice.** Serve ai test e alla riga di comando, ma l'app non lo avvia.
- **Allowlist stretta per le credenziali che arrivano alla CLI.** Il revisore chiedeva di scegliere
  tra allowlist e regex larga; ho preso l'opzione più prudente. Passano solo `ANTHROPIC_*`,
  `CLAUDE_CODE_*`, `AWS_*`, `AZURE_*` e `GOOGLE_APPLICATION_CREDENTIALS`. Un provider non previsto
  andrà aggiunto a mano.
- **Il riavvio ferma anche un orchestratore avviato dal terminale**, sempre dopo una conferma
  nell'interfaccia. Prima controlla che il motore scelto possa partire.
- **Il file delle credenziali sta in `~/.keystone`, fuori dal profilo.** La credenziale è tua e
  vale per tutti i profili. Le password dei database stanno invece nel profilo, perché legate ai
  suoi repository.
- **Modelli invariati.** Lead `claude-opus-5-5`, worker `claude-sonnet-5-5`. Se l'abbonamento Pro
  non comprende Opus nei turni degli agenti, basta `"leadModel": "claude-sonnet-5-5"` in
  `config.json` (`docs/motore-claude.md`).

## Rischi e limiti

- DPAPI protegge la credenziale dagli altri utenti e dagli altri PC, ma non dai processi dello
  stesso utente. Un comando che la decifra passa dalla policy, quindi chiede la tua approvazione,
  ma Keystone non è una sandbox (`docs/sicurezza.md` §4bis). È lo stesso limite delle password dei
  database.
- Il riconoscimento dei segreti è per nome (e per gli URL con password). Una variabile con un nome
  che non dice nulla (`MIA_COSA=sk-…`) passa comunque.
- Il login con l'abbonamento è per uso personale, secondo i termini di Anthropic. L'interfaccia lo
  dice.
- In `multiplayer-card-game` i file `keystone-sim/t3.md` … `t10.md` lasciati dalle prove con il
  sim sono stati tolti con un commit di rimozione (`f94c859`, su tua richiesta, senza riscrivere
  la storia: i merge precedenti restano nel log).

## Prove reali

Da fare insieme, perché consumano i limiti del piano (vedi il messaggio di chiusura della fase).

## Test

- Nuovi test:
  - `orchestrator/test/engine-credentials.test.ts`: un test "sonda" del repository, eseguito da
    Keystone, scrive quali credenziali vede;
  - `orchestrator/test/goal-repo.test.ts`;
  - `app/test/engine-auth.test.ts`;
  - casi nuovi in `agent-env.test.ts` e `ui-logic.test.ts`.
- **Controprove**, ciascuna fatta togliendo la protezione nel codice, eseguendo il test e
  ripristinando il codice:
  - filtro dei segreti in `agentEnv`: fallisce sia il test unitario sia la sonda;
  - allowlist delle credenziali (allargata a tutto): falliscono due test;
  - regola sul repository obbligatorio;
  - filtro dell'ambiente in `engine-auth.launch`;
  - cifratura su disco;
  - "un valore mancante non cancella".
- **Test instabile.** "merge approvato…" di `sim-flow` è fallito una volta su cinque giri della
  suite completa. Da solo dura circa 14 s, ma fa due cicli completi con `npm test` e due merge. In
  quel giro girava in parallelo anche la nuova sonda, che esegue un obiettivo intero. Il limite era
  60 s. Non si è più riprodotto in quattro giri; gli ho dato 120 s, come agli altri test di
  integrazione lunghi.
- Risultati finali (13 novembre 2026, dopo le correzioni del revisore):
  - typecheck pulito, due volte;
  - suite completa, due volte: 47 file, 605 test superati;
  - test dell'interfaccia: 1 file, 6 test superati.

  Un primo tentativo di verifica era stato fermato da Claude Code per memoria insufficiente sul
  PC; rilanciato a passi singoli.

## Parere del revisore

Nessun bloccante. Cinque punti da correggere, tutti sistemati:

1. il riavvio fermava l'orchestratore prima di sapere se poteva ripartire;
2. la regex dei segreti lasciava passare `AWS_BEARER_TOKEN_BEDROCK`, `*_KEY`, `PASSWD`,
   `CREDENTIALS` e gli URL con password, e così toglieva alla CLI il token Bedrock;
3. alla CLI arrivavano tutti i segreti dell'utente (`GITHUB_TOKEN`, …): ora solo quelli dei
   motori;
4. la validazione IPC non era testata, e un valore mancante cancellava la credenziale;
5. il piano rimandava a questo resoconto prima che esistesse.

Suggerimenti accolti:

- la credenziale viene validata prima di cambiare il motore;
- i comandi git di Keystone girano senza segreti;
- il completamento di `#repository` non lascia più un doppio spazio;
- la documentazione spiega il tag con l'id del repository.

Il revisore non ha trovato segreti nei log, nello stato, negli argomenti o nel renderer.
