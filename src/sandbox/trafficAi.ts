/**
 * Traffic AI sandbox (sandbox/trafficAi.html) on the kit: traffic around the cruising player.
 *
 * Extra URL parameters (kit ones documented in src/sandbox/kit.ts):
 *   traffic=0          no traffic (cost baseline)
 *   stub=1             force the stub vehicle factory (default: real src/traffic/vehicleFactory.ts if present)
 *   density=<n>        vehicles / km / lane (default 8)      aggr=<0..1> (default 0.5)
 *   warm=<s>           seconds of traffic pre-simulated before start, player driving up to ?s (default 40)
 *   debug=1            overlay debugInfo()
 */
import type { ITrafficVehicleFactory } from '../core/types';
import { createKit } from './kit';
import { createTraffic } from '../traffic/trafficSystem';
import { createStubFactory } from '../traffic/ai/stubFactory';

const kit = createKit();
const P = kit.params;
const num = (k: string, def: number) => (P.has(k) ? Number(P.get(k)) : def);

async function loadFactory(): Promise<ITrafficVehicleFactory> {
  if (P.get('stub') !== '1') {
    const mods = import.meta.glob('../traffic/vehicleFactory.ts');
    for (const key in mods) {
      try {
        const m = (await mods[key]()) as Record<string, unknown>;
        const opts = { lighting: kit.lighting, anisotropy: kit.ctx.quality.settings.anisotropy, ctx: kit.ctx, engine: kit.engine };
        let f: ITrafficVehicleFactory | null = null;
        for (const name of ['createTrafficVehicleFactory', 'createVehicleFactory', 'createTrafficFactory']) {
          if (typeof m[name] === 'function') f = (m[name] as (o: unknown) => ITrafficVehicleFactory)(opts);
        }
        if (!f) {
          for (const name of ['TrafficVehicleFactory', 'VehicleFactory']) {
            const C = m[name] as (new (o: unknown) => ITrafficVehicleFactory) | undefined;
            if (typeof C === 'function') f = new C(opts);
          }
        }
        if (f && typeof f.acquire === 'function') {
          await f.load();
          console.log('[ns] trafficAi: real vehicle factory');
          return f;
        }
      } catch (e) {
        console.warn('[ns] trafficAi: real factory failed, using stub', e);
      }
    }
  }
  console.log('[ns] trafficAi: stub vehicle factory');
  const stub = createStubFactory(kit.lighting);
  await stub.load();
  return stub;
}

if (P.get('traffic') !== '0') {
  const factory = await loadFactory();
  const traffic = createTraffic(kit.ctx, factory);
  kit.ctx.traffic = traffic;
  traffic.setDensity(num('density', 8));
  traffic.setAggression(num('aggr', 0.5));

  // Pre-simulate so the road around the player is already populated (spawns happen ≥ 320 m ahead).
  const p = kit.player;
  const s0 = num('s', 60);
  const d0 = num('d', 1.85);
  const speed = num('speed', 0);
  const warm = num('warm', 40);
  const DT = 1 / 120;
  const t0 = performance.now();
  for (let t = 0; t < warm; t += DT) {
    p.s = s0 - speed * (warm - t);
    p.d = d0;
    p.speed = speed;
    kit.ctx.road.toWorld(p.s, p.d, 0, p.position);
    traffic.step(DT);
  }
  console.log(`[ns] trafficAi warm ${warm}s in ${(performance.now() - t0).toFixed(0)} ms`);

  let acc = 0;
  let stepMs = 0;
  let frames = 0;
  let logged = false;
  const overlay = P.get('debug') === '1' ? document.createElement('div') : null;
  if (overlay) {
    overlay.style.cssText = 'position:fixed;left:8px;bottom:8px;color:#9cf;font:12px monospace;z-index:9';
    document.body.appendChild(overlay);
  }
  kit.onFrame((dt, time) => {
    const a = performance.now();
    acc += dt;
    while (acc >= DT) {
      traffic.step(DT);
      acc -= DT;
    }
    traffic.syncVisuals(dt, time);
    stepMs += performance.now() - a;
    frames++;
    if (overlay && frames % 15 === 0) overlay.textContent = traffic.debugInfo();
    if (!logged && (window as unknown as { __ready?: boolean }).__ready) {
      logged = true;
      console.log(`[ns] trafficAi ${traffic.debugInfo()} cpu ${(stepMs / frames).toFixed(3)} ms/frame`);
    }
  });
}

await kit.start();
