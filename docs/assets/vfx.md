# VFX assets (agent "vfx")

No third-party assets. Every effect in `src/vfx/**` (explosions, fireballs, flame tongues, smoke,
sparks, embers, debris, scorch decals, ground light pools, nitro afterburner, heat haze /
shockwave distortion) is procedural: GLSL shading on instanced quads / meshes.

The only texture used is the shared project noise `public/assets/textures/noise_rgba.png`
(generated in-project; see `docs/assets/textures.md`), loaded through `assetUrl()`.
