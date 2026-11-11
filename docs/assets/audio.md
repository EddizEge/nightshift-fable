# Audio — asset & design notes

**Third-party assets: none.** Every sound in NIGHTSHIFT is synthesised at runtime from code in
`src/audio/` (seeded, deterministic). No samples, no downloads, zero licence risk; `public/assets/audio/`
is intentionally empty and nothing is fetched at runtime.

## Modules
| File | Role |
|---|---|
| `src/audio/index.ts` | `createAudio(): IAudio`, mixer graph, per-frame mapping of `AudioFrame`, positional one-shots, ducking, states, visibility |
| `src/audio/engine.worklet.js` | AudioWorklet V8 synthesiser (plain JS, imported `?raw` → Blob URL: no path/base or transpile issues in dev or static builds) |
| `src/audio/engine.ts` | Worklet wrapper: param ramps, shift cut + blip, afterfire pops, oscillator fallback if AudioWorklet is missing |
| `src/audio/loops.ts` | Seamless loop beds: rain shower, body patter, wet tyre spray, skid, scrape, white/brown noise |
| `src/audio/sfxWorld.ts`, `sfxUi.ts` | Procedural one-shot recipes (modal metal/glass, explosions, thunder, UI tones…) |
| `src/audio/bank.ts` | Renders variants, DC-blocks/fades, normalises to the per-sound peak table; bus / polyphony / ducking table |
| `src/audio/impulse.ts` | Generated tunnel impulse response (RT60 ≈ 2.2 s, flutter echoes, frequency-dependent decay) |
| `src/audio/dsp.ts` | Offline DSP toolkit (biquads, noise colours, resonators, Freeverb, loops) |

## Mix
Buses engine / road / ambience / sfx / ui → 22 Hz high-pass → glue compressor (-16 dB, 2.5:1) →
limiter (-4 dB, 20:1) → 4× oversampled soft clipper (ceiling ≈ -0.2 dBFS). UI bypasses the pause duck.
Tunnel: engine+road+sfx send into the convolver; rain gain → 0 and low-passed. Explosions / heavy crashes
duck ambience + road. Slow motion lowers engine pitch (0.35 + 0.65·timeScale) and world one-shot rate.

## Rain on the car (the patter loop)
Drops on the body are short bursts of filtered noise: dull pats on panels (320–1300 Hz), lighter ticks on glass
(1.4–3 kHz), now and then a soft roof thud; about 20 a second, most of them faint, coming in waves; the loudest
is held at 4 × the loop's RMS; the loop is 11.7 s long and starts at a random point. It plays about 6 dB under
the shower (`PATTER_GAIN` 0.12 against 0.36).
The first version rang every drop as a decaying sine between 0.9 and 5.6 kHz, 95 times a second, as loud as
the shower, in a 5.3 s loop: heard as a thin tuned percussion instrument that never stopped (reported by the
user on 11 Nov). Do not bring pitched drops back. `tests/audioLoops.test.ts` guards this (no ringing, limited
peaks, long loop, seamless).
The brake pad noise is two band-passes at 3150 Hz with Q 14 (`BRAKE_Q`): with Q 35 it was a 60 Hz wide whistle.

## Integration notes
- `nitroStart` / `nitroEnd` are NOT auto-triggered from `nitroActive` (the game calls `play()`); the
  sustained jet layer and engine boost follow `nitroActive`.
- The scrape one-shot and the `AudioFrame.scrape` loop are independent.
- `thunder` routes through the ambience bus (muffled/silenced in tunnels like the rain).

## Verification
Layer by layer in the real game: `node tools/shot.mjs --page "index.html?debug" --script tools/scripts/audio-layers.mjs
--timeout 400000 --out-dir tools/tmp/audio/run1` records the final output, the five buses and every continuous
layer (rain shower, patter, spray, rumble, wind, skid, brake, scrape, nitro) as WAV files through a scripted
session (menu, driving, nitro, coasting, braking, standing, pause, traffic, crash, game over).
`python tools/audio/analyze.py <folder> [--png]` prints level per part, peak, DC, narrow tones, clicks and loop
repetition per layer; `--compare <other folder> --layer <name>` puts two recordings side by side.

`node tools/shot.mjs --page "sandbox/audio.html?auto=1" --out screenshots/audio.png --label audio --wait "window.__done === true" --timeout 120000`
and the static-build variant `node tools/audio/prod-check.mjs` (builds only the sandbox with base './').
