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
