# Piano delle fasi successive

Le fasi precedenti sono nel codice e nei documenti di `docs/`. Qui ci sono le fasi ancora da fare.

## Ordine delle fasi

1. Fase Skill (regole per gli agenti e review sul riassunto) — fatta
2. Fase 7 — File di configurazione — fatta
3. Fase 8 — Pacchetto dell'app — fatta (app portabile; l'installatore è tra le cose da fare)
4. Pubblicazione (le prove elencate in "Pubblicazione — da fare prima")
5. Fase 6c — Accesso al database in sola lettura: spostata dopo la pubblicazione

## Uso in team

Ogni persona installa Keystone sul proprio PC, con le proprie chiavi e il proprio clone del
repository. Quello che si condivide (codice, skill del repository in `.keystone/skills/`) passa da
git, con i normali push e pull fatti dalle persone. Nella prima versione non c'è un server
condiviso: niente stato, chiavi o code di lavoro comuni tra PC diversi.

## Fase Skill — Regole per gli agenti (fatta)

Fatta: formato, lettura dal branch di destinazione, percorsi protetti, consegna uguale a Claude e
Codex, pagina Skill, "salva come skill" dalla review, skill ricevute nel pannello dell'agente e
review sul riassunto. Dettagli e limiti in `docs/skill.md`; resoconto in
`docs/resoconti/skill.md`. Limite noto: con `file:` al primo turno di un task conta solo il testo
del task (il worktree è ancora vuoto).


**Cosa sono.** Una skill è un file markdown di regole per gli agenti. Due posti:

- `.keystone/skills/` nel repository: condivise con il team tramite git;
- `~/.keystone/skills/`: personali, valgono per tutti i repository di chi le scrive.

Ogni skill indica, nell'intestazione, a chi si applica (lead, worker, tutti) e quando (sempre,
oppure solo per certi file o certe richieste), e se è attiva.

**Come arrivano agli agenti.** Keystone le passa agli agenti allo stesso modo con Claude e con
Codex, come parte delle istruzioni del turno. Non si riattivano le skill, le impostazioni, la
memoria, i `CLAUDE.md` / `AGENTS.md` o i server MCP nativi dei motori: l'isolamento resta com'è.

**Sicurezza.**

- `.keystone/skills/` è un percorso protetto nella policy: gli agenti non possono scriverci (azione
  negata, non chiesta).
- Keystone legge le skill del repository dal branch di destinazione, non dal worktree
  dell'agente: un agente che modificasse una skill nel suo worktree non cambierebbe le regole
  proprie né degli altri. Un test per ciascuno dei due casi.

**Interfaccia.**

- Pagina Skill: crearle, modificarle, attivarle e disattivarle (del repository e personali).
- Nella review, "Richiedi modifiche" offre di salvare la correzione come skill.
- Il pannello dell'agente mostra quali skill ha ricevuto nel turno.

**Review sul riassunto.** La review si apre sul riassunto: richiesta, cosa è stato fatto e perché,
file toccati, esito dei test, schermate prima/dopo, rischi. Il diff sta in una scheda separata.
(Non era stato fatto nella 6b parte 2, quindi entra in questa fase.)

## Fase 7 — File di configurazione (fatta)

`~/.keystone/config.json`: motore e modello per agente, effort, numero di worker e le altre
impostazioni oggi passate da riga di comando.

Fatta: schema rigido, precedenza file < ambiente < riga di comando, motore/modello/effort per
singolo agente, `--config`, `--no-config`, `--show-config`; il file è un percorso protetto per gli
agenti. `--codex-path`, `--ci` e `--record` restano solo da riga di comando. Dettagli in
`docs/configurazione.md`; resoconto in `docs/resoconti/fase-7.md`. Per la Fase 8: l'app deve
mostrare l'errore se `config.json` non è valido (oggi l'orchestratore si ferma e lo scrive nel
suo log).

## Fase 8 — Pacchetto dell'app (fatta, senza installatore)

L'app installabile, che avvia da sola l'orchestratore senza i sorgenti.

Fatta: `npm run package -w app` crea l'app portabile (cartella con `Keystone.exe`, e uno zip con
`--zip`) con l'orchestratore in bundle, le fuse di Electron irrigidite e l'errore d'avvio mostrato
nell'app. Dettagli in `docs/pacchetto.md`; resoconto in `docs/resoconti/fase-8.md`.

