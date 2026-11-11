"""
NIGHTSHIFT traffic vehicles - Blender 4.3 helper library (headless).

Coordinates while building: Blender X = right, Y = forward (front of the vehicle), Z = up,
origin = centre of the footprint on the ground. The glTF exporter (+Y up) turns that into
three.js x = right, y = up, -z = forward, which is what the runtime contract wants.

Surface classes are carried by MATERIAL NAMES: "<class>.<variant>" (see PALETTE). The runtime
merges every primitive into one geometry and turns the name into a per-vertex class id; the
material's base colour / roughness / metalness become per-vertex albedo / roughness / metalness.
A "~nb" suffix keeps a part out of the measured bounding box (mirrors).
"""
import math
import bpy
import bmesh
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

# ───────────────────────────────────────────────────────────── materials

# name -> (linear rgb, roughness, metallic)
PALETTE = {
    'paint.body': ((0.8, 0.8, 0.8), 0.32, 0.0),
    'paint2.body': ((0.8, 0.8, 0.8), 0.32, 0.0),
    'glass.clear': ((0.010, 0.012, 0.014), 0.03, 0.0),
    'glass.tint': ((0.005, 0.006, 0.007), 0.03, 0.0),
    'rubber.tread': ((0.018, 0.018, 0.018), 0.85, 0.0),
    'rubber.wall': ((0.024, 0.024, 0.024), 0.7, 0.0),
    'rubber.seal': ((0.012, 0.012, 0.012), 0.55, 0.0),
    'trim.black': ((0.016, 0.016, 0.017), 0.62, 0.0),
    'trim.gloss': ((0.008, 0.008, 0.009), 0.1, 0.0),
    'trim.grey': ((0.06, 0.062, 0.066), 0.55, 0.0),
    'trim.liner': ((0.010, 0.010, 0.010), 0.92, 0.0),
    'trim.under': ((0.018, 0.018, 0.018), 0.85, 0.0),
    'trim.seam': ((0.003, 0.003, 0.003), 0.8, 0.0),
    'trim.grille': ((0.012, 0.012, 0.013), 0.4, 0.0),
    'trim.red': ((0.30, 0.012, 0.010), 0.4, 0.0),
    'trim.white': ((0.70, 0.70, 0.68), 0.45, 0.0),
    'trim.orange': ((0.85, 0.22, 0.0), 0.45, 0.0),
    'trim.blue': ((0.004, 0.018, 0.13), 0.45, 0.0),
    'trim.mud': ((0.02, 0.02, 0.02), 0.9, 0.0),
    'metal.chrome': ((0.92, 0.92, 0.93), 0.06, 1.0),
    'metal.alu': ((0.86, 0.87, 0.89), 0.24, 1.0),
    'metal.gun': ((0.20, 0.205, 0.215), 0.32, 1.0),
    'metal.steel': ((0.64, 0.645, 0.66), 0.2, 1.0),
    'metal.box': ((0.72, 0.73, 0.75), 0.38, 1.0),
    'metal.dark': ((0.07, 0.07, 0.075), 0.5, 1.0),
    'metal.galv': ((0.52, 0.53, 0.55), 0.42, 1.0),
    'head.lamp': ((0.9, 0.9, 0.92), 0.05, 0.0),
    'drl.lamp': ((0.9, 0.9, 0.92), 0.05, 0.0),
    'tail.lamp': ((0.28, 0.008, 0.008), 0.06, 0.0),
    'brake.lamp': ((0.26, 0.006, 0.006), 0.06, 0.0),
    'ind.lamp': ((0.32, 0.12, 0.01), 0.06, 0.0),
    'markerA.lamp': ((0.40, 0.14, 0.01), 0.1, 0.0),
    'markerR.lamp': ((0.30, 0.01, 0.01), 0.1, 0.0),
    'markerW.lamp': ((0.70, 0.70, 0.70), 0.1, 0.0),
    'lens.red': ((0.16, 0.004, 0.004), 0.05, 0.0),
    'lens.clear': ((0.30, 0.31, 0.33), 0.04, 0.0),
    'lens.smoke': ((0.035, 0.036, 0.04), 0.04, 0.0),
    'plate.white': ((0.78, 0.78, 0.74), 0.35, 0.0),
    'retro.red': ((0.55, 0.01, 0.01), 0.3, 0.0),
    'retro.white': ((0.80, 0.80, 0.78), 0.3, 0.0),
    'retro.yellow': ((0.80, 0.45, 0.0), 0.3, 0.0),
}

