"""
NIGHTSHIFT traffic - trucks (European cab-over tractor, rigid box truck, semi, fuel tanker).
Loaded by build.py: `trucks.register(globals())` returns {'boxtruck': P, 'semi': P, 'tanker': P}.
Boxy shells are lofted VERTICALLY: every station is a plan-view rounded rectangle at height z.
"""
import math
from types import SimpleNamespace
from mathutils import Vector, Matrix

B = None  # build.py namespace (decal, planar, V, MB, ...)


def lerp(a, b, t):
    return a + (b - a) * t


# ───────────────────────────────────────────────────────────── vertical loft

def plan_ring(z, yf, yb, w, rf, rb, xs=(), ys=(), nf=5, nr=3):
    """Right half (front centre -> rear centre) of a rounded-rectangle plan at height z."""
    rf = max(0.01, min(rf, w - 0.02))
    rb = max(0.01, min(rb, w - 0.02))
    pts = []
    for x in [0.0] + [min(x, w - rf - 0.002) for x in xs] + [w - rf]:
        pts.append((x, yf))
    for k in range(1, nf + 1):
        a = (math.pi / 2) * k / nf
        pts.append((w - rf + rf * math.sin(a), yf - rf + rf * math.cos(a)))
    for y in ys:
        pts.append((w, max(yb + rb + 0.002, min(y, yf - rf - 0.002))))
    for k in range(0, nr + 1):
        a = (math.pi / 2) * k / nr
        pts.append((w - rb + rb * math.cos(a), yb + rb - rb * math.sin(a)))
    for x in [min(x, w - rb - 0.002) for x in reversed(xs)]:
        pts.append((x, yb))
    pts.append((0.0, yb))
    return [Vector((x, y, z)) for x, y in pts]


def vloft(mb, zs, ring_fn, region, cap_top=True, cap_bot=True):
    rows = []
    for z in zs:
        half = ring_fn(z)
        full = half + [Vector((-p.x, p.y, p.z)) for p in reversed(half[1:-1])]
        rows.append([mb.v(p) for p in full])
    M = len(rows[0])
    for i in range(len(rows) - 1):
        for j in range(M):
            j2 = (j + 1) % M
            q = [rows[i][j], rows[i][j2], rows[i + 1][j2], rows[i + 1][j]]
            c = (q[0].co + q[1].co + q[2].co + q[3].co) * 0.25
            mb.f(q, region(c, 'wall'))
    for row, on, tag in ((rows[-1], cap_top, 'top'), (rows[0], cap_bot, 'bot')):
        if not on:
            continue
        ctr = Vector((0, 0, 0))
        for v in row:
            ctr += v.co
        ctr /= len(row)
        cv = mb.v(ctr)
        for j in range(M):
            j2 = (j + 1) % M
            c = (row[j].co + row[j2].co + ctr) / 3
            mb.f([row[j], row[j2], cv], region(c, tag))


def edge_round(z, z0, z1, r0, r1):
    """Inset of a rounded bottom (radius r0 at z0) / top (radius r1 at z1) edge."""
    if r1 > 0 and z > z1 - r1:
        d = (z - (z1 - r1)) / r1
        return r1 * (1 - math.sqrt(max(0.0, 1 - d * d)))
    if r0 > 0 and z < z0 + r0:
        d = ((z0 + r0) - z) / r0
        return r0 * (1 - math.sqrt(max(0.0, 1 - d * d)))
    return 0.0


def round_stations(z0, z1, r0, r1, extra=(), step=0.25):
    zs = [z0 + r0 * (1 - math.cos(math.radians(a))) for a in (8, 30, 55, 75)] if r0 > 0 else []
    zs += [z1 - r1 * (1 - math.cos(math.radians(a))) for a in (75, 55, 35, 18, 6)] if r1 > 0 else []
    n = max(1, int((z1 - z0) / step))
    zs += [z0 + (z1 - z0) * i / n for i in range(n + 1)]
    zs += list(extra)
    return [z for z in B.merge_sorted(zs, eps=0.004) if z0 - 1e-6 <= z <= z1 + 1e-6]


def rounded_box(mb, y0, y1, z0, z1, w, rf, rb, r0, r1, region, xs=(), ys=(), zextra=()):
    zs = round_stations(z0, z1, r0, r1, zextra)

    def ring(z):
        e = edge_round(z, z0, z1, r0, r1)
        return plan_ring(z, y1 - e, y0 + e, w - e, rf, rb, xs, ys)
    vloft(mb, zs, ring, region)


