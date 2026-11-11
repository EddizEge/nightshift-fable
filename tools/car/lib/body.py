"""
The body of the player car.

The skin is ONE subdivision surface.  Its control cage is generated here from design curves and has
the topology of an open box:

  lid   rows r = 0..6 run along the car (0 = centreline, 6 = shoulder), columns are the stations
        s = 0..S-1 from the front edge of the bonnet to the trailing edge of the tail.  Bonnet,
        windscreen, roof, side glass, engine cover and deck are all part of it.
  wall  hangs from the edge of the lid and wraps around the car: front fascia, body side, rear
        fascia.  Loops l = 0 (the lid edge) .. 5 (turned under the car / into the wheel arch).
        Around a wheel the columns fan out from the arch, so the loops flow around the opening.

Only the right half (x >= 0) is generated; it is mirrored before subdividing.  Every cage face
carries a zone (which material and what is done with it later) and a panel name; cage edges between
two panels become the shut lines.
"""
import math

import bmesh
import bpy
from mathutils import Vector

from . import spec as S
from . import util

SUBDIV = 2
ROWS = 7           # lid rows per half, centreline included
LOOPS = 6          # wall loops, the lid edge included


# ── interpolation ────────────────────────────────────────────────────────────────────────────

class Curve:
    """Shape-preserving cubic through (t, value) keys; keys named in `corners` keep a kink."""

    def __init__(self, keys, corners=()):
        keys = sorted(keys)
        self.t = [k[0] for k in keys]
        self.v = [k[1] for k in keys]
        n = len(keys)
        t, v = self.t, self.v
        h = [t[i + 1] - t[i] for i in range(n - 1)]
        d = [(v[i + 1] - v[i]) / h[i] for i in range(n - 1)]
        self.m_in = [0.0] * n     # slope arriving at key i
        self.m_out = [0.0] * n    # slope leaving key i
        for i in range(n):
            if n == 1:
                m = 0.0
            elif i == 0:
                m = d[0]
            elif i == n - 1:
                m = d[-1]
            elif d[i - 1] * d[i] <= 0:
                m = 0.0
            else:
                w1 = 2 * h[i] + h[i - 1]
                w2 = h[i] + 2 * h[i - 1]
                m = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
            self.m_in[i] = self.m_out[i] = m
            if 0 < i < n - 1 and any(abs(t[i] - c) < 1e-6 for c in corners):
                self.m_in[i] = d[i - 1]
                self.m_out[i] = d[i]

    def __call__(self, x):
        t, v = self.t, self.v
        if x <= t[0]:
            return v[0]
        if x >= t[-1]:
            return v[-1]
        i = 0
        while x > t[i + 1]:
            i += 1
        h = t[i + 1] - t[i]
        u = (x - t[i]) / h
        h00 = (1 + 2 * u) * (1 - u) ** 2
        h10 = u * (1 - u) ** 2
        h01 = u * u * (3 - 2 * u)
        h11 = u * u * (u - 1)
        return h00 * v[i] + h10 * h * self.m_out[i] + h01 * v[i + 1] + h11 * h * self.m_in[i + 1]


# ── stations ─────────────────────────────────────────────────────────────────────────────────
# A station is named by t = the y of its point on the shoulder line.

def _arch_ts(hub_y):
    return [hub_y + 0.42 * math.cos(math.radians(8 + 164 * j / 9)) for j in range(10)]


T_FRONT = 2.02
T_REAR = -2.06
FRONT_ARCH_T = _arch_ts(S.FRONT_AXLE_Y)
REAR_ARCH_T = _arch_ts(S.REAR_AXLE_Y)
T_COWL, T_HEADER, T_PEAK, T_ROOF_END = 0.72, 0.00, -0.30, -0.82
T_DOOR_FRONT, T_DOOR_REAR = T_COWL, -0.60
DOOR_T = [T_COWL, 0.48, 0.24, T_HEADER, T_PEAK, T_DOOR_REAR, T_ROOF_END]
T = [T_FRONT, 1.92] + FRONT_ARCH_T + DOOR_T + REAR_ARCH_T + [-1.94, T_REAR]
NS = len(T)
FRONT_ARCH_S = range(2, 12)
REAR_ARCH_S = range(12 + len(DOOR_T), 22 + len(DOOR_T))


def st(t):
    """Index of the station nearest to t."""
    return min(range(NS), key=lambda i: abs(T[i] - t))


# ── the lid: seven lines along the car, keyed at stations ───────────────────────────────────
#   r0 centreline          r1 inner bonnet / roof     r2 edge of windscreen and engine cover
#   r3 top of side glass, then the ridge of the buttress
#   r4 wing peak / waist line / haunch   r5 roll of the shoulder   r6 shoulder (edge of the lid)
LID = [
    (2.02, [(0, 2.225, 0.512), (0.24, 2.205, 0.515), (0.455, 2.155, 0.528), (0.61, 2.095, 0.552), (0.73, 2.035, 0.580), (0.81, 1.985, 0.596), (0.865, 1.950, 0.600)]),
    (1.80, [(0, 1.960, 0.628), (0.25, 1.950, 0.630), (0.48, 1.915, 0.648), (0.645, 1.875, 0.690), (0.765, 1.830, 0.728), (0.842, 1.810, 0.736), (0.900, 1.800, 0.722)]),
    (1.40, [(0, 1.430, 0.770), (0.26, 1.425, 0.772), (0.50, 1.415, 0.788), (0.66, 1.405, 0.838), (0.78, 1.400, 0.872), (0.855, 1.400, 0.866), (0.915, 1.400, 0.846)]),
    (1.00, [(0, 1.180, 0.820), (0.31, 1.165, 0.822), (0.58, 1.100, 0.836), (0.705, 1.045, 0.858), (0.80, 1.010, 0.872), (0.865, 1.000, 0.864), (0.920, 1.000, 0.838)]),
    (0.72, [(0, 1.050, 0.845), (0.36, 1.010, 0.848), (0.69, 0.830, 0.858), (0.765, 0.775, 0.866), (0.828, 0.740, 0.866), (0.882, 0.722, 0.852), (0.925, 0.720, 0.822)]),
    (0.00, [(0, 0.130, 1.168), (0.30, 0.110, 1.164), (0.515, 0.050, 1.142), (0.595, 0.010, 1.106), (0.842, 0.000, 0.850), (0.898, 0.000, 0.836), (0.937, 0.000, 0.802)]),
    (-0.30, [(0, -0.280, 1.198), (0.30, -0.285, 1.193), (0.52, -0.295, 1.170), (0.602, -0.300, 1.130), (0.843, -0.300, 0.848), (0.900, -0.300, 0.834), (0.938, -0.300, 0.800)]),
    (-0.82, [(0, -0.780, 1.172), (0.29, -0.790, 1.166), (0.50, -0.800, 1.142), (0.598, -0.810, 1.100), (0.850, -0.820, 0.872), (0.908, -0.820, 0.858), (0.946, -0.820, 0.824)]),
    (-1.05, [(0, -1.130, 1.040), (0.28, -1.130, 1.040), (0.49, -1.110, 1.050), (0.625, -1.075, 1.052), (0.842, -1.050, 0.922), (0.915, -1.050, 0.902), (0.955, -1.050, 0.866)]),
    (-1.40, [(0, -1.500, 0.992), (0.28, -1.500, 0.992), (0.50, -1.470, 1.000), (0.665, -1.430, 1.004), (0.80, -1.400, 0.962), (0.90, -1.400, 0.945), (0.955, -1.400, 0.915)]),
    (-1.80, [(0, -1.920, 0.946), (0.29, -1.910, 0.946), (0.52, -1.880, 0.948), (0.68, -1.840, 0.948), (0.795, -1.810, 0.938), (0.878, -1.800, 0.922), (0.925, -1.800, 0.894)]),
    (-1.94, [(0, -2.085, 0.928), (0.30, -2.072, 0.928), (0.52, -2.035, 0.928), (0.67, -1.985, 0.928), (0.775, -1.940, 0.922), (0.85, -1.905, 0.910), (0.893, -1.885, 0.886)]),
    (-2.06, [(0, -2.215, 0.938), (0.30, -2.200, 0.937), (0.51, -2.160, 0.934), (0.65, -2.110, 0.930), (0.745, -2.060, 0.922), (0.81, -2.015, 0.910), (0.855, -1.985, 0.890)]),
]
# The windscreen is a flat plane: the rows through it keep a kink at its lower and upper edge.
LID_CORNERS = {0: (T_COWL, T_HEADER, T_ROOF_END), 1: (T_COWL, T_HEADER, T_ROOF_END), 2: (T_COWL, T_HEADER), 3: (T_COWL, T_HEADER)}

