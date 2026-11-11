import type { IEventBus, RunSummary, TrafficVehicle } from '../core/types';
import { clamp } from '../core/math';

const BEST_KEY = 'nightshift.best';
export const COMBO_WINDOW = 4.5; // seconds a combo survives without a new near miss
const COMBO_MAX = 10;

// Session copy of the best score: with storage blocked, not every run is a new best.
let memBest = 0;

export function readBest(): number {
  try {
    const v = Number(localStorage.getItem(BEST_KEY));
    return Number.isFinite(v) ? Math.max(v, memBest) : memBest;
  } catch {
    return memBest;
  }
}

function writeBest(v: number): void {
  memBest = Math.max(memBest, Math.round(v));
  try {
    localStorage.setItem(BEST_KEY, String(Math.round(v)));
  } catch {
    /* ignore */
  }
}

interface PassTrack {
  /** Player-relative longitudinal offset last frame (vehicle s − player s). */
  rel: number;
  /** Smallest lateral body gap seen while overlapping longitudinally. */
  minGap: number;
  overlapped: boolean;
  /** Update stamp of the last step the vehicle was seen. */
  stamp: number;
}

/**
 * Scoring: distance points scale with speed, near misses build a combo multiplier, risk
 * bonuses reward sustained high speed and threading between vehicles.
 */
export class ScoreSystem {
  score = 0;
  distance = 0;
  topSpeedKmh = 0;
  nearMisses = 0;
  survivalTime = 0;
  riskBonus = 0;
  combo = 1;
  bestCombo = 1;
  comboTimer = 0;
  private track = new Map<number, PassTrack>();
  private speedRiskTimer = 0;
  private lastNearMissTime = -10;
  private time = 0;
  private stamp = 0;

  constructor(private events: IEventBus) {}

  reset(): void {
    this.score = 0;
    this.distance = 0;
    this.topSpeedKmh = 0;
    this.nearMisses = 0;
    this.survivalTime = 0;
    this.riskBonus = 0;
    this.combo = 1;
    this.bestCombo = 1;
    this.comboTimer = 0;
    this.track.clear();
    this.speedRiskTimer = 0;
    this.lastNearMissTime = -10;
    this.time = 0;
  }

  get comboTimer01(): number {
    return this.combo > 1 ? clamp(this.comboTimer / COMBO_WINDOW, 0, 1) : 0;
  }

  private award(points: number): number {
    const p = Math.round(points * this.combo);
    this.score += p;
    return p;
  }

  /** Add a scripted bonus (events). */
  bonus(label: string, points: number): void {
    const p = this.award(points);
    this.riskBonus += p;
    this.events.emit('bonus', { label, points: p });
  }

  update(
    dt: number,
    player: { s: number; d: number; speed: number; speedKmh: number; nitroActive: boolean; dims: { width: number; length: number } },
    traffic: readonly TrafficVehicle[],
  ): void {
    this.time += dt;
    this.survivalTime += dt;
    const ds = Math.max(0, player.speed) * dt;
    this.distance += ds;
    const kmh = Math.abs(player.speedKmh);
    this.topSpeedKmh = Math.max(this.topSpeedKmh, kmh);
    // Distance points: 1 per metre at 100 km/h, rising steeply with speed.
    // Accumulated as a fraction: a 120 Hz step is worth less than one point.
    const speedFactor = clamp((kmh - 60) / 100, 0, 3.2);
    this.score += ds * speedFactor * this.combo;

    // Combo decay.
    if (this.combo > 1) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.combo = 1;
        this.comboTimer = 0;
      }
    }

    // Sustained high speed risk bonus.
    if (kmh > 240) {
      this.speedRiskTimer += dt;
      if (this.speedRiskTimer >= 5) {
        this.speedRiskTimer = 0;
        this.bonus(kmh > 300 ? 'RED LINE' : 'HIGH SPEED', kmh > 300 ? 600 : 300);
      }
    } else this.speedRiskTimer = Math.max(0, this.speedRiskTimer - dt * 2);

    // Near misses: a vehicle passes from ahead to behind while the lateral body gap was small.
    const halfW = player.dims.width * 0.5;
    const halfL = player.dims.length * 0.5;
    const stamp = ++this.stamp;
    let threaded = 0;
    for (const v of traffic) {
      if (v.mode === 'wreck') continue;
      const rel = v.s - player.s;
      let t = this.track.get(v.id);
      if (!t) {
        t = { rel, minGap: Infinity, overlapped: false, stamp };
        this.track.set(v.id, t);
      }
      t.stamp = stamp;
      const longOverlap = Math.abs(rel) < v.halfLength + halfL + 0.6;
      const gap = Math.abs(v.d - player.d) - v.halfWidth - halfW;
      if (longOverlap) {
        t.overlapped = true;
        if (gap < t.minGap) t.minGap = gap;
        if (gap < 1.4) threaded++;
      }
      // Passed it (it is now behind us).
      if (t.rel > -(v.halfLength + halfL) && rel <= -(v.halfLength + halfL) && t.overlapped && !v.nearMissDone) {
        const relSpeed = (player.speed - v.speed) * 3.6;
        if (t.minGap > -0.05 && t.minGap < 1.25 && relSpeed > 12 && kmh > 90) {
          v.nearMissDone = true;
          this.nearMisses++;
          const close = t.minGap < 0.45;
          const base = (close ? 450 : 250) * (1 + clamp((kmh - 150) / 150, 0, 1.2)) * (player.nitroActive ? 1.25 : 1);
          if (this.time - this.lastNearMissTime < COMBO_WINDOW || this.combo > 1) this.combo = Math.min(COMBO_MAX, this.combo + 1);
          else this.combo = Math.max(this.combo, 2);
          this.bestCombo = Math.max(this.bestCombo, this.combo);
          this.comboTimer = COMBO_WINDOW;
          this.lastNearMissTime = this.time;
          const points = this.award(base);
          this.events.emit('nearMiss', {
            vehicleId: v.id,
            gap: t.minGap,
            speedKmh: kmh,
            points,
            side: v.d < player.d ? -1 : 1,
            combo: this.combo,
          });
        }
        t.overlapped = false;
        t.minGap = Infinity;
      }
      t.rel = rel;
    }
    // Threading between two vehicles side by side.
    if (threaded >= 2 && kmh > 140 && this.time - this.lastThread > 2) {
      this.lastThread = this.time;
      this.bonus('THREAD THE NEEDLE', 500);
    }
    for (const id of this.track.keys()) if (this.track.get(id)!.stamp !== stamp) this.track.delete(id);
  }
  private lastThread = -10;

  finish(cause: string): RunSummary {
    const best = readBest();
    const isNewBest = this.score > best;
    if (isNewBest) writeBest(this.score);
    return {
      score: Math.round(this.score),
      distance: this.distance,
      topSpeedKmh: this.topSpeedKmh,
      nearMisses: this.nearMisses,
      survivalTime: this.survivalTime,
      riskBonus: Math.round(this.riskBonus),
      bestCombo: this.bestCombo,
      bestScore: Math.round(Math.max(best, this.score)),
      isNewBest,
      cause,
    };
  }
}
