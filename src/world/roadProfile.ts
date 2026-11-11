/**
 * Road cross-section and layout constants (metres). Road space: d = 0 is the centre of OUR
 * carriageway, + is right (towards the outer guardrail), y = 0 is the asphalt.
 *
 *   opposite carriageway        median         our carriageway (4 lanes)        verge
 *  ...-23.55 -19.85 -16.15 -12.45 | -9.0 | -5.55 -1.85 +1.85 +5.55 | shoulder | rail ...
 */
export const LANE_WIDTH = 3.7;
export const LANE_COUNT = 4;
/** Lane centre offsets, lane 0 = leftmost (fast lane, next to the median). */
export const LANE_CENTERS: readonly number[] = [-5.55, -1.85, 1.85, 5.55];
/** Half width of the 4 lanes. */
export const LANES_HALF = 7.4;
/** Paved shoulders. */
export const SHOULDER_LEFT = 1.3;
export const SHOULDER_RIGHT = 3.0;
/** Median concrete barrier (Jersey profile): centre line and half width at its base. */
export const MEDIAN_D = -9.0;
export const MEDIAN_HALF = 0.3;
export const MEDIAN_HEIGHT = 1.05;
/** Faces that the player can hit. */
export const BARRIER_LEFT_D = MEDIAN_D + MEDIAN_HALF; // -8.7
export const BARRIER_RIGHT_D = LANES_HALF + SHOULDER_RIGHT; // +10.4 (steel guardrail face / tunnel wall / bridge parapet)
export const GUARDRAIL_HEIGHT = 0.8;
/** Edge of the asphalt on the right (shoulder end + a little). */
export const PAVED_RIGHT_D = BARRIER_RIGHT_D + 0.6; // 11.0
/** Mirror a lateral offset to the opposite carriageway. */
export const mirrorD = (d: number): number => 2 * MEDIAN_D - d;
/** Opposite carriageway lane centres (traffic there drives towards -s). */
export const OPPOSITE_LANE_CENTERS: readonly number[] = LANE_CENTERS.map(mirrorD);
/** Outer edge of everything paved on the opposite side. */
export const PAVED_LEFT_D = mirrorD(PAVED_RIGHT_D); // -29.0

/** World streaming. */
export const CHUNK_LENGTH = 220;

/** Street lamps: slots every LAMP_SPACING m, alternating median / right side. */
export const LAMP_SPACING = 22; // slot pitch; same-side lamps are 44 m apart
export const LAMP_HEIGHT = 10.5;
/** Luminaire lateral positions. */
export const LAMP_MEDIAN_D = -6.4; // arm from the median mast reaching over our fast lane
export const LAMP_RIGHT_D = 8.4; // arm from the right-hand pole reaching over the slow lane
export const LAMP_RIGHT_POLE_D = BARRIER_RIGHT_D + 1.1; // 11.5
/** Median masts carry two arms: ours and the mirrored one for the opposite carriageway. */
export const LAMP_MEDIAN_OPP_D = mirrorD(LAMP_MEDIAN_D); // -11.6
export const LAMP_OPP_OUTER_D = mirrorD(LAMP_RIGHT_D); // -26.4
export const LAMP_OPP_OUTER_POLE_D = mirrorD(LAMP_RIGHT_POLE_D); // -29.5

/** Tunnel cross-section (rectangular cut-and-cover box per carriageway). */
export const TUNNEL_WALL_RIGHT_D = BARRIER_RIGHT_D + 0.5; // 10.9 (kerb walkway in between)
export const TUNNEL_WALL_LEFT_D = MEDIAN_D; // shared centre wall replaces the median barrier
export const TUNNEL_CEILING_Y = 6.4;
/** Two continuous luminaire strips on the ceiling. */
export const TUNNEL_LIGHT_D: readonly number[] = [-4.6, 5.4];
export const TUNNEL_LIGHT_Y = 6.1;

/** Overpass (a road crossing above us). */
export const OVERPASS_CLEARANCE = 6.2;
export const OVERPASS_DECK_Y = 7.6;
export const OVERPASS_WIDTH = 13; // extent along our s axis

/** Bridge deck: parapets replace guardrails, water lies far below. */
export const BRIDGE_WATER_Y = -28;

export function laneCenter(lane: number): number {
  return LANE_CENTERS[Math.max(0, Math.min(LANE_COUNT - 1, lane))];
}
export function laneOf(d: number): number {
  return Math.max(0, Math.min(LANE_COUNT - 1, Math.floor((d + LANES_HALF) / LANE_WIDTH)));
}
