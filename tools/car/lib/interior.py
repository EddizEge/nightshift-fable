"""
NIGHTSHIFT player car: the cabin.

Everything is generated here from numbers (no model, no part library).  Two objects come out:

  Interior  one mesh, child of the body: tub (floor, footwells, inner sills), the wall behind the seats with
            a parcel shelf, the dashboard (binnacle, instrument cluster, centre screen, vents), the centre
            console, two bucket seats, the door cards, the steering column and the rear-view mirror.
  Steering  the steering wheel alone, child of the root, origin = spec.STEER_CENTRE, the rim in the plane
            perpendicular to the column axis (the game turns it about that axis).

It is seen through tinted glass at night, so the work goes into silhouettes (seat backs and headrests, the
wheel hoop, the dash line) and the glowing screens; nothing is modelled that the camera cannot see.

Blender space: X right, Y forward (nose at +Y), Z up; the driver sits on the left (x < 0).
"""
import math

import bmesh
from mathutils import Matrix, Vector

from . import util

# material slots used while building; the real bpy materials come from ctx.mat(name)
MATS = ['interior', 'interior_accent', 'dashboard', 'trim', 'hardware', 'carbon', 'mirror']
INT, ACC, DASH, TRIM, HW, CARB, MIRR = range(len(MATS))


# ── small maths ──────────────────────────────────────────────────────────────────────────────

def clamp01(t):
    return 0.0 if t < 0 else 1.0 if t > 1 else t


def sstep(e0, e1, x):
    t = clamp01((x - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)


def plateau(v, centre, half, soft):
    """1 inside |v - centre| < half, smooth fall to 0 over `soft`."""
    return 1.0 - sstep(half, half + soft, abs(v - centre))


def catmull_rom(ctrl, per=12):
    pts = [Vector(c) for c in ctrl]
    ext = [pts[0] * 2 - pts[1]] + pts + [pts[-1] * 2 - pts[-2]]
    out = []
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        for k in range(per):
            t = k / per
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t))
    out.append(pts[-1].copy())
    return out


def cumulative(poly):
    cum = [0.0]
    for a, b in zip(poly, poly[1:]):
        cum.append(cum[-1] + (b - a).length)
    return cum


def sample(poly, cum, s):
    """Point and unit tangent at arc length s."""
    s = max(0.0, min(cum[-1], s))
    for i in range(len(cum) - 1):
        if cum[i + 1] >= s:
            seg = cum[i + 1] - cum[i]
            t = (s - cum[i]) / seg if seg > 0 else 0.0
            p = poly[i].lerp(poly[i + 1], t)
            d = (poly[i + 1] - poly[i]).normalized()
            return p, d
    return poly[-1].copy(), (poly[-1] - poly[-2]).normalized()


def pchip(xs, ys):
    """Monotone cubic interpolation through (xs, ys) (no overshoot between keys)."""
    n = len(xs)
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    d = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    m = [0.0] * n
    m[0], m[-1] = d[0], d[-1]
    for i in range(1, n - 1):
        if d[i - 1] * d[i] <= 0:
            m[i] = 0.0
        else:
            w1, w2 = 2 * h[i] + h[i - 1], h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])

    def f(x):
        if x <= xs[0]:
            return ys[0]
        if x >= xs[-1]:
            return ys[-1]
        i = max(k for k in range(n - 1) if xs[k] <= x)
        t = (x - xs[i]) / h[i]
        t2, t3 = t * t, t * t * t
        return ((2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i]
                + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1])
    return f


def rrect(hw, hh, r, nc=3):
    """Rounded rectangle, counter-clockwise (u right, v up), starting at the right middle."""
    r = min(r, hw, hh)
    out = []
    corners = [(hw - r, hh - r, 0), (-hw + r, hh - r, 90), (-hw + r, -hh + r, 180), (hw - r, -hh + r, 270)]
    for cx, cy, a0 in corners:
        for k in range(nc + 1):
            a = math.radians(a0 + 90 * k / nc)
            out.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    # start at the right middle: rotate the list so the first point is the last of the 4th corner
    return out


# ── mesh builder ─────────────────────────────────────────────────────────────────────────────

