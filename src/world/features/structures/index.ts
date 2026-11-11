/**
 * Big set pieces as chunk features: overpasses, tunnels (tubes + portals + approach walls),
 * the cable-stayed bridge and city noise / retaining walls.
 *
 *   import { structureFeatures } from './world/features/structures';
 *   for (const f of structureFeatures) world.addFeature(f.name, f.build);
 *
 * Each entry is a separate (time-sliced) job; each runs once per chunk and returns at once
 * when the chunk has nothing for it.
 */
import type { IChunkBuilder } from '../../../core/types';
import { buildOverpass } from './overpass';
import { buildBridgeDeck, buildBridgePylon } from './bridge';
import { buildCityWalls } from './walls';
import { buildTunnelApproach, buildTunnelPortals, buildTunnelTubes } from './tunnel';

export { breakOverpassRailing, getOverpassInfo, OVERPASS_D0, OVERPASS_D1, OVERPASS_PARAPET_TOP, OVERPASS_RAIL_TOP, RAIL_X0, RAIL_X1 } from './overpass';

export const structureFeatures: Array<{ name: string; build: (b: IChunkBuilder) => void }> = [
  { name: 'structures-overpass', build: (b) => buildOverpass(b) },
  { name: 'structures-tunnel', build: (b) => buildTunnelTubes(b) },
  { name: 'structures-portal', build: (b) => buildTunnelPortals(b) },
  { name: 'structures-approach', build: (b) => buildTunnelApproach(b) },
  { name: 'structures-bridge', build: (b) => buildBridgeDeck(b) },
  { name: 'structures-pylon', build: (b) => buildBridgePylon(b) },
  { name: 'structures-walls', build: (b) => buildCityWalls(b) },
];
