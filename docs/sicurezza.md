# Sicurezza git in Keystone

Questo documento spiega cosa possono e non possono fare gli agenti sul tuo repository, e come
funziona il merge approvato. Il codice è in `orchestrator/src/core/` (`repos.ts`, `gitsafety.ts`,
`policy.ts`, `shell.ts`). Ogni regola ha i suoi test in `orchestrator/test/` (`merge.test.ts`,
`push-block.test.ts`, `policy.test.ts`).

## 1. Worktree per task

- Ogni task lavora in un proprio git worktree, sul branch `Keystone/<agente>/<task>-<slug>`, nella
  cartella `~/.keystone/<profilo>/worktrees/<repo>/ks-<agente>-<task>`.
- Il tuo checkout non viene mai toccato dagli agenti. L'unica eccezione è un merge che approvi tu
  (§2).
- Gli agenti committano come `Keystone <Nome>` `<id@keystone.local>`, mai con la tua identità. Il
  commit di merge che approvi è invece tuo: usa la tua identità git ed è firmato se la tua
  configurazione firma i commit.
- Pulizia: le cartelle di worktree rimaste occupate (succede su Windows) vengono rimosse con più
  tentativi e poi con `git worktree prune`. Si possono ripulire a mano i worktree orfani con
  `npm run orchestrator -- --prune-worktrees` oppure con il messaggio `worktrees.prune`
  dall'interfaccia.
- **Branch degli agenti** (`Keystone/<agente>/<task>-…`). Keystone elimina solo branch il cui nome
  inizia con `Keystone/` (questa esatta grafia), mai uno estratto in un checkout o worktree, e
  sempre con `git update-ref -d <ref> <commit>`: se il branch non punta più al commit atteso resta
  dov'è. Tutto passa da `orchestrator/src/core/branches.ts`.
  - dopo un merge riuscito il branch dell'agente viene eliminato (`--keep-branches` per
    conservarlo); il diff unito resta consultabile dai commit salvati;
  - un task rifiutato conserva il branch, per recuperarlo. `--prune-worktrees` elenca i branch dei
    task rifiutati, annullati o completati senza merge e li elimina solo dopo conferma
    (`--confirm-branches` per confermare senza chiedere). Non compaiono i branch di task che
    possono ancora riprendere né quelli che il profilo non conosce;
  - `--reset` con `--demo` elimina tutti i `Keystone/*` del solo repository di prova creato da
    Keystone.

## 2. Merge approvato: come viene aggiornato il tuo checkout

Il merge avviene **solo** quando rispondi `Merge` a una decisione di merge.

1. **Lavoro committato.** Se l'agente ha lasciato modifiche non committate nel worktree, vengono
   committate sul suo branch con la sua identità.
2. **Controlli, prima di cambiare qualunque cosa:**
   - il checkout che ha la base estratta (di solito il tuo) non deve avere modifiche tracciate non
     committate, altrimenti il merge viene rifiutato e la decisione si riapre con il motivo;
   - il merge non deve avere conflitti (`git merge-tree`); in caso di conflitto vedi §3.
3. **Commit di merge costruito fuori dal tuo working tree.** `git merge-tree --write-tree` calcola
   l'albero unito e `git commit-tree` crea il commit, con due genitori: la tua HEAD attuale e il
   branch dell'agente. In questa fase il tuo indice e i tuoi file non vengono toccati.
4. **Applicazione al tuo checkout** (caso in cui la base è il branch che hai aperto):
   - **controllo a secco** con `git read-tree -n -m -u <HEAD> <merge>`: verifica che nessun file
     non tracciato verrebbe sovrascritto e che l'indice sia coerente. Se fallisce, il merge viene
     rifiutato e non è cambiato nulla;
   - si verifica che la tua HEAD sia ancora quella di partenza: se nel frattempo hai fatto un
     commit, il merge viene rifiutato;
   - `git merge --ff-only <merge>`: dato che il commit di merge ha come primo genitore la tua HEAD,
     è un **fast-forward**. Git aggiorna l'indice e solo i file cambiati, poi sposta il branch;
   - **verifica finale**: HEAD deve essere il commit di merge e `git status` non deve mostrare
     modifiche tracciate. Il tuo working tree risulta così allineato e pulito. I tuoi file non
     tracciati che il merge non riguarda restano dove sono.