class Mesh:
    def __init__(self):
        self.v = []
        self.f = []
        self.m = []

    def vert(self, p):
        self.v.append(tuple(p))
        return len(self.v) - 1

    def face(self, idx, mat):
        self.f.append(tuple(idx))
        self.m.append(mat)

    def grid(self, rows, closed=True, mats=INT, cap0=None, cap1=None, c0=None, c1=None):
        """
        Quads between consecutive rows (lists of points of equal length).  `mats`: one slot, a list
        per segment of a row, or a function (row i, segment j) -> slot.  cap0 / cap1: slot of a
        triangle fan closing the first / last row (centre c0 / c1, default the row's average).
        """
        n = len(rows[0])
        base = len(self.v)
        for r in rows:
            assert len(r) == n, (len(r), n)
            for p in r:
                self.v.append(tuple(p))
        segs = n if closed else n - 1
        for i in range(len(rows) - 1):
            for j in range(segs):
                j1 = (j + 1) % n
                a, b = base + i * n + j, base + i * n + j1
                c, d = base + (i + 1) * n + j1, base + (i + 1) * n + j
                if callable(mats):
                    mat = mats(i, j)
                elif isinstance(mats, (list, tuple)):
                    mat = mats[j]
                else:
                    mat = mats
                self.face((a, b, c, d), mat)
        if cap0 is not None:
            self.fan(list(range(base, base + n)), cap0, c0)
        if cap1 is not None:
            last = base + (len(rows) - 1) * n
            self.fan(list(range(last, last + n)), cap1, c1)
        return base

    def fan(self, idx, mat, centre=None):
        if centre is None:
            c = Vector((0, 0, 0))
            for i in idx:
                c += Vector(self.v[i])
            centre = c / len(idx)
        ci = self.vert(centre)
        for k in range(len(idx)):
            self.face((idx[k], idx[(k + 1) % len(idx)], ci), mat[k] if isinstance(mat, (list, tuple)) else mat)

    def prism(self, outline, offset, mat_a, mat_b, mat_side):
        """Flat polygon `outline` (3D points) and its copy moved by `offset`, joined by side quads."""
        off = Vector(offset)
        n = len(outline)
        a = [self.vert(p) for p in outline]
        b = [self.vert(Vector(p) + off) for p in outline]
        self.face(list(reversed(a)), mat_a)
        self.face(b, mat_b)
        for k in range(n):
            k1 = (k + 1) % n
            self.face((a[k], a[k1], b[k1], b[k]), mat_side)

    def transform(self, mat):
        self.v = [tuple(mat @ Vector(p)) for p in self.v]

    def merge(self, other):
        base = len(self.v)
        self.v += other.v
        self.f += [tuple(i + base for i in f) for f in other.f]
        self.m += other.m

    def to_object(self, ctx, name, normals='recalc', ref=None, sharp=40.0, weld=1e-5):
        used = sorted(set(self.m))
        remap = {m: k for k, m in enumerate(used)}
        obj = util.mesh_object(name, self.v, self.f, ctx.col, [ctx.mat(MATS[m]) for m in used],
                               [remap[m] for m in self.m])
        if weld:
            util.weld(obj, weld)
        if normals == 'recalc':
            util.recalc_normals(obj)
        elif normals in ('in', 'out'):
            orient(obj, ref, outward=(normals == 'out'))
        if sharp == 'seams':
            util.shade(obj, True)
            mark_seams(obj)
        else:
            util.shade(obj, True, sharp)
        return obj


def mark_seams(obj, extra_deg=58.0):
    """Hard edges only where the material changes (piping, shell lip) or the form really folds."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    lim = math.radians(extra_deg)
    sharp = []
    for e in bm.edges:
        lf = e.link_faces
        s = len(lf) != 2 or lf[0].material_index != lf[1].material_index or lf[0].normal.angle(lf[1].normal, 0) > lim
        sharp.append(bool(s))
    bm.free()
    attr = me.attributes.get('sharp_edge') or me.attributes.new('sharp_edge', 'BOOLEAN', 'EDGE')
    attr.data.foreach_set('value', sharp)
    me.update()


def orient(obj, ref_fn, outward=False):
    """Turn every face towards (or away from) a reference point given per face centre."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    flip = []
    for f in bm.faces:
        c = f.calc_center_median()
        d = (Vector(ref_fn(c)) - c).dot(f.normal)
        if (d < 0 and not outward) or (d > 0 and outward):
            flip.append(f)
    if flip:
        bmesh.ops.reverse_faces(bm, faces=flip)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


# ── envelope (spec numbers) ──────────────────────────────────────────────────────────────────

def half_width(S, z):
    """Inner half width of the cabin at height z (glass leans in above the belt)."""
    if z <= S.BELT_Z:
        return S.CABIN_HALF_W_FLOOR + (z - S.FLOOR_Z) / (S.BELT_Z - S.FLOOR_Z) * (S.CABIN_HALF_W_BELT - S.CABIN_HALF_W_FLOOR)
    return S.CABIN_HALF_W_BELT - (z - S.BELT_Z) / (1.13 - S.BELT_Z) * (S.CABIN_HALF_W_BELT - S.ROOF_HALF_W)


def screen_z(S, y):
    """Height of the windscreen line (centreline) at y."""
    return S.COWL_Z + (S.COWL_Y - y) * (S.HEADER_Z - S.COWL_Z) / (S.COWL_Y - S.HEADER_Y)


# ── seats ────────────────────────────────────────────────────────────────────────────────────
# Sitting surface centre line (y, z): cushion front -> bight -> backrest (about 24 deg) -> headrest.
SEAT_CTRL = [
    (0.115, 0.300), (0.020, 0.292), (-0.120, 0.268), (-0.270, 0.250), (-0.365, 0.252),
    (-0.425, 0.295), (-0.462, 0.390), (-0.505, 0.495), (-0.552, 0.600), (-0.590, 0.700),
    (-0.612, 0.772), (-0.630, 0.848), (-0.640, 0.896),
]
# per control point: half width W, bolster height B, half width of the centre insert P, shell depth T
SEAT_KEYS = [
    (0.228, 0.028, 0.125, 0.062),
    (0.238, 0.050, 0.120, 0.068),
    (0.244, 0.072, 0.116, 0.074),
    (0.245, 0.075, 0.115, 0.076),
    (0.245, 0.064, 0.115, 0.080),
    (0.245, 0.058, 0.115, 0.084),
    (0.249, 0.080, 0.115, 0.085),
    (0.252, 0.092, 0.115, 0.085),
    (0.258, 0.104, 0.113, 0.084),
    (0.266, 0.116, 0.110, 0.080),
    (0.180, 0.060, 0.088, 0.075),
    (0.142, 0.036, 0.076, 0.071),
    (0.136, 0.030, 0.072, 0.068),
]
SEAT_HALF_MATS = [ACC, ACC, INT, INT, INT, INT, INT, CARB, CARB, CARB, CARB, CARB, CARB]


