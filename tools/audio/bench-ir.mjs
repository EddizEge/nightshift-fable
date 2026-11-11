#!/usr/bin/env node
/** Main-thread cost of the tunnel IR (rendered synchronously at the context rate in build()). */
import { createServer } from 'vite';
const server = await createServer({ configFile: false, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
try {
  const { tunnelImpulse } = await server.ssrLoadModule('/src/audio/impulse.ts');
  for (const sr of [44100, 48000, 96000, 192000]) {
    const t = performance.now();
    tunnelImpulse(sr, 2.2);
    console.log(`IR ${sr}: ${(performance.now() - t).toFixed(0)} ms`);
  }
} finally {
  await server.close();
}
