// Build dell'app: renderer (React, Vite) e processi main/preload (Node, CommonJS: il preload in
// sandbox non può essere un modulo ES). Uscita in app/dist.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (...p) => path.join(appDir, 'src', ...p);
const out = (...p) => path.join(appDir, 'dist', ...p);
const prod = process.argv.includes('--prod');

await build({
  configFile: false,
  root: src('renderer'),
  base: './',
  logLevel: 'warn',
  plugins: [react()],
  build: { outDir: out('renderer'), emptyOutDir: true, sourcemap: !prod, target: 'chrome130' },
});

for (const [entry, name] of [
  [src('main', 'main.ts'), 'main'],
  [src('preload', 'preload.ts'), 'preload'],
]) {
  await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      ssr: entry,
      outDir: out(name),
      emptyOutDir: true,
      sourcemap: !prod,
      target: 'node22',
      minify: false,
      rollupOptions: {
        // electron è fornito dal runtime; le dipendenze native facoltative di ws non servono
        external: ['electron', 'bufferutil', 'utf-8-validate', /^node:/],
        output: { format: 'cjs', entryFileNames: `${name}.cjs` },
      },
    },
    ssr: { noExternal: true, target: 'node' },
  });
}
console.log(`app compilata in ${out()}`);
