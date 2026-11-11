/**
 * Driving test bench: VehicleSim + CameraRig on a plain lit highway stand-in.
 *
 * Keys: W/S or arrows = throttle / brake (+reverse), A/D = steer, Space = handbrake, Shift = nitro,
 *       C = chase ↔ hood, R = reset, K = shake.
 * Query: ?auto=launch|lanechange|drift|brake  scripted inputs + [ns] telemetry logs (headless runs)
 *        &cam=chase|hood|orbit|crash          initial camera mode
 *        &at=<s>                              set window.__ready once the scenario reached this time
 *        &speed=<km/h>                        start speed for manual driving
 *        &freeze                              stop the simulation + camera once ready (stable screenshots)
 */
import {
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Vector3,
  Quaternion,
  WebGLRenderer,
  ACESFilmicToneMapping,
} from 'three';
import type { DriveControls, PlayerState } from '../core/types';
import { VehicleSim } from '../vehicle/vehicleSim';
import { CameraRig } from '../vehicle/cameraRig';

declare global {
  interface Window {
    __ready?: boolean;
    __drive?: { sim: VehicleSim; rig: CameraRig };
  }
}

const qs = new URLSearchParams(location.search);
const auto = qs.get('auto') ?? '';
const readyAt = Number(qs.get('at') ?? (auto ? '3' : '0.5'));
const freeze = qs.has('freeze');
const KMH = 1 / 3.6;
const DT = 1 / 120;

// ── Renderer / scene ─────────────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
const scene = new Scene();
scene.background = new Color(0.012, 0.016, 0.028);
scene.fog = new FogExp2(new Color(0.02, 0.026, 0.04), 0.0065);
const camera = new PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 2500);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

scene.add(new HemisphereLight(new Color(0.35, 0.42, 0.6), new Color(0.05, 0.05, 0.06), 0.55));
scene.add(new AmbientLight(new Color(0.2, 0.22, 0.3), 0.25));
const moon = new DirectionalLight(new Color(0.7, 0.78, 1), 0.7);
moon.position.set(-30, 60, 20);
scene.add(moon);