_mat_cache = {}


def get_mat(name):
    """Material for a palette name (or palette name + '~nb')."""
    if name in _mat_cache:
        return _mat_cache[name]
    base = name.split('~')[0]
    rgb, rough, metal = PALETTE[base]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    _mat_cache[name] = m
    return m


# ───────────────────────────────────────────────────────────── curves

class Pchip:
    """Monotone cubic (Fritsch-Carlson) interpolation: smooth, never overshoots the keys."""

    def __init__(self, xs, ys):
        assert len(xs) == len(ys) and len(xs) >= 2
        pairs = sorted(zip(xs, ys))
        self.x = [p[0] for p in pairs]
        self.y = [p[1] for p in pairs]
        n = len(self.x)
        h = [self.x[i + 1] - self.x[i] for i in range(n - 1)]
        d = [(self.y[i + 1] - self.y[i]) / h[i] for i in range(n - 1)]
        m = [0.0] * n
        if n == 2:
            m = [d[0], d[0]]
        else:
            m[0] = d[0]
            m[-1] = d[-1]
            for i in range(1, n - 1):
                if d[i - 1] * d[i] <= 0:
                    m[i] = 0.0
                else:
                    w1 = 2 * h[i] + h[i - 1]
                    w2 = h[i] + 2 * h[i - 1]
                    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
        self.m = m
        self.h = h

    def __call__(self, x):
        xs = self.x
        if x <= xs[0]:
            return self.y[0] + self.m[0] * (x - xs[0])
        if x >= xs[-1]:
            return self.y[-1] + self.m[-1] * (x - xs[-1])
        lo, hi = 0, len(xs) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if xs[mid] <= x:
                lo = mid
            else:
                hi = mid
        h = self.h[lo]
        t = (x - xs[lo]) / h
        t2, t3 = t * t, t * t * t
        return ((2 * t3 - 3 * t2 + 1) * self.y[lo] + (t3 - 2 * t2 + t) * h * self.m[lo]
                + (-2 * t3 + 3 * t2) * self.y[hi] + (t3 - t2) * h * self.m[hi])


class Guide:
    """Longitudinal guide curve: keys (u, a, b) -> (a(u), b(u)) with monotone cubic interpolation."""

    def __init__(self, keys):
        us = [k[0] for k in keys]
        self.a = Pchip(us, [k[1] for k in keys])
        self.b = Pchip(us, [k[2] for k in keys])

    def __call__(self, u):
        return self.a(u), self.b(u)


def hermite(p0, p1, m0, m1, t):
    t2, t3 = t * t, t * t * t
    return (p0 * (2 * t3 - 3 * t2 + 1) + m0 * (t3 - 2 * t2 + t)
            + p1 * (-2 * t3 + 3 * t2) + m1 * (t3 - t2))


