// Policy dei permessi: default "chiedi"; approvazione obbligatoria (non memorizzabile) per config
// git, variabili d'ambiente, hook e `git -c`; percorsi fuori dal worktree (.., assoluti, link
// simbolici), rete e comandi distruttivi chiedono; git push è sempre negato.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { classify, type PolicyContext, type Verdict } from '../src/core/policy.js';
import { parseShell } from '../src/core/shell.js';

let wt = '';
let outside = '';
let linkOk = false;
let fileLinkOk = false;

beforeAll(() => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-policy-')));
  wt = path.join(base, 'ks-bruno-t1');
  outside = path.join(base, 'fuori');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'segreto.txt'), 'segreto');
  fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'x');
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: altrove');
  fs.mkdirSync(path.join(wt, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'node_modules', '.bin', 'vitest'), '');
  // un link (junction su Windows: non serve essere amministratori) che porta fuori dal worktree
  try {
    fs.symlinkSync(outside, path.join(wt, 'link'), 'junction');
    linkOk = true;
  } catch {
    linkOk = false;
  }
  try {
    fs.symlinkSync(path.join(outside, 'segreto.txt'), path.join(wt, 'link-file.txt'), 'file');
    fileLinkOk = true;
  } catch {
    fileLinkOk = false; // su Windows i symlink di file richiedono la modalità sviluppatore
  }
});

const worker = (): PolicyContext => ({ role: 'worker', cwd: wt });
const lead = (): PolicyContext => ({ role: 'lead', cwd: wt });
const bash = (command: string, ctx = worker()) => classify('Bash', { command }, ctx);
const ps = (command: string, ctx = worker()) => classify('PowerShell', { command }, ctx);

function expectAction(v: Verdict, action: Verdict['action'], label: string) {
  expect(v.action, `${label} -> ${v.action}: ${v.reason}`).toBe(action);
}
function expectAskAlways(v: Verdict, label: string) {
  expectAction(v, 'ask', label);
  if (v.action === 'ask') expect(v.sticky, `${label} dovrebbe richiedere sempre approvazione`).toBe(false);
}

describe('consentito senza chiedere (worker, dentro il worktree)', () => {
  it.each([
    'ls -la',
    'cat src/a.ts',
    'grep -rn "TODO" src',
    'rg foo src',
    'git status',
    'git diff HEAD~1 -- src',
    'git log --oneline -5 | head -3',
    'git add -A && git commit -m "fix: gestisce ../ nei percorsi"',
    'git merge main',
    'git config --get user.name',
    'git branch --show-current',
    'npm test',
    'npm run build',
    'pnpm test',
    'node src/a.ts',
    'python -m pytest -q',
    'cargo test',
    'echo ciao > note.txt',
    'mkdir -p out/b && cp src/a.ts out/b/',
    'cd src && cat a.ts',
    'set -e',
    'npm test 2>&1 | tail -20',
    'git diff > /dev/null',
  ])('%s', (cmd) => expectAction(bash(cmd), 'allow', cmd));

  it('Read/Edit/Write dentro il worktree', () => {
    expectAction(classify('Read', { file_path: path.join(wt, 'src', 'a.ts') }, worker()), 'allow', 'Read');
    expectAction(classify('Edit', { file_path: 'src/a.ts' }, worker()), 'allow', 'Edit');
    expectAction(classify('Write', { file_path: path.join(wt, 'nuovo', 'b.ts') }, worker()), 'allow', 'Write');
  });

  it('PowerShell: letture dentro il worktree', () => {
    expectAction(ps('Get-Content src/a.ts'), 'allow', 'Get-Content');
    expectAction(ps('Get-ChildItem src'), 'allow', 'Get-ChildItem');
  });
});

