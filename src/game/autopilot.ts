import type { DriveControls, GameContext } from '../core/types';
import { clamp } from '../core/math';
import { BARRIER_LEFT_D, BARRIER_RIGHT_D, LANE_CENTERS, LANE_COUNT, LANE_WIDTH, laneOf } from '../world/roadProfile';

interface Clearance {
  /** Free distance ahead (m, bumper to bumper; negative = alongside). */
  dist: number;
  /** Speed of whatever blocks (m/s). */
  speed: number;
  /** The corridor runs into the zone a warning banner has told the driver to keep out of. */
  warned: boolean;
}

/**
 * Test / attract-mode driver: picks the lane with the most free road, steers to it, brakes when
 * boxed in. Used by the automated browser tests (soak runs, screenshots) — not a cheat for players.
 */
export class Autopilot {
  readonly controls: DriveControls = { throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: false };
  targetLane = 2;
  /** Cruise target, m/s. */
  cruise = 62;
  /** 0 = careful … 1 = threads gaps late (more near misses, more crashes). */
  risk = 0.5;
  /** Allow nitro on clear road. */
  useNitro = true;
  /** Road-space box the running set piece will block (set by the game every step). */
  hazard: { s: number; d: number; halfS: number; halfD: number; speed: number } | null = null;
  private hold = 0;
  private stuck = 0;
  private reverse = 0;
  private reverseSteer = 0;
  /** Seconds spent backing away from the wall we are standing behind (bounded). */
  private backedUp = 0;
  /** Seconds standing still although a lane is open somewhere. */
  private waiting = 0;
  /** Backing away from a wall to get room for the swing into the open lane. */
  private escape = false;
  private escapeWait = 0;
  /** Shuffling a car that stands across the road round: +1 forward, -1 back, 0 not turning. */
  private turnDir = 0;
  private turn = 0;
  private steerSmooth = 0;
  private readonly lanes: Clearance[] = [];
  private readonly here: Clearance = { dist: 400, speed: 100, warned: false };

  constructor(private ctx: GameContext) {
    for (let i = 0; i < LANE_COUNT; i++) this.lanes.push({ dist: 400, speed: 100, warned: false });
  }

  reset(): void {
    this.targetLane = clamp(laneOf(this.ctx.player.d), 0, LANE_COUNT - 1);
    this.hold = 0;
    this.steerSmooth = 0;
    this.stuck = 0;
    this.reverse = 0;
    this.backedUp = 0;
    this.waiting = 0;
    this.escape = false;
    this.escapeWait = 0;
    this.turnDir = 0;
    this.turn = 0;
  }

  /** Nearest obstacle ahead inside a lateral corridor centred on `d` with half-width `half`. */
  private scan(d: number, half: number, out: Clearance): Clearance {
    const p = this.ctx.player;
    const front = p.s + p.dims.length * 0.5;
    const back = p.s - p.dims.length * 0.5;
    out.dist = 400;
    out.speed = 100;
    out.warned = false;
    // The obstacle that counts is the one that leaves the least road after braking down to its
    // speed, not simply the nearest: a slower car 100 m ahead used to hide the standing wreck (or
    // the announced zone) a little beyond it until that car pulled out of the way.
    let least = Infinity;
    const take = (gap: number, sp: number) => {
      if (gap > 400) return;
      const cl = Math.max(0, p.speed - sp);
      const slack = gap - (cl * cl) / 18;
      if (slack < least) {
        least = slack;
        out.dist = gap;
        out.speed = sp;
      }
    };
    const consider = (s: number, od: number, halfL: number, halfW: number, sp: number) => {
      if (Math.abs(od - d) > halfW + half) return;
      if (s + halfL < back - 1.5) return; // fully behind us
      take(s - halfL - front, sp);
    };
    const traffic = this.ctx.traffic?.vehicles;
    if (traffic) {
      for (const v of traffic) {
        if (v.mode === 'wreck') continue;
        // Brake lights ahead: expect it to keep slowing.
        const sp = v.speed * (1 - 0.7 * clamp(v.braking, 0, 1));
        consider(v.s, v.d, v.halfLength, v.halfWidth, sp);
        // A vehicle that is changing lanes also claims the lane it is heading for.
        if (v.targetLane !== v.lane) consider(v.s, LANE_CENTERS[clamp(v.targetLane, 0, LANE_COUNT - 1)], v.halfLength, v.halfWidth, sp);
      }
    }
    // A set piece announced by the warning banner (see Director.hazard): treat it as a wall.
    const hz = this.hazard;
    if (hz) {
      consider(hz.s, hz.d, hz.halfS, hz.halfD, hz.speed);
      out.warned = Math.abs(hz.d - d) <= hz.halfD + half && hz.s + hz.halfS >= back - 1.5;
    }
    const bodies = this.ctx.crash?.bodies;
    if (bodies) {
      for (const b of bodies) {
        if (b.owner === 'player' || b.mass < 600) continue;
        const pr = this.ctx.road.project(b.position.x, b.position.z, p.s);
        if (pr.s < back - 30 || pr.s > front + 420) continue;
        // Footprint of the tumbling box in road space: a rectangle turned by its yaw (a rolled box
        // is no wider than this). Only the part of it inside the corridor counts: a tanker lying
        // diagonally over three lanes leaves the fourth open, which its bounding box would not.
        const q = b.quaternion;
        const fx = -2 * (q.x * q.z + q.w * q.y);
        const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
        const fl = Math.hypot(fx, fz) || 1;
        const f = this.ctx.road.frameAt(pr.s);
        const ax = (fx * f.tx + fz * f.tz) / fl; // long axis of the box in (s, d)
        const ay = (fx * f.rx + fz * f.rz) / fl;
        const hl = b.halfExtents.z + 1;
        const hw = Math.max(b.halfExtents.x, b.halfExtents.y) + 0.5;
        if (!this.clip(pr.s, pr.d, ax, ay, hl, hw, d - half, d + half)) continue;
        if (this.clipMax < back - 1.5) continue; // fully behind us
        take(this.clipMin - front, Math.min(Math.hypot(b.linvel.x, b.linvel.z), 12));
      }
    }
    return out;
  }

