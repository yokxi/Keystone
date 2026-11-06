# Database in sola lettura

Gli agenti possono leggere un database del progetto (struttura e dati) per capire il codice che ci
lavora sopra: SQLite, PostgreSQL o SQL Server. Solo in lettura, solo con gli strumenti di Keystone.

> **Avviso.** I risultati delle query vengono inviati al fornitore del modello (Anthropic o OpenAI).
> Usa solo database di sviluppo o con dati anonimizzati, **mai di produzione**.

PostgreSQL e SQL Server sono **sperimentali**: il codice è testato con driver simulati, non ancora
con un server reale. SQLite è provato davvero.

## Configurazione

Per ogni repository registrato, fino a 10 connessioni: pagina **Repository**, sezione "database in
sola lettura" (o messaggio `db.save`, vedi `docs/protocol.md`). La sezione mostra l'avviso sui dati
inviati al fornitore, e per PostgreSQL e SQL Server chiede la conferma che l'utente ha solo permessi
di lettura: la casella non è mai già spuntata, nemmeno quando modifichi una connessione esistente.
**Prova** apre la connessione ed elenca le tabelle.

| Campo | Significato |
|---|---|
| `id` | il nome che usano gli agenti (minuscole, cifre, trattini) |
| `name` | il nome che vedi tu |
| `kind` | `sqlite`, `postgres`, `sqlserver` |
| `file` | SQLite: il file, assoluto o relativo alla cartella del repository; deve esistere |
| `host`, `port`, `database`, `user` | PostgreSQL e SQL Server |
| `tls` | connessione cifrata (default sì); `trustServerCertificate` solo per server di sviluppo |
| `maxRows` | righe massime per query (1-5000) |
| `timeoutSec` | tempo massimo per operazione (1-300 s) |
| `approveEachQuery` | ogni query degli agenti chiede la tua approvazione |
| `readOnlyUserConfirmed` | hai confermato che l'utente ha solo permessi di lettura (obbligatorio per i server) |

**La password vale per una destinazione.** Keystone la lega a tipo, server, porta, database,
utente, cifratura e certificato della connessione. Se uno di questi cambia (anche da un altro
programma collegato all'orchestratore), la password non viene più usata né rimandata: va riscritta
nella pagina. Così nessuno può farsi mandare la tua password verso un altro server cambiando
l'indirizzo di una connessione. Nome, limiti e approvazione si cambiano senza riscriverla.

**La password non sta mai nella configurazione.** La scrivi nella pagina una volta (da 4 a 1000
caratteri); il processo main dell'app la cifra con `safeStorage` (DPAPI di Windows) in
`~/.keystone/<profilo>/db-secrets.json` e la passa all'orchestratore (`db.secret`), che la tiene solo
in memoria. L'app la rimanda a ogni collegamento (anche dopo un riavvio dell'orchestratore). Il
renderer non la rilegge mai: sa solo se una connessione ha una password ("password salvata"). Se la
cifratura del sistema non è disponibile la password non si salva su disco: vale finché l'app resta
aperta. Togliere una connessione toglie anche la sua password. Senza l'app, con l'orchestratore da
riga di comando, funziona solo SQLite.

### Un utente con soli permessi di lettura

È la garanzia vera, e Keystone la chiede esplicitamente. Esempi:

```sql
-- PostgreSQL
CREATE ROLE keystone_lettore LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE app TO keystone_lettore;
GRANT USAGE ON SCHEMA public TO keystone_lettore;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO keystone_lettore;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO keystone_lettore;

-- SQL Server
CREATE LOGIN keystone_lettore WITH PASSWORD = '…';
CREATE USER keystone_lettore FOR LOGIN keystone_lettore;
ALTER ROLE db_datareader ADD MEMBER keystone_lettore;
```

## Strumenti degli agenti

Ci sono solo se il repository su cui lavora l'agente ha connessioni configurate, per il lead e per i
worker:

- `db_tables { connection }`: tabelle e viste;
- `db_describe { connection, table }`: colonne, tipi, chiavi, indici (`schema.tabella` per i server);
- `db_query { connection, sql }`: una query di sola lettura, con i limiti della connessione.

Il risultato arriva all'agente come tabella di testo (celle lunghe accorciate, al massimo 40 000
caratteri), con un'intestazione `Connessione "…" (…, sola lettura)`.

## Come è garantita la sola lettura

