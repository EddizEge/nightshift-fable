"""
Preview renders of the car (look development only; nothing here ends up in the game).

  beauty: Cycles, dark studio with light strips and a glossy floor
  zebra:  Workbench with the horizontal reflection-check matcap (shows every bump in a surface)
  clay:   Workbench studio clay (shape without materials)
"""
import math
import os
import bpy
from mathutils import Vector

# name: (camera position, look-at point, focal length mm).  The nose of the car points to +Y.
VIEWS = {
    'front34':   ((-3.3, 4.7, 1.35), (0.0, 0.25, 0.52), 40),
    'rear34':    ((3.3, -5.0, 1.55), (0.0, -0.20, 0.55), 40),
    'rear34l':   ((-3.3, -5.0, 1.55), (0.0, -0.20, 0.55), 40),
    'side':      ((-7.6, 0.05, 0.85), (0.0, 0.05, 0.58), 50),
    'front':     ((0.0, 7.6, 0.85), (0.0, 0.0, 0.58), 70),
    'rear':      ((0.0, -7.6, 0.95), (0.0, 0.0, 0.60), 70),
    'top':       ((0.0, 0.05, 9.5), (0.0, 0.05, 0.0), 60),
    'low':       ((-2.5, 3.7, 0.42), (0.15, 0.55, 0.55), 35),      # like the menu shot
    'chase':     ((0.0, -6.4, 2.25), (0.0, 1.5, 0.65), 30),        # like the driving camera
    'hood':      ((-0.0, 0.10, 1.02), (0.0, 6.0, 0.55), 22),       # like the bonnet camera
    'wheel':     ((-2.25, 2.35, 0.55), (-0.93, 1.40, 0.38), 70),
    'rwheel':    ((-2.35, -2.2, 0.55), (-0.95, -1.40, 0.38), 70),
    'headlight': ((-1.75, 3.45, 0.80), (-0.60, 2.08, 0.62), 70),
    'tail':      ((1.45, -3.7, 1.00), (0.30, -2.15, 0.80), 60),
    'cabin':     ((-2.6, 0.9, 1.35), (0.0, -0.1, 0.85), 50),
    'under':     ((-2.2, -3.4, 0.22), (0.0, -1.2, 0.35), 35),
}


def _look_at(cam, target):
    d = Vector(target) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def _emission_material(name, color, strength):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = (color[0], color[1], color[2], 1)
    em.inputs['Strength'].default_value = strength
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    return m


def setup_studio(floor=True):
    """Dark room, long light strips overhead and at the sides (they draw lines on the paint), glossy floor."""
    sc = bpy.context.scene
    col = bpy.data.collections.new('Studio')
    sc.collection.children.link(col)
    world = bpy.data.worlds.new('StudioWorld')
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.012, 0.014, 0.018, 1)
    bg.inputs['Strength'].default_value = 1.0
    sc.world = world

    def strip(name, size, loc, rot, color, strength):
        me = bpy.data.meshes.new(name)
        sx, sy = size[0] / 2, size[1] / 2
        me.from_pydata([(-sx, -sy, 0), (sx, -sy, 0), (sx, sy, 0), (-sx, sy, 0)], [], [(0, 1, 2, 3)])
        me.materials.append(_emission_material(name + '_m', color, strength))
        o = bpy.data.objects.new(name, me)
        o.location = loc
        o.rotation_euler = rot
        col.objects.link(o)
        o.visible_camera = False
        return o

    # overhead soft boxes (long, along the car) and two side walls of light
    strip('KeyTop', (2.2, 9.0), (0.0, 0.0, 5.0), (0, 0, 0), (1.0, 0.97, 0.92), 9.0)
    strip('StripL', (0.5, 10.0), (-4.5, 0.0, 3.2), (0, math.radians(-50), 0), (0.85, 0.92, 1.0), 14.0)
    strip('StripR', (0.5, 10.0), (4.5, 0.0, 3.2), (0, math.radians(50), 0), (1.0, 0.93, 0.85), 14.0)
    strip('Front', (7.0, 1.2), (0.0, 7.5, 2.6), (math.radians(60), 0, 0), (1.0, 1.0, 1.0), 6.0)
    strip('Back', (7.0, 1.2), (0.0, -7.5, 2.6), (math.radians(-60), 0, 0), (1.0, 1.0, 1.0), 6.0)
    strip('LowL', (0.25, 8.0), (-5.5, 0.0, 0.7), (0, math.radians(-85), 0), (1.0, 1.0, 1.0), 10.0)
    strip('LowR', (0.25, 8.0), (5.5, 0.0, 0.7), (0, math.radians(85), 0), (1.0, 1.0, 1.0), 10.0)

    if floor:
        me = bpy.data.meshes.new('Floor')
        s = 40
        me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
        m = bpy.data.materials.new('FloorMat')
        m.use_nodes = True
        p = m.node_tree.nodes['Principled BSDF']
        p.inputs['Base Color'].default_value = (0.02, 0.021, 0.024, 1)
        p.inputs['Roughness'].default_value = 0.22
        p.inputs['Metallic'].default_value = 0.0
        me.materials.append(m)
        o = bpy.data.objects.new('Floor', me)
        col.objects.link(o)
    return col


