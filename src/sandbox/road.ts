// Engine + road surface + lamp field test bench. ?s=<arc length>&q=<quality>&h=<cam height>&yaw=<deg>
import { BoxGeometry, Color, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { EventBus } from '../core/events';
import { Quality } from '../core/quality';
import type { QualityLevel } from '../core/types';
import { Engine } from '../render/engine';
import { RoadPath } from '../world/roadPath';
import { LightField } from '../world/lightField';
import { WorldMaterials } from '../world/materials';
import { World } from '../world/world';
import { RoadSurface } from '../world/roadSurface';
import { LAMP_HEIGHT } from '../world/roadProfile';

const qs = new URLSearchParams(location.search);
const events = new EventBus();
const quality = new Quality(events, (qs.get('q') as QualityLevel) || 'high');
const engine = new Engine(document.getElementById('c') as HTMLCanvasElement, quality, events);
const road = new RoadPath(1);
const lighting = new LightField(road);
const mats = new WorldMaterials(lighting);
const world = new World(engine.scene, road, lighting, quality, mats);
const surface = new RoadSurface(lighting, quality, mats);
world.addFeature('road', surface.build);
// Stand-in luminaires so the reflections have something to show.
const headGeo = new BoxGeometry(0.5, 0.12, 1.1);
const headMat = mats.emissive(new Color(1, 0.7, 0.4), 60);
world.addFeature('lampheads', (b) => {
  for (const l of b.spec.lamps) {
    if (!l.on) continue;
    const m = new Mesh(headGeo, headMat);
    b.road.toWorld(l.s, l.d, LAMP_HEIGHT + 0.1, m.position);
    m.rotation.y = -b.road.headingAt(l.s);
    b.addObject(m);
  }
});
engine.addReflectionReceiver(surface);

const s0 = Number(qs.get('s') ?? 40);
const camH = Number(qs.get('h') ?? 1.5);
lighting.setPlayerS(s0);
world.update(s0, 0, 0);
world.buildAll();

// A stand-in car body to check AO, shadows and tail-light pools.
const car = new Mesh(new BoxGeometry(1.9, 1.3, 4.6), lighting.patchDynamic(new MeshStandardMaterial({ color: 0x223344, roughness: 0.25, metalness: 0.6 })));
road.toWorld(s0 + 18, 1.85, 0.65, car.position);
car.rotation.y = -road.headingAt(s0 + 18);
engine.scene.add(car);
const cp = new Vector3();
road.toWorld(s0 + 18, 1.85, 0, cp);
surface.setCars([{ x: cp.x, z: cp.z, heading: road.headingAt(s0 + 18), halfWidth: 0.95, halfLength: 2.3, height: 1.3 }]);
const back = new Vector3();
road.toWorld(s0 + 15.6, 1.85, 0, back);
const f = road.frameAt(s0 + 15.6);
surface.setPools([{ x: back.x, z: back.z, dx: -f.tx, dz: -f.tz, r: 1.2, g: 0.05, b: 0.02, size: 2.2 }]);

const cam = engine.camera;
road.toWorld(s0, Number(qs.get('d') ?? 1.85), camH, cam.position);
const look = new Vector3();
road.toWorld(s0 + 30, 1.0, camH * 0.6, look);
cam.lookAt(look);
cam.rotateY(((Number(qs.get('yaw') ?? 0)) * Math.PI) / 180);

let last = performance.now();
let frames = 0;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  lighting.update(dt, now / 1000);
  world.update(s0, dt, now / 1000);
  engine.render({ dt, rawDt: dt, time: now / 1000, player: null, speedFx: 0, flash: 0, damage: 0 });
  frames++;
  if (frames === 30) {
    Promise.all(mats.pending).then(() => {
      (window as unknown as { __ready: boolean }).__ready = true;
      console.log(`[ns] calls=${engine.stats.calls} tris=${engine.stats.triangles} programs=${engine.stats.programs} ms=${engine.frameMs.toFixed(1)}`);
    });
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
