#!/usr/bin/env node
/**
 * Production-build check for the audio module: builds ONLY sandbox/audio.html with base './'
 * (same as the game) into assets-src/audio/prod-build, serves it statically with `vite preview`
 * and runs the audio sandbox through tools/shot.mjs --url. Proves the Blob-URL worklet and the
 * relative base work in a static build (no TypeScript at runtime, no absolute paths).
 *
 *   node tools/audio/prod-check.mjs
 */
import { build, preview } from 'vite';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'assets-src/audio/prod-build');

await build({
  root,
  base: './',
  configFile: false,
  logLevel: 'warn',
  publicDir: false, // the audio module ships no files: everything is synthesised at runtime
  cacheDir: path.join(root, 'node_modules/.vite-audio-prod'),
  build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'sandbox/audio.html') } },
});
const server = await preview({ root, base: './', configFile: false, build: { outDir }, preview: { port: 0, host: '127.0.0.1' } });
const url = server.resolvedUrls.local[0];
console.log('[prod-check] serving', url);
const code = await new Promise((res) => {
  const p = spawn(process.execPath, [path.join(root, 'tools/shot.mjs'), '--url', url, '--page', 'sandbox/audio.html?auto=1', '--out', 'screenshots/audio-prod.png',
    '--label', 'audio', '--wait', 'window.__done === true', '--timeout', '120000'], { stdio: 'inherit', cwd: root });
  p.on('exit', res);
});
await server.close();
process.exit(code ?? 1);
