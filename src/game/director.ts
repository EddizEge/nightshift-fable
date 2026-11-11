/**
 * Cinematic event director. Two set pieces, both fully simulated and playable:
 *   A "Highway Chain Reaction": a truck loses it next to a fuel tanker ahead; the pile-up explodes
 *      and the player has to thread the one lane that stays open.
 *   B "The Last-Second Escape": a tanker crashes through the parapet of an overpass and drops
 *      onto the carriageway moments before the player gets there.
 */
import { Quaternion, Vector3 } from 'three';
import type {
  CinematicId,
  FireHandle,
  GameContext,
  ITrafficVehicleFactory,
  ITrafficVisual,
  TrafficVehicle,
  WreckBody,
} from '../core/types';
import { clamp } from '../core/math';
import { breakOverpassRailing } from '../world/features/structures';
import { BARRIER_LEFT_D, BARRIER_RIGHT_D, LANE_CENTERS, OVERPASS_DECK_Y } from '../world/roadProfile';
import type { ScoreSystem } from './score';

const _v = new Vector3();
const _a = new Vector3();
const _p = new Vector3();
const _q = new Quaternion();
const _half = new Vector3();
const _up = new Vector3(0, 1, 0);

type Phase = 'idle' | 'setup' | 'warned' | 'running' | 'aftermath';

/** Event A: cruise speed of the pack and the range it may use to keep its appointment (m/s). */
const PACK_SPEED = 23;
const PACK_MIN = 13;
const PACK_MAX = 31;
/**
 * Event A: the warning goes out this many seconds of closing distance (plus 40 m) behind the tanker;
 * the pile-up starts at 2.9 s. At 220 km/h that leaves a good three seconds to get to the left lane
 * (it was two and a half, which was enough only while the wrecks did not stay where they crashed).
 */
const WARN_LEAD = 5.2;
/** Open road the pile-up needs behind / ahead of the tanker when the warning goes out (m). */
const STAGE_BEHIND = 110;
const STAGE_AHEAD = 300;
/** How far past the planned stage the pack may still be caught up with (m). */
const STAGE_LATE = 130;
/** Event A keeps the leftmost lane open: wrecks are pushed back to the right of this line (d, m). */
const ESCAPE_EDGE = -3.3;
/** The rightmost lane, as the lane-keeping guard sees it (d, m): inner edge and outer edge. */
const RIGHT_LANE_IN = 3.3;
const RIGHT_LANE_OUT = LANE_CENTERS[3] + 2.05;
/** Wrecks closer together than this along the road form one pile (m). */
const PILE_GAP = 45;

interface PileItem {
  body: WreckBody;
  s: number;
  d: number;
  lo: number;
  hi: number;
  /** Long axis of the box in road space (along, across) and in the world (x, z); half length. */
  ax: number;
  ay: number;
  wx: number;
  wz: number;
  hl: number;
}

interface LooseWreck {
  visual: ITrafficVisual;
  body: WreckBody;
}

export class Director {
  private phase: Phase = 'idle';
  private active: CinematicId | null = null;
  private t = 0; // time inside the current phase
  private cooldown = 24; // seconds until the next event may start
  private lastWasA = false;
  private eventsDone = 0;
  private release: (() => void) | null = null;
  private fires: FireHandle[] = [];
  /** Vehicles we spawned that the traffic system does not own (the overpass truck). */
  private loose: LooseWreck[] = [];
  private timers: Array<{ at: number; fn: () => void }> = [];
  private clock = 0;
  /** Requested slow motion (the game reads and applies it). */
  slowMo = 0;
  /** Why the last event ended (diagnostics and tests). */
  lastEnd = '';

  // Event A state
  private tanker: TrafficVehicle | null = null;
  private truck: TrafficVehicle | null = null;
  private follower: TrafficVehicle | null = null;
  /** Ids of tanker, truck and follower at spawn: pooled vehicles are reused under a new id. */
  private ids = [-1, -1, -1];
  private stageTimer = 0;
  /** Every vehicle of the pack (with its id at spawn) and its speed offset inside the formation. */
  private pack: Array<{ v: TrafficVehicle; id: number }> = [];
  private packOffsets: number[] = [];
  private packSpeed = PACK_SPEED;
  /** Arc length at which the tanker is to be when the warning goes out. */
  private stageS = 0;
  /** The road is known to be open (no tunnel, no overpass) from the spawn point up to here. */
  private clearTo = 0;
  /** Last known arc length of the tanker (it may be recycled once it is far behind the player). */
  private tankerS = 0;
  private keepLeftUntil = 0;

  // Event B state
  private overpassS = 0;
  private bVisual: ITrafficVisual | null = null;
  private bBody: WreckBody | null = null;
  private bSide = 1;
  private bEta0 = 5;
  private bProgress = 0;
  private bBroke = false;
  private bImpactAt = -1;
  private bExploded = false;

