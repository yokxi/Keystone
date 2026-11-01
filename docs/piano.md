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

## Fase 7 — File di configurazione

`~/.keystone/config.json`: motore e modello per agente, effort, numero di worker e le altre
impostazioni oggi passate da riga di comando.

## Fase 8 — Pacchetto dell'app

L'app installabile, che avvia da sola l'orchestratore senza i sorgenti.