- [ ] **Installatore (NSIS con electron-builder).** Rinviato: electron-builder 26.18 porta
  `minimatch` con l'avviso GHSA-g3hv-75wg-m249; la versione corretta (11.0.1, del 27 ottobre 2026)
  avrà 14 giorni dal 10 novembre 2026, insieme alla sua nuova dipendenza. Allora: override di
  `minimatch` (con il lockfile rigenerato solo per quel ramo), `npm audit` pulito, installatore.

## Pubblicazione — da fare prima

- [ ] **Prova reale del motore Codex con una chiave API OpenAI.** Su un repository di prova:
  piano, lavoro, review e merge; permessi, sandbox, commit e conteggio dei token, con
  `--record` per le trascrizioni.
- [ ] **Prova reale del motore Codex con il login ChatGPT** (`--use-codex-login`, login fatto nella
  cartella di Keystone).
- [ ] **Prova con un team misto**, per esempio lead Claude e worker Codex (`--lead-engine claude
  --worker-engine codex`): sessioni separate per motore, spesa e limiti, review e merge.
- [ ] **Confronto dei costi con la Console Anthropic** usando una chiave API: spesa mostrata da
  Keystone e spesa nella Console per lo stesso obiettivo, compresa una sessione ripresa.

Solo dopo le due prove reali di Codex si toglie l'etichetta "sperimentale · non ancora verificato
con un modello reale" (`shared/src/engines.ts` e README).

## Fase 6c — Accesso al database in sola lettura

Spostata dopo la pubblicazione. Non è ancora implementata (un inizio non committato è stato
scartato).

**Configurazione per repository.** Per ogni repository registrato si configurano una o più
connessioni a database: SQL Server, PostgreSQL o SQLite.

- Le credenziali si salvano con `safeStorage` di Electron. Non arrivano mai agli agenti né ai loro
  comandi: non stanno nell'ambiente dei sottoprocessi, nei prompt, nei log o nelle trascrizioni.
- Per ogni connessione si configurano il limite di righe e il tempo massimo di ogni query.

**Cosa possono fare gli agenti.** Gli agenti accedono al database solo con gli strumenti di
Keystone, mai con un client proprio:

- elenco delle tabelle e delle loro colonne;
- descrizione di una tabella: colonne, tipi, chiavi, indici;
- query in sola lettura, con i limiti di righe e di tempo della connessione.

**La garanzia della sola lettura.**

- La garanzia vera è un utente del database con soli permessi di lettura. L'interfaccia lo chiede
  esplicitamente durante la configurazione: serve una conferma, non una casella già spuntata. Il
  motivo è spiegato in `docs/sicurezza.md`.
- In più, dove il database lo permette, ogni query gira in una transazione in sola lettura:
  `SET TRANSACTION READ ONLY` su PostgreSQL, connessione aperta in sola lettura su SQLite. SQL
  Server non ha un equivalente per le transazioni, quindi lì conta solo l'utente.
- Il controllo del testo della query, per esempio "solo SELECT", è al massimo un aiuto. Non è una
  garanzia e la documentazione non lo presenta come tale.

**Registro e approvazione.**

- Keystone registra ogni query: testo, agente, connessione, durata, righe restituite, esito.
- Le query si vedono nel pannello dell'agente.
- Un'opzione per connessione fa approvare all'utente le query una per una, come i comandi che
  chiedono il permesso.

**Trascrizioni.** I risultati delle query entrano nelle trascrizioni salvate (`--record`) solo dopo
la pulizia, come gli altri dati locali e i segreti.

**Avviso.** I risultati delle query vengono inviati al fornitore del modello. Quindi si usano solo
database di sviluppo o con dati anonimizzati, mai di produzione. L'avviso sta:

- nell'interfaccia, durante la configurazione della connessione;
- in `docs/sicurezza.md`.

**MCP: decisione presa.** Oggi i tool del team sono definiti una volta sola (`TeamTool`) e ogni
motore li espone a modo suo: il motore Claude con un server MCP interno (`createSdkMcpServer`), il
motore Codex con i dynamic tool di `app-server`. Gli strumenti del database seguono la stessa
strada: sono tool di Keystone e passano dalla policy, dal registro e dall'approvazione.

