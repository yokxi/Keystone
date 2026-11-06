// L'ambiente dei comandi degli agenti non eredita le variabili che servono solo all'orchestratore
// impacchettato (gira con il Node di Electron).
import { describe, expect, it } from 'vitest';
import { agentEnv } from '../src/core/agent-env.js';
import { tmpDir } from './helpers.js';

describe('ambiente degli agenti', () => {
  it('niente ELECTRON_RUN_AS_NODE (in qualunque maiuscola), il resto resta', () => {
    const env = agentEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', MIA_VARIABILE: 'x' }, { agentId: 'bruno', name: 'Bruno', cwd: tmpDir() });
    expect(Object.keys(env).filter((k) => /^electron_/i.test(k))).toEqual([]);
    expect(env.MIA_VARIABILE).toBe('x');
    expect(env.PATH).toBe('/bin');
  });
});
