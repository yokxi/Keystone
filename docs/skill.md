# Skill: regole per gli agenti

Una skill è un file markdown con una regola per gli agenti: come scrivere i commit, quali librerie
usare, cosa controllare in review. Keystone la mette nelle istruzioni del turno, allo stesso modo
con Claude e con Codex.

## Dove stanno

| Posto | Percorso | Chi la vede | Quando vale |
|---|---|---|---|
| Repository | `.keystone/skills/<id>.md` nel repository | tutto il team, tramite git | quando è committata sul **branch di destinazione** |
| Personale | `~/.keystone/skills/<id>.md` | solo tu, in tutti i tuoi repository | subito, se salvata dall'app; se creata o cambiata da fuori, dopo che la confermi |

`<id>` è il nome del file: minuscole, cifre e trattini (es. `messaggi-di-commit`). Altri nomi, le
sottocartelle, i link simbolici e i file più grandi di 12 000 byte vengono ignorati e segnalati.
Al massimo 50 skill per posto.

## Il formato

```markdown
---
nome: Messaggi di commit
descrizione: come scrivere i messaggi di commit
per: worker
quando: lavoro
file: src/api/**, *.sql
attiva: sì
---
Scrivi i messaggi in italiano, nello stile `feat(area): ...`.
```

| Chiave | Valori | Predefinito |
|---|---|---|
| `nome` | una riga, obbligatorio | — |
| `descrizione` | una riga | nessuna |
| `per` | `lead`, `worker`, `tutti` | `tutti` |
| `quando` | `sempre`, `piano` (il lead pianifica), `lavoro` (il worker lavora), `review` (il lead rivede), anche più d'uno separati da virgole | `sempre` |
| `file` | schemi di file separati da virgole: `**` come nome di cartella vale per zero o più cartelle, `*` e `?` dentro un nome (`**` dentro un nome vale come `*`); uno schema senza `/` vale per il nome del file in qualsiasi cartella (`*.sql`). Maiuscole e minuscole non contano. Il confronto non usa espressioni regolari e ha un tempo limitato anche con schemi scritti apposta | nessuno: vale per ogni lavoro |
| `attiva` | `sì`, `no` | `sì` |

Il testo della regola (fino a 8000 caratteri) viene dopo la seconda riga `---`. Chiavi sconosciute
o ripetute rendono il file non valido: la pagina Skill lo mostra con l'errore e gli agenti non lo
ricevono.

**Con `file`:** la skill vale se il lavoro tocca file che corrispondono (le modifiche già nel
worktree del task, per il worker e per la review del lead) oppure se la richiesta (obiettivo o
task) cita un percorso che corrisponde. Limite: al primo turno di un task il worktree è ancora
vuoto, quindi conta solo il testo del task; dalla review in poi contano anche i file modificati.

## Come arrivano agli agenti

A ogni turno Keystone sceglie le skill valide, attive e che valgono per ruolo, fase e file, e le
aggiunge alle istruzioni del turno in una sezione "Skill: regole del progetto", prima quelle del
repository e poi le personali. Le stesse istruzioni vanno al motore Claude (prompt di sistema) e al
motore Codex (istruzioni dello sviluppatore), sia all'avvio sia alla ripresa di una sessione.

- Al massimo 24 000 caratteri di skill per turno: quelle che non entrano non vengono troncate ma
  lasciate fuori, e il log dell'agente le elenca.
- Il pannello dell'agente mostra quali skill ha ricevuto nell'ultimo turno; il log lo scrive a ogni
  turno.
- Le skill non cambiano le regole di Keystone (permessi, niente push, merge solo tuo): il testo lo
  dice all'agente, e comunque la policy si applica a ogni azione.
- Le funzioni native dei motori restano spente: niente skill, memoria, impostazioni, server MCP,
  `CLAUDE.md` o `AGENTS.md` dei motori. Le skill di Keystone non usano quei meccanismi.

