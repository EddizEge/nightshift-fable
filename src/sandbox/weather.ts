/**
 * Weather sandbox (sandbox/weather.html) on the kit: rain streaks, ground splashes, tyre spray of
 * the player and of a few fake traffic boxes, lens rain.
 *
 * Extra URL parameters (on top of the kit's, see src/sandbox/kit.ts):
 *   rain=0        no weather at all (baseline cost)
 *   int=<0..1>    rain intensity (default 1)
 *   traffic=0     no fake traffic
 *   lens=0        no lens rain effect
 *   burst=<s>     a big splash() every <s> seconds 12 m ahead of the car
 *   ts=<x>        weather time scale (slow-motion check; use with speed=0)
 *   hide=a,b      hide weather meshes by name (rainStreaks, rainSplashes, tyreSpray)
 */
import { BoxGeometry, Color, Mesh, MeshBasicMaterial, MeshStandardMaterial, Vector3 } from 'three';
import { createKit } from './kit';
import { createWeather } from '../weather/index';
import type { TrafficVehicle, TrafficVehicleDef } from '../core/types';

const kit = createKit();
const P = kit.params;
const num = (k: string, d: number) => (P.has(k) ? Number(P.get(k)) : d);

interface Fake {
  v: Partial<TrafficVehicle> & { position: Vector3; def: TrafficVehicleDef };
  mesh: Mesh;
  relS: number;
  d: number;
  /** Absolute speed (m/s). */
  speed: number;
}

function def(type: TrafficVehicleDef['type'], length: number, width: number, height: number): TrafficVehicleDef {
  return { type, length, width, height, mass: 1500, speedMin: 20, speedMax: 30, tailY: height > 2.4 ? 1.0 : 0.85, tailX: width * 0.5 - 0.2, headY: 0.7, headX: width * 0.5 - 0.25 };
}

const fakes: Fake[] = [];
if (P.get('traffic') !== '0' && P.get('rain') !== '0') {
  const body = kit.lighting.patchDynamic(new MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.35, metalness: 0.4 }));
  const tailMat = new MeshBasicMaterial({ color: new Color(1, 0.04, 0.02).multiplyScalar(6) });
  const add = (d0: TrafficVehicleDef, relS: number, d: number, speed: number) => {
    const g = new BoxGeometry(d0.width, d0.height - 0.3, d0.length);
    g.translate(0, d0.height * 0.5 + 0.15, 0);
    const mesh = new Mesh(g, body);
    for (const sx of [-1, 1]) {
      const t = new Mesh(new BoxGeometry(0.3, 0.12, 0.05), tailMat);
      t.position.set(sx * d0.tailX, d0.tailY, d0.length * 0.5 + 0.03);
      mesh.add(t);
    }
    kit.engine.scene.add(mesh);
    fakes.push({ v: { id: fakes.length, position: new Vector3(), heading: 0, speed: 0, def: d0, s: 0, d, mode: 'drive', braking: 0 }, mesh, relS, d, speed });
  };
  // tspeed=<m/s> overrides the truck speed (default: player speed, capped at 26 m/s)
  const vt = num('tspeed', Math.min(26, kit.speed));
  add(def('semi', 13, 2.55, 3.9), num('trel', 30), -1.85, vt);
  add(def('sedan', 4.8, 1.85, 1.45), 62, 5.55, Math.min(32, kit.speed));
  add(def('boxtruck', 8, 2.4, 3.2), 110, -5.55, Math.min(24, kit.speed));
  add(def('hatch', 4.2, 1.8, 1.5), -18, -5.55, Math.min(34, kit.speed * 1.02));
  kit.ctx.traffic = { vehicles: fakes.map((f) => f.v) } as never;
}

const weather = P.get('rain') === '0' ? null : createWeather(kit.ctx);
if (weather) {
  kit.ctx.weather = weather;
  weather.setIntensity(num('int', 1));
  if (P.get('lens') !== '0') for (const e of weather.distortionEffects) kit.engine.addDistortionEffect(e);
}
(window as unknown as { __weather: unknown }).__weather = weather;

const ts = num('ts', 1);
/** hide=<mesh names, comma separated> (rainStreaks, rainSplashes, tyreSpray) for cost / debug. */
const hide = (P.get('hide') || '').split(',').filter(Boolean);
(window as unknown as { __hide: string[] }).__hide = hide;
const burst = num('burst', 0);
let burstT = 0;
const tmp = new Vector3();
kit.onFrame((dt, time) => {
  const p = kit.player;
  for (const f of fakes) {
    f.relS += (f.speed - kit.speed) * dt;
    // vehicles we overtake re-appear far ahead
    if (f.relS < -60) f.relS += 220;
    const s = p.s + f.relS;
    const fr = kit.ctx.road.frameAt(s);
    kit.ctx.road.toWorld(s, f.d, 0, f.v.position);
    f.v.s = s;
    f.v.heading = fr.h;
    f.v.speed = f.speed;
    f.mesh.position.copy(f.v.position);
    f.mesh.rotation.set(0, -fr.h, 0);
  }
  if (!weather) return;
  if (burst > 0) {
    burstT += dt;
    if (burstT >= burst) {
      burstT = 0;
      kit.ctx.road.toWorld(p.s + 12, p.d - 3.7, 0, tmp);
      weather.splash(tmp, 1.5);
    }
  }
  weather.update(dt * ts, time);
  if (hide.length) kit.engine.scene.traverse((o) => { if (hide.includes(o.name)) o.visible = false; });
});

await kit.start();
