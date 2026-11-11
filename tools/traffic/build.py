"""
NIGHTSHIFT traffic vehicles - procedural builder (Blender 4.3, headless).

  blender --background --factory-startup --python tools/traffic/build.py -- <type|all> [outdir]

Writes <outdir>/<type>.glb (one primitive per surface-class material, COLOR_0 = baked AO) that
tools/traffic/pack.mjs merges into public/assets/models/traffic/traffic.glb.
Blender frame: X right, Y forward, Z up, origin = centre of the footprint on the ground.
"""
import sys
import os
import math
import json

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bpy  # noqa: E402
from mathutils import Vector, Matrix  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402
import vlib as V  # noqa: E402
from vlib import MB, Pchip, loft, merge_sorted  # noqa: E402


def C(keys):
    if isinstance(keys, (int, float)):
        k = float(keys)
        return lambda u: k
    return Pchip([k[0] for k in keys], [k[1] for k in keys])


def lerp(a, b, t):
    return a + (b - a) * t


def clamp(x, a, b):
    return a if x < a else b if x > b else x


def frange(a, b, step):
    n = max(1, int(math.ceil(abs(b - a) / step)))
    return [a + (b - a) * i / n for i in range(n + 1)]


# ───────────────────────────────────────────────────────────── decals (projected patches)

def decal(mb, bvh, fn, na, nb, mname, off=0.005, inside=False, mirror=True, maxd=3.0, smooth=True):
    """Grid of (na x nb) cells whose vertices are ray-cast onto `bvh`.
    fn(a, b) -> (origin, direction) for a, b in [0, 1].  mname: str or f(i, j, na, nb) -> str."""
    grid = []
    for j in range(nb + 1):
        row = []
        for i in range(na + 1):
            o, d = fn(i / na, j / nb)
            d = Vector(d).normalized()
            loc, nor, _, _ = bvh.ray_cast(Vector(o), d, maxd)
            if loc is None:
                row.append(None)
                continue
            n = Vector(nor)
            if (n.dot(d) < 0) == inside:
                n = -n
            row.append((loc + n * off, n))
        grid.append(row)
    for sgn in ((1, -1) if mirror else (1,)):
        vs = [[None if p is None else mb.v(Vector((p[0].x * sgn, p[0].y, p[0].z))) for p in row] for row in grid]
        for j in range(nb):
            for i in range(na):
                q = [(j, i), (j, i + 1), (j + 1, i + 1), (j + 1, i)]
                if any(grid[a][b] is None for a, b in q):
                    continue
                name = mname(i, j, na, nb) if callable(mname) else mname
                if name is None:
                    continue
                f = mb.f([vs[a][b] for a, b in q], name, smooth)
                if f is None:
                    continue
                f.normal_update()
                navg = Vector((0, 0, 0))
                for a, b in q:
                    n = grid[a][b][1]
                    navg += Vector((n.x * sgn, n.y, n.z))
                if f.normal.dot(navg) < 0:
                    f.normal_flip()


def radial(cx, cy, fwd, z0, z1, th0, th1, dz0=0.0, dz1=0.0):
    """Rays from (cx, cy, z) inside the body sweeping th0..th1 deg (0 = straight back/forward, 90 = +X)."""
    def fn(a, b):
        t0 = th0(b) if callable(th0) else th0
        t1 = th1(b) if callable(th1) else th1
        th = math.radians(lerp(t0, t1, a))
        z = lerp(z0 + dz0 * a, z1 + dz1 * a, b)
        return Vector((cx, cy, z)), Vector((math.sin(th), fwd * math.cos(th), 0.0))
    return fn


def planar(o, U, W, D, u0, u1, v0, v1, back=1.5):
    """Rays along D from the plane o + U*u + W*v (u range may depend on v)."""
    o, U, W, D = Vector(o), Vector(U), Vector(W), Vector(D).normalized()

    def fn(a, b):
        v = lerp(v0, v1, b)
        a0 = u0(v) if callable(u0) else u0
        a1 = u1(v) if callable(u1) else u1
        u = lerp(a0, a1, a)
        return o + U * u + W * v - D * back, D
    return fn


def side_planar(y0, y1, z0, z1, x=3.0, sgn=1):
    """Projection onto the right flank (rays along -X)."""
    return planar((x * sgn, 0, 0), (0, 1, 0), (0, 0, 1), (-sgn, 0, 0), y0, y1, z0, z1, back=0.0)


def rear_planar(y, x0, x1, z0, z1):
    return planar((0, y - 2.0, 0), (1, 0, 0), (0, 0, 1), (0, 1, 0), x0, x1, z0, z1, back=0.0)


def front_planar(y, x0, x1, z0, z1):
    return planar((0, y + 2.0, 0), (1, 0, 0), (0, 0, 1), (0, -1, 0), x0, x1, z0, z1, back=0.0)


def top_planar(z, x0, x1, y0, y1):
    return planar((0, 0, z + 2.0), (1, 0, 0), (0, 1, 0), (0, 0, -1), x0, x1, y0, y1, back=0.0)


def bezel(inner, outer='trim.gloss', ring=1):
    def f(i, j, na, nb):
        if i < ring or j < ring or i >= na - ring or j >= nb - ring:
            return outer
        return inner(i, j, na, nb) if callable(inner) else inner
    return f


GLYPHS = [0b101111, 0b111101, 0b110111, 0b011110, 0b111011, 0b101101, 0b111110, 0b011111]


