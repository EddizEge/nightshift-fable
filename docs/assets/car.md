# Player car

**Licence: project-owned.** The player's car is our own work, modelled entirely from code by a Python script in
headless Blender 4.3. No downloaded model, no part library, no textures, no logos, trademarks or brand names: the
script reads nothing but its own modules, and the packing step refuses a file with a texture or a brand name in it.

## How it is built
1. `tools/car/build_car.py` (Blender, command line) builds the car from the modules in `tools/car/lib/`:
   - `spec.py`: the numbers every module agrees on (wheelbase, track, wheel radius, body envelope, cabin, part names),
   - `body.py` (skin, tail panel, wheel houses, floor), `interior.py` (cabin), `wheels.py`, `details.py` (mirrors),
     `bay.py` (engine bay and engine), `lamps.py` (headlamp optics): the geometry, built in this order,
   - `materials.py`: the material names and their base PBR values (`DEFS`),
   - `util.py` (mesh helpers, export), `render.py` (preview renders, not used by the game).

   It writes `tools/car/out/player_car.raw.glb` (uncompressed glTF, already in the game's car space) and
   `tools/car/out/player_car.meta.json` (measurements). `tools/car/out/` is not in git: it is reproducible.
2. `tools/car/pack.mjs` (Node, glTF-Transform) checks the contract below and exits with code 1 if anything is
   wrong, writes the measurements into the file, deduplicates, prunes, compresses with meshopt (quantised positions,
   normals and colours; UVs stay float because they are in metres) and writes `public/assets/models/player_car.glb`.
   It prints triangles per part and per material, the draw calls after the runtime merge and the file size.
3. `src/vehicle/playerCarVisual.ts` loads it, merges everything into one skinned mesh per material (the parts are
   bones) and builds every material and texture itself.

## Rebuild
```
"C:/Program Files/Blender Foundation/Blender 4.3/blender.exe" --background --factory-startup --python tools/car/build_car.py
node tools/car/pack.mjs                 # tools/car/out/player_car.raw.glb + .meta.json -> public/assets/models/player_car.glb
node tools/car/pack.mjs --check         # validate and report only, write nothing
```
Options: `build_car.py -- --render <dir> --views front34,rear34,side` renders previews (see the script header);
`pack.mjs --raw <glb> --meta <json> --out <glb>` packs another file (e.g. a test build) without touching the game's.
Run Blender at Idle priority when the machine is in use.

To review: `sandbox/car.html?view=front34|rear34|side|top|wheel|interior|low|tail|chase|bonnet&paint=graphite|carmine|pearl|midnight`
with `brake=1`, `reverse=1`, `lights=0`, `steer=0.4`, `spin=1`, `damage=0.8`, `wet=0..1`, `orbit=1`, `q=low`, and
`model=<url>` to load another packed file, e.g. `model=/tools/tmp/car/test.glb`.

## The contract (what the game relies on)
**Space.** Metres, Y up, the car faces −Z, origin = centre of the wheelbase on the ground (tyres touch y = 0).
Left is −X.

**Nodes.** One root `PlayerCar` in the scene. Under it, one node each named
`Body`, `MirrorL`, `MirrorR`, `Steering`, `Wheel_FL_Spin`, `Wheel_FR_Spin`, `Wheel_RL_Spin`, `Wheel_RR_Spin`,
`Wheel_FL_Caliper`, `Wheel_FR_Caliper`, `Wheel_RL_Caliper`, `Wheel_RR_Caliper`. Every other object is a child
(at any depth) of one of these parts and moves with it; the runtime finds a mesh's part by walking up its
ancestors. A mesh outside every part is an error. `*_Spin` holds what turns with the wheel (tyre, rim, disc), centred
on the hub; `*_Caliper` stays still at the hub (inside the wheel radius).

**Materials, by name** (`tools/car/lib/materials.py` `DEFS`; the runtime builds one material per name and only takes
colour / metalness / roughness / emission factors from the file):

| name | runtime material |
| --- | --- |
| `paint_main`, `paint_accent` | clearcoated metallic paint; colour from the paint preset, procedural flake, rain beads on the clearcoat |
| `carbon` | clearcoated carbon fibre: procedural 2/2 twill (albedo + normal, 2.5 mm tows, 1 cm period), rain beads on the clearcoat |
| `trim`, `grille` | matt black plastic / nearly black matt lining (ducts, wheel houses) |
| `grille_mesh` | metal mesh behind the openings (tail panel, nose intakes, slots of the engine cover): procedural hexagons, 11 mm cells, 1.9 mm wire; fades to an even dark satin when the cells get small on screen |
| `glass`, `lens` | tinted window glass / nearly clear lamp covers; drawn after the opaque car with "reflection over tint" blending (the reflection is added at full strength, alpha only darkens what is behind): glass opacity 0.58 rising to 0.92 at grazing angles, lens 0.1 |
| `mirror`, `reflector` | mirror glass / bright metal lamp buckets |
| `interior`, `interior_accent`, `dashboard` | cabin; the dashboard glows |
| `hardware`, `mechanical`, `plate` | satin metal, dark cast metal, plain plate (no text) |
| `headlight_L`, `headlight_R`, `taillight`, `signal`, `reverse` | lamps: emissive, driven by `setLights`, brake and damage flicker; L and R headlights are separate so one can fail; the tail bar stays red in every gear, `reverse` (two lenses in the tail panel) is dark and turns white only in reverse gear |
| `rim_chrome`, `rim_dark`, `caliper`, `disc`, `tyre_side`, `tyre_tread` | wheels; the caliper colour follows the paint preset (`rim_dark` is also the satin black of the tail blades and cam covers; the tyre grooves use `trim`) |

**Vertex data.** `POSITION`, `NORMAL` and triangles on every primitive. `TEXCOORD_0` is a box projection in metres
(1 UV unit = 1 m): the procedural maps are tiled per metre (a primitive without UVs is box-projected at load time).
`COLOR_0` is optional baked ambient occlusion as a grey vertex colour (1 = open, 0 = occluded, linear); it is used
only when every primitive of a material has it, and then darkens that material's base colour. Tangents, further UV
or colour sets and skin attributes are dropped by the packer. **No textures, no images.**

**Measurements.** `player_car.meta.json` (written by `build_car.py`), copied by the packer into the scene extras
and the `PlayerCar` node extras under the key `nightshift` (the runtime reads `scene.userData.nightshift`):
`wheels` (key, hub, front), `wheelRadius`, `dims` (`length`, `width`, `height`, `wheelBase`, `trackFront`, `trackRear`,
`wheelRadius`, `frontAxle`, `rearAxle`, …), `steering` (`pivot`, `axis` towards the driver), `anchors` (`headlightL/R`,
`taillightL/R`, `exhaustL/R`, `hoodCam`), `parts` (`MirrorL/R` pivots, where a knocked-off mirror collapses to),
`triangles`, plus `packedBy`.

**What `pack.mjs` checks** (each failure is reported, nothing is written): the root and every part present once and
not empty; every mesh inside a part; every material name known (a Blender `.001` duplicate is named as such); triangle
lists with normals; no textures, skins or animations; no brand name in any node, mesh, material or scene name; the
measurements complete and consistent (hubs on the left / right / front / rear, hub height = wheel radius, track, axles
and wheelbase agree with the hubs); each `*_Spin` centred on its hub with the measured radius; calipers inside the
wheel; the steering pivot on the steering wheel and the mirror pivots on the mirrors; anchors on the right side.
After writing, it reads the file back and checks that parts, materials, UVs, vertex colours and triangles survived.

## At run time
- One `SkinnedMesh` per material, vertices rigidly bound to the bone of their part (body, two mirrors, steering
  wheel, four wheel spins, four calipers): one draw call per material whatever the parts do.
- Procedural textures, tiled in metres: rain beads (512 px tile = 0.17 m), paint flake (256 px tile = 0.04 m),
  carbon twill (one 4 × 4 tow period = 0.01 m), hexagon mesh (11 mm cells). Pure functions, unit-tested in
  `tests/playerCar.test.ts` (deterministic, seamless, weave period, mesh lattice).
- Fine detail fades with its size on screen: rain beads are at full strength up to 3 texels per pixel and gone at 8
  (the clearcoat roughens a little as they go), weave and mesh fade to their averages. Beads drop to 0.22 while the
  camera sits over the car (bonnet camera) and are off at the low quality preset.
- Damage darkens and roughens paint and carbon, knocks the mirrors off and makes the right headlight flicker, then
  the left one fail. From damage 0.8 the car burns to char: paint and carbon nearly black and matt, calipers and
  bright metal dulled, glass dark and smoked, cabin dark.
- The drawn body never drops more than 3.5 cm over any wheel (`limitAttitude`): heave, pitch and roll are scaled
  together, so an arch cannot sink into a tyre. The physics is not touched.
- The headlight beam starts inside the nose (`dims.frontOverhang`), so it never lights the car's own bonnet. The
  bonnet camera (`HOOD_EYE` in `src/vehicle/cameraRig.ts`: 0.62 m ahead of the `hoodCam` anchor, 0.13 m above it,
  pitched up 0.05 rad) shows the bonnet in the bottom quarter of the frame; the bonnet hides the bright foot of the
  headlight cone just ahead of the bumper.

## How the body is modelled (`tools/car/lib/body.py`)
- The skin is one Catmull-Clark surface. Its control cage is generated from design tables: a lid (seven lines
  along the car per half, keyed at 13 stations: bonnet, windscreen, roof, side glass, engine cover, deck) and a
  wall that hangs from the lid's edge and wraps around the car (front fascia, body side, rear fascia). Around each
  wheel the wall's columns fan out from the arch. The right half is generated and mirrored.
- Every cage face has a zone (paint, gloss black, glass, lamp cover, carbon, underside) and a panel name. Intakes,
  the tail panel and the bonnet outlets are cage faces turned into recesses before subdividing (a support ring keeps
  the surface around an opening where it was). After subdividing (level 2), every edge between two panels becomes a
  5.6 mm wide, 6 mm deep groove: the shut lines. The slats of the engine cover and of the bonnet outlets are cut
  after subdividing.
- Shape: the tail leans forward under the lip (the lamp bar is the rearmost face), the lower edge of the bumper is
  40 cm above the road and the skin runs forward from there as the roof of the diffuser tunnel, with six strakes
  hanging from it. Behind the rear wheels the body is cut away, so the tyres show from behind. The door is
  scalloped under a character line that rises from the front wheel to the engine intake. The nose stands on a
  splitter blade.
- Tail panel: a recessed mesh panel under the lamp bar with two oval pipes in one satin housing in the middle and a
  satin blade to each side that carries the reversing lamp.
- Lamps: the lamp cover is part of the skin; behind it sits a recessed bucket. `lamps.py` fills the headlamp: two
  daytime-light blades along the brow, three round projector units stepped in depth, amber indicator slats. The
  tail lamp is a full-width glowing bar with amber ends.
- Wheel houses face the wheel and are kept under the skin by ray casting (the bonnet is lower than the front arch);
  the rear ones stop where the cut-away begins.
- `bay.py`: a lining inside the rear body, a closed engine bay behind the bulkhead and a V engine (block, cam
  covers, plenum with runners, headers, gearbox, braces), seen through the rear glass and the rear quarter windows.
- `wheels.py`: tyre with grooves, shoulder blocks, a rim-protector rib and abstract raised dashes on the sidewall
  (no words); concave rim with ten tapered split spokes, slotted disc, caliper. `interior.py`: cabin.
  `details.py`: door mirrors on a cast arm, fitted to the door surface. All follow the same rule: code only.

## Numbers (build of 11.11.2026)
| part | triangles |
| --- | --- |
| Body (skin 35 512; lamps, lining, wheel houses, floor, tail panel parts, strakes, intake blades 5 058; headlamp optics 3 016; engine bay 4 760; cabin 9 198) | 57 544 |
| Steering wheel | 1 784 |
| Mirrors (2) | 4 656 |
| Wheels: tyre, rim, disc (4) | 60 032 |
| Calipers (4) | 5 808 |
| **Total** | **129 824** |

26 draw calls after the runtime merge (the previous, downloaded model: 197 961 triangles, 21 draw calls).
`public/assets/models/player_car.glb`: 1.95 MB (the previous model with its textures: 2.87 MB).
Length 4.59 m, width 2.09 m (2.18 m over the mirrors), height 1.19 m, wheelbase 2.80 m, track 1.74 / 1.76 m,
tyre radius 0.38 m.
