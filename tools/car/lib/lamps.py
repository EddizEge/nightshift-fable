"""
Optics inside the headlamps.  Built after the body: lib/body.py makes the lens (zone lamp_head of the skin,
material lens) and the bucket behind it (BodyHeadlamps: an inset of the lens 4 cm deep).  This module
re-materials the bucket (satin metal walls, a bright upper plate, a dark satin floor under the beam units)
and puts the light units in front of its floor (object BodyHeadOptics):

  two daytime-running-light blades along the brow, 6 mm wide light guides standing 3 cm proud of the floor;
  the upper one turns down at the outer end,
  three round projector modules (chrome bowl, glowing ring, dark core under a clear dome), stepped back
  in depth towards the outer end,
  an amber indicator of three slats in the outer corner, inside the turn of the upper blade.

Everything is placed in the lens' own coordinates: (u, v) = the cage address of the lens faces (u runs from
the inner end, 3, to the outer end, 7; v from the brow, 0, to the lower edge, 1) and the depth d under the lens
along its normal.  Glowing parts are "headlight_L" for x < 0 and "headlight_R" for x > 0.  The tail lamps are
not touched.
"""
import math

import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from . import body, util

FLOOR_D = 0.040                 # depth of the bucket floor (body.lamp)
ROOT_D = 0.046                  # parts are anchored this deep (just behind the floor)

# daytime-running blades: (u, v) path, depth of the front face, width
BLADE_A = dict(path=[(3.28, 0.215), (4.20, 0.215), (5.10, 0.215), (5.75, 0.220), (6.12, 0.270), (6.40, 0.420),
                     (6.56, 0.620), (6.62, 0.800)], d=0.011, w=0.0060)
BLADE_B = dict(path=[(3.45, 0.345), (4.30, 0.345), (5.10, 0.345), (5.72, 0.352)], d=0.015, w=0.0050)
# projectors: (u, v) of the centre, depth of the face
PROJECTORS = [(3.97, 0.655, 0.012), (4.70, 0.660, 0.017), (5.40, 0.665, 0.022)]
PROJ_R = 0.0285                 # outer radius of the chrome bowl
RING_R = (0.0168, 0.0198)       # glowing ring
SIGNAL = [((5.95, 0.50), (6.30, 0.50)), ((5.97, 0.62), (6.36, 0.62)), ((6.00, 0.74), (6.40, 0.74))]
SIGNAL_D, SIGNAL_W = 0.016, 0.0065
UPPER_PLATE_V = 0.43            # bucket floor above this v (the brow) is bright metal
SEG = 20

MATS = ['reflector', 'rim_dark', 'hardware', 'headlight_R', 'signal', 'lens', 'trim']


class Lens:
    """The right lamp's lens: (u, v) -> point and outward normal on the skin."""

    def __init__(self, skin):
        bm = bmesh.new()
        bm.from_mesh(skin.data)
        bm.transform(skin.matrix_world)
        zl = bm.faces.layers.int['zone']
        uvl = bm.loops.layers.uv['cage']
        head = body.ZONES.index('lamp_head')
        self.tris = []
        verts, faces = [], []
        for f in bm.faces:
            if f[zl] != head or f.calc_center_median().x < 0:
                continue
            ls = f.loops
            for a, b, c in [(0, i, i + 1) for i in range(1, len(ls) - 1)]:
                self.tris.append(([ls[k][uvl].uv.copy() for k in (a, b, c)], [ls[k].vert.co.copy() for k in (a, b, c)], f.normal.copy()))
            base = len(verts)
            verts += [v.co.copy() for v in f.verts]
            faces.append([base + i for i in range(len(f.verts))])
        bm.free()
        self.bvh = BVHTree.FromPolygons(verts, faces)

    def at(self, u, v):
        """Point on the lens and its outward normal."""
        best = None
        q = Vector((u, v))
        for uvs, cos, n in self.tris:
            a, b, c = uvs
            d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
            if abs(d) < 1e-12:
                continue
            w0 = ((b.y - c.y) * (q.x - c.x) + (c.x - b.x) * (q.y - c.y)) / d
            w1 = ((c.y - a.y) * (q.x - c.x) + (a.x - c.x) * (q.y - c.y)) / d
            w2 = 1 - w0 - w1
            m = min(w0, w1, w2)
            if best is None or m > best[0]:
                best = (m, cos[0] * w0 + cos[1] * w1 + cos[2] * w2)
            if m >= 0:
                break
        p = best[1]
        loc, n, i, dist = self.bvh.find_nearest(p)
        return loc, n.normalized()

    def frame(self, u, v, du=0.02):
        """Point, outward normal N, unit tangent T along +u (in the lens surface), B = N x T."""
        p, n = self.at(u, v)
        a, _ = self.at(u + du, v)
        b, _ = self.at(u - du, v)
        t = (a - b)
        t = (t - n * t.dot(n)).normalized()
        return p, n, t, n.cross(t)

    def depth_below(self, p):
        """How far p is under the lens surface (positive = behind it)."""
        loc, n, i, dist = self.bvh.find_nearest(p)
        return -(p - loc).dot(n)


