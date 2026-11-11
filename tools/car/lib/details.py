"""
Door mirrors of the NIGHTSHIFT player car (own design, built from code only).

Each mirror is ONE mesh with material slots, origin at the foot of its stalk on the door (the game
knocks the mirror off by collapsing it about that point):

  housing   flat, wide pod: flat back carrying the glass (faces -Y, rearward), a streamlined cap that
            runs forward (+Y) into a low nose ridge; deep at the inboard end, shallower and slimmer
            outboard, the outer end leaning and swept back a few degrees so the glass looks back
            towards the cabin
            - carbon        the cap (top, front, ends)
            - paint_accent  a thin lower shell under the pod, separated from the cap by a shut line
            - trim          a narrow frame round the glass, the shut line, the bezel of the indicator
            - mirror        the glass, 6 mm back inside the frame
            - signal        a thin amber strip along the upper front edge, wrapping round the outer end
  stalk     one cast blade (paint_accent), 6.5 cm chord at the door tapering to 4.5 cm at the pod, 22 -> 16 mm
            thick, rounded nose and tail; it rises from the door along the door's normal, leans out and back
            (the leading edge sweeps back), and flares into the base plate and into the pod
  gasket    a rubber base plate (trim) with 8 mm corner radii under the blade root; when the body is built
            first it follows the door surface with its edge 1 mm inside the skin

Only the right mirror is modelled; the left one is its exact mirror image (x -> -x).
Blender space: X right, Y forward (nose +Y), Z up, metres.
"""
import math

import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from . import util

# ── housing ──────────────────────────────────────────────────────────────────────────────────
W = 0.212              # span across the car
TOP_IN, TOP_OUT = 0.056, 0.049      # top edge of the glass outline (local v), inboard / outboard
BOT_IN, BOT_OUT = -0.056, -0.034    # bottom edge (rises outboard: the pod slims towards its tip)
P_IN, P_OUT = 4.6, 4.0  # superellipse exponents of the outline (inboard end blunter)
OUT_LEAN = 0.22        # the outboard end leans: its top runs further out than its bottom
DEPTH_IN, DEPTH_OUT = 0.130, 0.092  # back plane -> nose
WALL = 0.012           # straight run of the side walls behind the cap's curvature
END_IN, END_OUT = 0.030, 0.060      # how far the nose ridge stops short of the ends (outer end raked)
NOSE_DROP = 0.026      # the nose ridge sits below the middle of the outline (long upper surface)
NOSE_HALF = 0.0050     # half height of the nose ridge closure
PROF_M, PROF_N = 2.3, 1.35          # cap profile: (forward)^M + (height)^N = 1 (N < 2: leaner than an ellipse)
SWEEP_DEG = 5.0        # outer end swept back: the glass turns towards the driver
OUTER_X = 1.130        # outermost point of the right mirror
BACK_Y = 0.612         # back plane (glass side) at the middle of the span
CENTRE_Z = 1.006       # middle of the outline (the pod sits low over the door: 4 cm lower than the first cut)
M = 48                 # points round the outline (multiple of 4)

# back face, from the outside of the shell inwards: (inset from the outline, forward from the back plane)
GLASS_INSET = 0.0110
GLASS_DEPTH = 0.0075   # glass plane 6 mm behind the face of the frame
FRAME_DEPTH = 0.0015

# cap rings: angle along the profile (0 = side wall, pi/2 = nose)
SIG_A0, SIG_A1 = 1.10, 1.165  # indicator strip between these two rings
SHELL_SPLIT_A = 1.31          # lower shell covers the underside up to this ring
ALPHAS = [0.0, 0.22, 0.45, 0.67, 0.88, SIG_A0, SIG_A1, SHELL_SPLIT_A, 1.44, math.pi / 2]