| Livello | SQLite | PostgreSQL | SQL Server |
|---|---|---|---|
| Utente con soli permessi di lettura | — (file) | **sì, confermato da te** | **sì, confermato da te** |
| Database | file aperto in sola lettura + authorizer che ammette solo letture | transazione `READ ONLY` e `default_transaction_read_only` | `ApplicationIntent=ReadOnly` (porta su una replica di lettura se c'è; non impedisce le scritture) |
| Controllo del testo | solo un aiuto | solo un aiuto | solo un aiuto |

L'authorizer di SQLite nega anche quello che funzionerebbe su un file aperto in sola lettura:
`VACUUM INTO` (scrive un altro file), `ATTACH` (legge altri file), `PRAGMA` che cambiano
impostazioni, estensioni, e le funzioni che creano valori enormi dal nulla (`zeroblob`,
`randomblob`). Sono ammessi solo i `PRAGMA` che descrivono le tabelle.

SQLite gira in un **processo a parte**, con l'ambiente vuoto, un limite di memoria e un tempo
massimo: una query può costruire valori enormi in memoria nativa (per esempio
`printf('%800000000c', 'x')`), che nessun limite di SQLite o di Node ferma; nel processo
dell'orchestratore lo farebbero crollare con tutti gli agenti. Nel processo a parte crolla solo la
lettura, e la query fallisce con un messaggio.

Il file SQLite si apre anche come "immutable": SQLite non crea file accanto. Con un database in
modalità WAL, la sola lettura normale creerebbe `-wal` e `-shm` nella cartella, magari nel tuo
repository (che risulterebbe modificato e fermerebbe i merge). Limite: si presume che nessuno scriva
sul file mentre Keystone lo legge; se un programma lo sta modificando, una lettura può vedere dati a
metà, e le modifiche ancora nel file `-wal` (non ancora riportate nel database) non si vedono.

Il controllo del testo rifiuta, fuori da stringhe e commenti, più istruzioni insieme e parole come
`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `INTO`, `EXEC`, `SET`. È un aiuto per dare
all'agente un messaggio chiaro: un testo costruito apposta può superarlo.

## Limiti

- Righe: al massimo `maxRows`, lette con un cursore (PostgreSQL) o annullando la richiesta (SQL
  Server): la tabella non viene caricata tutta in memoria.
- Tempo: `timeoutSec` per il collegamento e per l'istruzione, più un margine di 5 s oltre il quale
  l'operazione viene abbandonata. SQLite gira in un thread a parte, terminato allo scadere.
- Una connessione per operazione: niente sessioni lasciate aperte.
- PostgreSQL: oltre il tempo massimo (più 1 s) la query viene annullata sul server da una seconda
  connessione (`pg_cancel_backend` sulla propria sessione), se la seconda connessione riesce, e il
  socket viene chiuso; ROLLBACK e chiusura hanno a loro volta un limite. Serve perché una query
  potrebbe cambiare il proprio `statement_timeout`. Se la seconda connessione non riesce (limite di
  connessioni del server, per esempio), resta solo la chiusura del socket: una query lunga può
  continuare sul server finché non prova a rispondere.
- Al massimo 4 operazioni sul database insieme, per tutto l'orchestratore: le altre vengono
  rifiutate (e registrate) finché una non finisce.
- Celle accorciate a 2000 caratteri già nel driver, e al massimo 8 MB di risultato da SQLite.
  Limite residuo: i driver dei server (PostgreSQL, SQL Server) leggono il valore intero di una cella
  prima di accorciarlo, nel processo dell'orchestratore; un valore enorme di un server occupa memoria
  per la durata della query.

## Registro e approvazione

Ogni operazione degli agenti va in `~/.keystone/<profilo>/db-queries.jsonl` (testo, agente,
connessione, durata, righe, esito: `ok`, `error`, `refused`, `denied`, `timeout`), senza i risultati;
oltre 5 MB il file passa a `.1`. Le operazioni compaiono anche nel log dell'agente.

Con `approveEachQuery` ogni query (`db_query`) apre una richiesta di permesso ("Consenti una volta"
/ "Nega"), come i comandi che chiedono: la query parte solo dopo il tuo sì. `db_tables` e
`db_describe` leggono solo la struttura e non chiedono. Una richiesta annullata (turno fermato,
riavvio) non conta come un tuo "Nega": l'agente lo sa e il registro lo scrive (`denied` con il
motivo). Dopo un riavvio dell'orchestratore una richiesta rimasta aperta non ha più nessuno che
aspetta: rispondere non esegue la query, l'agente la richiederà.

## Trascrizioni

Lo script di pulizia (`orchestrator/scripts/sanitize-transcripts.ts`) toglie dalle trascrizioni i
risultati degli strumenti del database (le query restano). Se dopo la pulizia una trascrizione
contiene ancora un risultato, non viene copiata tra le fixture; il test delle fixture controlla lo
stesso a ogni esecuzione.

## Il file SQLite e il lavoro degli agenti

Il file lo indichi tu nella configurazione; gli agenti non scelgono percorsi. Attenzione però a un
file `.db` che sta nel repository: un agente può cambiarlo nel suo worktree come ogni altro file, e
dopo il merge la connessione leggerebbe un database con struttura e dati scelti dall'agente. La
review lo mostra tra i file modificati; l'authorizer limita comunque tutto alla lettura.

## Server MCP esterni

Decisione presa (vedi `docs/piano.md`): se in futuro si collega un server MCP esterno per i
database, Keystone fa da client e inoltra i suoi strumenti come tool del team, con policy, registro e
approvazione. Il server esterno non viene mai passato direttamente al motore.