class Kit:
    def __init__(self):
        self.v, self.f, self.m, self.want = [], [], [], []

    def vert(self, p):
        self.v.append(Vector(p))
        return len(self.v) - 1

    def face(self, idx, mat, want):
        self.f.append(tuple(idx))
        self.m.append(MATS.index(mat))
        self.want.append(Vector(want))


def _smooth(points, n):
    """Catmull-Rom through 2D points, n per span."""
    P = [Vector(p) for p in points]
    P = [P[0] * 2 - P[1]] + P + [P[-1] * 2 - P[-2]]
    out = []
    for i in range(1, len(P) - 2):
        for k in range(n):
            t = k / n
            a, b, c, d = P[i - 1], P[i], P[i + 1], P[i + 2]
            out.append(0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t ** 3))
    out.append(P[-2])
    return out


def bar(k, lens, path_uv, d_top, width, mat_front, mat_side, per=4):
    """A light guide of rectangular section along a (u, v) path: front face at depth d_top, rooted behind the floor."""
    pts = _smooth(path_uv, per) if len(path_uv) > 2 else [Vector(path_uv[0]).lerp(Vector(path_uv[1]), t / 6) for t in range(7)]
    rings = []
    frames = []
    for i, q in enumerate(pts):
        p, n, _, _ = lens.frame(q.x, q.y)
        frames.append((p, n))
    for i, (p, n) in enumerate(frames):
        a = frames[max(i - 1, 0)][0]
        b = frames[min(i + 1, len(frames) - 1)][0]
        t = (b - a)
        t = (t - n * t.dot(n)).normalized()
        s = n.cross(t)
        top, root = p - n * d_top, p - n * ROOT_D
        rings.append([k.vert(top - s * width / 2), k.vert(top + s * width / 2), k.vert(root + s * width / 2), k.vert(root - s * width / 2)])
        rings[-1].append((n, s, t))
    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        n, s, t = r0[4]
        k.face([r0[0], r0[1], r1[1], r1[0]], mat_front, n)
        k.face([r0[1], r0[2], r1[2], r1[1]], mat_side, s)
        k.face([r0[3], r0[0], r1[0], r1[3]], mat_side, -s)
    for r, sgn in ((rings[0], -1), (rings[-1], 1)):
        n, s, t = r[4]
        k.face(r[:4], mat_front, t * sgn)


def projector(k, lens, u, v, d_face):
    """Chrome bowl, glowing ring, dark core under a clear dome; aimed between the lens normal and straight ahead."""
    p, n, t, b = lens.frame(u, v)
    a = (n + Vector((0.0, 0.45, 0.0))).normalized()
    x = (t - a * t.dot(a)).normalized()
    y = a.cross(x)
    c = p - n * d_face

    def ring(r, h):
        return [k.vert(c + (x * math.cos(2 * math.pi * j / SEG) + y * math.sin(2 * math.pi * j / SEG)) * r + a * h) for j in range(SEG)]

    def band(r0, r1, mat, outward):
        for j in range(SEG):
            j1 = (j + 1) % SEG
            ang = 2 * math.pi * (j + 0.5) / SEG
            radial = x * math.cos(ang) + y * math.sin(ang)
            k.face([r0[j], r0[j1], r1[j1], r1[j]], mat, radial if outward == 'radial' else outward)

    depth = ROOT_D - d_face                                    # down to behind the floor
    wall_lo = ring(PROJ_R * 0.86, -depth)
    wall_hi = ring(PROJ_R, -0.003)
    lip = ring(PROJ_R - 0.0025, 0.0)
    cone_lo = ring(RING_R[1], -0.007)
    band(wall_lo, wall_hi, 'reflector', 'radial')
    band(wall_hi, lip, 'reflector', a)
    band(lip, cone_lo, 'reflector', a)                        # the chrome bowl
    ring_in = ring(RING_R[0], -0.007)
    band(cone_lo, ring_in, 'headlight_R', a)                  # glowing ring
    core_out = ring(RING_R[0] - 0.0005, -0.0085)
    band(ring_in, core_out, 'rim_dark', a)
    core_in = ring(0.0055, -0.0085)
    band(core_out, core_in, 'rim_dark', a)
    hub = k.vert(c + a * -0.0085)
    for j in range(SEG):
        k.face([core_in[j], core_in[(j + 1) % SEG], hub], 'headlight_R', a)   # small glowing core
    # clear dome over it
    dome = [ring(RING_R[0], -0.0070), ring(RING_R[0] * 0.72, -0.0030), ring(RING_R[0] * 0.38, -0.0010)]
    band(dome[0], dome[1], 'lens', a)
    band(dome[1], dome[2], 'lens', a)
    top = k.vert(c + a * -0.0004)
    for j in range(SEG):
        k.face([dome[2][j], dome[2][(j + 1) % SEG], top], 'lens', a)
    return c