# ── stalk and gasket ─────────────────────────────────────────────────────────────────────────
STALK_U = -0.035       # where the blade enters the pod (local span coordinate): inboard of the middle
STALK_W = 0.050        # ... and how far in front of the back plane (local)
STALK_DIP = 0.014      # how far the blade's end reaches up inside the pod
CHORD_ROOT, CHORD_TIP = 0.065, 0.045   # blade chord (along the airflow) at the door and at the pod
THICK_ROOT, THICK_TIP = 0.022, 0.016   # blade thickness
GASKET_L, GASKET_W, GASKET_R = 0.098, 0.036, 0.008   # base plate: length, width, corner radius
GASKET_SHIFT = 0.012   # the plate is centred under the blade root (its leading edge is ahead of the foot)
DOOR_N = Vector((0.40, 0.0, 0.917)).normalized()   # normal of the door shoulder at the foot (outwards, up)

MATS = ('carbon', 'paint_accent', 'trim', 'mirror', 'signal')
CARBON, ACCENT, TRIM, GLASS, SIGNAL = range(5)


def _lerp(a, b, t):
    return a + (b - a) * t


def _smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


# ── outline of the glass side (local u = span outwards, v = up) ───────────────────────────────

def _superellipse_samples():
    """M points (a, b) on a unit superellipse, symmetric about both axes, index 0 at (1, 0), CCW.
    Spaced by arc length on the real (stretched) shape, with extra density in the corners."""
    n = 4000
    pts = []
    for k in range(n):
        t = 2 * math.pi * k / n
        c, s = math.cos(t), math.sin(t)
        a = math.copysign(abs(c) ** (2 / P_OUT), c)
        b = math.copysign(abs(s) ** (2 / P_OUT), s)
        pts.append((a, b))
    sx, sy = W / 2, 0.05
    real = [(a * sx, b * sy) for a, b in pts]
    w = []
    for k in range(n):
        p0, p1, p2 = real[k - 1], real[k], real[(k + 1) % n]
        d = math.dist(p1, p2)
        t1 = (p1[0] - p0[0], p1[1] - p0[1])
        t2 = (p2[0] - p1[0], p2[1] - p1[1])
        ang = abs(math.atan2(t1[0] * t2[1] - t1[1] * t2[0], t1[0] * t2[0] + t1[1] * t2[1]))
        w.append(d + 0.034 * ang)
    # resample one quarter (0 .. pi/2) and mirror it so that the loop is exactly symmetric
    q = n // 4
    cum = [0.0]
    for k in range(q):
        cum.append(cum[-1] + w[k])
    m4 = M // 4
    quarter = []
    for j in range(m4 + 1):
        target = cum[-1] * j / m4
        k = 0
        while k < q - 1 and cum[k + 1] < target:
            k += 1
        f = (target - cum[k]) / max(1e-12, cum[k + 1] - cum[k])
        quarter.append((_lerp(pts[k][0], pts[k + 1][0], f), _lerp(pts[k][1], pts[k + 1][1], f)))
    quarter[0] = (1.0, 0.0)
    quarter[-1] = (0.0, 1.0)
    out = []
    for j in range(M):
        quad, r = divmod(j, m4)
        if quad == 0:
            a, b = quarter[r]
        elif quad == 1:
            a, b = quarter[m4 - r]
            a = -a
        elif quad == 2:
            a, b = quarter[r]
            a, b = -a, -b
        else:
            a, b = quarter[m4 - r]
            b = -b
        if a < 0:   # inboard end: same b, blunter curve (exponent P_IN)
            a = -(max(0.0, 1 - abs(b) ** P_IN)) ** (1 / P_IN)
        out.append((a, b))
    return out


def _edges(t):
    """Top and bottom of the outline at span fraction t (0 inboard .. 1 outboard)."""
    top = _lerp(TOP_IN, TOP_OUT, t ** 1.6)
    bot = _lerp(BOT_IN, BOT_OUT, t ** 1.35)
    return top, bot


def _outline_point(a, b, shrink=0.0):
    """(u, v) of normalised (a, b); `shrink` 0..1 pulls it in towards the nose ridge."""
    t = (a + 1) / 2
    top, bot = _edges(t)
    v = (top + bot) / 2 + b * (top - bot) / 2
    u = a * W / 2 + (OUT_LEAN * b * (top - bot) / 2 * a * a if a > 0 else 0.0)
    if shrink > 0:
        end = END_OUT if a >= 0 else END_IN
        uq = a * (W / 2 - end)
        tq = (uq / (W / 2) + 1) / 2
        topq, botq = _edges(tq)
        vq = (topq + botq) / 2 - NOSE_DROP + b * NOSE_HALF
        u = _lerp(u, uq, shrink)
        v = _lerp(v, vq, shrink)
    return u, v