class Ring:
    """Closed, X-mirrored ring through half-ring control points (first and last on x = 0).
    Sharp control points get one-sided tangents (a crease); others are G1 smooth."""

    def __init__(self, half, sharp, tension=1.0):
        self.K = len(half)
        mir = [Vector((-p.x, p.y, p.z)) for p in reversed(half[1:-1])]
        self.full = list(half) + mir
        fl = list(sharp) + list(reversed(sharp[1:-1]))
        N = len(self.full)
        self.tin, self.tout = [], []
        for i in range(N):
            a, b, c = self.full[i - 1], self.full[i], self.full[(i + 1) % N]
            din, dout = b - a, c - b
            if din.length < 1e-7:
                din = dout.copy()
            if dout.length < 1e-7:
                dout = din.copy()
            uin = din.normalized() if din.length > 1e-9 else Vector((0, 0, 1))
            uout = dout.normalized() if dout.length > 1e-9 else uin
            if fl[i]:
                self.tin.append(uin)
                self.tout.append(uout)
            else:
                t = uin + uout
                t = t.normalized() if t.length > 1e-6 else uout
                self.tin.append(t)
                self.tout.append(t)
        self.tension = tension

    def eval_half(self, t):
        """t in [0, K-1] along the right half."""
        i = min(int(math.floor(t)), self.K - 2)
        f = t - i
        p0, p1 = self.full[i], self.full[i + 1]
        d = (p1 - p0).length * self.tension
        return hermite(p0, p1, self.tout[i] * d, self.tin[i + 1] * d, f)


# ───────────────────────────────────────────────────────────── mesh builder