def bucket(ctx, lens):
    """Re-material the bucket body.lamp made: satin metal walls, bright brow plate, dark satin floor."""
    obj = None
    for o in ctx.col.all_objects:
        if o.name.startswith('BodyHeadlamps'):
            obj = o
    if obj is None:
        return None
    me = obj.data
    me.materials.clear()
    for n in ('hardware', 'reflector', 'rim_dark'):
        me.materials.append(ctx.mat(n))
    uvl = me.uv_layers.get('cage')
    mw = obj.matrix_world
    idx = []
    for poly in me.polygons:
        c = mw @ poly.center
        cm = Vector((abs(c.x), c.y, c.z))
        depth = lens.depth_below(cm)
        if depth < FLOOR_D * 0.75:
            idx.append(0)                                     # wall
            continue
        v = 0.5
        if uvl is not None:
            v = sum(uvl.data[li].uv.y for li in poly.loop_indices) / len(poly.loop_indices)
        idx.append(1 if v < UPPER_PLATE_V else 2)
    me.polygons.foreach_set('material_index', idx)
    me.update()
    return obj


def build(ctx):
    if ctx.body is None:
        return
    skin = ctx.body
    lens = Lens(skin)
    bucket(ctx, lens)

    k = Kit()
    bar(k, lens, BLADE_A['path'], BLADE_A['d'], BLADE_A['w'], 'headlight_R', 'reflector', per=5)
    bar(k, lens, BLADE_B['path'], BLADE_B['d'], BLADE_B['w'], 'headlight_R', 'reflector', per=5)
    centres = [projector(k, lens, u, v, d) for u, v, d in PROJECTORS]
    for a, b in SIGNAL:
        bar(k, lens, [a, b], SIGNAL_D, SIGNAL_W, 'signal', 'reflector')

    # right lamp as built, left lamp mirrored (glowing parts become headlight_L)
    nv = len(k.v)
    verts = list(k.v) + [Vector((-p.x, p.y, p.z)) for p in k.v]
    faces = list(k.f) + [tuple(nv + i for i in reversed(f)) for f in k.f]
    mats = list(k.m) + [m for m in k.m]
    wants = list(k.want) + [Vector((-w.x, w.y, w.z)) for w in k.want]
    names = MATS + ['headlight_L']
    left_head = len(MATS)
    mats = mats[:len(k.f)] + [left_head if MATS[m] == 'headlight_R' else m for m in mats[len(k.f):]]
    used = sorted(set(mats))
    remap = {m: i for i, m in enumerate(used)}
    obj = util.mesh_object('BodyHeadOptics', verts, faces, ctx.col, [ctx.mat(names[m]) for m in used], [remap[m] for m in mats])
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    flip = [f for f, w in zip(bm.faces, wants) if f.normal.dot(w) < 0]
    if flip:
        bmesh.ops.reverse_faces(bm, faces=flip)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    util.shade(obj, True, 35)
    util.set_parent(obj, skin)

    # where the game puts the beams: centre of the projectors, 2 cm ahead of them
    c = Vector((0, 0, 0))
    for p in centres:
        c += p
    c /= len(centres)
    ctx.anchors['headlightR'] = (c.x, c.y + 0.02, c.z)
    ctx.anchors['headlightL'] = (-c.x, c.y + 0.02, c.z)

    # every part must stay behind the lens
    worst = min(lens.depth_below(Vector((abs(p.x), p.y, p.z))) for p in k.v)
    lo, hi = util.bounds(obj)
    print(f'[car] lamps: BodyHeadOptics {util.tri_count(obj)} triangles (bucket {util.tri_count(bpy_obj(ctx))}),'
          f' nearest to the lens {worst * 1000:.1f} mm, y {lo.y:.3f}..{hi.y:.3f}, anchors R {tuple(round(a, 3) for a in ctx.anchors["headlightR"])}')
    return obj


def bpy_obj(ctx):
    for o in ctx.col.all_objects:
        if o.name.startswith('BodyHeadlamps'):
            return o
    return None
