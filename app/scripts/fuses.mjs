// Fuse di Electron per il pacchetto (app/scripts/package.mjs), separate per poterle testare.
import fs from 'node:fs';

/**
 * Le fuse di Electron stanno nel binario dopo una sentinella: un byte di versione, uno di
 * lunghezza e poi un byte per fuse ('0' spenta, '1' accesa, 'r' rimossa). Ordine (versione 1):
 * 0 RunAsNode, 1 EnableCookieEncryption, 2 EnableNodeOptionsEnvironmentVariable,
 * 3 EnableNodeCliInspectArguments, 4 EnableEmbeddedAsarIntegrityValidation, 5 OnlyLoadAppFromAsar,
 * 6 LoadBrowserProcessSpecificV8Snapshot, 7 GrantFileProtocolExtraPrivileges.
 * Prima di scrivere si controlla che le prime otto abbiano i valori predefiniti attesi: se no, ci si
 * ferma invece di scrivere byte nel posto sbagliato.
 */
export function flipFuses(exe, log = console.log) {
  const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');
  const buf = fs.readFileSync(exe);
  const at = buf.indexOf(SENTINEL);
  if (at < 0 || buf.indexOf(SENTINEL, at + 1) >= 0) throw new Error('fuse di Electron: sentinella non trovata o ripetuta');
  const v = at + SENTINEL.length;
  if (buf[v] !== 1) throw new Error(`fuse di Electron: versione ${buf[v]} non prevista`);
  const len = buf[v + 1];
  const fuses = buf.subarray(v + 2, v + 2 + len);
  const expected = '10110001'; // valori predefiniti di Electron per le prime otto
  const now = fuses.subarray(0, 8).toString('ascii');
  if (now !== expected) throw new Error(`fuse di Electron: valori inattesi (${now}, attesi ${expected}): non le modifico`);
  const want = { 1: '1', 2: '0', 3: '0' }; // cookie cifrati sì; NODE_OPTIONS e --inspect no
  for (const [i, c] of Object.entries(want)) fuses[Number(i)] = c.charCodeAt(0);
  fs.writeFileSync(exe, buf);
  log(`fuse: ${now} -> ${fuses.subarray(0, 8).toString('ascii')}`);
}

/** Le fuse scritte nell'eseguibile, come stringa ('1' accesa, '0' spenta, 'r' rimossa). */
export function readFuses(exe) {
  const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');
  const buf = fs.readFileSync(exe);
  const at = buf.indexOf(SENTINEL);
  if (at < 0) throw new Error('fuse di Electron: sentinella non trovata');
  const v = at + SENTINEL.length;
  return buf.subarray(v + 2, v + 2 + buf[v + 1]).toString('ascii');
}
