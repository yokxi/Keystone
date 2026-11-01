// L'etichetta "sperimentale" di un motore è la stessa in codice, interfaccia e README, e si toglie
// solo dopo la prova reale: questo test fallisce se README e codice non sono allineati.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENGINE_EXPERIMENTAL, ENGINE_LABELS } from '../src/engines.js';

const README = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'README.md'), 'utf8');

describe('motori sperimentali', () => {
  it('Codex è sperimentale finché non c\'è la prova con un modello vero', () => {
    expect(ENGINE_EXPERIMENTAL.codex).toBe('sperimentale · non ancora verificato con un modello reale');
  });

  it('il README riporta la stessa etichetta per ogni motore sperimentale, e nessuna per gli altri', () => {
    for (const [engine, label] of Object.entries(ENGINE_LABELS)) {
      const row = README.split('\n').find((l) => l.startsWith(`| ${label} |`));
      expect(row, `riga del motore ${label} nel README`).toBeTruthy();
      const text = ENGINE_EXPERIMENTAL[engine as keyof typeof ENGINE_LABELS];
      if (text) expect(row).toContain(text);
      else expect(row).not.toContain('sperimentale');
    }
  });
});