describe('percorsi fuori dal worktree: chiede', () => {
  it.each([
    'cat ../fuori/segreto.txt',
    'cat ../../../etc/passwd',
    'ls ~',
    'cat $HOME/.ssh/id_rsa',
    'type %USERPROFILE%\\.gitconfig',
    'echo x > ../out.txt',
    'cp src/a.ts ../copia.ts',
    'cd .. && cat fuori/segreto.txt',
    'git -C .. status',
    'grep -r password ..',
    'find .. -name "*.env"',
    'mv src/a.ts ../a.ts',
  ])('%s', (cmd) => expectAction(bash(cmd), 'ask', cmd));

  it('percorsi assoluti', () => {
    const abs = path.join(outside, 'segreto.txt');
    expectAction(bash(`cat "${abs}"`), 'ask', 'cat assoluto');
    expectAction(bash(process.platform === 'win32' ? 'type C:\\Windows\\win.ini' : 'cat /etc/hosts'), 'ask', 'file di sistema');
    expectAction(classify('Read', { file_path: abs }, worker()), 'ask', 'Read assoluto');
    expectAction(classify('Edit', { file_path: abs }, worker()), 'ask', 'Edit assoluto');
    expectAction(classify('Glob', { pattern: '../**/*.env' }, worker()), 'ask', 'Glob ..');
  });

  it('link simbolici che portano fuori', () => {
    if (!linkOk) return;
    expectAction(bash('cat link/segreto.txt'), 'ask', 'cat attraverso il link');
    expectAction(bash('echo x > link/nuovo.txt'), 'ask', 'scrittura attraverso il link');
    expectAction(classify('Read', { file_path: path.join(wt, 'link', 'segreto.txt') }, worker()), 'ask', 'Read attraverso il link');
    expectAction(classify('Write', { file_path: path.join(wt, 'link', 'x.txt') }, worker()), 'ask', 'Write attraverso il link');
    expectAction(bash(`ln -s ${outside} scorciatoia`), 'ask', 'creare un link verso fuori');
    if (fileLinkOk) expectAction(bash('cat link-file.txt'), 'ask', 'symlink di file');
  });

  it('"consenti sempre" vale solo per quella cartella', () => {
    const v = bash('cat ../fuori/segreto.txt');
    if (v.action !== 'ask') throw new Error('atteso ask');
    expect(v.sticky).toBe(true);
    expectAction(classify('Bash', { command: 'cat ../fuori/segreto.txt' }, { ...worker(), alwaysAllow: v.ruleKeys }), 'allow', 'stessa cartella');
    expectAction(classify('Bash', { command: 'cat ../../altro.txt' }, { ...worker(), alwaysAllow: v.ruleKeys }), 'ask', 'altra cartella');
  });
});

describe('codice dalla rete o dai pacchetti: chiede sempre', () => {
  it.each([
    'npm install',
    'npm i lodash',
    'npm ci',
    'npm add left-pad',
    'npm update',
    'npm audit fix',
    'npm init vite',
    'npm exec cowsay',
    'npx cowsay ciao',
    'npx -y vitest',
    'npx vitest@latest run',
    'pnpm install',
    'pnpm add zod',
    'pnpm dlx create-vite',
    'yarn',
    'yarn add react',
    'yarn dlx create-vite',
    'bun install',
    'bun add zod',
    'bun x cowsay',
    'bunx cowsay',
    'pip install requests',
    'pip3 install -r requirements.txt',
    'python -m pip install requests',
    'py -m pip install requests',
    'pipx run black',
    'uv add httpx',
    'uv sync',
    'uv run pytest',
    'uvx ruff check',
    'poetry install',
    'cargo install ripgrep',
    'go get example.com/x',
    'go install example.com/x@latest',
    'go run example.com/x@v1.2.3',
    'gem install rails',
    'bundle install',
    'composer require x/y',
    'brew install jq',
    'apt-get install jq',
    'winget install jq',
    'choco install jq',
    'deno run https://example.com/x.ts',
    'npm test && npm install',
  ])('%s', (cmd) => expectAskAlways(bash(cmd), cmd));

  it('PowerShell', () => expectAskAlways(ps('npm install; npm test'), 'npm install in PowerShell'));

  it('npx di un tool installato nel progetto: chiede, con "consenti sempre" limitato a quel tool', () => {
    const v = bash('npx vitest run');
    expectAction(v, 'ask', 'npx vitest');
    if (v.action !== 'ask') return;
    expect(v.sticky).toBe(true);
    expect(v.ruleKeys).toEqual(['Bash:pkg-exec:vitest']);
    expectAction(classify('Bash', { command: 'npx vitest run --coverage' }, { ...worker(), alwaysAllow: v.ruleKeys }), 'allow', 'npx vitest dopo consenti sempre');
    expectAskAlways(classify('Bash', { command: 'npx cowsay' }, { ...worker(), alwaysAllow: v.ruleKeys }), 'altro pacchetto');
  });

  it('go: gli schemi di pacchetti fuori dal worktree chiedono ancora', () => {
    expectAction(bash('go test ../...'), 'ask', 'go test ../...');
    expectAction(bash('go test ../../altro/...'), 'ask', 'go test ../../altro/...');
  });

  it('"consenti sempre" non esiste per le installazioni: ogni npm install chiede', () => {
    const v = bash('npm install lodash');
    expectAskAlways(v, 'npm install');
    expectAskAlways(classify('Bash', { command: 'npm install lodash' }, { ...worker(), alwaysAllow: v.action === 'ask' ? v.ruleKeys : [] }), 'npm install ripetuto');
  });

  it('i comandi di sviluppo restano consentiti', () => {
    for (const cmd of ['npm test', 'npm run build', 'pnpm test', 'yarn test', 'python -m pytest -q', 'cargo test', 'go test ./...', 'go test -v ./internal/...', 'go vet ./...', 'go run ./cmd/x', 'npm ls', 'pip --version']) {
      if (cmd === 'pip --version') expectAction(bash(cmd), 'ask', cmd); // programma non riconosciuto: chiede (con consenti sempre)
      else expectAction(bash(cmd), 'allow', cmd);
    }
  });
});

