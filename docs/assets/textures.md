# Texture set (public/assets/textures)

Rebuild: `node tools/textures/build.mjs` (downloads CC0 sources into `assets-src/textures/src/`, grades with sharp, writes WebP, contact sheet `screenshots/textures-contact.png`, report `assets-src/textures/build-report.json`). All maps: OpenGL normals (+Y up, sources are NormalGL / nor_gl), power-of-two, resampled with wrap padding so tiling stays seamless. Albedo is sRGB; normal/rough are linear data. Total 9.4 MB.

| Output | Source asset | Author | Licence | Source res | Tile (m) | Notes |
|---|---|---|---|---|---|---|
| asphalt_{albedo,normal,rough}.webp 2048² | ambientCG Asphalt015, https://ambientcg.com/a/Asphalt015 | ambientCG (Lennart Demes) | CC0 1.0 | 2K | 4 | Graded to neutral dark grey, mean luma 68/255, desaturated 0.6 |
| asphalt2_*.webp 1024² | ambientCG Asphalt031, https://ambientcg.com/a/Asphalt031 | ambientCG | CC0 1.0 | 2K | 4 | Coarser/patchier, luma 76; shoulders |
| concrete_*.webp 1024² | ambientCG Concrete024, https://ambientcg.com/a/Concrete024 | ambientCG | CC0 1.0 | 2K | 2 | Smooth cast concrete, luma 150 |
| concrete_panel_*.webp 1024² | Poly Haven `concrete`, https://polyhaven.com/a/concrete | Poly Haven contributors | CC0 1.0 | 2K | 4 | Board-formed joints run along V; luma 120 |
| metal_galv_*.webp 512² | ambientCG Metal011, https://ambientcg.com/a/Metal011 | ambientCG | CC0 1.0 | 1K | 1 | Albedo = metal F0, use metalness 1; brushing along U |
| metal_corrugated_*.webp 1024² | Poly Haven `corrugated_iron_03`, https://polyhaven.com/a/corrugated_iron_03 | Poly Haven contributors | CC0 1.0 | 2K | 2 | Painted steel, metalness ~0; ribs along V |
| night_sky_1k.hdr | Poly Haven HDRI `kloppenheim_04`, https://polyhaven.com/a/kloppenheim_04 | Greg Zaal | CC0 1.0 | 1K | - | Dark overcast night, fallback IBL only (RGBE, 1.6 MB) |
| grunge_mask.webp 1024² | procedural (tools/textures/noise.mjs) | - | project | - | 8 | Stains, leaks, speckle; tiles |
| noise_rgba.png 256² | procedural | - | project | - | - | R low fbm, G high fbm, B 1-Worley, A blue-ish white noise; periodic |
| noise_fbm_512.png 512² | procedural | - | project | - | - | Tiling fbm for clouds |

Changes to sources: colour grade (grey balance, desaturation, luma target), roughness remap, resize with wrap padding, normal renormalisation, WebP encode. No logos or trademarks.
