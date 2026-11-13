# Resoconto — Fase 11 (un merge per obiettivo)

Hai chiesto di dover approvare solo il merge finale, invece di un merge per ogni task.

## Cosa è fatto

- **Branch dell'obiettivo.** Nasce con l'obiettivo: `Keystone/goal/<id>`, dal tuo branch. I
  worktree dei task partono da lì.
- **I task si uniscono da soli nel branch dell'obiettivo**, dopo la review del lead
  (`request_merge`). Il merge è automatico ma resta controllato:
  - va solo verso il branch di quell'obiettivo, mai verso il tuo checkout;
  - il commit è di Keystone e non è mai firmato;
  - un conflitto torna al worker, come prima.
- **Una sola decisione finale.** Quando tutti i task sono fatti, Keystone estrae il branch
  dell'obiettivo in un suo worktree e ci esegue i test sul lavoro completo. Poi ti manda la
  decisione con la diff di tutto l'obiettivo, i riassunti dei task e l'esito dei test. Il merge nel
  tuo branch parte solo dal pulsante ed è quello atomico di sempre.
- **Le risposte alla decisione:**
  - "Richiedi modifiche": il lead crea i task necessari, che partono dal lavoro già unito;
  - "Rifiuta": l'obiettivo si chiude e il branch resta;
  - conflitto con il tuo branch: un task chiede a un worker di unirlo e risolvere.
- **Si unisce solo ciò che hai rivisto.** La decisione registra il commit. Se il branch cambia
  prima del click, per un task nuovo o per un commit fatto dai test, arriva una nuova decisione.
- **Difetto preesistente corretto.** I file lasciati dai test venivano committati con il lavoro
  dell'agente, anche nel merge per task. Ora Keystone toglie quelli comparsi durante i test,
  risolvendo link e junction, e non tocca il lavoro dell'agente non ancora committato.
- **Il flusso per task resta disponibile** con `"mergePerTask": true` in `config.json`. Gli
  obiettivi creati prima di questa fase restano su quel flusso.

## Scelte prese e perché

- **Il lead continua a rivedere ogni task.** Il controllo di qualità resta fine; a te arriva una
  sola decisione.
- **Nessun commit nel worktree dell'obiettivo.** Dopo i test viene ripulito, così i file creati dai
  test non entrano mai nella diff né nel tuo branch.
- **Branch mai riusati.** Un `Keystone/goal/g1` rimasto da un obiettivo rifiutato non viene
  riusato: si crea `g1-2`. Meglio un nome in più che unire lavoro vecchio.
- **"Richiedi modifiche" vuole un testo.** Senza, il lead non saprebbe cosa cambiare e la decisione
  tornerebbe identica.
- **Il merge di ogni task resta visibile nel feed.** Così si vede il percorso del lavoro anche
  senza decisioni intermedie.

## Rischi e limiti

- La verifica visuale resta per task. Nella decisione finale compaiono i riassunti di ciascun task,
  ma non c'è una verifica visuale sul lavoro unito.
- I test finali eseguono codice scritto dagli agenti, senza sandbox (§4bis). Se cambiano il branch
  dell'obiettivo la decisione non viene creata e ricevi un avviso. Per rimettere in moto
  l'obiettivo serve un tuo intervento, per esempio annullare e ridare l'obiettivo.
- Con il sim il conflitto finale porta a un task che il sim non sa risolvere davvero. Con Claude il
  worker esegue `git merge` e risolve. Il test verifica che il task venga creato e che il tuo
  branch non cambi.

## Test

- Nuovi: `goal-merge.test.ts` (7 test) e `goal-merge-review.test.ts` (10 test). Coprono:
  - il flusso completo: una sola decisione, il checkout invariato fino al Merge, un solo merge nel
    tuo branch con la tua identità;
  - i file dei test che non entrano nella diff né nel tuo branch;
  - il checkout con modifiche, "Rifiuta", "Richiedi modifiche", anche senza testo;
  - le guardie di `mergeIntoGoal`: un altro branch dell'obiettivo, il branch aperto nel tuo
    checkout, un checkout su un branch di Keystone;
  - il lavoro cambiato dopo la review e il task nuovo con la decisione aperta;
  - la junction fuori dal worktree, l'obiettivo in pausa, il conflitto finale;
  - i merge automatici mai firmati, anche con `commit.gpgsign=true`;
  - il branch già esistente.
- Controprove: per ogni protezione, togliendola almeno un test fallisce (13 controprove).
- Chiusura: typecheck pulito due volte. Suite completa due volte: 49 file, 656 test superati. Test
  dell'interfaccia: 6 su 6.

## Parere del revisore

Tre giri.

1. **Primo giro.** Un bloccante e quattro punti da correggere:
   - bloccante: il merge automatico si fidava del prefisso `Keystone/goal/`, e poteva portare
     lavoro in un tuo checkout aperto su un branch con quel nome;
   - il lavoro poteva cambiare tra la review e il click;
   - la pulizia non risolveva link e junction;
   - un obiettivo in pausa produceva comunque la decisione, e "Richiedi modifiche" senza testo
     tornava indietro identica;
   - gli obiettivi vecchi finivano a metà tra i due flussi.
2. **Secondo giro.** Un bloccante introdotto dalla correzione: il worktree finale usava il nome del
   branch ricavato dall'id invece di quello vero con il suffisso.
3. **Terzo giro.** Nessun bloccante.
