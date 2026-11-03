# Verifica visuale nella review

Quando un task tocca l'interfaccia di un'app web, Keystone può mostrarti nella review le schermate
della stessa pagina **prima** e **dopo** il lavoro dell'agente, affiancate. Accanto alle schermate
mostra la console del browser, gli errori JavaScript e le richieste fallite. La verifica la esegue
**Keystone**, non l'agente: l'agente indica solo quali pagine guardare. Durante il lavoro il worker
può anche chiedere a Keystone di provare l'interfaccia dal suo worktree (`try_ui`, sezione 5).

Codice: `orchestrator/src/core/visual.ts` (esecuzione), `orchestrator/src/core/team.ts`
(`runVisualCheck`, dopo i test e prima della review). Test: `orchestrator/test/visual.test.ts`.

## 1. Configurazione per repository

Nella pagina **Repository** dell'app, "verifica visuale → Configura":

| Campo | Esempio | Note |
|---|---|---|
| Comando di avvio | `npm run dev` | Eseguito nella cartella del branch, con una shell. |
| URL dell'app | `http://localhost:5173` | Solo `localhost`, `127.0.0.1` o `[::1]`. |
| Tempo massimo di avvio | `60` | Da 5 a 600 secondi. |
| Gli agenti vedono le schermate | spento | Il lead nella review e il worker con `try_ui`. Vedi sezioni 4 e 5. |

Senza configurazione la verifica è disattivata. "Disattiva" la toglie. Dal protocollo è il
messaggio `repo.config` con il campo `visual` (vedi `docs/protocol.md`).

La variabile `PORT` dell'app viene impostata alla porta dell'URL e `BROWSER=none`, così i dev
server più comuni rispondono sulla porta giusta e non aprono un browser da soli.

## 2. Cosa fa il worker

A fine task, prima di `update_task` con `status: "review"`, il worker chiama `submit_report`:

