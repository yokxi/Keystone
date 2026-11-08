// Controllo degli aggiornamenti (app/src/main/updates.ts): versioni, validazione della risposta di
// GitHub, nessuna richiesta con il controllo spento, nessun link fuori dalle release di Keystone.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppSettings, checkForUpdate, isNewer, parseRelease, parseVersion, RELEASES_API, updateCheckForcedOff, UpdateChecker, type FetchLike } from '../src/main/updates.js';
import { tmpDir } from '../../orchestrator/test/helpers.js';

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v0.2.0',
  name: 'Keystone 0.2.0',
  body: 'Novità:\r\n- installatore',
  html_url: 'https://github.com/yokxi/Keystone/releases/tag/v0.2.0',
  published_at: '2026-11-20T10:00:00Z',
  draft: false,
  prerelease: false,
  ...over,
});

/** una fetch finta che conta le chiamate e risponde con `body` */
function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; redirect: string }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, redirect: init.redirect });
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  return { fn, calls };
}

describe('aggiornamenti: versioni', () => {
  it('confronta x.y.z numericamente; le pre-release e i formati strani non valgono', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('1.2.3-beta')).toBeUndefined();
    expect(parseVersion('1.2')).toBeUndefined();
    expect(parseVersion(5)).toBeUndefined();
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.1.9', '0.2.0')).toBe(false);
    expect(isNewer('2.0.0-rc1', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', 'sviluppo')).toBe(false);
  });
});

describe('aggiornamenti: la risposta di GitHub è un dato non attendibile', () => {
  it('accetta solo un link alle release di yokxi/Keystone su https://github.com', () => {
    expect(parseRelease(release())?.url).toBe('https://github.com/yokxi/Keystone/releases/tag/v0.2.0');
    for (const html_url of [
      'https://evil.example/yokxi/Keystone/releases/tag/v0.2.0',
      'http://github.com/yokxi/Keystone/releases/tag/v0.2.0',
      'https://github.com/altro/Keystone/releases/tag/v0.2.0',
      'https://github.com.evil.example/yokxi/Keystone/releases/',
      'https://user:pw@github.com/yokxi/Keystone/releases/tag/v0.2.0',
      'https://github.com:8443/yokxi/Keystone/releases/tag/v0.2.0',
      'javascript:alert(1)',
      42,
    ]) expect(parseRelease(release({ html_url })), String(html_url)).toBeUndefined();
  });

  it('scarta bozze, pre-release e versioni non valide; ripulisce e tronca il testo', () => {
    expect(parseRelease(release({ draft: true }))).toBeUndefined();
    expect(parseRelease(release({ prerelease: true }))).toBeUndefined();
    expect(parseRelease(release({ tag_name: 'ultima' }))).toBeUndefined();
    expect(parseRelease(null)).toBeUndefined();
    const r = parseRelease(release({ name: 'Keystone\u0007 0.2.0‮', body: `riga\r\n${'x'.repeat(10_000)}` }))!;
    expect(r.name).toBe('Keystone 0.2.0');
    expect(r.notes.startsWith('riga\nxxx')).toBe(true);
    expect(r.notes.length).toBeLessThan(4100);
    expect(parseRelease(release({ name: '' }))!.name).toBe('Keystone 0.2.0');
  });

  it('una richiesta GET anonima a un solo indirizzo, senza seguire redirect', async () => {
    const f = fakeFetch(release());
    expect(await checkForUpdate('0.1.0', f.fn)).toMatchObject({ status: 'available', info: { version: '0.2.0' } });
    expect(f.calls).toEqual([{ url: RELEASES_API, headers: { accept: 'application/vnd.github+json', 'user-agent': 'Keystone-app' }, redirect: 'error' }]);
    expect(await checkForUpdate('0.2.0', fakeFetch(release()).fn)).toEqual({ status: 'none', latest: '0.2.0' });
  });

  it('gli errori tornano come risultato, mai come eccezione', async () => {
    expect(await checkForUpdate('0.1.0', fakeFetch({}, 404).fn)).toEqual({ status: 'error', error: 'nessuna release pubblicata' });
    expect(await checkForUpdate('0.1.0', fakeFetch({}, 500).fn)).toMatchObject({ status: 'error' });
    expect(await checkForUpdate('0.1.0', fakeFetch('<html>').fn)).toEqual({ status: 'error', error: 'risposta non valida' });
    expect(await checkForUpdate('0.1.0', fakeFetch(release({ html_url: 'https://evil.example/' })).fn)).toEqual({ status: 'error', error: 'release non valida' });
    const down: FetchLike = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await checkForUpdate('0.1.0', down)).toMatchObject({ status: 'error', error: expect.stringContaining('rete') });
    const slow: FetchLike = (_u, init) => new Promise((_ok, ko) => init.signal.addEventListener('abort', () => ko(new Error('abort'))));
    expect(await checkForUpdate('0.1.0', slow, 20)).toEqual({ status: 'error', error: 'tempo scaduto' });
  });
});

