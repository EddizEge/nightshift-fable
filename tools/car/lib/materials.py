"""
Materials of the player car.  The game looks materials up BY NAME (src/vehicle/playerCarVisual.ts)
and replaces most of the shading at run time (paint presets, emissive strength of the lamps, rain
beads on the clearcoat), so what matters here is: the name, sensible PBR values for the glTF file
and for the preview renders.
"""
import bpy

# name: base colour (linear), metallic, roughness, extras
DEFS = {
    # painted body panels: metallic base under a clearcoat (the game swaps the colour per paint preset)
    'paint_main':      dict(color=(0.050, 0.052, 0.058), metallic=0.85, roughness=0.34, coat=1.0, coat_roughness=0.04),
    # gloss black panels: roof, pillars, lower body
    'paint_accent':    dict(color=(0.012, 0.012, 0.013), metallic=0.60, roughness=0.30, coat=1.0, coat_roughness=0.05),
    # bare carbon fibre: splitter, diffuser, sills, mirror caps (the weave is a procedural texture in the game)
    'carbon':          dict(color=(0.020, 0.020, 0.022), metallic=0.30, roughness=0.36, coat=1.0, coat_roughness=0.10),
    # matt black plastic and rubber seals
    'trim':            dict(color=(0.006, 0.006, 0.007), metallic=0.0, roughness=0.70),
    # mesh inserts of the air intakes, inside of ducts, wheel houses, underfloor
    'grille':          dict(color=(0.003, 0.003, 0.003), metallic=0.1, roughness=0.75),
    # woven metal mesh behind the openings: tail panel, nose intakes, bonnet outlets (the game draws the mesh pattern)
    'grille_mesh':     dict(color=(0.020, 0.020, 0.022), metallic=0.6, roughness=0.40),
    # tinted window glass
    'glass':           dict(color=(0.020, 0.022, 0.025), metallic=0.0, roughness=0.02, alpha=0.36),
    # clear covers of the lamps
    'lens':            dict(color=(0.90, 0.92, 0.95), metallic=0.0, roughness=0.03, alpha=0.16),
    'mirror':          dict(color=(0.90, 0.90, 0.90), metallic=1.0, roughness=0.02),
    'interior':        dict(color=(0.012, 0.012, 0.013), metallic=0.0, roughness=0.75),
    'interior_accent': dict(color=(0.080, 0.012, 0.010), metallic=0.0, roughness=0.60),
    'dashboard':       dict(color=(0.002, 0.002, 0.002), metallic=0.0, roughness=0.40, emission=(0.25, 0.55, 1.0), emission_strength=1.0),
    # satin metal: bolts, exhaust tips, badges-that-are-not-badges
    'hardware':        dict(color=(0.27, 0.27, 0.28), metallic=1.0, roughness=0.32),
    # dark cast metal: suspension, engine bits seen through the vents
    'mechanical':      dict(color=(0.05, 0.05, 0.05), metallic=1.0, roughness=0.6),
    'plate':           dict(color=(0.015, 0.016, 0.018), metallic=0.3, roughness=0.45),
    # lamps: dark housings, all of the look is emission (HDR in the game)
    'headlight_L':     dict(color=(0.02, 0.02, 0.022), metallic=0.6, roughness=0.15, emission=(0.86, 0.93, 1.0), emission_strength=6.0),
    'headlight_R':     dict(color=(0.02, 0.02, 0.022), metallic=0.6, roughness=0.15, emission=(0.86, 0.93, 1.0), emission_strength=6.0),
    'taillight':       dict(color=(0.03, 0.002, 0.002), metallic=0.0, roughness=0.2, emission=(1.0, 0.018, 0.010), emission_strength=4.0),
    'signal':          dict(color=(0.03, 0.012, 0.002), metallic=0.0, roughness=0.2, emission=(1.0, 0.35, 0.02), emission_strength=0.0),
    # reversing lamps: dark until the game lights them (white, only in reverse gear)
    'reverse':         dict(color=(0.030, 0.030, 0.032), metallic=0.0, roughness=0.2, emission=(1.0, 1.0, 1.0), emission_strength=0.0),
    # chrome-ish reflector buckets inside the lamps
    'reflector':       dict(color=(0.55, 0.56, 0.58), metallic=1.0, roughness=0.12),
    # wheels
    'rim_chrome':      dict(color=(0.62, 0.63, 0.65), metallic=1.0, roughness=0.16),   # machined / polished faces
    'rim_dark':        dict(color=(0.020, 0.020, 0.022), metallic=0.7, roughness=0.38),  # painted parts of the rim
    'caliper':         dict(color=(0.62, 0.025, 0.012), metallic=0.2, roughness=0.35),
    'disc':            dict(color=(0.16, 0.16, 0.17), metallic=1.0, roughness=0.42),
    'tyre_side':       dict(color=(0.018, 0.018, 0.019), metallic=0.0, roughness=0.72),
    'tyre_tread':      dict(color=(0.014, 0.014, 0.015), metallic=0.0, roughness=0.85),
}

_cache = {}


def _principled(mat):
    mat.use_nodes = True
    for n in mat.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            return n
    return None


def make(name):
    d = DEFS[name]
    mat = bpy.data.materials.new(name)
    p = _principled(mat)
    col = d['color']
    alpha = d.get('alpha', 1.0)
    p.inputs['Base Color'].default_value = (col[0], col[1], col[2], 1.0)
    p.inputs['Metallic'].default_value = d['metallic']
    p.inputs['Roughness'].default_value = d['roughness']
    if 'coat' in d:
        p.inputs['Coat Weight'].default_value = d['coat']
        p.inputs['Coat Roughness'].default_value = d['coat_roughness']
    if 'emission' in d:
        e = d['emission']
        p.inputs['Emission Color'].default_value = (e[0], e[1], e[2], 1.0)
        p.inputs['Emission Strength'].default_value = d['emission_strength']
    if alpha < 1.0:
        p.inputs['Alpha'].default_value = alpha
        mat.surface_render_method = 'BLENDED'   # EEVEE; exported as alphaMode BLEND
        mat.use_backface_culling = False
    else:
        mat.use_backface_culling = True
    mat.diffuse_color = (col[0], col[1], col[2], alpha)  # workbench / viewport
    return mat


def get(name):
    """The bpy material with this name (created on first use). Unknown names are an error."""
    if name not in _cache or _cache[name].name not in bpy.data.materials:
        if name not in DEFS:
            raise KeyError(f'unknown car material "{name}" (add it to lib/materials.py DEFS)')
        _cache[name] = make(name)
    return _cache[name]


def reset():
    _cache.clear()