  private readonly polyA = new Float64Array(16);
  private readonly polyB = new Float64Array(16);
  private clipMin = 0;
  private clipMax = 0;

  /**
   * The part of a turned rectangle (centre s/d, long axis ax/ay, half length / width) that lies
   * inside the lateral strip lo … hi: its extent along the road goes to clipMin / clipMax.
   * Returns false when the rectangle does not reach into the strip.
   */
  private clip(s: number, d: number, ax: number, ay: number, hl: number, hw: number, lo: number, hi: number): boolean {
    const a = this.polyA;
    const b = this.polyB;
    // corners, in order round the rectangle (s, d pairs)
    a[0] = s + ax * hl - ay * hw;
    a[1] = d + ay * hl + ax * hw;
    a[2] = s + ax * hl + ay * hw;
    a[3] = d + ay * hl - ax * hw;
    a[4] = s - ax * hl + ay * hw;
    a[5] = d - ay * hl - ax * hw;
    a[6] = s - ax * hl - ay * hw;
    a[7] = d - ay * hl + ax * hw;
    let n = clipHalf(a, 4, b, lo, 1);
    n = clipHalf(b, n, a, hi, -1);
    if (n === 0) return false;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = a[i * 2];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    this.clipMin = min;
    this.clipMax = max;
    return true;
  }

  /** Is something standing next to our tail on that side (dir: +1 right, −1 left)? */
  private besideTail(dir: number): boolean {
    const p = this.ctx.player;
    const back = p.s - p.dims.length * 0.5;
    const half = p.dims.width * 0.5;
    const s0 = back - 7;
    const s1 = back + 1.5;
    const traffic = this.ctx.traffic?.vehicles;
    if (traffic) {
      for (const v of traffic) {
        if (v.mode === 'wreck' || v.s + v.halfLength < s0 || v.s - v.halfLength > s1) continue;
        const gap = (v.d - p.d) * dir - v.halfWidth - half;
        if (gap > -1.2 && gap < 1.8) return true;
      }
    }
    const lo = dir > 0 ? p.d + half - 0.3 : p.d - half - 1.8;
    const hi = dir > 0 ? p.d + half + 1.8 : p.d - half + 0.3;
    const bodies = this.ctx.crash?.bodies;
    if (bodies) {
      for (const b of bodies) {
        if (b.owner === 'player' || b.mass < 600) continue;
        const pr = this.ctx.road.project(b.position.x, b.position.z, p.s);
        if (Math.abs(pr.s - p.s) > 30) continue;
        const q = b.quaternion;
        const fx = -2 * (q.x * q.z + q.w * q.y);
        const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
        const fl = Math.hypot(fx, fz) || 1;
        const f = this.ctx.road.frameAt(pr.s);
        if (!this.clip(pr.s, pr.d, (fx * f.tx + fz * f.tz) / fl, (fx * f.rx + fz * f.rz) / fl, b.halfExtents.z, Math.max(b.halfExtents.x, b.halfExtents.y), lo, hi)) continue;
        if (this.clipMax > s0 && this.clipMin < s1) return true;
      }
    }
    return false;
  }