  constructor(
    private ctx: GameContext,
    private score: ScoreSystem,
    private factory: ITrafficVehicleFactory | null,
  ) {}

  get current(): CinematicId | null {
    return this.active;
  }

  reset(): void {
    this.phase = 'idle';
    this.active = null;
    this.t = 0;
    this.cooldown = 24;
    this.lastWasA = false;
    this.eventsDone = 0;
    this.release?.();
    this.release = null;
    for (const f of this.fires) f.stop();
    this.fires.length = 0;
    for (const l of this.loose) this.factory?.release(l.visual);
    this.loose.length = 0;
    if (this.bVisual && !this.bBody) {
      this.bVisual.object.removeFromParent();
      this.factory?.release(this.bVisual);
    }
    this.bVisual = null;
    this.bBody = null;
    this.timers.length = 0;
    this.clock = 0;
    this.slowMo = 0;
    this.tanker = this.truck = this.follower = null;
    this.pack.length = 0;
    this.ctx.ui?.banner(null);
  }

  private after(seconds: number, fn: () => void): void {
    this.timers.push({ at: this.clock + seconds, fn });
  }

  private end(id: CinematicId, why: string): void {
    // Called off before the player was told anything: as far as they know nothing has happened,
    // so it does not count as an event and the next attempt comes soon.
    const quiet = id === 'chainReaction' && this.phase === 'setup';
    this.lastEnd = `${id}:${why}`;
    this.ctx.events.emit('cinematic', { id, phase: 'end' });
    this.phase = 'idle';
    this.active = null;
    if (quiet) {
      this.cooldown = 6 + Math.random() * 4;
      this.lastWasA = false;
    } else {
      this.eventsDone++;
      this.cooldown = 38 + Math.random() * 26 - Math.min(14, this.eventsDone * 2);
    }
    this.release?.();
    this.release = null;
    this.ctx.ui?.banner(null);
  }

  /**
   * Where the running set piece is about to block the road, in road space (centre + half extents).
   * The player reads this off the warning banner; the test autopilot gets it from here.
   */
  hazard(out: { s: number; d: number; halfS: number; halfD: number; speed: number }): boolean {
    if (this.active === 'chainReaction') {
      // "PILE-UP AHEAD — KEEP LEFT": from the warning on, everything right of the leftmost lane,
      // around the tanker (it moves with the pack until the pile-up starts). Once the wrecks have
      // settled they speak for themselves: a driver who had to stop short of them goes by what is
      // really in the way (the box held him where he stood until the event timed out).
      if (this.phase === 'setup' || this.phase === 'aftermath') return false;
      out.s = this.tankerS + 10;
      out.halfS = 70;
      out.d = (ESCAPE_EDGE + BARRIER_RIGHT_D) / 2;
      out.halfD = (BARRIER_RIGHT_D - ESCAPE_EDGE) / 2;
      out.speed = this.phase === 'warned' && this.tanker ? this.tanker.speed : 0;
      return true;
    }
    if (this.active !== 'lastSecondEscape' || this.bExploded) return false;
    out.s = this.overpassS - 12;
    out.d = this.bTargetD;
    out.halfS = 15;
    out.halfD = 3.9;
    out.speed = 0;
    return true;
  }

  /** Force an event (tests / debug). Returns false when it cannot start here. */
  trigger(id: CinematicId): boolean {
    if (this.phase !== 'idle' || !this.ctx.player.alive) return false;
    return id === 'chainReaction' ? this.startA() : this.startB(true);
  }

  // ── Event A ─────────────────────────────────────────────────────────────

