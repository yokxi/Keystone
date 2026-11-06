# Resoconto — Fase 6c (database in sola lettura) e Codex rinviato

Fatta prima della pubblicazione, su tua richiesta, senza un database tuo per provarla. SQLite è
provato davvero; PostgreSQL e SQL Server sono **sperimentali** (driver simulati nei test).

## Cosa è fatto

- **Connessioni per repository** (fino a 10): SQLite, PostgreSQL, SQL Server, con limite di righe,
  tempo massimo, "approvo ogni query" e, per i server, la conferma esplicita che l'utente ha solo
  permessi di lettura (mai già spuntata). Schema in `shared/src/db.ts`, messaggi `db.save`,
  `db.delete`, `db.secret`, `db.test`.
- **Strumenti degli agenti** `db_tables`, `db_describe`, `db_query`, solo se il repository ha
  connessioni; ammessi dalla policy come tool del team; ogni operazione nel registro
  (`~/.keystone/<profilo>/db-queries.jsonl`, senza risultati) e nel log dell'agente; approvazione
  query per query con le decisioni di permesso.
- **Sola lettura**:
  - SQLite in un processo a parte, file aperto in sola lettura e immutable, authorizer a lista
    bianca (niente scritture, `VACUUM INTO`, `ATTACH`, `PRAGMA` che cambiano, estensioni,
    `zeroblob`, `randomblob`);
  - PostgreSQL in transazione `READ ONLY` con cursore, annullamento sul server allo scadere del
    tempo;
  - SQL Server con `ApplicationIntent=ReadOnly`; lì la garanzia è solo l'utente;
  - controllo del testo solo come aiuto.
- **Password**: scritte nella pagina Repository, cifrate dal processo main con `safeStorage`,
  passate all'orchestratore solo in memoria e rimandate a ogni collegamento; legate alla
  destinazione (cambiare server, utente, database… le invalida); tolte da ogni messaggio d'errore;
  mai nel renderer dopo il salvataggio, nello stato, nei log, nel registro, nelle trascrizioni.
- **Limiti**: righe, tempo, 4 operazioni contemporanee, celle a 2000 caratteri, 8 MB di risultato
  da SQLite.
- **Trascrizioni**: lo script di pulizia toglie i risultati degli strumenti del database; una
  fixture con un risultato rimasto viene rifiutata.
- **Pacchetto**: `tedious` fuori dal bundle (porta le librerie di Azure); i controlli della Fase 8 lo
  verificano.
- **Codex rinviato** (tua richiesta del 6 novembre): non incluso in questa versione. Il codice e i
  test restano; l'orchestratore rifiuta Codex da riga di comando e da `config.json`, salvo
  `KEYSTONE_ENABLE_CODEX=1` per prove di sviluppo.

## Scelte prese e perché

- **SQLite in un processo figlio, non in un thread** (dopo la revisione): una query come
  `printf('%800000000c','x')` costruisce un valore enorme in memoria nativa che nessun limite di
  SQLite o di V8 ferma, e faceva crollare l'orchestratore con tutti gli agenti. Nel processo figlio
  crolla solo la lettura. Costa un avvio di processo per operazione (decine di millisecondi).
- **`immutable=1`**: con un database in modalità WAL la sola lettura normale crea `-wal` e `-shm`
  accanto al file; nel repository renderebbero il checkout "modificato" e fermerebbero i merge.
- **Password legata alla destinazione** (dopo la revisione): il WebSocket locale non ha un token,
  quindi un altro programma locale poteva cambiare l'host di una connessione e farsi mandare la
  password. Ora la password non vale più per una destinazione diversa, né nell'orchestratore né
  nell'app.
- **Credenziali solo in memoria nell'orchestratore**: l'orchestratore è un processo Node separato e
  non può usare `safeStorage`; la cifratura resta all'app. Senza l'app funziona solo SQLite.
- **`approveEachQuery` solo per `db_query`**: `db_tables` e `db_describe` leggono solo la
  struttura.
- **Dipendenze**: `pg` 8.23.1, `pg-cursor` 2.22.1, `tedious` 20.3.8 nella regola dei 14 giorni.
  **Eccezione di sicurezza** per `@azure/identity` 4.14.1, `@azure/msal-node` 7.1.2,
  `@azure/msal-common` 16.15.0 (GHSA-xcx6-jx8p-x3h5, alta), documentata in `docs/sicurezza.md` §6.
  Un override più stretto non è stato applicato da npm.
- **Tipi di `pg` scritti a mano** (`orchestrator/src/types/pg.d.ts`) invece di due pacchetti
  `@types` in più.
