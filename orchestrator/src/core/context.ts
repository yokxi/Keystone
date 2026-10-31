// Il contesto passato a ogni sottosistema del nucleo. Ogni modifica di stato segue lo stesso
// schema: si modifica `store.data`, si chiama `store.markDirty()` (persistenza) e `emit(...)`
// (aggiornamento dell'interfaccia). Così disco e vista restano sempre allineati.
import type { Outbound } from '@keystone/shared';
import type { Store } from './store.js';

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface Ctx {
  store: Store;
  now(): number;
  emit(msg: Outbound): void;
  log: Logger;
}

export function consoleLogger(level: 'debug' | 'info' | 'warn' | 'error' = 'info'): Logger {
  const order = ['debug', 'info', 'warn', 'error'];
  const min = order.indexOf(level);
  const at = (l: string, fn: (s: string) => void) => (msg: string) => {
    if (order.indexOf(l) >= min) fn(`[${new Date().toISOString().slice(11, 19)}] ${l.padEnd(5)} ${msg}`);
  };
  return { debug: at('debug', console.log), info: at('info', console.log), warn: at('warn', console.warn), error: at('error', console.error) };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