  private startA(): boolean {
    const ctx = this.ctx;
    const traffic = ctx.traffic;
    if (!traffic) return false;
    const p = ctx.player;
    const anchor = p.s + clamp(p.speed * 7.5, 480, 680);
    const tanker0 = anchor + 30;
    // The pack is spawned beyond the fog and drives on until the player has closed in. It cruises
    // slower ahead of a slower player, so that catching up never takes long.
    const sp = clamp(p.speed - 30, PACK_MIN, PACK_SPEED);
    const closing0 = Math.max(8, p.speed - sp);
    const lead = Math.max(0, tanker0 - p.s - (closing0 * WARN_LEAD + 40)) / closing0;
    if (lead > 32) return false; // the player is too slow to catch up at all: try again later
    // Where the player catches up is the stage. The pack paces itself to be there on time (see
    // updateA), but a player who speeds up gets there early and one who slows down late: the road
    // has to be open wherever between the spawn point and a little past the stage that happens.
    const stage = tanker0 + sp * lead;
    if (!this.stageClear(tanker0 - STAGE_BEHIND, stage + STAGE_LATE + STAGE_AHEAD)) return false;

    // Clear the spawn stretch (it is still far beyond the fog) and stop ambient spawns there.
    for (const v of traffic.vehicles.slice()) if (v.s > anchor - 170 && v.s < anchor + 270) traffic.remove(v);
    this.release = traffic.reserve(anchor - 180, anchor + 280);
    this.tanker = traffic.spawn('tanker', anchor + 30, 2, sp, 'drive');
    this.truck = traffic.spawn('boxtruck', anchor + 46, 1, sp + 0.4, 'drive');
    this.follower = traffic.spawn('sedan', anchor - 4, 2, sp + 1, 'drive');
    const extras = [traffic.spawn('suv', anchor + 14, 1, sp + 0.5, 'drive'), traffic.spawn('hatch', anchor + 22, 3, sp, 'drive'), traffic.spawn('van', anchor + 70, 3, sp, 'drive')];
    if (!this.tanker || !this.truck) {
      // Could not place the two leads: take back whatever was spawned.
      for (const v of [this.tanker, this.truck, this.follower, ...extras]) if (v) traffic.remove(v);
      this.tanker = this.truck = this.follower = null;
      this.release();
      this.release = null;
      return false;
    }
    this.ids[0] = this.tanker.id;
    this.ids[1] = this.truck.id;
    this.ids[2] = this.follower?.id ?? -1;
    this.pack.length = 0;
    this.packOffsets.length = 0;
    const offsets = [0, 0.4, 1, 0.5, 0, 0];
    [this.tanker, this.truck, this.follower, ...extras].forEach((v, i) => {
      if (!v) return;
      this.pack.push({ v, id: v.id });
      this.packOffsets.push(offsets[i]);
    });
    this.packSpeed = sp;
    this.stageS = stage;
    this.clearTo = stage + STAGE_LATE + STAGE_AHEAD;
    this.tankerS = this.tanker.s;
    this.stageTimer = 1;
    this.active = 'chainReaction';
    this.phase = 'setup';
    this.t = 0;
    return true;
  }

  /** No tunnel and no overpass between s0 and s1: the fireball, the smoke and the wrecks need open road. */
  private stageClear(s0: number, s1: number): boolean {
    const w = this.ctx.world;
    for (let s = s0; s <= s1; s += 40) if (w.tunnelAt(s) > 0) return false;
    if (w.tunnelAt(s1) > 0) return false;
    const op = w.nextOverpass(s0);
    return op === null || op > s1;
  }

  /** Still the vehicle the director spawned (not released to the pool and reused). */
  private live(v: TrafficVehicle | null, id: number): v is TrafficVehicle {
    return v !== null && v.id === id && !!this.ctx.traffic?.vehicles.includes(v);
  }

  /** The whole pack cruises at `speed` (plus the small offsets that keep its formation). */
  private pacePack(speed: number, dt: number): void {
    const traffic = this.ctx.traffic;
    if (!traffic) return;
    for (let i = 0; i < this.pack.length; i++) {
      const m = this.pack[i];
      if (!this.live(m.v, m.id) || m.v.mode !== 'drive') continue;
      const want = speed + this.packOffsets[i];
      traffic.setCruise?.(m.v, want);
      // Trucks pick up speed slowly on their own: help them along a little.
      if (m.v.speed < want - 0.3) m.v.speed = Math.min(want, m.v.speed + 1.2 * dt);
    }
  }