- **Codex disattivato con un interruttore** (`ENGINE_DISABLED`) invece di commentare il codice: i
  test del motore restano validi e riattivarlo è una riga.

## Rischi e limiti

- PostgreSQL e SQL Server non sono provati con un server reale: limite di righe, tempo massimo,
  annullamento e `READ ONLY` sono coperti solo da driver simulati. Prova reale aggiunta in
  `docs/piano.md`.
- I driver dei server leggono il valore intero di una cella prima di accorciarlo, nel processo
  dell'orchestratore.
- PostgreSQL: se la seconda connessione per annullare la query non riesce, resta solo la chiusura
  del socket.
- SQLite immutable: non vede le modifiche ancora nel `-wal` e presume che nessuno scriva durante la
  lettura.
- Il WebSocket locale non ha un token: un programma con il tuo utente sul PC può comandare
  l'orchestratore (vale per tutto Keystone). Vedi la domanda qui sotto.
- Un file `.db` nel repository può essere cambiato da un agente e, dopo il merge, letto dalla
  connessione: la review lo mostra; l'authorizer limita tutto alla lettura.

## Test

- `orchestrator/test/db.test.ts` (21 test): controllo del testo, SQLite vero (tabelle, descrizione,
  query, limiti, authorizer anche saltando il controllo del testo, file invariato, tempo scaduto
  senza bloccare, WAL senza file accanto, valori enormi, crollo del lettore confinato), password
  mai su disco/log/registro/snapshot/errori, legame con la destinazione, concorrenza, strumenti degli
  agenti, approvazione (sì, no, annullata), registro, pulizia delle trascrizioni.
- `app/test/db-ui.test.ts` (6): password cifrate, mai in chiaro, solo memoria senza cifratura,
  file rovinati; comandi del renderer (`db.secret` mai); modulo della connessione.
- `app/e2e/security.e2e.ts`, nuovo test: con l'app vera e `safeStorage` vero, conferma
  obbligatoria, password all'orchestratore e cifrata su disco, rimandata dopo un nuovo server, tolta
  con la connessione.
- `orchestrator/test/engine-disabled.test.ts` (2): Codex rifiutato da riga di comando e da
  `config.json`.
- Mutazioni (ognuna fa fallire il suo test): authorizer di SQLite tolto; `scrub` tolto; invio delle
  password al collegamento tolto (e2e); `immutable` tolto; diniego delle funzioni tolto; confronto
  della destinazione tolto. La query `printf('%800000000c')` senza il processo a parte fa crollare il
  processo dei test (verificato dal revisore).
- **Un'esecuzione con molti fallimenti, non del codice**: in una suite lanciata in background il PC
  è andato in sospensione (ogni test risulta durato circa 2,8 ore) e i timer sono scaduti al
  risveglio; la seconda passata della stessa esecuzione era tutta verde.
- Risultati finali: typecheck pulito; `npm test` due volte: 41 file, 574 test passati entrambe le
  volte; `npm run test:ui`: 5 test passati; `npm audit`: 0 vulnerabilità.

## Parere del revisore

Prima revisione (parte 1): nessuna fuga della password né buchi nell'authorizer. Da correggere:
tempo massimo di PostgreSQL che non fermava la query sul server (anche con `set_config`), nessun
limite di memoria e concorrenza, piano non aggiornato: corretti. Suggerimenti accolti: soglia di
`scrub` allineata (password di almeno 4 caratteri), richiesta annullata distinta da "Nega", quoting
della descrizione, chiusura su errore in SQL Server, nota sull'elenco tabelle troncato, file WAL.

Seconda revisione (correzioni e parte 2): **un bloccante** (la query `printf` enorme faceva crollare
l'orchestratore), corretto con il processo a parte; **da correggere** la password dirottabile
cambiando l'host di una connessione, corretto legandola alla destinazione; nota sulla seconda
connessione di PostgreSQL e sui dati del `-wal`, aggiunte. Il processo main e il renderer non
mostrano fughe della password; lo stato React del campo si svuota anche dopo un errore.

Il revisore non ha rivisto le ultime due correzioni (processo a parte, legame con la destinazione):
sono coperte dai test e dalle mutazioni sopra.

## Domande per te

1. **Token sul WebSocket locale?** Oggi qualunque programma locale con il tuo utente può comandare
   l'orchestratore. Un token, generato all'avvio e letto dall'app, chiuderebbe questa porta. Cambia
   un principio di sicurezza (chi può collegarsi), quindi decidi tu.
2. **PostgreSQL e SQL Server in questa versione?** Come per Codex, li posso lasciare "sperimentali"
   oppure disattivarli fino alla prova con un server reale (SQLite resta).