def thin_box(mb, c, size, mname):
    B.V.box(mb, c, size, mname)


def cyl(mb, p0, p1, r, mname, n=8, caps=True):
    B.V.cylinder(mb, p0, p1, r, n, mname, caps=caps)


def lamp_row(mb, x0, x1, z0, z1, y, names, facing=-1, depth=0.05):
    """Rear (facing=-1) / front (+1) lamp bar: black housing + a row of lens quads."""
    B.V.box(mb, ((x0 + x1) / 2, y - facing * depth / 2, (z0 + z1) / 2), (abs(x1 - x0) + 0.02, depth, z1 - z0 + 0.02), 'trim.black')
    n = len(names)
    yy = y + facing * 0.003
    for k, nm in enumerate(names):
        a = lerp(x0, x1, k / n) + 0.005
        b = lerp(x0, x1, (k + 1) / n) - 0.005
        B.qd(mb, [(a, yy, z0), (b, yy, z0), (b, yy, z1), (a, yy, z1)], nm, (0, facing, 0))


# ───────────────────────────────────────────────────────────── cab-over cab

def build_cab(sh, det, wh, C):
    """C: Yf (front), w (half width), top, depth, axle_f, axle_r, dual, R."""
    Yf, w, top, dep = C['Yf'], C['w'], C['top'], C['depth']
    yb = Yf - dep
    zb = C.get('bottom', 1.12)
    ws0, ws1 = zb + 0.72, top - 0.30  # windscreen
    wx = w - 0.19

    def yfront(z):
        return Yf - max(0.0, z - (zb + 0.6)) * 0.13

    def wz(z):
        return w - max(0.0, z - (zb + 0.9)) * 0.045

    def region(c, tag):
        if tag == 'bot':
            return 'trim.under'
        z, ax = c.z, abs(c.x)
        front = c.y > yfront(z) - 0.06 and ax < wz(z) - 0.08
        if front:
            if ws0 < z < ws1 and ax < wx:
                return 'glass.clear'
            if ws0 - 0.05 < z < ws1 + 0.05 and ax < wx + 0.06:
                return 'trim.gloss'
            if zb + 0.08 < z < ws0 - 0.12 and ax < wx - 0.12:
                return 'trim.grille'
        side = ax > wz(z) - 0.03
        if side and ws0 + 0.12 < z < ws1 - 0.02 and Yf - 1.12 < c.y < Yf - 0.30:
            return 'glass.tint'
        if side and ws0 + 0.08 < z < ws1 + 0.02 and Yf - 1.16 < c.y < Yf - 0.26:
            return 'trim.gloss'
        if z < zb + 0.06:
            return 'trim.black'
        return 'paint.body'

    zs = round_stations(zb, top, 0.06, 0.14, extra=[ws0 - 0.12, ws0 - 0.05, ws0, ws0 + 0.08, ws0 + 0.12, ws1 - 0.02, ws1, ws1 + 0.02, ws1 + 0.05, zb + 0.06, zb + 0.08])

    def ring(z):
        e = edge_round(z, zb, top, 0.06, 0.14)
        return plan_ring(z, yfront(z) - e, yb + e, wz(z) - e, 0.17, 0.06,
                         xs=[wx - 0.12, wx, wx + 0.06], ys=[Yf - 0.26, Yf - 0.30, Yf - 1.12, Yf - 1.16])
    vloft(sh, zs, ring, region)

    # sun visor, roof fairing, cab extenders
    B.V.box(sh, (0, yfront(top) - 0.02, top - 0.17), (2 * w - 0.25, 0.22, 0.06), 'paint.body', bevel=0.02, segments=1)
    if C.get('fairing'):
        ft = C['fairing']

        def freg(c, tag):
            return 'paint.body'
        zf = [top - 0.05 + (ft - top + 0.05) * k / 6 for k in range(7)]

        def fring(z):
            t = (z - top) / (ft - top)
            return plan_ring(z, Yf - 0.35 - max(0.0, t) * 1.25, yb + 0.03, w - 0.07 - max(0.0, t) * 0.1, 0.45, 0.05)
        vloft(sh, zf, fring, freg)
    for s in (1, -1):
        B.V.box(sh, (s * (w - 0.02), yb - 0.17, (zb + top) / 2 + 0.15), (0.04, 0.34, top - zb - 0.2), 'paint.body', bevel=0.012, segments=1)

    # bumper module with headlamps, steps
    def breg(c, tag):
        if c.z < 0.58:
            return 'trim.black'
        if c.y > Yf + 0.02 and 0.66 < c.z < 0.74 and abs(c.x) < 0.6:
            return 'trim.grille'
        return C.get('bumper', 'trim.grey')
    rounded_box(sh, Yf - 0.42, Yf + 0.06, 0.42, zb + 0.02, w - 0.02, 0.22, 0.04, 0.05, 0.04, breg, xs=[0.6], zextra=[0.58, 0.66, 0.74])
    bvh = B.bvh_of(sh)
    hl = lambda i, j, na, nb: 'drl.lamp' if j == nb - 2 else ('ind.lamp' if (i + 0.5) / na > 0.78 else 'head.lamp')
    B.decal(det, bvh, B.front_planar(Yf + 0.06, 0.66, w - 0.12, 0.80, 0.98), 8, 4, B.bezel(hl), off=0.006)
    B.decal(det, bvh, B.front_planar(Yf + 0.06, 0.70, w - 0.2, 0.62, 0.68), 3, 1, 'drl.lamp', off=0.006)
    # grille slats
    slat = lambda i, j, na, nb: 'metal.gun' if j % 2 == 0 else 'trim.grille'
    B.decal(det, bvh, B.front_planar(Yf, -(wx - 0.14), wx - 0.14, zb + 0.12, ws0 - 0.16), 2, 9, slat, off=0.008, mirror=False)
    B.plate(det, bvh, B.front_planar(Yf + 0.06, -0.26, 0.26, 0.48, 0.592), seed=7)
    # door seams + handle + side repeater
    for y in (Yf - 0.22, Yf - 1.24):
        B.decal(det, bvh, B.side_planar(y - 0.006, y + 0.006, zb + 0.1, ws1 + 0.05), 1, 6, 'trim.seam', off=0.004)
    B.decal(det, bvh, B.side_planar(Yf - 1.0, Yf - 0.84, ws0 - 0.02, ws0 + 0.02), 2, 1, 'trim.gloss', off=0.005)
    B.decal(det, bvh, B.side_planar(Yf - 0.12, Yf - 0.04, zb + 0.18, zb + 0.24), 1, 1, 'ind.lamp', off=0.005)
    # roof marker lamps
    for x in (-0.7, -0.35, 0.35, 0.7):
        B.V.box(det, (x, yfront(top) - 0.05, top - 0.11), (0.09, 0.05, 0.035), 'markerA.lamp')
    # mirrors: arm + main + wide-angle heads
    for s in (1, -1):
        x = s * (w + 0.16)
        y = Yf - 0.18
        B.V.box(det, (s * (w + 0.08), y, ws1 - 0.02), (0.18, 0.04, 0.035), 'trim.black')
        B.V.box(det, (s * (w + 0.08), y, ws0 + 0.05), (0.18, 0.04, 0.035), 'trim.black')
        B.V.box(det, (x, y, ws0 + 0.38), (0.09, 0.11, 0.42), 'trim.black', bevel=0.02, segments=1)
        B.qd(det, [(x - 0.035, y - 0.058, ws0 + 0.2), (x + 0.035, y - 0.058, ws0 + 0.2), (x + 0.035, y - 0.058, ws0 + 0.56), (x - 0.035, y - 0.058, ws0 + 0.56)], 'metal.chrome', (0, -1, 0))
        B.V.box(det, (x, y + 0.02, ws0 - 0.05), (0.09, 0.10, 0.17), 'trim.black', bevel=0.02, segments=1)
    # exhaust stack with heat shield behind the cab (tractors), right side
    if C.get('stack'):
        xs_, ys_ = w - 0.2, yb - 0.16
        cyl(det, (xs_, ys_, 1.05), (xs_, ys_, top + 0.32), 0.065, 'metal.chrome', n=10, caps=False)
        cyl(det, (xs_, ys_, top + 0.32), (xs_, ys_ - 0.05, top + 0.4), 0.065, 'metal.chrome', n=10)
        B.V.box(det, (xs_ + 0.055, ys_, top - 0.55), (0.03, 0.17, 0.95), 'metal.alu')
        for zz in (1.6, top - 0.3):
            B.V.box(det, (xs_ - 0.02, ys_ + 0.09, zz), (0.05, 0.12, 0.04), 'metal.dark')
    # side skirts (aero fairings) from behind the front wheel to the rear-axle mudguard (tractors)
    if C.get('skirt'):
        y0s, y1s = C['axle_r'] + C['R'] + 0.32, C['axle_f'] - C['R'] - 0.85
        if y1s - y0s > 0.4:
            for s in (1, -1):
                B.V.box(det, (s * (w - 0.04), (y0s + y1s) / 2, 0.52), (0.035, y1s - y0s, 0.3), 'paint.body', bevel=0.012, segments=1)
                B.V.box(det, (s * (w - 0.06), (y0s + y1s) / 2, 0.36), (0.03, y1s - y0s, 0.04), 'trim.black')
    # steps + front mudguards
    for s in (1, -1):
        for zz in (0.5, 0.82):
            B.V.box(det, (s * (w - 0.2), C['axle_f'] - 0.62, zz), (0.42, 0.26, 0.04), 'metal.gun')
        B.V.box(det, (s * (w - 0.2), C['axle_f'] - 0.62, 0.68), (0.44, 0.03, 0.42), 'trim.black')
    R = C['R']
    mudguard(wh, C['axle_f'], C['track_f'], R, 0.36, 15, 165)