- `request`: la richiesta originale, con parole sue;
- `changes`: cosa ha cambiato;
- `why`: perché, e le alternative scartate;
- `verification`: come l'ha verificato;
- `open_issues`: problemi aperti, oppure "nessuno";
- `visual_checks` (facoltativo, al massimo 10 pagine): per ogni pagina `name`, `path` (sempre
  relativo all'app, deve iniziare con `/`), `steps` e `caption` (cosa si dovrebbe vedere).

I passaggi possibili sono: `goto` (un altro percorso della stessa app), `click`, `fill` (con
`value`), `press` (con `key`) e `wait` (aspetta che un elemento sia visibile). Al massimo 30
passaggi per pagina, e i selettori sono quelli di Playwright. Un percorso che porta fuori dall'app
(`//altro.sito`, `http://…`) viene rifiutato già da `submit_report`.

Il resoconto compare nella review per te e per il lead, sempre indicato come "quello che dice il
worker".

## 3. Cosa fa Keystone

Dopo i test del repository (e solo se non sono tornati al worker per una correzione):

1. Se il worker non ha indicato pagine, la verifica risulta "non eseguita" con il motivo.
2. Cerca un browser: Microsoft Edge, poi Google Chrome, poi il Chromium scaricato in
   `~/.keystone/browsers`. Usa sempre un profilo temporaneo, mai il tuo.
3. Controlla che sull'URL non risponda già un'altra app. Se risponde, le schermate sarebbero
   sue: la verifica si ferma come "non riuscita" e lo dice.
4. **Prima:** crea un worktree temporaneo staccato (`~/.keystone/<profilo>/visual/<task>-base`)
   sul commit da cui è partito il branch dell'agente (`git merge-base`). Avvia l'app, esegue i
   passaggi di ogni pagina, cattura le schermate e ferma l'app con tutti i suoi processi.
5. **Dopo:** lo stesso nel worktree dell'agente.
6. Toglie il worktree temporaneo. Il tuo checkout non viene mai toccato.

Le verifiche e le prove dello stesso repository si eseguono **una per volta**. Usano tutte la stessa
porta, e due app avviate insieme si scambierebbero le schermate. Una review o una prova che arriva
mentre ne è in corso un'altra aspetta il suo turno. Repository diversi non si aspettano.

Una schermata viene catturata anche quando un passaggio fallisce, così mostra dove si è fermata.
L'errore del passaggio è annotato accanto alla schermata. Le schermate sono a 1280 px di larghezza,
con la pagina intera fino a 4000 px di altezza.

**Dipendenze.** `node_modules` non è nel repository. Se il tuo checkout ce l'ha, è ignorata da git
e manca nella cartella, Keystone crea un collegamento (junction su Windows) e lo toglie alla fine.
Il collegamento viene tolto senza mai seguirlo: una cancellazione ricorsiva svuoterebbe la tua
cartella vera. Dopo un'interruzione (crash, chiusura forzata), all'avvio dell'orchestratore
vengono tolti i collegamenti e i worktree temporanei rimasti.

**Console, errori e rete.** Per ogni pagina e per ciascun lato, Keystone raccoglie:

- i messaggi della console del browser, con il tipo (`log`, `info`, `warning`, `error`…);
- gli errori JavaScript non gestiti, con il messaggio e le prime righe dello stack;
- le richieste fallite: errori di rete, risposte 4xx e 5xx, e richieste bloccate perché non
  locali.

I messaggi "Failed to load resource…" che il browser scrive da solo in console non vengono raccolti,
perché sono già tra le richieste fallite. Ci sono dei limiti per pagina e per lato: 50 messaggi di
console, 20 errori e 50 richieste. I testi vengono troncati: 500 caratteri per un messaggio, 1000
per un errore, 300 per un URL. Oltre i limiti la diagnostica risulta "troncata".

**Cosa è "solo dopo".** Una voce è nuova se non compare nel lato "prima" della stessa pagina:

- per un messaggio di console contano il tipo e il testo;
- per un errore conta la prima riga, perché righe e colonne dello stack cambiano a ogni modifica;
- per una richiesta contano metodo, percorso (senza la query, che i dev server cambiano a ogni
  avvio) ed esito.

Se il lato "prima" non è stato eseguito, il confronto non è disponibile e lo si dice.

**Esito.** È salvato nel task (`task.visual`, vedi `docs/protocol.md`):

- `done`: eseguita;
- `skipped`: non eseguita, con il motivo;
- `failed`: l'app non si è avviata, o sull'URL rispondeva già un'altra app;
- `running`: in corso.

I problemi di avvio, con le ultime righe dell'output dell'app, e le richieste di rete bloccate sono
elencati nella review.

## 4. Nella review

- **Per te:** la schermata di review mostra il resoconto del worker e, sopra il diff, per ogni
  pagina le schermate prima/dopo affiancate, con la didascalia e i problemi. Un clic ingrandisce
  la schermata. Sotto le schermate, "Console, errori e rete" mette a confronto prima e dopo. Le
  voci nuove sono segnate "solo dopo", e il riquadro si apre da solo se ce ne sono. Il riassunto
  dell'esito è anche nel testo della decisione di merge.
- **Per il lead:** riceve sempre il riassunto in testo. Per ogni pagina ci sono gli errori
  JavaScript, gli errori e avvisi di console e le richieste fallite che compaiono **solo dopo**
  (al massimo 5 per tipo); ciò che c'era già prima compare solo come conteggio. Le immagini le
  riceve solo se è attiva l'opzione "Gli agenti vedono le schermate" del repository, disattivata di
  default perché ogni immagine costa token. Al massimo 8 immagini, nell'ordine delle pagine: con Claude come blocchi
  immagine, con Codex come `localImage`. Con Claude, un'immagine oltre i 5 MB viene sostituita da
  una riga di testo che lo dice.

## 5. Prova interfaccia per il worker (`try_ui`)

Durante il lavoro, prima di mettere il task in review, il worker può chiamare `try_ui` con al
massimo 3 pagine, nello stesso formato di `visual_checks`. Keystone:

1. avvia l'app **dal worktree del worker** (solo quello: non c'è un lato "prima");
2. esegue i passaggi e cattura una schermata per pagina in
   `~/.keystone/<profilo>/visual/<task>-try/`;