class MB:
    """Accumulates geometry with per-face material names into one bmesh/object."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.mats = []

    def mi(self, mname):
        if mname not in self.mats:
            self.mats.append(mname)
        return self.mats.index(mname)

    def v(self, co):
        return self.bm.verts.new(co)

    def f(self, vs, mname, smooth=True):
        if len(set(vs)) < 3:
            return None
        if len(set(vs)) < len(vs):
            # collapse duplicated verts (degenerate quad -> triangle)
            seen, out = set(), []
            for x in vs:
                if x not in seen:
                    seen.add(x)
                    out.append(x)
            vs = out
        try:
            face = self.bm.faces.new(vs)
        except ValueError:
            return None
        face.material_index = self.mi(mname)
        face.smooth = smooth
        return face

    def tri_count(self):
        return sum(len(f.verts) - 2 for f in self.bm.faces)

    def to_object(self, recalc=False):
        if recalc:
            bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces[:])
        mesh = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for m in self.mats:
            mesh.materials.append(get_mat(m))
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj


def merge_sorted(*lists, eps=1e-4):
    vals = sorted(v for l in lists for v in l)
    out = []
    for v in vals:
        if not out or v - out[-1] > eps:
            out.append(v)
    return out


# ───────────────────────────────────────────────────────────── loft

def loft(mb, stations, ring_fn, sharp, tsamp, region, offset=None, cap_lo=None, cap_hi=None):
    """Build a closed lofted shell.

    stations: increasing station parameters u (positions along the loft axis).
    ring_fn(u) -> list of half-ring control points (Vector), first/last with x == 0.
    tsamp: increasing ring parameters in [0, K-1] (0 and K-1 included) where vertices are placed.
    region(zone, u, t, side) -> material name, evaluated at face centres; zone 'body', 'lo', 'hi'.
    offset(zone, u, t, side, co) -> Vector | None, per-vertex displacement (recesses).
    cap_lo / cap_hi: {'s': [descending s in (0,1)], 'axis': Vector (outward), 'bulge': float}
      closes the first / last ring by shrinking it toward its centroid.
    """
    n = len(tsamp)
    ts = list(tsamp) + list(reversed(tsamp[1:-1]))
    sides = [1] * n + [-1] * (n - 2)
    M = len(ts)
    rings = []
    rows = []
    for u in stations:
        R = Ring(ring_fn(u), sharp)
        half = [R.eval_half(t) for t in tsamp]
        full = half + [Vector((-p.x, p.y, p.z)) for p in reversed(half[1:-1])]
        rings.append(full)
        row = []
        for j, co in enumerate(full):
            c = co.copy()
            if offset:
                d = offset('body', u, ts[j], sides[j] if 0 < j < n - 1 or j >= n else 0, c)
                if d is not None:
                    c += d
            row.append(mb.v(c))
        rows.append(row)

    def side_of(j):
        return 1 if j < n - 1 else -1

    for i in range(len(stations) - 1):
        um = 0.5 * (stations[i] + stations[i + 1])
        for j in range(M):
            j2 = (j + 1) % M
            tm = 0.5 * (ts[j] + ts[j2])
            q = [rows[i][j], rows[i][j2], rows[i + 1][j2], rows[i + 1][j]]
            c = (q[0].co + q[1].co + q[2].co + q[3].co) * 0.25
            mb.f(q, region('body', um, tm, side_of(j), c))

    def cap(ring, row, spec, zone, u_end):
        C = Vector((0, 0, 0))
        for p in ring:
            C += p
        C /= len(ring)
        axis = spec['axis']
        bulge = spec.get('bulge', 0.0)
        svals = spec['s']
        prev = row
        prev_s = 1.0
        for s in svals:
            cur = []
            for j, p in enumerate(ring):
                co = C + (p - C) * s + axis * (bulge * (1 - s * s))
                if offset:
                    d = offset(zone, s, ts[j], side_of(j), co)
                    if d is not None:
                        co = co + d
                cur.append(mb.v(co))
            sm = 0.5 * (s + prev_s)
            for j in range(M):
                j2 = (j + 1) % M
                tm = 0.5 * (ts[j] + ts[j2])
                q = [prev[j], prev[j2], cur[j2], cur[j]]
                c = (q[0].co + q[1].co + q[2].co + q[3].co) * 0.25
                mb.f(q, region(zone, sm, tm, side_of(j), c))
            prev, prev_s = cur, s
        co = C + axis * bulge
        if offset:
            d = offset(zone, 0.0, 0.0, 0, co)
            if d is not None:
                co = co + d
        cv = mb.v(co)
        for j in range(M):
            j2 = (j + 1) % M
            tm = 0.5 * (ts[j] + ts[j2])
            c = (prev[j].co + prev[j2].co + cv.co) / 3.0
            mb.f([prev[j], prev[j2], cv], region(zone, prev_s * 0.5, tm, side_of(j), c))

    if cap_lo:
        cap(rings[0], rows[0], cap_lo, 'lo', stations[0])
    if cap_hi:
        cap(rings[-1], rows[-1], cap_hi, 'hi', stations[-1])
    return rings


# ───────────────────────────────────────────────────────────── primitives

def _xf(co, m):
    return m @ Vector(co)


def box(mb, center, size, mname, bevel=0.0, m=None, segments=1, smooth=False):
    """Axis-aligned box (optionally bevelled) at center with full size (sx, sy, sz)."""
    cx, cy, cz = center
    sx, sy, sz = size[0] / 2, size[1] / 2, size[2] / 2
    bm = bmesh.new()
    vs = [bm.verts.new((cx + x * sx, cy + y * sy, cz + z * sz))
          for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    idx = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    for q in idx:
        bm.faces.new([vs[i] for i in q])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, segments=segments, profile=0.5, affect='EDGES')
    append_bm(mb, bm, mname, m, smooth)
    bm.free()


def append_bm(mb, bm, mname, m=None, smooth=True, mirror_x=False):
    """Copy a bmesh into the builder (optionally transformed / mirrored)."""
    vmap = {}
    for v in bm.verts:
        co = v.co.copy()
        if m is not None:
            co = m @ co
        if mirror_x:
            co.x = -co.x
        vmap[v] = mb.v(co)
    for f in bm.faces:
        vs = [vmap[v] for v in f.verts]
        if mirror_x:
            vs.reverse()
        name = mname if isinstance(mname, str) else mname(f)
        mb.f(vs, name, smooth)


def lathe(mb, profile, nseg, mname, m=None, smooth=True, closed=False, axis='x', a0=0.0, a1=2 * math.pi):
    """Revolve profile [(r, h)] around the axis (h along it). mname may be a list per profile segment."""
    full = abs((a1 - a0) - 2 * math.pi) < 1e-6
    cnt = nseg if full else nseg + 1
    rows = []
    for k in range(cnt):
        a = a0 + (a1 - a0) * k / nseg
        ca, sa = math.cos(a), math.sin(a)
        row = []
        for (r, h) in profile:
            if axis == 'x':
                co = Vector((h, r * ca, r * sa))
            elif axis == 'y':
                co = Vector((r * ca, h, r * sa))
            else:
                co = Vector((r * ca, r * sa, h))
            if m is not None:
                co = m @ co
            row.append(mb.v(co))
        rows.append(row)
    np_ = len(profile)
    segs = nseg if full else nseg
    for k in range(segs):
        k2 = (k + 1) % cnt
        for j in range(np_ - 1):
            name = mname[j] if isinstance(mname, (list, tuple)) else mname
            mb.f([rows[k][j], rows[k][j + 1], rows[k2][j + 1], rows[k2][j]], name, smooth)
        if closed:
            name = mname[-1] if isinstance(mname, (list, tuple)) else mname
            mb.f([rows[k][np_ - 1], rows[k][0], rows[k2][0], rows[k2][np_ - 1]], name, smooth)
    return rows


def cylinder(mb, p0, p1, r, nseg, mname, caps=True, smooth=True, cap_name=None):
    """Cylinder between two points."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    L = d.length
    z = d.normalized()
    x = z.orthogonal().normalized()
    y = z.cross(x)
    ring0, ring1 = [], []
    for k in range(nseg):
        a = 2 * math.pi * k / nseg
        off = x * (math.cos(a) * r) + y * (math.sin(a) * r)
        ring0.append(mb.v(p0 + off))
        ring1.append(mb.v(p1 + off))
    for k in range(nseg):
        k2 = (k + 1) % nseg
        mb.f([ring0[k], ring0[k2], ring1[k2], ring1[k]], mname, smooth)
    if caps:
        mb.f(list(reversed(ring0)), cap_name or mname, False)
        mb.f(ring1, cap_name or mname, False)