describe('aggiornamenti: interruttore', () => {
  it('predefinito attivo; la scelta si salva in app-settings.json; un file rovinato torna al predefinito', () => {
    const file = path.join(tmpDir(), 'app-settings.json');
    const s = new AppSettings(file);
    expect(s.updateCheck).toBe(true);
    s.setUpdateCheck(false);
    expect(new AppSettings(file).updateCheck).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ updateCheck: false });
    fs.writeFileSync(file, '{rovinato');
    expect(new AppSettings(file).updateCheck).toBe(true);
  });

  it('spento: nessuna richiesta automatica; spento da ambiente: nessuna richiesta, nemmeno a mano', async () => {
    const settings = new AppSettings(path.join(tmpDir(), 'app-settings.json'));
    settings.setUpdateCheck(false);
    const f = fakeFetch(release());
    const off = new UpdateChecker({ current: '0.1.0', settings, fetchFn: f.fn, forcedOff: false });
    off.schedule(1, 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(f.calls).toHaveLength(0);
    // a richiesta sì (l'hai premuto tu)
    expect((await off.check()).result).toMatchObject({ status: 'available' });
    expect(f.calls).toHaveLength(1);
    expect(off.releaseUrl()).toBe('https://github.com/yokxi/Keystone/releases/tag/v0.2.0');

    const g = fakeFetch(release());
    const forced = new UpdateChecker({ current: '0.1.0', settings: new AppSettings(path.join(tmpDir(), 'a.json')), fetchFn: g.fn, forcedOff: true });
    forced.schedule(1, 1);
    await forced.check();
    await new Promise((r) => setTimeout(r, 50));
    expect(g.calls).toHaveLength(0);
    expect(forced.releaseUrl()).toBeUndefined();
    expect(updateCheckForcedOff({ KEYSTONE_NO_UPDATE_CHECK: '1' })).toBe(true);
    expect(updateCheckForcedOff({ KEYSTONE_NO_UPDATE_CHECK: '0' })).toBe(false);
    expect(updateCheckForcedOff({})).toBe(false);
  });

  it('acceso: il primo controllo parte da solo; spegnendolo i controlli si fermano', async () => {
    const f = fakeFetch(release({ tag_name: 'v0.1.0' }));
    const c = new UpdateChecker({ current: '0.1.0', settings: new AppSettings(path.join(tmpDir(), 'a.json')), fetchFn: f.fn, forcedOff: false, now: () => 5 });
    const seen: string[] = [];
    c.onChange((s) => seen.push(s.checking ? 'checking' : (s.result?.status ?? '?')));
    c.schedule(1, 60_000);
    await expect.poll(() => f.calls.length).toBe(1);
    await expect.poll(() => c.state.result?.status).toBe('none');
    expect(c.state.lastCheck).toBe(5);
    expect(seen).toEqual(['checking', 'none']);
    c.setEnabled(false);
    c.schedule(1, 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(f.calls).toHaveLength(1);
    c.stop();
  });
});