5. **Atomicità.** Se uno dei passi del punto 4 fallisce (anche dopo il fast-forward, per esempio
   per un file bloccato su Windows), il checkout viene riportato al commit di partenza:
   `git reset --hard <commit di partenza>` più la rimozione dei file che il merge aveva aggiunto.
   È sicuro perché al punto 2 si è verificato che il checkout non avesse modifiche tracciate. Il
   tuo branch resta com'era e la decisione si riapre con il motivo.
6. **Se la base non è estratta da nessuna parte** (sei su un altro branch), si sposta solo il
   riferimento con `git update-ref <base> <nuovo> <vecchio>`. È un'operazione atomica e fallisce
   se nel frattempo la base è cambiata.
7. **Chiusura.** Il worktree viene rimosso e il branch dell'agente eliminato, solo se punta ancora
   al commit unito (`--keep-branches` per conservarlo). Il diff unito resta consultabile.

Le operazioni che cambiano worktree e branch di un repository sono serializzate, cioè eseguite una
alla volta.

## 3. Conflitti

Se al momento del merge la base è cambiata e c'è un conflitto, il merge non viene fatto, la
decisione viene chiusa con il motivo e il task torna al worker. Il worker esegue `git merge <base>`
nel suo worktree, risolve tenendo le modifiche di entrambe le parti, rilancia i test e committa.
Il task ripassa poi dai test e dalla review, e arriva una nuova decisione di merge.

## 4. Push bloccato a livello git

La policy (§5) nega `git push` quando lo vede. Ma un push può nascondersi in uno script, in un test
o in un hook, quindi è git stesso a rifiutarlo, con due livelli indipendenti.

**Livello 1: ambiente dei processi degli agenti** (ereditato da script, test e hook):

- `GIT_ALLOW_PROTOCOL=keystone-none`: nessun trasporto ammesso. Ha la precedenza su qualunque
  configurazione, anche su `git -c protocol.allow=always`;
- configurazione d'ambiente (`GIT_CONFIG_COUNT`), che ha precedenza su `.git/config` e sulla
  configurazione globale: `protocol.allow=never`, ogni URL di push riscritto verso un indirizzo
  inesistente, nessun credential helper, ssh disattivato, nessuna firma;
- nessun prompt di credenziali, nessun agent SSH, nessun token (`GH_TOKEN`, `GITHUB_TOKEN`, …);
- `GIT_CEILING_DIRECTORIES`: git non risale oltre il worktree.

**Livello 2: guardiano nel repository**, che regge anche a un ambiente sovrascritto o svuotato con
`env -i`:

- quando registri un repository, Keystone **ti mostra la modifica e chiede conferma** prima di
  aggiungere in fondo al suo `.git/config` queste due righe (il percorso cambia con il repository):

  ```ini
  [includeIf "gitdir/i:C:/percorso/del/repo/.git/worktrees/ks-*"]
  	path = C:/Users/<tu>/.keystone/git/agent-guard.gitconfig
  ```

  Senza conferma la registrazione si ferma e il file non cambia. Questo vale nell'interfaccia,
  con `repo.preview` e `repo.add { confirmGuard: true }`, e da riga di comando, dove `--repo`
  chiede `s/N` oppure richiede `--confirm-guard`. Fa eccezione solo il repository di prova creato
  da `--demo`;
- il file incluso sta in `~/.keystone/git/`, **fuori** da ogni repository e worktree. Per la policy
  è un **percorso protetto** insieme al `.git/config` del repository, ai dati dei worktree in
  `.git/worktrees` e al collegamento `.git` di ogni worktree: un agente non può scriverli,
  cancellarli né cambiare le chiavi `include`/`includeIf` (né con `git config` né con `git -c`).
  Questi comandi vengono **negati**, non chiesti, e nemmeno "Consenti sempre" li sblocca;
- vale **solo** nei worktree degli agenti (cartelle `ks-…`). Il tuo checkout, il tuo push e i tuoi
  fetch non cambiano: un test lo verifica;
- Keystone verifica che il guardiano sia attivo prima di creare un worktree e **prima di ogni turno
  di un worker**. Se manca o è stato manomesso, il turno non parte e il task si blocca con il
  motivo. Keystone non lo reinstalla mai da solo: serve registrare di nuovo il repository e
  confermare;