def seat_loop(W, B, P, T):
    """
    Cross-section (u lateral, v towards the occupant), closed loop of 26 points: the dark red centre
    insert, leather bolster rolls tucked into a thin carbon shell with a crisp lip, flat side walls and
    a flat back with defined corners.
    """
    Wb = W - 0.014
    half = [
        (0.0, 0.0),
        (0.5 * P, 0.002),
        (P, 0.0),
        (P + 0.008, 0.012),                        # seam between insert and bolster
        (P + 0.42 * (Wb - P), 0.55 * B),
        (Wb - 0.030, 0.96 * B),
        (Wb - 0.006, B - 0.014),                   # bolster crest
        (W - 0.010, 0.66 * B),                     # leather tucks into the shell
        (W - 0.004, 0.62 * B),                     # carbon lip, inner edge
        (W + 0.004, 0.58 * B),                     # carbon lip, outer edge
        (W + 0.001, -0.96 * T),                    # flat side wall, crisp corner into the back
        (W - 0.012, -T),
        (0.45 * W, -1.04 * T),
        (0.0, -1.05 * T),
    ]
    left = [(-u, v) for (u, v) in reversed(half[1:-1])]
    return half + left


def seat_rows(cx):
    """Rows of the seat (3D points) plus the two cap centres."""
    per = 12
    dense = catmull_rom(SEAT_CTRL, per)
    cum = cumulative(dense)
    L = cum[-1]
    keys_s = [cum[i * per] for i in range(len(SEAT_CTRL))]

    curves = [pchip(keys_s, [k[i] for k in SEAT_KEYS]) for i in range(4)]

    def params(s):
        return [c(s) for c in curves]

    def frame(s):
        p, _ = sample(dense, cum, s)
        a, _ = sample(dense, cum, s - 0.015)
        b, _ = sample(dense, cum, s + 0.015)
        t = (b - a).normalized()
        n = Vector((t.y, -t.x))   # (y, z): normal towards the occupant
        return p, t, n

    def to3(p, n, u, v):
        return Vector((cx + u, p.x + v * n.x, p.y + v * n.y))

    # rows: denser where the section changes quickly (bight, shoulder wings into the headrest)
    def density(s):
        d = 1.0
        d += 1.2 * math.exp(-((s - keys_s[5]) / 0.08) ** 2)
        d += 2.4 * math.exp(-((s - 0.5 * (keys_s[9] + keys_s[10])) / 0.07) ** 2)
        d += 0.8 * math.exp(-((s - L) / 0.10) ** 2)
        return d
    fine = [L * k / 400 for k in range(401)]
    acc = [0.0]
    for a, b in zip(fine, fine[1:]):
        acc.append(acc[-1] + density(0.5 * (a + b)) * (b - a))
    N = 40
    ss = []
    for i in range(N):
        target = acc[-1] * i / (N - 1)
        k = next(k for k in range(len(acc)) if acc[k] >= target - 1e-12)
        if k == 0:
            ss.append(0.0)
        else:
            t = (target - acc[k - 1]) / (acc[k] - acc[k - 1])
            ss.append(fine[k - 1] + (fine[k] - fine[k - 1]) * t)
    main = []
    for s in ss:
        p, t, n = frame(s)
        W, B, P, T = params(s)
        main.append([to3(p, n, u, v) for (u, v) in seat_loop(W, B, P, T)])

    def cap(s, sign, rc, phis=(30.0, 55.0, 74.0, 87.0)):
        """Domed end: the whole section shrinks evenly towards its middle while it moves on along the tangent."""
        p, t, n = frame(s)
        W, B, P, T = params(s)
        loop = seat_loop(W, B, P, T)
        cv = (0.5 * B - 1.05 * T) * 0.5
        out = Vector((0.0, t.x, t.y)) * sign
        rows = []
        for ph in phis:
            phi = math.radians(ph)
            rho = math.cos(phi) ** 0.5
            rows.append([to3(p, n, u * rho, cv + (v - cv) * rho) + out * (rc * math.sin(phi)) for (u, v) in loop])
        return rows, to3(p, n, 0.0, cv) + out * rc

    front_rows, front_c = cap(0.0, -1.0, 0.030)
    top_rows, top_c = cap(L, 1.0, 0.034)
    rows = list(reversed(front_rows)) + main + top_rows
    return rows, front_c, top_c


def build_seat(cx):
    m = Mesh()
    rows, c0, c1 = seat_rows(cx)
    mats = SEAT_HALF_MATS + list(reversed(SEAT_HALF_MATS))
    m.grid(rows, closed=True, mats=mats, cap0=mats, cap1=mats, c0=c0, c1=c1)
    return m


# ── tub: floor, footwells, inner sills ───────────────────────────────────────────────────────

