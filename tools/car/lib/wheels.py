"""
NIGHTSHIFT player car: the four wheels and their brake calipers, generated from nothing but this code.

For every key of spec.WHEELS two objects (parented to ctx.root, origin = hub centre, axle = X):
  Wheel_<key>_Spin     tyre, forged ten-spoke rim, brake disc with its bell, wheel nuts, centre cap
  Wheel_<key>_Caliper  six-piston (front) / four-piston (rear) monobloc caliper with its bracket

Everything is modelled once per axle in a local wheel frame whose outer face points to +X (a right-hand
wheel).  The left wheels are true mirror images (x -> -x, face winding reversed): the directional
spokes turn the other way, the normals stay outward.

Local coordinates used below: a = position along the axle (outward > 0, 0 = centre plane of the tyre),
r = distance from the axle, t = angle in the YZ plane measured from +Y (forward) towards +Z (up).
"""
import math

import bmesh
import bpy
from mathutils import Vector

from . import util

TAU = 2.0 * math.pi
FACE_IN = 0.015          # the rim face sits this far inside the outer sidewall of the tyre
SHARP_DEG = 31.0         # edges sharper than this get split normals

SPIN_MATS = ('tyre_tread', 'tyre_side', 'trim', 'rim_chrome', 'rim_dark', 'mechanical', 'disc', 'hardware')
CALIPER_MATS = ('caliper', 'hardware', 'mechanical')

# Resolution (around the axle).  The tyre silhouette error at 48 sides is 0.8 mm on a 760 mm circle; each of
# the 48 columns carries one shoulder block (SLOT_FRAC of the pitch) and one slot.
N_TYRE = 48
SLOT_FRAC = 0.74
N_RIM = 64
N_HUB = 36
N_BELL = 32
N_DISC = 48
N_DISH = 32

DEBUG = {}               # filled per axle for the test driver (clearances, envelopes)


# ── small mesh accumulator ────────────────────────────────────────────────────────────────────

def polar(a, r, t, cy=0.0, cz=0.0):
    return (a, cy + r * math.cos(t), cz + r * math.sin(t))