def prism(mb, pts2d, plane, d0, d1, mname, side_name=None, m=None, smooth_sides=False, caps=(True, True)):
    """Extrude a 2D polygon. plane 'xz' -> extruded along y from d0 to d1, 'yz' along x, 'xy' along z."""
    def co(p, d):
        if plane == 'xz':
            c = Vector((p[0], d, p[1]))
        elif plane == 'yz':
            c = Vector((d, p[0], p[1]))
        else:
            c = Vector((p[0], p[1], d))
        return m @ c if m is not None else c
    a = [mb.v(co(p, d0)) for p in pts2d]
    b = [mb.v(co(p, d1)) for p in pts2d]
    n = len(pts2d)
    for i in range(n):
        i2 = (i + 1) % n
        mb.f([a[i], a[i2], b[i2], b[i]], side_name or mname, smooth_sides)
    if caps[0]:
        mb.f(list(reversed(a)), mname, False)
    if caps[1]:
        mb.f(b, mname, False)
    return a, b


def quad(mb, a, b, c, d, mname, smooth=False):
    return mb.f([mb.v(Vector(a)), mb.v(Vector(b)), mb.v(Vector(c)), mb.v(Vector(d))], mname, smooth)


def rounded_rect(w, h, r, seg=3, cx=0.0, cy=0.0):
    """2D rounded rectangle points (CCW)."""
    r = min(r, w / 2 - 1e-4, h / 2 - 1e-4)
    pts = []
    corners = [(w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)]
    for (x, y, a0) in corners:
        for k in range(seg + 1):
            a = math.radians(a0 + 90 * k / seg)
            pts.append((cx + x + r * math.cos(a), cy + y + r * math.sin(a)))
    return pts