def tub_mesh(S):
    m = Mesh()
    fz = S.FLOOR_Z + 0.005
    y_end = S.COWL_Y + 0.25 - 0.02
    ys = [S.BULKHEAD_Y + 0.045, -0.55, -0.30, -0.05, 0.20, 0.45, 0.58, 0.64, 0.70, 0.76, 0.82, 0.90, 0.98, 1.06, y_end]

    def floor_z(y):
        return fz + 0.27 * sstep(0.78, y_end + 0.02, y)

    rows = []
    for y in ys:
        zt = 0.405 + 0.115 * sstep(0.58, 0.78, y)          # sill top rises to meet the dash in the footwell
        xi = 0.645 - 0.050 * sstep(0.84, 1.10, y)          # footwell narrows ahead of the front wheel houses
        zf = floor_z(y)
        half = [
            (0.745, zt), (xi + 0.023, zt), (xi + 0.006, zt - 0.007), (xi, zt - 0.023),
            (xi, zf + 0.030), (xi - 0.007, zf + 0.009), (xi - 0.025, zf), (0.30, zf),
        ]
        pts = [(-x, z) for (x, z) in half] + [(0.0, zf)] + [(x, z) for (x, z) in reversed(half)]
        rows.append([Vector((x, y, z)) for (x, z) in pts])
    nseg = len(rows[0]) - 1
    mats = [CARB, CARB, CARB, CARB, CARB, INT, INT, INT, INT, INT, INT, CARB, CARB, CARB, CARB, CARB]
    assert len(mats) == nseg
    m.grid(rows, closed=False, mats=mats)
    # front wall of the footwells (under the dash)
    last = rows[-1]
    bottom = last[4:-4]
    top = [Vector((p.x, p.y, 0.52)) for p in bottom]
    m.grid([bottom, top], closed=False, mats=TRIM)
    return m


# ── wall behind the seats and the parcel shelf ───────────────────────────────────────────────

def bulkhead_mesh(S, notch_y):
    m = Mesh()
    yb = S.BULKHEAD_Y + 0.02
    yf = yb + 0.025
    top = 0.700                                   # shelf height
    half = [(0.645, S.FLOOR_Z + 0.005), (0.645, 0.405), (0.750, 0.405), (0.770, 0.560), (0.790, top)]
    outline = [(-x, z) for (x, z) in reversed(half)] + [(x, z) for (x, z) in half]
    # the polygon runs left-top -> left-bottom -> right-bottom -> right-top; prism closes the top edge
    pts = [Vector((x, yf, z)) for (x, z) in outline]
    m.prism(pts, (0, yb - yf, 0), INT, TRIM, INT)
    # shelf: plan outline, deep between and outboard of the seats, notched behind them
    zs0, zs1 = top, top + 0.024
    yn = notch_y
    front_half = [
        (0.000, -0.640), (0.070, -0.640), (0.098, -0.655), (0.110, yn), (0.330, yn - 0.004), (0.630, yn),
        (0.652, -0.672), (0.700, -0.650), (0.770, -0.650), (0.792, -0.665),
    ]
    front = [(-x, y) for (x, y) in reversed(front_half[1:])] + front_half
    plan = front + [(0.792, yb), (-0.792, yb)]
    pts = [Vector((x, y, zs0)) for (x, y) in plan]
    m.prism(pts, (0, 0, zs1 - zs0), TRIM, CARB, CARB)
    return m


# ── dashboard ────────────────────────────────────────────────────────────────────────────────
DASH_PROFILE = [
    (0.935, 0.812), (0.870, 0.835), (0.790, 0.858), (0.710, 0.878), (0.655, 0.890),
    (0.625, 0.888), (0.607, 0.875), (0.601, 0.856), (0.606, 0.837), (0.618, 0.823),
    (0.623, 0.804), (0.6245, 0.792), (0.630, 0.740), (0.642, 0.665), (0.662, 0.600),
    (0.690, 0.555), (0.728, 0.533), (0.800, 0.522), (0.935, 0.522),
]
DRIVER_X = None   # set in build (left seat)


# driver's binnacle: the dash top rises into a brow, the face behind it is recessed into a cavity
BROW_RISE = {2: 0.000, 3: 0.020, 4: 0.033, 5: 0.043, 6: 0.045, 7: 0.041}
CAVITY = {8: (0.034, 0.065), 9: (0.082, 0.077), 10: (0.082, 0.036), 11: (0.0755, 0.008), 12: (0.035, 0.005)}
CAVITY_HALF = 0.150


def dash_section(x, S):
    ax = abs(x)
    e = sstep(0.62, 0.785, ax)                      # rounded ends into the doors
    c = 1.0 - sstep(0.11, 0.22, ax)                 # centre stack flows into the console
    hood = plateau(x, -S.SEAT_X, CAVITY_HALF + 0.012, 0.036)
    cav = plateau(x, -S.SEAT_X, CAVITY_HALF, 0.028)
    pts = []
    for i, (y, z) in enumerate(DASH_PROFILE):
        z += BROW_RISE.get(i, 0.0) * hood
        if i in CAVITY:
            dy, dz = CAVITY[i]
            y += dy * cav
            z += dz * cav
        if 13 <= i <= 15:
            y -= 0.030 * c
        if 15 <= i <= 17:
            z -= 0.025 * c
        if 2 <= i <= 9:
            z -= 0.030 * e * (i - 1) / 8.0
        if 4 <= i <= 16:
            y += 0.040 * e
        # the cabin narrows towards the floor: squeeze the ends of the dash to stay inside
        xs = x * min(1.0, (half_width(S, z) - 0.024) / 0.785)
        pts.append(Vector((xs, y, z)))
    return pts


