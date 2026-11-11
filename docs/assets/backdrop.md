# Backdrop assets (agent: backdrop)

No third-party files are added by the backdrop module.

| What | Source | Licence |
| --- | --- | --- |
| Facade windows, shopfronts, crown / corner light strips | procedural GLSL (src/world/backdrop/facade.ts) | project code |
| Illuminated sign words (HOTEL, PARKING, 24H, ...) | rendered at runtime into a canvas atlas with the browser's generic sans-serif font (src/world/backdrop/signs.ts); generic words only, no brands, no font file shipped | project code |
| Billboard artwork | procedural abstract shapes (city.ts boardMaterial) | project code |
| Parked cars, grass tufts, lattice legs, frontage roads | procedural geometry (roadside.ts, terrain.ts) | project code |
| Textures used | the shared project textures already listed in docs/assets/textures.md (concrete_panel_*, metal_galv_albedo, asphalt2_normal, noise_fbm_512, metal_corrugated_normal) | see textures.md |