Decisione: se in futuro si collega un server MCP esterno (per esempio per lo schema del database),
**Keystone fa da client MCP e inoltra i suoi strumenti agli agenti come tool del team**, con policy,
registro e approvazione. Il server esterno non viene mai passato direttamente al motore, perché si
perderebbero:

- la policy;
- il registro e l'approvazione;
- la pulizia delle trascrizioni;
- l'isolamento attuale (`mcp_servers: {}` per Codex, nessun server MCP dell'utente per Claude).

Restano da definire, prima di implementare:

- se esporre i tool del database con nomi e schemi compatibili con quelli dei server MCP più
  diffusi per i database;
- come limitare un server esterno ai soli tool di lettura;
- come avviare un server esterno: un processo stdio con l'ambiente ripulito, senza le credenziali
  degli agenti.

## Fase 6 — Motore Codex (fatta)

Adattatore per `codex app-server` accanto a quelli di Claude e del motore sim, con le stesse
garanzie: ogni azione passa dalla policy di Keystone, nessuna configurazione personale dell'utente,
limiti per obiettivo. Dettagli e limiti noti in `docs/motore-codex.md`. Manca la prova con un
modello vero.

## Fase 6b — Verifica visuale nella review

Fatta, in due parti. Parte 1: schermate prima/dopo, resoconto del worker, permesso per il browser,
schermate agli agenti come opzione. Parte 2: console, errori JavaScript e richieste fallite nella
review, e la prova interfaccia per il worker (`try_ui`). Dettagli e limiti in
`docs/verifica-visuale.md`. Manca una prova con un modello vero.

**Configurazione per repository.** Per ogni repository registrato si configurano:

- il comando che avvia l'app;
- l'URL a cui risponde;
- un tempo massimo di avvio.

Senza questa configurazione la verifica visuale è disattivata.

**Cosa dichiara il worker.** A fine task il worker indica, in un formato strutturato, le pagine e i
passaggi da verificare: URL, clic, campi da compilare. Scrive anche un resoconto strutturato:

- la richiesta originale;
- cosa ha cambiato e perché;
- come l'ha verificato;
- i problemi aperti.

**Cosa fa Keystone.** È Keystone, non l'agente, a eseguire la verifica:

- avvia l'app due volte, dal branch di partenza e dal worktree dell'agente;
- esegue i passaggi dichiarati con Playwright;
- cattura le schermate prima e dopo;
- se l'avvio o un passaggio fallisce, lo annota nella review.

**Nella review.**

- La schermata di review mostra le schermate prima/dopo affiancate, con didascalie, accanto al diff
  e all'esito dei test.
- Un'opzione permette al lead di vedere le schermate nella sua review. È disattivata di default,
  perché le immagini costano token.

**Sicurezza.**

- L'app avviata per la verifica può usare solo la rete locale.
- Le schermate stanno in `~/.keystone`, mai nel repository, nelle trascrizioni o nei log.
- L'installazione dei browser di Playwright chiede il permesso.

**Limite iniziale.** All'inizio solo app web, e il limite va documentato.

### Parte 2 (fatta)

**Console, errori e rete nella review.** Durante la verifica Keystone raccoglie, per ogni pagina e
per ciascuno dei due lati (prima e dopo):

- i messaggi della console del browser;
- gli errori JavaScript non gestiti;
- le richieste fallite: errori di rete, risposte 4xx e 5xx, richieste bloccate perché non locali.

La review li mostra accanto alle schermate e mette in evidenza ciò che compare solo "dopo". Il
lead li riceve come testo nella sua review. Testi lunghi troncati, nessun dato fuori da
`~/.keystone`.

**Strumento "prova interfaccia" per il worker.** Durante il lavoro il worker può chiedere a
Keystone di avviare l'app dal suo worktree e di eseguire dei passaggi, con lo stesso formato di
`visual_checks`. Riceve indietro l'esito dei passaggi, la console, gli errori e le richieste
fallite. Così verifica l'interfaccia prima di mettere il task in review. Regole:

- lo esegue Keystone, con le stesse garanzie della verifica in review: solo rete locale, ambiente
  senza credenziali, schermate in `~/.keystone`;
- limiti per turno: numero di prove e tempo massimo;
- la schermata va all'agente solo se l'opzione delle schermate è attiva per il repository, perché
  costa token.
