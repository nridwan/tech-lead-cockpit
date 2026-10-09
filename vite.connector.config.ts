import { defineConfig } from 'vite';
import { readPwaAssets } from './connector/remote/pwa-assets.ts';

/**
 * Bundles the Node connector into one ESM file for the desktop app, so it runs on plain
 * `node` without TypeScript tooling or the project's node_modules.
 */
export default defineConfig({
  // The Remote PWA ships inside server.mjs (connector/remote/pwa-assets.ts).
  define: { __TLC_PWA_ASSETS__: JSON.stringify(readPwaAssets(new URL('./connector/remote/', import.meta.url))) },
  build: {
    ssr: 'connector/desktop-entry.ts',
    outDir: 'dist-connector',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: { entryFileNames: 'server.mjs', codeSplitting: false },
    },
  },
  ssr: {
    target: 'node',
    // Bundle every dependency; only Baileys' optional media helpers stay external (never used here).
    noExternal: true,
    external: ['sharp', 'jimp', 'link-preview-js', 'audio-decode', 'qrcode-terminal', 'pg-native'],
  },
});