  private updateA(dt: number): void {
    const ctx = this.ctx;
    const p = ctx.player;
    const staging = this.phase === 'setup' || this.phase === 'warned';
    const tankerLive = this.live(this.tanker, this.ids[0]);
    if (staging && (!tankerLive || !this.live(this.truck, this.ids[1]))) {
      this.end('chainReaction', 'pack-gone'); // despawned (the player stalled far behind): call it off quietly
      return;
    }
    if (!this.live(this.follower, this.ids[2])) this.follower = null;
    if (tankerLive) this.tankerS = this.sOf(this.tanker!);
    const dist = this.tankerS - p.s;

    if (staging) {
      const tanker = this.tanker!;
      const truck = this.truck!;
      const closing = Math.max(8, p.speed - tanker.speed);
      const warnGap = closing * WARN_LEAD + 40;

      // The spawn-free stretch moves with the pack.
      if ((this.stageTimer -= dt) <= 0 && ctx.traffic) {
        this.stageTimer = 1;
        this.release?.();
        this.release = ctx.traffic.reserve(tanker.s - 210, tanker.s + 250);
        // A player who fell behind is late for the stage: the pack carries on at its slowest for
        // as long as the open road lasts (looked at a stretch at a time).
        if (this.clearTo - tanker.s < 700 && this.stageClear(this.clearTo - 20, this.clearTo + 160)) this.clearTo += 160;
      }

      if (this.phase === 'setup') {
        // Rendezvous: the pack paces itself so that the tanker reaches the stage just as the player
        // closes to the warning distance. A player who speeds up or slows down on the way moves the
        // meeting time, not the meeting place.
        const playerToGo = this.stageS - warnGap - p.s;
        if (playerToGo > 5) {
          const eta = playerToGo / Math.max(p.speed, 10);
          const want = clamp((this.stageS - tanker.s) / eta, PACK_MIN, PACK_MAX);
          this.packSpeed += clamp(want - this.packSpeed, -3.5 * dt, 2.2 * dt);
        }
        this.pacePack(this.packSpeed, dt);
        // Hold the two leads together until the player arrives.
        if (tanker.mode === 'drive' && truck.mode === 'drive') truck.speed += (tanker.s + 15 - truck.s) * 0.5 * dt;

        if (dist < warnGap) {
          if (!this.stageClear(tanker.s - STAGE_BEHIND, tanker.s + STAGE_AHEAD)) {
            this.end('chainReaction', 'stage-unsafe'); // cannot happen inside the stretch checked at the start
            return;
          }
          this.phase = 'warned';
          this.t = 0;
          ctx.ui?.banner('PILE-UP AHEAD — KEEP LEFT', 'warning');
          ctx.audio?.play('warning');
          ctx.events.emit('cinematic', { id: 'chainReaction', phase: 'warn' });
        } else if (dist < -30) this.end('chainReaction', 'passed-in-setup');
        else if (this.t > 45) this.end('chainReaction', 'setup-timeout');
        else if (tanker.s + STAGE_AHEAD > this.clearTo) this.end('chainReaction', 'stage-missed'); // the player fell behind and the open road ran out
        return;
      }

      // warned
      this.pacePack(this.packSpeed, dt);
      if (dist < Math.max(105, closing * 2.9) || this.t > 6) {
        this.phase = 'running';
        this.t = 0;
        this.beginPileUp();
      }
      return;
    }

    // running / aftermath
    // Guarantee the escape lane: shove wrecks that drift into the leftmost lane back out.
    if (this.clock < this.keepLeftUntil && ctx.crash) {
      for (const b of ctx.crash.bodies) {
        if (b.owner === 'player') continue;
        const pr = ctx.road.project(b.position.x, b.position.z, this.tankerS);
        const edge = ESCAPE_EDGE;
        const reach = Math.max(b.halfExtents.x, b.halfExtents.z);
        if (pr.d - reach < edge && Math.abs(pr.s - this.tankerS) < 140) {
          const f = ctx.road.frameAt(pr.s);
          const push = clamp((edge - (pr.d - reach)) * 3.5, 0, 9) * dt * b.mass;
          _v.set(f.rx * push, 0, f.rz * push);
          ctx.crash.applyImpulse(b, _v);
        }
      }
    }
    // Past the tanker (or what is left of it: once it is far behind, traffic recycles the wreck).
    const passed = p.s > this.tankerS + 30;
    if (this.phase === 'running' && this.t > 2.6) this.phase = 'aftermath';
    if (passed && p.alive) {
      this.score.bonus('CHAIN REACTION SURVIVED', 3000);
      ctx.audio?.play('bonus');
      this.end('chainReaction', 'survived');
    } else if (this.t > 30) this.end('chainReaction', 'aftermath-timeout');
  }

  private beginPileUp(): void {
    const ctx = this.ctx;
    const traffic = ctx.traffic!;
    const tanker = this.tanker!;
    const truck = this.truck!;
    ctx.events.emit('cinematic', { id: 'chainReaction', phase: 'start', position: tanker.position.clone() });
    ctx.ui?.banner(null);
    this.keepLeftUntil = this.clock + 9;

    // The truck blows a front tyre and slews right, across the tanker's bow.
    const f = ctx.road.frameAt(truck.s);
    _p.copy(truck.position).addScaledVector(_v.set(f.rx, 0, f.rz), 1.1);
    _p.y = 0.5;
    ctx.vfx?.sparks(_p, _v.set(-f.tx, 0.4, -f.tz), 60, 16);
    ctx.vfx?.smokePuff(_p, _v.set(f.tx * 12, 1.5, f.tz * 12), 1.6);
    ctx.audio?.play('crashHeavy', { position: truck.position, volume: 0.9 });
    // Hand-over speeds follow what the pack is really doing (it paces itself between 13 and 31 m/s).
    const vt = Math.max(8, truck.speed) * 0.74;
    _v.set(f.tx * vt + f.rx * 6.5, 0.4, f.tz * vt + f.rz * 6.5);
    _a.set(0, -1.5, 0.5);
    traffic.wreck(truck, _v, _a);

    const tid = this.ids[0];
    const kid = this.ids[1];
    const fid = this.ids[2];
    this.after(0.35, () => {
      if (!this.live(tanker, tid) || tanker.mode === 'wreck') return;
      const g = ctx.road.frameAt(tanker.s);
      const vk = Math.max(8, tanker.speed) * 0.87;
      _v.set(g.tx * vk + g.rx * 1.5, 0.3, g.tz * vk + g.rz * 1.5);
      _a.set(0, 0.9, 0.25);
      traffic.wreck(tanker, _v, _a);
      _p.copy(tanker.position).addScaledVector(_a.set(g.tx, 0, g.tz), tanker.halfLength);
      _p.y = 1.2;
      ctx.vfx?.sparks(_p, _a.set(-g.tx, 0.5, -g.tz), 90, 20);
      ctx.vfx?.debris(_p, _a.set(g.tx * 10, 5, g.tz * 10), 16);
      ctx.audio?.play('crashHeavy', { position: tanker.position });
      ctx.events.emit('collision', { kind: 'traffic', position: _p.clone(), normal: new Vector3(-g.tx, 0, -g.tz), relSpeed: 12, intensity: 0.5, fatal: false });
    });
    this.after(0.8, () => {
      const fo = this.follower;
      if (this.live(fo, fid) && this.live(tanker, tid) && fo.mode === 'drive' && fo.s < tanker.s && tanker.s - fo.s < 45) {
        const g = ctx.road.frameAt(fo.s);
        const vf = Math.max(8, fo.speed) * 0.67;
        _v.set(g.tx * vf + g.rx * 3, 0.8, g.tz * vf + g.rz * 3);
        _a.set(0.4, 2.2, 0.6);
        traffic.wreck(fo, _v, _a);
        ctx.audio?.play('crashLight', { position: fo.position });
      }
    });
    // The tanker goes up.
    this.after(1.25, () => this.live(tanker, tid) && this.explodeVehicle(tanker, 2.5, 46, 11, 30));
    this.after(2.3, () => this.live(truck, kid) && this.explodeVehicle(truck, 1.15, 28, 6, 16));
  }

