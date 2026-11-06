// L'etichetta "sperimentale" di un motore è la stessa in codice, interfaccia e README, e si toglie
// solo dopo la prova reale: questo test fallisce se README e codice non sono allineati.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENGINE_DISABLED, ENGINE_EXPERIMENTAL, ENGINE_LABELS } from '../src/engines.js';

const README = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'README.md'), 'utf8');

describe('motori sperimentali', () => {
  it('Codex è sperimentale finché non c\'è la prova con un modello vero', () => {
    expect(ENGINE_EXPERIMENTAL.codex).toBe('sperimentale · non ancora verificato con un modello reale');
  });

  it('il README riporta lo stato di ogni motore: non incluso, sperimentale o nessuna etichetta', () => {
    for (const [engine, label] of Object.entries(ENGINE_LABELS)) {
      const row = README.split('\n').find((l) => l.startsWith(`| ${label} |`));
      expect(row, `riga del motore ${label} nel README`).toBeTruthy();
      const id = engine as keyof typeof ENGINE_LABELS;
      // un motore non incluso in questa versione lo dice; uno sperimentale porta l'etichetta del codice
      if (ENGINE_DISABLED[id]) expect(row).toContain('non incluso in questa versione');
      else if (ENGINE_EXPERIMENTAL[id]) expect(row).toContain(ENGINE_EXPERIMENTAL[id]);
      else expect(row).not.toMatch(/sperimentale|non incluso/);
    }
  });

  it('Codex non è incluso in questa versione (rinviato al rilascio successivo)', () => {
    expect(ENGINE_DISABLED.codex).toMatch(/non è incluso in questa versione/);
    expect(ENGINE_DISABLED.claude).toBeUndefined();
  });
});