class Part:
    """Plain lists: vertices, faces, one material NAME per face."""

    def __init__(self):
        self.v = []
        self.f = []
        self.m = []

    def vert(self, p):
        self.v.append((float(p[0]), float(p[1]), float(p[2])))
        return len(self.v) - 1

    def face(self, idx, mat):
        out = []
        for i in idx:
            if not out or out[-1] != i:
                out.append(i)
        if len(out) > 1 and out[0] == out[-1]:
            out.pop()
        if len(out) >= 3:
            self.f.append(tuple(out))
            self.m.append(mat)
            return len(self.f) - 1
        return None

    def extend(self, other):
        off = len(self.v)
        self.v.extend(other.v)
        for f, m in zip(other.f, other.m):
            self.f.append(tuple(i + off for i in f))
            self.m.append(m)
        return self

    def lathe_slotted(self, block, slot, n, mats, slot_mat, frac, t0=0.0):
        """
        Like lathe() (same winding), but every column is split at `frac`: from its start to frac it follows
        `block`, from frac to the next column it follows `slot` (same length as block; where the two agree the
        surface is plain).  Walls close the slot on both sides.  The split points lie on the chords between the
        columns, and the rows next to a slot carry them too, so no T-junction opens a crack.
        """
        np_ = len(block)
        cut = [math.dist(block[i], slot[i]) > 1e-7 for i in range(np_)]
        segcut = [cut[i] or cut[i + 1] for i in range(np_ - 1)]
        ts = [t0 + TAU * j / n for j in range(n)]
        V = [[self.vert(polar(a, r, t)) for t in ts] for a, r in block]

        def chord(prof, i, j, f):
            a, r = prof[i]
            p0, p1 = Vector(polar(a, r, ts[j])), Vector(polar(a, r, ts[(j + 1) % n]))
            return p0.lerp(p1, f)

        for j in range(n):
            j1 = (j + 1) % n
            tmid = Vector((0.0, -math.sin(ts[j] + TAU * frac / n), math.cos(ts[j] + TAU * frac / n)))
            tend = Vector((0.0, -math.sin(ts[j1]), math.cos(ts[j1])))
            SA, SB, EB = {}, {}, {}
            for i in range(np_):
                used = (i > 0 and segcut[i - 1]) or (i < np_ - 1 and segcut[i])
                if not used:
                    continue
                SA[i] = self.vert(chord(block, i, j, frac))
                SB[i] = self.vert(chord(slot, i, j, frac)) if cut[i] else SA[i]
                EB[i] = self.vert(polar(slot[i][0], slot[i][1], ts[j1])) if cut[i] else V[i][j1]
            for i in range(np_ - 1):
                i1 = i + 1
                if not segcut[i]:
                    ring = [V[i][j]] + ([SA[i]] if i in SA else []) + [V[i][j1], V[i1][j1]] + \
                           ([SA[i1]] if i1 in SA else []) + [V[i1][j]]
                    self.face(ring, mats[i])
                    continue
                self.face((V[i][j], SA[i], SA[i1], V[i1][j]), mats[i])
                self.face((SB[i], EB[i], EB[i1], SB[i1]), slot_mat)
                for quad, want in (((SA[i], SB[i], SB[i1], SA[i1]), tmid), ((EB[i], V[i][j1], V[i1][j1], EB[i1]), -tend)):
                    fi = self.face(quad, slot_mat)
                    if fi is not None and self.face_normal(fi).dot(want) < 0:
                        self.f[fi] = tuple(reversed(self.f[fi]))

    def lathe(self, prof, n, mats, off=None, t0=0.0, closed=False, centre=(0.0, 0.0)):
        """
        Surface of revolution around an axis parallel to X through (y, z) = centre.
        prof: [(a, r)], mats: one name or one per segment (None = leave that segment out).
        Winding: the outside of the surface is on the LEFT of the profile's direction of travel
        in the (a right, r up) plane.  Points with r == 0 become a single pole vertex.
        Returns {(segment, column): face index}.
        """
        cy, cz = centre
        rows = []
        for i, (a, r) in enumerate(prof):
            if r <= 1e-9:
                k = self.vert((a, cy, cz))
                rows.append([k] * n)
            else:
                o = off[i] if off else 0.0
                rows.append([self.vert(polar(a, r, t0 + TAU * j / n + o, cy, cz)) for j in range(n)])
        np_ = len(prof)
        segs = np_ if closed else np_ - 1
        cell = {}
        for i in range(segs):
            i1 = (i + 1) % np_
            mat = mats if isinstance(mats, str) else mats[i]
            if mat is None:
                continue
            for j in range(n):
                j1 = (j + 1) % n
                fi = self.face((rows[i][j], rows[i][j1], rows[i1][j1], rows[i1][j]), mat)
                if fi is not None:
                    cell[(i, j)] = fi
        return cell

    def loft(self, loops, mats, cap_start=None, cap_end=None):
        """Quads between consecutive closed loops (all the same length); optional n-gon caps."""
        n = len(loops[0])
        rows = [[self.vert(p) for p in lp] for lp in loops]
        cell = {}
        for k in range(len(rows) - 1):
            for i in range(n):
                i1 = (i + 1) % n
                mat = mats if isinstance(mats, str) else mats[i]
                if mat is None:
                    continue
                fi = self.face((rows[k][i], rows[k][i1], rows[k + 1][i1], rows[k + 1][i]), mat)
                if fi is not None:
                    cell[(k, i)] = fi
        if cap_start:
            self.face(list(reversed(rows[0])), cap_start)
        if cap_end:
            self.face(rows[-1], cap_end)
        return cell

    def mirrored(self):
        """Mirror x -> -x; the winding is reversed so that the normals stay outward."""
        o = Part()
        o.v = [(-x, y, z) for x, y, z in self.v]
        o.f = [tuple(reversed(f)) for f in self.f]
        o.m = list(self.m)
        return o

    def reversed_faces(self, start=0):
        for k in range(start, len(self.f)):
            self.f[k] = tuple(reversed(self.f[k]))

    def face_normal(self, k):
        f = self.f[k]
        p = [Vector(self.v[i]) for i in f]
        nrm = Vector((0, 0, 0))
        for i in range(len(p)):
            a, b = p[i], p[(i + 1) % len(p)]
            nrm += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
        return nrm.normalized() if nrm.length > 0 else nrm

    def face_centre(self, k):
        f = self.f[k]
        c = Vector((0, 0, 0))
        for i in f:
            c += Vector(self.v[i])
        return c / len(f)

    # bmesh round trip (for insets) ----------------------------------------------------------
    def to_bmesh(self, names):
        bm = bmesh.new()
        vs = [bm.verts.new(p) for p in self.v]
        idx = {n: i for i, n in enumerate(names)}
        for f, m in zip(self.f, self.m):
            bf = bm.faces.new([vs[i] for i in f])
            bf.material_index = idx[m]
        bm.verts.ensure_lookup_table()
        bm.faces.ensure_lookup_table()
        bm.normal_update()
        return bm

    @staticmethod
    def from_bmesh(bm, names):
        o = Part()
        bm.verts.index_update()
        o.v = [tuple(v.co) for v in bm.verts]
        for bf in bm.faces:
            o.f.append(tuple(v.index for v in bf.verts))
            o.m.append(names[bf.material_index])
        return o

    @staticmethod
    def from_mesh(me, names):
        o = Part()
        o.v = [tuple(v.co) for v in me.vertices]
        for p in me.polygons:
            o.f.append(tuple(p.vertices))
            o.m.append(names[min(p.material_index, len(names) - 1)])
        return o

    def compact(self):
        """Drop vertices that no face uses."""
        used = sorted({i for f in self.f for i in f})
        remap = {old: new for new, old in enumerate(used)}
        self.v = [self.v[i] for i in used]
        self.f = [tuple(remap[i] for i in f) for f in self.f]
        return self

    def tris(self):
        return sum(len(f) - 2 for f in self.f)