# ── the wall at the two ends: explicit columns under the lid rows r0..r6, loops 1..5 ─────────
# Loop 4 is the leading edge of the splitter: a blade that stands out in front of the face above it.
FRONT = [
    [(0.000, 2.335, 0.440), (0.000, 2.350, 0.382), (0.000, 2.338, 0.192), (0.000, 2.396, 0.114), (0.000, 2.250, 0.105)],
    [(0.245, 2.315, 0.442), (0.250, 2.330, 0.383), (0.255, 2.320, 0.192), (0.260, 2.378, 0.114), (0.250, 2.232, 0.105)],
    [(0.470, 2.262, 0.452), (0.480, 2.276, 0.388), (0.490, 2.266, 0.193), (0.502, 2.324, 0.114), (0.485, 2.180, 0.105)],
    [(0.635, 2.195, 0.470), (0.650, 2.206, 0.400), (0.665, 2.196, 0.197), (0.680, 2.250, 0.115), (0.650, 2.110, 0.105)],
    [(0.765, 2.118, 0.492), (0.785, 2.124, 0.416), (0.800, 2.115, 0.206), (0.818, 2.160, 0.118), (0.765, 2.030, 0.106)],
    [(0.852, 2.048, 0.510), (0.875, 2.048, 0.432), (0.890, 2.040, 0.217), (0.905, 2.072, 0.123), (0.835, 1.960, 0.108)],
    [(0.912, 1.972, 0.528), (0.935, 1.968, 0.450), (0.945, 1.962, 0.230), (0.950, 1.978, 0.130), (0.875, 1.900, 0.110)],
]
# The tail leans the other way round than a box: the lamp bar under the lip is the rearmost face, everything
# below it falls back.  Loop 4 is the lower edge of the bumper; from there the skin runs forward and down as
# the roof of the diffuser tunnel (loop 5 = where the tunnel meets the flat floor).
REAR = [
    [(0.000, -2.130, 0.888), (0.000, -2.150, 0.800), (0.000, -2.140, 0.560), (0.000, -2.090, 0.405), (0.000, -1.700, 0.170)],
    [(0.300, -2.118, 0.887), (0.305, -2.138, 0.799), (0.310, -2.128, 0.560), (0.310, -2.078, 0.405), (0.300, -1.700, 0.170)],
    [(0.515, -2.080, 0.884), (0.525, -2.100, 0.797), (0.540, -2.090, 0.558), (0.540, -2.042, 0.400), (0.520, -1.700, 0.170)],
    [(0.660, -2.032, 0.880), (0.675, -2.052, 0.794), (0.690, -2.042, 0.555), (0.690, -1.995, 0.395), (0.660, -1.720, 0.175)],
    [(0.760, -1.985, 0.872), (0.780, -2.004, 0.789), (0.795, -1.992, 0.550), (0.790, -1.945, 0.385), (0.735, -1.800, 0.250)],
    [(0.830, -1.945, 0.862), (0.856, -1.960, 0.782), (0.868, -1.945, 0.545), (0.852, -1.900, 0.372), (0.790, -1.820, 0.300)],
    [(0.882, -1.918, 0.850), (0.915, -1.925, 0.774), (0.918, -1.905, 0.540), (0.885, -1.865, 0.355), (0.815, -1.820, 0.320)],
]

# ── the wall along the side: half width of loops 1..4, where they sit between shoulder and
#    bottom (fractions), and the bottom line; keyed along t ─────────────────────────────────
_SIDE_T = [1.92, 1.816, 1.40, 0.984, 0.72, 0.24, -0.30, -0.60, -0.82, -0.984, -1.40, -1.816, -1.94]
# Between the arches the side is scalloped: the surface under loop 1 leans in, more and more towards the rear,
# and ends in the engine intake; loop 1 is the character line above it (it rises from the front wheel to the
# top of the intake), the sill below stands out again.
_SIDE_X = {
    1: [0.928, 0.942, 0.959, 0.958, 0.960, 0.960, 0.955, 0.947, 0.985, 0.990, 0.998, 0.980, 0.950],
    2: [0.952, 0.968, 0.990, 0.972, 0.945, 0.932, 0.920, 0.905, 0.992, 1.000, 1.022, 1.000, 0.965],
    3: [0.965, 0.984, 1.009, 0.980, 0.940, 0.925, 0.912, 0.902, 0.987, 1.004, 1.039, 1.012, 0.955],
    4: [0.968, 0.994, 1.015, 0.988, 0.952, 0.948, 0.948, 0.950, 0.968, 1.010, 1.045, 1.012, 0.915],
}
_SIDE_F = {
    1: [0.14, 0.19, 0.25, 0.22, 0.30, 0.29, 0.23, 0.17, 0.18, 0.22, 0.25, 0.16, 0.10],
    2: [0.32, 0.41, 0.50, 0.48, 0.46, 0.46, 0.45, 0.44, 0.45, 0.48, 0.50, 0.30, 0.22],
    3: [0.80, 0.78, 0.75, 0.74, 0.73, 0.70, 0.66, 0.64, 0.66, 0.72, 0.75, 0.62, 0.58],
}
# Behind the rear wheel the body is cut away (the tyre shows from behind): the bottom line jumps up there.
_BOTTOM_Z = [(1.92, 0.130), (0.72, 0.145), (0.24, 0.150), (-0.30, 0.155), (-0.82, 0.165), (-1.94, 0.340)]
_BOTTOM_DY = [(1.92, -0.045), (1.82, 0.0), (-1.82, 0.0), (-1.94, 0.060)]

