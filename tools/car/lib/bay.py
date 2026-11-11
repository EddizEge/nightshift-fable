"""
The engine bay: what is seen through the rear glass, the slots of the engine cover, the rear quarter
windows and the window in the bulkhead behind the seats.  Built after the body (ctx.body is the skin and
still carries its helper layers: face int "zone", UV layer "cage").

  BodyBayLiner   the inside of the skin over the bay (buttresses, haunches, deck and the rear quarter
                 windows): a copy of those skin faces moved 18 mm inwards and turned to face into the bay.
                 Every face of it looks inwards, so from outside the near side is culled and you look into
                 the bay, while the far side closes it (no view straight through the car).  The rear glass
                 and the engine cover are left open: the engine is seen through them.
  BodyBay        the box: bay floor, side walls in front of the rear wheel-house tubs, a shelf over the tubs,
                 the rear wall, the back of the bulkhead and a frame around the bulkhead window.
  BodyEngine     a V engine lying along the car: block with two banks, cam covers, intake plenum with
                 eight runners and a throttle body, exhaust headers, gearbox, strut tops and two braces.

Keep-outs (other modules): rear wheel-house tubs |x| > 0.64 for -1.86 < y < -0.94 below z 0.83; behind
y -1.65 stay above z 0.50 (diffuser tunnel); nothing behind y -1.92; the cabin ends at the bulkhead.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

from . import body, util
from . import spec as S

# ── where the bay is ─────────────────────────────────────────────────────────────────────────
Y_FRONT = S.BULKHEAD_Y          # back face of the bulkhead
Y_REAR = -1.885                 # rear wall of the bay
WALL_X = 0.625                  # side walls, in front of the rear wheel-house tubs
SHELF_Z = 0.850                 # shelf over the tubs (their top is at 0.83)
LIP_Z = 0.880                   # the shelf turns up against the skin
FLOOR_Z = 0.320                 # bay floor ...
FLOOR_Z_REAR = 0.520            # ... rising over the diffuser tunnel
FLOOR_STEP = (-1.58, -1.65)     # where it rises
WINDOW_HALF = 0.600             # half width of the window in the bulkhead
WINDOW_Z = 0.725                # its lower edge (top of the parcel shelf in the cabin)
SKIN_GAP = 0.020                # the box keeps this far inside the skin
LINER_GAP = 0.022

MATS = ['trim', 'grille', 'carbon', 'interior', 'mechanical', 'hardware', 'rim_dark']


class Kit:
    """Vertex / face lists with a material and an orientation rule per face."""

    def __init__(self):
        self.v, self.f, self.m, self.g = [], [], [], []
        self.n_groups = 0

    def solid(self):
        """Start a closed solid: its faces get consistent outward normals."""
        self.n_groups += 1
        return ('solid', self.n_groups)

    def vert(self, p):
        self.v.append(Vector(p))
        return len(self.v) - 1

    def face(self, pts_or_idx, mat, group):
        idx = [i if isinstance(i, int) else self.vert(i) for i in pts_or_idx]
        self.f.append(tuple(idx))
        self.m.append(MATS.index(mat))
        self.g.append(group)

    # ── primitives ───────────────────────────────────────────────────────────────────────────
    def prism(self, profile, y0, y1, mat, cap_mat=None, xform=None):
        """Closed polygon in the xz plane extruded from y0 to y1."""
        g = self.solid()
        n = len(profile)
        t = xform or Matrix.Identity(4)
        a = [self.vert(t @ Vector((x, y0, z))) for x, z in profile]
        b = [self.vert(t @ Vector((x, y1, z))) for x, z in profile]
        for i in range(n):
            j = (i + 1) % n
            self.face([a[i], a[j], b[j], b[i]], mat, g)
        self.face(a, cap_mat or mat, g)
        self.face(list(reversed(b)), cap_mat or mat, g)

    def rbox(self, centre, size, mat, bevel=0.0, segments=2, xform=None):
        """Box (optionally with rounded edges) in its own frame `xform` (rotation about its centre)."""
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
        if bevel > 0:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=segments, profile=0.5, affect='EDGES')
        m = Matrix.Translation(Vector(centre)) @ (xform or Matrix.Identity(4))
        g = self.solid()
        base = len(self.v)
        for v in bm.verts:
            self.v.append(m @ v.co)
        for f in bm.faces:
            self.f.append(tuple(base + v.index for v in f.verts))
            self.m.append(MATS.index(mat))
            self.g.append(g)
        bm.free()

    def tube(self, path, r, sides, mat, caps=True, cap_mat=None):
        """Round tube along a polyline (parallel-transported frames); radius may be a list."""
        g = self.solid() if caps else ('open', 0)
        path = [Vector(p) for p in path]
        rs = r if isinstance(r, (list, tuple)) else [r] * len(path)
        tangents = []
        for i in range(len(path)):
            a = path[max(i - 1, 0)]
            b = path[min(i + 1, len(path) - 1)]
            tangents.append((b - a).normalized())
        up = Vector((0, 0, 1)) if abs(tangents[0].z) < 0.9 else Vector((1, 0, 0))
        nrm = tangents[0].cross(up).normalized()
        rings = []
        for i, p in enumerate(path):
            t = tangents[i]
            nrm = (nrm - t * nrm.dot(t)).normalized()
            bi = t.cross(nrm)
            ring = []
            for k in range(sides):
                a = 2 * math.pi * k / sides
                ring.append(self.vert(p + (nrm * math.cos(a) + bi * math.sin(a)) * rs[i]))
            rings.append(ring)
        for i in range(len(rings) - 1):
            for k in range(sides):
                k1 = (k + 1) % sides
                self.face([rings[i][k], rings[i][k1], rings[i + 1][k1], rings[i + 1][k]], mat, g)
        if caps:
            self.face(list(reversed(rings[0])), cap_mat or mat, g)
            self.face(rings[-1], cap_mat or mat, g)

    def disc(self, centre, axis, r, h, sides, mat, cap_mat=None):
        c = Vector(centre)
        a = Vector(axis).normalized()
        self.tube([c - a * (h / 2), c + a * (h / 2)], r, sides, mat, True, cap_mat)

    # ── to Blender ───────────────────────────────────────────────────────────────────────────
    def to_object(self, ctx, name, smooth_deg=40):
        used = sorted(set(self.m))
        remap = {m: k for k, m in enumerate(used)}
        obj = util.mesh_object(name, self.v, self.f, ctx.col, [ctx.mat(MATS[m]) for m in used],
                               [remap[m] for m in self.m])
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bm.faces.ensure_lookup_table()
        groups = {}
        for i, gk in enumerate(self.g):
            groups.setdefault(gk, []).append(bm.faces[i])
        flip = []
        for gk, faces in groups.items():
            if gk[0] == 'solid':
                bmesh.ops.recalc_face_normals(bm, faces=faces)
            elif gk[0] == 'want':
                want = gk[1]
                for f in faces:
                    if f.normal.dot(Vector(want(f.calc_center_median()))) < 0:
                        flip.append(f)
        if flip:
            bmesh.ops.reverse_faces(bm, faces=flip)
        loose = [v for v in bm.verts if not v.link_faces]
        if loose:
            bmesh.ops.delete(bm, geom=loose, context='VERTS')
        bm.to_mesh(obj.data)
        bm.free()
        obj.data.update()
        util.shade(obj, True, smooth_deg)
        return obj


def want(fn):
    """A face group that must face along fn(face centre)."""
    return ('want', fn)


# ── the skin, measured ───────────────────────────────────────────────────────────────────────

class Skin:
    def __init__(self, skin):
        self.bm = bmesh.new()
        self.bm.from_mesh(skin.data)
        self.bm.transform(skin.matrix_world)
        self.bm.faces.ensure_lookup_table()
        self.zone = self.bm.faces.layers.int.get('zone')
        self.bvh = BVHTree.FromBMesh(self.bm)

    def ray(self, origin, direction, far=4.0):
        """(distance, zone name, normal) of the first skin face along the ray, or (None, None, None)."""
        d = Vector(direction).normalized()
        loc, n, i, dist = self.bvh.ray_cast(Vector(origin), d, far)
        if loc is None:
            return None, None, None
        zone = body.ZONES[self.bm.faces[i][self.zone]] if self.zone is not None else 'paint'
        return dist, zone, n

    def inside(self, origin, direction, gap, far=4.0):
        """How far along the ray a point stays `gap` away from the skin it hits (measured along the skin normal)."""
        d = Vector(direction).normalized()
        dist, zone, n = self.ray(origin, d, far)
        if dist is None:
            return None, None
        return dist - gap / max(0.35, abs(d.dot(n))), zone

    def side_x(self, y, z, gap):
        t, _ = self.inside((0.0, y, z), (1, 0, 0), gap)
        return self.settle(Vector((t if t is not None else 0.9, y, z)), Vector((1, 0, 0)), gap).x

    def outline(self, y, centre_z, n, gap, a0=0.0, a1=180.0):
        """Points `gap` inside the skin in the cross-section at y, seen from (0, y, centre_z), angles a0..a1
        (0 = +x, 90 = up): (point, zone) pairs."""
        out = []
        c = Vector((0.0, y, centre_z))
        for k in range(n + 1):
            a = math.radians(a0 + (a1 - a0) * k / n)
            d = Vector((math.cos(a), 0.0, math.sin(a)))
            t, zone = self.inside(c, d, gap)
            out.append((self.settle(c + d * (t if t is not None else 0.5), d, gap), zone))
        return out

    def settle(self, p, d, gap):
        """Move p back along -d until it is at least 0.75 gap inside the skin (shut-line grooves, glass edges)."""
        for _ in range(24):
            loc, n, i, dist = self.bvh.find_nearest(p, 0.2)
            if loc is None or ((p - loc).dot(n) < 0 and dist >= 0.8 * gap):
                break
            p = p - d * 0.003
        return p

    def enclosed(self, p):
        """Inside the skin: most axis rays from p first meet the skin from behind."""
        votes = 0
        for d in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
            loc, n, i, dist = self.bvh.ray_cast(Vector(p), Vector(d), 6.0)
            if loc is not None and n.dot(Vector(d)) > 0:
                votes += 1
        return votes >= 4

    def free(self):
        self.bm.free()


# ── liner ────────────────────────────────────────────────────────────────────────────────────
LINER_C = 0.860                 # the liner's rays start on the centreline at this height (its lowest edge)
OPEN = ('glass_rear', 'cover', 'mesh', 'duct')


def liner(ctx, sk):
    """The inside of the skin over the bay, facing into it; open under the rear glass and the engine cover."""
    k = Kit()
    ny, na = 18, 32
    ys = [Y_FRONT - 0.004 + (Y_REAR - 0.012 - Y_FRONT + 0.004) * i / ny for i in range(ny + 1)]
    grid = []
    for y in ys:
        row = []
        for p, zone in sk.outline(y, LINER_C, na, LINER_GAP):
            row.append((k.vert(p), zone))
        grid.append(row)
    for i in range(ny):
        y = 0.5 * (ys[i] + ys[i + 1])
        g = want(lambda c, y=y: (-c.x, 0.0, LINER_C - c.z))
        for j in range(na):
            corners = [grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]]
            zones = [z for _, z in corners]
            if all(z in OPEN or z == 'gap' or z is None for z in zones) and any(z in OPEN for z in zones):
                continue
            k.face([v for v, _ in corners], 'grille', g)
    obj = k.to_object(ctx, 'BodyBayLiner', 40)
    util.set_parent(obj, ctx.body)
    return obj


# ── the box ──────────────────────────────────────────────────────────────────────────────────

def floor_z(y):
    y0, y1 = FLOOR_STEP
    if y >= y0:
        return FLOOR_Z
    if y <= y1:
        return FLOOR_Z_REAR
    t = (y0 - y) / (y0 - y1)
    return FLOOR_Z + (FLOOR_Z_REAR - FLOOR_Z) * (t * t * (3 - 2 * t))


def bay_box(ctx, sk):
    k = Kit()
    ys = [Y_FRONT, -0.95, -1.10, -1.25, -1.40, -1.50, FLOOR_STEP[0], -1.605, -1.625, FLOOR_STEP[1], -1.75, Y_REAR]

    # floor
    g = want(lambda c: (0, 0, 1))
    for i in range(len(ys) - 1):
        y0, y1 = ys[i], ys[i + 1]
        k.face([(-WALL_X, y0, floor_z(y0)), (WALL_X, y0, floor_z(y0)), (WALL_X, y1, floor_z(y1)), (-WALL_X, y1, floor_z(y1))], 'trim', g)
    # side walls, facing the engine
    for sx in (-1, 1):
        g = want(lambda c, sx=sx: (-sx, 0, 0))
        for i in range(len(ys) - 1):
            y0, y1 = ys[i], ys[i + 1]
            x = sx * WALL_X
            k.face([(x, y0, floor_z(y0)), (x, y1, floor_z(y1)), (x, y1, SHELF_Z), (x, y0, SHELF_Z)], 'trim', g)
    # shelf over the tubs, turning up against the skin
    yss = [Y_FRONT - 0.002 - (Y_FRONT - Y_REAR - 0.002) * i / 14 for i in range(15)]
    for sx in (-1, 1):
        gs = want(lambda c: (0, 0, 1))
        gl = want(lambda c, sx=sx: (-sx, 0, 0.3))
        for i in range(len(yss) - 1):
            y0, y1 = yss[i], yss[i + 1]
            xo0, xo1 = sk.side_x(y0, SHELF_Z, SKIN_GAP), sk.side_x(y1, SHELF_Z, SKIN_GAP)
            xl0, xl1 = sk.side_x(y0, LIP_Z, SKIN_GAP + 0.004), sk.side_x(y1, LIP_Z, SKIN_GAP + 0.004)
            k.face([(sx * WALL_X, y0, SHELF_Z), (sx * xo0, y0, SHELF_Z), (sx * xo1, y1, SHELF_Z), (sx * WALL_X, y1, SHELF_Z)], 'trim', gs)
            k.face([(sx * xo0, y0, SHELF_Z), (sx * xl0, y0, LIP_Z), (sx * xl1, y1, LIP_Z), (sx * xo1, y1, SHELF_Z)], 'trim', gl)
            # the lip also faces out: seen from outside through the quarter window it closes the slot along the skin
            e = 0.0015
            k.face([(sx * (xo0 + e), y0, SHELF_Z), (sx * (xl0 + e), y0, LIP_Z), (sx * (xl1 + e), y1, LIP_Z), (sx * (xo1 + e), y1, SHELF_Z)],
                   'trim', want(lambda c, sx=sx: (sx, 0, -0.3)))

    # rear wall: below the shelf between the side walls, above it a fan up to the deck
    g = want(lambda c: (0, 1, 0))
    k.face([(-WALL_X, Y_REAR, FLOOR_Z_REAR), (WALL_X, Y_REAR, FLOOR_Z_REAR), (WALL_X, Y_REAR, SHELF_Z), (-WALL_X, Y_REAR, SHELF_Z)], 'trim', g)
    rim = sk.outline(Y_REAR, SHELF_Z, 28, SKIN_GAP)
    centre = k.vert((0.0, Y_REAR, SHELF_Z))
    pts = [k.vert(p) for p, _ in rim]
    for i in range(len(pts) - 1):
        k.face([centre, pts[i], pts[i + 1]], 'trim', g)

    # back of the bulkhead (carbon, seen through the rear glass) and its cabin side
    yb = Y_FRONT
    for side, mat, d in ((-1, 'carbon', -1), (1, 'trim', 1)):
        g = want(lambda c, d=d: (0, d, 0))
        y = yb + (0.0 if side < 0 else 0.004)
        k.face([(-WALL_X, y, FLOOR_Z), (WALL_X, y, FLOOR_Z), (WALL_X, y, WINDOW_Z), (-WALL_X, y, WINDOW_Z)], mat, g)
    # frame around the bulkhead window, from the window line up to the roof (both faces)
    rim = sk.outline(yb - 0.004, WINDOW_Z, 40, SKIN_GAP)
    origin = Vector((0.0, yb, WINDOW_Z))
    for face_y, mat, d in ((yb - 0.002, 'trim', -1), (yb + 0.002, 'interior', 1)):
        g = want(lambda c, d=d: (0, d, 0))
        outer, inner = [], []
        for o, _ in rim:
            dvec = (o - origin).normalized()
            t_out = (o - origin).length
            t_rect = WINDOW_HALF / abs(dvec.x) if abs(dvec.x) > 1e-6 else 9.0
            t_in = max(0.0, min(t_rect, t_out - 0.035))
            i = origin + dvec * t_in
            outer.append(k.vert((o.x, face_y, o.z)))
            inner.append(k.vert((i.x, face_y, i.z)))
        for j in range(len(rim) - 1):
            k.face([inner[j], outer[j], outer[j + 1], inner[j + 1]], mat, g)

    obj = k.to_object(ctx, 'BodyBay', 35)
    util.set_parent(obj, ctx.body)
    return obj


# ── engine ───────────────────────────────────────────────────────────────────────────────────
CRANK_Z = 0.440
BLOCK_Y = (-0.900, -1.560)
BANK = math.radians(45.0)       # each bank leans out this much from vertical (a 90 degree V)
HEAD_C = Vector((0.220, 0.650))  # centre of the right head's top face (x, z)
RUNNER_Y = [-1.020, -1.125, -1.230, -1.335]
BRACE_Y = -1.420
TOWER_X = 0.740


def _bezier(p0, p1, p2, p3, n):
    out = []
    for i in range(n + 1):
        t = i / n
        a = (1 - t) ** 3
        b = 3 * (1 - t) ** 2 * t
        c = 3 * (1 - t) * t * t
        d = t ** 3
        out.append(p0 * a + p1 * b + p2 * c + p3 * d)
    return out


def engine(ctx):
    k = Kit()
    V = Vector
    y0, y1 = BLOCK_Y

    # block with the two banks (one section along the crank)
    half = [(0.150, 0.345), (0.190, 0.370), (0.200, 0.500), (0.285, 0.585), (0.155, 0.715), (0.070, 0.630)]
    k.prism([(0.0, 0.345)] + [(x, z) for x, z in half] + [(0.0, 0.630)] + [(-x, z) for x, z in reversed(half)], y0, y1, 'mechanical')
    # timing cover and pulleys at the front (facing the bulkhead)
    small = [(0.0, 0.37), (0.15, 0.37), (0.18, 0.40), (0.18, 0.50), (0.255, 0.575), (0.150, 0.690), (0.0, 0.610)]
    k.prism(small[:-1] + [(-x, z) for x, z in reversed(small[1:-1])], y0 + 0.028, y0, 'rim_dark')
    k.disc((0.0, y0 + 0.042, CRANK_Z), (0, 1, 0), 0.075, 0.026, 20, 'hardware', 'mechanical')
    k.disc((0.0, y0 + 0.052, CRANK_Z), (0, 1, 0), 0.030, 0.012, 14, 'hardware')
    for sx in (-1, 1):
        k.disc((sx * 0.215, y0 + 0.040, 0.600), (0, 1, 0), 0.050, 0.022, 18, 'hardware', 'mechanical')

    # cam covers on the two heads, with a raised spine and an oil filler on the right one
    for sx in (-1, 1):
        rot = Matrix.Rotation(sx * BANK, 4, 'Y')          # the cover's local z = the head's outward normal
        n = V((sx * math.sin(BANK), 0.0, math.cos(BANK)))
        c = V((sx * HEAD_C.x, 0.0, HEAD_C.y))
        off = 0.0 if sx > 0 else 0.020                        # the left bank sits a little ahead
        yc = (y0 + y1) / 2 + off
        ln = (y0 - y1) - 0.050
        cen = c + n * 0.030
        k.rbox((cen.x, yc, cen.z), (0.160, ln, 0.060), 'rim_dark', bevel=0.018, segments=2, xform=rot)
        spine = c + n * 0.062
        k.rbox((spine.x, yc, spine.z), (0.030, ln - 0.08, 0.010), 'hardware', bevel=0.004, segments=1, xform=rot)
        for j in range(4):                                     # coil packs along the valley side
            a = V((-sx * math.cos(BANK), 0.0, math.sin(BANK)))
            p = c + n * 0.066 + a * 0.050
            k.rbox((p.x, RUNNER_Y[j] + off - 0.052, p.z), (0.030, 0.034, 0.018), 'trim', bevel=0.004, segments=1, xform=rot)
        if sx > 0:
            p = c + n * 0.070 - V((sx * math.cos(BANK), 0.0, -math.sin(BANK))) * 0.040
            k.disc((p.x, y0 - 0.075, p.z), n, 0.026, 0.020, 16, 'hardware')

    # intake plenum in the valley: a tall carbon box whose top follows the rear glass 4 cm under it (the driving
    # camera sees the glass almost edge-on), two rails along its top, throttle body at its front, eight runners
    side = [(-0.945, 0.700), (-1.380, 0.700), (-1.380, 0.860), (-1.335, 0.950), (-1.300, 0.972), (-1.000, 0.985),
            (-0.962, 0.980), (-0.945, 0.955)]
    swap = Matrix(((0, 1, 0, 0), (1, 0, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)))       # profile in (y, z), extruded along x
    k.prism(side, -0.100, 0.100, 'carbon', xform=swap)
    for sx in (-1, 1):
        k.tube([V((sx * 0.072, -0.990, 0.993)), V((sx * 0.072, -1.290, 0.981))], 0.009, 8, 'hardware', True)
    for yy in (-1.04, -1.32):
        k.rbox((0.0, yy, 0.665), (0.060, 0.050, 0.070), 'mechanical')
    k.tube([V((0.0, -0.960, 0.805)), V((0.0, -0.905, 0.805))], 0.046, 20, 'hardware', True, 'trim')
    k.tube([V((0.0, -0.908, 0.805)), V((0.0, -0.893, 0.805))], 0.052, 20, 'hardware', True, 'mechanical')
    for sx in (-1, 1):
        off = 0.0 if sx > 0 else 0.020
        for yr in RUNNER_Y:
            y = yr + off
            path = _bezier(V((sx * 0.060, y, 0.800)), V((sx * 0.130, y, 0.875)), V((sx * 0.190, y, 0.830)),
                           V((sx * 0.118, y, 0.668)), 7)
            k.tube(path, 0.019, 8, 'hardware', True)

    # exhaust headers: four primaries per bank down the outside of the block into a collector
    for sx in (-1, 1):
        off = 0.0 if sx > 0 else 0.020
        lanes = [0.444, 0.406, 0.368, 0.330]
        col_start = V((sx * 0.395, -1.600, 0.500))
        for j, yr in enumerate(RUNNER_Y):
            y = yr + off
            lx = lanes[j]
            pts = [V((sx * 0.235, y, 0.560)), V((sx * 0.300, y, 0.548))]
            pts += _bezier(V((sx * 0.300, y, 0.548)), V((sx * 0.360, y, 0.540)), V((sx * lx, y - 0.020, 0.500)),
                           V((sx * lx, y - 0.080, 0.445)), 4)[1:]
            pts += [V((sx * lx, -1.500, 0.445))]
            pts += _bezier(V((sx * lx, -1.500, 0.445)), V((sx * lx, -1.560, 0.450)), V((sx * 0.395, -1.575, 0.480)),
                           col_start, 3)[1:]
            k.tube(pts, 0.016, 6, 'hardware', True)
        path = [col_start] + _bezier(col_start, V((sx * 0.395, -1.660, 0.560)), V((sx * 0.330, -1.740, 0.620)),
                                     V((sx * 0.300, Y_REAR + 0.004, 0.620)), 5)[1:]
        k.tube(path, [0.040] + [0.034] * (len(path) - 1), 10, 'hardware', True)

    # gearbox behind the engine, above the diffuser tunnel
    gb = [(-0.150, 0.540), (0.150, 0.540), (0.180, 0.575), (0.180, 0.680), (0.120, 0.740), (-0.120, 0.740), (-0.180, 0.680), (-0.180, 0.575)]
    k.prism(gb, y1, -1.835, 'mechanical')
    k.prism([(x * 1.08, 0.53 + (z - 0.54) * 1.05) for x, z in gb], y1 + 0.004, y1 - 0.035, 'rim_dark')

    # strut tops on the shelf, a cross brace between them and an A-brace to the rear wall
    for sx in (-1, 1):
        k.disc((sx * TOWER_X, BRACE_Y, SHELF_Z + 0.009), (0, 0, 1), 0.052, 0.018, 18, 'hardware', 'hardware')
        k.disc((sx * TOWER_X, BRACE_Y, SHELF_Z + 0.022), (0, 0, 1), 0.022, 0.012, 12, 'mechanical')
    zb = 0.882
    k.tube([V((-TOWER_X, BRACE_Y, zb)), V((TOWER_X, BRACE_Y, zb))], 0.017, 12, 'hardware', True)
    for sx in (-1, 1):
        k.rbox((sx * TOWER_X, BRACE_Y, zb - 0.010), (0.060, 0.050, 0.020), 'hardware', bevel=0.005, segments=1)
        k.tube([V((sx * (TOWER_X - 0.04), BRACE_Y - 0.010, zb)), V((sx * 0.060, Y_REAR + 0.030, 0.862))], 0.015, 10, 'carbon', True)
    k.rbox((0.0, Y_REAR + 0.022, 0.862), (0.150, 0.036, 0.050), 'hardware', bevel=0.006, segments=1)

    obj = k.to_object(ctx, 'BodyEngine', 40)
    util.set_parent(obj, ctx.body)
    return obj


# ── checks ───────────────────────────────────────────────────────────────────────────────────

def check(sk, objs, min_gap=0.015):
    """Vertices too close to (or outside) the skin, and in the other modules' keep-outs."""
    rep = {}
    for o in objs:
        mw = o.matrix_world
        close = outside = tubs = tunnel = tail = 0
        worst = 9.0
        where = []
        for v in o.data.vertices:
            p = mw @ v.co
            loc, n, i, d = sk.bvh.find_nearest(p, 0.06)     # (farther away is an opening: the wheel arches)
            if loc is not None:
                worst = min(worst, d)
                if (p - loc).dot(n) > 0 and not sk.enclosed(p):
                    outside += 1
                    where.append(tuple(round(c, 3) for c in p))
                elif d < min_gap - 0.003:
                    close += 1
                    where.append(tuple(round(c, 3) for c in p))
            if abs(p.x) > 0.64 and -1.86 < p.y < -0.94 and p.z < 0.83:
                tubs += 1
            if p.y < -1.65 and p.z < 0.50:
                tunnel += 1
            if p.y < -1.92:
                tail += 1
        rep[o.name] = dict(tris=util.tri_count(o), nearest_skin=round(worst, 4) if worst < 9 else None, close=close, outside=outside,
                           in_tubs=tubs, in_tunnel=tunnel, behind_tail=tail, examples=where[:6])
    return rep


def build(ctx):
    if ctx.body is None:
        return
    skin = ctx.body
    sk = Skin(skin)
    objs = [liner(ctx, sk), bay_box(ctx, sk), engine(ctx)]
    rep = check(sk, objs)
    sk.free()
    print('[car] bay:', rep)
    return objs