// Ground: asphalt-like noise texture so motion and slides read clearly.
function asphaltTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#26282c';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const v = 24 + Math.random() * 40;
    g.fillStyle = `rgb(${v},${v},${v + 4})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5);
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const groundTex = asphaltTexture();
const GROUND = 3000;
groundTex.repeat.set(GROUND / 8, GROUND / 8);
const ground = new Mesh(new PlaneGeometry(GROUND, GROUND), new MeshStandardMaterial({ map: groundTex, roughness: 0.55, metalness: 0 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// Lane markings + roadside posts, recentred on the car every PERIOD metres (an endless road).
const LANE = 3.6;
const PERIOD = 36;
const SPAN = 900;
const markings = new Group();
scene.add(markings);
const paint = new MeshStandardMaterial({ color: new Color(0.85, 0.85, 0.8), roughness: 0.4, emissive: new Color(0.1, 0.1, 0.09) });
const dashGeo = new BoxGeometry(0.15, 0.01, 3);
const dashes: Array<[number, number]> = [];
for (const lx of [-LANE * 1.5, -LANE * 0.5, LANE * 0.5, LANE * 1.5]) for (let z = -SPAN; z < SPAN; z += 12) dashes.push([lx, z]);
const dashMesh = new InstancedMesh(dashGeo, paint, dashes.length);
const o3 = new Object3D();
dashes.forEach(([x, z], i) => {
  o3.position.set(x, 0.005, z);
  o3.updateMatrix();
  dashMesh.setMatrixAt(i, o3.matrix);
});
markings.add(dashMesh);
for (const ex of [-LANE * 2.5 - 0.2, LANE * 2.5 + 0.2]) {
  const edge = new Mesh(new BoxGeometry(0.2, 0.01, SPAN * 2), paint);
  edge.position.set(ex, 0.005, 0);
  markings.add(edge);
}
const postGeo = new BoxGeometry(0.15, 1.1, 0.15);
const postMat = new MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.5 });
const reflMat = new MeshBasicMaterial({ color: new Color(3, 1.2, 0.2) });
const posts: Vector3[] = [];
for (const px of [-LANE * 2.5 - 1.2, LANE * 2.5 + 1.2]) for (let z = -SPAN; z < SPAN; z += 18) posts.push(new Vector3(px, 0.55, z));
const postMesh = new InstancedMesh(postGeo, postMat, posts.length);
const reflMesh = new InstancedMesh(new BoxGeometry(0.17, 0.12, 0.17), reflMat, posts.length);
posts.forEach((p, i) => {
  o3.position.copy(p);
  o3.updateMatrix();
  postMesh.setMatrixAt(i, o3.matrix);
  o3.position.y = 0.95;
  o3.updateMatrix();
  reflMesh.setMatrixAt(i, o3.matrix);
});
markings.add(postMesh, reflMesh);
// A few overhead lamps so the scene has night-time pools of light.
const lampMat = new MeshBasicMaterial({ color: new Color(6, 4, 2) });
for (let z = -SPAN; z < SPAN; z += 108) {
  const head = new Mesh(new BoxGeometry(0.6, 0.15, 1.2), lampMat);
  head.position.set(LANE * 2.5 + 0.5, 10, z);
  markings.add(head);
  if (Math.abs(z) < 230) {
    const pl = new PointLight(new Color(1, 0.72, 0.42), 260, 45, 1.6);
    pl.position.set(LANE * 2.5 - 1, 9.5, z);
    markings.add(pl);
  }
}

// ── Car stand-in: body, cabin, 4 wheels (steer / spin / suspension visible) ──────────────────────
const sim = new VehicleSim();
const dims = sim.dims;
const car = new Group();
const body = new Group();
car.add(body);
scene.add(car);
const paintMat = new MeshStandardMaterial({ color: new Color(0.55, 0.06, 0.04), roughness: 0.3, metalness: 0.4 });
const glassMat = new MeshStandardMaterial({ color: 0x0b0e14, roughness: 0.1, metalness: 0.8 });
const lower = new Mesh(new BoxGeometry(dims.width, 0.55, dims.length), paintMat);
lower.position.y = 0.52;
const cabin = new Mesh(new BoxGeometry(dims.width * 0.8, 0.42, dims.length * 0.42), glassMat);
cabin.position.set(0, 0.99, 0.25);
const tailMat = new MeshBasicMaterial({ color: new Color(4, 0.15, 0.1) });
const headMat = new MeshBasicMaterial({ color: new Color(6, 6, 5.5) });
for (const sx of [-1, 1]) {
  const tl = new Mesh(new BoxGeometry(0.45, 0.08, 0.04), tailMat);
  tl.position.set(sx * dims.width * 0.33, 0.68, dims.length / 2 + 0.01);
  const hl = new Mesh(new BoxGeometry(0.4, 0.08, 0.04), headMat);
  hl.position.set(sx * dims.width * 0.33, 0.62, -dims.length / 2 - 0.01);
  body.add(tl, hl);
}
body.add(lower, cabin);
const wheelGeo = new CylinderGeometry(dims.wheelRadius, dims.wheelRadius, 0.26, 20);
wheelGeo.rotateZ(Math.PI / 2);
const tyreMat = new MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
const spokeMat = new MeshStandardMaterial({ color: 0xb0b4bb, roughness: 0.3, metalness: 0.8 });
const wheels: Group[] = [];
const spinners: Group[] = [];
for (let i = 0; i < 4; i++) {
  const steerG = new Group();
  const spin = new Group();
  spin.add(new Mesh(wheelGeo, tyreMat));
  const spoke = new Mesh(new BoxGeometry(0.28, dims.wheelRadius * 1.6, 0.09), spokeMat);
  spin.add(spoke);
  steerG.add(spin);
  const lf = i < 2 ? dims.frontAxle : -dims.rearAxle;
  const half = ((i < 2 ? dims.trackFront : dims.trackRear) - 0.26) / 2;
  steerG.position.set(i % 2 === 0 ? -half : half, dims.wheelRadius, -lf);
  car.add(steerG);
  wheels.push(steerG);
  spinners.push(spin);
}
const headLight = new PointLight(new Color(1, 0.95, 0.85), 120, 40, 1.4);
headLight.position.set(0, 1.0, -9);
car.add(headLight);

// ── Player state (owned by the game in the real build) ───────────────────────────────────────────
const state: PlayerState = {
  position: new Vector3(),
  quaternion: new Quaternion(),
  velocity: new Vector3(),
  heading: 0, yawRate: 0, speed: 0, speedKmh: 0, lateralSpeed: 0, s: 0, d: 0, relHeading: 0,
  throttle: 0, brake: 0, steerAngle: 0, handbrake: false, rpm: 0, rpm01: 0, gear: 1, nitro01: 1, nitroActive: false,
  accelLong: 0, accelLat: 0,
  wheelSkid: [0, 0, 0, 0], wheelSpin: [0, 0, 0, 0], suspension: [0, 0, 0, 0],
  bodyPitch: 0, bodyRoll: 0,
  wheelContacts: [new Vector3(), new Vector3(), new Vector3(), new Vector3()],
  damage: 0, alive: true, wrecked: false, dims,
};

const rig = new CameraRig(camera);
const camMode = qs.get('cam');
if (camMode === 'hood' || camMode === 'orbit' || camMode === 'crash' || camMode === 'chase') rig.setMode(camMode);
window.__drive = { sim, rig };

// ── Input ────────────────────────────────────────────────────────────────────────────────────────
const keys = new Set<string>();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyC') rig.nextMode();
  if (e.code === 'KeyR') restart();
  if (e.code === 'KeyK') rig.addShake(0.6);
});
addEventListener('keyup', (e) => keys.delete(e.code));
const ctl: DriveControls = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false };
const k = (...c: string[]) => c.some((x) => keys.has(x));
function keyboard(): void {
  ctl.throttle = k('KeyW', 'ArrowUp') ? 1 : 0;
  ctl.brake = k('KeyS', 'ArrowDown') ? 1 : 0;
  ctl.steer = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0);
  ctl.handbrake = k('Space');
  ctl.nitro = k('ShiftLeft', 'ShiftRight');
}

// ── Scripted scenarios ───────────────────────────────────────────────────────────────────────────
const START: Record<string, number> = { launch: 0, lanechange: 250, drift: 140, brake: 200 };
function restart(): void {
  sim.reset(0, 0, 0, (START[auto] ?? Number(qs.get('speed') ?? 0)) * KMH);
  rig.snap();
  simTime = 0;
}
function scripted(t: number): void {
  ctl.throttle = 0;
  ctl.brake = 0;
  ctl.steer = 0;
  ctl.handbrake = false;
  ctl.nitro = false;
  switch (auto) {
    case 'launch':
      ctl.throttle = 1;
      ctl.nitro = t > 12 && t < 16;
      break;
    case 'lanechange': {
      ctl.throttle = 0.6;
      const c = t % 4; // tap right, wait, tap left, wait
      ctl.steer = c > 0.5 && c < 0.9 ? 1 : c > 2.5 && c < 2.9 ? -1 : 0;
      break;
    }
    case 'drift': {
      const c = t % 5;
      ctl.steer = c > 0.2 && c < 1.0 ? 1 : 0;
      ctl.handbrake = c > 0.2 && c < 1.0;
      ctl.throttle = c > 1.0 ? 0.5 : 0.3;
      break;
    }
    case 'brake':
      ctl.brake = t > 0.5 ? 1 : 0;
      ctl.throttle = t <= 0.5 ? 0.3 : 0;
      break;
  }
}

// ── Loop ─────────────────────────────────────────────────────────────────────────────────────────
const hud = document.getElementById('hud')!;
let simTime = 0;
let acc = 0;
let last = performance.now();
let nextLog = 0;
let maxSlip = 0;
let fpsAcc = 0;
let fpsN = 0;
let fps = 0;
restart();

function slipDeg(): number {
  return Math.abs(sim.speed) > 1 ? (Math.atan2(sim.lateralSpeed, Math.abs(sim.speed)) * 180) / Math.PI : 0;
}

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 0.5) {
    fps = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
  }
  // Scripted runs advance a fixed amount per frame so headless timing is deterministic.
  // With &freeze the scene stops once ready so the screenshot shows exactly the logged moment.
  const frozen = freeze && !!window.__ready;
  const step = frozen ? 0 : auto ? 1 / 60 : dt;
  acc += step;
  while (acc >= DT) {
    acc -= DT;
    if (auto) scripted(simTime);
    else keyboard();
    sim.step(DT, ctl, { grip: 1 });
    simTime += DT;
    maxSlip = Math.max(maxSlip, Math.abs(slipDeg()));
    if (auto && simTime >= nextLog) {
      nextLog += 0.25;
      console.log(
        `[ns] ${auto} t=${simTime.toFixed(2)} kmh=${(sim.speed * 3.6).toFixed(1)} gear=${sim.gear} rpm=${sim.rpm.toFixed(0)} ` +
          `slip=${slipDeg().toFixed(1)} head=${((sim.heading * 180) / Math.PI).toFixed(1)} x=${sim.x.toFixed(2)} ` +
          `aLat=${sim.accelLat.toFixed(2)} aLong=${sim.accelLong.toFixed(2)} skidR=${sim.wheelSkid[3].toFixed(2)} nitro=${sim.nitro01.toFixed(2)}`,
      );
    }
  }
  sim.writeState(state);

  // Car visual.
  car.position.copy(state.position);
  car.quaternion.copy(state.quaternion);
  body.rotation.set(state.bodyPitch, 0, -state.bodyRoll);
  body.position.y = -(state.suspension[0] + state.suspension[1] + state.suspension[2] + state.suspension[3]) * 0.25;
  for (let i = 0; i < 4; i++) {
    wheels[i].rotation.y = i < 2 ? -state.steerAngle : 0;
    wheels[i].position.y = dims.wheelRadius;
    spinners[i].rotation.x = -state.wheelSpin[i];
  }
  // Endless road: recentre the markings on the car.
  markings.position.z = Math.round(state.position.z / PERIOD) * PERIOD;
  ground.position.set(Math.round(state.position.x / 8) * 8, 0, Math.round(state.position.z / 8) * 8);

  if (!frozen) rig.update(auto ? step : dt, state, auto ? simTime : now / 1000);
  renderer.render(scene, camera);

  hud.textContent =
    `${auto || 'manual'}  cam=${rig.mode}  fps=${fps.toFixed(0)}  t=${simTime.toFixed(2)}\n` +
    `${state.speedKmh.toFixed(0).padStart(4)} km/h  gear ${state.gear === -1 ? 'R' : state.gear}  ${state.rpm.toFixed(0)} rpm\n` +
    `slip ${slipDeg().toFixed(1)}° (max ${maxSlip.toFixed(1)})  latG ${state.accelLat.toFixed(2)}  longG ${state.accelLong.toFixed(2)}\n` +
    `steer ${((state.steerAngle * 180) / Math.PI).toFixed(2)}°  nitro ${(state.nitro01 * 100).toFixed(0)}%${state.nitroActive ? ' ON' : ''}  fov ${camera.fov.toFixed(1)}\n` +
    `skid ${state.wheelSkid.map((s) => s.toFixed(2)).join(' ')}\n` +
    `W/S throttle-brake  A/D steer  Space handbrake  Shift nitro  C camera  R reset`;

  if (!window.__ready && simTime >= readyAt) {
    window.__ready = true;
    console.log(`[ns] ready t=${simTime.toFixed(2)} kmh=${state.speedKmh.toFixed(1)} cam=${rig.mode} fov=${camera.fov.toFixed(1)}`);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
