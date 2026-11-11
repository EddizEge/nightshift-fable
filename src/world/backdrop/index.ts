/**
 * Backdrop: everything beyond the road corridor.
 *
 *   createBackdrop(ctx)  camera-following sky dome with the far skyline panorama and sheet lightning
 *                        (1 draw call; emits ctx.events 'lightning' at each flash).
 *   backdropFeatures     per-chunk content to register with world.addFeature (terrain, city blocks,
 *                        industry, rural, bridge water / shore lights, tunnel hill).
 */
import { FogExp2, LinearMipmapLinearFilter, RepeatWrapping, TextureLoader, Vector2 } from 'three';
import type { Texture } from 'three';
import type { GameContext, IChunkBuilder } from '../../core/types';
import { makeRng } from '../../core/math';
import { assetUrl } from '../materials';
import { createSkyDome } from './sky';
import { generateSkyline } from './skyline';
import { camState, cullChunkMeshes, shared, tickShared } from './shared';
import { buildTerrain } from './terrain';
import { buildCity } from './city';
import { buildIndustrial } from './industrial';
import { buildRural } from './rural';
import { buildBridge } from './water';

export interface Backdrop {
  update(dt: number, time: number): void;
  dispose(): void;
  /** Trigger a lightning flash now (intensity 0..1). `hold` freezes it at its peak (screenshots). */
  flash(intensity?: number, hold?: boolean): void;
  /** Resolves when the cloud texture has loaded. */
  readonly ready: Promise<void>;
}

interface Pulse {
  t0: number;
  dur: number;
  amp: number;
}

export function createBackdrop(ctx: GameContext): Backdrop {
  const scene = ctx.engine.scene;
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));
  const cloud: Texture = new TextureLoader().load(
    assetUrl('assets/textures/noise_fbm_512.png'),
    () => resolveReady(),
    undefined,
    () => {
      console.warn('[ns] backdrop: cloud noise failed to load');
      resolveReady();
    },
  );
  cloud.wrapS = cloud.wrapT = RepeatWrapping;
  cloud.minFilter = LinearMipmapLinearFilter;
  cloud.anisotropy = 4;
  const sky = generateSkyline(7);
  const dome = createSkyDome(cloud, sky.mask, sky.windows);
  scene.add(dome.mesh);

  const rng = makeRng(0x5eed);
  let nextFlash = 7 + rng() * 9;
  let pulses: Pulse[] = [];
  let hold = false;
  let holdAmp = 0;
  let time = 0;
  const size = new Vector2();

  let selfEmit = false;
  function schedule(t: number, intensity: number, emit = true): void {
    // Direction: somewhere in the sky ahead / to the sides, low in the cloud deck.
    const az = (rng() - 0.5) * 2.6;
    const el = 0.1 + rng() * 0.32;
    const f = shared.uFlash.value;
    f.x = Math.sin(az) * Math.cos(el);
    f.y = Math.sin(el);
    f.z = -Math.cos(az) * Math.cos(el);
    pulses = [];
    const n = 1 + Math.floor(rng() * 3);
    let at = t;
    for (let i = 0; i < n; i++) {
      const dur = 0.05 + rng() * 0.1;
      pulses.push({ t0: at, dur, amp: intensity * (i === 0 ? 0.75 + rng() * 0.25 : 0.4 + rng() * 0.6) });
      at += dur + 0.03 + rng() * 0.12;
    }
    if (!emit) return;
    selfEmit = true;
    ctx.events.emit('lightning', { intensity });
    selfEmit = false;
  }
  // Lightning emitted by anyone else (director, debug triggers) flashes the sky too.
  const offLightning = ctx.events.on('lightning', (e) => {
    if (selfEmit) return;
    schedule(time, Math.min(1, Math.max(0.3, e.intensity)), false);
    hold = false;
    nextFlash = Math.max(nextFlash, time + 12);
  });

  return {
    ready,
    update(dt: number, t: number): void {
      time = t;
      tickShared(t);
      const cp = ctx.engine.camera.position;
      camState.x = cp.x;
      camState.y = cp.y;
      camState.z = cp.z;
      camState.valid = true;
      shared.uTime.value = t;
      ctx.engine.renderer.getDrawingBufferSize(size);
      shared.uViewH.value = Math.max(1, size.y);
      const fog = scene.fog as FogExp2 | null;
      dome.fogColor.copy(fog && 'color' in fog ? fog.color : ctx.lighting.uniforms.uFogColor.value);
      if (!hold && t >= nextFlash) {
        schedule(t, 0.55 + rng() * 0.45);
        nextFlash = t + 20 + rng() * 30;
      }
      let w = 0;
      if (hold) w = holdAmp;
      else {
        for (const p of pulses) {
          const x = t - p.t0;
          if (x < 0) continue;
          // Fast attack, exponential decay with a little flicker.
          const a = x < 0.02 ? x / 0.02 : Math.exp(-(x - 0.02) / (p.dur * 0.55));
          w = Math.max(w, p.amp * a * (0.85 + 0.15 * Math.sin(x * 140)));
        }
        if (pulses.length && t - pulses[pulses.length - 1].t0 > 1.5) pulses = [];
      }
      shared.uFlash.value.w = w * 1.4;
      shared.uFlashGlobal.value = w;
      void dt;
    },
    flash(intensity = 1, h = false): void {
      schedule(time, intensity);
      hold = h;
      holdAmp = intensity;
      nextFlash = time + 20 + rng() * 30;
    },
    dispose(): void {
      offLightning();
      scene.remove(dome.mesh);
      dome.mesh.geometry.dispose();
      dome.material.dispose();
      sky.mask.dispose();
      sky.windows.dispose();
      cloud.dispose();
      shared.uFlash.value.w = 0;
      shared.uFlashGlobal.value = 0;
      camState.valid = false;
    },
  };
}

/** Per-chunk content. Each entry is a separate (time-sliced) build job. */
const culled = (fn: (b: IChunkBuilder) => void) => (b: IChunkBuilder) => {
  fn(b);
  cullChunkMeshes(b);
};
export const backdropFeatures: Array<{ name: string; build: (b: IChunkBuilder) => void }> = [
  { name: 'backdrop.terrain', build: culled(buildTerrain) },
  { name: 'backdrop.city', build: culled(buildCity) },
  { name: 'backdrop.industrial', build: culled(buildIndustrial) },
  { name: 'backdrop.rural', build: culled(buildRural) },
  { name: 'backdrop.bridge', build: culled(buildBridge) },
];
