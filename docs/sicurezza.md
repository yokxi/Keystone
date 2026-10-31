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
  dall'interfaccia. I branch restano sempre.

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
7. **Chiusura.** Il worktree viene rimosso, il branch dell'agente resta e il diff unito resta
   consultabile.

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

- quando registri un repository, Keystone aggiunge al suo `.git/config` una riga
  `includeIf "gitdir/i:<.git>/worktrees/ks-*"` che include il file
  `~/.keystone/<profilo>/git/agent-guard.gitconfig`, con le stesse regole del livello 1;
- vale **solo** nei worktree degli agenti (cartelle `ks-…`). Il tuo checkout, il tuo push e i tuoi
  fetch non cambiano: un test lo verifica;
- prima di consegnare un worktree a un agente, Keystone verifica che il guardiano sia attivo; se
  non lo è, si rifiuta;
- se il file di Keystone viene cancellato, git ignora l'include e il tuo repository non si rompe;
- per toglierlo: `npm run orchestrator -- --remove-git-guard <percorso del repo>`.

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

**Limite noto.** Non è una sandbox del sistema operativo. Per aggirare il blocco servono **insieme**
la manomissione dell'ambiente e della configurazione: per esempio svuotare l'ambiente, riabilitare
il protocollo e impostare un `pushurl` con `-c`, tutto nello stesso comando. La policy chiede
approvazione per ciascuno di questi passi quando li vede.

## 5. Policy dei permessi

Principio: **tutto ciò che non è esplicitamente consentito diventa una richiesta di permesso.**

**Consentito senza chiedere** (worker, dentro il suo worktree):

- letture (`Read`/`Grep`/`Glob`, `cat`, `ls`, `grep`, `rg`, `find` senza `-exec`/`-delete`, …);
- modifiche ai file (`Edit`/`Write`, `mkdir`, `cp`, `mv`, redirezioni);
- git locale: `status`, `diff`, `log`, `add`, `commit`, `merge`, `branch` in sola lettura,
  `config --get`;
- comandi di sviluppo: `npm test`, `npm run build/lint/typecheck/…`, `npx <tool installato>`,
  `node <file>`, `tsc`, `vitest`, `pytest`, `cargo test`, `go test`.

Il lead lavora in sola lettura nel tuo checkout: legge e usa git in lettura, tutto il resto chiede,
e non può modificare file.

**Chiede sempre**, senza la possibilità di "Consenti sempre" (la decisione offre solo
`Consenti una volta` / `Nega`):

- modifiche alla configurazione git (`git config` in scrittura, `git remote add/set-url`, …);
- `git -c …`, `--git-dir`, `--work-tree`, `--exec-path`, `--config-env`;
- variabili d'ambiente (`X=1 cmd`, `export`, `set`, `setx`, `unset`, `env X=… / -u / -i`,
  `$env:X`);
- hook e qualunque scrittura in un percorso `.git` (compreso il collegamento `.git` del worktree);
- `git hook`, `git worktree`, `gc`, `update-ref`, `filter-branch` e simili.

**Chiede, con "Consenti sempre" limitato all'ambito mostrato:**

- percorsi fuori dal worktree: `..`, percorsi assoluti, `~`, `$HOME`, `%USERPROFILE%`, link
  simbolici e junction che portano fuori, `cd` fuori, `git -C` fuori. "Consenti sempre" vale per
  quel programma in quella cartella;
- rete: `curl`, `wget`, `ssh`, `npm install`, `pip install`, `git fetch/pull/clone`, `npx` di un
  tool non installato, URL negli argomenti. Vale per quel programma e quell'host;
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
