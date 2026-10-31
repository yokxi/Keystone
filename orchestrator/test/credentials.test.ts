// Terzo livello: nei worktree degli agenti non c'è nessuna credenziale. Anche aggirando il blocco
// dei trasporti, un push con un pushurl valido verso un remote locale che chiede l'autenticazione
// fallisce, e il server non riceve mai credenziali.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentEnv } from '../src/core/agent-env.js';
import { NO_PROGRAM } from '../src/core/gitsafety.js';
import { RepoManager } from '../src/core/repos.js';
import { git } from '../src/util/git.js';
import { demoRepo, onCleanup, testCtx, tmpDir } from './helpers.js';

/** Un remote HTTP locale che chiede sempre l'autenticazione e registra le credenziali ricevute. */
async function authServer() {
  const authorizations: string[] = [];
  let requests = 0;
  const srv = http.createServer((req, res) => {
    requests++;
    if (req.headers.authorization) authorizations.push(req.headers.authorization);
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="keystone-test"', 'Content-Type': 'text/plain' });
    res.end('autenticazione richiesta');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  onCleanup(() => new Promise<void>((r) => srv.close(() => r())));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/repo.git`, authorizations, requests: () => requests };
}

async function setup() {
  const dir = tmpDir();
  const repo = await demoRepo(dir);
  // la "credenziale salvata" dell'utente: un helper che fornisce utente e password a chiunque la chieda
  await git(repo, ['config', '--local', 'credential.helper', '!f() { echo username=utente; echo password=segreto; }; f']);
  const repos = new RepoManager(testCtx(path.join(dir, 'state')), { worktreesDir: path.join(dir, 'worktrees'), guardFile: path.join(dir, 'home', 'git', 'agent-guard.gitconfig') });
  await repos.add(repo, { confirmGuard: true });
  const wt = await repos.createWorktree('repo', 'bruno', { id: 't1', title: 'credenziali' });
  // senza configurazione globale né di sistema: niente Git Credential Manager con finestre
  const isolated = { GIT_CONFIG_GLOBAL: path.join(dir, 'globale-vuota.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' };
  fs.writeFileSync(isolated.GIT_CONFIG_GLOBAL, '');
  const base = { ...process.env, ...isolated, SSH_AUTH_SOCK: '/tmp/agent.sock', GH_TOKEN: 'ghp_finto', GITHUB_TOKEN: 'ghp_finto2', MY_GITHUB_TOKEN: 'x', GITLAB_TOKEN: 'glpat' };
  const env = agentEnv(base, { agentId: 'bruno', name: 'Bruno', cwd: wt.path }) as NodeJS.ProcessEnv;
  return { dir, repo, wt, env, isolated };
}

/** git in modo asincrono: il server HTTP di prova gira nello stesso processo e deve poter rispondere. */
function run(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

describe('nessuna credenziale nei worktree degli agenti', () => {
  it('controprova: dal checkout dell\'utente le credenziali arrivano al server', async () => {
    const s = await setup();
    const server = await authServer();
    await run(s.repo, ['push', server.url, 'HEAD:refs/heads/main'], { ...process.env, ...s.isolated });
    expect(server.authorizations.length).toBeGreaterThan(0); // l'helper dell'utente funziona
  });

  it('push con pushurl valido verso un remote che chiede credenziali: fallisce e il server non riceve credenziali', async () => {
    const s = await setup();
    const server = await authServer();
    // si aggirano apposta i primi due livelli (trasporti) per isolare il terzo
    const bypassTransport = ['-c', 'protocol.allow=always', '-c', `remote.origin.pushurl=${server.url}`];
    await git(s.repo, ['remote', 'add', 'origin', server.url]);
    const cases: Array<[string, NodeJS.ProcessEnv]> = [
      ['ambiente dell\'agente', { ...s.env, GIT_ALLOW_PROTOCOL: 'http' }],
      ['ambiente svuotato (env -i)', { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, ...s.isolated, GIT_ALLOW_PROTOCOL: 'http' }],
    ];
    for (const [label, env] of cases) {
      const r = await run(s.wt.path, [...bypassTransport, 'push', 'origin', 'HEAD:refs/heads/main'], env);
      expect(r.code, `${label}: il push è riuscito\n${r.out}`).not.toBe(0);
    }
    expect(server.requests()).toBeGreaterThan(0); // il server è stato raggiunto davvero...
    expect(server.authorizations).toEqual([]); // ...ma senza nessuna credenziale
  });

  it('ssh fallisce sempre: core.sshCommand punta a un programma inesistente', async () => {
    const s = await setup();
    // pushurl esplicito: il guardiano riscrive gli URL di push, ma non un pushurl
    const r = await run(s.wt.path, ['-c', 'protocol.allow=always', '-c', 'remote.ssh.url=ssh://git@127.0.0.1:1/repo.git', '-c', 'remote.ssh.pushurl=ssh://git@127.0.0.1:1/repo.git', 'push', 'ssh', 'HEAD'], { ...s.env, GIT_ALLOW_PROTOCOL: 'ssh' });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(NO_PROGRAM);
  });

  it('l\'ambiente degli agenti non eredita agent SSH né token', async () => {
    const s = await setup();
    for (const k of ['SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'MY_GITHUB_TOKEN', 'GITLAB_TOKEN', 'GIT_ASKPASS', 'SSH_ASKPASS']) expect(s.env[k], k).toBeUndefined();
    const keys = Object.keys(s.env).filter((k) => k.startsWith('GIT_CONFIG_KEY_')).map((k) => s.env[k]);
    expect(keys).toEqual(expect.arrayContaining(['credential.helper', 'core.askPass', 'core.sshCommand']));
  });
});
