/**
 * Roadside furniture chunk features (agent "furniture").
 *
 *   import { furnitureFeatures } from './world/features/furniture';
 *   for (const f of furnitureFeatures) world.addFeature(f.name, f.build);
 *
 * Per chunk (worst case, city chunk with gantry): ≤ 12 draw calls
 *   barriers: concrete median
 *   rails:    W-beams + terminal posts + gantry truss + verge metal (bent) · 4 m post/splice units (instanced)
 *   lamps:    median assemblies · right assemblies (instanced, lens in the same draw) · halos · haze cones (volumetrics only)
 *   gantry:   sign faces (the truss is merged into the rails mesh)
 *   small:    reflectors (studs, delineators) · delineator posts (instanced) · verge sign faces
 */
import type { IChunkBuilder } from '../../../core/types';
import { buildBarriers, buildRails } from './barriers';
import { buildGantry } from './gantry';
import { buildLamps } from './lamps';
import { buildSmall } from './small';

export const furnitureFeatures: Array<{ name: string; build: (b: IChunkBuilder) => void }> = [
  { name: 'furniture-barriers', build: buildBarriers },
  { name: 'furniture-rails', build: buildRails },
  { name: 'furniture-lamps', build: buildLamps },
  { name: 'furniture-gantry', build: buildGantry },
  { name: 'furniture-small', build: buildSmall },
];

export { LAMP_RGB } from './materials';
