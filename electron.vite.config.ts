// electron.vite.config.ts - shape of docs/research/electron-stack.md section 10 (W0).
// The project path contains a space: paths are derived with fileURLToPath, never URL.pathname.
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const p = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const shared = { '@shared': p('./src/shared') };

export default defineConfig({
  main: {
    resolve: { alias: shared },
    // Dependencies listed in package.json#dependencies are externalised by electron-vite by default and ship in app.asar.
    build: { target: 'node24', sourcemap: true, rollupOptions: { output: { format: 'es' } } },
  },
  preload: {
    resolve: { alias: shared },
    // CJS preload -> out/preload/index.cjs ; sandbox-safe and dependency-free (it imports only `electron`).
    build: { sourcemap: false, rollupOptions: { output: { format: 'cjs' }, external: ['electron'] } },
  },
  renderer: {
    resolve: { alias: { ...shared, '@': p('./src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    build: { target: 'chrome152' },
  },
});