describe('rete: chiede', () => {
  it.each([
    'curl https://example.com',
    'wget http://example.com/x',
    'npm install lodash',
    'npm i',
    'npx un-tool-non-installato',
    'pip install requests',
    'git fetch origin',
    'git pull',
    'git clone https://github.com/x/y',
    'git ls-remote origin',
    'ssh utente@host',
    'node src/a.ts https://example.com/api',
    'gh pr create',
  ])('%s', (cmd) => expectAction(bash(cmd), 'ask', cmd));

  it('PowerShell', () => {
    expectAction(ps('Invoke-WebRequest https://example.com -OutFile x.html'), 'ask', 'iwr');
  });
});

describe('comandi distruttivi: chiede', () => {
  it.each(['rm file.txt', 'rm -rf build', 'git reset --hard HEAD~1', 'git clean -fdx', 'find . -name "*.log" -delete', 'git checkout -- .', 'git restore src/a.ts', 'git stash drop', 'git branch -D vecchio', 'dd if=/dev/zero of=x'])('%s', (cmd) =>
    expectAction(bash(cmd), 'ask', cmd),
  );

  it('PowerShell Remove-Item', () => expectAction(ps('Remove-Item -Recurse -Force build'), 'ask', 'Remove-Item'));

  it('"consenti sempre" per rm dentro il worktree non vale fuori', () => {
    const v = bash('rm -rf build');
    if (v.action !== 'ask') throw new Error('atteso ask');
    expectAction(classify('Bash', { command: 'rm -rf build' }, { ...worker(), alwaysAllow: v.ruleKeys }), 'allow', 'rm dentro');
    expectAction(classify('Bash', { command: 'rm -rf ../fuori' }, { ...worker(), alwaysAllow: v.ruleKeys }), 'ask', 'rm fuori');
  });
});

