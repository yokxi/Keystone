# Resoconto — Fase Skill (regole per gli agenti e review sul riassunto)

## Cosa è fatto

- **Formato** delle skill (`shared/src/skills.ts`): intestazione con `nome`, `descrizione`, `per`,
  `quando`, `file`, `attiva`; chiavi sconosciute o ripetute rendono il file non valido. Schemi di
  file senza espressioni regolari, con tempo limitato.
- **Due posti**: `.keystone/skills/` nel repository (condivise con git) e `~/.keystone/skills/`
  (personali).
- **Lettura dal branch di destinazione** per le skill del repository: dagli oggetti git
  (`ls-tree` / `cat-file`), mai dal worktree dell'agente, dal checkout o da un branch `Keystone/*`.
  Niente link simbolici (modo 120000), sottocartelle, file troppo grandi, oltre 50 skill.
- **Skill personali solo se confermate**: Keystone ricorda l'impronta SHA-256 di ogni skill
  personale salvata dall'app e consegna solo i file con un'impronta ricordata. Un file creato o
  cambiato da fuori compare come "da confermare" e arriva agli agenti solo dopo **Conferma**, che
  vale per il contenuto mostrato (se il file cambia ancora, la conferma è rifiutata).
- **Percorsi protetti**: `.keystone/skills/` (worktree e checkout) e `~/.keystone/skills/` negati,
  non chiesti. In più: cancellare una cartella che *contiene* un percorso protetto, o spostarla
  come sorgente (`rm -rf .keystone`, `mv .keystone x`, `rm -rf .` nel worktree), è negato; anche
  `state.json` del profilo (dove stanno le impronte) è un percorso protetto.
- **Consegna uguale a Claude e Codex**: sezione "Skill: regole del progetto" nelle istruzioni del
  turno, entro 24 000 caratteri; quelle che non entrano vengono elencate, non troncate. Funzioni
  native dei motori sempre spente.
- **Interfaccia**: pagina Skill (crea, modifica, cancella, attiva/disattiva solo per te, conferma
  le personali, avviso sui merge bloccati da una skill tracciata modificata); "Salva la correzione
  come skill" in "Richiedi modifiche"; skill ricevute nel pannello dell'agente.
- **Review sul riassunto**: la review si apre su richiesta, cosa è stato fatto e perché, file
  toccati, esito dei test, schermate, rischi (modifiche alle skill del repository per prime); il
  diff è in una scheda separata.
- Fuori tema ma corretti nel frattempo: il server non cade più se un client rifiutato resetta la
  connessione (ECONNRESET su Windows); un test di ripresa che dipendeva dai tempi (vedi sotto).

## Scelte prese e perché

- **Impronte per le skill personali** (scelta presa dopo la revisione). La policy non vede dentro gli
  script, e i test li esegue Keystone: uno script di test scritto dall'agente poteva creare
  `~/.keystone/skills/x.md` e condizionare tutti gli agenti in tutti i repository, senza review.
  Le alternative erano documentare il limite e basta, oppure togliere le skill personali. Ho scelto
  la più prudente che le tiene: serve una conferma esplicita per ogni contenuto non salvato
  dall'app. Chi scrive le skill a mano nella cartella deve confermarle una volta nella pagina.
- **La conferma porta l'impronta** mostrata all'utente, così non si conferma un contenuto cambiato
  tra la lettura e il clic.
- **Regola dell'antenato nella policy solo per cancellare e per le sorgenti di uno spostamento**: la
  destinazione di `mv` (l'ultima, o quella di `-t` / `-Destination`) non si sposta, quindi
  `mv x .` resta un'operazione normale. Per gli altri programmi che scrivono (`cp x .`, `touch`)
  una cartella che contiene percorsi protetti non viene toccata nel suo insieme.
- **Stato del profilo protetto, non tutta la cartella del profilo**: i worktree stanno dentro la
  cartella del profilo, quindi proteggerla tutta bloccherebbe il lavoro; si proteggono
  `state.json` e `state.json.bak`.
- **`skill.toggle`** con `enabled` vero o falso richiede che la skill esista, così lo stato non
  accumula chiavi inutili; `null` (togliere la scelta) resta sempre possibile.

## Rischi e limiti

- Le impronte stanno nello stato del profilo in `~/.keystone`: uno script che modificasse anche
  quello potrebbe far passare una skill personale. Per renderlo visibile servirebbe firmare lo stato
  con una chiave in `safeStorage`; annotato in `docs/sicurezza.md` §6ter come limite.
- Schema `file:` al primo turno di un task: il worktree è vuoto, conta solo il testo del task.
- Le skill sono testo per il modello: arrivano al fornitore come le altre istruzioni.
- Modificare dall'app una skill del repository già committata lascia il checkout con modifiche non
  committate e ferma i merge finché non committi (si ferma in modo pulito; la pagina lo dice).

## Test

- Test di sicurezza e mutazioni (ogni protezione tolta fa fallire il suo test):
  - percorsi skill tolti dai percorsi protetti → fallisce "scrivere in .keystone/skills … è negato";
  - esclusione dei branch `Keystone/*` tolta → fallisce "mai da un branch degli agenti";
  - worker che legge il proprio branch → fallisce anche "il worker riceve la skill del branch di
    destinazione";
  - controllo delle impronte tolto → falliscono i due test sulle skill personali create da fuori;
  - regola dell'antenato tolta → fallisce "mv, tee, sed -i e le operazioni sulla cartella .keystone";
  - `state.json` tolto dai percorsi protetti → fallisce lo stesso test.
- Test instabile corretto: `recovery.test.ts` aspettava solo che il worker fosse al lavoro, ma la
  sessione del motore viene registrata poco dopo l'inizio del turno: a seconda dei tempi il test
  leggeva la sessione prima che esistesse. Ora aspetta anche la sessione.
- Risultati finali: typecheck pulito; `npm test` due volte: 35 file, 517 test passati entrambe le
  volte; `npm run test:ui`: 4 test passati.

## Parere del revisore

Prima revisione: nessun bloccante. Da correggere: resoconto e tag mancanti; skill personali lette da
disco senza un passaggio da te (corretto con le impronte); copertura dei test sui link e su altri
comandi (aggiunta, e ha trovato il caso `rm -rf .keystone`, corretto). Suggerimenti accolti: avviso
sui merge bloccati, `skill.toggle` solo su skill esistenti. Non accolto: un test per il limite di
`file:` al primo turno (resta documentato).

Ricontrollo delle correzioni: nessun bloccante. Da correggere: la regola dell'antenato negava anche
`mv a.txt .` (la destinazione), corretto applicandola solo alle sorgenti, con test che `mv x .`,
`mv x ./`, `mv -t . x` restino consentiti. Suggerimenti accolti: `state.json` tra i percorsi
protetti; una riga in `docs/skill.md` sulle skill personali già presenti, che diventano "da
confermare". Verificato dal revisore: impronta e contenuto consegnato vengono dagli stessi byte
(niente TOCTOU), BOM e CRLF cambiano l'impronta, la conferma rifiuta contenuti cambiati.
