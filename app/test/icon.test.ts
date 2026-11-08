// Icona di Windows (app/scripts/make-icon.mjs): il formato .ico e il file committato.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIco } from '../scripts/make-icon.mjs';

/** Le voci di un file .ico: misura, lunghezza e inizio dei dati. */
function entries(ico: Buffer) {
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  return Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
    const o = 6 + 16 * i;
    return { size: ico[o] || 256, len: ico.readUInt32LE(o + 8), off: ico.readUInt32LE(o + 12) };
  });
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('icona', () => {
  it('buildIco: intestazione, voci e dati PNG nell\'ordine giusto; 256 si scrive come 0', () => {
    const a = Buffer.concat([PNG, Buffer.from('a')]);
    const b = Buffer.concat([PNG, Buffer.from('bb')]);
    const ico = buildIco([{ size: 16, png: a }, { size: 256, png: b }]);
    const e = entries(ico);
    expect(e).toEqual([{ size: 16, len: a.length, off: 6 + 32 }, { size: 256, len: b.length, off: 6 + 32 + a.length }]);
    expect(ico[6 + 16]).toBe(0);
    expect(ico.subarray(e[1]!.off, e[1]!.off + e[1]!.len)).toEqual(b);
    expect(() => buildIco([{ size: 300, png: a }])).toThrow(/misura/);
  });

  it('app/assets/icon.ico ha tutte le misure di Windows, ognuna un PNG', () => {
    const ico = fs.readFileSync(path.resolve(__dirname, '..', 'assets', 'icon.ico'));
    const e = entries(ico);
    expect(e.map((x) => x.size)).toEqual([16, 20, 24, 32, 40, 48, 64, 128, 256]);
    for (const x of e) expect(ico.subarray(x.off, x.off + 8)).toEqual(PNG);
  });
});