  /** Arc length of a vehicle, following its wreck body once it has been handed to the crash world. */
  private sOf(v: TrafficVehicle): number {
    if (v.mode !== 'wreck') return v.s;
    const b = this.bodyOf(v);
    return b ? this.ctx.road.project(b.position.x, b.position.z, v.s).s : v.s;
  }

  private bodyOf(v: TrafficVehicle): WreckBody | null {
    const bodies = this.ctx.crash?.bodies;
    if (!bodies) return null;
    for (const b of bodies) if (b.owner === v) return b;
    return null;
  }

  private explodeVehicle(v: TrafficVehicle, scale: number, fireSeconds: number, blast: number, radius: number): void {
    const ctx = this.ctx;
    const body = this.bodyOf(v);
    _p.copy(body ? body.position : v.position);
    _p.y = Math.max(0.8, _p.y);
    this.explodeAt(_p, scale, blast, radius, body ? body.linvel : null);
    v.visual.setCharred(1);
    if (ctx.vfx) {
      const target = body ?? v;
      if (body) body.burning = true;
      this.fires.push(ctx.vfx.attachFire(target, scale * 0.9, fireSeconds));
    }
    ctx.events.emit('cinematic', { id: this.active ?? 'chainReaction', phase: 'climax', position: _p.clone() });
  }

  private explodeAt(pos: Vector3, scale: number, blast: number, radius: number, vel: Vector3 | null): void {
    const ctx = this.ctx;
    if (ctx.vfx) ctx.vfx.explosion(pos, { scale, velocity: vel ? _a.copy(vel).multiplyScalar(0.35) : undefined, smoke: 14, debris: true });
    else ctx.events.emit('explosion', { position: pos.clone(), scale });
    ctx.crash?.applyBlast(pos, blast, radius);
  }

  // ── Event B ─────────────────────────────────────────────────────────────

  private startB(force = false): boolean {
    const ctx = this.ctx;
    if (!this.factory || !ctx.crash?.ready) return false;
    const p = ctx.player;
    const op = ctx.world.nextOverpass(p.s + 120);
    if (op === null) return false;
    const dist = op - p.s;
    const lead = Math.max(250, p.speed * 5.4);
    if (!force && (dist > lead || dist < lead * 0.72)) return false;
    // Forced (tests, debug): from further away than the director's own start, which leaves the
    // player four to five seconds; the drop still waits for them (see updateB).
    if (force && (dist > 900 || dist < lead * 0.72)) return false;
    this.overpassS = op;
    this.bSide = p.d > 0 ? 1 : -1;
    this.bVisual = this.factory.acquire('tanker', 7 + this.eventsDone);
    this.bVisual.setLights(0, 0, 0, true);
    ctx.engine.scene.add(this.bVisual.object);
    this.bBody = null;
    this.bBroke = false;
    this.bExploded = false;
    this.bImpactAt = -1;
    this.bProgress = 0;
    this.bEta0 = dist / Math.max(20, p.speed);
    this.release = ctx.traffic ? ctx.traffic.reserve(op - 70, op + 80) : null;
    this.active = 'lastSecondEscape';
    this.phase = 'warned';
    this.t = 0;
    ctx.ui?.banner(this.bSide > 0 ? 'INCOMING — KEEP LEFT' : 'INCOMING — KEEP RIGHT', 'warning');
    ctx.audio?.play('warning');
    ctx.audio?.play('horn', { position: ctx.road.toWorld(op, 0, OVERPASS_DECK_Y, _p), volume: 0.8 });
    ctx.events.emit('cinematic', { id: 'lastSecondEscape', phase: 'warn' });
    this.placeOverpassTruck(0);
    return true;
  }

