// <dataDir>/orchestrator.json: pid e porta dell'orchestratore attivo su un profilo. Serve all'app
// per trovarlo e impedisce che due orchestratori scrivano lo stesso state.json.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './util/fsx.js';

export interface RunInfo {
  pid: number;
  port: number;
  host: string;
  profile: string;
  version: string;
  startedAt: number;
}

export function runFile(dataDir: string): string {
  return path.join(dataDir, 'orchestrator.json');
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** L'orchestratore attivo su questo profilo, se c'è (ignora file rimasti da un crash). */
export function readRunInfo(dataDir: string): RunInfo | undefined {
  try {
    const info = readJson<RunInfo>(runFile(dataDir));
    return info && info.pid !== process.pid && isAlive(info.pid) ? info : undefined;
  } catch {
    return undefined;
  }
}

export function claimProfile(dataDir: string, info: RunInfo): void {
  const other = readRunInfo(dataDir);
  if (other) throw new Error(`il profilo "${info.profile}" è già usato dall'orchestratore con pid ${other.pid} (porta ${other.port})`);
  writeJsonAtomic(runFile(dataDir), info);
}

export function releaseProfile(dataDir: string): void {
  try {
    const info = readJson<RunInfo>(runFile(dataDir));
    if (info?.pid === process.pid) fs.rmSync(runFile(dataDir), { force: true });
  } catch {
    /* ignora */
  }
}