def dash_mesh(S):
    m = Mesh()
    xd = -S.SEAT_X
    edges = [CAVITY_HALF - 0.004, CAVITY_HALF + 0.014, CAVITY_HALF + 0.030, CAVITY_HALF + 0.048]
    xs = {0.0, 0.065, 0.13, -0.065, -0.13, -0.10, 0.19, 0.235, 0.28, 0.34, 0.40, 0.46, 0.505, 0.55, 0.60,
          0.645, 0.69, 0.73, 0.76, 0.785, -0.645, -0.69, -0.73, -0.76, -0.785, -0.60, xd - 0.075, xd, xd + 0.075}
    for d in edges:
        xs.add(round(xd - d, 4))
        xs.add(round(xd + d, 4))
    xs = sorted(xs)
    rows = [dash_section(x, S) for x in xs]

    def mat(i, j):
        xm = 0.5 * (xs[i] + xs[i + 1])
        if j <= 3:
            return INT
        if j <= 6:
            return CARB
        if j <= 9 and abs(xm - xd) < CAVITY_HALF + 0.03:
            return TRIM                              # inside of the binnacle
        if j <= 7:
            return CARB
        if j == 10:
            return ACC if 0.19 <= xm <= 0.64 else INT
        if j <= 13:
            return INT
        return TRIM

    m.grid(rows, closed=True, mats=mat, cap0=INT, cap1=INT)
    return m


def panel_frame(centre, tilt_deg):
    """Right, up and outward normal of a screen whose face turns `tilt_deg` upwards from facing -Y."""
    a = math.radians(tilt_deg)
    right = Vector((1, 0, 0))
    up = Vector((0, math.sin(a), math.cos(a)))
    nrm = Vector((0, -math.cos(a), math.sin(a)))
    return Vector(centre), right, up, nrm


def screen_mesh(centre, tilt, w, h, depth, items, bezel_mat=TRIM):
    """
    A screen: a dark slab (bezel) whose front face is `centre`, plus emissive shapes 1.5 mm in front.
    items: ('rect', u0, v0, u1, v1) or ('arc', cu, cv, r0, r1, a0_deg, a1_deg, segments) in metres.
    """
    m = Mesh()
    c, R, U, N = panel_frame(centre, tilt)
    # slab with a rounded outline
    out = rrect(w / 2, h / 2, 0.008, 2)
    front = [c + R * u + U * v for (u, v) in out]
    back = [p - N * depth for p in front]
    m.grid([back, front], closed=True, mats=bezel_mat, cap1=bezel_mat, cap0=TRIM, c1=c, c0=c - N * depth)
    lift = N * 0.0015
    for it in items:
        if it[0] == 'rect':
            _, u0, v0, u1, v1 = it
            q = [c + R * u0 + U * v0 + lift, c + R * u1 + U * v0 + lift, c + R * u1 + U * v1 + lift, c + R * u0 + U * v1 + lift]
            ids = [m.vert(p) for p in q]
            m.face(ids, DASH)
        else:
            _, cu, cv, r0, r1, a0, a1, segs = it
            inner, outer = [], []
            for k in range(segs + 1):
                a = math.radians(a0 + (a1 - a0) * k / segs)
                inner.append(c + R * (cu + r0 * math.cos(a)) + U * (cv + r0 * math.sin(a)) + lift)
                outer.append(c + R * (cu + r1 * math.cos(a)) + U * (cv + r1 * math.sin(a)) + lift)
            m.grid([inner, outer], closed=False, mats=DASH)
    return m


def vent_mesh(centre, axis, r):
    """Round air vent: satin metal bezel ring, dark throat, two vanes."""
    m = Mesh()
    a = Vector(axis).normalized()
    u = Vector((1, 0, 0))
    v = a.cross(u).normalized()
    if v.z < 0:
        v = -v
    c = Vector(centre)
    n = 20

    def ring(rad, off):
        return [c + u * (rad * math.cos(2 * math.pi * k / n)) + v * (rad * math.sin(2 * math.pi * k / n)) + a * off for k in range(n)]
    rows = [ring(r * 1.16, -0.012), ring(r * 1.16, 0.002), ring(r * 1.06, 0.006), ring(r * 0.95, 0.004), ring(r * 0.92, -0.020)]
    m.grid(rows, closed=True, mats=lambda i, j: HW if i < 3 else TRIM, cap1=TRIM, c1=c - a * 0.020)
    for dv in (-0.33, 0.33):
        cc = c + v * (r * dv) - a * 0.004
        w = r * 0.86 * math.sqrt(1 - dv * dv)
        m.prism([cc - u * w - v * 0.0025, cc + u * w - v * 0.0025, cc + u * w + v * 0.0025, cc - u * w + v * 0.0025],
                -a * 0.010 + v * 0.004, HW, HW, HW)
    return m