# The mouth of the engine intake leans a little: its top edge further forward than its bottom edge.
_SIDE_DY = {
    1: [(2.0, 0.0), (-0.30, 0.0), (-0.60, 0.030), (-0.82, 0.030), (-0.984, 0.0), (-2.0, 0.0)],
    2: [(2.0, 0.0), (-0.30, 0.0), (-0.60, 0.000), (-0.82, 0.000), (-0.984, 0.0), (-2.0, 0.0)],
    3: [(2.0, 0.0), (-0.30, 0.0), (-0.60, -0.030), (-0.82, -0.030), (-0.984, 0.0), (-2.0, 0.0)],
}
SIDE_DY = {l: Curve(v) for l, v in _SIDE_DY.items()}
SIDE_X = {l: Curve(list(zip(_SIDE_T, v))) for l, v in _SIDE_X.items()}
SIDE_F = {l: Curve(list(zip(_SIDE_T, v))) for l, v in _SIDE_F.items()}
BOTTOM_Z = Curve(_BOTTOM_Z)
BOTTOM_DY = Curve(_BOTTOM_DY)

ARCH_LIP = 0.040      # how far the wall turns into the wheel arch
UNDER_TUCK = 0.070    # how far it turns under the sill


def _arch(hub_y, radius, bottom_z, rear_z=None):
    """(y, z) of the ten arch points, front to rear; the rear end may stop higher than the front one."""
    a0 = -math.asin((S.HUB_Z - bottom_z) / radius)
    a1 = math.pi + math.asin((S.HUB_Z - (bottom_z if rear_z is None else rear_z)) / radius)
    pts = []
    for j in range(10):
        a = a0 + (a1 - a0) * j / 9
        pts.append((hub_y + radius * math.cos(a), S.HUB_Z + radius * math.sin(a)))
    return pts


REAR_ARCH_END_Z = 0.315   # the rear arch ends here: behind the wheel the body is open down to the road
FRONT_ARCH = _arch(S.FRONT_AXLE_Y, S.ARCH_R_F, 0.142)
REAR_ARCH = _arch(S.REAR_AXLE_Y, S.ARCH_R_R, 0.165, REAR_ARCH_END_Z)


# ── zones: what a cage face becomes ──────────────────────────────────────────────────────────
ZONES = ['paint', 'accent', 'glass_ws', 'glass_side', 'glass_rear', 'lamp_head', 'lamp_tail',
         'carbon', 'under', 'cover', 'duct', 'mesh', 'gap']
ZONE_MATERIAL = {
    'paint': 'paint_main', 'accent': 'paint_accent', 'glass_ws': 'glass', 'glass_side': 'glass',
    'glass_rear': 'glass', 'lamp_head': 'lens', 'lamp_tail': 'lens', 'carbon': 'carbon',
    'under': 'trim', 'cover': 'paint_accent', 'duct': 'grille', 'mesh': 'grille_mesh', 'gap': 'trim',
}
GLASS = ('glass_ws', 'glass_side', 'glass_rear')
# Zones that are panels of the car: where two of them with different panel names meet there is a shut line.
PANEL_ZONES = ('paint', 'accent', 'glass_ws', 'glass_side', 'glass_rear', 'lamp_head', 'lamp_tail', 'carbon', 'cover')
NO_PANEL = -1


def lid_zone(rb, sb):
    """Zone and panel of the lid face between rows rb, rb+1 and stations sb, sb+1."""
    s_cowl, s_head, s_roof = st(T_COWL), st(T_HEADER), st(T_ROOF_END)
    s_dlo = st(REAR_ARCH_T[3])
    s_glass_end = st(REAR_ARCH_T[4])
    s_cover_end = st(REAR_ARCH_T[8])
    if rb <= 1:
        if s_cowl <= sb < s_head:
            return 'glass_ws', 'windscreen'
        if s_head <= sb < s_roof:
            return 'accent', 'roof'
        if s_roof <= sb < s_glass_end:
            return 'glass_rear', 'backlight'
        if s_glass_end <= sb < s_cover_end:
            return 'cover', 'cover'
        if 1 <= sb < s_cowl:
            return 'paint', 'bonnet'
        return 'paint', 'front' if sb < s_cowl else 'tail'
    if rb == 2:
        if s_cowl <= sb < s_roof:
            return 'accent', 'roof'
        if 1 <= sb < s_cowl:
            return 'paint', 'bonnet'
        return 'paint', 'front' if sb < s_cowl else 'rearwing'
    if rb == 3:
        if s_cowl <= sb < s_dlo:
            return 'glass_side', 'sideglass'
        return 'paint', 'frontwing' if sb < s_cowl else 'rearwing'
    # rb 4, 5: the shoulder
    return 'paint', side_panel(sb)


def side_panel(sb):
    if sb < 1:
        return 'front'
    if sb < st(T_DOOR_FRONT):
        return 'frontwing'
    if sb < st(T_DOOR_REAR):
        return 'door'
    if sb < NS - 2:
        return 'rearwing'
    return 'tail'


def side_zone(sb, lb):
    """Wall face between stations sb, sb+1 and loops lb, lb+1."""
    arch = (sb in FRONT_ARCH_S and sb + 1 in FRONT_ARCH_S) or (sb in REAR_ARCH_S and sb + 1 in REAR_ARCH_S)
    if lb == 4:
        return 'under', 'under'
    if lb == 3 and not arch and st(FRONT_ARCH_T[-1]) <= sb < st(REAR_ARCH_T[0]):
        return 'carbon', 'sill'
    if lb == 3 and sb < FRONT_ARCH_S[0]:
        return 'carbon', 'splitter'       # the splitter runs round the corner and dies into the arch
    if lb == 3 and sb >= REAR_ARCH_S[-1]:
        return 'carbon', 'diffuser'
    if lb == 0 and sb == 0:
        return 'lamp_head', 'lamp_head'
    if lb == 1 and sb == NS - 2:
        return 'lamp_tail', 'lamp_tail'
    return 'paint', side_panel(sb)


def front_zone(cb, lb):
    """Front fascia face between the columns under rows cb, cb+1 and loops lb, lb+1."""
    if lb == 4:
        return 'under', 'under'
    if lb == 3:
        return 'carbon', 'splitter'
    if lb == 0 and cb >= 3:
        return 'lamp_head', 'lamp_head'
    return 'paint', 'front'


def rear_zone(cb, lb):
    if lb == 4:
        return 'under', 'under'
    if lb == 3:
        return 'carbon', 'diffuser'
    if lb == 1:
        return 'lamp_tail', 'lamp_tail'
    return 'paint', 'tail'


# Wall column index (the u of the cage address) of a front column, a side station, a rear column.
def u_front(c):
    return c


