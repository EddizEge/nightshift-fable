# NIGHTSHIFT — test report

Date: 10–11 November 2026 (last full run: 11 November, 14:49–15:15, after the wave-4 changes and the fixes
to the test driver; the game itself is as in commit `105ed33`).
Machine: Windows 11, Ryzen 7 5700X, 64 GB, NVIDIA RTX 4060 Ti.
Browser: system Chrome, headless, driven by Playwright (`tools/shot.mjs`), WebGL2 on the real GPU through
ANGLE / Direct3D 11. Everything below was actually run; nothing was tested by hand with a keyboard on a
visible window, and no other browser or machine was tried.

## After the player car was replaced (11 November, 20:02–20:19)

The downloaded player car was replaced by the project's own model (built from code, `tools/car/`). The checks
below were run again on that state (model of 20:02: 129 824 triangles, 26 draw calls, 1.95 MB); the rest of
this report describes the run before it and still holds for everything that is not the car.

| Check | Result |
| --- | --- |
| Type check `npx tsc --noEmit -p .` | 0 errors |
| Unit tests `npx vitest run` | 5 files, 79 passed, 1 skipped (15 of them are the car's: procedural textures, mesh lattice, attitude limit, contract) |
| Production build `npm run build` | OK: `dist/` 18.9 MB, 33 files; game JS 0.60 MB |
| Game flow, production build | **46 / 46 in 3 runs in a row** (20:03–20:14), 0 page errors |
| Static hosting `node tools/static-check.mjs` | PASS: 28 files (16.5 MB), 0 not found, 0 external requests |
| Car file `node tools/car/pack.mjs` | contract OK, read-back OK |
| Not run again | soak, non-finite pixel scan, audio checks (nothing in those systems changed) |

Performance, `tools/scripts/perf.mjs`, 1920×1080, vsync off, production builds, back to back in this order:
new, old, new, old (old = worktree of `1e4e255`, the last commit with the downloaded car). The machine was in
use, so both builds are below the idle numbers further down; only the comparison counts.

| Preset | New car, fps (run 1 / 2) | Old car, fps (run 1 / 2) | GPU timer new | GPU timer old | Draw calls new / old | Triangles new / old |
| --- | --- | --- | --- | --- | --- | --- |
| LOW | 250.8 / 232.8 | 264.7 / 267.8 | 2.76 / 2.96 ms | 2.46 / 2.42 ms | 166 / 160 | 0.48 M / 0.55 M |
| MEDIUM | 143.0 / 147.2 | 150.7 / 165.7 | 6.38 / 6.16 ms | 6.05 / 5.67 ms | 399 / 386 | 1.00 M / 1.15 M |
| HIGH | 136.8 / 129.8 | 122.7 / 147.5 | 7.04 / 7.38 ms | 7.74 / 6.55 ms | 450 / 438 | 1.14 M / 1.29 M |
| ULTRA | 114.6 / 126.1 | 119.9 / 137.7 | 8.51 / 7.77 ms | 8.14 / 7.12 ms | 490 / 478 | 1.30 M / 1.45 M |

The new car is about 5 to 10 % behind in LOW, MEDIUM and ULTRA and inside the run-to-run spread in HIGH. It
costs about 0.4 ms more GPU time per frame although it has fewer triangles: it is drawn as 26 materials
instead of 21 in each pass (main, shadow, reflection: 6 to 12 more calls per frame), and its paint, carbon,
mesh and glass shaders do more per pixel (fading rain beads and fine patterns, reflection-over-tint glass).
Which of these weighs most was not separated. Every preset stays above 110 frames per second at 1080p here.

Screenshots of the first of the three runs: `screenshots/final/flow-*.jpg`; the car alone:
`screenshots/final/car-studio-*.jpg` (look-dev page) and `screenshots/final/car-game-*.jpg` (in the game).

## Sound: the pinging rain patter (11 November, 21:10–21:40)

The user heard a constant, thin, percussive, instrument-like sound that was not the rain. Every layer was
recorded separately in the game (`tools/scripts/audio-layers.mjs`) and analysed (`tools/audio/analyze.py`). The
source was the layer of drops on the car body: 95 decaying sine pings a second between 0.9 and 5.6 kHz, as loud
as the rain bed, in a loop that repeated every 5.3 s, playing in the menu and all through a run. It is now
sparse filtered-noise pats (see `docs/assets/audio.md`). The same recording before and after, menu, 7 s:

| | Before | After |
| --- | --- | --- |
| Patter layer, level (RMS) / loudest drop | −25.3 / −3.2 dBFS | −32.1 / −20.2 dBFS |
| Patter layer, drops louder than −20 dBFS | 57 a second | 0 |
| Patter layer, share of energy between 2 and 6 kHz | 51 % | 9 % |
| Patter loop: ringing of the 40 loudest drops (1 = pure tone) / length | 0.53 / 5.3 s | 0.15 / 11.7 s |
| Final output in the menu: clicks found / loudest sample | 5 a second, around 2.8 kHz / −2.3 dBFS | none / −8.2 dBFS |
| Brake pad noise: how far its 3.1 kHz tone stands out | +23 dB | +12 dB |

Pictures: `screenshots/final/audio-patter-before-after.png` (patter layer) and
`screenshots/final/audio-menu-output-before-after.png` (final output); in each, before is above after, the
spectrogram (0–12 kHz) above the waveform. Nothing else stood out in the recordings: no DC offset, no sample at
full scale in the final output, no loop seam click, nothing playing in the menu, in pause or after game over
that should be silent. Nobody listened; this is signal analysis only.

## Summary

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npx tsc --noEmit -p .` | 0 errors |
| Unit tests | `npx vitest run` | 4 files (`tests/` only), 63 passed, 1 skipped |
| Production build | `npm run build` | OK: `dist/` 19 MB, 33 files; JS split into game 0.59 MB, three.js 0.75 MB, physics 4.33 MB |
| Game flow, production build | `node tools/shot.mjs --dist --page "index.html?debug" --script tools/scripts/gameflow.mjs --timeout 300000` | **46 / 46** checks in **5 runs in a row** (14:49–15:05) and in a sixth run, 0 page errors; before that 5 in a row at 13:22–13:37 and at 14:04–14:22. See "Repeated runs" for every batch of the day, including the two runs that failed |
| Soak, 240 s, production build | `node tools/shot.mjs --dist --page "index.html?debug" --script tools/scripts/soak.mjs --secs 240 --dark 1` | twice: 1 run each, 0 crashes, 11.9 and 12.4 km at 225 s, both set pieces seen and survived, 0 odd frames of 113 and of 114, 0 page errors |
| Static hosting | `node tools/static-check.mjs` | PASS: served from `/games/nightshift/`, 28 files (17.4 MB), 0 not found, 0 external requests |
| Performance | `tools/scripts/perf.mjs`, 1920×1080, vsync off | HIGH 113 fps while the machine was in use; no regression against the previous build measured back to back, see table (measured on `105ed33`; nothing that is drawn has changed since) |
| Non-finite pixels | `tools/tmp/nanhunt.mjs` (scans the HDR scene buffer every frame through repeated crashes) | production build (`105ed33`): 0 NaN / Inf texels in 4278 frames |
| Audio self-check, audio device failure | `sandbox/audio.html?auto=1`, `tools/scripts/audio-game.mjs` | not run again (no change under `src/audio` since the last run: 17 / 17, and 10 of 10 forced AudioContext failures recovered) |

## Game flow (46 checks)

One scripted session against the production build: real key presses and clicks, state read through `window.__NS`.

- **Menu**: boots into the menu; shows NIGHTSHIFT, "Survive the Midnight", PLAY, SETTINGS, CONTROLS.
- **Start**: clicking PLAY starts a run; the HUD appears.
- **Controls**: the traffic density is set to zero and the road reset first; the check "road is empty for the
  control checks" must read 0 vehicles (the earlier "empty road" still held about 12 prefilled vehicles, and a
  blind test car could rear-end one). Then W accelerates (143 → 197 km/h), distance grows, D steers right,
  A steers left, Shift fires nitro, S brakes, Space reaches the handbrake, C switches chase ↔ hood camera,
  Esc pauses (world frozen), Esc resumes. The car is put back on its lane between the steering checks.
- **Traffic and score** (30 s of the test driver, no invulnerability): traffic present, score rises. This is
  also where the director starts its own first set piece. A crash here does not fail a check, but it is
  logged; see "The test driver" below for what it used to run into there.
- **Set pieces**: each is forced with `__NS.trigger(...)`, must start, report its climax and at least one
  explosion. The car is invulnerable for these checks only, because they test the event, not the test driver.
  Two tolerances, both written to the log when they are used: (1) the chain reaction may be called off quietly
  before its warning (no banner shown, stage not reachable); the script then asks again, up to three times;
  (2) if the test driver stands boxed in while the trigger is refused 20 times, it is put on open road 80 m
  ahead. In the last 6 runs neither was used.
- **Near miss**: staged, not left to luck: the straightest stretch ahead is looked up, one slow vehicle is
  placed 26 m ahead in the next lane and passed at one metre; the near-miss counter must rise.
- **Crash and restart**: a deliberate crash ends the run, the game-over screen shows FINAL SCORE, DISTANCE,
  TOP SPEED, NEAR MISSES, BEST and PLAY AGAIN, the best score is written to `localStorage`, PLAY AGAIN starts a
  clean run (score, distance and damage reset).
- **Quality**: LOW, MEDIUM, HIGH and ULTRA each render.

Screenshots of one of these runs: `screenshots/final/flow-*.jpg` (menu, driving, nitro, hood camera, pause,
traffic, both set pieces, crash sequence, game over, restart, the four presets). Before / after pictures of the
wave-4 visual changes: `screenshots/final/w4-*.jpg`.

### Repeated runs (production build, 11 November)

The reviewer ran the game flow four times on the previous build (`13e948e`) and got 6 failed checks in three
of the runs (set piece A without an explosion, the car standing still, set piece B never starting). That was a
real bug in the game, see "Bugs found" below. After the fix the same command was repeated in batches:

| Batch | Build | Runs | Result |
| --- | --- | --- | --- |
| 11:58–12:18 | wave-4 fixes | 6 | 6 × 46 / 46. One run asked for set piece A a second time (called off before its warning). In one run set piece B ended by its time limit with the test driver standing behind the tanker |
| 12:38–12:56 | + earlier warning | 5 | 5 × 46 / 46. In one run set piece A ended by its time limit with the test driver standing inside its own warning zone (fixed afterwards) |
| 13:00–13:16 | `105ed33` | 5 | 3 × 46 / 46, **2 runs failed**, both on the near-miss check: once the old check that waited for a near miss to happen by itself (0 in 30 s on a thin road), once the first staged version (the blind car drifted off a curve before it reached the vehicle). The check was rewritten twice during this batch. In one passing run set piece B ended by its time limit: the test driver stood between the tanker and a van that had stopped behind it |
| 13:22–13:37 | `105ed33`, final script | 5 | **5 × 46 / 46**. Set piece A ended "survived" 5 of 5, set piece B "escaped" 5 of 5 (3 of them tight), staged near miss 5 of 5, no second ask, no boxed-in recovery. In all 5 the test driver crashed in the traffic part (see "The test driver") |
| 14:04–14:22 | + test driver obeys the banner | 5 | **5 × 46 / 46**. One second ask for set piece A. The test driver crashed in the traffic part in 2 of 5; set piece B ended by its time limit twice (once with the car standing across the tunnel, nose to a wreck and tail to the wall) |
| 14:49–15:05 | + the other test-driver fixes (final) | 5 | **5 × 46 / 46**. No crash in the traffic part. The director's own set piece A, which falls into that part, paid its bonus in 4 of 5; in the fifth the driver left the open lane once the wrecks had settled and had come to a stop beside them when the 30 s were up (no crash; it drove on afterwards). Forced A "survived" 5 of 5, B "escaped" (tight) 5 of 5, no second ask, no boxed-in recovery, nobody standing at the end of a forced event |
| 15:05–15:08 | final | 1 | 46 / 46, no crash, both bonuses. This run is a repeat: the session that had started the batch was stopped from outside at 15:03, the fifth run looked dead and was started again, but the first one was still running and finished too. The two overlapped for 43 s, and the repeat overwrote the log of the first; its last line, "SUMMARY 46/46 checks passed", was read before that happened |

Both set pieces produced their climax and explosions in every one of the 32 runs in this table.

### The test driver

In 14 of the 21 runs up to 13:37 the test driver died in the 30-second traffic part, always at about
s = 1720 m and always while the director's own first chain reaction was being set up. That looked like the
event being too hard. It was not the event: the driver rear-ended a car in the lane it was crossing, at about 140 km/h. Traced and
fixed in the driver (`src/game/autopilot.ts`; the game is unchanged):

- **Crossing a lane on the way to the open one.** It stepped from lane 2 to lane 1 and half a second later
  on to lane 0, stopped braking for lane 1 at that moment (speed control looked only at its own corridor and
  at the lane it was heading for) and met the car in lane 1 half-way across. It now brakes for every lane on
  the way, does not step on before it can get right across, and does not use a lane as a stepping stone
  unless it could sit in it without an emergency stop.
- **A slower car hid what stood behind it.** The scan returned the nearest obstacle in a lane. With a car
  doing 94 km/h 105 m ahead and the drop zone of the second set piece 129 m ahead, the driver saw no reason
  to brake at 223 km/h. It now takes the obstacle that leaves the least road after braking.
- **The warning banner.** A lane inside the announced zone counted as open road until the zone was a few
  seconds away, so with a slower car in the open lane the driver pulled out into the zone. It now leaves
  such a lane at once and never prefers it to a lane outside the zone.
- **Standing across the road.** After a hit it survived (the car is invulnerable during the forced events)
  it once stood at right angles to the road, nose to a wreck and tail to the tunnel wall, and its lane logic
  got nowhere. It now shuffles round, forward and back, until it points down the road again (staged in the
  tunnel: driving on after 5.5 s).

Six new unit tests cover the first three. Result: see the last two rows of the table above and of the
soak table below.

## Soak runs (autopilot, no invulnerability)

| Run | Length | Result |
| --- | --- | --- |
| Before the last autopilot fixes, dev server (10 Nov) | 200 s | 2 runs, 1 crash (totalled after 119 s / 6.4 km), best 24 881, both set pieces occurred by themselves, 0 odd frames of 94 |
| Production build, long run (10 Nov) | 545 s | 5 runs, 4 crashes (one rear-end in the tunnel, three times into the burning tanker of the second set piece), 1 odd frame of 248 (mean brightness 6.0 on the unlit rural stretch, exactly at the detection threshold), geometries 138-148 and textures 66-71 from start to end (no growth), 0 window errors |
| Wave 3, production build (11 Nov, 06:40) | 240 s | 1 run, 0 crashes, both set pieces seen and survived, 0 odd frames of 114 |
| Wave 4, earlier builds (11 Nov, 12:56 and 13:17) | 2 × 240 s | 0 odd frames of 114 each, 0 page errors; in one of them the car stood for about 135 s at the director's own second set piece (not reproduced in three traced runs) |
| Wave 4, `105ed33` (11 Nov, 13:37) | 240 s | 2 runs, 1 crash (hit the wreck of the second set piece after 226 s / 11.9 km, score 49 323), "CHAIN REACTION SURVIVED" and "LAST-SECOND ESCAPE" bonuses, 16 near misses, 6 explosions, geometries 137-163 and textures 71 (no growth), 0 odd frames of 113, 0 window errors |
| + test driver obeys the banner (11 Nov, 14:22) | 2 × 240 s | first: 2 runs, 1 crash (the same place: the wreck of the second set piece after 220 s / 11.9 km); second: 1 run, 0 crashes; both set pieces seen and survived in each, 0 odd frames of 113 each |
| Final (11 Nov, 15:06 and 15:10) | 2 × 240 s | 1 run each, 0 crashes, 11.9 km and 12.4 km after 225 s, both set pieces seen and survived in each ("CHAIN REACTION SURVIVED", "LAST-SECOND ESCAPE"), 14 and 13 near misses, 6 explosions each, 0 odd frames of 113 and of 114, 0 window errors. The first of the two shared the GPU with the repeated game-flow run for its first two minutes |

"Odd frame" = a screenshot every 2 s whose mean brightness is below 6 or above 215 of 255 (black or blown-out
frame). Window errors and page exceptions: 0 in every run.

## Performance (production build, 1920×1080, vsync off)

| Preset | Frames per second | Frame interval avg / max | GPU timer | Frames over 20 ms | Draw calls | Triangles |
| --- | --- | --- | --- | --- | --- | --- |
| LOW | 199 | 5.0 / 316 ms | 3.5 ms | 4 of 1590 | 160 | 0.55 M |
| MEDIUM | 123 | 8.1 / 116 ms | 7.4 ms | 3 of 986 | 386 | 1.15 M |
| HIGH | 113 | 8.9 / 89 ms | 8.4 ms | 1 of 904 | 437 | 1.29 M |
| ULTRA | 103 | 9.7 / 20 ms | 9.5 ms | 0 of 828 | 477 | 1.46 M |

8 s per preset, autopilot in city traffic. **These numbers were taken while the machine was in use** (other
applications held 26–33 % of the GPU); on the idle machine the previous build measured LOW 377, MEDIUM 226,
HIGH 211, ULTRA 180. To rule out a regression the previous build (`13e948e`) was built into a temporary
folder and both were measured back to back under the same load: previous 193 / 125 / 109 / 96 fps, current
197 / 121 / 112 / 102 fps. Draw calls and triangles are unchanged. The target of 1080p at 60 frames per second
is met on this GPU with a wide margin. The single long frames are the first frames after a preset switch.
The unlit rural stretch now draws 151–189 thousand background triangles (was 227–240 thousand).

## Bugs found by these tests and fixed

Wave 4 (11 November):

- **A traffic vehicle that ran into a wreck was handed to the crash world with its world position as its
  velocity** (two functions shared one scratch vector): 2000–5400 m/s, cut to 250 m/s by the limiter, so the
  wreck flew about a kilometre down the road and was removed. In set piece A this happened to the tanker
  whenever it touched the jack-knifing truck early: the event ended without an explosion. In normal play every
  AI car that hit a wreck vanished the same way. Fixed; the crash world now also refuses any hand-over above
  110 m/s and never lets the solver speed a body up beyond what an impulse or a blast gave it.
- The "CHAIN REACTION SURVIVED" line next to an event without explosions was the bonus of an earlier event in
  the same session (the list in the log is cumulative), not a wrong bonus.
- A forced event could start for a player who had just crashed, and the restart key was swallowed during the
  first 350 ms of the game-over screen: the test then stood on the game-over screen and the next event never
  started. `trigger()` now refuses while no event can run.
- With wrecks staying where they crash a pile-up could close the whole carriageway. The director now keeps
  one outer lane open past every pile of wrecks: whatever reaches into it is pushed out, and a wreck lying
  across the road is swung out like a gate by the end that is in the lane.
- AI traffic "crashed" into the tanker of set piece B while it was still six metres up in the air.
- Set piece B, when forced far from an overpass, dropped the tanker long before the player arrived; a forced
  start now needs an overpass at a sensible distance and the drop follows the arrival time of the player.
- Set piece A: the stage is fixed when the event starts and the convoy paces itself to meet the player there;
  the whole reachable stretch is checked for tunnels and overpasses, and an event that cannot be staged is
  called off before anything is shown. The warning comes about a second earlier.
- The test driver: reads wrecks by their real outline in road space (a tanker lying across three lanes was
  one point before), follows the warning zone of both set pieces only while it is in force, and backs out
  until it has room to swing into the open lane. Four more faults of the driver itself, see "The test driver".
- Impact smoke was a near-black ball over the car on unlit road; it is grey-brown dust and steam now and
  takes sky light. The first frame of a detonation is a shaped core with rays instead of a flat white frame.
  Fires follow the drawn pose of a wreck in slow motion. Burnt vehicles are ash, rust and bare steel with a
  cooling glow instead of black silhouettes. The rural verge no longer looks like snow.

Earlier:

- Distance points were rounded per physics step, so driving below about 150 km/h scored nothing.
- Leaning on a wreck at a standstill added damage four times a second until the car was "totalled".
- A vehicle handed to the physics world while overlapping another one could be launched at 360 km/h
  (seen with the tanker in the chain reaction); wreck bodies now have a speed limiter.
- A rounding error in the road shader stippled every street-lamp highlight on the wet road.
- Dynamic resolution dropped to its floor during the first seconds of a run and never came back.
- Event B: the tanker landed across all lanes; the overpass railing did not break.
- Black rectangles flashing over the picture (seen in the crash camera, once in a long drive): the headlight
  pool term of the road shader evaluated 0 × exp(+large) = NaN for road far behind a lamp, and the bloom mip
  chain spread that single texel into a screen-sized block. Fixed at the source; the scene copy now also
  replaces any non-finite texel, and every `pow(x, 2.0)` with a possibly negative base was rewritten.
- Wrecked traffic vehicles floated above the road by half their height (missing ground offset).
- In the 0.2× slow-motion crash shot wrecks moved in 12 Hz steps; poses are now interpolated between physics steps.
- The chain reaction kept references to pooled vehicles after they had been recycled (a random car could be
  wrecked or launched), and its stage could drift into a tunnel or under an overpass.
- Pressing R during the crash sequence discarded the run without storing the best score.
- A collision between two AI vehicles next to the player reset the combo of the player.
- With storage blocked every run was announced as a new best.
- The automatic quality step-down counted overload about 2.4 times too fast, also in menus.
- Sound buffers were rendered on the main thread and froze the first seconds of play; they are rendered in a worker now.
- An AudioContext failure (device change, renderer error) is caught and the audio graph is rebuilt.

## Notes and limits

- **Jams**: AI traffic that has stopped behind a pile-up does not back out or change lanes. A car that stops
  inside such a jam can be boxed in; the test driver stood that way until the time limit of the event in
  2 of the 21 runs up to 13:37. It did not happen in the 11 runs after the test-driver fixes, which is not
  proof that it cannot.
- The test driver survived every one of the last 6 game-flow runs and both last soak runs. That is 8 samples
  of 3 to 4 minutes, not a guarantee; before the fixes it crashed every one to two minutes.
- **Audio self-check**: the "engine pitch tracks rpm" check failed because the output device now runs at
  96 kHz (the fixed analysis window was too coarse for the 60 Hz idle) — a measurement bug, fixed without
  lowering the threshold. The rain bus reading silence once was the main-thread stall, a product bug, fixed.
- The tab crash seen once by the reviewer (AudioContext error, then "Target crashed") was not reproduced; the
  game now survives forced context failures, but a crash of the audio renderer of the browser itself cannot be tested.
- The unlit rural stretch: mean frame brightness about 27 / 255, city about 51.
- Under street lamps the wet road around a detonation still goes cream-white for a frame or two; on LOW the
  hard round glow seen earlier is gone (filmed again, `screenshots/w4low-city-sheet.png`, not in git).
- Not tested: Firefox, Safari, mobile, gamepads, integrated GPUs, displays other than 1600×900 and 1920×1080,
  very long sessions (longest single run about 4 minutes / 13 km).
- Sound was verified by signal analysis only; nobody listened to it.