3. restituisce al worker, per ogni pagina, l'esito dei passaggi, gli errori JavaScript, gli errori e
   avvisi di console, il numero degli altri messaggi e le richieste fallite.

Le garanzie sono le stesse della verifica in review: rete solo locale, ambiente senza credenziali,
schermate in `~/.keystone`, una sola app per volta per repository.

**Limiti per turno:**

- al massimo 5 prove;
- in tutto 10 minuti;
- ogni prova ha al massimo 3 minuti per i passaggi, più il tempo di avvio configurato.

Una prova che supera il tempo si ferma e lo dice. Il turno interrotto non avvia nuove prove; una
prova già partita finisce entro i suoi limiti.

**Schermate.** La schermata torna all'agente solo se è attiva l'opzione "Gli agenti vedono le
schermate": con Claude come blocco immagine nel risultato del tool, con Codex come `inputImage`.
Altrimenti il risultato dice che non è allegata.

**Quando non è disponibile.** Senza verifica visuale configurata, o senza Edge né Chrome, la prova
non parte e il worker riceve il motivo. Il download di Chromium si chiede solo alla review, non
durante il turno di un agente. `try_ui` è un tool del team, ammesso dalla policy solo per i worker.

## 6. Permesso per scaricare il browser

Se non c'è né Edge né Chrome, Keystone apre una decisione di tipo permesso: "Keystone chiede di
eseguire: `playwright install chromium`", con le opzioni `Scarica Chromium` / `Nega`. La richiesta
vale sempre una volta sola: non esiste "consenti sempre".

- Con `Scarica Chromium`, Chromium viene scaricato in `~/.keystone/browsers` (circa 150 MB,
  condiviso tra i profili) e poi la verifica parte.
- Con `Nega`, la review prosegue senza schermate e la verifica risulta "download di Chromium non
  consentito".

Finché non rispondi, la review di quel task aspetta. Se più task aspettano, la decisione è una
sola. Se l'orchestratore si riavvia, la decisione viene annullata e chiesta di nuovo.

## 7. Sicurezza e limiti

- **Il comando esegue il codice del branch dell'agente sul tuo computer**, come i test del
  repository. Lo stesso vale per il lato "prima", che esegue il codice del tuo branch. Configura la
  verifica solo per repository di cui ti fidi tanto quanto ti fidi dei loro test.
- **Rete solo locale.**
  - L'URL configurato deve essere locale.
  - Il browser blocca ogni richiesta HTTP e ogni WebSocket non locali, e lo annota nella review.
    I service worker sono bloccati e i download disattivati.
  - Il processo dell'app riceve `HTTP_PROXY`/`HTTPS_PROXY` verso un indirizzo inesistente. È un
    **freno**, non un isolamento: un programma che ignora le variabili del proxy può ancora
    raggiungere la rete esterna. Keystone non è una sandbox (vedi `docs/sicurezza.md`, 4bis).
- **Niente credenziali.** L'app riceve l'ambiente sicuro degli agenti, senza le variabili che
  finiscono in `API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, né le credenziali git.
- **Le schermate restano in `~/.keystone/<profilo>/visual/<task>/`.** Non vanno mai nel
  repository, nei log o nelle trascrizioni registrate con `--record`, da cui vengono tolti i dati
  delle immagini. L'app le chiede una per volta: l'orchestratore serve solo gli id dell'esito di
  quel task (`before-1`, `after-2`…), mai un percorso scelto dal client.
- **Solo app web.** App desktop, mobile o da riga di comando non sono supportate.
- **Una porta per volta.** I due lati usano la stessa porta, uno dopo l'altro. Se la tua app è già
  avviata su quella porta, fermala o configura un'altra porta.
- **Le pagine le sceglie il worker.** Una pagina che non indica non viene verificata. Il lead e tu
  potete chiedere modifiche se mancano pagine importanti.
- **Console, errori e richieste vanno al fornitore del modello.** Arrivano al lead nel testo della
  review e al worker nel risultato di `try_ui`, come già succede per l'output dei test. Un'app che
  scrive in console dati sensibili li manda al modello: usa dati di sviluppo.
