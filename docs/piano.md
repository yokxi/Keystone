# Piano delle fasi successive

Le fasi precedenti sono nel codice e nei documenti di `docs/`. Qui ci sono le fasi ancora da fare.

## Da fare prima della pubblicazione

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

## Fase 6 — Motore Codex (fatta)

Adattatore per `codex app-server` accanto a quelli di Claude e del motore sim, con le stesse
garanzie: ogni azione passa dalla policy di Keystone, nessuna configurazione personale dell'utente,
limiti per obiettivo. Dettagli e limiti noti in `docs/motore-codex.md`. Manca la prova con un
modello vero.

## Fase 6b — Verifica visuale nella review

Da fare dopo la Fase 6. Non è ancora implementata.

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

## Fase 6c — Accesso al database in sola lettura

Da fare dopo la Fase 6b. Non è ancora implementata.

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

**MCP: da valutare.** Oggi i tool del team sono definiti una volta sola (`TeamTool`) e ogni motore
li espone a modo suo: il motore Claude con un server MCP interno (`createSdkMcpServer`), il motore
Codex con i dynamic tool di `app-server`. Gli strumenti del database possono seguire la stessa
strada: sono tool di Keystone e passano dalla policy, dal registro e dall'approvazione. Questo
basta per la prima versione.

Per collegare in futuro un server MCP esterno per lo schema del database, conviene che sia Keystone
a fare da client MCP, e che inoltri i suoi tool agli agenti come tool del team. Non si passa il
server direttamente al motore, perché si perderebbero:

- la policy;
- il registro e l'approvazione;
- la pulizia delle trascrizioni;
- l'isolamento attuale (`mcp_servers: {}` per Codex, nessun server MCP dell'utente per Claude).

Da decidere prima di implementare:

- se esporre i tool del database con nomi e schemi compatibili con quelli dei server MCP più
  diffusi per i database;
- come limitare un server esterno ai soli tool di lettura;
- dove gira un server esterno: un processo stdio con l'ambiente ripulito, senza le credenziali
  degli agenti.

## Fase 7 — File di configurazione

`~/.keystone/config.json`: motore e modello per agente, effort, numero di worker e le altre
impostazioni oggi passate da riga di comando.

## Fase 8 — Pacchetto dell'app

L'app installabile, che avvia da sola l'orchestratore senza i sorgenti.