def _camera():
    sc = bpy.context.scene
    cam = sc.camera
    if cam is None:
        cd = bpy.data.cameras.new('PreviewCam')
        cam = bpy.data.objects.new('PreviewCam', cd)
        sc.collection.objects.link(cam)
        sc.camera = cam
    cam.data.clip_start = 0.05
    cam.data.clip_end = 200
    cam.data.sensor_width = 36
    return cam


def render_views(out_dir, views, mode='beauty', res=(1280, 720), samples=40, prefix='car', device='CPU', exposure=0.0):
    """Render the named views (see VIEWS; a view may also be a ((pos), (target), lens) tuple keyed by name in a dict)."""
    sc = bpy.context.scene
    out_dir = os.path.abspath(out_dir)      # Blender resolves a relative path against the drive root
    os.makedirs(out_dir, exist_ok=True)
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Medium High Contrast'
    sc.view_settings.exposure = exposure
    if mode == 'beauty':
        sc.render.engine = 'CYCLES'
        sc.cycles.samples = samples
        sc.cycles.use_denoising = True
        sc.cycles.max_bounces = 6
        sc.cycles.transparent_max_bounces = 8
        sc.cycles.device = 'CPU'
        if device == 'GPU':
            try:
                prefs = bpy.context.preferences.addons['cycles'].preferences
                prefs.compute_device_type = 'OPTIX'
                prefs.get_devices()
                for d in prefs.devices:
                    d.use = d.type == 'OPTIX'
                sc.cycles.device = 'GPU'
            except Exception as e:  # no usable GPU: stay on the CPU
                print('[render] GPU not available:', e)
        sc.render.threads_mode = 'FIXED'
        sc.render.threads = 12
    else:
        sc.render.engine = 'BLENDER_WORKBENCH'
        sh = sc.display.shading
        sh.light = 'MATCAP'
        sh.studio_light = 'reflection_check_horizontal.exr' if mode == 'zebra' else 'clay_studio.exr'
        sh.color_type = 'SINGLE'
        sh.single_color = (0.8, 0.8, 0.8)
        sh.show_cavity = mode == 'clay'
        sh.show_object_outline = False
        sc.display.render_aa = '8'
        sc.view_settings.view_transform = 'Standard'
        sc.view_settings.look = 'None'
        studio = bpy.data.collections.get('Studio')
        if studio is not None:          # the light strips are only in the way of a matcap render
            for o in studio.objects:
                o.hide_render = o.name != 'Floor'
    cam = _camera()
    done = []
    items = views.items() if isinstance(views, dict) else [(v, VIEWS[v]) for v in views]
    for name, (pos, target, lens) in items:
        cam.location = pos
        cam.data.lens = lens
        _look_at(cam, target)
        if name == 'top':                 # straight down, nose of the car to the left
            cam.rotation_euler = (0.0, 0.0, -math.pi / 2)
        path = os.path.join(out_dir, f'{prefix}-{mode}-{name}.png')
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        done.append(path)
        print('[render] wrote', path)
    return done