def mudguard(mb, y, x, R, width, a0, a1, z=None):
    for s in (1, -1):
        m = Matrix.Translation((s * x, y, R if z is None else z))
        B.V.lathe(mb, [(R + 0.06, -width / 2), (R + 0.06, width / 2), (R + 0.075, width / 2), (R + 0.075, -width / 2)], 12,
                  'trim.black', m=m, closed=True, axis='x', a0=math.radians(a0), a1=math.radians(a1))


def chassis(det, y0, y1, z=0.95, x=0.43, h=0.26):
    for s in (1, -1):
        B.V.box(det, (s * x, (y0 + y1) / 2, z), (0.09, y1 - y0, h), 'metal.dark')


def tractor_running_gear(det, wh, C):
    R = C['R']
    chassis(det, C['rear'], C['Yf'] - 0.4)
    # fuel tank (right), battery/AdBlue box (left)
    ya, yb_ = C['axle_r'] + 0.75, C['axle_f'] - 0.65
    if yb_ - ya > 0.6:
        m = Matrix.Translation((1.0, 0, 0.78))
        B.V.lathe(det, [(0.0, ya), (0.26, ya), (0.3, ya + 0.04), (0.3, yb_ - 0.04), (0.26, yb_), (0.0, yb_)], 14, 'metal.alu', m=m, axis='y')
        B.V.box(det, (-1.0, (ya + yb_) / 2, 0.8), (0.42, yb_ - ya, 0.5), 'trim.black', bevel=0.03, segments=1)
    for ay, xw, dual in ((C['axle_f'], C['track_f'], False), (C['axle_r'], C['track_r'], True)):
        for s in (1, -1):
            B.V.wheel(wh, (s * xw, ay, R), R, 0.30, 0.29, s, style='truckdual' if dual else 'truck', rim_mat='metal.alu', dual=dual, nseg=20)
    mudguard(wh, C['axle_r'], C['track_r'] - 0.17, R, 0.62, 25, 160)
    for s in (1, -1):
        B.V.box(det, (s * (C['track_r'] - 0.17), C['axle_r'] - R - 0.12, R * 0.75), (0.6, 0.014, R * 1.1), 'trim.mud')