def _depth(u):
    t = min(1.0, max(0.0, (u / (W / 2) + 1) / 2))
    return _lerp(DEPTH_IN, DEPTH_OUT, _smooth(t) * 0.6 + t * 0.4)


def _inward_normals(loop):
    """Unit 2D normals of a closed convex loop, pointing inside."""
    n = len(loop)
    out = []
    for i in range(n):
        p0, p1 = loop[i - 1], loop[(i + 1) % n]
        tx, ty = p1[0] - p0[0], p1[1] - p0[1]
        L = math.hypot(tx, ty) or 1.0
        out.append((-ty / L, tx / L))
    cx = sum(p[0] for p in loop) / n
    cy = sum(p[1] for p in loop) / n
    if sum((cx - p[0]) * q[0] + (cy - p[1]) * q[1] for p, q in zip(loop, out)) < 0:
        out = [(-q[0], -q[1]) for q in out]
    return out


class Frame:
    """Local housing frame (u span outwards, v up, w forward) -> Blender space (right mirror)."""

    def __init__(self, origin, sweep_deg):
        s = math.radians(sweep_deg)
        self.o = Vector(origin)
        self.u = Vector((math.cos(s), -math.sin(s), 0.0))
        self.w = Vector((math.sin(s), math.cos(s), 0.0))
        self.v = Vector((0.0, 0.0, 1.0))

    def __call__(self, u, v, w):
        return self.o + self.u * u + self.v * v + self.w * w


# ── housing ──────────────────────────────────────────────────────────────────────────────────

def _housing_rings():
    """Rings of local (u, v, w) points, each M long, from the glass edge outwards and forwards.
    Returns (outline samples (a, b), rings, kind of each ring)."""
    ab = _superellipse_samples()
    rim = [_outline_point(a, b) for a, b in ab]
    nrm = _inward_normals(rim)

    def inset(d, w):
        return [(p[0] + n[0] * d, p[1] + n[1] * d, w) for p, n in zip(rim, nrm)]

    rings, kinds = [], []
    back = [
        (GLASS_INSET, GLASS_DEPTH, 'glass'),            # edge of the glass
        (GLASS_INSET, FRAME_DEPTH + 0.0008, 'frame'),   # inner wall of the frame
        (GLASS_INSET - 0.0008, FRAME_DEPTH, 'frame'),   # chamfered inner edge of the frame
        (0.0046, FRAME_DEPTH, 'frame'),                 # face of the frame
        (0.0034, 0.0, 'lip'),                           # frame steps up to the shell lip
        (0.0014, 0.0, 'lip'),                           # outer edge of the lip, rounded (1.4 mm)
        (0.0004, 0.0004, 'lip'),
        (0.0, 0.0014, 'wall'),
    ]
    for d, w, k in back:
        rings.append(inset(d, w))
        kinds.append(k)
    # side wall, then the cap towards the nose ridge
    for al in ALPHAS:
        shrink = 1 - math.cos(al) ** (2 / PROF_N)
        fwd = math.sin(al) ** (2 / PROF_M)
        ring = []
        for a, b in ab:
            u, v = _outline_point(a, b, shrink)
            w = WALL + (_depth(u) - WALL) * fwd
            ring.append((u, v, w))
        rings.append(ring)
        kinds.append(('cap', al))
    return ab, rings, kinds