def slot_vent_mesh(centre, tilt, w, h):
    m = Mesh()
    c, R, U, N = panel_frame(centre, tilt)
    outer = [c + R * x + U * y for (x, y) in rrect(w / 2, h / 2, h * 0.45, 2)]
    inner = [c + (p - c) * 0.93 - N * 0.002 for p in outer]
    deep = [c + (p - c) * 0.90 - N * 0.018 for p in outer]
    back = [p - N * 0.012 for p in outer]
    m.grid([back, outer, inner, deep], closed=True, mats=lambda i, j: HW if i < 2 else TRIM, cap1=TRIM, c1=c - N * 0.018)
    for k in (-1, 1):
        cc = c + U * (h * 0.18 * k) - N * 0.006
        hw = w / 2 * 0.86
        m.prism([cc - R * hw - U * 0.002, cc + R * hw - U * 0.002, cc + R * hw + U * 0.002, cc - R * hw + U * 0.002],
                -N * 0.008, HW, HW, HW)
    return m


# ── centre console ───────────────────────────────────────────────────────────────────────────

def console_mesh(S):
    m = Mesh()
    fz = S.FLOOR_Z + 0.005
    ys = [S.BULKHEAD_Y + 0.045, -0.62, -0.40, -0.15, 0.10, 0.28, 0.38, 0.46, 0.53, 0.59, 0.635, 0.66]
    rows = []
    for y in ys:
        zt = 0.352 + 0.025 * sstep(-0.70, 0.25, y) + 0.27 * sstep(0.30, 0.66, y)
        hw = 0.092 - 0.010 * sstep(0.30, 0.66, y)
        half = [(hw + 0.006, fz), (hw + 0.004, fz + 0.05), (hw, zt - 0.030), (hw - 0.006, zt - 0.009), (hw - 0.022, zt)]
        pts = half + [(-x, z) for (x, z) in reversed(half)]
        rows.append([Vector((x, y, z)) for (x, z) in pts])
    m.grid(rows, closed=False, mats=CARB, cap0=CARB)
    # satin-metal framed control island on top (drive selector)
    y0, y1 = 0.02, 0.24
    zt = 0.352 + 0.025 * sstep(-0.70, 0.25, 0.13)
    out = [Vector((u, 0.13 + v, zt - 0.004)) for (u, v) in rrect(0.052, (y1 - y0) / 2, 0.02, 2)]
    top_ring = [Vector((p.x, p.y, zt + 0.010)) for p in out]
    inner = [Vector((p.x * 0.82, 0.13 + (p.y - 0.13) * 0.92, zt + 0.011)) for p in out]
    m.grid([out, top_ring, inner], closed=True, mats=lambda i, j: HW if i == 0 else HW, cap1=TRIM)
    return m


# ── door cards ───────────────────────────────────────────────────────────────────────────────

def door_mesh(S, side):
    m = Mesh()
    ys = [S.BULKHEAD_Y + 0.045, -0.66, -0.52, -0.38, -0.24, -0.12, 0.00, 0.12, 0.24, 0.36, 0.46, 0.55, 0.62, 0.70]
    rows = []
    for y in ys:
        a = plateau(y, 0.20, 0.26, 0.12)          # armrest along the door
        prof = [
            (0.748, 0.396), (0.738, 0.430), (0.729, 0.480), (0.729, 0.540),
            (0.745 - 0.034 * a, 0.572), (0.745 - 0.046 * a, 0.598), (0.749 - 0.040 * a, 0.620),
            (0.763 - 0.020 * a, 0.631), (0.775, 0.640), (0.780, 0.700), (0.788, 0.790),
            (0.795, 0.842), (0.800, 0.868), (0.808, 0.882), (0.814, 0.886),
        ]
        rows.append([Vector((side * x, y, z)) for (x, z) in prof])
    mats = [INT, INT, INT, INT, INT, INT, INT, INT, INT, CARB, INT, TRIM, TRIM, TRIM]
    m.grid(rows, closed=False, mats=mats)
    return m


def door_hardware(S, side):
    """Opening lever (satin metal) and the pull bar on the armrest."""
    m = Mesh()
    # lever, set into the upper door panel ahead of the armrest
    c = Vector((side * 0.781, 0.50, 0.745))
    pts = [c + Vector((0, dy, dz)) for (dy, dz) in rrect(0.055, 0.011, 0.009, 2)]
    m.prism(pts, (-side * 0.010, 0, 0), HW, HW, HW)
    # pull bar along the armrest
    c = Vector((side * 0.712, 0.30, 0.655))
    pts = [c + Vector((0, dy, dz)) for (dy, dz) in rrect(0.080, 0.008, 0.007, 2)]
    m.prism(pts, (-side * 0.012, 0, 0), HW, HW, HW)
    return m


# ── steering column, rear-view mirror ────────────────────────────────────────────────────────

def tube(m, p0, p1, r0, r1, n, mat, caps=True):
    p0, p1 = Vector(p0), Vector(p1)
    ax = (p1 - p0).normalized()
    u = ax.orthogonal().normalized()
    v = ax.cross(u)
    rows = []
    for p, r in ((p0, r0), (p1, r1)):
        rows.append([p + (u * math.cos(2 * math.pi * k / n) + v * math.sin(2 * math.pi * k / n)) * r for k in range(n)])
    m.grid(rows, closed=True, mats=mat, cap0=mat if caps else None, cap1=mat if caps else None, c0=p0, c1=p1)