# ───────────────────────────────────────────────────────────── box body / trailer

def box_body(sh, det, y0, y1, z0, z1, w, tag='paint2.body'):
    def reg(c, t):
        if t == 'bot':
            return 'trim.under'
        return tag
    ys = [y0 + (y1 - y0) * k / 10 for k in range(1, 10)]
    rounded_box(sh, y0, y1, z0, z1, w, 0.05, 0.03, 0.03, 0.05, reg, ys=list(reversed(ys)))


def box_details(det, bvh, y0, y1, z0, z1, w, axles, R, rear_lamp_z=1.0, panels=1.2, plate_seed=1):
    # top / bottom rails
    for s in (1, -1):
        B.V.box(det, (s * (w + 0.012), (y0 + y1) / 2, z1 - 0.05), (0.03, y1 - y0 - 0.04, 0.1), 'metal.alu')
        B.V.box(det, (s * (w + 0.015), (y0 + y1) / 2, z0 + 0.1), (0.035, y1 - y0 - 0.04, 0.2), 'metal.alu')
    # panel joints
    n = int((y1 - y0) / panels)
    for k in range(1, n):
        y = y0 + (y1 - y0) * k / n
        B.decal(det, bvh, B.side_planar(y - 0.008, y + 0.008, z0 + 0.22, z1 - 0.12), 1, 4, 'metal.gun', off=0.004)
    # yellow conspicuity tape (dashed) just above the bottom rail
    dash = lambda i, j, na, nb: 'retro.yellow' if i % 2 == 0 else None
    B.decal(det, bvh, B.side_planar(y0 + 0.2, y1 - 0.2, z0 + 0.24, z0 + 0.29), 24, 1, dash, off=0.005)
    # side marker lamps
    for k in range(int((y1 - y0) / 2.6) + 1):
        y = lerp(y0 + 0.3, y1 - 0.3, k / max(1, int((y1 - y0) / 2.6)))
        for s in (1, -1):
            B.V.box(det, (s * (w + 0.04), y, z0 + 0.1), (0.03, 0.09, 0.045), 'markerA.lamp')
    # top corner markers
    for s in (1, -1):
        B.V.box(det, (s * (w - 0.12), y0 - 0.02, z1 - 0.09), (0.12, 0.03, 0.05), 'markerR.lamp')
        B.V.box(det, (s * (w - 0.12), y1 + 0.02, z1 - 0.09), (0.12, 0.03, 0.05), 'markerW.lamp')
    # rear: door frame, centre seam, lock bars, red contour tape, hinges
    yr = y0 - 0.004
    for s in (1, -1):
        B.V.box(det, (s * (w - 0.04), y0 - 0.02, (z0 + z1) / 2), (0.08, 0.05, z1 - z0), 'metal.gun')
        B.qd(det, [(s * (w - 0.075), yr - 0.046, z0 + 0.15), (s * (w - 0.005), yr - 0.046, z0 + 0.15), (s * (w - 0.005), yr - 0.046, z1 - 0.15), (s * (w - 0.075), yr - 0.046, z1 - 0.15)], 'retro.red', (0, -1, 0))
        for xx in (0.25, w - 0.32):
            cyl(det, (s * xx, y0 - 0.05, z0 + 0.12), (s * xx, y0 - 0.05, z1 - 0.12), 0.017, 'metal.alu', n=6)
            B.V.box(det, (s * xx, y0 - 0.06, z0 + 0.95), (0.04, 0.03, 0.26), 'metal.alu')
        for zz in (z0 + 0.4, (z0 + z1) / 2, z1 - 0.4):
            B.V.box(det, (s * (w - 0.1), y0 - 0.055, zz), (0.16, 0.03, 0.09), 'metal.gun')
    B.V.box(det, (0, y0 - 0.02, z1 - 0.04), (2 * w, 0.05, 0.08), 'metal.gun')
    B.V.box(det, (0, y0 - 0.02, z0 + 0.04), (2 * w, 0.05, 0.08), 'metal.gun')
    B.qd(det, [(-0.008, yr - 0.002, z0 + 0.08), (0.008, yr - 0.002, z0 + 0.08), (0.008, yr - 0.002, z1 - 0.08), (-0.008, yr - 0.002, z1 - 0.08)], 'trim.seam', (0, -1, 0))
    # corner castings (rear, top + bottom)
    for s in (1, -1):
        for zz in (z0 + 0.07, z1 - 0.07):
            B.V.box(det, (s * (w - 0.06), y0 - 0.03, zz), (0.16, 0.08, 0.14), 'metal.dark')
    rear_bumper(det, y0, w, rear_lamp_z, plate_seed)
    # axles: wheels + mudguard over the group
    return