- se il file di Keystone viene cancellato, git ignora l'include e il tuo repository non si rompe.

**Come rimuovere il guardiano** da un repository (gli agenti non potranno più lavorarci finché non
lo registri di nuovo):

- da riga di comando: `npm run orchestrator -- --remove-git-guard "C:\percorso\del\repo"`;
- oppure con git: `git -C "C:\percorso\del\repo" config --local --remove-section "includeIf.gitdir/i:<percorso>/.git/worktrees/ks-*"`.
  Il nome esatto della sezione si vede con `git config --local --list --show-origin`;
- oppure a mano: apri `.git/config` del repository e cancella le due righe mostrate sopra.

**Livello 3: nessuna credenziale nei worktree degli agenti.** È un livello indipendente dai primi
due: vale anche se un comando riuscisse ad aggirare il blocco dei trasporti.

- Sia l'ambiente sia il guardiano impostano `credential.helper` vuoto, che azzera gli helper
  configurati prima (Git Credential Manager, `store`, …). Impostano anche
  `credential.interactive=never`, un `core.askPass` inesistente e un `core.sshCommand` che fallisce
  sempre.
- L'ambiente degli agenti non eredita l'agent SSH (`SSH_AUTH_SOCK`, `SSH_AGENT_PID`), i programmi
  per chiedere password (`GIT_ASKPASS`, `SSH_ASKPASS`), i comandi ssh personalizzati
  (`GIT_SSH`, `GIT_SSH_COMMAND`) né token (`GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `*_PAT`,
  variabili `GCM_*`, …).
- Test: un push con un `pushurl` valido verso un server HTTP locale che chiede l'autenticazione
  fallisce, sia con l'ambiente dell'agente sia con `env -i`. Il server viene raggiunto ma non
  riceve **nessuna** credenziale, mentre dal tuo checkout la stessa credenziale arriva
  (controprova). Anche ssh fallisce.
- Nota: la riga del guardiano viene aggiunta in fondo al `.git/config`, così il suo
  `credential.helper` vuoto azzera gli helper definiti prima. Se in futuro aggiungi a mano un
  helper *dopo* quella riga, nei worktree degli agenti lo azzera comunque l'ambiente (livello 1);
  resta scoperto solo il caso di un ambiente svuotato apposta.

I test dimostrano che il push fallisce:

- normale e con URL esplicito;
- con `git -c` (anche con `pushurl` e `pushInsteadOf` riscritti);
- con `GIT_ALLOW_PROTOCOL` riabilitato;
- con la configurazione d'ambiente azzerata o con `GIT_CONFIG_PARAMETERS` iniettato;
- con `env -i`;
- da uno script che ripulisce il proprio ambiente;
- da uno script npm lanciato dal loop dei test;
- da un hook `post-commit`.

Sono bloccati anche fetch e ls-remote nei worktree degli agenti, e la firma con le tue chiavi.

## 4bis. Limite: Keystone non è una sandbox

I tre livelli e la policy rendono molto difficile pubblicare qualcosa per errore o per un agente
troppo intraprendente, ma **non sono un isolamento del sistema operativo**:

- gli agenti girano con il tuo utente Windows e possono leggere ciò che legge il tuo utente, se
  approvi le richieste o se il codice lo fa da uno script (per esempio un test);
- un programma scritto apposta per aggirare i controlli può farlo. Per pubblicare dovrebbe, nello
  stesso comando, svuotare l'ambiente, riabilitare il protocollo, impostare un `pushurl` con `-c` e
  procurarsi credenziali che nei worktree non ci sono. La policy chiede approvazione per ciascuno
  di questi passi quando li vede, ma non vede dentro gli script;
- il codice che gli agenti scrivono ed eseguono (test, build) ha accesso alla rete come qualunque
  programma lanciato da te;
- **gli script del repository non passano dalla policy.** La policy guarda il comando che l'agente
  scrive, non quello che quel comando esegue. Quando un comando consentito lancia codice del
  repository, quel codice gira senza altri controlli:
  - `npm test` esegue lo script `test` di `package.json` e anche `pretest` e `posttest`;
  - `npm run build` esegue `prebuild`, `build` e `postbuild`;
  - `make` esegue le regole del `Makefile` (questo chiede, ma una volta approvato il resto no);
  - i test stessi (`vitest`, `pytest`, `cargo test`) eseguono il codice dei test e delle
    dipendenze già installate, compresi i plugin di configurazione (`vitest.config.*`,
    `conftest.py`, `build.rs`).

  Un agente può modificare questi file nel suo worktree e poi lanciare `npm test`: la modifica è
  visibile nel diff della review, ma viene eseguita prima che tu la veda. È il limite principale
  del "non è una sandbox".

**Raccomandazione.** Per repository sensibili (codice di lavoro, segreti, accessi a produzione)
usa Keystone in un ambiente separato: una **macchina virtuale**, oppure un **utente Windows
dedicato** senza accesso ai tuoi file, alle tue chiavi SSH e al tuo Git Credential Manager. In
quell'ambiente clona solo il repository su cui vuoi far lavorare gli agenti.

## 5. Policy dei permessi

Principio: **tutto ciò che non è esplicitamente consentito diventa una richiesta di permesso.**

**Consentito senza chiedere** (worker, dentro il suo worktree):

- letture (`Read`/`Grep`/`Glob`, `cat`, `ls`, `grep`, `rg`, `find` senza `-exec`/`-delete`, …);
- modifiche ai file (`Edit`/`Write`, `mkdir`, `cp`, `mv`, redirezioni);
- git locale: `status`, `diff`, `log`, `add`, `commit`, `merge`, `branch` in sola lettura,
  `config --get`;
- comandi di sviluppo: `npm test`, `npm run build/lint/typecheck/…`, `node <file>`, `tsc`,
  `vitest`, `pytest`, `cargo test` (vedi sopra: gli script che lanciano non sono controllati).

Il lead lavora in sola lettura nel tuo checkout: legge e usa git in lettura, tutto il resto chiede,
e non può modificare file.

**Chiede sempre**, senza la possibilità di "Consenti sempre" (la decisione offre solo
`Consenti una volta` / `Nega`):

- modifiche alla configurazione git (`git config` in scrittura, `git remote add/set-url`, …);
- `git -c …`, `--git-dir`, `--work-tree`, `--exec-path`, `--config-env`;
- variabili d'ambiente (`X=1 cmd`, `export`, `set`, `setx`, `unset`, `env X=… / -u / -i`,
  `$env:X`);
- hook e qualunque scrittura in un percorso `.git` (compreso il collegamento `.git` del worktree);
- `git hook`, `git worktree`, `gc`, `update-ref`, `filter-branch` e simili;
- **codice dalla rete o dai pacchetti**: installazioni e aggiornamenti di dipendenze
  (`npm/pnpm/yarn/bun install|ci|add|update`, `npm init <pacchetto>`, `npm audit fix`,
  `pip install`, `python -m pip`, `uv add|sync|run`, `pipx`, `poetry`, `pdm`, `conda`, `gem`,
  `bundle`, `composer`, `cargo install|add`, `go get|install`, `deno install`, `dotnet add|restore`,
  `brew`, `apt`, `winget`, `choco`, `scoop`) ed esecuzione di pacchetti scaricati al volo
  (`npx` o `npm exec` di un tool non installato o con `-y`/`@versione`, `pnpm dlx`, `yarn dlx`,
  `bunx`, `uvx`, `go run pacchetto@versione`, `deno run https://…`). Un'installazione può eseguire
  script dei pacchetti (`postinstall`), quindi ogni volta decidi tu.

**Chiede, con "Consenti sempre" limitato all'ambito mostrato:**

- percorsi fuori dal worktree: `..`, percorsi assoluti, `~`, `$HOME`, `%USERPROFILE%`, link
  simbolici e junction che portano fuori, `cd` fuori, `git -C` fuori. "Consenti sempre" vale per
  quel programma in quella cartella;
- rete: `curl`, `wget`, `ssh`, `git fetch/pull/clone`, URL negli argomenti. Vale per quel
  programma e quell'host;
- `npx`, `npm exec`, `pnpm exec` di un tool già installato nel progetto (in `node_modules/.bin`):
  esegue il codice di quel pacchetto. Vale per quel tool;
- comandi distruttivi: `rm`, `git reset --hard`, `git clean`, `git checkout -- .`,
  `find -delete`, `Remove-Item`, … Vale solo dentro il worktree, mai fuori;
- programmi sconosciuti, codice inline (`node -e`, `python -c`), script di shell, comandi di
  sistema. Vale solo per quel comando esatto.

**Negato sempre:**

- `git push` in qualunque forma visibile: anche dentro `bash -c`, `cmd /c`, `powershell -Command`,
  `$(…)`, backtick, `eval`, `find -exec`, `timeout`/`env`, alias definiti con `-c`, `lfs push`,
  `subtree push`, `send-pack`;
- la firma (`commit -S`, `tag -s`);
- le modifiche ai file da parte del lead;
- i sub-agenti.

Il classificatore usa un piccolo parser di shell (virgolette, operatori, redirezioni, here-doc,
sostituzioni, variabili) e analizza anche i comandi annidati. Quando non riesce a capire un
comando, chiede.

## 6. Dipendenze

- Tutte le dipendenze hanno versioni esatte, il lockfile è nel repository e `npm audit` deve
  risultare pulito.
- Regola generale: si usano versioni pubblicate da almeno due settimane. Una correzione di
  sicurezza ha la precedenza su questa regola.
- **Electron 44.10.1** (scelta del 31 ottobre 2026): le versioni 44.x fino alla 44.9.0 sono
  colpite dall'avviso [GHSA-jr5w-w6x2-84p9](https://github.com/advisories/GHSA-jr5w-w6x2-84p9)
  (certificati intermedi eMudhra compromessi, gravità alta), corretto dalla 44.9.1. Al momento
  della scelta nessuna 44.x corretta era uscita da almeno due settimane: la prima, la 44.9.1, era
  del 20 ottobre. Si usa quindi la 44.10.1, l'ultima della serie. Quando la 44.10.1 avrà più di
  due settimane la regola sarà di nuovo rispettata, senza bisogno di cambiare versione.

- **playwright-core 1.64.1** (pubblicata il 14 ottobre 2026), per la verifica visuale. È solo la
  libreria, senza browser: i browser di Playwright vengono scaricati soltanto dopo il tuo permesso
  (vedi `docs/verifica-visuale.md`).

## 6bis. Verifica visuale

Se la configuri per un repository, Keystone avvia l'app dal branch di partenza e dal worktree
dell'agente per catturare le schermate. Con la prova interfaccia (`try_ui`) il worker può chiedere
a Keystone di avviarla dal suo worktree durante il lavoro, con limiti per turno. In entrambi i casi
viene eseguito codice del branch, come per i test.

- Il browser raggiunge solo l'origine dell'app (stesso host e porta): né la rete esterna né altri
  servizi locali. Per il processo dell'app la rete esterna è frenata, non isolata.
- L'app riceve l'ambiente senza credenziali.
- Le schermate restano in `~/.keystone` e non finiscono nelle trascrizioni.
- Console, errori JavaScript e richieste fallite dell'app arrivano agli agenti come testo, quindi
  al fornitore del modello.
- Il download di Chromium chiede sempre il permesso.

Dettagli e limiti in `docs/verifica-visuale.md`.

## 6ter. Skill

Le skill sono regole in markdown che Keystone aggiunge alle istruzioni degli agenti (dettagli in
`docs/skill.md`).

- Le skill del repository si leggono dal **branch di destinazione**, dagli oggetti git: mai dal
  worktree dell'agente, dal tuo checkout o da un branch `Keystone/*`. Una skill modificata da un
  agente nel suo worktree non ha effetto finché non approvi il merge, e la review segnala la
  modifica come primo rischio.
- `.keystone/skills/` (nel worktree e nel checkout) e `~/.keystone/skills/` sono percorsi
  protetti: le scritture degli agenti sono negate, non chieste.
- Cancellare o spostare una cartella che contiene un percorso protetto (per esempio `.keystone`,
  `~/.keystone` o la cartella di lavoro stessa) con `rm`, `mv` e simili è negato allo stesso modo.
- Limite: la policy blocca le scritture dirette che riconosce (`Edit`/`Write`, redirezioni, `cp`,
  `mv`, `rm`, `tee`, `sed -i`, …), non quelle fatte da script o da comandi git nel worktree (per
  esempio uno script dei test, che esegue Keystone, o un `git checkout` di un altro branch). Per
  questo il blocco delle scritture non basta, e c'è una seconda difesa per ciascun posto:
  - skill del repository: la lettura dal branch di destinazione (cambiano solo con un merge tuo);
  - skill personali: Keystone consegna solo i file con l'impronta (SHA-256) di un contenuto che hai
    salvato o confermato nell'app. Un file creato o cambiato da fuori resta "da confermare" e non
    arriva agli agenti; la cartella non può essere un link o una junction.
- Limite residuo: le impronte stanno nello stato del profilo (`state.json`, percorso protetto nella
  policy come le skill), che però uno script può modificare come qualunque altro file
  dell'utente. Rendere la manomissione visibile richiederebbe
  di firmare lo stato con una chiave in `safeStorage`; per ora è annotato come limite, come gli
  altri effetti degli script (§5).
- Le funzioni native dei motori restano spente; le skill passano come testo nelle istruzioni.

## 6quater. File di configurazione

`~/.keystone/config.json` (dettagli in `docs/configurazione.md`):

- schema rigido: chiavi sconosciute o valori fuori dai limiti fermano l'avvio; non ci sono campi
  per chiavi API o token, né per le modalità dei permessi;
- il binario di Codex (`--codex-path`), il comando dei test (`--ci`) e la cartella delle
  trascrizioni (`--record`) restano solo da riga di comando: un file che resta sul disco non
  decide cosa viene eseguito;
- il file (e quello indicato con `--config`) è un percorso protetto: le scritture degli agenti
  sono negate, non chieste; un link simbolico o una junction al posto del file non vengono letti;
- il login personale (`useClaudeLogin`, `useCodexLogin`) attivato dal file è segnalato con un
  avviso a ogni avvio, perché un file dimenticato non lo attivi senza che tu lo veda;
- limite: come per le skill personali, la policy non vede dentro gli script (§5). Il file si legge
  solo all'avvio e il log di avvio elenca da dove viene la configurazione e cosa imposta. Tra il
  controllo (file normale) e la lettura non c'è atomicità: il rischio è basso perché il file è
  protetto per gli agenti.

## 7. Motore Claude

Dettagli in `docs/motore-claude.md`. In sintesi:

- ogni chiamata a un tool passa dalla policy di Keystone (un hook PreToolUse su tutti i tool più
  `canUseTool`). `permissionMode` è sempre `default` e non esiste una modalità che salti i permessi,
  nemmeno come opzione;
- gli agenti non ereditano la configurazione di Claude Code dell'utente: niente impostazioni, hook,
  server MCP, comandi, skill o `CLAUDE.md` globale. Lo verifica un test sulla CLI vera;
- di default si autentica solo via API (chiave o provider cloud); il login personale di Claude Code
  si abilita esplicitamente e usa solo il token di `claude setup-token`, mai i file di `~/.claude`;
- chiave API e token restano alla CLI: i comandi degli agenti, i server MCP stdio e gli hook non li
  vedono (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, verificato sulla CLI vera);
- ogni obiettivo ha un tetto di spesa: al raggiungimento gli agenti si fermano, il lavoro resta
  salvato e la decisione su come proseguire spetta a te.

## 8. Motore Codex

Dettagli in `docs/motore-codex.md`. In sintesi:

- Codex chiede l'approvazione prima di ogni comando (`approvalPolicy: "untrusted"`, verificato:
  anche i comandi di sola lettura). Ogni richiesta (comandi, modifiche di file, tool del team)
  passa dalla policy di Keystone con lo stesso vocabolario del motore Claude; le richieste di
  permessi aggiuntivi o di input all'utente sono rifiutate;
- le approvazioni non vanno mai a un revisore automatico (`guardian_approval` spento), e il
  modello non ha tool laterali: niente lettura di immagini, sub-agenti, browser, ricerca web;
- gli agenti non ereditano la configurazione di Codex dell'utente: `CODEX_HOME` di Keystone,
  nessun server MCP, nessun `AGENTS.md` (nemmeno del repository), skill di sistema disattivate,
  niente login shell. Lo verifica un test sulla CLI vera, con controprova;
- sandbox di Codex come seconda barriera: lead in sola lettura, worker con scrittura solo nel
  worktree e nelle cartelle git del suo branch, senza rete;
- la chiave API passa a Codex con `account/login/start` e resta in `~/.keystone/codex-home`: non è
  nell'ambiente del processo né in quello dei comandi;
- Codex riporta solo token: il freno per obiettivo sono i limiti di turni e di tempo.
