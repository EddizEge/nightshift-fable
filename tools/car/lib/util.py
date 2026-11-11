"""
Small helpers shared by the car modules (Blender 4.3, background mode).

Everything here works without a window: no operator that needs a 3D view.
"""
import math
import bmesh
import bpy
from mathutils import Matrix, Vector


def low_priority():
    """The build must not get in the way of whatever else runs on the machine."""
    try:
        import ctypes
        k = ctypes.windll.kernel32
        k.SetPriorityClass(k.GetCurrentProcess(), 0x00004000)  # BELOW_NORMAL_PRIORITY_CLASS
    except Exception:
        pass


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.unit_settings.system = 'METRIC'
    sc.unit_settings.scale_length = 1.0
    return sc


def collection(name):
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(col)
    return col


def link(obj, col=None):
    (col or bpy.context.scene.collection).objects.link(obj)
    return obj


def empty(name, loc=(0, 0, 0), parent=None, col=None, size=0.05):
    o = bpy.data.objects.new(name, None)
    o.empty_display_size = size
    o.location = loc
    link(o, col)
    if parent is not None:
        set_parent(o, parent)
    return o


def mesh_object(name, verts, faces, col=None, materials=None, face_materials=None, smooth=True):
    """
    Mesh object from plain lists.  `materials`: list of bpy materials (slots, in order);
    `face_materials`: slot index per face (default 0).
    """
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    me.validate(verbose=False)
    me.update()
    if materials:
        for m in materials:
            me.materials.append(m)
    if face_materials:
        me.polygons.foreach_set('material_index', list(face_materials))
    obj = bpy.data.objects.new(name, me)
    link(obj, col)
    shade(obj, smooth)
    return obj


def object_from_bmesh(name, bm, col=None, materials=None, smooth=True):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    me.update()
    if materials:
        for m in materials:
            me.materials.append(m)
    obj = bpy.data.objects.new(name, me)
    link(obj, col)
    shade(obj, smooth)
    return obj


def shade(obj, smooth=True, sharp_angle_deg=None):
    """Smooth shading; with `sharp_angle_deg`, edges steeper than that become hard (split normals)."""
    me = obj.data
    me.polygons.foreach_set('use_smooth', [bool(smooth)] * len(me.polygons))
    if sharp_angle_deg is not None:
        me.set_sharp_from_angle(angle=math.radians(sharp_angle_deg))
    me.update()
    return obj


def activate(obj):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def add_modifier(obj, kind, name=None, **props):
    m = obj.modifiers.new(name or kind.title(), kind)
    for k, v in props.items():
        setattr(m, k, v)
    return m


def apply_modifiers(obj):
    """Bake the whole modifier stack into the mesh (keeps materials and the object transform)."""
    if not obj.modifiers:
        return obj
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    old = obj.data
    me.name = old.name
    obj.modifiers.clear()
    obj.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return obj


def apply_transform(obj):
    """Bake the object's own transform into its mesh (object ends up at identity)."""
    bpy.context.view_layer.update()
    me = obj.data
    mw = obj.matrix_world.copy()
    me.transform(mw)
    if mw.determinant() < 0:
        me.flip_normals()
    obj.matrix_world = Matrix.Identity(4)
    me.update()
    return obj


def set_origin(obj, point):
    """Move the object's origin to a world point without moving the geometry."""
    bpy.context.view_layer.update()
    p = Vector(point)
    mw = obj.matrix_world.copy()
    local = mw.inverted() @ p
    obj.data.transform(Matrix.Translation(-local))
    obj.matrix_world = mw @ Matrix.Translation(local)
    obj.data.update()
    return obj


def set_parent(child, parent):
    """Parent while keeping the child's world transform."""
    bpy.context.view_layer.update()
    mw = child.matrix_world.copy()
    child.parent = parent
    child.matrix_parent_inverse = parent.matrix_world.inverted()
    child.matrix_world = mw
    return child


def join(objs, name=None):
    """Join mesh objects into the first one (material slots are merged by material)."""
    objs = [o for o in objs if o is not None]
    if not objs:
        return None
    base = objs[0]
    if len(objs) > 1:
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = base
        with bpy.context.temp_override(active_object=base, object=base, selected_objects=objs, selected_editable_objects=objs):
            bpy.ops.object.join()
    if name:
        base.name = name
        base.data.name = name
    return base


def duplicate(obj, name=None, col=None):
    o = obj.copy()
    o.data = obj.data.copy()
    if name:
        o.name = name
        o.data.name = name
    link(o, col or (obj.users_collection[0] if obj.users_collection else None))
    return o


def mirrored_copy(obj, name, col=None):
    """Copy of a mesh object mirrored across the YZ plane (x -> -x), normals kept outward."""
    o = duplicate(obj, name, col)
    apply_transform(o)
    o.data.transform(Matrix.Scale(-1, 4, Vector((1, 0, 0))))
    o.data.flip_normals()
    o.data.update()
    return o


def tri_count(objs):
    if not isinstance(objs, (list, tuple)):
        objs = [objs]
    n = 0
    for o in objs:
        if o is None or o.type != 'MESH':
            continue
        for p in o.data.polygons:
            n += len(p.vertices) - 2
    return n


def bounds(objs):
    """World-space bounding box (min Vector, max Vector) of mesh objects."""
    if not isinstance(objs, (list, tuple)):
        objs = [objs]
    bpy.context.view_layer.update()
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        if o is None or o.type != 'MESH':
            continue
        mw = o.matrix_world
        for v in o.data.vertices:
            p = mw @ v.co
            for i in range(3):
                lo[i] = min(lo[i], p[i])
                hi[i] = max(hi[i], p[i])
    return lo, hi


# ── geometry builders ───────────────────────────────────────────────────────────────────────

def lathe(profile, segments, axis='X', closed_profile=False, angle=2 * math.pi):
    """
    Surface of revolution.  `profile`: list of (a, r): position along the axis and radius.
    Returns (verts, faces); quads wind so that normals point away from the axis when the profile
    runs towards +axis ... check with `flip` at the call site if needed (use bmesh recalc otherwise).
    """
    verts = []
    faces = []
    n = len(profile)
    full = abs(angle - 2 * math.pi) < 1e-9
    cols = segments if full else segments + 1
    for j in range(cols):
        t = angle * j / segments
        c, s = math.cos(t), math.sin(t)
        for a, r in profile:
            if axis == 'X':
                verts.append((a, r * c, r * s))
            elif axis == 'Y':
                verts.append((r * s, a, r * c))
            else:
                verts.append((r * c, r * s, a))
    pn = n if closed_profile else n - 1
    for j in range(segments):
        j1 = (j + 1) % cols
        for i in range(pn):
            i1 = (i + 1) % n
            faces.append((j * n + i, j1 * n + i, j1 * n + i1, j * n + i1))
    return verts, faces


def recalc_normals(obj, inside=False):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if inside:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return obj


def weld(obj, dist=1e-5):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=dist)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return obj


def box(name, size, loc=(0, 0, 0), col=None, materials=None, bevel=0.0, segments=2):
    """Axis-aligned box, optionally with rounded edges."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=segments, profile=0.5, affect='EDGES')
    obj = object_from_bmesh(name, bm, col, materials)
    bm.free()
    obj.location = loc
    shade(obj, True, 40)
    return obj


def to_gltf(p):
    """Blender (x, y, z) -> game / glTF car space (x, z, -y)."""
    return [round(p[0], 4), round(p[2], 4), round(-p[1], 4)]