def rear_bumper(det, y0, w, z, plate_seed=1):
    """Underride bar with lamp clusters and plate."""
    B.V.box(det, (0, y0 + 0.08, z - 0.48), (2 * w - 0.25, 0.12, 0.13), 'metal.gun')
    stripe = ['retro.red', 'retro.white'] * 5
    n = len(stripe)
    for k, nm in enumerate(stripe):
        x0 = lerp(-(w - 0.14), w - 0.14, k / n)
        x1 = lerp(-(w - 0.14), w - 0.14, (k + 1) / n)
        B.qd(det, [(x0, y0 + 0.017, z - 0.53), (x1, y0 + 0.017, z - 0.53), (x1, y0 + 0.017, z - 0.43), (x0, y0 + 0.017, z - 0.43)], nm, (0, -1, 0))
    for s in (1, -1):
        B.V.box(det, (s * (w - 0.45), y0 + 0.2, z - 0.25), (0.06, 0.3, 0.45), 'metal.dark')
        names = ['ind.lamp', 'tail.lamp', 'tail.lamp', 'lens.clear', 'lens.red']
        if s < 0:
            names = list(reversed(names))
        x0, x1 = (0.55, w - 0.06) if s > 0 else (-(w - 0.06), -0.55)
        lamp_row(det, x0, x1, z - 0.07, z + 0.07, y0 - 0.01, names)
    B.V.box(det, (0, y0 + 0.02, z), (0.56, 0.04, 0.16), 'trim.black')
    chevrons(det, y0 - 0.004, 0.6, w - 0.12, z - 0.33, z - 0.2)
    chevrons(det, y0 - 0.004, -(w - 0.12), -0.6, z - 0.33, z - 0.2, flip=True)
    pts = B.plate_cells(plate_seed)
    na, nb = 22, 5
    for i in range(na):
        for j in range(nb):
            x0 = lerp(-0.26, 0.26, i / na)
            x1 = lerp(-0.26, 0.26, (i + 1) / na)
            z0 = lerp(z - 0.056, z + 0.056, j / nb)
            z1 = lerp(z - 0.056, z + 0.056, (j + 1) / nb)
            B.qd(det, [(x0, y0 - 0.002, z0), (x1, y0 - 0.002, z0), (x1, y0 - 0.002, z1), (x0, y0 - 0.002, z1)], pts(i, j, na, nb), (0, -1, 0))