  /** Lateral target of the drop: the middle of the two lanes on the player's side. */
  private get bTargetD(): number {
    return this.bSide > 0 ? (LANE_CENTERS[2] + LANE_CENTERS[3]) / 2 : (LANE_CENTERS[0] + LANE_CENTERS[1]) / 2;
  }

  private placeOverpassTruck(progress: number): void {
    const ctx = this.ctx;
    const vis = this.bVisual!;
    const f = ctx.road.frameAt(this.overpassS);
    // It crosses from the far side towards the drop point, drifting to the edge facing the player.
    const d0 = this.bTargetD - this.bSide * 42;
    const d1 = this.bTargetD - this.bSide * 5;
    const d = d0 + (d1 - d0) * progress;
    const veer = Math.pow(clamp((progress - 0.6) / 0.4, 0, 1), 2);
    const sOff = -1.5 - veer * 3.2;
    ctx.road.toWorld(this.overpassS + sOff, d, OVERPASS_DECK_Y, vis.object.position);
    // Heading: along +d (road right) for side +1, plus a growing slew towards the player (−s).
    const base = f.h + (this.bSide > 0 ? Math.PI / 2 : -Math.PI / 2);
    const slew = this.bSide * veer * 0.5 + Math.sin(this.t * 9) * 0.04 * veer;
    vis.object.rotation.set(0, -(base + slew), 0);
    vis.setLights(progress > 0.55 ? 1 : 0, 0, this.clock, true);
  }

  private updateB(dt: number): void {
    const ctx = this.ctx;
    const p = ctx.player;
    const dropS = this.overpassS - 11;
    const eta = (dropS - p.s) / Math.max(18, p.speed);

    if (!this.bBroke) {
      // Progress follows the player's ETA so the drop always lands just ahead of them.
      const target = 1 - clamp((eta - 2.0) / Math.max(0.5, this.bEta0 - 2.0), 0, 1);
      // It always drives all the way to the drop point, at a crawl if the player dawdles (breaking
      // through after a fixed time dropped it wherever it was, beyond the barrier), and the crawl
      // is slow enough not to beat a player who started far away to the bridge.
      this.bProgress = Math.min(1, Math.max(this.bProgress + dt * Math.min(0.07, 0.75 / this.bEta0), target));
      this.placeOverpassTruck(this.bProgress);
      if (this.bProgress > 0.7 && Math.random() < dt * 30) {
        _p.copy(this.bVisual!.object.position);
        _p.y += 0.3;
        ctx.vfx?.sparks(_p, _v.set(0, 1, 0), 6, 6);
      }
      if (this.bProgress >= 1) this.breakThrough();
      return;
    }

    const body = this.bBody;
    if (body && !this.bExploded) {
      const low = body.position.y - Math.min(body.halfExtents.x, body.halfExtents.y) < 0.9;
      if (low || this.clock - this.bImpactAt > 2.2) {
        this.bExploded = true;
        _p.copy(body.position);
        _p.y = Math.max(1.0, _p.y);
        this.explodeAt(_p, 2.4, 11, 30, body.linvel);
        ctx.weather?.splash(_p, 2.5);
        body.burning = true;
        this.bVisual!.setCharred(1);
        if (ctx.vfx) this.fires.push(ctx.vfx.attachFire(body, 2.1, 50));
        ctx.events.emit('cinematic', { id: 'lastSecondEscape', phase: 'climax', position: _p.clone() });
        ctx.ui?.banner(null);
        this.bImpactAt = this.clock;
      }
    }
    if (p.alive && p.s > this.overpassS + 14) {
      const tight = this.bExploded ? this.clock - this.bImpactAt < 2.6 : true;
      this.score.bonus(tight ? 'LAST-SECOND ESCAPE' : 'ESCAPED THE WRECK', tight ? 4000 : 1500);
      ctx.audio?.play('bonus');
      if (tight) this.slowMo = 0.9;
      this.end('lastSecondEscape', tight ? 'escaped-tight' : 'escaped');
    } else if (this.t > Math.max(28, this.bEta0 * 1.4 + 8)) this.end('lastSecondEscape', 'timeout');
  }