Con il checkout su un HEAD staccato e senza un branch di destinazione configurato, le skill del
repository non vengono consegnate (non c'è un branch da cui leggerle): la pagina Skill lo segnala e
il log dell'agente lo scrive.

## Sicurezza

- **Lette dal branch di destinazione.** Le skill del repository vengono lette dagli oggetti git del
  branch di destinazione (quello configurato in "merge in", oppure il branch aperto), mai dal
  worktree dell'agente né dai file del tuo checkout. Per il worker è la base del suo worktree, cioè
  il branch in cui il lavoro verrà unito. Un agente che modificasse una skill nel suo worktree, anche
  committandola sul suo branch, non cambierebbe le regole che riceve lui né gli altri. Un branch
  degli agenti (`Keystone/*`) non è mai una fonte di skill.
- **Percorso protetto.** `.keystone/skills/` (nel worktree e nel tuo checkout) e
  `~/.keystone/skills/` sono percorsi protetti nella policy: scriverci, cancellarci o copiarci file
  è **negato**, non chiesto, e "Consenti sempre" non lo sblocca.
- **Skill personali: solo contenuti confermati da te.** La policy non vede dentro gli script (per
  esempio gli script dei test, che esegue Keystone): uno script potrebbe scrivere in
  `~/.keystone/skills/`. Per questo Keystone ricorda l'impronta (SHA-256) di ogni skill personale
  salvata dall'app e consegna agli agenti solo i file con un'impronta ricordata. Un file creato o
  cambiato da fuori (a mano, da un altro programma, da uno script) compare nella pagina Skill come
  **da confermare** e non arriva agli agenti finché non premi **Conferma**; il log dell'agente lo
  segnala. La conferma vale solo per il contenuto che hai sotto gli occhi: se il file cambia
  ancora, va confermato di nuovo. La cartella `~/.keystone/skills` deve essere una cartella vera
  (non un link o una junction) dentro `~/.keystone`. Le skill personali che c'erano prima di
  questa regola, o copiate a mano nella cartella, compaiono come "da confermare": non sono sparite,
  basta confermarle una volta.
- **Nella review.** Se un task modifica `.keystone/skills/`, il riassunto della review lo mette per
  primo tra i rischi: dopo il merge quelle regole arriveranno a tutti gli agenti.
- **Le skill sono testo per il modello.** Arrivano al fornitore del modello come le altre
  istruzioni: non metterci segreti.
- **Scritture dall'interfaccia.** Keystone scrive solo `.keystone/skills/<id>.md` nel tuo checkout e
  `~/.keystone/skills/<id>.md`, con nomi validati; rifiuta cartelle o file che sono link simbolici o
  junction, o che portano fuori dal repository.

I test: `orchestrator/test/skills.test.ts` (lettura dal branch, worktree manomesso, branch degli
agenti, percorsi protetti, consegna nelle istruzioni, interfaccia), `shared/test/skills.test.ts`
(formato e applicabilità), `orchestrator/test/codex-engine.test.ts` (istruzioni a Codex all'avvio e
alla ripresa), `app/e2e/security.e2e.ts` (dalla review alla skill ricevuta dal worker).

## Nell'interfaccia

- **Pagina Skill**: le skill di ogni repository registrato e quelle personali, con lo stato (attiva,
  disattivata, non valida, da committare, da confermare). **Nuova skill** e **Modifica** scrivono il file. Le skill
  del repository vanno nel tuo checkout e valgono solo dopo il commit sul branch di destinazione: la
  pagina mostra "da committare" finché il checkout è diverso dal branch. **Attiva per me** /
  **Disattiva per me** valgono solo per te e non toccano il file (stanno nelle impostazioni del
  profilo); **Usa "attiva" del file** toglie la scelta. **Rileggi** aggiorna l'elenco dopo un commit
  fatto fuori da Keystone. **Conferma** (solo per le personali da confermare) le fa arrivare agli
  agenti. Modificare o cancellare dalla pagina una skill del repository già committata lascia il
  checkout con modifiche non committate: finché non committi, i merge di quel repository si fermano
  (la pagina lo ricorda). Una skill nuova, non ancora tracciata da git, non li blocca.
- **Review**: con "Salva la correzione come skill", il testo di "Richiedi modifiche" diventa una
  skill (personale di default; puoi scegliere il repository), per il worker durante il lavoro, per
  il lead in review o per tutti. La skill si salva prima della richiesta: se non si salva, la
  richiesta non parte e vedi l'errore.
- **Agenti**: "skill ricevute nell'ultimo turno".

## Uso in team

Ognuno ha Keystone sul proprio PC. Le skill del repository si condividono con i normali commit,
push e pull; quelle personali restano tue. Non c'è un server condiviso.