describe('approvazione sempre obbligatoria (mai "consenti sempre")', () => {
  it.each([
    // configurazione git
    'git config user.email x@y.z',
    'git config --global core.hooksPath ./h',
    'git config --unset remote.origin.pushurl',
    'git remote add altro https://example.com/x.git',
    'git remote set-url origin https://example.com/x.git',
    // git -c (anche per comandi di sola lettura)
    'git -c core.hooksPath=./h commit -m x',
    'git -c user.name=x log',
    'git --git-dir=../altro/.git log',
    // variabili d'ambiente
    'export FOO=1',
    'FOO=1 npm test',
    'GIT_ALLOW_PROTOCOL=file npm test',
    'env -u GIT_ALLOW_PROTOCOL npm test',
    'env -i PATH=/usr/bin npm test',
    'unset GIT_CONFIG_COUNT',
    'setx FOO 1',
    'set FOO=1',
    // hook e percorsi .git
    'echo "git push" > .git/hooks/pre-commit',
    'cp hook.sh .git/hooks/post-commit',
    'chmod +x .git/hooks/pre-commit',
    'git hook run pre-commit',
    'rm .git',
  ])('%s', (cmd) => expectAskAlways(bash(cmd), cmd));

  it('PowerShell: $env:', () => expectAskAlways(ps("$env:GIT_ALLOW_PROTOCOL = 'file'"), '$env:'));

  it('Write/Edit su .git', () => {
    expectAskAlways(classify('Write', { file_path: path.join(wt, '.git', 'hooks', 'pre-push') }, worker()), 'Write hook');
    expectAskAlways(classify('Edit', { file_path: '.git' }, worker()), 'Edit .git');
  });

  it('anche con le chiavi già "consentite sempre" si chiede di nuovo', () => {
    const v = bash('git config user.email x@y.z');
    if (v.action !== 'ask') throw new Error('atteso ask');
    expectAskAlways(classify('Bash', { command: 'git config user.email x@y.z' }, { ...worker(), alwaysAllow: v.ruleKeys }), 'ripetuto');
  });
});

describe('git push: negato sempre', () => {
  it.each([
    'git push',
    'git push origin main',
    'git -C . push',
    'git --no-pager push --force',
    'bash -c "git push"',
    "sh -c 'cd src && git push origin HEAD'",
    'echo $(git push)',
    'echo `git push`',
    'cmd /c git push',
    'powershell -Command "git push"',
    'timeout 10 git push',
    'env FOO=1 git push',
    'git -c alias.p=push p',
    "git -c alias.p='!git push' p",
    'eval git push',
    'find . -name x -exec git push \\;',
    'npm test && git push',
    'git lfs push origin',
    'git subtree push --prefix x origin main',
    'git send-pack ../remote.git main',
  ])('%s', (cmd) => expectAction(bash(cmd), 'deny', cmd));

  it('firma con le chiavi dell\'utente', () => {
    expectAction(bash('git commit -S -m firmato'), 'deny', 'commit -S');
    expectAction(bash('git commit --gpg-sign=ABC -m x'), 'deny', 'gpg-sign');
    expectAction(bash('git tag -s v1 -m x'), 'deny', 'tag -s');
  });

  it('un messaggio di commit che contiene "push" non è un push', () => {
    expectAction(bash('git commit -m "corregge il pulsante push"'), 'allow', 'messaggio');
  });
});

describe('default: tutto il resto chiede', () => {
  it.each(['qualcosa-di-sconosciuto --flag', 'make deploy', 'node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"', 'python -c "print(1)"', 'bash script.sh', 'awk \'{print $1}\' a.txt', 'sudo ls', 'taskkill /F /IM node.exe', 'printenv', 'echo "chiuso male'])('%s', (cmd) =>
    expectAction(bash(cmd), 'ask', cmd),
  );

  it('tool sconosciuti e rete dei tool', () => {
    expectAction(classify('UnTool', {}, worker()), 'ask', 'tool sconosciuto');
    expectAction(classify('WebFetch', { url: 'https://example.com' }, worker()), 'ask', 'WebFetch');
    expectAction(classify('Task', {}, worker()), 'deny', 'sub-agenti');
  });
});

describe('lead: sola lettura', () => {
  it('legge, ma non scrive né esegue', () => {
    expectAction(bash('cat src/a.ts', lead()), 'allow', 'cat');
    expectAction(bash('git log --oneline', lead()), 'allow', 'git log');
    expectAction(bash('echo x > a.txt', lead()), 'ask', 'redirezione');
    expectAction(bash('git commit -m x', lead()), 'ask', 'commit');
    expectAction(bash('npm test', lead()), 'ask', 'npm test');
    expectAction(bash('node src/a.ts', lead()), 'ask', 'node');
    expectAction(classify('Edit', { file_path: 'src/a.ts' }, lead()), 'deny', 'Edit');
    expectAction(bash('git push', lead()), 'deny', 'push');
  });
});

