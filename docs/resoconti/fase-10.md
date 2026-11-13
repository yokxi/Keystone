# Resoconto — Fase 10 (meno richieste di permesso)

Nata dalla prima prova reale con l'abbonamento Claude (13 novembre 2026): un obiettivo piccolo ha
prodotto 9 richieste di permesso Bash. Hai scelto di tenere la regola "tutto ciò che non è
esplicitamente consentito chiede" e di allargare solo i consentiti verificabili.

## Le 9 richieste della prova

1. **Letture composte del lead** (`git ls-files | head`, `wc -c $(…)`). L'output di un comando
   usato come percorso non è verificabile, quindi chiedono ancora. Le istruzioni ora dicono di
   usare Read/Grep/Glob.
2. **Modifiche fatte con `python - <<EOF`** invece di Edit. È codice arbitrario, quindi chiede
   ancora. Le istruzioni ora dicono di usare Edit/Write.
3. **Schermate fatte dall'agente con Edge in `/tmp`.** Spettano a Keystone, quindi chiedono
   ancora. Le istruzioni ora dicono di non avviare browser e server, e al lead di non creare task
   di sola verifica.

## Cosa è fatto

- **Consentite le forme comuni e verificabili:**
  - il messaggio di `git commit` scritto con `-m "$(cat <<'EOF' … EOF)"` (o con echo/printf di
    testo fisso), solo tra virgolette e solo come messaggio;
  - i cicli e le condizioni della shell, valutati in base al comando che contengono.
- **Istruzioni agli agenti** (`WORK_WITHOUT_ASKING` in `prompts.ts`), con un test che verifica che
  le forme raccomandate siano davvero consentite.
- **Bypass della policy corretti**, alcuni preesistenti:
  - here-doc: un comando nascosto nel corpo, o la chiusura `<<-` con tabulazioni;
  - `((…))` e `$((…))` con `<<`;
  - valori attaccati alle opzioni (`git commit -F/etc/passwd`, `grep -f/x`, opzioni raggruppate,
    lettere di unità);
  - `rg --pre`, `printf -v`, `${VAR:=…}`;
  - espansioni che valutano una variabile (`${x@P}`, `${x:N}`, `${!x}`, `$[…]`);
  - `set` con opzioni che cambiano la shell.

## Scelte prese e perché

- **`read` e `for` chiedono sempre.** Nella prima versione erano consentiti verso nomi minuscoli.
  Quattro giri di revisione hanno mostrato che una variabile con contenuto scelto dall'agente
  finisce in comandi che la policy non può verificare: `sed "$x"`, `printf $x`, `rg $x`,
  `git commit -m $x`, `${x:x}`. Ho scelto di tornare indietro invece di continuare a chiudere
  casi singoli.
- **Sostituzione di solo testo consentita solo come messaggio di commit tra virgolette.** Era una
  delle due opzioni indicate dal revisore, la più stretta.
- **Il buco preesistente sui valori attaccati alle opzioni corretto subito** e non rimandato.
  Riguarda la stessa regola di sicurezza.

## Rischi e limiti

- La policy legge i comandi con un parser suo, non con bash: forme di shell rare possono essere
  lette diversamente. Quando non capisce, chiede. I casi noti sono coperti da test, compreso un
  test che avvolge 10 comandi pericolosi in 12 forme di shell.
- Meno richieste dipendono anche dal fatto che gli agenti seguano le istruzioni. Se non lo fanno,
  la policy chiede come prima: nessun rischio, solo più domande.

## Test

- Typecheck pulito due volte. Suite completa due volte: 47 file, 639 test superati. Test
  dell'interfaccia: 6 su 6.
- Ogni correzione di sicurezza ha una controprova: tolta la protezione, almeno un test fallisce.
  Una controprova inizialmente non falliva (opzioni raggruppate, lettera di unità), perché un altro
  ramo copriva lo stesso caso; ho aggiunto un caso che passa solo da quella protezione e rifatto
  la controprova.

## Parere del revisore

Cinque giri.

1. Primo giro: `read` cambiava l'ambiente, la sostituzione letterale lasciava passare i percorsi
   attaccati alle opzioni, `<<` dentro `$((`. Segnalati anche i valori attaccati preesistenti.
2. Secondo giro: `((` al livello più alto, opzioni raggruppate, eccezione del commit decisa sul
   testo invece che per comando, `printf -v`, nomi di variabile su Windows.
3. Terzo giro: `((` dopo una parola chiave, `${x@P}`, `-m $(…)` senza virgolette, lettera di
   unità.
4. Quarto giro: i bypass tramite il valore delle variabili di `read`/`for`, che hanno portato a
   ritirarli.
5. Quinto giro: **nessun bloccante**. Il confronto automatico su 8462 comandi, tra la policy prima
   della Fase 10 e quella attuale, mostra che le uniche nuove aperture sono le parole chiave della
   shell attorno a programmi già consentiti. Il suggerimento di un test parametrico sugli
   avvolgimenti è stato accolto.