def column_mesh(S, axis):
    m = Mesh()
    c = Vector(S.STEER_CENTRE)
    a = Vector(axis)
    p0 = c - a * 0.068                       # starts inside the hub's back shell
    p1 = c - a * 0.345                       # ends inside the dash face
    tube(m, p0, c - a * 0.12, 0.028, 0.040, 14, TRIM)
    tube(m, c - a * 0.12, p1, 0.040, 0.046, 14, TRIM)
    return m


def mirror_mesh(S):
    m = Mesh()
    c = Vector((0.0, 0.105, 1.050))
    turn = Matrix.Rotation(math.radians(-6.0), 3, 'Z') @ Matrix.Rotation(math.radians(-8.0), 3, 'X')
    out = rrect(0.118, 0.031, 0.028, 4)

    def ring(scale, dy):
        return [c + turn @ Vector((u * scale, dy, v * scale)) for (u, v) in out]
    rows = [ring(0.80, 0.024), ring(0.97, 0.016), ring(1.0, 0.004), ring(1.0, -0.010), ring(0.94, -0.012), ring(0.93, -0.008)]
    m.grid(rows, closed=True, mats=lambda i, j: TRIM, cap0=TRIM, cap1=MIRR, c0=c + turn @ Vector((0, 0.024, 0)), c1=c + turn @ Vector((0, -0.008, 0)))
    # stem up to the glass
    tube(m, c + Vector((0, 0.020, 0.012)), Vector((0.0, 0.128, 1.093)), 0.008, 0.010, 8, TRIM)
    return m


# ── steering wheel ───────────────────────────────────────────────────────────────────────────

def rim_point(R, th):
    """Rim centre line in the wheel plane: x right, z up; flattened at the bottom (soft clamp)."""
    x, z = R * math.sin(th), R * math.cos(th)
    a, b = 0.128, 0.011
    if z < -a:
        z = -a - b * (1 - math.exp(-(-a - z) / b))
    return Vector((x, 0.0, z))


def steering_mesh(S):
    """Built in the wheel's own frame: x right, z up in the rim plane, -y towards the driver."""
    m = Mesh()
    R = S.STEER_RIM_R
    Y = Vector((0, 1, 0))
    # rim
    ths = [-180 + 360 * i / 56 for i in range(56)] + [-3.2, 3.2]
    ths = sorted(set(round(t, 4) for t in ths))
    rows = []
    for t in ths:
        th = math.radians(t)
        p = rim_point(R, th)
        tg = (rim_point(R, th + 1e-3) - rim_point(R, th - 1e-3)).normalized()
        rad = Vector((-tg.z, 0, tg.x))
        if rad.dot(p) < 0:
            rad = -rad
        grip = math.exp(-((abs(t) - 95) / 28.0) ** 2)
        hr = 0.0165 + 0.0025 * grip
        ha = 0.0140 + 0.0018 * grip
        row = []
        for k in range(12):
            phi = 2 * math.pi * k / 12
            cphi, sphi = math.cos(phi), math.sin(phi)
            # D-shaped: a little fuller on the driver side
            ax = ha * sphi * (1.08 if sphi < 0 else 0.92)
            row.append(p + rad * (hr * cphi) + Y * ax)
        rows.append(row)
    rows.append(rows[0])

    def rim_mat(i, j):
        t0, t1 = ths[i], ths[(i + 1) % len(ths)]
        return ACC if (-3.3 <= t0 <= 3.3 and -3.3 <= t1 <= 3.3) else INT
    m.grid(rows, closed=True, mats=rim_mat)

    # spokes: two drooping side spokes (satin metal) and a bottom spoke (carbon)
    for t, w0, w1, mat in ((-100.0, 0.052, 0.030, HW), (100.0, 0.052, 0.030, HW), (180.0, 0.060, 0.036, CARB)):
        th = math.radians(t)
        q = rim_point(R, th)
        d = Vector((q.x, 0, q.z)).normalized()
        side = Vector((-d.z, 0, d.x))
        srows = []
        for k, f in enumerate((0.0, 0.33, 0.66, 1.0)):
            r = 0.050 + (q.length - 0.010 - 0.050) * f
            yy = 0.036 + (0.004 - 0.036) * (f ** 0.8)
            w = (w0 + (w1 - w0) * f) / 2
            th_ = 0.0085
            c = d * r + Y * yy
            srows.append([c + side * u + Y * v for (u, v) in rrect(w, th_, 0.006, 1)])
        m.grid(srows, closed=True, mats=mat)

    # hub: back shell, satin ring, leather pad
    hub = rrect(0.064, 0.052, 0.030, 3)
    layers = [(0.078, 0.70, TRIM), (0.050, 0.95, TRIM), (0.024, 1.00, HW), (0.017, 1.00, INT), (0.012, 0.955, INT),
              (0.0095, 0.80, INT)]
    hrows = []
    for (yy, sc, _) in layers:
        hrows.append([Vector((u * sc, yy, v * sc - 0.004)) for (u, v) in hub])
    mats_l = [l[2] for l in layers]
    m.grid(hrows, closed=True, mats=lambda i, j: mats_l[i + 1] if i >= 1 else TRIM,
           cap0=TRIM, cap1=INT, c0=Vector((0, 0.078, -0.004)), c1=Vector((0, 0.0075, -0.004)))

    # paddles behind the rim (satin metal)
    blade = [(0.118, 0.044), (0.150, 0.056), (0.192, 0.058), (0.212, 0.040), (0.214, -0.004), (0.198, -0.024), (0.150, -0.022), (0.122, -0.012)]
    for sgn in (-1, 1):
        pts = [Vector((sgn * x, 0.046, z)) for (x, z) in blade]
        if sgn < 0:
            pts = list(reversed(pts))
        m.prism(pts, (0, 0.007, 0), HW, HW, HW)
    return m