describe('parser di shell', () => {
  it('scompone liste, pipe, redirezioni e sostituzioni', () => {
    const p = parseShell('A=1 git log --format="%h %s" | head -2 > out.txt; echo $(pwd) && cat <<EOF\nriga\nEOF\n');
    expect(p.error).toBeUndefined();
    expect(p.commands.map((c) => c.words.map((w) => w.text).join(' '))).toEqual(['git log --format=%h %s', 'head -2', 'echo $(…)', 'cat']);
    expect(p.commands[0]?.assignments).toEqual(['A=1']);
    expect(p.commands[1]?.redirects[0]).toMatchObject({ op: '>', target: { text: 'out.txt' } });
    expect(p.substitutions).toEqual(['pwd']);
    expect(p.commands[3]?.stdinScript).toBe(true);
  });

  it('segnala la sintassi che non capisce', () => {
    expect(parseShell('echo "aperta').error).toMatch(/virgolette/);
    expect(parseShell('cat <<EOF\nsenza fine').error).toMatch(/here-doc/);
  });

  it('i percorsi Windows restano interi', () => {
    expect(parseShell('type C:\\Users\\x\\file.txt').commands[0]?.words[1]?.text).toBe('C:\\Users\\x\\file.txt');
  });
});

describe('fase 10: forme comuni degli agenti consentite, senza perdere verificabilità', () => {
  it('messaggio di commit con $(cat <<EOF …) o echo: testo scritto nel comando, consentito', () => {
    expectAction(bash(`git commit -m "$(cat <<'EOF'\nfeat: titolo con l'apostrofo nel corpo? no\n\nCorpo\nEOF\n)"`), 'allow', 'commit con heredoc');
    expectAction(bash(`git add -A && git commit -m "$(printf 'feat: x')"`), 'allow', 'commit con printf');
  });

  it('il testo di una sostituzione usato come percorso, o un cat di un file: chiede ancora', () => {
    expectAction(bash(`cat $(cat <<'EOF'\n/etc/passwd\nEOF\n)`), 'ask', 'percorso da heredoc');
    expectAction(bash('git commit -m "$(cat ~/.ssh/id_rsa)"'), 'ask', 'cat di un file');
    expectAction(bash('git commit -m "$(git log -1 --format=%s)"'), 'ask', 'output di un comando');
    expectAction(bash(`echo "$(echo x)" > ../fuori.txt`), 'ask', 'scrittura fuori');
  });

  it('cicli e condizioni: conta il comando dentro', () => {
    expectAction(bash('ls | while read f; do echo "$f"; done'), 'allow', 'while read');
    expectAction(bash('ls | while read f; do echo "$f"; done', lead()), 'allow', 'while read del lead');
    expectAction(bash('if [ -f a ]; then cat a; else echo no; fi'), 'allow', 'if');
    expectAction(bash('while true; do curl http://example.com; done'), 'ask', 'rete dentro un ciclo');
    expectAction(bash('do rm -rf build'), 'ask', 'rm dopo do');
    expectAction(bash('{ curl http://x; }'), 'ask', 'rete in un gruppo');
    expectAction(bash('for f in *.md; do rm "$f"; done'), 'ask', 'rm sulla variabile del ciclo');
    expectAction(bash('for f in $(ls); do echo "$f"; done'), 'ask', 'for su output di un comando');
    expectAction(bash('if true; then git push; fi'), 'deny', 'push dentro un if');
  });
});

describe('here-doc: il corpo non nasconde comandi (corretto il 13 novembre 2026)', () => {
  it('$(…) e `…` nel corpo di un here-doc vengono classificati: bash li esegue', () => {
    expectAction(bash('cat <<EOF\n$(curl http://example.com)\nEOF'), 'ask', '$( ) nel corpo');
    expectAction(bash('cat <<EOF\n`curl http://example.com`\nEOF'), 'ask', 'backtick nel corpo');
    expectAction(bash('git commit -m "$(cat <<EOF\n$(curl http://example.com)\nEOF\n)"'), 'ask', 'dentro il messaggio di commit');
    expectAction(bash('cat <<EOF\n$(git push)\nEOF'), 'deny', 'push nascosto nel corpo');
  });

  it('<<- chiude alla riga con il delimitatore preceduto da tabulazioni: quello che segue è un comando', () => {
    expectAction(bash('cat <<-EOF\nx\n\tEOF\ncurl http://example.com\nEOF'), 'ask', 'comando dopo la chiusura con tab');
  });

  it('il corpo finisce solo alla riga uguale al delimitatore; senza chiusura chiede', () => {
    expectAction(bash('cat <<EOF > nota.md\nEOFX\ncurl http://example.com\nEOF'), 'allow', 'EOFX è testo');
    expectAction(bash('cat <<EOF > nota.md\nnon chiuso'), 'ask', 'here-doc non terminato');
    expectAction(bash("cat <<EOF > nota.md\nl'app (va)\nEOF"), 'allow', 'testo con apostrofi e parentesi');
  });
});

