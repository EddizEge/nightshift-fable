/**
 * Render jobs shared by the render worker (render.worker.ts) and the main-thread fallback.
 * Pure DSP: no DOM, no Web Audio objects.
 */
import type { SfxName } from '../core/types';
import type { Stereo } from './dsp';
import { renderSfx } from './bank';
import { LOOP_NAMES, renderLoops } from './loops';
import { tunnelImpulse } from './impulse';

export type RenderJob = { kind: 'sfx'; name: SfxName; sr: number } | { kind: 'loops'; sr: number } | { kind: 'ir'; sr: number };

/** Loops come back in LOOP_NAMES order; sfx as its variants. */
export function runJob(job: RenderJob): Stereo[] {
  if (job.kind === 'sfx') return renderSfx(job.name, job.sr);
  if (job.kind === 'ir') return [tunnelImpulse(job.sr, 2.2)]; // ≈ 50 ms at 48 kHz, 100 ms at 96 kHz
  const set = renderLoops(job.sr);
  return LOOP_NAMES.map((k) => set[k]);
}