def chevrons(det, y, x0, x1, z0, z1, n=6, flip=False):
    """Rear marking plate: alternating red / yellow diagonal stripes (retro-reflective), black backing."""
    B.V.box(det, ((x0 + x1) / 2, y + 0.012, (z0 + z1) / 2), (x1 - x0 + 0.02, 0.02, z1 - z0 + 0.02), 'trim.black')
    h = z1 - z0
    sk = -h if flip else h  # stripe slant
    step = (x1 - x0) / n
    for k in range(n):
        a, b = x0 + k * step, x0 + (k + 1) * step
        if sk > 0:
            pts = [(a, y, z0), (b, y, z0), (min(x1, b + sk * 0.6), y, z1), (min(x1, a + sk * 0.6), y, z1)]
        else:
            pts = [(max(x0, a + sk * 0.6), y, z0), (max(x0, b + sk * 0.6), y, z0), (b, y, z1), (a, y, z1)]
        B.qd(det, pts, 'retro.red' if k % 2 == 0 else 'retro.yellow', (0, -1, 0))


def trailer_axles(det, wh, axles, x, R, wtyre=0.385, guard_z=None, dual=False):
    for ay in axles:
        for s in (1, -1):
            B.V.wheel(wh, (s * x, ay, R), R, wtyre, 0.29, s, style='truckdual' if dual else 'truck', rim_mat='metal.alu', dual=dual, nseg=20)
    y0, y1 = min(axles) - R - 0.1, max(axles) + R + 0.1
    for s in (1, -1):
        B.V.box(det, (s * x, (y0 + y1) / 2, 2 * R + 0.1 if guard_z is None else guard_z), (wtyre + 0.12, y1 - y0, 0.03), 'trim.black')
        B.V.box(det, (s * x, y0 - 0.02, R * 0.78), (wtyre + 0.1, 0.014, R * 1.2), 'trim.mud')
    chassis(det, y0 - 0.2, y1 + 0.3, z=2 * R + 0.02, x=0.5, h=0.22)


def landing_gear(det, y, z_top, w=0.95):
    for s in (1, -1):
        B.V.box(det, (s * w, y, (z_top + 0.36) / 2 + 0.05), (0.11, 0.11, z_top - 0.36), 'metal.dark')
        B.V.box(det, (s * w, y, 0.33), (0.085, 0.085, 0.1), 'metal.gun')
        B.V.box(det, (s * w, y, 0.27), (0.24, 0.28, 0.03), 'metal.dark')
    B.V.box(det, (0, y, z_top - 0.45), (2 * w, 0.05, 0.05), 'metal.dark')
    B.V.box(det, (1.07, y, z_top - 0.55), (0.04, 0.04, 0.3), 'metal.gun')


def side_guard(det, y0, y1, w, z=0.62):
    for s in (1, -1):
        for zz in (z, z + 0.32):
            B.V.box(det, (s * (w - 0.08), (y0 + y1) / 2, zz), (0.025, y1 - y0, 0.1), 'metal.alu')
        for y in (y0 + 0.1, (y0 + y1) / 2, y1 - 0.1):
            B.V.box(det, (s * (w - 0.2), y, z + 0.4), (0.22, 0.05, 0.08), 'metal.dark')


# ───────────────────────────────────────────────────────────── types