# ───────────────────────────────────────────────────────────── wheels

def wheel(mb, center, radius, width, rim_r, outward, style='alloy5x2', nseg=22, rim_mat='metal.alu',
          tyre_seg=None, dual=False):
    """Tyre + rim + brake disc. Axle along X; `outward` = +1 for the right side, -1 for the left.

    Styles: 'alloy5x2' (10 spokes in 5 pairs), 'alloy6', 'alloy7', 'steelcap' (van hub-cap),
            'truck' (steel disc with 10 nuts), 'truckdual' (dual tyres, dished)
    """
    cx, cy, cz = center
    s = outward
    tseg = tyre_seg or nseg

    def M(h_offset=0.0):
        # local frame: h along +X outward; mirror for the left side
        return Matrix.Translation((cx, cy, cz)) @ Matrix.Diagonal((s, 1, 1, 1))

    m = M()
    hw = width / 2
    R = radius
    # tyre profile (r, h): inner bead -> inner wall -> tread -> outer wall -> outer bead
    sh = min(0.035, (R - rim_r) * 0.3)
    prof = [
        (rim_r + 0.012, -hw + 0.012),
        (rim_r + (R - rim_r) * 0.55, -hw - 0.004),
        (R - sh, -hw + 0.006),
        (R - 0.004, -hw + sh * 0.9),
        (R, -hw * 0.30),
        (R, hw * 0.30),
        (R - 0.004, hw - sh * 0.9),
        (R - sh, hw - 0.006),
        (rim_r + (R - rim_r) * 0.55, hw + 0.004),
        (rim_r + 0.012, hw - 0.012),
    ]
    mats = (['rubber.wall'] * 3 + ['rubber.tread'] * 3 + ['rubber.wall'] * 3)
    if dual:
        # inner tyre of a dual pair sits further in
        m_in = Matrix.Translation((cx - s * (width + 0.03), cy, cz)) @ Matrix.Diagonal((s, 1, 1, 1))
        lathe(mb, prof, tseg, mats, m=m_in)
    lathe(mb, prof, tseg, mats, m=m)

    face_h = hw - 0.02  # rim face plane (outer)
    lip = [
        (rim_r - 0.012, face_h - 0.035),
        (rim_r - 0.004, face_h + 0.004),
        (rim_r + 0.014, face_h + 0.006),
        (rim_r + 0.016, face_h - 0.012),
    ]
    lathe(mb, lip, nseg, rim_mat, m=m)
    # barrel (seen through the spokes), dark
    lathe(mb, [(rim_r - 0.012, -hw + 0.02), (rim_r - 0.012, face_h - 0.035)], nseg, 'metal.dark', m=m)

    if style.startswith('alloy'):
        # brake disc + hub, behind the spokes
        dr = rim_r * 0.82
        lathe(mb, [(0.0, face_h - 0.075), (dr, face_h - 0.075), (dr, face_h - 0.10)], nseg, 'metal.dark', m=m)
        # caliper (top rear)
        cal = Matrix.Translation((cx + s * (face_h - 0.06), cy - 0.0, cz + dr * 0.78))
        box(mb, (0, 0, 0), (0.05, dr * 0.75, 0.07), 'trim.grey', m=cal)
        nsp = {'alloy5x2': 10, 'alloy6': 6, 'alloy7': 7}.get(style, 10)
        pair = style == 'alloy5x2'
        hub_r = rim_r * 0.30
        # hub
        lathe(mb, [(0.0, face_h + 0.012), (hub_r * 0.55, face_h + 0.012), (hub_r, face_h - 0.0), (hub_r, face_h - 0.05)],
              nseg // 2, rim_mat, m=m)
        lathe(mb, [(0.0, face_h + 0.0135), (hub_r * 0.42, face_h + 0.0135)], nseg // 2, 'trim.gloss', m=m)
        r_in, r_out = hub_r * 0.85, rim_r - 0.008
        steps = 4
        for k in range(nsp):
            if pair:
                base = (k // 2) * (2 * math.pi / 5) + (-1 if k % 2 == 0 else 1) * 0.13
            else:
                base = k * 2 * math.pi / nsp
            w_in = 0.022 if pair else 0.034
            w_out = 0.016 if pair else 0.030
            top, bot = [], []
            for i in range(steps + 1):
                f = i / steps
                r = r_in + (r_out - r_in) * f
                hwid = (w_in + (w_out - w_in) * f) * (1.0 + 0.4 * math.sin(math.pi * f) if not pair else 1.0)
                hface = face_h - 0.004 - 0.022 * math.sin(math.pi * f * 0.9)  # concave dish
                da = hwid / r
                row_t, row_b = [], []
                for sgn in (-1, 1):
                    a = base + sgn * da
                    p = Vector((hface, r * math.cos(a), r * math.sin(a)))
                    q = Vector((hface - 0.03, r * math.cos(a) * 1.0, r * math.sin(a) * 1.0))
                    row_t.append(mb.v(m @ p))
                    row_b.append(mb.v(m @ q))
                top.append(row_t)
                bot.append(row_b)
            for i in range(steps):
                mb.f([top[i][0], top[i][1], top[i + 1][1], top[i + 1][0]], rim_mat)
                mb.f([bot[i][0], top[i][0], top[i + 1][0], bot[i + 1][0]], rim_mat)
                mb.f([top[i][1], bot[i][1], bot[i + 1][1], top[i + 1][1]], rim_mat)
    elif style == 'steelcap':
        # full plastic/silver hub cap with vents
        dr = rim_r * 0.82
        lathe(mb, [(0.0, face_h - 0.075), (dr, face_h - 0.075)], nseg, 'metal.dark', m=m)
        cap_prof = [(0.0, face_h + 0.018), (rim_r * 0.25, face_h + 0.016), (rim_r * 0.55, face_h + 0.004),
                    (rim_r * 0.75, face_h - 0.002), (rim_r * 0.92, face_h + 0.004), (rim_r - 0.006, face_h - 0.004)]
        lathe(mb, cap_prof, nseg, ['metal.gun', 'metal.gun', 'trim.black', 'metal.gun', 'metal.gun'], m=m)
    elif style in ('truck', 'truckdual'):
        dish = 0.06 if style == 'truckdual' else 0.02
        prof_d = [(0.0, face_h - dish - 0.01), (rim_r * 0.22, face_h - dish - 0.01), (rim_r * 0.30, face_h - dish + 0.01),
                  (rim_r * 0.55, face_h - dish + 0.0), (rim_r * 0.72, face_h - dish * 0.5),
                  (rim_r * 0.9, face_h - 0.01), (rim_r - 0.01, face_h - 0.02)]
        lathe(mb, prof_d, nseg, ['metal.dark', rim_mat, rim_mat, rim_mat, 'trim.black', rim_mat], m=m)
        # wheel nuts
        for k in range(10):
            a = 2 * math.pi * k / 10
            p = Vector((face_h - dish + 0.005, rim_r * 0.42 * math.cos(a), rim_r * 0.42 * math.sin(a)))
            pp = m @ p
            q = m @ (p + Vector((0.025, 0, 0)))
            cylinder(mb, pp, q, 0.014, 6, 'metal.chrome')
        # hub nose
        lathe(mb, [(0.0, face_h - dish + 0.07), (rim_r * 0.12, face_h - dish + 0.065), (rim_r * 0.2, face_h - dish + 0.0)],
              12, 'metal.galv', m=m)


# ───────────────────────────────────────────────────────────── object ops

def apply_boolean(obj, cutter, op='DIFFERENCE'):
    mod = obj.modifiers.new('bool', 'BOOLEAN')
    mod.operation = op
    mod.solver = 'EXACT'
    mod.object = cutter
    mod.material_mode = 'TRANSFER'
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    newmesh = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    obj.modifiers.clear()
    old = obj.data
    obj.data = newmesh
    bpy.data.meshes.remove(old)
    bpy.data.objects.remove(cutter, do_unlink=True)


def join(objs, name):
    objs = [o for o in objs if o is not None]
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    with bpy.context.temp_override(active_object=objs[0], selected_editable_objects=objs, selected_objects=objs):
        bpy.ops.object.join()
    o = objs[0]
    o.name = name
    o.data.name = name
    return o


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for me in list(bpy.data.meshes):
        bpy.data.meshes.remove(me)
    for m in list(bpy.data.materials):
        bpy.data.materials.remove(m)
    _mat_cache.clear()


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def _hemisphere_dirs(n):
    """Cosine-weighted directions around +Z (Fibonacci spiral)."""
    dirs = []
    ga = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        u = (i + 0.5) / n
        r = math.sqrt(u)
        a = i * ga
        dirs.append(Vector((r * math.cos(a), r * math.sin(a), math.sqrt(max(0.0, 1 - u)))))
    return dirs


def bake_ao(obj, rays=48, dist=0.9, ground=True, strength=1.0, floor=0.18):
    """Per-vertex ambient occlusion into a FLOAT_COLOR point attribute 'Col' (grey)."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    verts = [v.co.copy() for v in bm.verts]
    polys = [[v.index for v in f.verts] for f in bm.faces]
    if ground:
        g = 60.0
        base = len(verts)
        verts += [Vector((-g, -g, -0.002)), Vector((g, -g, -0.002)), Vector((g, g, -0.002)), Vector((-g, g, -0.002))]
        polys.append([base, base + 1, base + 2, base + 3])
    tree = BVHTree.FromPolygons(verts, polys, all_triangles=False)
    dirs = _hemisphere_dirs(rays)
    ao = []
    for v in bm.verts:
        n = v.normal
        if n.length < 1e-6:
            ao.append(1.0)
            continue
        # tangent frame
        t = n.orthogonal().normalized()
        b = n.cross(t)
        o = v.co + n * 0.004
        hit = 0.0
        for d in dirs:
            w = t * d.x + b * d.y + n * d.z
            loc, _, _, dd = tree.ray_cast(o, w, dist)
            if loc is not None:
                hit += 1.0 - (dd / dist) * 0.5
        a = 1.0 - strength * hit / len(dirs)
        ao.append(max(floor, min(1.0, a)))
    bm.free()
    attr = me.color_attributes.get('Col') or me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    for i, a in enumerate(ao):
        # slight gamma so open surfaces stay near 1 and only real crevices darken
        g = a ** 1.25
        attr.data[i].color = (g, g, g, 1.0)
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find('Col')


def finalize(obj, sharp_angle=38.0):
    me = obj.data
    for p in me.polygons:
        p.use_smooth = True
    me.set_sharp_from_angle(angle=math.radians(sharp_angle))
    # merge exact duplicates produced by separate parts touching (keeps seams otherwise)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=0.0002)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() < 1e-9], context='FACES')
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    me.set_sharp_from_angle(angle=math.radians(sharp_angle))


def export_glb(obj, path):
    for o in bpy.context.scene.objects:
        o.select_set(o == obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_texcoords=False,
        export_normals=True,
        export_tangents=False,
        export_materials='EXPORT',
        export_vertex_color='ACTIVE',
        export_all_vertex_colors=False,
        export_yup=True,
        export_apply=True,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_lights=False,
        export_cameras=False,
        export_extras=False,
    )


def measure(obj):
    xs = [v.co.x for v in obj.data.vertices]
    ys = [v.co.y for v in obj.data.vertices]
    zs = [v.co.z for v in obj.data.vertices]
    return (min(xs), max(xs)), (min(ys), max(ys)), (min(zs), max(zs))
