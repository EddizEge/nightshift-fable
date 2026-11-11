import type { TrafficType, TrafficVehicleDef } from '../../core/types';

/** Plausible defaults (used by the stub factory and tests; the real factory supplies its own). */
export const STUB_DEFS: Readonly<Record<TrafficType, TrafficVehicleDef>> = {
  sedan: { type: 'sedan', length: 4.85, width: 1.86, height: 1.45, mass: 1550, speedMin: 27, speedMax: 33, tailY: 0.95, tailX: 0.7, headY: 0.72, headX: 0.64 },
  hatch: { type: 'hatch', length: 4.2, width: 1.79, height: 1.47, mass: 1250, speedMin: 26, speedMax: 32, tailY: 0.98, tailX: 0.66, headY: 0.74, headX: 0.6 },
  suv: { type: 'suv', length: 4.75, width: 1.93, height: 1.72, mass: 2050, speedMin: 26, speedMax: 32, tailY: 1.1, tailX: 0.72, headY: 0.86, headX: 0.66 },
  sports: { type: 'sports', length: 4.5, width: 1.95, height: 1.25, mass: 1500, speedMin: 30, speedMax: 36, tailY: 0.82, tailX: 0.74, headY: 0.64, headX: 0.68 },
  van: { type: 'van', length: 5.4, width: 2.02, height: 2.3, mass: 2600, speedMin: 24, speedMax: 29, tailY: 1.0, tailX: 0.8, headY: 0.8, headX: 0.72 },
  boxtruck: { type: 'boxtruck', length: 7.6, width: 2.45, height: 3.4, mass: 7500, speedMin: 22, speedMax: 26, tailY: 0.9, tailX: 1.05, headY: 0.95, headX: 0.85 },
  semi: { type: 'semi', length: 16.5, width: 2.55, height: 4.0, mass: 18000, speedMin: 22, speedMax: 25, tailY: 0.95, tailX: 1.1, headY: 1.0, headX: 0.9 },
  tanker: { type: 'tanker', length: 14.5, width: 2.55, height: 3.6, mass: 22000, speedMin: 22, speedMax: 24, tailY: 0.95, tailX: 1.1, headY: 1.0, headX: 0.9 },
};

export const TRAFFIC_TYPES: readonly TrafficType[] = ['sedan', 'hatch', 'suv', 'sports', 'van', 'boxtruck', 'semi', 'tanker'];

export function isHeavy(t: TrafficType): boolean {
  return t === 'boxtruck' || t === 'semi' || t === 'tanker';
}

/**
 * Pick a type. `heavyShare` = combined van/boxtruck/semi/tanker share (≈ 0.22, grows with distance).
 */
export function pickType(r1: number, r2: number, heavyShare: number): TrafficType {
  if (r1 < heavyShare) {
    if (r2 < 0.35) return 'van';
    if (r2 < 0.6) return 'boxtruck';
    if (r2 < 0.85) return 'semi';
    return 'tanker';
  }
  if (r2 < 0.34) return 'sedan';
  if (r2 < 0.56) return 'hatch';
  if (r2 < 0.84) return 'suv';
  return 'sports';
}