def plate_cells(seed=3, eu=True):
    """Number plate: dark border, blue band (EU), pseudo-characters (2x3 cells each)."""
    def f(i, j, na, nb):
        if j == 0 or j == nb - 1 or i == 0 or i == na - 1:
            return 'trim.black'
        if eu and i <= 2:
            return 'trim.blue'
        k = i - (4 if eu else 2)
        if k < 0 or k >= na - (5 if eu else 3) or k % 3 == 2:
            return 'plate.white'
        g = GLYPHS[(k // 3 * 5 + seed) % len(GLYPHS)]
        bit = (j - 1) * 2 + (k % 3)
        return 'trim.seam' if (g >> bit) & 1 else 'plate.white'
    return f


def plate(mb, bvh, fn, seed=3, eu=True):
    decal(mb, bvh, fn, 22 if eu else 18, 5, plate_cells(seed, eu), off=0.009, mirror=False)


def qd(mb, pts, mname, normal, smooth=False):
    f = mb.f([mb.v(Vector(p)) for p in pts], mname, smooth)
    if f is not None:
        f.normal_update()
        if f.normal.dot(Vector(normal)) < 0:
            f.normal_flip()
    return f


def rbox(mb, center, size, mname, bevel=0.02, segments=2, mirror=False):
    V.box(mb, center, size, mname, bevel=bevel, segments=segments, smooth=True)
    if mirror:
        V.box(mb, (-center[0], center[1], center[2]), size, mname, bevel=bevel, segments=segments, smooth=True)


def bvh_of(mb):
    mb.bm.verts.ensure_lookup_table()
    mb.bm.normal_update()
    return BVHTree.FromBMesh(mb.bm)


# ───────────────────────────────────────────────────────────── passenger cars / van

def endplan(yR, yF, rr, fr, front_len=0.45):
    """Plan-view corner rounding: width multiplier near the bumpers."""
    k = front_len / 0.45
    return [(yR, 1 - rr), (yR + 0.012, 1 - rr * 0.62), (yR + 0.03, 1 - rr * 0.38), (yR + 0.07, 1 - rr * 0.17), (yR + 0.15, 1 - rr * 0.05), (yR + 0.32, 1.0),
            (yF - 0.42 * k, 1.0), (yF - 0.22 * k, 1 - fr * 0.1), (yF - 0.1 * k, 1 - fr * 0.3), (yF - 0.035 * k, 1 - fr * 0.6), (yF, 1 - fr)]


BODY_T = [0, 1, 2, 3, 3.5, 4, 4.33, 4.66, 5, 5.5, 6, 6.15, 6.35, 6.65, 7]
BODY_SHARP = [False, True, True, True, False, True, False, False]


def build_car(P):
    L = P['L']
    yR, yF = -L / 2, L / 2
    zf, zsb, zsh, zbelt, zdeck = C(P['zf']), C(P['zsb']), C(P['zsh']), C(P['zbelt']), C(P['zdeck'])
    wbelt, plan = C(P['wbelt']), C(P['plan'])
    wmax, wsb, wsill, win = P['wmax'], P['wsb'], P['wsill'], P['win']
    R = P['R']
    axles = P['axles']
    Ra = R + P.get('archgap', 0.045)
    acz = R + P.get('archdz', 0.012)

    def za(u):
        z = -1.0
        for ay in axles:
            du = u - ay
            if abs(du) <= Ra + 1e-6:
                z = max(z, acz + math.sqrt(max(0.0, Ra * Ra - du * du)))
        return z

    def ring(u):
        f = plan(u)
        z0 = zf(u)
        z3 = max(zsb(u), z0 + 0.01)
        a = za(u)
        zA = a if a > 0 else z3
        z4 = max(z3 + P.get('sill', 0.10), zA + 0.03)
        z5 = max(zsh(u), z4 + 0.03)
        z6 = max(zbelt(u), z5 + 0.03)
        z7 = max(zdeck(u), z6 - 0.06)
        wi = win * f
        pts = [(0, z0), (wi, z0), (wi, zA), (wsb * f, zA), (wsill * f, z4), (wmax * f, z5), (wbelt(u) * f, z6), (0, z7)]
        return [Vector((x, u, z)) for x, z in pts]

    st = frange(yR, yF, P.get('du', 0.08))
    for ay in axles:
        st += [ay + Ra * k / 8 for k in range(-8, 9)] + [ay - Ra - 0.004, ay + Ra + 0.004]
    ends = (0.006, 0.016, 0.03, 0.05, 0.08, 0.12, 0.18, 0.26)
    st += [yR + d for d in ends] + [yF - d for d in ends]
    st += P.get('stations', [])
    st = [u for u in merge_sorted(st, eps=0.0035) if yR - 1e-6 <= u <= yF + 1e-6]

    capz = P.get('capz', {})

    def region(zone, u, t, side, c):
        if zone != 'body':
            return 'trim.black' if c.z < capz.get(zone, 0.0) else 'paint.body'
        if t < 1:
            return 'trim.under'
        if t < 3:
            return 'trim.liner'
        clad = P.get('clad')
        if clad is not None:
            r = clad(u, t, c)
            if r:
                return r
        return 'paint.body'

    body = MB('body')
    loft(body, st, ring, BODY_SHARP, BODY_T, region,
         cap_lo={'s': [0.8, 0.5], 'axis': Vector((0, -1, 0)), 'bulge': P.get('bulgeR', 0.012)},
         cap_hi={'s': [0.8, 0.5], 'axis': Vector((0, 1, 0)), 'bulge': P.get('bulgeF', 0.02)})
    bvh_body = bvh_of(body)

    # greenhouse
    G = P['gh']
    hr = C(G['hr'])
    zdlo, zrail, zroof = C(G['zdlo']), C(G['zrail']), C(G['zroof'])
    wdlo, wrail = C(G['wdlo']), C(G['wrail'])
    inset = G.get('inset', 0.022)

    def gring(u):
        h = clamp(hr(u), 0.0, 1.0)
        zb = zbelt(u) - 0.006
        wg = wbelt(u) * plan(u) - inset
        hw = h ** 0.8
        pts = [(0, zb - 0.08), (wg, zb - 0.08), (wg, zb),
               (lerp(wg, wdlo(u), hw), lerp(zb, zdlo(u), h)),
               (lerp(wg, wrail(u), hw), lerp(zb, zrail(u), h)),
               (0, lerp(zb, zroof(u), h))]
        return [Vector((x, u, z)) for x, z in pts]

    uc, uws, ubl, uback = G['u_cowl'], G['u_ws'], G['u_bl'], G['u_back']
    ub, bw, ucg = G['u_b'], G['bw'], G['u_cglass']
    gst = frange(uback, uc, G.get('du', 0.06))
    gst += [uws, uws + 0.05, uc - 0.05, ubl, ubl - 0.05, uback + 0.04, ub - bw, ub + bw, ucg] + G.get('stations', [])
    gst = [u for u in merge_sorted(gst, eps=0.004) if uback - 1e-6 <= u <= uc + 1e-6]
    gt = merge_sorted([0, 1, 2, 2.06, 2.5, 2.94, 3, 3.5, 4, 4.1, 4.4, 4.7, 5], G.get('tsamp', []))
    seal = G.get('seal', 'trim.black')
    side_glass = G.get('side_glass')

    def gregion(zone, u, t, side, c):
        if t < 2:
            return 'trim.black'
        if t < 3:
            if t < 2.06 or t > 2.94:
                return seal
            if side_glass is not None:
                r = side_glass(u, t, c)
                if r:
                    return r
            if abs(u - ub) <= bw:
                return G.get('bpillar', 'trim.gloss')
            if u > ucg:
                return 'glass.tint'
            return G.get('cpillar', 'paint.body')
        if t < 4:
            return G.get('pillar', 'paint.body')
        if u > uws:
            if t < 4.1 or u > uc - 0.05 or u < uws + 0.05:
                return 'trim.gloss'
            return 'glass.clear'
        if u < ubl:
            rear = G.get('rear')
            if rear is not None:
                return rear(u, t, c)
            if t < 4.1 or u > ubl - 0.05 or u < uback + 0.04:
                return 'trim.gloss'
            return 'glass.tint'
        return G.get('roof', 'paint.body')

    gh = MB('gh')
    loft(gh, gst, gring, [False, True, True, False, False, False], gt, gregion)
    bvh_gh = bvh_of(gh)

    det = MB('det')
    ctx = {'bvh': bvh_body, 'bvh_gh': bvh_gh, 'zbelt': zbelt, 'zdeck': zdeck, 'wbelt': wbelt, 'plan': plan, 'yR': yR, 'yF': yF}
    P['details'](det, ctx)

    # wheels
    wh = MB('wheels')
    for k, ay in enumerate(axles):
        for s in (1, -1):
            V.wheel(wh, (s * P['track'], ay, R), R, P['tyre_w'], P['rim_r'], s, style=P['wheel'], rim_mat=P.get('rim_mat', 'metal.alu'))
    return [body, gh, det, wh]


def mirror_pair(mb, x, y, z, w=0.20, d=0.085, h=0.12, mat='paint.body', arm=0.10):
    for s in (1, -1):
        cx = s * (x + w / 2)
        V.box(mb, (cx, y, z), (w, d, h), mat, bevel=min(0.035, d / 2 - 0.004, h / 2 - 0.004), segments=2, smooth=True)
        V.box(mb, (s * (x - arm / 2 + 0.03), y + 0.005, z - h * 0.25), (arm, 0.05, 0.035), 'trim.black', bevel=0.008, segments=1)
        yb = y - d / 2 - 0.003
        x0, x1 = s * (x + 0.03), s * (x + w - 0.02)
        qd(mb, [(x0, yb, z - h / 2 + 0.025), (x1, yb, z - h / 2 + 0.025), (x1, yb, z + h / 2 - 0.02), (x0, yb, z + h / 2 - 0.02)], 'metal.chrome', (0, -1, 0))


def lamp_head(i, j, na, nb):
    a = (i + 0.5) / na
    b = (j + 0.5) / nb
    if b < 0.34:
        return 'drl.lamp'
    if a < 0.55:
        return 'head.lamp'
    return 'lens.clear'


def lamp_tail(i, j, na, nb):
    a = (i + 0.5) / na
    b = (j + 0.5) / nb
    if 0.45 < b < 0.9:
        return 'tail.lamp'
    if b < 0.4 and a < 0.32:
        return 'ind.lamp'
    if b < 0.4 and a < 0.5:
        return 'lens.clear'
    return 'lens.red'


def std_car_details(D):
    """Common details driven by a small dict of positions (see the type params)."""
    def details(mb, cx):
        bvh, bg = cx['bvh'], cx['bvh_gh']
        yR, yF = cx['yR'], cx['yF']
        # headlamps
        h = D['head']
        decal(mb, bvh, radial(h['cx'], yF - h['back'], 1, h['z0'], h['z1'], h['th0'], h['th1'], h.get('dz0', 0), h.get('dz1', 0)),
              14, 5, bezel(h.get('cells', lamp_head)), inside=True, off=0.007)
        # tail lamps
        t = D['tail']
        decal(mb, bvh, radial(t['cx'], yR + t['back'], -1, t['z0'], t['z1'], t['th0'], t['th1'], t.get('dz0', 0), t.get('dz1', 0)),
              16, 6, bezel(t.get('cells', lamp_tail)), inside=True, off=0.007)
        # grille + intake
        g = D['grille']
        decal(mb, bvh, front_planar(yF, g['x0'], g['x1'], g['z0'], g['z1']), 8, 4,
              bezel('trim.grille', g.get('frame', 'metal.chrome')), mirror=False)
        if 'intake' in D:
            g = D['intake']
            decal(mb, bvh, front_planar(yF, g['x0'], g['x1'], g['z0'], g['z1']), 10, 3, bezel('trim.grille', 'trim.black'), mirror=False)
        # plates
        p = D['plate_f']
        plate(mb, bvh, front_planar(yF, -0.26, 0.26, p, p + 0.112), seed=5)
        p = D['plate_r']
        decal(mb, bvh, rear_planar(yR, -0.3, 0.3, p - 0.03, p + 0.14), 8, 3, 'trim.black', off=0.005, mirror=False)
        plate(mb, bvh, rear_planar(yR, -0.26, 0.26, p, p + 0.112), seed=2)
        # rear diffuser / reflectors
        if 'diffuser' in D:
            d = D['diffuser']
            decal(mb, bvh, rear_planar(yR, -d['x'], d['x'], d['z0'], d['z1']), 10, 2, 'trim.black', off=0.004, mirror=False)
        if 'refl' in D:
            r = D['refl']
            decal(mb, bvh, rear_planar(yR, r['x0'], r['x1'], r['z0'], r['z1']), 2, 1, 'retro.red')
        # third brake lamp
        if 'cbrake' in D:
            c = D['cbrake']
            decal(mb, bg if c.get('gh', True) else bvh, rear_planar(yR, -c['x'], c['x'], c['z0'], c['z1']), 6, 1, 'brake.lamp', mirror=False)
        # door seams, handles, side repeaters
        for (y, z0, z1) in D.get('seams', []):
            decal(mb, bvh, side_planar(y - 0.005, y + 0.005, z0, z1), 1, 6, 'trim.seam', off=0.003)
        for (y, z) in D.get('handles', []):
            decal(mb, bvh, side_planar(y - 0.075, y + 0.075, z, z + 0.028), 3, 1, D.get('handle_mat', 'trim.gloss'), off=0.004)
        if 'repeater' in D:
            y, z = D['repeater']
            decal(mb, bvh, side_planar(y, y + 0.06, z, z + 0.022), 2, 1, 'ind.lamp', off=0.004)
        m = D['mirror']
        mirror_pair(mb, m['x'], m['y'], m['z'], m.get('w', 0.2), m.get('d', 0.085), m.get('h', 0.12), m.get('mat', 'paint.body'))
        for (x, y, z, r) in D.get('exhaust', []):
            V.cylinder(mb, (x, y + 0.12, z), (x, y - 0.015, z), r, 12, 'metal.chrome', caps=True, cap_name='trim.seam')
        if 'extra' in D:
            D['extra'](mb, cx)
    return details


def roof_rails(x, z, y0, y1, h=0.05):
    def f(mb, cx):
        for s in (1, -1):
            V.box(mb, (s * x, (y0 + y1) / 2, z + h / 2), (0.045, y1 - y0, h), 'metal.gun', bevel=0.012, segments=1)
            for y in (y0 + 0.05, y1 - 0.05):
                V.box(mb, (s * x, y, z), (0.05, 0.09, 0.05), 'trim.black', bevel=0.01, segments=1)
    return f


# ---- sedan --------------------------------------------------------------------------------
SEDAN = dict(
    L=4.75, R=0.335, axles=[1.43, -1.40], track=0.80, tyre_w=0.225, rim_r=0.235, wheel='alloy5x2',
    wmax=0.925, wsb=0.893, wsill=0.912, win=0.62,
    zf=[(-2.375, 0.37), (-2.34, 0.30), (-2.25, 0.23), (-2.0, 0.17), (1.95, 0.17), (2.2, 0.21), (2.32, 0.26), (2.375, 0.29)],
    zsb=[(-2.375, 0.39), (-2.34, 0.32), (-2.25, 0.27), (-2.0, 0.21), (1.9, 0.21), (2.2, 0.25), (2.32, 0.29), (2.375, 0.31)],
    zsh=[(-2.375, 0.78), (-1.5, 0.83), (0.0, 0.81), (1.6, 0.76), (2.375, 0.60)],
    zbelt=[(-2.375, 0.905), (-2.35, 0.95), (-2.3, 0.97), (-2.2, 0.985), (-1.9, 0.99), (-1.0, 0.975), (0.85, 0.93), (1.6, 0.86), (2.1, 0.79), (2.3, 0.73), (2.375, 0.68)],
    zdeck=[(-2.375, 0.915), (-2.35, 0.96), (-2.3, 0.98), (-2.2, 0.995), (-1.9, 1.0), (-1.6, 0.995), (-1.45, 0.96), (0.85, 0.94), (1.6, 0.875), (2.1, 0.80), (2.3, 0.735), (2.375, 0.67)],
    wbelt=[(-2.375, 0.80), (-1.6, 0.835), (0.85, 0.855), (1.8, 0.835), (2.375, 0.80)],
    plan=endplan(-2.375, 2.375, 0.10, 0.17),
    capz={'lo': 0.42, 'hi': 0.40},
    gh=dict(u_cowl=0.88, u_ws=-0.02, u_bl=-0.92, u_back=-1.58, u_b=-0.26, bw=0.045, u_cglass=-1.10,
            hr=[(-1.58, 0.0), (-1.35, 0.43), (-1.08, 0.80), (-0.92, 0.95), (-0.75, 1.0), (-0.15, 1.0), (0.02, 0.96), (0.3, 0.76), (0.6, 0.44), (0.88, 0.0)],
            zdlo=[(-1.6, 1.33), (-0.4, 1.375), (0.9, 1.36)], zrail=[(-1.6, 1.39), (-0.4, 1.425), (0.9, 1.41)],
            zroof=[(-1.6, 1.42), (-0.45, 1.455), (0.9, 1.44)], wdlo=0.715, wrail=[(-1.6, 0.61), (-0.4, 0.645), (0.9, 0.65)]),
)
SEDAN['details'] = std_car_details(dict(
    head=dict(cx=0.46, back=0.45, z0=0.585, z1=0.665, dz0=0.04, dz1=0.03, th0=-22, th1=68),
    tail=dict(cx=0.52, back=0.42, z0=0.80, z1=0.925, dz1=-0.02, th0=-30, th1=78),
    grille=dict(x0=lambda v: -0.36 - (v - 0.42) * 0.3, x1=lambda v: 0.36 + (v - 0.42) * 0.3, z0=0.42, z1=0.575),
    intake=dict(x0=-0.55, x1=0.55, z0=0.255, z1=0.36),
    plate_f=0.385, plate_r=0.54,
    diffuser=dict(x=0.72, z0=0.33, z1=0.43), refl=dict(x0=0.74, x1=0.84, z0=0.45, z1=0.475),
    cbrake=dict(x=0.2, z0=1.385, z1=1.405),
    seams=[(0.98, 0.33, 0.94), (-0.26, 0.33, 0.955), (-1.0, 0.33, 0.965)],
    handles=[(0.36, 0.87), (-0.62, 0.885)], handle_mat='metal.chrome', repeater=(1.10, 0.80),
    mirror=dict(x=0.84, y=0.76, z=1.0),
    exhaust=[(0.5, -2.3, 0.30, 0.038), (-0.5, -2.3, 0.30, 0.038)],
))


# ---- hatchback ----------------------------------------------------------------------------
HATCH = dict(
    L=4.25, R=0.32, axles=[1.265, -1.375], track=0.78, tyre_w=0.205, rim_r=0.21, wheel='alloy6',
    wmax=0.90, wsb=0.87, wsill=0.888, win=0.60,
    zf=[(-2.125, 0.37), (-2.09, 0.30), (-2.0, 0.22), (-1.8, 0.18), (1.75, 0.18), (1.95, 0.22), (2.07, 0.27), (2.125, 0.30)],
    zsb=[(-2.125, 0.39), (-2.09, 0.32), (-2.0, 0.26), (-1.8, 0.22), (1.7, 0.22), (1.95, 0.26), (2.07, 0.30), (2.125, 0.32)],
    zsh=[(-2.125, 0.86), (-1.5, 0.88), (0.0, 0.84), (1.4, 0.78), (2.125, 0.62)],
    zbelt=[(-2.125, 0.965), (-2.1, 0.995), (-2.05, 1.005), (-1.6, 1.01), (0.8, 0.95), (1.5, 0.88), (1.9, 0.81), (2.07, 0.75), (2.125, 0.70)],
    zdeck=[(-2.125, 0.975), (-2.1, 1.005), (-2.05, 1.015), (-1.6, 1.02), (0.8, 0.955), (1.5, 0.895), (1.9, 0.82), (2.07, 0.755), (2.125, 0.69)],
    wbelt=[(-2.125, 0.80), (-1.6, 0.82), (0.8, 0.835), (1.7, 0.815), (2.125, 0.78)],
    plan=endplan(-2.125, 2.125, 0.10, 0.18),
    capz={'lo': 0.45, 'hi': 0.41},
    gh=dict(u_cowl=0.80, u_ws=-0.12, u_bl=-1.62, u_back=-2.02, u_b=-0.38, bw=0.045, u_cglass=-1.28,
            hr=[(-2.02, 0.0), (-1.96, 0.45), (-1.82, 0.82), (-1.62, 0.98), (-1.45, 1.0), (-0.25, 1.0), (-0.08, 0.96), (0.2, 0.75), (0.5, 0.43), (0.80, 0.0)],
            zdlo=[(-2.0, 1.38), (-0.6, 1.42), (0.8, 1.40)], zrail=[(-2.0, 1.45), (-0.6, 1.475), (0.8, 1.46)],
            zroof=[(-2.0, 1.475), (-0.7, 1.505), (0.8, 1.49)], wdlo=0.70, wrail=[(-2.0, 0.60), (-0.6, 0.64), (0.8, 0.645)],
            stations=[-1.99, -1.97, -1.93, -1.88]),
)
HATCH['details'] = std_car_details(dict(
    head=dict(cx=0.44, back=0.42, z0=0.605, z1=0.69, dz0=0.04, dz1=0.03, th0=-20, th1=70),
    tail=dict(cx=0.55, back=0.32, z0=0.86, z1=1.0, dz0=0.0, dz1=-0.03, th0=-18, th1=80),
    grille=dict(x0=lambda v: -0.32 - (v - 0.43) * 0.4, x1=lambda v: 0.32 + (v - 0.43) * 0.4, z0=0.43, z1=0.58),
    intake=dict(x0=-0.5, x1=0.5, z0=0.27, z1=0.37),
    plate_f=0.40, plate_r=0.62,
    diffuser=dict(x=0.7, z0=0.35, z1=0.46), refl=dict(x0=0.70, x1=0.80, z0=0.48, z1=0.505),
    cbrake=dict(x=0.17, z0=1.43, z1=1.45),
    seams=[(0.86, 0.34, 0.955), (-0.38, 0.34, 0.985), (-1.0, 0.34, 1.0)],
    handles=[(0.26, 0.905), (-0.72, 0.93)], repeater=(0.92, 0.81),
    mirror=dict(x=0.82, y=0.68, z=1.03),
    exhaust=[(-0.5, -2.06, 0.31, 0.033)],
))


# ---- SUV ----------------------------------------------------------------------------------
def suv_clad(u, t, c):
    if c.z < 0.47 and t < 4.7:
        return 'trim.black'
    for ay in (1.495, -1.365):
        if math.hypot(c.y - ay, c.z - 0.385) < 0.47 and t < 5.2:
            return 'trim.black'
    return None


SUV = dict(
    L=4.85, R=0.37, axles=[1.495, -1.365], track=0.83, tyre_w=0.235, rim_r=0.235, wheel='alloy7', archgap=0.05,
    wmax=0.975, wsb=0.95, wsill=0.965, win=0.66, clad=suv_clad, sill=0.12,
    zf=[(-2.425, 0.46), (-2.39, 0.38), (-2.3, 0.30), (-2.05, 0.25), (2.0, 0.25), (2.25, 0.30), (2.37, 0.36), (2.425, 0.40)],
    zsb=[(-2.425, 0.48), (-2.39, 0.41), (-2.3, 0.34), (-2.05, 0.30), (1.95, 0.30), (2.25, 0.34), (2.37, 0.39), (2.425, 0.42)],
    zsh=[(-2.425, 0.95), (-1.5, 0.98), (0.0, 0.95), (1.6, 0.92), (2.425, 0.78)],
    zbelt=[(-2.425, 1.07), (-2.40, 1.10), (-2.35, 1.11), (-1.6, 1.11), (0.95, 1.06), (1.7, 1.0), (2.2, 0.95), (2.37, 0.90), (2.425, 0.86)],
    zdeck=[(-2.425, 1.08), (-2.40, 1.11), (-2.35, 1.12), (-1.6, 1.12), (0.95, 1.07), (1.7, 1.015), (2.2, 0.96), (2.37, 0.905), (2.425, 0.85)],
    wbelt=[(-2.425, 0.86), (-1.6, 0.885), (0.95, 0.90), (1.9, 0.89), (2.425, 0.85)],
    plan=endplan(-2.425, 2.425, 0.09, 0.15),
    capz={'lo': 0.52, 'hi': 0.47},
    gh=dict(u_cowl=0.95, u_ws=0.02, u_bl=-1.98, u_back=-2.30, u_b=-0.38, bw=0.05, u_cglass=-1.88,
            hr=[(-2.30, 0.0), (-2.27, 0.45), (-2.17, 0.85), (-1.98, 0.985), (-1.8, 1.0), (-0.12, 1.0), (0.06, 0.95), (0.35, 0.73), (0.65, 0.42), (0.95, 0.0)],
            zdlo=[(-2.3, 1.56), (-0.6, 1.60), (0.95, 1.58)], zrail=[(-2.3, 1.64), (-0.6, 1.665), (0.95, 1.65)],
            zroof=[(-2.3, 1.665), (-0.7, 1.695), (0.95, 1.685)], wdlo=0.775, wrail=[(-2.3, 0.66), (-0.6, 0.70), (0.95, 0.70)],
            cpillar='trim.gloss', stations=[-2.29, -2.25, -2.21, -2.13]),
)
SUV['details'] = std_car_details(dict(
    head=dict(cx=0.50, back=0.45, z0=0.76, z1=0.84, dz0=0.03, dz1=0.02, th0=-20, th1=66),
    tail=dict(cx=0.60, back=0.30, z0=0.98, z1=1.10, dz1=-0.02, th0=-20, th1=80),
    grille=dict(x0=lambda v: -0.42 - (v - 0.5) * 0.15, x1=lambda v: 0.42 + (v - 0.5) * 0.15, z0=0.52, z1=0.74, frame='trim.gloss'),
    intake=dict(x0=-0.6, x1=0.6, z0=0.36, z1=0.47),
    plate_f=0.40, plate_r=0.74,
    diffuser=dict(x=0.85, z0=0.42, z1=0.58), refl=dict(x0=0.80, x1=0.90, z0=0.60, z1=0.63),
    cbrake=dict(x=0.2, z0=1.645, z1=1.66),
    seams=[(1.00, 0.45, 1.06), (-0.38, 0.45, 1.09), (-1.0, 0.45, 1.10)],
    handles=[(0.28, 1.0), (-0.75, 1.03)], repeater=(1.03, 0.97),
    mirror=dict(x=0.885, y=0.83, z=1.14, w=0.22, h=0.14),
    exhaust=[(0.55, -2.38, 0.36, 0.04), (-0.55, -2.38, 0.36, 0.04)],
    extra=roof_rails(0.60, 1.66, -1.75, 0.0),
))


# ---- sports coupe -------------------------------------------------------------------------
SPORTS = dict(
    L=4.40, R=0.335, axles=[1.22, -1.33], track=0.835, tyre_w=0.255, rim_r=0.255, wheel='alloy5x2', archgap=0.04,
    wmax=0.975, wsb=0.95, wsill=0.962, win=0.64, sill=0.08,
    zf=[(-2.2, 0.30), (-2.16, 0.22), (-2.05, 0.15), (-1.75, 0.12), (1.75, 0.12), (2.0, 0.14), (2.14, 0.17), (2.2, 0.20)],
    zsb=[(-2.2, 0.32), (-2.16, 0.25), (-2.05, 0.19), (-1.75, 0.15), (1.7, 0.15), (2.0, 0.17), (2.14, 0.20), (2.2, 0.22)],
    zsh=[(-2.2, 0.70), (-1.4, 0.76), (-0.3, 0.68), (1.2, 0.64), (2.2, 0.46)],
    zbelt=[(-2.2, 0.845), (-2.17, 0.88), (-2.1, 0.895), (-1.7, 0.895), (-1.3, 0.88), (0.45, 0.78), (1.2, 0.72), (1.8, 0.63), (2.1, 0.55), (2.2, 0.50)],
    zdeck=[(-2.2, 0.85), (-2.17, 0.885), (-2.1, 0.895), (-1.7, 0.885), (-1.3, 0.87), (0.45, 0.775), (1.2, 0.70), (1.8, 0.62), (2.1, 0.545), (2.2, 0.49)],
    wbelt=[(-2.2, 0.80), (-1.4, 0.86), (-0.5, 0.82), (0.5, 0.81), (1.6, 0.86), (2.2, 0.80)],
    plan=endplan(-2.2, 2.2, 0.10, 0.20, front_len=0.9),
    capz={'lo': 0.36, 'hi': 0.30},
    gh=dict(u_cowl=0.50, u_ws=-0.42, u_bl=-0.85, u_back=-1.92, u_b=-1.0, bw=0.0, u_cglass=-1.02, inset=0.03,
            hr=[(-1.92, 0.0), (-1.6, 0.42), (-1.2, 0.80), (-0.85, 0.97), (-0.62, 1.0), (-0.5, 0.99), (-0.3, 0.92), (-0.05, 0.70), (0.25, 0.37), (0.50, 0.0)],
            zdlo=[(-1.9, 1.17), (-0.6, 1.20), (0.5, 1.18)], zrail=[(-1.9, 1.22), (-0.6, 1.245), (0.5, 1.23)],
            zroof=[(-1.9, 1.235), (-0.65, 1.255), (0.5, 1.245)], wdlo=0.70, wrail=[(-1.9, 0.56), (-0.7, 0.62), (0.5, 0.63)],
            side_glass=lambda u, t, c: 'paint.body' if u < -1.02 + (t - 2.0) * 0.25 else None),
)


def sports_extra(mb, cx):
    # rear wing lip + side intakes
    decal(mb, cx['bvh'], side_planar(-1.0, -0.62, 0.52, 0.64), 4, 2, 'trim.grille', off=0.004)
    V.box(mb, (0, -2.02, 0.92), (1.45, 0.20, 0.025), 'trim.gloss', bevel=0.01, segments=1)
    for s in (1, -1):
        V.box(mb, (s * 0.5, -1.98, 0.895), (0.03, 0.08, 0.05), 'trim.gloss', bevel=0.006, segments=1)


SPORTS['details'] = std_car_details(dict(
    head=dict(cx=0.48, back=0.55, z0=0.43, z1=0.495, dz0=0.07, dz1=0.05, th0=-15, th1=72),
    tail=dict(cx=0.40, back=0.35, z0=0.74, z1=0.80, dz1=0.0, th0=-80, th1=80,
              cells=lambda i, j, na, nb: 'tail.lamp' if j >= 1 else ('ind.lamp' if i < 2 or i >= na - 2 else 'lens.red')),
    grille=dict(x0=-0.45, x1=0.45, z0=0.20, z1=0.34, frame='trim.gloss'),
    plate_f=0.36, plate_r=0.50,
    diffuser=dict(x=0.80, z0=0.24, z1=0.42), refl=dict(x0=0.80, x1=0.88, z0=0.44, z1=0.46),
    cbrake=dict(x=0.25, z0=1.19, z1=1.20),
    seams=[(0.55, 0.28, 0.77), (-0.95, 0.28, 0.85)],
    handles=[(-0.62, 0.80)], repeater=(0.75, 0.64),
    mirror=dict(x=0.84, y=0.35, z=0.84, w=0.19, h=0.10),
    exhaust=[(0.32, -2.15, 0.27, 0.045), (0.42, -2.15, 0.27, 0.045), (-0.32, -2.15, 0.27, 0.045), (-0.42, -2.15, 0.27, 0.045)],
    extra=sports_extra,
))


# ---- panel van ----------------------------------------------------------------------------
def van_side_glass(u, t, c):
    if c.z > 1.93:
        return 'paint.body'
    if u > 1.06:
        return 'glass.tint'
    return 'paint.body'


def van_rear(u, t, c):
    ax = abs(c.x)
    if ax < 0.012:
        return 'trim.seam'
    return 'paint.body'


VAN = dict(
    L=5.40, R=0.35, axles=[1.70, -1.96], track=0.85, tyre_w=0.235, rim_r=0.205, wheel='steelcap', rim_mat='metal.gun', archgap=0.06,
    wmax=1.0, wsb=0.975, wsill=0.99, win=0.70, sill=0.14,
    zf=[(-2.7, 0.42), (-2.62, 0.36), (-2.45, 0.30), (2.3, 0.30), (2.55, 0.34), (2.66, 0.38), (2.7, 0.42)],
    zsb=[(-2.7, 0.44), (-2.62, 0.38), (-2.45, 0.34), (2.3, 0.34), (2.55, 0.37), (2.66, 0.41), (2.7, 0.45)],
    zsh=[(-2.7, 1.0), (0.0, 1.0), (1.9, 0.98), (2.7, 0.82)],
    zbelt=[(-2.7, 1.12), (1.9, 1.12), (2.25, 1.06), (2.55, 1.0), (2.67, 0.95), (2.7, 0.90)],
    zdeck=[(-2.7, 1.12), (1.9, 1.13), (2.25, 1.07), (2.55, 1.0), (2.67, 0.94), (2.7, 0.88)],
    wbelt=[(-2.7, 0.97), (1.9, 0.97), (2.7, 0.90)],
    plan=[(-2.7, 0.93), (-2.66, 0.975), (-2.58, 0.995), (-2.45, 1.0), (2.0, 1.0), (2.3, 0.985), (2.5, 0.955), (2.64, 0.905), (2.7, 0.84)],
    capz={'lo': 0.56, 'hi': 0.55},
    gh=dict(u_cowl=1.90, u_ws=1.17, u_bl=-2.55, u_back=-2.69, u_b=-10, bw=0.0, u_cglass=1.06, inset=0.015,
            hr=[(-2.69, 0.0), (-2.67, 0.5), (-2.62, 0.9), (-2.55, 1.0), (0.6, 1.0), (0.95, 0.90), (1.17, 0.66), (1.5, 0.33), (1.90, 0.0)],
            zdlo=2.27, zrail=2.39, zroof=2.50, wdlo=0.955, wrail=0.90, side_glass=van_side_glass, rear=van_rear,
            tsamp=[2.7], stations=[-2.68, -2.66, -2.64, -2.6, 1.06]),
)


def van_extra(mb, cx):
    bvh = cx['bvh']
    # black bumpers + rear step, sliding door rail
    decal(mb, bvh, front_planar(2.7, -0.95, 0.95, 0.34, 0.56), 10, 2, 'trim.black', off=0.004, mirror=False)
    decal(mb, bvh, rear_planar(-2.7, -0.98, 0.98, 0.34, 0.55), 10, 2, 'trim.black', off=0.004, mirror=False)
    decal(mb, bvh, side_planar(-1.62, 1.0, 1.98, 2.0), 20, 1, 'trim.black', off=0.004)
    decal(mb, bvh, side_planar(-2.4, 2.2, 0.36, 0.52), 24, 2, 'trim.black', off=0.004)
    for y in (1.06, 0.06, -1.62, -2.66):
        decal(mb, cx['bvh_gh'], side_planar(y - 0.005, y + 0.005, 1.13, 2.3), 1, 6, 'trim.seam', off=0.003)
    # rear door centre seam on the lower body
    decal(mb, bvh, rear_planar(-2.7, -0.005, 0.005, 0.55, 1.12), 1, 4, 'trim.seam', off=0.003, mirror=False)
    # high stop lamp at the roof edge, roof marker lamps
    decal(mb, cx['bvh_gh'], rear_planar(-2.7, -0.22, 0.22, 2.40, 2.43), 6, 1, 'brake.lamp', mirror=False)
    decal(mb, cx['bvh_gh'], front_planar(2.7, 0.55, 0.62, 2.40, 2.43), 1, 1, 'markerA.lamp')


VAN['details'] = std_car_details(dict(
    head=dict(cx=0.62, back=0.40, z0=0.80, z1=0.94, dz0=0.0, dz1=0.0, th0=-18, th1=62),
    tail=dict(cx=0.78, back=0.18, z0=0.58, z1=1.06, th0=-35, th1=78,
              cells=lambda i, j, na, nb: 'tail.lamp' if j >= 3 else ('ind.lamp' if j == 2 else ('lens.clear' if j == 1 else 'lens.red'))),
    grille=dict(x0=-0.48, x1=0.48, z0=0.60, z1=0.80, frame='trim.gloss'),
    plate_f=0.40, plate_r=0.57,
    seams=[(1.06, 0.56, 1.12)], handles=[(0.95, 1.02), (0.0, 1.02)], repeater=(1.25, 0.98),
    mirror=dict(x=0.96, y=1.85, z=1.36, w=0.22, d=0.09, h=0.30, mat='trim.black'),
    extra=van_extra,
))

TYPES = {'sedan': SEDAN, 'hatch': HATCH, 'suv': SUV, 'sports': SPORTS, 'van': VAN}


# ───────────────────────────────────────────────────────────── driver

def build(name, outdir):
    V.clear_scene()
    P = TYPES[name]
    parts = P['builder'](P) if 'builder' in P else build_car(P)
    objs = [mb.to_object(recalc=mb.name in ('body', 'gh', 'wheels') or mb.name.startswith('shell')) for mb in parts]
    nb = P.get('n_body_parts', 2)
    xs = [abs(v.co.x) for o in objs[:nb] for v in o.data.vertices]
    ys = [v.co.y for o in objs for v in o.data.vertices]
    zs = [v.co.z for o in objs for v in o.data.vertices]
    dims = dict(length=round(max(ys) - min(ys), 3), width=round(2 * max(xs), 3), height=round(max(zs), 3))
    obj = V.join(objs, name)
    V.finalize(obj)
    V.bake_ao(obj, rays=40, dist=0.8)
    tris = V.tri_count(obj)
    (x0, x1), (y0, y1), (z0, z1) = V.measure(obj)
    path = os.path.join(outdir, name + '.glb')
    V.export_glb(obj, path)
    info = dict(type=name, tris=tris, size=[round(x1 - x0, 3), round(y1 - y0, 3), round(z1 - z0, 3)], dims=dims)
    with open(os.path.join(outdir, name + '.json'), 'w') as fh:
        json.dump(info, fh)
    print('[traffic] ' + json.dumps(info))
    return info


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    which = argv[0] if argv else 'all'
    outdir = argv[1] if len(argv) > 1 else os.path.join(HERE, '..', '..', 'assets-src', 'traffic', 'out')
    os.makedirs(outdir, exist_ok=True)
    import trucks
    TYPES.update(trucks.register(globals()))
    names = list(TYPES) if which == 'all' else which.split(',')
    for n in names:
        build(n, outdir)


main()