  /** Is somebody coming up from behind in the corridor centred on `d` (we may be braking)? */
  private rearBlocked(d: number, half: number): boolean {
    const p = this.ctx.player;
    const back = p.s - p.dims.length * 0.5;
    const traffic = this.ctx.traffic?.vehicles;
    if (!traffic) return false;
    for (const v of traffic) {
      if (v.mode === 'wreck') continue;
      const vd = v.targetLane !== v.lane ? LANE_CENTERS[clamp(v.targetLane, 0, LANE_COUNT - 1)] : v.d;
      if (Math.abs(v.d - d) > v.halfWidth + half && Math.abs(vd - d) > v.halfWidth + half) continue;
      const gap = back - (v.s + v.halfLength);
      if (gap < 0) continue; // alongside or ahead: the forward scan deals with it
      const closing = v.speed - p.speed;
      // Pulling out from a standstill into a lane that crawls past a wreck: a shorter gap will do
      // (the car behind is slow and sees us), or the driver waits in the jam for minutes.
      const crawl = p.speed < 3 && v.speed < 12;
      if (gap < (crawl ? 4 + Math.max(0, closing) * 1.3 : 3 + Math.max(0, closing) * 2.5)) return true;
    }
    return false;
  }

  update(dt: number): DriveControls {
    const p = this.ctx.player;
    const c = this.controls;
    const half = p.dims.width * 0.5;
    this.hold -= dt;
    this.targetLane = clamp(this.targetLane, 0, LANE_COUNT - 1);

    // Time until we would reach the blocker in each lane.
    const ttc = (cl: Clearance) => (cl.dist <= 0 ? 0 : cl.dist / Math.max(1.5, p.speed - cl.speed));
    let best = this.targetLane;
    let bestT = -Infinity;
    for (let l = 0; l < LANE_COUNT; l++) {
      const cl = this.scan(LANE_CENTERS[l], half + 0.45, this.lanes[l]);
      let t = Math.min(14, ttc(cl));
      // "KEEP LEFT": a lane that runs into the announced zone is no way out, however far ahead the
      // zone still is, as long as any lane stays clear of it. A slower car in the open lane is
      // something to follow, not a reason to pull out into the zone (the driver did exactly that
      // and met the jack-knifing truck there).
      if (cl.warned) t -= 20;
      t -= Math.abs(l - this.targetLane) * 0.45; // prefer staying
      t -= Math.abs(l - 1.5) * 0.08;
      if (t > bestT) {
        bestT = t;
        best = l;
      }
    }
    const tHere = ttc(this.lanes[this.targetLane]);
    const wantMove = 6.2 - 3.6 * this.risk; // start looking for a way out this many seconds before contact
    // Told to keep out of the lane we are in: move now, not when the zone is a few seconds away.
    const obey = this.lanes[this.targetLane].warned && !this.lanes[best].warned;
    if (this.hold <= 0 && best !== this.targetLane && (tHere < wantMove || bestT > tHere + 5 || obey)) {
      const next = this.targetLane + (best > this.targetLane ? 1 : -1);
      const side = this.lanes[next];
      // The neighbouring lane must be free alongside and for the next moment.
      const closing = Math.max(0, p.speed - side.speed);
      // ...and long enough to shed the closing speed once we are in it.
      let room = Math.max(5 + closing * 1.1, ((closing * closing) / 18) * (1.1 - 0.5 * this.risk) + 6);
      // A lane that is only a step on the way to the open one: no late threading there. The car
      // must be able to sit behind whatever is in it without an emergency stop.
      if (best !== next) room = Math.max(room, (closing * closing) / 18 + 6 + closing * (0.25 + 0.35 * (1 - this.risk)));
      // A wall across our lane and the next one (a wreck lying over two lanes, a set piece): the
      // next lane is no better, but it is no worse either and it is on the way to the open one.
      const cur = this.lanes[this.targetLane];
      const through = best !== next && side.dist > 8 && side.dist >= cur.dist - 2 && side.speed >= cur.speed - 1;
      // A second step before the first is finished: the car has to get right across the lane it
      // is still moving into before it reaches whatever drives there. (It used to step on at
      // once, stop braking for that lane, and meet the car in it half-way across.)
      const settle = LANE_CENTERS[this.targetLane] - p.d;
      const beyond = Math.abs(settle) > 1 && (LANE_CENTERS[next] - LANE_CENTERS[this.targetLane]) * settle > 0;
      const tCross = (Math.abs(settle) + half + 1.6) / 4 + 0.35;
      const crossable = !beyond || p.speed < 8 || cur.dist > Math.max(0, p.speed - cur.speed) * tCross + 6;
      if (crossable && (side.dist > room || through) && !this.rearBlocked(LANE_CENTERS[next], half + 0.45)) {
        this.targetLane = next;
        this.hold = through ? 0.25 : 0.5;
      }
    }

    // Standing behind a wall with the open lane out of reach: more than one lane away, the lane in
    // between blocked just ahead, or simply no room left to swing over (stopped a metre behind a
    // wreck, half-way into the lane change). Back up until there is room, then head straight for
    // the open lane. Latched: half-hearted reversing in bursts, creeping forward again in between,
    // once left the car standing for minutes.
    const open = best !== this.targetLane && this.lanes[best].dist > 60;
    const goal = open ? best : this.targetLane;
    const off = Math.abs(LANE_CENTERS[goal] - p.d);
    const swing = 6 + off * 2.2; // road it takes to move over that far from a standstill
    let room = 400;
    if (p.speed < 2.5) {
      // The tightest spot of our own corridor and of every lane on the way.
      const here = clamp(laneOf(p.d), 0, LANE_COUNT - 1);
      room = this.scan(p.d, half + 0.25, this.here).dist;
      const dir = goal > here ? 1 : -1;
      for (let l = here + dir; l !== goal && l >= 0 && l < LANE_COUNT; l += dir) room = Math.min(room, this.lanes[l].dist);
    }
    const boxed = off > 1.2 && room < swing && this.lanes[goal].dist > 25;
    this.waiting = (open || boxed) && p.speed < 1.5 ? this.waiting + dt : 0;
    if (!this.escape && p.speed < 2.5 && this.reverse <= 0 && ((open && tHere < wantMove) || this.waiting > (boxed ? 1.2 : 2.5))) {
      this.escape = true;
      this.escapeWait = 0;
    }
    if (this.escape) {
      if (!(open || boxed) || p.speed > 6) this.escape = false;
      else {
        const rear = this.rearBlocked(p.d, half + 0.45);
        if (rear) this.escapeWait += dt;
        if (room >= swing || this.backedUp >= 10 || this.escapeWait > 5) {
          // Enough room (or no more to be had): go for it.
          this.escape = false;
          this.targetLane = goal;
          this.hold = 4;
        } else if (!rear) {
          this.reverse = Math.max(this.reverse, 0.15);
          this.backedUp += dt;
          // Tail away from the open lane, so that the nose points into it — unless something
          // stands beside the tail there: then back into the open lane itself.
          const to = Math.sign(LANE_CENTERS[goal] - p.d) || 1;
          this.reverseSteer = this.besideTail(-to) && !this.rearBlocked(LANE_CENTERS[goal], half + 0.45) ? to * 0.45 : -to * 0.3;
        }
        // (else: somebody right behind — stand and wait for them, see holdStill)
      }
    } else if (p.speed > 12) this.backedUp = 0;
    const holdStill = this.escape && this.reverse <= 0;

    // Steering: aim for a lateral speed proportional to the offset, damp with yaw rate.
    const targetD = clamp(LANE_CENTERS[this.targetLane], BARRIER_LEFT_D + 1.5, BARRIER_RIGHT_D - 1.5);
    const err = targetD - p.d;
    const vLat = p.speed * Math.sin(p.relHeading);
    const vWant = clamp(err * 1.35, -4.4, 4.4);
    // Feed-forward for the curve: full lock holds about 0.97 g at any speed.
    const kappa = this.ctx.road.curvatureAt(p.s + p.speed * 0.25);
    const ff = (p.speed * p.speed * kappa) / (0.97 * 9.81);
    const yawErr = p.yawRate - p.speed * kappa;
    const want = clamp(ff + (vWant - vLat) * 0.32 - yawErr * 0.1, -1, 1);
    this.steerSmooth += (want - this.steerSmooth) * Math.min(1, dt * 14);
    c.steer = Math.abs(this.steerSmooth) < 0.03 && Math.abs(err) < 0.2 ? 0 : this.steerSmooth;

    // Speed: brake for whatever is in the corridor we actually occupy.
    let ahead = this.scan(p.d, half + 0.25, this.here);
    // While moving over, the lane we are heading for counts as well, and every lane on the way
    // to it: braking has to start with the lane change, not when the car is already half-way
    // into the gap.
    if (Math.abs(err) > 0.4) {
      const slack = (cl: Clearance) => cl.dist - Math.max(0, p.speed - cl.speed) ** 2 / 18;
      const from = clamp(laneOf(p.d), 0, LANE_COUNT - 1);
      const lo = Math.min(from, this.targetLane);
      const hi = Math.max(from, this.targetLane);
      for (let l = lo; l <= hi; l++) {
        if (l === from && from !== this.targetLane) continue; // the lane we are leaving: the corridor scan has it
        const cl = this.lanes[l];
        if (slack(cl) < slack(ahead)) ahead = cl;
      }
    }
    const closing = p.speed - ahead.speed;
    const tAhead = closing > 0.5 ? ahead.dist / closing : 99;
    // Distance needed to shed the closing speed at ≈ 9 m/s² plus a margin.
    const need = (closing * closing) / 18 + 6 + closing * (0.25 + 0.35 * (1 - this.risk));
    const mustBrake = closing > 0.5 && ahead.dist < need;
    // Crawling behind a standing obstacle while the target lane is open: keep rolling so the car
    // can actually steer round it.
    const creep = mustBrake && p.speed < 7 && Math.abs(err) > 0.5 && this.lanes[this.targetLane].dist > 12;
    c.brake = mustBrake && !creep ? 1 : 0;
    const follow = !mustBrake && closing > -1 && ahead.dist < 22; // sit behind without tailgating
    c.throttle = creep ? 0.35 : mustBrake ? 0 : follow ? 0.2 : p.speed < this.cruise ? 1 : 0.12;
    c.nitro = this.useNitro && !mustBrake && !follow && p.speed > 38 && p.speed < this.cruise - 2 && tAhead > 6 && Math.abs(err) < 0.6 && p.nitro01 > 0.45;
    c.handbrake = false;
    if (holdStill) {
      // Waiting for the car behind before backing up: do not creep forward meanwhile.
      c.throttle = 0;
      c.handbrake = true;
    }

    // Standing across the road (spun round by a hit it survived): everything above thinks in road
    // coordinates and gets nowhere from here; the car once stood nose to a wreck and tail to the
    // tunnel wall until the test gave up. Shuffle it round, forward with the wheel towards the
    // road and back with it the other way, until the nose points down the road again.
    if (Math.abs(p.relHeading) > (this.turnDir !== 0 ? 0.4 : 0.8) && Math.abs(p.speed) < 7) {
      if (this.turnDir === 0) {
        this.turnDir = 1;
        this.turn = 0;
      }
      this.turn += dt;
      // Change direction after a stroke, or as soon as the car is up against something.
      if (this.turn > 1.6 || (this.turn > 0.6 && Math.abs(p.speed) < 0.3)) {
        this.turnDir = -this.turnDir;
        this.turn = 0;
      }
      const to = -Math.sign(p.relHeading);
      c.steer = this.turnDir > 0 ? to : -to;
      c.throttle = this.turnDir > 0 ? 0.55 : 0;
      c.brake = this.turnDir > 0 ? 0 : 1; // brake at a standstill = reverse
      c.handbrake = false;
      c.nitro = false;
      this.steerSmooth = 0;
      this.reverse = 0;
      this.stuck = 0;
      this.escape = false;
      this.waiting = 0;
      return c;
    }
    this.turnDir = 0;

    // Wedged against a wreck or a barrier: back out with the wheel turned the other way.
    if (p.speed < 0.6 && c.throttle > 0.1 && ahead.dist < 3) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt * 2);
    if (this.stuck > 1.2) {
      this.stuck = 0;
      this.reverse = 1.5;
      this.reverseSteer = -Math.sign(err || 1) * 0.6;
    }
    if (this.reverse > 0) {
      this.reverse -= dt;
      c.throttle = 0;
      c.brake = 1; // brake at a standstill = reverse
      c.steer = this.reverseSteer;
      c.nitro = false;
    }
    return c;
  }
}

/**
 * Sutherland–Hodgman against one side of a lateral strip: keeps the part of the polygon (s, d pairs)
 * with sign · (d − edge) ≥ 0. Returns the number of points written to `out`.
 */
function clipHalf(inp: Float64Array, n: number, out: Float64Array, edge: number, sign: number): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const s0 = inp[i * 2];
    const d0 = inp[i * 2 + 1];
    const s1 = inp[j * 2];
    const d1 = inp[j * 2 + 1];
    const in0 = sign * (d0 - edge) >= 0;
    const in1 = sign * (d1 - edge) >= 0;
    if (in0) {
      out[m * 2] = s0;
      out[m * 2 + 1] = d0;
      m++;
    }
    if (in0 !== in1) {
      const t = (edge - d0) / (d1 - d0);
      out[m * 2] = s0 + (s1 - s0) * t;
      out[m * 2 + 1] = edge;
      m++;
    }
  }
  return m;
}