def to_object(part, name, ctx, order, sharp=SHARP_DEG):
    used = [n for n in order if n in set(part.m)]
    idx = {n: i for i, n in enumerate(used)}
    me = bpy.data.meshes.new(name)
    me.from_pydata(part.v, [], part.f)
    for n in used:
        me.materials.append(ctx.mat(n))
    me.polygons.foreach_set('material_index', [idx[m] for m in part.m])
    me.validate(verbose=False)
    me.update()
    obj = bpy.data.objects.new(name, me)
    util.link(obj, ctx.col)
    util.shade(obj, True, sharp)
    return obj


def smoothstep(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


# ── per-axle numbers ──────────────────────────────────────────────────────────────────────────

def dims(S, front):
    w = S.TYRE_W_F if front else S.TYRE_W_R
    w2 = w / 2
    d = dict(front=front, w=w, w2=w2, af=w2 - FACE_IN, R=S.WHEEL_R, lip=S.RIM_R)
    if front:
        d.update(a_h=0.060, r_o=0.200, r_i=0.122, a_dc=-0.035, grooves=(-0.50, 0.0, 0.50), ribs=(-0.25, 0.25),
                 gw=0.0130)
    else:
        d.update(a_h=0.066, r_o=0.190, r_i=0.117, a_dc=-0.029, grooves=(-0.57, -0.19, 0.19, 0.57), ribs=(0.0,),
                 gw=0.0140)
    d['a_hb'] = d['a_h'] - 0.030          # back face of the rim centre = hub mounting face
    d['barrel_r'] = 0.2458
    return d


# ── tyre ──────────────────────────────────────────────────────────────────────────────────────

def tyre_profile(D):
    """
    Half section of the tyre, car side -> outer side: [(a, r, slot depth, material of the segment to the next
    point)].  Circumferential grooves with dark walls and floor; on the outer shoulder the slot depth says how far
    each point sinks between two shoulder blocks; the outer sidewall carries the bulge with the
    lettering band and a rim-protector rib that stands proud of the rim lip.
    """
    R, w2, af = D['R'], D['w2'], D['af']
    tw = w2 - 0.019                       # half width of the tread band
    gd = 0.0085                           # groove depth
    gw = D['gw']
    G = 'trim'                            # groove walls and floors: darker than the rubber on top (reads as depth)

    def crown(a):
        return R - 0.0018 * (a / tw) ** 2

    P = []

    def add(a, r, mat, depth=0.0):
        P.append([a, r, depth, mat])

    # car side: bead (hidden under the rim flange) up to the tread edge
    for a, r in [(-(af - 0.016), 0.2648), (-(af - 0.004), 0.2730), (-(w2 - 0.0035), 0.2900),
                 (-w2, 0.3240), (-(w2 - 0.0012), 0.3540), (-(w2 - 0.0050), 0.3685)]:
        add(a, r, 'tyre_side')
    add(-(w2 - 0.0118), 0.3757, 'tyre_tread')
    add(-tw, crown(-tw), 'tyre_tread')
    for a, kind in sorted([(g * tw, 'g') for g in D['grooves']] + [(c * tw, 'c') for c in D['ribs']]):
        if kind == 'c':
            add(a, crown(a), 'tyre_tread')
            continue
        lo, hi = a - gw / 2, a + gw / 2
        add(lo, crown(lo), G)
        add(lo + 0.0015, R - gd, G)
        add(hi - 0.0015, R - gd, G)
        add(hi, crown(hi), 'tyre_tread')
    # outer shoulder: the slots of the shoulder blocks start on the crown and run out on the sidewall
    s0 = tw - 0.0175
    add(s0, crown(s0), 'tyre_tread')
    add(s0 + 0.0025, crown(s0 + 0.0025), 'tyre_tread', 0.0068)
    add(tw, crown(tw), 'tyre_tread', 0.0068)
    add(w2 - 0.0105, 0.3752, 'tyre_side', 0.0060)
    add(w2 - 0.0030, 0.3650, 'tyre_side', 0.0034)
    add(w2 - 0.0004, 0.3495, 'tyre_side')
    # outer sidewall: bulge (lettering band), rim-protector rib, bead
    for a, r in [(w2 + 0.0004, 0.3410),
                 (w2 + 0.0002, 0.3250), (w2 - 0.0012, 0.3060), (w2 - 0.0032, 0.2960),
                 (w2 - 0.0030, 0.2908), (w2 - 0.0002, 0.2890), (w2, 0.2850), (w2 - 0.0012, 0.2824),
                 (w2 - 0.0058, 0.2800), (w2 - 0.0100, 0.2774), (af + 0.0003, 0.2745), (af - 0.006, 0.2721),
                 (af - 0.016, 0.2648)]:
        add(a, r, 'tyre_side')
    return P


def _sidewall_a(P, r):
    """Axial position of the outer sidewall at radius r (the lettering band on the bulge)."""
    out = [(a, rr) for a, rr, d, m in P if a > 0 and 0.30 < rr < 0.345]
    out.sort(key=lambda p: p[1])
    for (a0, r0), (a1, r1) in zip(out, out[1:]):
        if r0 <= r <= r1:
            return a0 + (a1 - a0) * (r - r0) / (r1 - r0)
    return out[-1][0]


# Abstract sidewall marking: groups of blocky dashes (no letters, no words).  Each glyph: (width mm, kind)
# kind 'F' full height, 'L' low (the lower 2/3), 'S' split in two with a gap, 'T' top 1/3 only.
_GLYPHS = [
    [(9, 'F'), (6, 'S'), (10, 'F'), (7, 'L'), (11, 'F'), (6, 'S')],
    [(7, 'F'), (12, 'L'), (6, 'S'), (9, 'F')],
    [(11, 'F'), (6, 'L'), (6, 'L'), (9, 'S'), (8, 'F'), (12, 'L'), (7, 'F')],
]
_SMALL = [[(5, 'F'), (5, 'F'), (5, 'F')], [(4, 'S'), (5, 'F')], [(5, 'F'), (5, 'L')]]


def lettering(D, P):
    """Raised blocks (1 mm proud, 18 mm tall) in two arcs on the outer sidewall, a small group between them."""
    out = Part()
    sink, proud = 0.0006, 0.0010

    def block(t0, t1, r0, r1):
        ts, rs = (t0, t1, t1, t0), (r0, r0, r1, r1)
        lo = [out.vert(polar(_sidewall_a(P, r) - sink, r, t)) for t, r in zip(ts, rs)]
        hi = [out.vert(polar(_sidewall_a(P, r) + proud, r, t)) for t, r in zip(ts, rs)]
        tc, rc = (t0 + t1) / 2, (r0 + r1) / 2
        c = Vector(polar(_sidewall_a(P, rc), rc, tc))
        faces = [hi] + [[lo[k], lo[(k + 1) % 4], hi[(k + 1) % 4], hi[k]] for k in range(4)]
        for k, f in enumerate(faces):
            fi = out.face(f, 'tyre_side')
            if fi is None:
                continue
            want = Vector((1, 0, 0)) if k == 0 else (out.face_centre(fi) - c)
            if k:
                want.x = 0.0
            if out.face_normal(fi).dot(want) < 0:
                out.f[fi] = tuple(reversed(out.f[fi]))

    def write(words, t_start, r0, h, gap, word_gap):
        s = 0.0
        rm = r0 + h / 2
        for w in words:
            for width, kind in w:
                t0 = t_start + s / rm
                t1 = t_start + (s + width / 1000) / rm
                if kind == 'F':
                    block(t0, t1, r0, r0 + h)
                elif kind == 'L':
                    block(t0, t1, r0, r0 + h * 0.66)
                elif kind == 'T':
                    block(t0, t1, r0 + h * 0.66, r0 + h)
                else:
                    block(t0, t1, r0, r0 + h * 0.40)
                    block(t0, t1, r0 + h * 0.60, r0 + h)
                s += width / 1000 + gap
            s += word_gap
        return s

    def length(words, gap, word_gap):
        return sum(sum(wd / 1000 + gap for wd, k in w) + word_gap for w in words) - word_gap - gap

    r0, h = 0.317, 0.018
    for base in (0.0, math.pi):
        L = length(_GLYPHS, 0.003, 0.014)
        write(_GLYPHS, base - L / 2 / (r0 + h / 2), r0, h, 0.003, 0.014)
        Ls = length(_SMALL, 0.0025, 0.008)
        write(_SMALL, base + math.pi / 2 - Ls / 2 / (r0 + 0.004), r0 + 0.0, 0.008, 0.0025, 0.008)
    return out


def tyre(D):
    P = tyre_profile(D)
    block = [(a, r) for a, r, d, m in P]
    mats = [m for a, r, d, m in P][:-1]
    # the slot variant: each point sinks along the inward normal of the section
    slot = []
    for i, (a, r, d, m) in enumerate(P):
        if d <= 0:
            slot.append((a, r))
            continue
        a0, r0 = block[max(0, i - 1)]
        a1, r1 = block[min(len(block) - 1, i + 1)]
        ta, tr = a1 - a0, r1 - r0
        L = math.hypot(ta, tr)
        slot.append((a + d * tr / L, r - d * ta / L))     # right of the direction of travel = inside
    p = Part()
    p.lathe_slotted(block, slot, N_TYRE, mats, 'trim', SLOT_FRAC, t0=TAU / N_TYRE * 0.5)
    p.extend(lettering(D, P))
    return p


# ── rim: lip, barrel, inner dish ──────────────────────────────────────────────────────────────

def rim_shell(D):
    w2, af = D['w2'], D['af']
    br = D['barrel_r']
    C, K = 'rim_chrome', 'rim_dark'
    prof = [
        (af - 0.020, 0.2655),                  # under the tyre bead
        (af - 0.009, 0.2700),
        (af - 0.0030, 0.2721),                 # rounded top of the flange
        (af, 0.2692),
        (af, 0.2614),                          # machined outer face of the lip
        (af - 0.0012, 0.2600),
        (af - 0.0056, 0.2593),                 # step down
        (af - 0.0064, 0.2580),
        (af - 0.0064, 0.2537),                 # second machined ring
        (af - 0.0082, 0.2520),
        (af - 0.0165, 0.2476),                 # chamfer into the well
        (af - 0.0300, br),
        (-(w2 - 0.040), br - 0.0003),          # barrel
        (-(af + 0.001), 0.2560),               # inner flange (car side)
        (-(af - 0.004), 0.2712),
        (-(af - 0.020), 0.2655),
    ]
    mats = [K, C, C, C, C, C, C, C, C, K, K, K, K, K, K]
    p = Part()
    p.lathe(prof, N_RIM, mats)
    # dark dish behind the brake: you never look through the wheel into nothing
    ad = -(w2 - 0.034)
    p.lathe([(ad, br + 0.004), (ad, 0.150), (ad - 0.004, 0.090)], N_DISH, 'mechanical')
    p.lathe([(ad - 0.005, 0.0), (ad - 0.005, 0.0905), (ad - 0.0012, 0.150), (ad - 0.0012, br + 0.004)], N_DISH,
            'mechanical')
    return p


def hub_centre(D, ctx):
    """Closed centre of the rim with five recessed nut pockets (exact boolean), cap and nuts."""
    a_h, a_hb = D['a_h'], D['a_hb']
    prof = [
        (a_hb, 0.0), (a_hb, 0.0860), (a_hb + 0.0030, 0.0905), (a_h - 0.0060, 0.0915),
        (a_h + 0.0035, 0.0858), (a_h + 0.0040, 0.0815), (a_h + 0.0008, 0.0772), (a_h, 0.0748),
        (a_h, 0.0345), (a_h - 0.0012, 0.0330), (a_h - 0.0080, 0.0326), (a_h - 0.0080, 0.0),
    ]
    K, C = 'rim_dark', 'rim_chrome'
    mats = [K, K, K, K, C, C, K, K, K, K, K]
    hub = Part()
    hub.lathe(prof, N_HUB, mats, t0=math.radians(36.0) + math.pi / N_HUB)
    names = [K, C]
    hub_obj = to_object(hub, '_wheel_hub_tmp', ctx, names, sharp=None)
    pcd = 0.0585
    rp = 0.0136
    floor = a_h - 0.016
    cutters = []
    for k in range(5):
        t = math.radians(36.0 + 72.0 * k)
        cy, cz = pcd * math.cos(t), pcd * math.sin(t)
        c = Part()
        c.lathe([(floor, 0.0), (floor, rp), (a_h - 0.0025, rp), (a_h + 0.0012, rp + 0.0034),
                 (a_h + 0.02, rp + 0.0034), (a_h + 0.02, 0.0)], 12, K, centre=(cy, cz), t0=t)
        co = to_object(c, f'_wheel_cut_tmp{k}', ctx, names, sharp=None)
        co.hide_render = True
        cutters.append(co)
        m = hub_obj.modifiers.new(f'cut{k}', 'BOOLEAN')
        m.operation = 'DIFFERENCE'
        m.solver = 'EXACT'
        m.object = co
        try:
            m.material_mode = 'INDEX'
        except Exception:
            pass
    util.apply_modifiers(hub_obj)
    out = Part.from_mesh(hub_obj.data, [s.name.split('.')[0] for s in hub_obj.data.materials])
    keep = Part()
    keep.v = out.v
    for f, m in zip(out.f, out.m):
        if max(out.v[i][0] for i in f) > a_hb + 1e-5:      # the back face (against the bell) is never seen
            keep.f.append(f)
            keep.m.append(m)
    out = keep.compact()
    for o in cutters + [hub_obj]:
        me = o.data
        bpy.data.objects.remove(o)
        if me.users == 0:
            bpy.data.meshes.remove(me)
    # nuts (hexagon with a chamfered top) sitting at the bottom of the pockets
    for k in range(5):
        t = math.radians(36.0 + 72.0 * k)
        cy, cz = pcd * math.cos(t), pcd * math.sin(t)
        top = a_h - 0.0030
        out.lathe([(floor, 0.0103), (top - 0.0018, 0.0103), (top, 0.0080), (top, 0.0)], 6, 'hardware',
                  centre=(cy, cz), t0=t)
    # plain centre cap
    out.lathe([(a_h - 0.0075, 0.0312), (a_h + 0.0022, 0.0312), (a_h + 0.0042, 0.0294), (a_h + 0.0058, 0.0245),
               (a_h + 0.0067, 0.0130), (a_h + 0.0069, 0.0)], 24, 'hardware')
    return out


# ── spokes ────────────────────────────────────────────────────────────────────────────────────

def spokes(D):
    """
    Ten forged spokes in five pairs.  Each spoke falls from the lip towards the hub (concave face),
    leans in the direction of rotation (directional: the left wheels get the mirror image), and has a
    real section: machined top face, chamfers, drafted sides with a milled pocket, a flat back.
    """
    af, a_h = D['af'], D['a_h']
    rear = not D['front']
    r0, rL = 0.066, 0.2525
    a0 = a_h + 0.0085                      # top of the spoke at the hub
    aL = af - 0.0076                       # top of the spoke where it meets the lip (just under the step ring)
    # concave face: the spoke runs almost flat out of the hub and sweeps up into the lip; against the straight
    # line from root to lip the face sags 1.4 cm (front) / 2.2 cm (rear) at mid span
    gamma = 2.6
    phiH, phiL = math.radians(5.2), math.radians(12.4)
    lean = math.radians(4.0)
    out = Part()
    K, C = 'rim_dark', 'rim_chrome'
    rs = [0.066, 0.100, 0.130, 0.155, 0.176, 0.195, 0.212, 0.226, 0.238, 0.2475, 0.2575]

    def path(r):
        x = min(1.0, max(0.0, (r - r0) / (rL - r0)))
        return a0 + (aL - a0) * x ** gamma

    for pair in range(5):
        tc = math.radians(72.0 * pair)
        for s in (-1.0, 1.0):
            def theta(r):
                t = min(1.0, max(0.0, (r - r0) / (rL - r0)))
                return tc + s * (phiH + (phiL - phiH) * smoothstep(0.0, 1.0, t)) + lean * t ** 1.4

            def P(r):
                return Vector(polar(path(r), r, theta(r)))

            loops = []
            for r in rs:
                p = P(r)
                dr = 0.002
                T = (P(r + dr) - P(r - dr)).normalized()
                th = theta(r)
                et = Vector((0.0, -math.sin(th), math.cos(th)))
                u = (et - et.dot(T) * T).normalized()
                v = T.cross(u)
                if v.x < 0:
                    v = -v
                # section along the spoke: tapers from 3.0 cm at the hub to 1.6 cm at the rim, with a short
                # fillet into the lip
                x = min(1.0, max(0.0, (r - r0) / (rL - r0)))
                W = 0.0300 - 0.0140 * x ** 0.9 + 0.0075 * smoothstep(0.236, 0.2575, r)
                H = 0.0330 - 0.0090 * smoothstep(0.066, 0.236, r) + 0.0100 * smoothstep(0.236, 0.256, r)
                if rear:
                    W *= 1.07
                    H *= 1.10
                c = 0.0021                                     # chamfer: 2 mm wide, 40 degrees off the face
                ch = c * 0.84                                  # (a crisp facet: sharper than SHARP_DEG)
                cr = 0.0006                                    # the machined face is crowned along its middle
                sd = 0.0030                                    # draft of the sides
                pk = 0.0030 * smoothstep(0.095, 0.130, r) * (1.0 - smoothstep(0.205, 0.232, r))   # pocket depth
                half = [(W / 2 - c, 0.0), (W / 2, -ch), (W / 2 + 0.20 * sd, -0.28 * H),
                        (W / 2 + 0.25 * sd - pk, -0.44 * H), (W / 2 + 0.55 * sd - pk, -0.68 * H),
                        (W / 2 + sd - 0.0025, -H)]
                sec = [(0.0, cr)] + half + [(-x_, y) for x_, y in reversed(half)]
                loops.append([p + x_ * u + y * v for x_, y in sec])
            n = len(loops[0])
            mats = [K] * n
            # machined top (two halves of the crown) and its two chamfers
            mats[0] = mats[1] = mats[n - 1] = mats[n - 2] = C
            start = len(out.f)
            out.loft(loops, mats)
            # outward check on a top face of the middle section
            k = start + (len(rs) // 2) * n + (n - 1)
            if out.face_normal(k).x < 0:
                out.reversed_faces(start)
    return out


# ── brake: disc, bell, bobbins ────────────────────────────────────────────────────────────────

def brake_disc(D):
    r_o, r_i, a_dc = D['r_o'], D['r_i'], D['a_dc']
    a_f, a_b = a_dc + 0.017, a_dc - 0.017
    rv = r_o - 0.028                                    # floor of the ventilation slot
    face_r = [r_o - 0.0025, r_o - 0.018, r_o - 0.033, r_o - 0.048, r_o - 0.063, r_i + 0.0015]
    prof = [(a_b, r_i), (a_b, r_o - 0.0025),
            (a_b + 0.0025, r_o), (a_b + 0.0110, r_o), (a_b + 0.0110, rv), (a_f - 0.0110, rv),
            (a_f - 0.0110, r_o), (a_f - 0.0025, r_o)]
    first_face = len(prof)
    prof += [(a_f, r) for r in face_r]
    prof += [(a_f - 0.0015, r_i)]
    Dm, M = 'disc', 'mechanical'
    mats = [Dm, Dm, Dm, Dm, M, Dm, Dm, Dm] + [Dm] * len(face_r) + [Dm]
    k = 4.6                                              # spiral of the slot rows (rad per metre)
    off = [k * (r - r_i) for a, r in prof]
    p = Part()
    cell = p.lathe(prof, N_DISC, mats, off=off, closed=True)
    # slots: every 5th column, alternating outer and inner rows
    bm = p.to_bmesh(SPIN_MATS)
    slots = []
    for s in range(12):
        j = s * 4
        rows = (0, 1, 2, 3) if s % 2 == 0 else (1, 2, 3, 4)
        slots.append([bm.faces[cell[(first_face + rr, j)]] for rr in rows])
    mi = SPIN_MATS.index('mechanical')
    for region in slots:
        bmesh.ops.inset_region(bm, faces=region, thickness=0.0052, depth=0.0, use_even_offset=True)
        bmesh.ops.inset_region(bm, faces=region, thickness=0.0004, depth=0.0, use_even_offset=True)
        vs = {v for f in region for v in f.verts}
        bmesh.ops.translate(bm, vec=(-0.0028, 0.0, 0.0), verts=list(vs))
        for f in region:
            f.material_index = mi
    out = Part.from_bmesh(bm, SPIN_MATS)
    bm.free()
    # vanes between the two plates (seen through the slot in the edge)
    nv = 24
    for j in range(nv):
        t = TAU * (j + 0.5) / nv + k * (r_o - r_i)
        hw = 0.0021
        a0, a1 = a_b + 0.0105, a_f - 0.0105
        rA, rB = rv - 0.001, r_o - 0.0018
        def P(a, r, side):
            return polar(a, r, t + side * hw / r)
        vs = [out.vert(P(a0, rA, -1)), out.vert(P(a1, rA, -1)), out.vert(P(a1, rB, -1)), out.vert(P(a0, rB, -1)),
              out.vert(P(a0, rA, 1)), out.vert(P(a1, rA, 1)), out.vert(P(a1, rB, 1)), out.vert(P(a0, rB, 1))]
        for f, want in (((0, 1, 2, 3), -1), ((4, 7, 6, 5), 1), ((3, 2, 6, 7), 0)):
            fi = out.face([vs[i] for i in f], 'disc')
            nrm = out.face_normal(fi)
            c = out.face_centre(fi)
            radial = Vector((0, c.y, c.z)).normalized()
            tang = Vector((0, -math.sin(t), math.cos(t)))
            ref = radial if want == 0 else tang * want
            if nrm.dot(ref) < 0:
                out.f[fi] = tuple(reversed(out.f[fi]))
    # bell (hat) and the bobbins that float the disc on it
    a_hb = D['a_hb']
    out.lathe([(a_dc - 0.0100, 0.0950), (a_dc - 0.0100, r_i - 0.0015), (a_dc + 0.0100, r_i - 0.0015),
               (a_dc + 0.0100, 0.0965), (a_hb - 0.0060, 0.0935), (a_hb - 0.0012, 0.0888), (a_hb - 0.0012, 0.0800)],
              N_BELL, 'mechanical')
    rb = r_i - 0.0008
    for j in range(10):
        t = TAU * j / 10 + math.radians(18)
        cy, cz = rb * math.cos(t), rb * math.sin(t)
        out.lathe([(a_dc - 0.0185, 0.0), (a_dc - 0.0185, 0.0056), (a_dc + 0.0175, 0.0056), (a_dc + 0.0188, 0.0044),
                   (a_dc + 0.0190, 0.0)], 6, 'hardware', centre=(cy, cz))
    return out


# ── caliper ───────────────────────────────────────────────────────────────────────────────────

def caliper(D):
    front = D['front']
    r_o, a_dc = D['r_o'], D['a_dc']
    span = math.radians(98.0 if front else 76.0)
    tc = math.radians(170.0 if front else 12.0)        # front: behind the axle, rear: in front of it
    pist = (-0.58, 0.0, 0.58) if front else (-0.42, 0.42)
    Lt = 0.030 if front else 0.027
    rl0 = r_o - (0.068 if front else 0.060)
    rh0 = r_o + 0.031
    rb = r_o + 0.0065
    ao = a_dc + 0.017 + 0.0045
    ai = a_dc - 0.017 - 0.0045
    M = 26 if front else 22

    def shape(u):
        x = min(1.0, max(0.0, (abs(u) - 0.60) / 0.40)) * 0.93
        q = (1.0 - math.sqrt(1.0 - x * x)) / (1.0 - math.sqrt(1.0 - 0.93 ** 2))     # 0 .. 1 at the very end
        bump = min(1.0, sum(math.exp(-((u - pp) / 0.155) ** 2) for pp in pist))
        lt = Lt * (1.0 - 0.55 * q)
        rl = rl0 + ((r_o - 0.004) - rl0) * q - 0.012 * bump * (1.0 - q)
        rh = rh0 - 0.008 * q
        ch = 0.0055 * (1.0 - 0.35 * q)
        b = 0.0068 * bump * (1.0 - q)
        crown = 0.0040 * (1.0 - q)
        return lt, rl, rh, ch, b, crown, q

    loops = []
    us = [-math.cos(math.pi * k / M) for k in range(M + 1)]
    for u in us:
        t = tc + u * span / 2
        lt, rl, rh, ch, b, crown, q = shape(u)
        aO, aI = ao + lt, ai - lt
        hh = rh - rl
        prof = [
            (ao, rl + 0.003), (ao + 0.003, rl),
            (aO - ch, rl), (aO, rl + ch),                                  # crisp cast chamfers
            (aO + 0.45 * b, rl + 0.24 * hh), (aO + b, rl + 0.47 * hh), (aO + 0.55 * b, rl + 0.70 * hh),
            (aO + 0.08 * b, rh - 1.6 * ch), (aO, rh - ch), (aO - ch, rh),
            (a_dc + 0.42 * (aO - a_dc), rh + crown), (a_dc + 0.42 * (aI - a_dc), rh + crown),
            (aI + ch, rh), (aI, rh - ch),
            (aI, rl + ch), (aI + ch, rl),
            (ai - 0.003, rl), (ai, rl + 0.003),
            (ai, rb), (ao, rb),
        ]
        loops.append([polar(a, r, t) for a, r in prof])
    p = Part()
    n = len(loops[0])
    cell = p.loft(loops, 'caliper', cap_start='caliper', cap_end='caliper')
    bm = p.to_bmesh(CALIPER_MATS)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    panel = [bm.faces[cell[(k, i)]] for k in range(M) for i in (3, 4, 5, 6)
             if abs((us[k] + us[k + 1]) / 2) < 0.66]
    # pad window in the bridge
    win = [bm.faces[cell[(k, 10)]] for k in range(M) if abs((us[k] + us[k + 1]) / 2) < 0.52]
    bmesh.ops.inset_region(bm, faces=win, thickness=0.0032, depth=0.0, use_even_offset=True)
    bmesh.ops.inset_region(bm, faces=win, thickness=0.0003, depth=-0.0050, use_even_offset=True)
    mi = CALIPER_MATS.index('mechanical')
    for f in win:
        f.material_index = mi
    # raised, crisply edged panel on the outer face (where a maker would put a logo: left plain)
    bmesh.ops.inset_region(bm, faces=panel, thickness=0.0045, depth=0.0, use_even_offset=True)
    bmesh.ops.inset_region(bm, faces=panel, thickness=0.0008, depth=0.0016, use_even_offset=True)
    out = Part.from_bmesh(bm, CALIPER_MATS)
    bm.free()
    # bolts on the outer face (hex heads with a washer)
    for ub in ((-0.29, 0.29) if front else (-0.76, 0.76)):
        t = tc + ub * span / 2
        lt, rl, rh, ch, b, crown, q = shape(ub)
        rr = rl + 0.80 * (rh - rl)
        af_ = ao + lt + 0.10 * b
        cy, cz = rr * math.cos(t), rr * math.sin(t)
        out.lathe([(af_ - 0.003, 0.0112), (af_ + 0.0014, 0.0112), (af_ + 0.0018, 0.0090)], 12, 'hardware',
                  centre=(cy, cz))
        out.lathe([(af_ + 0.0018, 0.0090), (af_ + 0.0078, 0.0090), (af_ + 0.0092, 0.0072), (af_ + 0.0092, 0.0)], 6,
                  'hardware', centre=(cy, cz), t0=t)
    # radial-mount bracket behind the caliper (car side), with two lugs reaching towards the hub
    bl = []
    nb = 12
    for k in range(nb + 1):
        u = -0.86 + 1.72 * k / nb
        t = tc + u * span / 2
        lt, rl, rh, ch, b, crown, q = shape(u)
        lug = smoothstep(0.45, 0.80, abs(u))
        r_lo = rl0 - 0.010 - 0.032 * lug
        r_hi = rl0 + 0.026
        a1 = ai - Lt - 0.001
        a0 = a1 - 0.008
        bl.append([polar(a, r, t) for a, r in ((a0, r_lo), (a1, r_lo), (a1, r_hi), (a0, r_hi))])
    br = Part()
    br.loft(bl, 'mechanical', cap_start='mechanical', cap_end='mechanical')
    bm = br.to_bmesh(CALIPER_MATS)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    out.extend(Part.from_bmesh(bm, CALIPER_MATS))
    bm.free()
    return out


# ── assembly ──────────────────────────────────────────────────────────────────────────────────

def build_axle(ctx, front):
    S = ctx.spec
    D = dims(S, front)
    spin = Part()
    pieces = {}
    for name, fn in (('tyre', lambda: tyre(D)), ('rim', lambda: rim_shell(D)), ('hub', lambda: hub_centre(D, ctx)),
                     ('spokes', lambda: spokes(D)), ('brake', lambda: brake_disc(D))):
        part = fn()
        pieces[name] = part.tris()
        spin.extend(part)
    cal = caliper(D)
    pieces['caliper'] = cal.tris()
    DEBUG['front' if front else 'rear'] = dict(D=D, pieces=pieces)
    return spin, cal, pieces


def build(ctx):
    S = ctx.spec
    out = []
    axles = {True: build_axle(ctx, True), False: build_axle(ctx, False)}
    for key, (x, y, w, front) in S.WHEELS.items():
        spin, cal, pieces = axles[front]
        if x < 0:                                   # left side: true mirror image
            spin, cal = spin.mirrored(), cal.mirrored()
        o = to_object(spin, f'Wheel_{key}_Spin', ctx, SPIN_MATS)
        c = to_object(cal, f'Wheel_{key}_Caliper', ctx, CALIPER_MATS)
        for obj in (o, c):
            obj.location = (x, y, S.HUB_Z)
            util.set_parent(obj, ctx.root)
        out += [o, c]
        print(f'[car] wheel {key}: spin {util.tri_count(o)} + caliper {util.tri_count(c)} = '
              f'{util.tri_count(o) + util.tri_count(c)} triangles  {pieces}')
    return out