def _build_housing(F, col, mats):
    ab, rings, kinds = _housing_rings()
    bm = bmesh.new()
    vrings = [[bm.verts.new(F(*p)) for p in ring] for ring in rings]

    def band_mat(ri, i):
        """Material of the quad between ring ri and ri+1 at outline segment i."""
        k0, k1 = kinds[ri], kinds[ri + 1]
        a = (ab[i][0] + ab[(i + 1) % M][0]) / 2
        b = (ab[i][1] + ab[(i + 1) % M][1]) / 2
        lower = b < -0.45
        if k0 in ('glass', 'frame'):
            return TRIM
        if isinstance(k1, tuple):
            a0 = k0[1] if isinstance(k0, tuple) else -1
            a1 = k1[1]
            if a > -0.15 and b > -0.35 and abs(a0 - SIG_A0) < 1e-9 and abs(a1 - SIG_A1) < 1e-9:
                return SIGNAL
            if lower and a1 <= SHELL_SPLIT_A + 1e-9:
                return ACCENT
            return CARBON
        return ACCENT if lower else CARBON

    rim_faces = set()       # frame and lip: no shut line is cut through them
    for ri in range(len(vrings) - 1):
        r0, r1 = vrings[ri], vrings[ri + 1]
        for i in range(M):
            j = (i + 1) % M
            f = bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
            f.material_index = band_mat(ri, i)
            if kinds[ri] in ('glass', 'frame', 'lip'):
                rim_faces.add(f)
    # glass: one flat face
    g = bm.faces.new(list(reversed(vrings[0])))
    g.material_index = GLASS
    # nose ridge closure: strips between the top and bottom halves of the last ring
    last = vrings[-1]
    h = M // 2
    for i in range(h):
        a0, a1 = last[i], last[i + 1]
        b0, b1 = last[(M - i) % M], last[M - i - 1]
        if i == 0:
            f = bm.faces.new((a0, a1, b1))
        elif i == h - 1:
            f = bm.faces.new((a0, a1, b0))
        else:
            f = bm.faces.new((a0, a1, b1, b0))
        f.material_index = CARBON
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    _shut_line(bm, rim_faces)
    _signal_lens(bm)
    obj = util.object_from_bmesh('MirrorHousing', bm, col, mats)
    bm.free()
    util.shade(obj, True, 33)
    return obj


def _signal_lens(bm):
    """The indicator strip sits 0.5 mm deep in a fine bezel of the cap."""
    sig = [f for f in bm.faces if f.material_index == SIGNAL]
    if not sig:
        return
    res = bmesh.ops.inset_region(bm, faces=sig, thickness=0.0008, depth=-0.0005, use_even_offset=True)
    for f in res['faces']:
        f.material_index = TRIM


def _shut_line(bm, rim_faces):
    """The joint where the carbon cap meets the lower shell: a 1 mm chamfer in dark rubber reads as
    the gap between the two shells."""
    edges = []
    for e in bm.edges:
        if len(e.link_faces) != 2 or any(f in rim_faces for f in e.link_faces):
            continue
        m0, m1 = e.link_faces[0].material_index, e.link_faces[1].material_index
        if {m0, m1} == {CARBON, ACCENT}:
            edges.append(e)
    if not edges:
        return
    res = bmesh.ops.bevel(bm, geom=edges, offset=0.0005, segments=1, profile=0.5, affect='EDGES',
                          clamp_overlap=True, material=TRIM)
    for f in res.get('faces', []):
        f.material_index = TRIM


# ── stalk ────────────────────────────────────────────────────────────────────────────────────

def _bezier(p0, p1, p2, t):
    return p0 * (1 - t) ** 2 + p1 * (2 * (1 - t) * t) + p2 * t * t


def _bezier_d(p0, p1, p2, t):
    return (p1 - p0) * (2 * (1 - t)) + (p2 - p1) * (2 * t)


def _blade_section(n=16):
    """Closed blade section, chord 1 from the leading edge (x=0) to the trailing edge (x=1), unit thickness:
    a full round nose, the widest point at about 40 % chord, and a trailing edge that is thinner but still
    rounded (a cast arm, not a sharp wing)."""
    pts = []
    for k in range(n):
        ph = 2 * math.pi * k / n
        x = (1 - math.cos(ph)) / 2
        y = 0.5 * math.sin(ph) * (1 - 0.55 * x ** 1.5) / 0.86
        pts.append((x, y))
    return pts