# ── assembly ─────────────────────────────────────────────────────────────────────────────────

def steer_axis(S):
    t = math.radians(S.STEER_TILT_DEG)
    return (0.0, -math.cos(t), math.sin(t))


def build(ctx):
    S = ctx.spec
    axis = steer_axis(S)
    parts = []

    # seats (closed solids)
    seat_meshes = [build_seat(sx * S.SEAT_X) for sx in (-1, 1)]
    seats = Mesh()
    for sm in seat_meshes:
        seats.merge(sm)
    # how far back the seat shells reach at shelf height: the shelf is notched behind them
    band = [Vector(p) for p in seats.v if 0.680 <= p[2] <= 0.740 and 0.12 <= abs(p[0]) <= 0.62]
    notch_y = min(p.y for p in band) - 0.012 if band else -0.71
    parts.append(seats.to_object(ctx, 'InteriorSeats', 'recalc', sharp='seams'))

    parts.append(tub_mesh(S).to_object(ctx, 'InteriorTub', 'in', ref=lambda c: (0.0, c.y - 0.15, 0.75), sharp=40.0))
    parts.append(bulkhead_mesh(S, notch_y).to_object(ctx, 'InteriorWall', 'recalc', sharp=40.0))
    parts.append(dash_mesh(S).to_object(ctx, 'InteriorDash', 'recalc', sharp=42.0))
    parts.append(console_mesh(S).to_object(ctx, 'InteriorConsole', 'out', ref=lambda c: (0.0, c.y, S.FLOOR_Z + 0.02) if c.y < 0.70 else (0.0, -1.0, 0.3), sharp=40.0))
    for side in (-1, 1):
        parts.append(door_mesh(S, side).to_object(ctx, 'InteriorDoor', 'in', ref=lambda c: (0.0, c.y, 0.60), sharp=38.0))
        parts.append(door_hardware(S, side).to_object(ctx, 'InteriorDoorHw', 'recalc', sharp=40.0))

    # instrument cluster: tacho arc around the speed block, two side panels
    xc = -S.SEAT_X
    cluster = screen_mesh((xc, 0.690, 0.851), 10.0, 0.280, 0.074, 0.010, [
        ('rect', -0.132, -0.026, -0.062, 0.026),
        *[('arc', 0.0, 0.0, 0.027, 0.034, a0, a0 + 24.0, 3) for a0 in range(-222, 30, 28)],
        ('rect', 0.062, -0.026, 0.132, 0.026),
        ('rect', -0.040, -0.034, 0.040, -0.029),
    ])
    cluster.transform(Matrix.Translation((0, 0, 0)))
    parts.append(cluster.to_object(ctx, 'InteriorCluster', 'recalc', sharp=30.0))
    centre = screen_mesh((0.0, 0.603, 0.752), 16.0, 0.300, 0.112, 0.014, [
        ('rect', -0.140, -0.046, 0.046, 0.046),
        ('rect', 0.056, 0.004, 0.140, 0.046),
        ('rect', 0.056, -0.046, 0.140, -0.006),
    ])
    parts.append(centre.to_object(ctx, 'InteriorScreen', 'recalc', sharp=30.0))
    vents = Mesh()
    for sx in (-1, 1):
        vents.merge(vent_mesh((sx * 0.655, 0.624, 0.770), (0, -0.98, 0.10), 0.034))
    vents.merge(slot_vent_mesh((0.0, 0.613, 0.664), -14.0, 0.250, 0.022))
    parts.append(vents.to_object(ctx, 'InteriorVents', 'recalc', sharp=35.0))
    parts.append(column_mesh(S, axis).to_object(ctx, 'InteriorColumn', 'recalc', sharp=50.0))
    parts.append(mirror_mesh(S).to_object(ctx, 'InteriorMirror', 'recalc', sharp=50.0))

    interior = util.join(parts, 'Interior')
    util.set_parent(interior, ctx.body_parent())

    # steering wheel: built in its own frame, tilted so its axis points from the wheel to the driver
    sw = steering_mesh(S)
    sw.transform(Matrix.Rotation(-math.radians(S.STEER_TILT_DEG), 3, 'X'))
    steering = sw.to_object(ctx, 'Steering', 'recalc', sharp=60.0)
    steering.location = S.STEER_CENTRE
    util.set_parent(steering, ctx.root)
    ctx.meta['steering'] = {'pivot': tuple(S.STEER_CENTRE), 'axis': axis}

    print(f'[car] interior: Interior {util.tri_count(interior)} tris, Steering {util.tri_count(steering)} tris')
    return [interior, steering]