def u_side(s):
    return ROWS - 1 + s


def u_rear(c):
    return NS + 2 * ROWS - 3 - c


LID_V = 10      # cage address of a lid face: (station, LID_V + row); of a wall face: (column, loop)


def pockets():
    """Recessed openings: cage faces that are pushed into the body.
    faces, lip width, push, colour of the lip; support = a ring cut first that keeps the surface around the
    opening where it was (and makes the opening smaller than its cage faces); floor = zone of the floor."""
    s_door = st(T_DOOR_REAR)
    return [
        # the two big intakes in the nose
        dict(faces=[('W', u_front(c), 2) for c in (1, 2, 3, 4)], lip=0.014, push=(0.0, -0.13, 0.0), lip_zone='paint'),
        # the mesh panel across the tail
        dict(faces=[('W', u_rear(c) - 1, 2) for c in (0, 1, 2)], lip=0.012, push=(0.0, 0.115, 0.0), lip_zone='paint'),
        # the engine intake behind the door
        dict(faces=[('W', u_side(s_door), 1), ('W', u_side(s_door), 2)], lip=0.008, push=(-0.045, -0.16, 0.0), lip_zone='paint',
             support=0.018),
        # the outlet in the bonnet: a slatted panel set a little below the surface
        dict(faces=[('L', s, 1) for s in range(st(FRONT_ARCH_T[1]), st(FRONT_ARCH_T[5]))], lip=0.009, push=(0.0, 0.0, -0.012),
             lip_zone='paint', support=0.060, floor='cover'),
    ]


# ── cage ─────────────────────────────────────────────────────────────────────────────────────

def lid_points():
    """P[r][s] for the right half."""
    rows = []
    for r in range(ROWS):
        corners = LID_CORNERS.get(r, ())
        cx = Curve([(t, pts[r][0]) for t, pts in LID])
        cy = Curve([(t, pts[r][1]) for t, pts in LID], corners)
        cz = Curve([(t, pts[r][2]) for t, pts in LID], corners)
        rows.append([Vector((cx(t), cy(t), cz(t))) for t in T])
    return rows


def side_column(s, top):
    """Loops 1..5 of the wall under the shoulder point `top` at station s."""
    t = T[s]
    if s in FRONT_ARCH_S:
        by, bz = FRONT_ARCH[s - FRONT_ARCH_S[0]]
        arch = True
    elif s in REAR_ARCH_S:
        by, bz = REAR_ARCH[s - REAR_ARCH_S[0]]
        arch = True
    else:
        by, bz = t + BOTTOM_DY(t), BOTTOM_Z(t)
        arch = False
    out = []
    for l in (1, 2, 3):
        f = SIDE_F[l](t)
        out.append(Vector((SIDE_X[l](t), top.y + (by - top.y) * f + (0.0 if arch else SIDE_DY[l](t)), top.z + (bz - top.z) * f)))
    x4 = SIDE_X[4](t)
    out.append(Vector((x4, by, bz)))
    if arch:
        out.append(Vector((x4 - ARCH_LIP, by, bz)))
    else:
        out.append(Vector((x4 - UNDER_TUCK, by, bz - 0.022)))
    return out


def edge_crease(e, where, zone_l):
    """How sharp a cage edge stays (0 = fully smooth)."""
    a, b = where.get(e.verts[0]), where.get(e.verts[1])
    if a is None or b is None:
        return 0.0
    w = 0.0
    zones = [ZONES[f[zone_l]] for f in e.link_faces]
    if len(zones) == 2 and zones[0] != zones[1]:
        if zones[0] in GLASS or zones[1] in GLASS:
            w = max(w, 0.30)
        if 'lamp_head' in zones:
            w = max(w, 0.35)
        if 'lamp_tail' in zones:
            w = max(w, 0.45)          # the lamp bar stands over the face below it
        if 'carbon' in zones:
            w = max(w, 0.40)
    if a[0] == 'L' and b[0] == 'L' and a[1] == b[1]:
        if a[1] == 2 and max(a[2], b[2]) <= st(T_COWL):
            w = max(w, 0.30)          # the two lines on the bonnet
        if a[1] == 3 and min(a[2], b[2]) >= st(T_ROOF_END):
            w = max(w, 0.25)          # ridge from the roof to the tail
        if a[1] == 4 and max(a[2], b[2]) <= st(1.0):
            w = max(w, 0.22)          # crown of the front wing
    if a[0] == 'W' and b[0] == 'W' and a[2] == 1 and b[2] == 1:
        lo_c, hi_c = u_side(st(T_DOOR_FRONT)), u_side(st(T_DOOR_REAR))
        if lo_c <= min(a[1], b[1]) and max(a[1], b[1]) <= hi_c:
            w = max(w, 0.45)          # the character line along the door
    if a[0] == 'W' and b[0] == 'W' and a[2] == 4 and b[2] == 4:
        w = max(w, 0.60)              # bottom edge of the body and the lips of the wheel arches
        if max(a[1], b[1]) <= ROWS - 1:
            w = max(w, 0.80)          # the splitter's leading edge
    if a[0] == 'L' and b[0] == 'L' and a[2] == NS - 1 and b[2] == NS - 1:
        w = max(w, 0.55)              # trailing edge of the tail
    return w


def pocket(bm, faces, layers, lip, push, lip_zone, wall=0.004, support=0.0, floor='mesh'):
    """Turn cage faces into a recess: a lip, walls, and the floor pushed by `push`."""
    zone_l, panel_l, crease_l = layers
    region = set(faces)
    if support > 0:
        # the ring this leaves around the opening keeps the zone and panel of the faces it is cut from
        bmesh.ops.inset_region(bm, faces=faces, thickness=support, depth=0.0, use_even_offset=True, use_boundary=False)
    ring1 = set(bmesh.ops.inset_region(bm, faces=faces, thickness=lip, depth=0.0, use_even_offset=True, use_boundary=False)['faces'])
    ring2 = set(bmesh.ops.inset_region(bm, faces=faces, thickness=wall, depth=0.0, use_even_offset=True, use_boundary=False)['faces'])
    for f in ring1:
        f[zone_l] = ZONES.index(lip_zone)
        f[panel_l] = NO_PANEL
    for f in ring2:
        f[zone_l] = ZONES.index('duct')
        f[panel_l] = NO_PANEL
    for f in region:
        f[zone_l] = ZONES.index(floor)
        f[panel_l] = NO_PANEL
    for v in set(v for f in region for v in f.verts):
        d = Vector(push)
        if abs(v.co.x) < 1e-6:
            d.x = 0.0
        v.co += d
    for e in set(e for f in ring1 for e in f.edges):
        fs = set(e.link_faces)
        if fs & ring2:
            e[crease_l] = 0.55                      # the mouth
        elif not fs <= ring1:
            e[crease_l] = max(e[crease_l], 0.20)    # where the lip starts
    for e in set(e for f in ring2 for e in f.edges):
        if set(e.link_faces) & region:
            e[crease_l] = 0.60                      # the floor