def build_semi(P):
    sh, det, wh = B.MB('shell'), B.MB('det'), B.MB('wheels')
    C = P['cab']
    build_cab(sh, det, wh, C)
    y0, y1, z0, z1, w = P['trailer']
    box_body(sh, det, y0, y1, z0, z1, w)
    bvh = B.bvh_of(sh)
    tractor_running_gear(det, wh, C)
    B.V.box(det, (0, C['axle_r'] + 0.35, 1.12), (0.9, 0.8, 0.06), 'metal.dark')  # fifth wheel
    box_details(det, bvh, y0, y1, z0, z1, w, P['taxles'], 0.5, rear_lamp_z=1.0, plate_seed=4)
    trailer_axles(det, wh, P['taxles'], 1.0, 0.5, guard_z=z0 - 0.06)
    landing_gear(det, y1 - 3.0, z0)
    side_guard(det, min(P['taxles']) + 0.8, y1 - 3.3, w)
    chassis(det, y0 + 0.2, y1 - 0.2, z=z0 - 0.1, x=0.5, h=0.2)
    return [sh, det, wh]


def build_box(P):
    sh, det, wh = B.MB('shell'), B.MB('det'), B.MB('wheels')
    C = P['cab']
    build_cab(sh, det, wh, C)
    y0, y1, z0, z1, w = P['box']
    box_body(sh, det, y0, y1, z0, z1, w)
    bvh = B.bvh_of(sh)
    tractor_running_gear(det, wh, C)
    box_details(det, bvh, y0, y1, z0, z1, w, [C['axle_r']], 0.5, rear_lamp_z=0.98, panels=1.0, plate_seed=6)
    chassis(det, y0 + 0.1, C['rear'], z=0.95)
    side_guard(det, C['axle_r'] + 0.7, C['axle_f'] - 0.7, w)
    # roller shutter ribs on the rear face
    rib = lambda i, j, na, nb: 'metal.gun' if j % 3 == 0 else 'paint2.body'
    B.decal(det, bvh, B.rear_planar(y0, -(w - 0.1), w - 0.1, z0 + 0.12, z1 - 0.12), 1, 33, rib, off=0.003, mirror=False)
    return [sh, det, wh]