describe('fase 10: le forme raccomandate nelle istruzioni sono consentite dalla policy', () => {
  it('worker: commit, test, letture semplici', async () => {
    const { workerInstructions } = await import('../src/core/prompts.js');
    const text = workerInstructions({ userName: 'U', nameOf: (x) => x, tasks: [] }, { id: 'w', repoId: 'r', agentId: 'bruno', taskId: 't1', branch: 'b', base: 'main', path: wt, status: 'active', files: 0, additions: 0, deletions: 0 });
    const commit = /git add -A && git commit -m "titolo" -m "dettagli"/.exec(text)?.[0];
    expect(commit, 'le istruzioni indicano come committare').toBeDefined();
    for (const c of [commit!, 'npm test', 'npm run build', 'ls', 'cat README.md', 'git log --oneline -5', 'git diff'])
      expectAction(bash(c), 'allow', c);
  });

  it('lead: letture semplici nel checkout', () => {
    for (const c of ['ls', 'cat README.md', 'git log --oneline -5', 'git diff', 'git ls-files | head -50']) expectAction(bash(c, lead()), 'allow', c);
  });
});

describe('fase 10, dopo la revisione: niente nuove strade per aggirare la policy', () => {
  it('read e for non cambiano l\'ambiente: solo variabili minuscole', () => {
    for (const c of ['read PATH < a', 'read -r PATH <<< .', 'while read PATH; do ls; done < a', 'read BASH_ENV < a', 'read http_proxy < a', 'for PATH in .; do ls; done', 'read $x < a'])
      expectAskAlways(bash(c), c);
    expectAction(bash('ls | while read -r line; do echo "$line"; done'), 'allow', 'read di una variabile minuscola');
  });

  it('sostituzione di solo testo: consentita solo come messaggio di git commit', () => {
    for (const c of [
      'git commit --file=$(echo /etc/passwd)',
      'git commit -F"$(echo /etc/passwd)"',
      'git commit -m a -F$(printf /etc/hosts)',
      'git add --pathspec-from-file=$(echo /etc/passwd)',
      'rg --pre=$(echo curl) a',
      'grep --file=$(echo /etc/passwd) a',
      'npm test $(echo -- --config=/x)',
      'git apply --directory=$(echo ../..) p',
    ])
      expectAction(bash(c), 'ask', c);
    expectAction(bash('git commit -m "$(echo ciao)"'), 'allow', 'messaggio con echo');
  });

  it('valori attaccati alle opzioni: controllati come percorsi; rg --pre chiede', () => {
    for (const c of ['rg --pre=curl a', 'rg --pre curl a', 'rg --pre-glob "*" --pre x a', 'git commit -F/etc/passwd', 'git commit -m a --template=/etc/hosts', 'grep -f/etc/passwd a', 'grep -f/etc/passwd /etc/shadow', 'grep --file=/etc/passwd a'])
      expectAction(bash(c), 'ask', c);
    for (const c of ['git commit -F msg.txt', 'git commit -m "fix: a/b"', 'git log --format=%H/%s -5', 'grep -e/foo/ src', 'grep -rn foo src']) expectAction(bash(c), 'allow', c);
  });

  it('"<<" dentro $(( … )) è uno shift, non un here-doc: i comandi dopo restano visibili', () => {
    expectAction(bash('echo $((1 << 2\n))\ngit push origin\n2\n))'), 'deny', 'push dopo un finto here-doc aritmetico');
    expectAction(bash('echo $((1<<2\n))\ncurl http://example.com\n2\n))'), 'ask', 'rete dopo un finto here-doc aritmetico');
    expect(classify('Bash', { command: 'echo $((1<<2\n))\ncurl http://example.com\n2\n))' }, worker())).toMatchObject({ reason: expect.stringContaining('curl') });
  });

  it('for con sintassi non valida chiede', () => expectAskAlways(bash('for f in a do curl a; done'), 'for senza ;'));
});

