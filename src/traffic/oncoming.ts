/**
 * Decorative oncoming traffic on the opposite carriageway (OPPOSITE_LANE_CENTERS, driving towards -s).
 * Every vehicle in a lane moves at that lane's speed, so they can never overlap. Spawned beyond the
 * fog ahead, removed behind the player. Pooled; no allocation in step / sync.
 */
import { Vector3 } from 'three';
import type { GameContext, ITrafficVehicleFactory, ITrafficVisual, RoadFrame, TrafficVehicleDef } from '../core/types';
import { OPPOSITE_LANE_CENTERS } from '../world/roadProfile';
import { pickType } from './ai/defs';

export interface OncomingVehicle {
  position: Vector3;
  heading: number;
  s: number;
  d: number;
  def: TrafficVehicleDef;
}

interface Ov extends OncomingVehicle {
  visual: ITrafficVisual | null;
  lane: number;
}

export const ONCOMING_RULES = { spawnMin: 470, spawnMax: 820, removeBehind: 120, minGap: 30 } as const;

export class OncomingTraffic {
  readonly list: Ov[] = [];
  private readonly pool: Ov[] = [];
  private readonly laneSpeed = [34, 31, 28, 25];
  private readonly f: RoadFrame = { s: 0, x: 0, z: 0, h: 0, k: 0, tx: 0, tz: -1, rx: 1, rz: 0 };
  private spawnCooldown = 0;
  private seq = 0;
  /** Target count = min(quality.oncomingMax, density × this). */
  densityScale = 1.4;

  constructor(
    private readonly ctx: GameContext,
    private readonly factory: ITrafficVehicleFactory,
    private readonly rng: () => number,
  ) {
    this.shuffleSpeeds();
  }

  private shuffleSpeeds(): void {
    const base = [34, 31, 28, 25];
    for (let i = 0; i < 4; i++) this.laneSpeed[i] = Math.min(36, Math.max(24, base[i] + (this.rng() - 0.5) * 3));
  }

  reset(): void {
    while (this.list.length) this.release(this.list.length - 1);
    this.shuffleSpeeds();
    this.spawnCooldown = 0;
  }

  private release(i: number): void {
    const v = this.list[i];
    if (v.visual) {
      v.visual.object.removeFromParent();
      this.factory.release(v.visual);
      v.visual = null;
    }
    const last = this.list.pop()!;
    if (i < this.list.length) this.list[i] = last;
    this.pool.push(v);
  }

  step(dt: number, density: number): void {
    const road = this.ctx.road;
    const ps = this.ctx.player.s;
    const f = this.f;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const v = this.list[i];
      road.frameAt(v.s, f);
      v.s -= (this.laneSpeed[v.lane] / Math.max(0.5, 1 - f.k * v.d)) * dt;
      if (v.s < ps - ONCOMING_RULES.removeBehind || v.s > ps + 1200) this.release(i);
      else this.pose(v);
    }
    const max = this.ctx.quality.settings.oncomingMax;
    const target = Math.min(max, Math.round(density * this.densityScale));
    this.spawnCooldown -= dt;
    if (this.list.length < target && this.spawnCooldown <= 0) {
      this.trySpawn(ps);
      this.spawnCooldown = 0.12 + this.rng() * 0.25;
    }
  }

  private trySpawn(ps: number): void {
    const r = this.rng;
    const type = pickType(r(), r(), 0.24);
    const def = this.factory.defs[type];
    const heavy = type === 'boxtruck' || type === 'semi' || type === 'tanker';
    const lane = heavy ? 2 + (r() < 0.7 ? 1 : 0) : Math.floor(r() * 4);
    const s = ps + ONCOMING_RULES.spawnMin + r() * (ONCOMING_RULES.spawnMax - ONCOMING_RULES.spawnMin);
    for (const o of this.list) {
      if (o.lane !== lane) continue;
      if (Math.abs(o.s - s) < o.def.length * 0.5 + def.length * 0.5 + ONCOMING_RULES.minGap) return;
    }
    const v: Ov = this.pool.pop() ?? { position: new Vector3(), heading: 0, s: 0, d: 0, def, visual: null, lane: 0 };
    v.def = def;
    v.s = s;
    v.lane = lane;
    v.d = OPPOSITE_LANE_CENTERS[lane];
    v.visual = this.factory.acquire(type, (this.seq++ * 2654435761) >>> 8);
    this.ctx.engine.scene.add(v.visual.object);
    this.list.push(v);
    this.pose(v);
  }

  private pose(v: Ov): void {
    const f = this.ctx.road.frameAt(v.s, this.f);
    v.position.set(f.x + f.rx * v.d, 0, f.z + f.rz * v.d);
    v.heading = f.h + Math.PI;
  }

  sync(time: number): void {
    for (const v of this.list) {
      const o = v.visual!.object;
      o.position.copy(v.position);
      o.rotation.set(0, -v.heading, 0);
      v.visual!.setLights(0, 0, time);
    }
  }
}