def build_tanker(P):
    sh, det, wh = B.MB('shell'), B.MB('det'), B.MB('wheels')
    C = P['cab']
    build_cab(sh, det, wh, C)
    yb, yf, R, zc = P['tank']
    d = 0.42
    prof = [(0.0, yb)]
    for k in range(1, 7):
        a = math.radians(90 * k / 6)
        prof.append((R * math.sin(a), yb + d * (1 - math.cos(a))))
    for k in range(6, -1, -1):
        a = math.radians(90 * k / 6)
        prof.append((R * math.sin(a), yf - d * (1 - math.cos(a))))
    m = Matrix.Translation((0, 0, zc)) @ Matrix.Diagonal((1.07, 1, 1, 1))
    B.V.lathe(sh, prof, 30, 'metal.steel', m=m, axis='y')
    bvh = B.bvh_of(sh)
    tractor_running_gear(det, wh, C)
    B.V.box(det, (0, C['axle_r'] + 0.35, 1.12), (0.9, 0.8, 0.06), 'metal.dark')
    # stiffening bands
    for y in [lerp(yb + d + 0.6, yf - d - 0.6, k / 4) for k in range(5)]:
        B.V.lathe(det, [(R + 0.004, y - 0.05), (R + 0.022, y - 0.035), (R + 0.022, y + 0.035), (R + 0.004, y + 0.05)], 30, 'metal.alu', m=m, axis='y')
    top = zc + R
    # catwalk, domes, folding handrails
    B.V.box(det, (0, (yb + yf) / 2, top + 0.03), (0.55, yf - yb - 2 * d - 0.6, 0.04), 'metal.galv')
    for y in [lerp(yb + d + 1.2, yf - d - 1.2, k / 3) for k in range(4)]:
        cyl(det, (0, y, top - 0.02), (0, y, top + 0.13), 0.24, 'metal.alu', n=14)
        cyl(det, (0, y, top + 0.13), (0, y, top + 0.16), 0.17, 'metal.galv', n=12)
    ys = [lerp(yb + d + 0.4, yf - d - 0.4, k / 8) for k in range(9)]
    for s in (1, -1):
        for y in ys:
            cyl(det, (s * 0.36, y, top + 0.01), (s * 0.36, y, top + 0.3), 0.016, 'metal.alu', n=5, caps=False)
        cyl(det, (s * 0.36, ys[0], top + 0.3), (s * 0.36, ys[-1], top + 0.3), 0.02, 'metal.alu', n=6)
    # rear ladder on the dome
    for s in (1, -1):
        cyl(det, (s * 0.2, yb + 0.02, 1.15), (s * 0.2, yb + 0.02, top + 0.1), 0.02, 'metal.alu', n=6)
    for k in range(9):
        z = lerp(1.35, top - 0.1, k / 8)
        cyl(det, (-0.2, yb + 0.02, z), (0.2, yb + 0.02, z), 0.013, 'metal.alu', n=5, caps=False)
    # ADR orange panels (generic, no numbers): rear on the dome, both sides
    adr = lambda i, j, na, nb: 'trim.black' if i == 0 or j == 0 or i == na - 1 or j == nb - 1 or j == nb // 2 else 'trim.orange'
    B.decal(det, bvh, B.rear_planar(yb, 0.32, 0.72, 1.85, 2.15), 6, 5, adr, off=0.006, mirror=False)
    B.decal(det, bvh, B.side_planar(yf - 1.6, yf - 1.2, 1.9, 2.2), 6, 5, adr, off=0.006)
    # red/white flammable diamond near the panel (simple square-on-point)
    for s in (1, -1):
        ctr = Vector((s * (R * 1.07 + 0.01), yf - 2.0, 2.05))
        B.qd(det, [(ctr.x, ctr.y - 0.17, ctr.z), (ctr.x, ctr.y, ctr.z - 0.17), (ctr.x, ctr.y + 0.17, ctr.z), (ctr.x, ctr.y, ctr.z + 0.17)], 'trim.red', (s, 0, 0))
    # subframe, cabinets, axles, bumper, markers
    chassis(det, yb + 0.1, yf - 0.6, z=zc - R + 0.02, x=0.48, h=0.24)
    for s in (1, -1):
        B.V.box(det, (s * 0.95, yf - 3.8, 0.95), (0.5, 2.3, 0.6), 'metal.alu', bevel=0.02, segments=1)
        for k in range(int((yf - yb - 1.0) / 2.6) + 1):
            y = lerp(yb + 0.6, yf - 0.6, k / max(1, int((yf - yb - 1.0) / 2.6)))
            B.V.box(det, (s * 1.18, y, zc - R + 0.08), (0.03, 0.09, 0.045), 'markerA.lamp')
        dash = lambda i, j, na, nb: 'retro.yellow' if i % 2 == 0 else None
    B.decal(det, bvh, B.side_planar(yb + d + 0.3, yf - d - 0.3, zc - 0.55, zc - 0.50), 24, 1, lambda i, j, na, nb: 'retro.yellow' if i % 2 == 0 else None, off=0.005)
    def dome_y(x, z):
        rho = min(R * 0.999, math.sqrt((x / 1.07) ** 2 + (z - zc) ** 2))
        return yb + d * (1 - math.cos(math.asin(rho / R)))
    for s in (1, -1):
        for x, z in ((0.55, top - 0.22), (0.95, zc - 0.25)):
            yy = dome_y(s * x, z)
            B.V.box(det, (s * x, yy - 0.02, z), (0.1, 0.05, 0.05), 'markerR.lamp')
    rear_bumper(det, yb - 0.12, 1.25, 1.0, plate_seed=8)
    trailer_axles(det, wh, P['taxles'], 1.0, 0.5, guard_z=1.08)
    landing_gear(det, yf - 2.8, zc - R + 0.1)
    side_guard(det, max(P['taxles']) + 0.75, yf - 4.9, 1.25)
    return [sh, det, wh]


def register(ns):
    global B
    B = SimpleNamespace(**ns)
    cab_semi = dict(Yf=8.25, w=1.25, top=3.05, depth=2.3, R=0.5, axle_f=6.8, axle_r=3.1, track_f=1.03, track_r=0.98, rear=2.55, fairing=3.96, stack=True)
    cab_box = dict(Yf=4.1, w=1.2, top=2.95, depth=2.1, R=0.48, axle_f=2.75, axle_r=-1.45, track_f=1.0, track_r=0.95, rear=-3.9, bottom=1.08)
    return {
        'semi': dict(builder=build_semi, n_body_parts=1, cab=cab_semi, trailer=(-8.3, 5.3, 1.22, 4.0, 1.275), taxles=[-4.68, -5.99, -7.3]),
        'boxtruck': dict(builder=build_box, n_body_parts=1, cab=dict(cab_box, R=0.5), box=(-4.1, 1.85, 1.15, 3.5, 1.25)),
        'tanker': dict(builder=build_tanker, n_body_parts=1, cab=dict(cab_semi, fairing=None), tank=(-7.8, 5.0, 1.1, 2.3), taxles=[-4.5, -5.81, -7.12]),
    }