describe('fase 10, secondo giro di revisione', () => {
  it('(( … )) all\'inizio di un comando non nasconde i comandi che seguono', () => {
    expectAction(bash('((ls<<2\n))\ngit push origin\n2'), 'deny', 'push dopo (( ))');
    expectAction(bash('((ls<<2\n))\ncurl http://example.com\n2'), 'ask', 'rete dopo (( ))');
    expect(classify('Bash', { command: '((ls<<2\n))\ncurl http://example.com\n2' }, worker())).toMatchObject({ reason: expect.stringContaining('curl') });
  });

  it('opzioni brevi raggruppate: il valore dopo la lettera che lo prende è un percorso', () => {
    for (const c of ['git commit -aF/etc/passwd', 'git commit -sF/etc/passwd', 'git commit -m a -nF/etc/passwd', 'grep -nf/etc/passwd a', 'grep -rf/etc/passwd a', 'rg -if/etc/passwd a'])
      expectAction(bash(c), 'ask', c);
    for (const c of ['git commit -am "x"', 'grep -A3 foo src', 'grep -e/foo/ src']) expectAction(bash(c), 'allow', c);
  });

  it('il messaggio di commit con $(…) vale solo come parola dopo -m di "git commit", non in altri comandi della catena', () => {
    for (const c of [
      'git log commit -m "$(echo --output=../x)"',
      'git show commit -m "$(echo --ext-diff)"',
      'git commit -m a && npm test -m "$(echo ../x)"',
      'git commit -m a; git log -m "$(echo ../x)"',
      'git add commit -m "$(echo ../x)"',
      'git commit -m "$(echo x)" --author "$(echo y)"',
    ])
      expectAction(bash(c), 'ask', c);
  });

  it('printf -v, ${VAR:=…} e nomi che su Windows sono variabili d\'ambiente: chiedono sempre', () => {
    for (const c of ['printf -v PATH . ; ls', 'echo ${PATH:=.}', 'read path < a', 'read home < a', 'for home in .; do ls; done', 'read git_dir < a'])
      expectAskAlways(bash(c), c);
  });
});

describe('fase 10, terzo giro di revisione', () => {
  it('(( )) anche dopo una parola chiave non nasconde i comandi che seguono', () => {
    expectAction(bash('then ((ls<<2\n))\ngit push origin\n2'), 'deny', 'push dopo then ((');
    for (const c of ['do ((ls<<2\n))\ncurl http://example.com\n2', '{ ((ls<<2\n))\ncurl http://example.com\n2\n; }', '! ((ls<<2\n))\ncurl http://example.com\n2', 'while ((ls<<2\n))\ncurl http://example.com\n2\n; do true; done'])
      expectAction(bash(c), 'ask', c);
  });

  it('${x@P} e le altre trasformazioni chiedono sempre: eseguono i $(…) contenuti in una variabile', () => {
    for (const c of [`for x in '$(curl http://example.com)'; do echo "\${x@P}"; done`, `read x <<< '$(curl a)'; echo \${x@P}`, 'echo ${x@P}']) expectAskAlways(bash(c), c);
  });

  it('-m $(…) senza virgolette chiede: bash ne dividerebbe il testo in opzioni', () => {
    for (const c of ['git commit -m $(echo a -F /etc/passwd)', 'git commit -m $(echo --amend)', 'git commit -m "$(echo a)" -m $(echo b -F /etc/passwd)']) expectAction(bash(c), 'ask', c);
  });

  it('un percorso con la lettera di unità dentro un\'opzione breve si controlla', () => {
    for (const c of ['git diff -OC:/Users/x/secret', 'git grep -fC:/Windows/win.ini x', 'git log -zC:/Users/x/secret', 'grep -nC:/Windows/win.ini x']) expectAction(bash(c), 'ask', c);
  });
});
