// Icona di Windows: da app/assets/icon.svg (e icon-16.svg per le misure piccole) a
// app/assets/icon.ico, con le misure che Windows usa (16-256 pixel).
//
//   npm run icon -w app
//
// Si lancia a mano quando cambia il disegno, e il risultato si committa: il pacchetto usa il file
// .ico già pronto. Per disegnare l'SVG serve un browser: si usa l'Electron già installato, con una
// finestra nascosta e un canvas. Nessuna dipendenza in più.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const assets = path.resolve(path.dirname(here), '..', 'assets');
/** misura -> disegno da cui ricavarla */
const SIZES = [
  [16, 'icon-16.svg'],
  [20, 'icon-16.svg'],
  [24, 'icon.svg'],
  [32, 'icon.svg'],
  [40, 'icon.svg'],
  [48, 'icon.svg'],
  [64, 'icon.svg'],
  [128, 'icon.svg'],
  [256, 'icon.svg'],
];

/** Un file .ico con le immagini PNG date (formato accettato da Windows Vista in poi). */
export function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // riservato
  header.writeUInt16LE(1, 2); // 1 = icona
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    if (size < 1 || size > 256) throw new Error(`misura non valida: ${size}`);
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0); // 0 = 256
    e.writeUInt8(size === 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // niente tavolozza
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); // piani
    e.writeUInt16LE(32, 6); // bit per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/** Dentro Electron: disegna ogni misura su un canvas e scrive icon.ico. */
async function renderInElectron() {
  const m = await import('electron');
  const { app, BrowserWindow } = m.default ?? m;
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8"><body></body>');
  const images = [];
  for (const [size, file] of SIZES) {
    const svg = fs.readFileSync(path.join(assets, file), 'utf8');
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    const png = await win.webContents.executeJavaScript(`new Promise((ok, ko) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = ${size};
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, ${size}, ${size});
        ok(c.toDataURL('image/png'));
      };
      img.onerror = () => ko(new Error('svg non valido'));
      img.src = ${JSON.stringify(dataUrl)};
    })`);
    images.push({ size, png: Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64') });
  }
  fs.writeFileSync(path.join(assets, 'icon.ico'), buildIco(images));
  console.log(`icon.ico: ${images.map((i) => i.size).join(', ')} pixel`);
  app.exit(0);
}

if (process.versions.electron) {
  renderInElectron().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  const electron = createRequire(import.meta.url)('electron');
  // Electron vero, non in modalità Node: la variabile non deve esserci affatto
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(electron, [here], { stdio: 'inherit', env });
}