  private breakThrough(): void {
    const ctx = this.ctx;
    const vis = this.bVisual!;
    this.bBroke = true;
    breakOverpassRailing(this.overpassS, this.bSide);
    this.bImpactAt = this.clock;
    const f = ctx.road.frameAt(this.overpassS);
    const def = vis.def;
    _half.set(def.width / 2, def.height / 2, def.length / 2);
    _p.copy(vis.object.position);
    _p.y += def.height / 2;
    _q.copy(vis.object.quaternion);
    // Over the edge: it carries just enough sideways speed to come down on the two lanes of the
    // player's side (the fall takes about 1.1 s), swings round to lie roughly along the road and
    // rolls onto its flank. The other two lanes stay open: that is the escape the banner announces.
    _v.set(f.rx * this.bSide * 4.5 - f.tx * 5, 1.0, f.rz * this.bSide * 4.5 - f.tz * 5);
    _a.set(-f.rx * 1.0 * this.bSide, -1.15 * this.bSide, -f.rz * 1.0 * this.bSide);
    this.bBody = ctx.crash!.addBox(vis.object, _half, def.mass, _p, _q, _v, _a, 'director', def.height / 2);
    this.loose.push({ visual: vis, body: this.bBody });
    // Parapet debris and sparks.
    _p.copy(vis.object.position);
    _p.y = OVERPASS_DECK_Y + 0.8;
    ctx.vfx?.sparks(_p, _v.set(-f.tx, 0.3, -f.tz), 140, 18);
    ctx.vfx?.debris(_p, _v.set(-f.tx * 9, 3, -f.tz * 9), 22);
    ctx.vfx?.smokePuff(_p, _v.set(-f.tx * 4, 2, -f.tz * 4), 2.2);
    ctx.audio?.play('crashHeavy', { position: _p });
    ctx.audio?.play('glass', { position: _p, delay: 0.1 });
    ctx.events.emit('cinematic', { id: 'lastSecondEscape', phase: 'start', position: _p.clone() });
    ctx.events.emit('collision', { kind: 'debris', position: _p.clone(), normal: new Vector3(0, 1, 0), relSpeed: 10, intensity: 0.45, fatal: false });
  }

  // ── a way through ───────────────────────────────────────────────────────

  private readonly pile: PileItem[] = [];
  private readonly pileProj = { s: 0, d: 0 };

