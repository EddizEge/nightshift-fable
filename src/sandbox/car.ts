/**
 * NIGHTSHIFT — hero car studio (sandbox/car.html).
 *
 * Self-contained look-dev scene for the player car: dark wet glossy floor (planar reflection under a
 * thin water film), dimmed RoomEnvironment IBL plus bright emissive strips so reflections read,
 * ACES tone mapping, sRGB output.
 *
 * Query: view=front34|rear34|side|top|wheel|interior|low|tail|chase|bonnet  paint=graphite|carmine|pearl|midnight
 *        q=low (quality preset seen by the car: no rain beads)
 *        brake=1  steer=0.5 (rad)  spin=1 (animate wheels)  lights=0|1  damage=0..1  reverse=1  orbit=1
 *        model=<url> (another packed car file, default the game's assets/models/player_car.glb)
 */
import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Timer,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LAYERS } from '../core/types';
import type { PlayerState } from '../core/types';
import { createPlayerCarVisual } from '../vehicle/playerCarVisual';
import type { PaintName } from '../vehicle/playerCarVisual';

declare global {
  interface Window { __ready?: boolean; __car?: unknown }
}

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const view = q.get('view') ?? 'front34';
const paint = (q.get('paint') ?? 'graphite') as PaintName;

const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exposure', 1.0);
renderer.outputColorSpace = SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0.004, 0.005, 0.007);

// ── studio light strips: visible in the scene and baked into the env map (so paint/glass reflect them)
function addStrips(target: Scene | Group, gain: number): void {
  const mk = (w: number, h: number, d: number, x: number, y: number, z: number, c: [number, number, number]) => {
    const m = new Mesh(new BoxGeometry(w, h, d), new MeshBasicMaterial({ color: new Color(c[0] * gain, c[1] * gain, c[2] * gain), toneMapped: true }));
    m.position.set(x, y, z);
    target.add(m);
  };
  // overhead softbox lines along the car
  for (const x of [-1.1, 0, 1.1]) mk(0.12, 0.04, 7, x, 4.2, 0, [1, 1, 1]);
  // cool side strips
  mk(0.05, 0.22, 9, -9, 1.3, 0, [0.55, 0.7, 1]);
  mk(0.05, 0.22, 9, 9, 1.3, 0, [0.55, 0.7, 1]);
  mk(0.05, 0.12, 9, -9, 2.4, 0, [0.55, 0.7, 1]);
  mk(0.05, 0.12, 9, 9, 2.4, 0, [0.55, 0.7, 1]);
  // warm rear / front bars (fake street-lamp tint)
  mk(6, 0.08, 0.06, 0, 2.6, 6.5, [1, 0.62, 0.3]);
  mk(6, 0.08, 0.06, 0, 2.6, -6.5, [1, 0.62, 0.3]);
}
addStrips(scene, 4);

const pmrem = new PMREMGenerator(renderer);
const room = new RoomEnvironment();
// Dim the room itself (it is a bright white box); the strips added below then dominate the reflections.
room.traverse((o) => {
  const m = (o as Mesh).material as MeshBasicMaterial | undefined;
  if (m?.color) m.color.multiplyScalar(0.08);
});
const envGroup = new Group();
addStrips(envGroup, 30);
room.add(envGroup);
const envTex = pmrem.fromScene(room, 0.04).texture;
scene.environment = envTex;
// dim studio: the game's night IBL is dark, the strips carry the reflections
scene.environmentIntensity = num('envScene', 1);

// ── wet floor: mirror reflection + thin dark water film with slight roughness on top
const reflector = new Reflector(new PlaneGeometry(60, 60), {
  textureWidth: 2048, textureHeight: 1024, color: new Color(0.25, 0.255, 0.26), clipBias: 0.002,
});
reflector.rotation.x = -Math.PI / 2;
scene.add(reflector);
const film = new Mesh(
  new PlaneGeometry(60, 60),
  new MeshBasicMaterial({ color: new Color(0.003, 0.0035, 0.004), transparent: true, opacity: 0.5, depthWrite: false }),
);
film.rotation.x = -Math.PI / 2;
film.position.y = 0.002;
scene.add(film);

