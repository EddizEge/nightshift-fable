/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';

// Sandbox pages (sandbox/*.html) are dev/test-only entry points; they are served by the dev
// server but are NOT part of the production build (only index.html is).
export default defineConfig(({ command }) => ({
  base: './',
  publicDir: 'public',
  server: { host: '127.0.0.1', port: 5173, strictPort: false },
  preview: { host: '127.0.0.1', port: 4173 },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2500,
    sourcemap: false,
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, 'index.html') },
      output: {
        // Libraries change far less often than the game: separate, long-cacheable chunks.
        manualChunks(id: string) {
          // Package name right after the last "node_modules" segment (either path separator).
          const parts = id.split('node_modules');
          if (parts.length < 2) return undefined;
          const pkg = parts[parts.length - 1].slice(1);
          if (pkg.startsWith('three') || pkg.startsWith('postprocessing')) return 'three';
          return undefined;
        },
      },
    },
  },
  optimizeDeps: { exclude: [] },
  define: { __DEV__: command === 'serve' },
  // Only the real suite: throw-away experiments under tools/tmp are not tests.
  test: { include: ['tests/**/*.test.ts'] },
}));
void readdirSync;