  /**
   * No pile of wrecks may close the whole carriageway: whoever stops in front of it (or arrives
   * two seconds after the tanker came down) needs one lane to get through, and nothing clears a
   * wreck that is still in view. Per pile, the outer lane on one side is kept open — the side the
   * banner announced while a set piece runs, otherwise the one that is nearer to being open — by
   * pushing the wrecks that reach into it back out. (Until wrecks stayed where they crashed this
   * could not happen: traffic that ran into one used to be flung out of sight, see TrafficSystem.wreck.)
   */
  private keepLaneOpen(dt: number): void {
    const crash = this.ctx.crash;
    if (!crash || crash.bodies.length === 0) return;
    const road = this.ctx.road;
    const p = this.ctx.player;
    const pile = this.pile;
    let n = 0;
    for (const b of crash.bodies) {
      if (b.owner === 'player' || b.mass < 600) continue;
      if (b.position.y - Math.max(b.halfExtents.x, b.halfExtents.y) > 2.5) continue; // still in the air
      const pr = road.project(b.position.x, b.position.z, p.s, this.pileProj);
      if (pr.s < p.s - 80 || pr.s > p.s + 450) continue;
      // Lateral extent of the box turned by its yaw (a rolled box is no wider than this).
      const f = road.frameAt(pr.s);
      const q = b.quaternion;
      const fx = -2 * (q.x * q.z + q.w * q.y);
      const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
      const fl = Math.hypot(fx, fz) || 1;
      const ax = (fx * f.tx + fz * f.tz) / fl;
      const ay = (fx * f.rx + fz * f.rz) / fl;
      const lat = Math.max(b.halfExtents.x, b.halfExtents.y) * Math.abs(ax) + b.halfExtents.z * Math.abs(ay) + 0.3;
      if (pr.d + lat < BARRIER_LEFT_D || pr.d - lat > BARRIER_RIGHT_D) continue; // off the carriageway
      let it = pile[n];
      if (!it) pile.push((it = { body: b, s: 0, d: 0, lo: 0, hi: 0, ax: 1, ay: 0, wx: 0, wz: 0, hl: 0 }));
      it.body = b;
      it.s = pr.s;
      it.d = pr.d;
      it.lo = pr.d - lat;
      it.hi = pr.d + lat;
      it.ax = ax;
      it.ay = ay;
      it.wx = fx / fl;
      it.wz = fz / fl;
      it.hl = b.halfExtents.z;
      n++;
    }
    // Sort by arc length (insertion sort: a handful of bodies, nearly sorted from step to step).
    for (let i = 1; i < n; i++) {
      const it = pile[i];
      let j = i - 1;
      while (j >= 0 && pile[j].s > it.s) {
        pile[j + 1] = pile[j];
        j--;
      }
      pile[j + 1] = it;
    }
    // The side a running set piece promised.
    let promised = 0;
    let promisedS = 0;
    if (this.active === 'chainReaction' && (this.phase === 'running' || this.phase === 'aftermath')) {
      promised = -1;
      promisedS = this.tankerS;
    } else if (this.active === 'lastSecondEscape' && this.bBroke) {
      promised = -this.bSide;
      promisedS = this.overpassS;
    }
    for (let i = 0; i < n; ) {
      let j = i + 1;
      while (j < n && pile[j].s - pile[j - 1].s < PILE_GAP) j++;
      // How far the pile reaches into the leftmost / the rightmost lane.
      let inL = 0;
      let inR = 0;
      for (let k = i; k < j; k++) {
        const it = pile[k];
        inL = Math.max(inL, ESCAPE_EDGE - it.lo);
        inR = Math.max(inR, Math.min(it.hi, RIGHT_LANE_OUT) - Math.max(it.lo, RIGHT_LANE_IN));
      }
      const near = promised !== 0 && pile[i].s - 150 < promisedS && pile[j - 1].s + 150 > promisedS;
      const side = near ? promised : inL <= 0.05 || inR <= 0.05 ? 0 : inL <= inR ? -1 : 1;
      if (side !== 0) {
        for (let k = i; k < j; k++) {
          const it = pile[k];
          // Depth inside the lane to be kept open and the way out of it (+1 = towards the right).
          let depth: number;
          let dir: number;
          if (side < 0) {
            depth = ESCAPE_EDGE - it.lo;
            dir = 1;
          } else {
            depth = Math.min(it.hi, RIGHT_LANE_OUT) - Math.max(it.lo, RIGHT_LANE_IN);
            // Out towards the middle, or onto the hard shoulder when it lies mostly out there.
            dir = it.d > LANE_CENTERS[3] + 1.2 ? 1 : -1;
          }
          if (depth <= 0.05) continue;
          // Enough to get a wreck that has come to rest moving again (tyres and bent metal hold it
          // with about 9 m/s²), not enough to throw it. A wreck lying along the road is pushed
          // sideways as a whole. One lying across it is swung like a gate, by the end that is in
          // the lane: its other end may well be against the far barrier, and then no sideways
          // push moves it (a tanker is 16 m long, the carriageway 19 m wide).
          const f = road.frameAt(it.s);
          const across = Math.abs(it.ay);
          const end = it.ay * dir < 0 ? 1 : -1; // the end of the long axis that points into the lane
          const lean = end * it.ax >= 0 ? 1 : -1; // further the way that end already leans along the road
          const push = clamp(9.5 + depth * 3, 0, 15) * dt * it.body.mass;
          const pd = push * dir * (1 - 0.5 * across);
          const ps = push * lean * across;
          _v.set(f.rx * pd + f.tx * ps, 0, f.rz * pd + f.tz * ps);
          _p.copy(it.body.position);
          _p.x += it.wx * it.hl * end * across;
          _p.z += it.wz * it.hl * end * across;
          crash.applyImpulse(it.body, _v, _p);
        }
      }
      i = j;
    }
  }

  // ── common ──────────────────────────────────────────────────────────────

  /** Fixed-step update (scaled time) while a run is in progress. */
  update(dt: number, survivalTime: number): void {
    this.clock += dt;
    this.t += dt;
    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (this.timers[i].at <= this.clock) {
        const fn = this.timers[i].fn;
        this.timers.splice(i, 1);
        fn();
      }
    }
    if (this.slowMo > 0) this.slowMo = Math.max(0, this.slowMo - dt / 0.35);
    this.keepLaneOpen(dt);

    if (this.phase === 'idle') {
      this.cooldown -= dt;
      if (this.cooldown > 0 || !this.ctx.player.alive) return;
      // Alternate, but B needs an overpass at the right distance: A fills in when none is near.
      const wantB = this.lastWasA && survivalTime > 40;
      if (wantB && this.startB()) {
        this.lastWasA = false;
        return;
      }
      if (!wantB || this.cooldown < -22) {
        if (this.startA()) this.lastWasA = true;
        else this.cooldown = Math.max(this.cooldown, 1.5); // conditions not right: try again shortly
      }
      return;
    }
    if (this.active === 'chainReaction') this.updateA(dt);
    else if (this.active === 'lastSecondEscape') this.updateB(dt);
  }

  /** Drop wrecks we own once they are far behind. */
  cleanup(playerS: number): void {
    for (let i = this.loose.length - 1; i >= 0; i--) {
      const l = this.loose[i];
      const pr = this.ctx.road.project(l.body.position.x, l.body.position.z, playerS);
      if (pr.s < playerS - 170) {
        this.ctx.crash?.remove(l.body);
        l.visual.object.removeFromParent();
        this.factory?.release(l.visual);
        this.loose.splice(i, 1);
      }
    }
  }
}