// ── camera
const camera = new PerspectiveCamera(32, innerWidth / innerHeight, 0.05, 200);
camera.layers.enable(LAYERS.PLAYER);
const VIEWS: Record<string, { pos: [number, number, number]; at: [number, number, number]; fov: number }> = {
  front34: { pos: [-4.6, 1.55, -5.4], at: [0, 0.55, -0.2], fov: 32 },
  rear34: { pos: [4.8, 1.6, 5.2], at: [0, 0.55, 0.2], fov: 32 },
  side: { pos: [-8.2, 0.85, 0], at: [0, 0.6, 0], fov: 32 },
  top: { pos: [0, 11.5, 0.001], at: [0, 0, 0], fov: 30 },
  wheel: { pos: [-2.25, 0.55, -2.35], at: [-0.95, 0.4, -1.4], fov: 32 },
  interior: { pos: [-1.55, 1.25, 0.35], at: [0.1, 0.72, -0.75], fov: 45 },
  low: { pos: [-2.6, 0.28, -5.6], at: [0, 0.55, -0.6], fov: 34 },
  // close look at the tail panel mesh, and the game's chase distance from behind
  tail: { pos: [0.35, 0.78, 3.35], at: [0, 0.6, 2.2], fov: 30 },
  chase: { pos: [0, 1.65, 6.6], at: [0, 0.8, -10], fov: 55 },
  // bonnet as the bonnet camera sees it (grazing): rain-bead sheen check
  bonnet: { pos: [0, 1.0, -1.25], at: [0, 0.7, -12], fov: 70 },
};
const V = VIEWS[view] ?? VIEWS.front34;
camera.fov = V.fov;
camera.position.set(...V.pos);
camera.lookAt(new Vector3(...V.at));
camera.updateProjectionMatrix();
let controls: OrbitControls | null = null;
if (q.get('orbit') === '1') {
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...V.at);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ── fake simulation state
function makeState(): PlayerState {
  const z = () => new Vector3();
  return {
    position: new Vector3(), quaternion: new Quaternion(), velocity: z(), heading: 0, yawRate: 0, speed: 0, speedKmh: 0,
    lateralSpeed: 0, s: 0, d: 0, relHeading: 0, throttle: 0, brake: num('brake', 0), steerAngle: num('steer', 0),
    handbrake: false, rpm: 900, rpm01: 0.1, gear: q.get('reverse') === '1' ? -1 : 1, nitro01: 1, nitroActive: false,
    accelLong: 0, accelLat: 0, wheelSkid: [0, 0, 0, 0], wheelSpin: [0, 0, 0, 0], suspension: [0, 0, 0, 0],
    bodyPitch: num('pitch', 0), bodyRoll: num('roll', 0), wheelContacts: [z(), z(), z(), z()], damage: num('damage', 0),
    alive: true, wrecked: false,
    dims: { length: 4.3, width: 2, height: 1.2, wheelBase: 2.8, trackFront: 1.9, trackRear: 1.9, wheelRadius: 0.38, frontAxle: 1.4, rearAxle: 1.4, cgHeight: 0.45, mass: 1500 },
  };
}

const info = document.getElementById('info')!;
// ?model=<url> loads another packed car (e.g. a test pack from tools/car/pack.mjs --out ...)
// ?q=low checks the low-quality path (no rain beads)
const car = await createPlayerCarVisual({
  anisotropy: renderer.capabilities.getMaxAnisotropy(), url: q.get('model') ?? undefined, quality: { level: q.get('q') ?? 'high' },
});
// The Reflector's mirror camera only renders layer 0: let the studio floor see the car too.
car.root.traverse((o) => o.layers.enable(LAYERS.DEFAULT));
scene.add(car.root);
car.setPaint(paint);
car.setEnvMap(envTex, num('env', 1));
car.setLights({ headlights: q.get('lights') !== '0' });
car.setDamage(num('damage', 0));
car.setWetness(num('wet', 1));
const state = makeState();
state.dims = car.dims;
window.__car = car;

info.textContent = `view=${view} paint=${paint} drawCalls(car)=${car.drawCalls} tris=${car.triangles}`;
console.log(`[ns] car loaded: drawCalls=${car.drawCalls} tris=${car.triangles} dims=${JSON.stringify(car.dims)}`);
console.log(`[ns] wheelLocal=${JSON.stringify(car.wheelLocal.map((v) => v.toArray().map((x) => +x.toFixed(3))))}`);
console.log(`[ns] anchors=${JSON.stringify(Object.fromEntries(Object.entries(car.anchors).map(([k, o]) => [k, o.position.toArray().map((x) => +x.toFixed(3))])))}`);

const spin = q.get('spin') === '1';
const clock = new Timer();
let frames = 0;
renderer.setAnimationLoop(() => {
  clock.update();
  const dt = Math.min(0.05, clock.getDelta());
  if (spin) for (let i = 0; i < 4; i++) state.wheelSpin[i] = (state.wheelSpin[i] + dt * 6) % (Math.PI * 2);
  car.update(dt, state);
  controls?.update();
  renderer.render(scene, camera);
  if (++frames === 8) {
    const r = renderer.info.render;
    console.log(`[ns] frame: calls=${r.calls} triangles=${r.triangles}`);
    window.__ready = true;
  }
});