def build_cage():
    """The control cage of the whole skin as a bmesh, with zone / panel / address layers and seams."""
    P = lid_points()
    bm = bmesh.new()
    zone_l = bm.faces.layers.int.new('zone')
    panel_l = bm.faces.layers.int.new('panel')
    crease_l = bm.edges.layers.float.new('crease_edge')
    uv_l = bm.loops.layers.uv.new('cage')
    panels = {}
    cage_face = {}

    def panel_id(name):
        return panels.setdefault(name, len(panels))

    lid_v = [[bm.verts.new(P[r][s]) for s in range(NS)] for r in range(ROWS)]
    where = {}                        # vertex -> ('L', row, station) or ('W', column, loop)
    for r in range(ROWS):
        for s in range(NS):
            where[lid_v[r][s]] = ('L', r, s)

    def face(vs, zone, panel, uvs, key):
        f = bm.faces.new(vs)
        f[zone_l] = ZONES.index(zone)
        f[panel_l] = panel_id(panel)
        f.smooth = True
        for loop, uv in zip(f.loops, uvs):
            loop[uv_l].uv = uv
        cage_face[key] = f
        return f

    for r in range(ROWS - 1):
        for s in range(NS - 1):
            z, p = lid_zone(r, s)
            v0 = LID_V + r
            face([lid_v[r][s], lid_v[r][s + 1], lid_v[r + 1][s + 1], lid_v[r + 1][s]], z, p,
                 [(s, v0), (s + 1, v0), (s + 1, v0 + 1), (s, v0 + 1)], ('L', s, r))

    # wall columns in order around the half car: front centre -> corner -> side -> corner -> rear centre
    cols = []
    for c in range(ROWS):
        cols.append([lid_v[c][0]] + [bm.verts.new(Vector(p)) for p in FRONT[c]])
    for s in range(1, NS - 1):
        cols.append([lid_v[ROWS - 1][s]] + [bm.verts.new(p) for p in side_column(s, P[ROWS - 1][s])])
    for c in range(ROWS - 1, -1, -1):
        cols.append([lid_v[c][NS - 1]] + [bm.verts.new(Vector(p)) for p in REAR[c]])

    for i, colv in enumerate(cols):
        for l in range(1, LOOPS):
            where[colv[l]] = ('W', i, l)

    n_front = ROWS - 1                # faces of the front fascia (per half)
    n_side = NS - 1
    for i in range(len(cols) - 1):
        for l in range(LOOPS - 1):
            if i < n_front:
                z, p = front_zone(i, l)
            elif i < n_front + n_side:
                z, p = side_zone(i - n_front, l)
            else:
                z, p = rear_zone(ROWS - 2 - (i - n_front - n_side), l)
            face([cols[i][l], cols[i + 1][l], cols[i + 1][l + 1], cols[i][l + 1]], z, p,
                 [(i, l), (i + 1, l), (i + 1, l + 1), (i, l + 1)], ('W', i, l))

    for e in bm.edges:
        w = edge_crease(e, where, zone_l)
        if w > 0:
            e[crease_l] = w

    for pk in pockets():
        pocket(bm, [cage_face[k] for k in pk['faces']], (zone_l, panel_l, crease_l), pk['lip'], pk['push'], pk['lip_zone'],
               support=pk.get('support', 0.0), floor=pk.get('floor', 'mesh'))

    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    bmesh.ops.mirror(bm, geom=geom, axis='X', merge_dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.faces.ensure_lookup_table()
    roof = max(bm.faces, key=lambda f: f.calc_center_median().z)
    if roof.normal.z < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    for e in bm.edges:
        e.seam = False
        if len(e.link_faces) == 2:
            a, b = e.link_faces
            if a[panel_l] != NO_PANEL and b[panel_l] != NO_PANEL and a[panel_l] != b[panel_l] \
                    and ZONES[a[zone_l]] in PANEL_ZONES and ZONES[b[zone_l]] in PANEL_ZONES:
                e.seam = True
    return bm, panels


def subdivide(bm, name, col, levels=SUBDIV):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    obj = bpy.data.objects.new(name, me)
    util.link(obj, col)
    m = util.add_modifier(obj, 'SUBSURF', 'Subdivision')
    m.levels = levels
    m.render_levels = levels
    m.subdivision_type = 'CATMULL_CLARK'
    m.boundary_smooth = 'ALL'
    util.apply_modifiers(obj)
    return obj


# ── after subdividing ────────────────────────────────────────────────────────────────────────

GAP_HALF_WIDTH = 0.0028
GAP_DEPTH = 0.006


def cut_shut_lines(obj):
    """A narrow dark groove along every seam: the gaps between the panels."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    zone_l = bm.faces.layers.int['zone']
    seams = [e for e in bm.edges if e.seam]
    if seams:
        r = bmesh.ops.bevel(bm, geom=seams, offset=GAP_HALF_WIDTH, offset_type='OFFSET', segments=2, profile=1.0,
                            affect='EDGES', clamp_overlap=True, loop_slide=True)
        new_faces = set(r['faces'])
        bm.normal_update()
        mids = set(v for f in new_faces for v in f.verts if all(lf in new_faces for lf in v.link_faces))
        for v in mids:
            v.co -= v.normal * GAP_DEPTH
        gap = ZONES.index('gap')
        for f in new_faces:
            f[zone_l] = gap
    bm.normal_update()
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return len(seams)


def cut_louvres(obj):
    """Slots across the engine cover."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    zone_l = bm.faces.layers.int['zone']
    uv_l = bm.loops.layers.uv['cage']
    cover = ZONES.index('cover')
    slots = []
    for f in bm.faces:
        if f[zone_l] != cover:
            continue
        u, v = _address(f, uv_l)
        k = (u % 1.0) * 4.0
        if int(k) in (1, 3):
            slots.append(f)
    if slots:
        walls = bmesh.ops.inset_region(bm, faces=slots, thickness=0.0035, depth=-0.016, use_even_offset=True, use_boundary=True)['faces']
        for f in walls:
            f[zone_l] = ZONES.index('duct')
        for f in slots:
            f[zone_l] = ZONES.index('mesh')
    bm.normal_update()
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return len(slots)


def assign_materials(obj, ctx):
    """Turn the zone attribute into material slots."""
    me = obj.data
    names = []
    for z in ZONES:
        m = ZONE_MATERIAL[z]
        if m not in names:
            names.append(m)
    for n in names:
        me.materials.append(ctx.mat(n))
    zone = me.attributes['zone'].data
    idx = [names.index(ZONE_MATERIAL[ZONES[zone[i].value]]) for i in range(len(me.polygons))]
    me.polygons.foreach_set('material_index', idx)
    me.update()


def _address(f, uv_l):
    n = len(f.loops)
    return sum(l[uv_l].uv.x for l in f.loops) / n, sum(l[uv_l].uv.y for l in f.loops) / n


def extract(skin, keep):
    """bmesh with a copy of the skin faces for which keep(zone name, u, v, face) is true."""
    bm = bmesh.new()
    bm.from_mesh(skin.data)
    zone_l = bm.faces.layers.int['zone']
    uv_l = bm.loops.layers.uv['cage']
    kill = []
    for f in bm.faces:
        u, v = _address(f, uv_l)
        if not keep(ZONES[f[zone_l]], u, v, f):
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    return bm


def lamp(ctx, skin, zone, name, depth, rule, mats, wall=0.003):
    """What is seen through a lamp's lens: a dark bucket with glowing strips on its floor."""
    bm = extract(skin, lambda z, u, v, f: z == zone)
    uv_l = bm.loops.layers.uv['cage']
    faces = bm.faces[:]
    walls = set(bmesh.ops.inset_region(bm, faces=faces, thickness=wall, depth=-depth, use_even_offset=True, use_boundary=True)['faces'])
    lit = {}
    for f in bm.faces:
        if f in walls:
            f.material_index = 0
            continue
        u, v = _address(f, uv_l)
        c = f.calc_center_median()
        m = rule(u, v, c.x)
        f.material_index = mats.index(m)
        if m != mats[0]:
            lit.setdefault((m, c.x < 0), []).append(c.copy())
    obj = util.object_from_bmesh(name, bm, ctx.col, [ctx.mat(m) for m in mats])
    bm.free()
    util.shade(obj, True, 40)
    util.set_parent(obj, skin)
    return obj, lit


def head_rule(u, v, x):
    side = 'headlight_L' if x < 0 else 'headlight_R'
    if v < 0.25:
        return side                                   # the brow: daytime running light
    if 0.5 < v < 0.75:
        k = (u - 3.5) * 2.0
        if 0 <= k < 4 and (k % 1.0) < 0.5:
            return side                               # four beam units
    if v > 0.75 and u > 5.5:
        return 'signal'
    return 'paint_accent'


def tail_rule(u, v, x):
    outer = u < u_rear(ROWS - 1) + 1                  # the cage face at the corner and the one on the body side
    if 1.25 < v < 1.5:
        return 'taillight'                            # the bar across the car
    if 1.5 < v < 1.75 and outer:
        return 'taillight'
    if v > 1.75 and outer:
        return 'signal'
    return 'paint_accent'


def _mean(points):
    c = Vector((0, 0, 0))
    for p in points:
        c += p
    return c / max(1, len(points))


def headliner(ctx, skin):
    """Inside of the roof and pillars, so that the cabin is closed when seen through the glass."""
    s0, s1 = st(T_COWL), st(T_ROOF_END)
    bm = extract(skin, lambda z, u, v, f: z in ('accent', 'gap') and v >= LID_V and s0 <= u <= s1)
    bm.normal_update()
    for v in bm.verts:
        v.co -= v.normal * 0.012
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    obj = util.object_from_bmesh('BodyHeadliner', bm, ctx.col, [ctx.mat('interior')])
    bm.free()
    util.set_parent(obj, skin)
    return obj


LINER_IN_FRONT = 0.50     # inner wall of the wheel houses (x); the front one leaves room for the steered wheel
LINER_IN_REAR = 0.66
FLOOR_END_Y = -1.70       # the flat floor ends here; behind it the roof of the diffuser tunnel rises


def wheel_houses(ctx, skin):
    """Dark tubs behind the wheel arches.  They face the wheel (the game draws one side only) and are kept
    under the skin: over the front wheel the bonnet is lower than the arch."""
    from mathutils.bvhtree import BVHTree
    sbm = bmesh.new()
    sbm.from_mesh(skin.data)
    tree = BVHTree.FromBMesh(sbm)

    def under_skin(x, y, z):
        if z <= S.HUB_Z + 0.05:
            return z
        hit = tree.ray_cast(Vector((x, y, S.HUB_Z)), Vector((0.0, 0.0, 1.0)))
        if hit[0] is None:
            return z
        return min(z, hit[0].z - 0.018)

    bm = bmesh.new()
    n = 26
    for front in (True, False):
        hub_y = S.FRONT_AXLE_Y if front else S.REAR_AXLE_Y
        r_out = (S.ARCH_R_F if front else S.ARCH_R_R) + 0.012
        x_out = (0.988 if front else 1.010) - ARCH_LIP + 0.012
        x_in = LINER_IN_FRONT if front else LINER_IN_REAR
        # the front tub narrows towards the middle of the car: room for the steered tyre, none wasted under the bonnet
        xs = [x_out, 0.80, 0.65, x_in] if front else [x_out, 0.84, x_in]
        r_in = r_out - 0.032 if front else r_out
        a0 = math.radians(-30 if front else -28)   # the tub ends at the bottom line of the body
        # the rear tub stops where the arch stops: the body is open behind the rear wheel
        a1 = math.radians(210) if front else math.pi + math.asin((S.HUB_Z - REAR_ARCH_END_Z) / r_out)
        for sign in (1, -1):
            rings = []
            for x in xs:
                r = r_out if x >= 0.75 else r_out + (r_in - r_out) * (0.75 - x) / (0.75 - x_in)
                ring = []
                for i in range(n + 1):
                    a = a0 + (a1 - a0) * i / n
                    y, z = hub_y + r * math.cos(a), S.HUB_Z + r * math.sin(a)
                    ring.append(bm.verts.new((sign * x, y, under_skin(sign * x, y, z))))
                rings.append(ring)
            hub = bm.verts.new((sign * x_in, hub_y, S.HUB_Z))
            new = []
            for k in range(len(rings) - 1):
                for i in range(n):
                    new.append(bm.faces.new((rings[k][i], rings[k + 1][i], rings[k + 1][i + 1], rings[k][i + 1])))
            for f in new:                      # the drum looks at the axle
                c = f.calc_center_median()
                f.normal_update()
                if f.normal.y * (c.y - hub_y) + f.normal.z * (c.z - S.HUB_Z) > 0:
                    f.normal_flip()
            for i in range(n):                 # the inner wall looks outwards, at the wheel
                f = bm.faces.new((rings[-1][i], hub, rings[-1][i + 1]))
                f.normal_update()
                if f.normal.x * sign < 0:
                    f.normal_flip()
    sbm.free()
    obj = util.object_from_bmesh('BodyWheelHouses', bm, ctx.col, [ctx.mat('grille')])
    bm.free()
    util.shade(obj, True, 50)
    util.set_parent(obj, skin)
    return obj


def under_floor(ctx, skin, P):
    """Flat floor between the turned-under edges of the skin, from the nose to the mouth of the diffuser tunnel."""
    ribs = [(p[4][1], p[4][0], p[4][2]) for p in FRONT]
    for s in range(1, NS - 1):
        col = side_column(s, P[ROWS - 1][s])
        if col[4].y < FLOOR_END_Y:
            break
        if s in FRONT_ARCH_S:
            ribs.append((col[4].y, LINER_IN_FRONT, 0.140))
        elif s in REAR_ARCH_S:
            ribs.append((col[4].y, LINER_IN_REAR, 0.160))
        else:
            ribs.append((col[4].y, col[4].x, col[4].z))
    ribs.append((FLOOR_END_Y, LINER_IN_REAR, 0.164))
    verts, faces = [], []
    for y, x, z in ribs:
        verts += [(-x, y, z + 0.004), (0.0, y, z + 0.004), (x, y, z + 0.004)]
    for k in range(len(ribs) - 1):
        a = 3 * k
        faces.append((a, a + 1, a + 4, a + 3))
        faces.append((a + 1, a + 2, a + 5, a + 4))
    obj = util.mesh_object('BodyFloor', verts, faces, ctx.col, [ctx.mat('trim')])
    util.weld(obj)
    util.shade(obj, False)
    util.set_parent(obj, skin)
    return obj


# ── the tail panel: twin centre exhaust in one housing, a blade to each side ─────────────────
EXHAUST = (0.098, -2.137, 0.676)      # centre of the right tail pipe's mouth
TAIL_Z = EXHAUST[2]
HOUSING_FACE_Y = -2.125               # front face of the exhaust housing (the bumper face is at -2.145 there)
HOUSING_BACK_Y = -2.020               # where it disappears into the mesh


def _oval(a, b, n=32, p=2.5):
    """Rounded outline (superellipse) with half axes a (x) and b (z), counter-clockwise seen from behind."""
    pts = []
    for k in range(n):
        t = 2 * math.pi * k / n
        c, sn = math.cos(t), math.sin(t)
        pts.append((a * math.copysign(abs(c) ** (2 / p), c), b * math.copysign(abs(sn) ** (2 / p), sn)))
    return pts


def _loft(bm, rings, mat, cap=None):
    """Quads between consecutive closed rings of (x, y, z); cap = material index of a fan closing the last ring."""
    vs = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(vs[0])
    out = []
    for i in range(len(vs) - 1):
        for k in range(n):
            f = bm.faces.new((vs[i][k], vs[i][(k + 1) % n], vs[i + 1][(k + 1) % n], vs[i + 1][k]))
            f.material_index = mat
            out.append(f)
    if cap is not None:
        c = Vector((0, 0, 0))
        for v in vs[-1]:
            c += v.co
        cv = bm.verts.new(c / n)
        for k in range(n):
            f = bm.faces.new((vs[-1][k], vs[-1][(k + 1) % n], cv))
            f.material_index = cap
            out.append(f)
    return out


def exhausts(ctx, skin):
    """Two oval pipes side by side in one satin housing in the middle of the tail panel."""
    mats = ['hardware', 'trim', 'grille']
    bm = bmesh.new()
    zc = TAIL_Z

    def ring(a, b, y, cx=0.0, p=2.5, n=32):
        return [(cx + x, y, zc + z) for x, z in _oval(a, b, n, p)]

    # housing: a rounded frame; inside it a dark recess
    A, B, PW = 0.212, 0.064, 4.0
    f_y = HOUSING_FACE_Y
    _loft(bm, [ring(A, B, HOUSING_BACK_Y, p=PW), ring(A, B, f_y + 0.005, p=PW), ring(A - 0.005, B - 0.005, f_y, p=PW),
               ring(A - 0.017, B - 0.017, f_y, p=PW), ring(A - 0.019, B - 0.019, f_y + 0.004, p=PW)], 0)
    _loft(bm, [ring(A - 0.019, B - 0.019, f_y + 0.004, p=PW), ring(A - 0.021, B - 0.021, f_y + 0.026, p=PW)], 1, cap=1)
    # pipes: bright tip, black bore
    a, b = 0.073, 0.037
    for sign in (1, -1):
        cx = sign * EXHAUST[0]
        m = EXHAUST[1]
        _loft(bm, [ring(a, b, f_y + 0.030, cx), ring(a, b, m + 0.004, cx), ring(a - 0.003, b - 0.003, m, cx),
                   ring(a - 0.006, b - 0.006, m + 0.002, cx), ring(a - 0.008, b - 0.008, m + 0.012, cx)], 0)
        _loft(bm, [ring(a - 0.008, b - 0.008, m + 0.012, cx), ring(a - 0.009, b - 0.009, m + 0.120, cx)], 2, cap=2)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = util.object_from_bmesh('BodyExhausts', bm, ctx.col, [ctx.mat(m) for m in mats])
    bm.free()
    util.shade(obj, True, 40)
    util.set_parent(obj, skin)
    return obj


def tail_blades(ctx, skin):
    """A satin blade across the mesh panel to each side of the exhaust housing; its outer part carries the
    reversing lamp."""
    f = (REAR[0][1][2] - TAIL_Z) / (REAR[0][1][2] - REAR[0][2][2])
    face_y = Curve([((REAR[c][1][0] + REAR[c][2][0]) / 2, REAR[c][1][1] + (REAR[c][2][1] - REAR[c][1][1]) * f) for c in range(4)])
    xs = [0.232, 0.29, 0.35, 0.41, 0.47, 0.50, 0.56, 0.62, 0.645]
    lamp = (0.50, 0.62)                      # the reversing lamp sits between these
    th, depth, back = 0.022, 0.075, 0.030
    mats = ['rim_dark', 'reverse']      # satin, not gloss: a gloss blade throws sharp glints at the driving camera
    bm = bmesh.new()
    for sign in (1, -1):
        rings = []
        for x in xs:
            y = face_y(x) + back
            rings.append([bm.verts.new((sign * x, y, TAIL_Z + th / 2)), bm.verts.new((sign * x, y, TAIL_Z - th / 2)),
                          bm.verts.new((sign * x, y + depth, TAIL_Z - th / 2 + 0.006)), bm.verts.new((sign * x, y + depth, TAIL_Z + th / 2 - 0.006))])
        for i in range(len(xs) - 1):
            for k in range(4):
                face = bm.faces.new((rings[i][k], rings[i][(k + 1) % 4], rings[i + 1][(k + 1) % 4], rings[i + 1][k]))
                lit = k == 0 and lamp[0] - 1e-6 <= xs[i] and xs[i + 1] <= lamp[1] + 1e-6
                face.material_index = 1 if lit else 0
        bm.faces.new(rings[0])
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = util.object_from_bmesh('BodyTailBlades', bm, ctx.col, [ctx.mat(m) for m in mats])
    bm.free()
    util.shade(obj, False)
    util.set_parent(obj, skin)
    return obj


def diffuser_fins(ctx, skin):
    """Strakes in the diffuser tunnel: they hang from its roof."""
    th = 0.016
    z_floor = 0.166
    bm = bmesh.new()
    for x in (0.20, 0.42, 0.62):
        # the tunnel roof at this x: from the floor edge up to the lower edge of the bumper
        k = min(range(ROWS - 1), key=lambda c: abs((REAR[c][3][0] + REAR[c + 1][3][0]) / 2 - x))
        w = (x - REAR[k][3][0]) / (REAR[k + 1][3][0] - REAR[k][3][0])
        lip = [REAR[k][3][i] + (REAR[k + 1][3][i] - REAR[k][3][i]) * w for i in range(3)]
        y0, y1 = FLOOR_END_Y - 0.06, lip[1] + 0.028

        def roof(y):
            return z_floor + (lip[2] - z_floor) * (FLOOR_END_Y - y) / (FLOOR_END_Y - lip[1])

        # a band under the roof that grows deeper towards the rear; its top is a little inside the roof: no gap
        pts = [(y0, roof(y0) - 0.030), (y1 - 0.035, roof(y1 - 0.035) - 0.105), (y1, roof(y1) - 0.075),
               (y1, roof(y1) + 0.025), (y0, roof(y0) + 0.020)]
        for sign in (1, -1):
            cx = sign * x
            a = [bm.verts.new((cx - th / 2, y, z)) for y, z in pts]
            b = [bm.verts.new((cx + th / 2, y, z)) for y, z in pts]
            bm.faces.new(a)
            bm.faces.new(list(reversed(b)))
            for i in range(len(pts)):
                j = (i + 1) % len(pts)
                bm.faces.new((a[i], b[i], b[j], a[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = util.object_from_bmesh('BodyDiffuserFins', bm, ctx.col, [ctx.mat('trim')])
    bm.free()
    util.shade(obj, False)
    util.set_parent(obj, skin)
    return obj


def _smooth_path(pts, n):
    """Catmull-Rom through pts, n points per span."""
    P = [Vector(p) for p in pts]
    P = [P[0] * 2 - P[1]] + P + [P[-1] * 2 - P[-2]]
    out = []
    for i in range(1, len(P) - 2):
        for k in range(n):
            t = k / n
            a, b, c, d = P[i - 1], P[i], P[i + 1], P[i + 2]
            out.append(0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t ** 3))
    out.append(P[-2])
    return out


def intake_blades(ctx, skin):
    """A carbon blade across each of the two front intakes."""
    path = _smooth_path([[(a + b) / 2 for a, b in zip(FRONT[c][1], FRONT[c][2])] for c in (1, 2, 3, 4, 5)], 5)
    th, depth, back = 0.009, 0.075, 0.028
    parts = []
    for sign in (1, -1):
        verts, faces = [], []
        for p in path:
            x, y, z = sign * p.x, p.y - back, p.z + 0.004
            verts += [(x, y, z + th / 2), (x, y, z - th / 2), (x, y - depth, z - th / 2), (x, y - depth, z + th / 2)]
        for i in range(len(path) - 1):
            a = 4 * i
            for k in range(4):
                faces.append((a + k, a + (k + 1) % 4, a + 4 + (k + 1) % 4, a + 4 + k))
        o = util.mesh_object('Blade', verts, faces, ctx.col, [ctx.mat('carbon')])
        util.recalc_normals(o)
        parts.append(o)
    obj = util.join(parts, 'BodyIntakeBlades')
    util.shade(obj, True, 50)
    util.set_parent(obj, skin)
    return obj


def box_uv(obj):
    """UV = box projection in metres (the game tiles its procedural detail textures over it)."""
    me = obj.data
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
    uv = me.uv_layers.new(name='UVMap')
    bpy.context.view_layer.update()
    mw = obj.matrix_world
    rot = mw.to_3x3()
    co = [mw @ v.co for v in me.vertices]
    for poly in me.polygons:
        n = rot @ poly.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for li in poly.loop_indices:
            p = co[me.loops[li].vertex_index]
            if ax == 0:
                uv.data[li].uv = (p.y, p.z)
            elif ax == 1:
                uv.data[li].uv = (p.x, p.z)
            else:
                uv.data[li].uv = (p.x, p.y)


def clean(obj):
    """Drop the helper layers of the build."""
    me = obj.data
    for name in ('zone', 'panel', 'crease_edge'):
        a = me.attributes.get(name)
        if a is not None:
            me.attributes.remove(a)


def build(ctx):
    bm, panels = build_cage()
    skin = subdivide(bm, 'Body', ctx.col)
    bm.free()
    n_seams = cut_shut_lines(skin)
    cut_louvres(skin)
    assign_materials(skin, ctx)
    util.shade(skin, True, 38)
    util.set_parent(skin, ctx.root)
    ctx.body = skin

    P = lid_points()
    head, lit_h = lamp(ctx, skin, 'lamp_head', 'BodyHeadlamps', 0.040, head_rule,
                       ['paint_accent', 'headlight_L', 'headlight_R', 'signal'], wall=0.0015)
    tail, lit_t = lamp(ctx, skin, 'lamp_tail', 'BodyTaillamps', 0.030, tail_rule,
                       ['paint_accent', 'taillight', 'signal'])
    extra = [head, tail, headliner(ctx, skin), wheel_houses(ctx, skin),
             under_floor(ctx, skin, P), exhausts(ctx, skin), tail_blades(ctx, skin), diffuser_fins(ctx, skin), intake_blades(ctx, skin)]

    # where the game puts its lights, flares and flames
    hl, hr = _mean(lit_h.get(('headlight_L', True), [])), _mean(lit_h.get(('headlight_R', False), []))
    ctx.anchors['headlightL'] = (hl.x, hl.y + 0.02, hl.z)
    ctx.anchors['headlightR'] = (hr.x, hr.y + 0.02, hr.z)
    tl = [p for p in lit_t.get(('taillight', True), []) if p.x < -0.45]
    tr = [p for p in lit_t.get(('taillight', False), []) if p.x > 0.45]
    a, b = _mean(tl), _mean(tr)
    ctx.anchors['taillightL'] = (a.x, a.y - 0.02, a.z)
    ctx.anchors['taillightR'] = (b.x, b.y - 0.02, b.z)
    ctx.anchors['exhaustL'] = (-EXHAUST[0], EXHAUST[1] - 0.01, EXHAUST[2])
    ctx.anchors['exhaustR'] = (EXHAUST[0], EXHAUST[1] - 0.01, EXHAUST[2])
    # The camera rig puts the bonnet camera 0.62 m ahead of this point and 0.10 m above it: that is
    # just above the base of the windscreen, so the bonnet fills the bottom fifth of the frame.
    ctx.anchors['hoodCam'] = (0.0, 0.45, 0.860)
    # where the door mirrors stand: on the shoulder of the door just behind the corner of the side glass
    ctx.meta['mirror_foot'] = (0.884, 0.635, 0.846)

    # the helper layers (zone, panel, cage address) stay on the skin until build_car.finish_meshes: lib/bay.py and
    # lib/lamps.py still pick faces by them
    lo, hi = util.bounds(skin)
    print(f'[car] body: skin {util.tri_count(skin)} triangles, {n_seams} seam edges, with parts {util.tri_count([skin] + extra)};'
          f' x {lo.x:.3f}..{hi.x:.3f}  y {lo.y:.3f}..{hi.y:.3f}  z {lo.z:.3f}..{hi.z:.3f}')
    return skin
