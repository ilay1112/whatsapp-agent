// electron.vite.config.ts - shape of docs/research/electron-stack.md section 10 (W0).
// The project path contains a space: paths are derived with fileURLToPath, never URL.pathname.
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import * as modelManifest from './src/main/llm/local/manifest';

const p = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const shared = { '@shared': p('./src/shared') };

/** [V2] T2 11 check 8: out/main/manifest.json = a JSON sidecar of src/main/llm/local/manifest.ts (every exported *MANIFEST
 *  table: MODEL_MANIFEST now, MEDIA_MODEL_MANIFEST once V2-W1-07 adds it). The packaged smoke compares it with
 *  vendor/models.pin.json. Emitted by every main build (the e2e build carries it too; it holds no seam string). */
function modelManifestSidecar(): Plugin {
  return {
    name: 'wca-model-manifest-sidecar',
    generateBundle() {
      const tables = Object.fromEntries(Object.entries(modelManifest).filter(([k]) => k.endsWith('MANIFEST')));
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: `${JSON.stringify(tables, null, 2)}\n` });
    },
  };
}

export default defineConfig({
  main: {
    resolve: { alias: shared },
    plugins: [modelManifestSidecar()], // [V2]
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