def _build_stalk(foot, top, col, mats, n_door=None):
    n_door = n_door or DOOR_N
    base = foot - n_door * 0.003                    # starts inside the gasket
    ctrl = foot + n_door * 0.032 + Vector((0.012, -0.010, 0.0))
    prof = _blade_section()
    np_ = len(prof)
    ts = [0.0, 0.05, 0.12, 0.22, 0.36, 0.52, 0.68, 0.82, 0.92, 1.0]
    fwd = Vector((0, 1, 0))
    bm = bmesh.new()
    rings = []
    for t in ts:
        p = _bezier(base, ctrl, top, t)
        tan = _bezier_d(base, ctrl, top, t).normalized()
        c = (fwd - tan * fwd.dot(tan)).normalized()       # chord direction (LE forward)
        th = tan.cross(c).normalized()
        # one cast blade: 6.5 cm chord at the door tapering to 4.5 cm at the pod, a fillet into the gasket
        # and into the pod; the trailing edge stays nearly straight, so the leading edge sweeps back
        fl_b = math.exp(-t / 0.06)
        fl_t = math.exp(-(1 - t) / 0.06)
        chord = _lerp(CHORD_ROOT, CHORD_TIP, t) * (1 + 0.16 * fl_b + 0.14 * fl_t)
        thick = _lerp(THICK_ROOT, THICK_TIP, t) * (1 + 0.30 * fl_b + 0.25 * fl_t)
        le = p + c * (chord * 0.66)
        ring = []
        for x, y in prof:
            ring.append(bm.verts.new(le - c * (x * chord) + th * (y * thick)))
        rings.append(ring)
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(np_):
            j = (i + 1) % np_
            f = bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
            f.material_index = ACCENT
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # the open ends are buried in the gasket and in the pod: make sure normals point out of the blade
    mid = rings[len(rings) // 2]
    ctr = sum((v.co for v in mid), Vector()) / len(mid)
    f0 = mid[0].link_faces[0]
    if (f0.calc_center_median() - ctr).dot(f0.normal) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    obj = util.object_from_bmesh('MirrorStalk', bm, col, mats)
    bm.free()
    util.shade(obj, True, 50)
    return obj


# ── gasket ───────────────────────────────────────────────────────────────────────────────────

def _gasket_loop(L, Wd, R, seg=4):
    """Rounded rectangle (length along the car, width across), corner radius R, CCW from the front."""
    loop = []
    for cl, cw, a0 in ((L / 2 - R, Wd / 2 - R, 0.0), (-(L / 2 - R), Wd / 2 - R, 0.5 * math.pi),
                       (-(L / 2 - R), -(Wd / 2 - R), math.pi), (L / 2 - R, -(Wd / 2 - R), 1.5 * math.pi)):
        for k in range(seg + 1):
            ang = a0 + 0.5 * math.pi * k / seg
            loop.append((cl + R * math.cos(ang), cw + R * math.sin(ang)))
    return loop


def _build_gasket(foot, col, mats, n=None, surface=None):
    """Rubber base plate under the blade.  `surface(p)` (if given) returns the door surface point under p along
    -n: the plate then follows the door, its edge sunk 1 mm into the skin."""
    n = n or DOOR_N
    ax_l = Vector((0, 1, 0))
    ax_l = (ax_l - n * ax_l.dot(n)).normalized()      # long axis: along the car
    ax_w = n.cross(ax_l).normalized()
    loop = _gasket_loop(GASKET_L, GASKET_W, GASKET_R)
    # pad levels (inset, height above the door surface); the lowest is 1 mm inside the skin
    levels = [(0.0, -0.0010), (0.0002, 0.0016), (0.0010, 0.0032), (0.0025, 0.0041), (0.0050, 0.0045)]
    cen = foot + ax_l * GASKET_SHIFT
    nrm2 = _inward_normals(loop)
    bm = bmesh.new()
    rings = []
    for d, hgt in levels:
        ring = []
        for (l, w), nn in zip(loop, nrm2):
            q = cen + ax_l * (l + nn[0] * d) + ax_w * (w + nn[1] * d)
            s = surface(q) if surface else None
            ring.append(bm.verts.new((s if s is not None else q) + n * hgt))
        rings.append(ring)
    k = len(loop)
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(k):
            j = (i + 1) % k
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    cap = bm.faces.new(rings[-1])                     # no bottom: it is inside the door
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    cap.normal_update()
    if cap.normal.dot(n) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    for f in bm.faces:
        f.material_index = TRIM
    obj = util.object_from_bmesh('MirrorGasket', bm, col, mats)
    bm.free()
    util.shade(obj, True, 40)
    return obj


# ── assembly ─────────────────────────────────────────────────────────────────────────────────

def build_right(ctx):
    S = ctx.spec
    mats = [ctx.mat(m) for m in MATS]
    foot = Vector(S.MIRROR_FOOT)

    # place the housing so that its outermost point is at OUTER_X
    F0 = Frame((0.0, BACK_Y, CENTRE_Z), SWEEP_DEG)
    _, rings, _ = _housing_rings()
    max_x = max(F0(*p).x for ring in rings for p in ring)
    F = Frame((OUTER_X - max_x, BACK_Y, CENTRE_Z), SWEEP_DEG)

    housing = _build_housing(F, ctx.col, mats)
    _, bot = _edges((STALK_U / (W / 2) + 1) / 2)
    top = F(STALK_U, bot + STALK_DIP, STALK_W)

    # The body says where its door shoulder is (build_car.place_mirrors moves the mirror there afterwards):
    # with the skin at hand the base plate follows the door and the blade rises along the door's real normal.
    n_door, surface, skin_bvh, delta, root = DOOR_N, None, None, Vector(), foot.copy()
    mf = ctx.meta.get('mirror_foot')
    if mf is not None and ctx.body is not None:
        delta = Vector(mf) - foot
        bm = bmesh.new()
        bm.from_mesh(ctx.body.data)
        bm.transform(ctx.body.matrix_world)
        skin_bvh = BVHTree.FromBMesh(bm)
        bm.free()
        loc, nrm, _, _ = skin_bvh.ray_cast(Vector(mf) + DOOR_N * 0.03, -DOOR_N, 0.08)
        if loc is not None:
            n_door = nrm.normalized()
            root = loc - delta

            def surface(q):
                hit = skin_bvh.ray_cast(q + delta + n_door * 0.03, -n_door, 0.08)[0]
                return None if hit is None else hit - delta

    stalk = _build_stalk(root, top, ctx.col, mats, n_door)
    gasket = _build_gasket(root, ctx.col, mats, n_door, surface)

    msg = ''
    if skin_bvh is not None:      # how close the pod and the blade come to the body (the foot itself excepted)
        gaps = []
        for o, skip in ((housing, 0.0), (stalk, 0.012)):
            gap = 1.0
            for v in o.data.vertices:
                p = o.matrix_world @ v.co
                if (p - root).dot(n_door) < skip:          # the blade root stands in the base plate
                    continue
                hit = skin_bvh.find_nearest(p + delta, 0.2)
                if hit[0] is not None:
                    gap = min(gap, hit[3])
            gaps.append(gap)
        msg = (f'; nearest body: pod {gaps[0] * 1000:.0f} mm, blade (12 mm above the door) {gaps[1] * 1000:.0f} mm;'
               f' door normal {tuple(round(c, 3) for c in n_door)}')
    print(f'[car] mirror parts (right): housing {util.tri_count(housing)}, stalk {util.tri_count(stalk)}, '
          f'gasket {util.tri_count(gasket)} tris{msg}')
    obj = util.join([housing, stalk, gasket], 'MirrorR')
    util.apply_modifiers(obj)        # no modifiers are used (bevels are modelled); kept as a guard
    util.set_origin(obj, foot)
    return obj


def build(ctx):
    S = ctx.spec
    right = build_right(ctx)
    left = util.mirrored_copy(right, 'MirrorL', ctx.col)
    fx, fy, fz = S.MIRROR_FOOT
    util.set_origin(left, (-fx, fy, fz))
    for o in (left, right):
        util.set_parent(o, ctx.root)
    lo, hi = util.bounds(right)
    print(f'[car] mirrors: MirrorL {util.tri_count(left)} tris, MirrorR {util.tri_count(right)} tris; '
          f'right mirror x {lo.x:.3f}..{hi.x:.3f}, y {lo.y:.3f}..{hi.y:.3f}, z {lo.z:.3f}..{hi.z:.3f}; '
          f'origin R {tuple(round(c, 4) for c in right.matrix_world.translation)} '
          f'L {tuple(round(c, 4) for c in left.matrix_world.translation)}')
    return [left, right]
