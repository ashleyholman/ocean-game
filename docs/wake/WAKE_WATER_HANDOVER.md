# Wake and water effects — handover log

Round-by-round record for the wake/water project. `docs/wake/WAKE_WATER_DESIGN.md` is
the authority on architecture and invariants; `docs/wake/WAKE_WATER_PROJECT_PLAN.md` on
sequence and gates. Newest round last.

Project-wide invariant: this entire project is presentation-only and one-way.
It may change rendered water, foam, normals and spray, but it must not change
authoritative wave evaluation, buoyancy, vessel dynamics or canonical state.

WK0–WK2 are implemented. The strengthened WK1 and incremental WK2 GPU brackets
both pass on the merged desktop code. On 2026-08-07 Ash directed the combined
wake on by default behind the existing Debug Tools master checkbox. Later the
same day Ash rejected the WK1/WK2 look under sail; the **WK-R recovery round**
diagnosed a trail-destroying carrier defect, fixed it, recalibrated the
deposits, added registration/structure and pulled the wave pattern forward
from WK4. Ash's reference-state A/B of WK-R subsumes the WK1/WK2 visual
checkpoints.

**WK-R5** (final section) answered Ash's feedback on the merged WK-R build: a
0.9-texel lookup jitter was a noise-gradient domain warp and the single cause
of the blotching, the pixel buzz and the detached bow patches; a 0.375 m hull
level replaced the grid the warp had been hiding; the wave pattern was rebuilt
on real Kelvin geometry after two plane waves proved unable to compress or
fan; and the bow deposits and collar smear were re-derived. Ash's standing
constraint from that round — **the wake stays one-way, no vertex displacement,
nothing written back to the physics surface** — scopes everything after it.

---

## WK0 — Instrumentation and baseline · implemented 2026-08-06

**Status: implementation and exact-commit GPU baseline complete. 48 test files
/ 671 tests pass, production build clean, live Ocean Lab smoke test clean.**

### What exists now

| Thing | Where |
|---|---|
| Allocation-free contact condensation | `src/vessel/WakeSources.ts` |
| Deterministic contact evidence builder | `src/vessel/schooner/WakeSourcesEvidence.ts` |
| Committed contact/source baseline | `evidence/ship-wake/contact-baseline.json` |
| Regeneration + validation | `npm run ship:wake` (`tools/export-ship-wake.mjs`) |
| Contract + short-run determinism tests | `tests/wake-sources.test.ts` |
| Production-frame source refresh | `src/main.ts`, immediately after vessel physics |
| Default-off master switch + live source readout | Ocean Lab, `src/debug/OceanLab.ts` |

### The source contract

`WakeSources` binds once to `BuoyantBody.contacts` and `overtopEvents`, then
rewrites one stable output graph after each completed physics frame. Repeated
`update()` calls allocate nothing. It exposes:

- the aft-most complete port-to-starboard waterline cut in the stern third;
- every active bow-region waterline point in a fixed 78-entry capacity buffer,
  with an explicit live count;
- wet-station count, active-waterline count, and wet-contact mean/peak normal
  entry speed for bow, midships and stern;
- the body's active overtop event list by reference.

The adapter applies no policy, owns no history and writes nowhere. It does not
read the master switch: instrumentation remains live while effects are off, so
the panel can diagnose the inputs to a disabled or broken effect. The switch
is deliberately born before its first renderer consumer; it defaults off and
cannot change a pixel in WK0.

### Evidence method and headline values

The exporter freshly solves the S3 captive polar at a 90-degree starboard-tack
reach for each reference wind, rather than interpolating a stale table. It uses
full sail for glassy/moderate and working sail for Southern rough:

| Sea | Speed | Leeway | Balance rudder |
|---|---:|---:|---:|
| `GLASSY_LONG_SWELL` | 0.977539 m/s | 1.015625° | 0.273438° |
| `CURRENT_MODERATE` | 3.592773 m/s | 1.015625° | 0.273438° |
| `SOUTHERN_OCEAN_ROUGH` | 5.293945 m/s | 2.578125° | 3.007813° |

Four seeded cases run: those three plus `CURRENT_MODERATE` at exact zero
speed. Each warms for 30 seconds, measures for 60 seconds, advances physics at
240 Hz, and reads completed frames at 60 Hz. The record contains waterline
activation/deactivation rates, wet-contact entry-speed histograms and
quantiles, overtop counts, and a compact 1 Hz source-envelope series.

Bow-region entry-speed p95:

| Case | p95 normal entry speed |
|---|---:|
| moderate, anchor | 0.675 m/s |
| glassy polar reach | 0.051 m/s |
| moderate polar reach | 0.911 m/s |
| Southern polar reach | 2.040 m/s |

The exporter was run twice from scratch. Both files had SHA-256
`3a5abe5c878271ac8aac0edfca3509bd1ca0dea3cc01894702b33b9a22548064`.

### Findings surfaced by WK0

#### WK0-F1 — entry speed is not a wake command

At anchor in `CURRENT_MODERATE`, wave orbital motion alone gives the bow a
0.675 m/s p95 and 1.595 m/s maximum normal entry speed. This is correct contact
kinematics and exactly why the later policy must combine it with speed through
water. A spray or foam emitter keyed only to `normalEntrySpeedMps` would fire at
anchor. WK1's exact-zero speed gate and WK3's event threshold must remain
separate facts.

#### WK0-F2 — reference runs did not overtop

All four 60-second cases recorded zero overtop events, including Southern rough
at 5.29 m/s. Do not retune the detector in this project: it is physics-owned.
WK3 cannot calibrate schooner `OvertopSpray.strength()` from these four runs
alone; it will need a longer/severe or heading-targeted deterministic sizing
case, recorded as an intentional evidence extension rather than a silent
change to this baseline.

#### WK0-F3 — the stern source breathes with the resolved waterline

The selected stern segment is consistently station 0, but its measured width
ranges from roughly 0.14 m to 3.07 m across the reference series. That is the
real section/water-plane intersection, not noise to replace with design beam.
WK1 should let policy radius/strength keep injection legible when the cut
narrows, without inventing a second hull width.

#### WK0-F4 — FoamField has no B channel yet

The design draft says the foam target is RGBA and B is free. Shipping
`FoamField` explicitly allocates `THREE.RGFormat`, its diagnostic readback has
stride two, and memory accounting assumes two channels. WK1 therefore includes
an intentional render-target migration (format, decay/advect writes, readback,
diagnostics, blend verification, and memory accounting), not merely writing a
third component. This does not affect WK0.

### Pixel identity

WK0 changes no shader, render target, material, scene object, camera, light,
foam option or draw call. Its production-frame addition only copies already
published contact numbers into a CPU object graph. The master switch has no
renderer consumer. Production output is therefore pixel-identical by
construction, the design's explicitly self-certifiable visual gate.

### Performance baseline — deliberately pending

Ash will provide a window when the GPU is uncontended. Only then:

1. follow the repository's documented GPU-enabled headless Chrome process;
2. use paired/interleaved blocks, not a single timing leg or the in-app pane;
3. capture the WK0 pre-effects result without changing the implementation;
4. commit the result under `evidence/ship-wake/` and extend the evidence
   allowlist for that exact file.

No placeholder timing file exists and no performance number is claimed.

### Verification record

- Before edits: `npm test` — 47 files / 663 tests green.
- After fast-forwarding the concurrently landed cinematic-camera work:
  `npm test` — 48 files / 671 tests green.
- `npm run build` — typecheck and production bundle clean (existing chunk-size
  and mixed static/dynamic import warnings only).
- `npm run ship:wake` twice — byte-identical output and validation clean.
- In-app browser smoke test at the local dev build: Ocean Lab opened with live
  source values, master initially off, toggled on and back off, no console
  errors. This was functional UI validation, not a performance run.

---

## WK1 — The trail · implemented 2026-08-07

**Status: implementation complete on `codex/wake-water-wk1`; 49 test files /
681 tests pass in the full suite, production build clean, live Ocean Lab smoke
test clean. The implementation is on `master`; acceptance remains open until
Ash accepts the reference-state look and a real steering maneuver, and until a
longer paired run resolves the ≤0.6 ms performance gate.**

The work started from local `master` at `6559b81`; the exact untouched WK0
performance baseline was measured at `80a1c2f` in a separate worktree. The wake
master remains **off by default**.

### What exists now

| Thing | Where |
|---|---|
| Presentation-only speed/sea/wind policy | `src/scene/wakePolicy.ts` |
| RGBA foam history; B = hull turbulence | `src/scene/FoamField.ts` |
| Stern-segment R/G/B injection and exact B decay | `src/scene/FoamField.ts`, `src/main.ts` |
| Fine-detail smoothing, pale haze and ambient-break suppression | `src/scene/Ocean.ts` |
| Master plus four independent A/B controls and live policy readout | `src/debug/OceanLab.ts` |
| Deterministic three-sea/two-camera component sheet harness | `src/debug/wakeContactSheet.ts` |
| Expanded deterministic policy/injection record | `src/vessel/schooner/WakeSourcesEvidence.ts`, `evidence/ship-wake/contact-baseline.json` |
| Policy, sign, decay, channel/blend and shader-contract tests | `tests/wake-trail.test.ts` |

### The one-way architecture

WK1 reads the completed `WakeSources` stern cut and actual speed through water,
then resolves one stable policy object. `main.ts` passes a stable stern source
into `FoamField` and stable appearance gains into `Ocean`. There is no reverse
path: no force, wave, buoyancy, vessel-dynamics or canonical-world value is
written by the wake. The diagnostic leeway/tow hooks are captive evidence
controls only; free production sailing is unchanged.

`FoamField` now intentionally allocates RGBA half-float ping-pong targets. R
and G retain the shipping active/residual arithmetic; B is hull turbulence.
The same injection pass paints the resolved port-to-starboard stern segment,
with a texel-footprint guard so the moving source does not step across a
coarse level. Advection and decay carry all three physical channels and write
opaque alpha. Injection writes zero alpha with explicit additive blend
factors. Reset warm-up expressly excludes hull injection, so reset cannot
invent a stern spot or pre-existing trail.

The desktop field therefore grows from about 0.625 MiB to 1.25 MiB. This is the
intended cost of the third physical channel plus RGBA render-target support,
not an unnoticed allocation.

`Ocean` samples the persistent near/far field once as RGB. B removes only the
fine/detail slope stack and its unresolved micro-normal variance; it never
touches resolved Gerstner displacement, residual swell, wave phase or
buoyancy. A small lit haze term pales the band. Suppression applies only to
instantaneous ambient breaking, so hull-injected R/G remains white. With the
master off, injection and all three appearance gains are exactly zero while
already-stored B is still allowed to decay naturally.

### Policy and evidence

The first visual policy is deliberately named and provisional pending Ash's
eyes. Stern drive scales as speed-through-water squared, is exactly zero at
zero speed or without a complete stern cut, and is progressively narrowed and
dimmed once ambient whitewater masks it. Wind/sea mixing shortens the B decay
from 30 s toward 20 s. The exporter records the actual field transport vector,
source position/radius, R/G/B rates, B tau and the three appearance gains at
1 Hz.

First recorded sample per case:

| Case | R /s | G /s | B /s | radius | B tau | sea mask |
|---|---:|---:|---:|---:|---:|---:|
| moderate anchor | 0 | 0 | 0 | 0.856 m | 29.61 s | 0% |
| glassy polar reach | 0.0865 | 0.0324 | 0.1125 | 0.761 m | 30.00 s | 0% |
| moderate polar reach | 1.1687 | 0.4383 | 1.5193 | 0.944 m | 29.61 s | 0% |
| Southern rough polar reach | 1.3956 | 0.5233 | 1.8143 | 0.683 m | 20.00 s | 100% |

The contact statistics and polar values from WK0 are unchanged. Two complete
fresh exports were byte-identical at SHA-256
`070aa8d7620290eaf32aac03c8b499405997a5d696e0368582bf28c5cfc02971`.

### Gates covered

- Exact zero R/G/B injection at zero speed despite non-zero wave/contact motion.
- Speed-squared drive, missing-stern gating and rough-sea masking.
- Course-vector transport under imposed leeway, with the sign pinned by test.
- Exact exponential B decay, including arbitrary-step semigroup behaviour.
- RGBA format/readback/memory, additive blend factors, alpha writes and reset
  warm-up exclusion.
- Existing ambient R/G injection expression retained verbatim; every new ocean
  contribution is exactly zero with the master off.
- One shared persistent-field fetch path feeds hull smoothing, haze,
  suppression and the existing R/G whitewater consumer.

### Visual checkpoint — deliberately still open

`wakeContactSheet.ts` advances each freshly solved glassy/moderate/Southern
polar state twice from the same deterministic reset: an ambient-only 28-second
master-off A run, then a real 28-second hull-trail run. It captures cinematic-
stern-quarter and embodied-aft views; full/minus-smooth/minus-haze/minus-
suppression share the exact frozen B field. The separate A run is necessary
because hull R/G legitimately mixes into the existing ambient R/G channels and
cannot be retrospectively tagged. The harness is ready; its images have **not**
been treated as Ash's acceptance.

The blocking checkpoint must also include a real S3 helm-driven maneuver. The
current deterministic matrix uses captive straight reference legs and does not
pretend otherwise. S3's documented frozen-trim limitation means a classic tack
crosses the eye but settles in irons; Ash may judge that steering curve (or a
manually steered gybe) for trail curvature. Record the chosen maneuver and the
accepted policy numbers here before treating WK1 as accepted or enabling wake
effects by default. By Ash's sequencing decision below, this checkpoint no
longer blocks WK2 implementation.

### Performance — measured, gate still open

Ash supplied an uncontended window on 2026-08-07. The repository's real
GPU-enabled headless Chrome process ran on Apple M2 / ANGLE Metal at a verified
2560×1440 drawing buffer. The in-app browser was not used for timing.

The exact WK0 commit `80a1c2f`, checked out in a detached temporary worktree,
recorded 37.60 ± 5.63 ms for the complete-frame off arm of the existing
interleaved absolute-baseline route. The same route on WK1 with the wake master
default-off recorded 38.07 ± 5.05 ms. That +0.47 ms is between separate runs,
not paired, and is **not** attributed to WK1.

The dedicated WK1 bracket built a real 28-second `CURRENT_MODERATE` polar trail,
froze world/waves/clouds, kept FoamField stepping, then collected 24 adjacent
master-off/master-on pairs:

- complete-frame paired mean **+1.750 ± 1.198 ms SE**;
- complete-frame paired median **+0.507 ms**;
- pair range **−7.347 to +24.282 ms**;
- derived ocean-prefix mean **+2.313 ± 1.104 ms SE**, median **+1.313 ms**.

The whole-frame mean is less than two standard errors from zero, and the robust
median and mean sit on opposite sides of the 0.6 ms budget. Therefore this run
is **inconclusive**, not a pass and not a proven failure. The raw first-run
report retains its original point-estimate `FAIL` line; the corrected
statistical interpretation and exact hashes are in
`evidence/ship-wake/performance/README.md` rather than rewriting raw evidence.

The unattended harness is retained and strengthened for the next window: 16
raw rotations per leg rather than 4, and pass/fail only when the two-SE interval
lies wholly on one side of the budget. No further GPU work is needed until Ash
wants that tighter rerun.

### Verification record

- `npm run test:full` — 49 files / 681 tests green.
- `npm run typecheck` — clean.
- `npm run build` — clean (existing mixed-import and chunk-size warnings only).
- `npm run ship:wake` twice — byte-identical expanded evidence and validation
  clean.
- GPU evidence — exact WK0 baseline plus the first 24-pair WK1 bracket committed
  under `evidence/ship-wake/performance/`; WK1 budget verdict inconclusive.
- In-app browser functional smoke at the local dev build: master and all four
  WK1 controls exercised; master restored off;
  rendered scene sane; no shader/runtime errors. The only warning was the
  existing Three.js `PCFSoftShadowMap` deprecation. This was not a performance
  run.

### Sequencing decision — milestone 3 / WK2 unblocked

On 2026-08-07 Ash explicitly directed the project to move ahead and prepare a
new task for milestone 3. In the round plan, milestone 3 is **WK2 — the bow and
waterline**. This decision does not turn the inconclusive WK1 performance result
into a pass and does not constitute visual acceptance of WK1. It changes only
the sequencing:

- at that checkpoint, the wake master remained off by default;
- do not describe WK1 as accepted until its visual/steering checkpoint closes;
- retain the strengthened paired GPU rerun for a convenient uncontended window;
- close those carry-forward checks before enabling the wake system by default
  or declaring the combined work accepted.

Those checks are no longer prerequisites for beginning WK2 code work.

### Next implementation session

Start milestone 3 as WK2 from current `master`. Read
`docs/wake/WAKE_WATER_DESIGN.md`, the WK2 section of `docs/wake/WAKE_WATER_PROJECT_PLAN.md`, and
this handover before editing. The first implementation targets are bow-point
R/G/B injection and the actual waterline-driven wet hull band. Preserve the
project-wide presentation-only, one-way-physics invariant. WK2's own
performance and embodied visual gates remain required, alongside the
carry-forward WK1 acceptance checks above.

---

## Lead review — WK0 and WK1 · 2026-08-07

**Verdict: WK2 cleared to start.** Reviewed by the thread lead against the
design invariants and the plan's per-round gates, independently of the
implementer's own verification record.

### What the review verified first-hand

- Full suite green in the reviewer's own run (49 files / 681 tests).
- `npm run ship:wake` regenerated byte-identical evidence in the reviewer's
  own run — determinism confirmed, not taken from this log.
- Line-by-line reads of `WakeSources.ts`, `wakePolicy.ts`, the complete WK1
  diffs to `FoamField.ts`, `Ocean.ts` and `main.ts`, and both wake test
  files. Confirmed: the master-off path is exact (multiplications by literal
  1.0 and gated zeros; ambient R/G injection retained verbatim), warm-up
  excludes hull injection, alpha blend factors prevent additive alpha
  accumulation, sign tests live on pure seams, and nothing writes toward
  physics or canonical state.

### Review findings and their disposition

1. **Two hull-speed numbers coexisted undocumented.** Resolved during
   review: `WAKE_POLICY_HULL_SPEED_MPS = 4.7` equals the sailing thread's
   canonical `SAILING_HULL_SPEED_MPS` (1.34 kn·√LWL(ft), 14.3 m waterline);
   the sailing documents' 5.875 m/s is that number times the polar's stated
   1.25 surfing allowance, so there was never a conflict — only an
   undocumented duplicate. Fixed by documenting the derivation at both
   constants' point of use, correcting design §2, and pinning the agreement
   with a test in `wake-trail.test.ts` (by test, not by import, so the
   render bundle never depends on an evidence harness). Southern-reach
   saturation (5.29 m/s > 4.7) is confirmed as chosen behaviour.
2. **The GLSL string-pinning tests are deliberately brittle.** Accepted as
   the right compromise without a GPU in vitest; a reviewer-guidance comment
   now stands over them: a failure means read the shader diff and re-pin on
   purpose, never revert-to-satisfy-the-string or loosen the match.
3. **`diagnosticTowLeewayRad` reshapes the shared captive-tow path**,
   slightly beyond the plan's additive-only rule for shared files. Approved
   as the thread's one reviewed exception: captive evidence only, set only
   through the diagnostic API, zeroed on `releaseTow`. Now documented as
   such at the declaration.
4. **WK0-F2 invalidates WK3's original sizing plan** (zero overtop events in
   all four reference runs). The WK3 plan section now requires a dedicated
   deterministic sizing case as an intentional evidence extension, forbids
   retuning the physics-owned detector, and — per WK0-F1 — extends the
   no-emission-at-anchor gate to `CURRENT_MODERATE`, the case proven able to
   false-fire an entry-speed-only trigger.

### Carry-forwards (unchanged by this review)

- **WK1 visual acceptance** — Ash's A/B at the reference states plus a
  steered maneuver. Gates calling WK1 accepted and any default-on.
- **WK1 performance gate** — inconclusive first bracket; the strengthened
  16-rotation harness needs one uncontended GPU window. The ocean-prefix
  medians hint the true cost may sit above the 0.6 ms slice (RGBA16F
  bandwidth on two textures is the plausible mechanism); if the rerun lands
  over budget, the design's named compressible items apply, on numbers,
  with Ash deciding.

Process note for future rounds: the implementer's handover discipline here —
findings surfaced in full, an inconclusive measurement reported as
inconclusive rather than rounded to a pass — is the standard this thread
expects.

---

## WK2 — The bow and the waterline · implemented 2026-08-07

**Status: implementation, deterministic gates and GPU budgets complete. Visual
calibration remains open.** At Ash's 2026-08-07 direction the combined wake is
now on by default, with the existing Debug Tools master checkbox as its off
switch.

### What now exists

- **Bow collar:** every active bow-side `HullWaterContact` intersection feeds
  R/G plus a smaller B term into FoamField's existing injection draw. The
  fixed 26-point uniform buffer fits every schooner bow-side contact;
  overlapping sources combine by maximum so station density cannot brighten
  the ribbon.
  Each source becomes a short downwind segment at `CrestSpray`'s shared 0.96
  coupling.
- **Resolved wet hull:** `WakeSources` publishes stable, longitudinally sorted
  complete waterline cuts in hull-local and world coordinates. `HullWetBand`
  retains eight real profile knots and modifies only exterior world-PBR hull
  materials: darker albedo and lower roughness in a short band above the live
  cut. It does not read design draught, `WaveField`, or any physics authority.
- **Optional bow mound:** one removable Ocean fragment block adds a small
  analytic normal gradient immediately ahead of the forwardmost complete bow
  cut. It has no vertex displacement and its own lab toggle; Ash may keep,
  recalibrate or kill it at the visual checkpoint.
- **Instruments:** Ocean Lab has independent collar, wet-hull and mound
  toggles, live WK2 policy/contact readouts and a deterministic “WK2 A/B
  sheet” button. `?perf=wake-bow` is the unattended incremental GPU bracket.

The data flow remains strictly one-way:
`HullWaterContact → WakeSources → wakePolicy → FoamField/hull material/Ocean
normal`. No force, `CanonicalWorldState`, wave phase, buoyancy sample or hull
coefficient is changed.

### Policy and deterministic evidence

The collar has an exact 0.8 m/s onset, smooth speed drive, and saturates at the
shared 4.7 m/s hull speed. Its unmasked full-drive rates are R 1.65, G 0.52 and
B 0.38 per second. The first implementation gains are provisional until Ash's
checkpoint: wet height 0.46–0.60 m, darkening 0.28, roughness multiplier
0.58, and maximum mound normal strength 0.11 before rough-sea masking.

The exported collar curve is:

| Speed (m/s) | Drive | R/s | G/s | B/s |
|---:|---:|---:|---:|---:|
| 0.0 / 0.4 / 0.8 | 0 | 0 | 0 | 0 |
| 1.2 | 0.029400 | 0.048511 | 0.015288 | 0.011172 |
| 2.0 | 0.225762 | 0.372508 | 0.117396 | 0.085790 |
| 3.0 | 0.595627 | 0.982785 | 0.309726 | 0.226338 |
| 4.7 / 5.875 | 1 | 1.650000 | 0.520000 | 0.380000 |

At the 3.592773 m/s moderate reference the resolved drive is 0.803961: R
1.326536, G 0.418060 and B 0.305505/s, 0.608634 m source radius, 0.572555 m
wet band and 0.088436 mound strength. Southern rough reaches full speed drive
but masks the visible rates to R 1.023, G 0.3224 and B 0.2356/s and the mound
to 0.0308. At anchor there are still 24 honest bow points and an eight-knot wet
profile, but collar injection and mound strength are exactly zero; a stationary
hull correctly remains wet.

`contact-baseline.json` is now evidence format 3. Two fresh exports were
byte-identical at SHA-256
`2bdf7234fb185bf2d488d326e23a7030103f03c0441cb8389ec62b52eae17454`.
WK0 contact and WK1 trail headline values remain unchanged.

### Gates covered

- Exact zero collar and mound at/below onset, at anchor, without real bow
  points, or through their relevant toggle/master off-path.
- Actual bow-side intersections only; forward mound attachment is the real
  forwardmost complete cut, not a design-waterline reconstruction.
- Eight wet-hull knots track contact-local waterline heights through a seeded
  240-frame Southern-rough pitching run; both pitch and waterline height vary.
- Collar added to the existing FoamField pass, warm-up still excludes all hull
  injection, and the optional mound is fragment-normal-only.
- Browser functional smoke in the local desktop build: master and all three
  WK2 controls exercised and restored, scene rendered, no shader/runtime
  errors. The only console item was the existing Three.js
  `PCFSoftShadowMap` deprecation. This proves wiring/compilation, not the look.

### Visual checkpoint — pending Ash

The WK2 contact sheet rebuilds five independent 18-second histories from the
same deterministic reset for each of glassy, moderate and Southern rough:
WK1-only A, full WK2 B, B−collar, B−wet-hull and B−mound. It captures
embodied-bow first and cinematic bow-quarter second. Independent histories are
required because hull R/G shares FoamField's ambient channels and cannot be
removed retrospectively.

Ash still needs to judge whether the collar reads as attached water rather
than paint, whether the live wet ribbon follows pitch without crawling, and
whether the mound earns its cost. Record accepted/revised gains and the
keep/kill mound decision here before calling WK2 visually accepted. Ash's
explicit default-on direction is not represented as a visual acceptance that
did not happen.

### Performance checkpoint — passed on uncontended GPU

The dedicated `?perf=wake-bow` route builds the moderate 3.592773 m/s
reference, keeps the wake master and WK1 fully on, then switches all WK2 work
off/on across 24 adjacent pairs with 16 raw six-frame rotations per leg. Its
gate is ≤0.2 ms for the complete GPU frame, with pass/fail only when the
two-standard-error interval lies wholly on one side of the budget.

The final run used real headless Chrome 151 on Apple M2 / ANGLE Metal with a
verified 2560×1440 drawing buffer. WK1, with WK2 explicitly held off, measured
**+0.031 ± 0.005 ms SE**, median **+0.030 ms**, and passed its ≤0.6 ms gate
with a 95% upper estimate of **0.042 ms**.

WK2 initially produced two formally inconclusive brackets because rare slow
legs dominated the arithmetic mean despite stable ~0.06 ms medians. Those raw
runs are retained. The obvious whole-field waste was then removed: the
26-point collar loop is entered only inside a source rectangle expanded by the
same per-level texel footprint used by injection, and the analytic mound skips
its exponential outside 3.5 radii. The first bounded run remained inconclusive
after one 1.628 ms leg; the repeat measured **+0.128 ± 0.024 ms SE**, median
**+0.101 ms**, and passed the ≤0.2 ms gate with a 95% upper estimate of
**0.176 ms**. Nothing was rounded or trimmed into a pass.

The `?perf=wake-trail` and `?perf=wake-bow` parameters remain solely as
reproducible benchmark launchers. They do not control normal gameplay wake
state.

### Verification record

- `npm run test:full -- --configLoader runner` — 50 files / 691 tests green on
  the final merged/default-on code.
- `npm run typecheck` — clean.
- `npm run build -- --configLoader runner` — clean (existing mixed-import and
  chunk-size warnings only).
- `npm run ship:wake` twice — byte-identical format-3 evidence and validation
  clean.
- Targeted WK0/WK1/WK2 wake tests — 3 files / 25 tests green before the full
  suite.

### Exact carry-forward list

1. **Ash visual, WK1:** A/B at glassy, moderate and Southern-rough reference
   states in cinematic and embodied views, plus a real steered maneuver for
   trail curvature; accept or revise WK1 gains.
2. **Ash visual, WK2:** the embodied-led five-column matrix above; accept or
   revise collar/wet-band gains and decide whether to keep the optional mound.

Both GPU gates and the default-on decision are closed. There are no other known
WK2 implementation or headless-validation blockers.

---

## WK-R — Recovery round: carrier fix, calibration, structure, waves · 2026-08-07

**Status: implemented by the thread lead at Ash's direction, after Ash rejected
the WK1/WK2 look while sailing (short blotchy foam, no trail, weak bow, no ship
waves). The review that preceded this round found the cause was not
calibration: the trail was being destroyed in the field.** Deterministic gates
green; Ash's reference-state A/B supersedes and absorbs the WK1/WK2 visual
carry-forwards above.

### R1 — the carrier was eating the trail (root cause, fixed)

`FoamField`'s advection resampled the whole field bilinearly 24 times a second,
scrolled by observer velocity — about 0.11 texel per step at 4 m/s on the near
level's 1.5 m texels. Repeated sub-texel bilinear resampling is numerical
diffusion: σ ≈ 2.3·√t m, so a one-to-two-texel hull line blurred to a ~5 m
smear inside 4 seconds and fell below every render threshold long before its
30 s decay constant mattered. **No gain tuning could have produced a long
trail through this** — the same class of mechanism-not-tuning failure as the
2026-08-01 registration defect, and invisible to WK1's gates because the decay
tests were analytic (exact semigroup on the decay *factor*) while the field
died numerically in the resample. Verified live both ways: at rest the stern
blob outlived 40 s; under way, the raw-field debug view showed the tail gone
in one to two boat lengths.

Fix: `quantizeFoamFieldScroll` — each level scrolls its contents by **whole
texels only**, and the sub-texel remainder lives in that level's origin (the
parameter position of the texture centre, now per-level: near and far shift at
different times). A texel-aligned bilinear copy lands exactly on texel centres
and is lossless; the origin remainder keeps injection and lookup continuous.
`uFoamOrigin` split into `uFoamNearOrigin`/`uFoamFarOrigin`; the whitewater
GPU probe drives both. Ambient foam sees the same carrier fix; its wind drift
(~0.005 texel/step) was too broad and too re-injected to show the blur, and
motion stays smooth because the origin remainder slides while the contents
step. Contract tests pin integer-texel shifts, remainder bounds and exact
distance conservation at the 4.1 m/s case that used to diffuse away.

### R2 — deposits and the band's voice (provisional numbers, Ash's A/B rules)

With the carrier honest, the WK1 rates deposited only ~0.1–0.4 density along
the track (rate × dwell ≈ rate × 1.2·radius/V) — sparse threshold-crossings
against the breakup noise, which is exactly the "random blotches" Ash saw.
Policy now sizes deposits by dwell: stern R 6.0 / G 1.8 / B 5.5 per second at
hull speed (R near saturation at the moderate polar), bow collar R 4.5 /
G 1.5 / B 1.1. Calm B tau 45 s (rough 24 s) — deliberately at the
beautiful-lie end, ~150 m e-fold at 3.5 m/s, because G rides the *sea's*
persistence (6 s moderate) and B is the only long carrier. B gained a second
consumer: `trailFoamFloor` (0.28 × B into residual-foam coverage, own lab
toggle "Trail foam floor (B flecks)") so the worked band keeps sparse aged
flecks after G ages out, and bubble haze rose 0.22 → 0.5. All named constants
in `wakePolicy.ts`; nothing touched sea presets.

### R3 — registration and structure

- **Gerstner inversion at every field-space source.** The foam field is
  indexed by seed position; contact points are world positions, and the
  difference — the local orbital displacement — swung the stamp around the
  stern with every wave. `WaveField.invertDisplacement` (the buoyancy
  solver's own seed inverter, now public) is applied to the stern cut, every
  bow point, the mound centre and the pattern anchor, ~30 solves per frame on
  CPU.
- **Track-aligned grain.** The foam breakup's streak axis now blends from
  wind toward the course direction where B is strong (`uWakeStreakDir`), so
  the trail's texture runs down the track while ambient windrows keep the
  wind. An already-laid trail keeps only the current course's grain —
  documented lie, same shape as the streak-injection precedent.
- **Stern rails.** Stern R/G injection is biased toward the ends of the
  resolved cut (`railBias` 0.55, roughly energy-neutral; B stays full-width),
  the two-shoulders-and-churned-core structure of a real wake. When the
  breathing cut narrows below a texel the rails merge on their own.

### R4 — the ship's waves (WK4 pulled forward; the gate's premise was wrong)

The WK4 deferral argued the pattern is "subtle at her Froude numbers". That is
honest below ~2.6 m/s and wrong at the 3.5–4.1 m/s Ash actually sails:
Fr = 0.30–0.35, λ = 2πV²/g = 7.9–10.8 m — most of a waterline. Built now as
designed in §4.5: one analytic hull-frame block in the ocean fragment shader,
**normals only**, anchored at the inverted stem seed. Transverse waves fill
the exact Kelvin wedge (asin(1/3), a constant, pinned by test with λ);
divergent wavelets at λ·⅔ ride a ~1.2λ band on the arms at 35.26° to track.
Envelope derivatives are deliberately dropped (the carrier's k dominates).
Fades: speed onset 1.2→2.6 m/s, ambient-energy mask (×0.85 seaMask — it
drowns before the foam does), turn-rate fade 2→8 °/s on a presentation-
smoothed |yaw rate| (the steady pattern declines to lie through manoeuvres),
pixel-footprint alias fade, √-spread and tail fade along a wedge of
clamp(8λ, 30, 160) m. Own toggle ("Ship wave pattern"); strength zero is an
exact off-path; removal remains one shader block plus one policy section.

### Gates and verification

- Full suite green (see verification record below); typecheck and production
  build clean.
- New contract tests: whole-texel scroll + remainder exactness; sub-texel
  drift parks without shifting; λ = 2πV²/g and the 19.47° wedge pinned;
  pattern exact-zero at anchor; ambient-energy and turn fades.
- Master-off remains an exact appearance off-path (all gains, floor and
  pattern strength zero; stored B still decays naturally).
- Ambient R/G injection arithmetic retained verbatim (string-pinned).
- Live desktop verification at each stage on the tow rig: long persistent
  trail in both the raw field view and production, bow collar attached,
  pattern A/B visible on glass and absent when toggled off.

### Open items for Ash

1. **The A/B that matters: sail her.** All previous WK1/WK2 visual
   carry-forwards collapse into this round's look pass at the three reference
   states. Every effect has its own lab lever; revised numbers get written
   into `wakePolicy.ts` comments as usual.
2. **Glassy low-angle foam weight.** At 4 m/s on glass the collar-plus-trail
   carpet alongside the hull reads heavy from the low waterline camera. If it
   reads heavy to Ash too, the first lever is the collar/stern R rates, not
   the floor.
3. **Pattern strength.** PATTERN_SLOPE_MAX 0.3 on glass is deliberately
   assertive so the A/B has something to bid down from.
4. **GPU ledger.** R1 changes no per-frame work shape (same two passes); the
   pattern block is bounded by the wedge test but is new fragment work, and
   the design's 0.3 ms pattern slice has not yet been measured on an
   uncontended GPU. The `?perf=wake-trail`/`?perf=wake-bow` harnesses remain;
   a pattern-specific bracket wants adding at the next quiet-GPU window
   before the thread's final 1.5 ms ledger.
5. **Evidence.** `contact-baseline.json` regenerated deliberately with the
   new policy values — two fresh runs byte-identical at SHA-256
   `28d16f23e039c7d8713cfefc42e389f51f401d10119e1c9d0f9ca43d385e7d88`; WK0
   contact statistics unchanged (bow p95 0.051 / 0.911 / 2.040 m/s),
   WK1/WK2 policy-derived numbers updated. (Superseded by the S4 merge below —
   see the pickup section.)

---

## WK-R merge to master, and where the next session starts · 2026-08-08

**Ash's verdict on the running build: "it still needs work, but this is an
improvement." Specific feedback deferred to the next session.** That is an
interim judgement, not visual acceptance: no WK-R gain has been signed off,
and the numbers below stay provisional until Ash names what is wrong. Merged
to master at Ash's instruction on that basis, because the round is a strict
improvement over what was on master and blocking it behind a full look pass
would have stranded the fix.

### The S4 merge, and what it moved

Master had advanced to `4c64b9f` (S4 — live trim, moving rig, the tack
completes) since this branch was cut. Merged master in first, per the plan's
cross-thread rule, then re-ran everything. No textual conflicts; the wake's
call sites into `Schooner` survived untouched.

**S4 does move this thread's evidence**, and that is expected rather than
alarming: `WakeSourcesEvidence` freshly *solves* the captive polar through
`SailingPolarEvidence.solveEquilibrium` for each reference sea, so a change
to sail aero or trim changes the reference speeds every wake number is
sampled at. The baseline was therefore regenerated once, deliberately, after
the merge (two runs byte-identical at SHA-256
`e2540e30829c412bf87129d9eda8c712b5dd1402ef5218539170f691f20ba443`).

The mechanism, precisely, because it is easy to state wrongly: **no sail acts
inside the contact run.** That run is a captive tow and consumes exactly two
numbers from the polar solution — speed and leeway
(`runWakeContactCase`'s head comment). What S4 changed is how those two
numbers are *solved*: the captive probe no longer holds one frozen trim, it
trims every probe to draw for its own apparent wind
(`SailingPolarEvidence.ts`, "S4: every probe is trimmed to draw for ITS
apparent wind"), which is why the polar evidence format went v2 → v3. Better
trim, more drive, so the solved operating point moved. The hull, mass and
buoyancy model are unchanged.

| Reference (90° starboard reach) | S3 frozen trim | S4 trim-to-draw |
|---|---:|---:|
| `GLASSY_LONG_SWELL` speed | 0.9775 m/s | 1.0791 m/s |
| `CURRENT_MODERATE` speed | 3.5928 m/s | 3.7197 m/s |
| `SOUTHERN_OCEAN_ROUGH` speed | 5.2939 m/s | 5.4209 m/s |
| Southern leeway | 2.578° | 1.172° |
| Southern balance rudder | 3.008° | 6.836° |

### WK-R-F1 — the Southern reference now overtops, and WK0-F2 is spent

WK0-F2 recorded **zero** overtop events across all four reference runs and
concluded WK3 could not size `OvertopSpray.strength()` from them. The
regenerated baseline records **334 event samples across 11 frames** in
Southern rough, peak depth 0.151 m, peak event speed 1.329 m/s.

I isolated the cause rather than assuming it, by running the current code at
the old and new kinematics and at both crosses (throwaway probe, not
committed):

| Southern rough contact case | overtop event samples |
|---|---:|
| S3 speed + S3 leeway | 0 |
| S4 speed + S3 leeway | 0 |
| S3 speed + S4 leeway | 0 |
| S4 speed + S4 leeway | **334** (11 frames) |

So it is neither variable alone: the detector fires only on the combination of
the extra 2.4% speed *and* the halved leeway (a hull squarer to its own path).
It is a marginal crossing — 11 frames in a 60-second measurement, ~0.3% of
frames — not a vessel that now ships water routinely. Nothing in the physics
was retuned; the operating point simply crossed a threshold it previously sat
under.

**Consequence for WK3:** its plan section is written around WK0-F2 and
requires a dedicated deterministic sizing case because the references could not
fire the detector. That constraint is now partly lifted — the Southern
reference *is* a firing case — but it is a thin one. WK3 should treat these 11
frames as a floor, not a calibration set, and still build a heavier case to
size `strength()` against. Do not retune the physics-owned detector to get more
events; that remains a physics-thread finding if it looks wrong.

### Exact state at the merge

- Branch `claude/wakewater-visual-review-07018d`, merged to `master`.
- Wake master remains **on by default**; every WK-R feature has its own Ocean
  Lab toggle, and master-off is still an exact appearance off-path.
- Dev server config `drift-wake` on fixed port 5217 (`.claude/launch.json`).

### Verification on the merged code

- `npm run test:full` — **52 files / 723 tests green** (up from 50/695 on the
  pre-merge branch; the additions are S4's `ship-rig-trim-envelope` and
  `ship-sailing-controls` suites, not new wake tests).
- `npm run typecheck` — clean.
- `npm run build` — clean (existing mixed-import and chunk-size warnings only).
- Dev server on the merged branch serves without console or build errors.
- No GPU timing was taken on this merge; see pickup item 3.

### Pickup list, in the order I would take them

1. **Ash's feedback is the first input.** It supersedes my own guesses below.
   Every visual constant lives in `wakePolicy.ts` with a comment; change
   policy, never sea-state presets or contact geometry.
2. **My own standing suspicions, if Ash's feedback does not name them first:**
   the collar-plus-trail foam carpet alongside the hull reads heavy from the
   low-waterline camera on glassy water (first lever: `BOW_COLLAR_ACTIVE_RATE`
   and `ACTIVE_FOAM_RATE_AT_HULL_SPEED`, not the foam floor); and
   `PATTERN_SLOPE_MAX = 0.3` is deliberately an assertive opening bid.
3. **The pattern's GPU cost is unmeasured.** R1 changes no per-frame work
   shape, but WK-R4 is genuinely new fragment work and the design's 0.3 ms
   pattern slice has never been bracketed. `?perf=wake-trail` and
   `?perf=wake-bow` exist; a `?perf=wake-pattern` bracket wants building on
   the same paired-interleaved-blocks method before the thread's closing
   1.5 ms ledger. Do it on an uncontended GPU, headless, per
   `docs/ocean/OCEAN_PERF_HANDOVER.md` — never in the in-app pane.
4. **The A/B sheets still describe the pre-WK-R component set.**
   `wakeContactSheet.ts` builds WK1's four-column and WK2's five-column
   matrices; neither knows about the trail foam floor or the wave pattern. If
   the next round wants deterministic evidence images, those columns need
   adding.
5. **WK3 is untouched and still next in the plan** — bow entry spray and the
   overtop port, with WK0-F1/F2's constraints (no anchor false-fire; the
   reference runs recorded zero overtop events, so `strength()` needs a
   dedicated sizing case).

### What I would not re-litigate

R1's texel-quantised advection is not a taste call and should not be tuned
away: sub-texel resampling of a persistent field is numerical diffusion, and
it is what made every previous wake look unsalvageable. If a future change
makes the trail short again, check the scroll quantisation and the per-level
origins before touching any gain.

---

## WK-R5 — Ash's feedback round: the lookup, the hull level, the real pattern · 2026-08-08

**Status: implemented and merged. 55 test files / 748 tests pass, production
build clean, `npm run ship:wake` evidence regenerated. Ash accepted the foam
lookup change by eye ("a little cheesey but it'll do just fine... much better,
happy to go with that") and reviewed the wake live during the round.**

Ash gave four complaints on the merged WK-R build: foam patches with a
"blotchy wood-grainey oil-slick look"; "noisy static-electricity type bits
that buzz", pixels flashing white/blue; bow patches that "seem to just spawn
on the water next to the ship, but don't originate from it"; and foam that is
flat rather than voluminous. Mid-round he added that the wave pattern "doesn't
seem right — I thought a real pattern would compress at the point of the bow
and then fan out diagonally", and that the wake must stay one-way.

### R5-1 — The foam lookup was a domain warp (three complaints, one cause)

`persistentFoamField` displaced its own UV by 0.9 texel along
`noisedPeriodic(...).yz` — a noise **gradient**. Offsetting a lookup along a
noise gradient is a domain warp, and domain-warping by a noise gradient is the
standard procedural recipe for wood grain and marble. Ash's word for it was
diagnostically exact. At the 1.5 m near level 0.9 texel is **1.35 m of open
water**.

It dates from `2fec8b0` and WK-R never touched it. It was harmless for years
because ambient foam is broad, smooth patches, and a sample displacement only
destroys what is sharp at the dither's scale. **R1 and R2 are what made it
live**: texel-exact advection plus near-saturated deposits handed the warp a
crisp, high-contrast field, and it began sampling across hard foam edges.
Neighbouring pixels landing 1.35 m apart across such an edge is the blotching,
the bow collar torn off the stem into free-floating patches, and — since the
noise re-rolls as the camera and field move under it — the white/blue buzz.
Ocean TAA is opt-in (`?oceanTaa=1`), so nothing averaged it away.

The jitter was earning something real: bilinear magnification of a 1.5 m grid
has a gradient discontinuity at every texel boundary, whose level sets read as
a diamond lattice. So fix the reconstruction, not the sample.
`src/scene/foamLookup.ts` sets the jitter to **zero** and adds a quintic
within-texel fraction warp (`smoothTexelUv`, Ocean.ts) whose derivative
vanishes at both ends, making the interpolant C1 across texel boundaries. It
moves no sample: a foam edge stays exactly where the field put it, and there
is no per-pixel noise left to buzz. Smoothing is **0.75, not 1.0** — a full
warp flattens texel centres as well as boundaries and trades the diamond
lattice for a grid of texel-sized plateaus.

Legacy (0.9 jitter, no warp) stays reachable as a bit-exact A/B arm, with both
levers on sliders, in the Ocean Lab's "foam lookup" section. This is not a
wake-only switch: the same lookup serves every whitecap in the sea.

**Hypotheses killed by reading the code, recorded so they are not re-run:** a
stale lookup origin (`attachFoam` runs every frame); temporal detail jitter
without a resolve (it is zeroed when the resolve is off); the bow collar being
disconnected beads (station spacing is 0.4 m against a 0.975 m effective
radius — they merge).

### R5-2 — The hull level, and the square patterns

With the warp dithering gone, Ash saw "square patterns appearing at bow". They
were the 1.5 m texel grid itself: a 0.6 m bow collar is sub-texel there, and
no reconstruction filter invents detail that was never stored. The answer is
resolution, and only where it is needed.

A third FoamField level, **48 m across at 128 texels = 0.375 m per texel** —
four times finer than the near level for a quarter of its texel count, because
it covers a five-hundredth of the area. Widening the near level to match would
have cost sixteen times more. It is appended as `levels[2]` so `readLevel`'s
published `0 | 1` contract, and every diagnostic built on it, keep meaning
near and far. A bonus falls out: at 0.375 m texels the bow's 0.61 m source
radius finally clears the `uTexelSize * 0.65` floor, so its `footprintWeight`
goes 0.62 → 1.0.

### R5-3 — The ghost wake (a bug introduced in this round, caught by Ash)

Ash: "Why do all these screenshots have a 2nd wake off to the side?" It was
real, and it was new.

**Every foam level is a torus.** What scrolls off one edge re-enters on the
opposite one. That is harmless when the window is large compared with how far
foam travels before it decays — the near level is 384 m against a B channel
that e-folds in about 160 m, so anything coming back around has been
multiplied by 2⁻⁹. It is not harmless at 48 m: that is thirteen seconds at tow
speed against B's 45 s time constant, so **about three quarters of the trail
survived the trip round** and sailed back through the window as a second,
parallel wake every 48 m.

Fix: `uEdgeKill` in the advect pass. The hull level crushes surviving foam
over **(0.45, 0.49)** in uv-from-centre — strictly *outside* the lookup's
0.443 fade end, because starting it earlier punches a dark ring through the
crossfade, and complete before the 0.5 wrap so nothing reaches it alive. The
wide levels get an inert `(1, 2)` and go on outliving their wrap by decay.

Isolated by removing the hull level from the lookup — one edit, decisive.
Three earlier theories (stale foam surviving a reset, warm-up stamping the
hull source, the fade failing before the wrap) were all wrong and all killed
by reading the code rather than by experiment.

**Generalise this:** adding a small clipmap level to a long-persistence field
needs an edge kill, every time. The persistence that makes the trail good is
exactly what makes a short window recirculate.

### R5-4 — The wave pattern is now real Kelvin geometry

WK-R4's pattern was two independent **plane waves**: `sin(k * astern)` for the
transverse system and a fixed 35.26° `sin(...)` for the divergent one, with
the cusp painted on as a Gaussian envelope. Straight, parallel crests at one
uniform wavelength cannot compress or fan, because nothing in that arithmetic
varies with position. Ash's read was exactly right.

The real pattern is not two systems. Waves holding station against a hull at
speed V satisfy `k(θ) = k₀ sec²θ`, `k₀ = g/V²`. Stationary phase picks the
headings that actually reach a point, and that condition is merely a
**quadratic in tan θ**:

    2·Y·t² + X·t + Y = 0,    t = tan θ,  X astern, Y abeam, in units of 1/k₀

so both branches are closed form. No integral, no root-finding, and **no baked
texture** — a bake was planned and turned out to be unnecessary. Its
discriminant `X² − 8Y²` *derives* the wedge (real roots need
|Y/X| ≤ tan 19.47°) instead of the constant being asserted. The small root is
the transverse branch, the large one divergent, and they merge exactly where
the discriminant vanishes, which is the cusp. One family, two ends, joined —
which is what produces compression at the bow and the diagonal fan.

Numerically: the transverse root is taken as `c/q` (`-2Y/(X+√disc)`) so it
stays exact on the centreline where the textbook formula is 0/0. Amplitude is
a Havelock depth weight `exp(-D sec²θ)` at D = 0.22, with the saddle's
`1/√|Φ''|`; the curvature is floored at 0.6 to bound the cusp caustic, where
the two saddles merge and stationary phase genuinely fails (the true envelope
is Airy). `GRADIENT_NORM = 5.5` because that saddle amplitude carries
`1/√curvature ~ 1/√X`, so the constant has to be set by the mid-field rather
than the peak.

Everything is in units of 1/k₀, so the pattern is exactly self-similar: the
same shape at every speed, scaled by the one length the CPU policy already
publishes. **Still fragment normals only** — `tests/kelvin-pattern.test.ts`
fails if the function ever mentions a vertex, a displacement or the wave
field.

### R5-5 — Bow deposits re-derived, and the tear turned onto the track

R2 sized the stern rates from dwell time and left WK2's bow numbers alone.
A texel's deposit is `rate × 1.2 × radius / V`, so the bow's 0.61 m radius
costs it a third of the stern's dwell before any rate is chosen. The WK2
numbers, read straight across, left the collar depositing 0.74 in R against
the stern's 1.19 and — the one that mattered — **0.18 in B against 1.09, a
factor of six**. B is the worked-water band, so the collar had nothing binding
it together between threshold crossings and read as disconnected islands.
Active 4.5 → 6.5, residual 1.5 → 2.2, turbulence **1.1 → 3.0** (45% of the
stern's B: a transom churns water, a stem shears past it).

The collar's smear ran **downwind**, at CrestSpray's droplet wind coupling.
That is the right model for water thrown clear into the air and the wrong one
for foam in the water, which is left behind in the surface the hull passed
through. On a reach it lifted the whole collar up to 1.8 m sideways off the
hull. It now runs astern along the track at the vessel's own travel over the
residence time. R3 fixed precisely this for the breakup grain
(`uWakeStreakDir`) and missed the injection.

Evidence field `windTearM` is renamed `tearM` and is now an astern vector;
`evidence/ship-wake/contact-baseline.json` regenerated.

### Ash's standing constraint, recorded because it scopes future rounds

**The wake stays one-way. No vertex displacement, nothing written back to
`WaveField`, buoyancy or anything the physics samples.** Ash was explicit when
the option was offered: his complaint was about the normal-shading pattern's
*shape*, not its lack of relief. This retires the displacement options that
had been floated for the bow mound and the pattern, along with their
tessellation and render/physics-mismatch risks.

### Pickup list, in the order I would take them

1. **~~The midships source — asked for in this round and not delivered.~~ DONE
   in WK-R6 below.** The
   field's only hull inputs are still one stern segment and the bow-third
   waterline points, so a 15.5 m hull generates nothing amidships. The design
   is settled: reuse the existing 26-uniform budget as **two polylines of 13
   points** (port and starboard) with segment-distance tests, rather than more
   point sources — same uniform cost, no gaps between stations, and no need to
   inflate the source radius to bridge them. Touches `WakeSources` (drop the
   `region === 'bow'` gate, resample `resolvedWaterlineStations`), the
   FoamField injection shader, `main.ts` and the wake tests.
2. **The hull level's GPU cost is unmeasured.** Estimated +20% of foam
   injection texels (81,920 → 98,304) plus one texture fetch per ocean
   fragment. Measure on an uncontended GPU, headless, per
   `docs/ocean/OCEAN_PERF_HANDOVER.md` — never in the in-app pane.
3. **The pattern's GPU cost is still unmeasured**, and R5-4 replaced its
   arithmetic wholesale. A `?perf=wake-pattern` bracket still wants building.
4. **The A/B sheets still describe the pre-WK-R component set** —
   `wakeContactSheet.ts` knows nothing about the trail foam floor, the wave
   pattern, the hull level or the foam-lookup arm.
5. **WK3 remains next in the plan** — bow entry spray and the overtop port.
   Note for that round: spray is **not** the missing bow-foam source. At
   cruising speed bow foam is air entrained in the breaking bow wave plus
   waterline shear, both of which are *attached* to the hull; spray is
   episodic and lands outside the collar.

### What I would not re-litigate

Everything under WK-R's heading of the same name, plus: the foam lookup must
not go back to displacing its sample to hide a reconstruction artifact. If the
texel grid ever becomes visible again, the levers are the warp strength and
the hull level's resolution — not the jitter. And if a short-window level is
ever added again, give it an edge kill before it is ever looked at.

## WK-R6 — the waterline reaches amidships · 2026-08-08

**Status: implemented and live-verified. 55 test files / 744 tests pass,
production build clean, deterministic wake evidence regenerated twice with
SHA-256 `4260f624f6e1d5102cc1ef9256433ce123e075b31f67c5723f22a6152da98b82`.**

R5 still fed FoamField one stern cut and up to 26 independent points from the
bow third. The 15.5 m hull therefore generated no attached water from most of
either side. R6 keeps the same 26 GPU positions but changes what they mean:
`WakeSources` resamples every complete resolved cut into **13 matched stations**
from the live aft endpoint to the live forward endpoint, packed port/starboard.
The operation is allocation-free, longitudinally even in hull-local z, and
interpolates only presentation world points; contact physics is unchanged.

FoamField now joins adjacent samples into two continuous hull-side polylines.
Each segment is swept by the existing short track-aligned tear and evaluated as
a bounded parallelogram plus its four edge distances. Max composition keeps
brightness independent of sample density. A one-cut fallback remains honest,
and the bounds guard still prevents the work from running outside the hull's
small field region. No new uniform position, render pass, texture, force,
vertex displacement or wave-state path was added.

Deterministic tests pin the 13-station budget, port/starboard packing, endpoint
retention, exact midships interpolation, stable object identities, shader
segment path and production wiring. Evidence format 4 records
`waterlineStationCount`; every moving reference sample holds all 13, while the
anchor continues to publish geometry but produces exactly zero injection.

The live review used the production encounter bridge — not `?debug=ship`, which
intentionally zeros local encounter velocity — at 4.35 m/s in
`CURRENT_MODERATE`. The source remained attached and continuous through
midships, fed the existing astern band, showed no detached patches or gaps, and
logged no shader error. The clean capture is
`evidence/ship-wake/midships-waterline-wake.jpg` (ignored visual evidence, kept
locally). This is implementation verification, not Ash's final visual tuning
acceptance.

The GPU increment is deliberately unclaimed. R6 trades 26 point-to-tear tests
for 24 swept side segments with more distance arithmetic; include it in the
next uncontended hull-level/wake bracket rather than reading the in-app pane.
The next feature round remains WK3: bow-entry spray and the schooner overtop
port.

## WK-R7 — ocean detail survives the Kelvin wake · 2026-08-08

**Status: implemented and live-verified. 55 test files / 745 tests pass,
production build clean, deterministic wake evidence regenerated twice with
SHA-256 `e1e515766a438f71078a8021e15a2302160071fdea5b4f27e44dd52f64b5d39b`.**

Ash rejected the worked-water smoothing after the R6 capture: the Kelvin cone
looked glassy, and its narrow cusp fade read as a straight material boundary.
That diagnosis was exact. FoamField B had been allowed to remove up to 92 per
cent of the resolved procedural detail and substantially narrow the unresolved
micro-roughness, while the analytic pattern faded across only the innermost
five per cent of its normalised discriminant.

R7 removes detail damping as a concept, not merely as a tuned-down gain. The
resolved detail gradient, retired high-frequency variance and Cox-Munk
unresolved variance now continue unchanged through the entire hull trail and
Kelvin cone. B still owns its useful wake-specific signals — bubble haze,
ambient-break suppression and aged foam flecks — and the Kelvin solution is
still an additive fragment-normal perturbation, so no physics or displacement
path changed. The obsolete uniform, policy field, lab switch and A/B column
were removed rather than left as no-ops. Evidence format 5 reflects the policy
schema removal while retaining R6's 13-station waterline record.

The exact Kelvin support geometry remains physical, but its rendered amplitude
now hands over across a wavelength-scaled **1.25–3.5 m strip**, broadened only
when the pixel footprint requires it. The ambient detail is never multiplied
by that envelope: it crosses the boundary at full strength and visually mixes
with the dying Kelvin gradient instead of being restored only at the edge.

The live browser check used the shipping wake-trail harness in
`CURRENT_MODERATE` at 3.59 m/s: λ 8.3 m, pattern slope 0.229, wedge 66 m and a
1.49 m physical cusp feather. Fine facets remain legible inside and outside
the cone, the side handoff no longer reads as two water materials, and there
were no shader errors. The clean capture is
`evidence/ship-wake/wake-detail-feather.jpg` (ignored visual evidence, kept
locally). Existing Three shadow-map deprecation warnings are unchanged.

## WK-R8 — an attached bow wave before the Kelvin far field · 2026-08-08

**Status: implemented and live-verified. 55 test files / 746 tests pass,
production build clean.**

Ash correctly read the first exposed Kelvin crests as stern-sourced. The
pattern origin was already the resolved stem, but the stationary-phase
solution is a **far-field** model: its 19.47° cone stays under the widening hull
for much of the waterline, and R7's honest metre-scale cusp feather suppresses
the small remainder. The first strong unobscured crest therefore appeared near
the stern even though the shader's source point was at the bow.

R8 keeps that far-field geometry and adds the missing near-field bow shoulder.
It begins at the live stem, follows a Wigley half-breadth built from the live
stem-to-stern waterline span and active half-beam, separates outboard of the
wetted shell, and fades from 42 to 72 per cent of hull length where it meets
the Kelvin cusp. A raised crest plus weaker outboard trough contributes only a
fragment-normal gradient. At the reference Froude number the crest also feeds
a narrow instantaneous breaking-lip contribution into the existing foam
coverage chain, so it inherits the established breakup, lighting and
anti-aliasing rather than becoming a white stripe. Persistent waterline foam
still owns the history after the hull passes.

This split follows the published hydrodynamics rather than moving the Kelvin
origin until the picture looked right: bow-wave measurements describe a thin
attached sheet that thickens downstream, while matched-asymptotic work treats
the near field as a separate zone from the far-field wave system. A complete
thin-ship model would additionally resolve distributed bow/stern interference;
R8 leaves that later system intact instead of pretending it all originates at
one visible point.

The browser review used `?perf=wake-bow` in `CURRENT_MODERATE` at 3.59 m/s
(λ 8.3 m, slope 0.229). Bow-on and raised three-quarter checks show the
breaking lip attached symmetrically at the stem, curving outboard along both
shoulders, and handing off without a straight boundary or painted band. The
clean capture is `evidence/ship-wake/bow-wave-origin-head-on.jpg` (ignored
visual evidence, kept locally). No shader errors were logged; the existing
Three shadow-map deprecation warning is unchanged. The one-way constraint
still holds: no vertex displacement, WaveField write, buoyancy input or force
path was added.

## WK-R9 — the bow is a finite pressure front, not a cone apex · 2026-08-08

**Status: implemented and live-verified. 56 test files / 750 tests pass,
production build clean.**

Ash's follow-up identified the remaining conceptual error in R8: replacing a
hidden point cone with a point-attached shoulder curve still left the bow's
finite pressure body out of the model. A broad working bow does not radiate its
near field from an infinitesimal apex. The point-source Kelvin construction is
only a far-field asymptotic description; extrapolating it under the hull is not
a visible bow-wave model.

R9 derives a finite source from the already registered 13-station waterline.
The most-forward complete cut supplies the live crown centre and tip span. The
cut two renderer stations aft — about 2.4 m on this waterline — supplies the
actual forward-shoulder centre and breadth. A stable CPU resolver retains a
genuinely wide live tip and, when pitch collapses the last cut almost onto the
stem, keeps the mostly clear-water crown at 58 per cent of the measured
shoulder half-width rather than collapsing back to a point.

The shader joins those measurements with a rounded pressure crest whose centre
stands 0.75–1.15 m ahead of the last wet cut at playable wavelengths and whose
ends sweep aft to the two shoulders. The attached side crests continue from
there and fade into the Kelvin cusp. Breaking coverage is biased toward the
shoulders; the central front remains predominantly water normal/detail, so it
does not become a white bumper bar. The existing foam breakup, lighting and
anti-aliasing remain the only foam rendering path.

The stationary-phase pattern now has an explicit finite-hull authority ramp
from 36 to 68 per cent of live waterline length. Its mathematical point apex is
never rendered: the broad bow front owns the near field, both systems overlap
through the handoff, and the far-field solution owns only the region where its
assumptions are honest. Ocean detail still runs unchanged through every part
of the result.

Live review used `?perf=wake-bow` in `CURRENT_MODERATE` at 3.59 m/s. Bow-on and
raised three-quarter views show the pressure ridge spanning ahead of the bow,
curling into both finite shoulders and feeding the later wake. The foam-off
check confirmed that the white lip belongs to the breaking/collar path while
no hard Kelvin apex or material seam remains underneath it. Clean
captures are `evidence/ship-wake/bow-pressure-front-head-on.jpg` and
`evidence/ship-wake/bow-pressure-front-quarter.jpg` (ignored visual evidence,
kept locally). No shader errors were logged. The one-way constraint remains:
no vertex displacement, WaveField write, buoyancy input or force path changed.

## WK-R10 — review pass on R6–R9, and the marquee · 2026-08-08

**Status: implemented. 57 test files / 763 tests pass, production build clean,
shader compiles with no errors in `?perf=wake-bow`.** Ash's visual acceptance
of the R10 look is still owed; what is claimed here is that the defects below
were real, are gone, and are now pinned by arithmetic rather than by source
text.

R6's midships waterline source stands and was the one unambiguous gain in the
R6–R9 run: before it, a 15.5 m hull fed one stern cut plus loose bow-third
points and generated no attached water from most of either side. The swept
parallelogram distance, the max composition and the bounds guard are all
sound. Everything below is about what R7–R9 did on top of it.

**The bow front was culled at its steepest point.** R9 rejected at a flat
`astern < -1.5`. The crest centre stands `frontLead` (0.909 m at the reference
wavelength) ahead of the tip, so that plane sat 0.94 sigma forward of it —
which is exactly where a Gaussian's slope is maximal. Measured against the
live uniforms, a slope perturbation of 0.272 dropped to zero across one
fragment along a straight transverse line about four metres wide, locked to
the bow, in open water. For scale, `PATTERN_SLOPE_MAX` is 0.3. The guard is
now derived from the crest — `frontLead + frontWidth * 3.5` — and
`tests/bow-near-field.test.ts` asserts the residual slope there is under one
per cent of the crest's peak, and separately records what the old plane was
doing so the regression cannot come back quietly.

**Two white lines straddled the bow.** Ash reported a square-ish foam shape
ahead of the stem: two lines at fixed separation that slid sideways at random.
That was R9's `frontBreakBias`, which ramped the front's breaking coverage to
full strength at 0.88 of the shoulder half-width — where `frontLateral` was
already cutting the front off — producing a narrow high-coverage band on each
side. The lateral slide was the resolved tip cut jumping between hull stations
in pitch, which moves `uShipWakeOrigin` and takes the whole abeam frame with
it. The front now carries no breaking term at all: the sheet breaks where it
separates, at and aft of the shoulders, which is what `shoulderBreak` already
described. The clear-water pressure mound is clear water.

**The near field had no abeam bound.** R8 rejected on `abs(fromCrest)`; R9
deleted that and replaced it with nothing, so four exponentials, a sqrt and
six smoothsteps ran for every ocean fragment inside a 12.4 m band that is
unbounded transversely — at deck height, most of the lower frame. Both axes
are bounded again, matching what `bowMoundGradient` twenty lines above does
and says. GPU cost across R6–R9 remains unmeasured; that is still owed.

**The bow mound and the pressure front were two models of one bump.** R4's
mound sits 0.46 m ahead of the tip with radii 2.10 x 1.13; R9's front sits
0.91 m ahead and spans the same water. R9 landed without retiring it, so both
were summed into the same slope. The mound now stands down wherever the front
is live. Its A/B switch still reaches it when the front is not.

**`crownHalfWidthM` never used the live tip.** R9's note claims the resolver
"retains a genuinely wide live tip". It does not: the most-forward complete cut
is where the hull is narrowest, so `max(tip, 0.58 * shoulder)` takes the floor
every frame — live uniforms give shoulder 2.0558 and crown 1.1923, and
2.0558 * 0.58 = 1.1923 exactly. The arithmetic is unchanged (a bluff hull
genuinely could beat the floor) but the note was wrong and the unit test that
"proved" it used a hand-built 1.8 m tip. Both are corrected.

**The scrolling marquee.** Ash saw foam whose outline stood still while its
shading rolled through it, fast or slow, sometimes reversing, sometimes cut
off by a hard line, and switching between across-the-trail and along-it. That
is the breakup streak frame. The grain direction was interpolated per fragment
between wind and track on the B channel, and the *sample position* was rotated
into it. Rotating a sample moves it by |q| * dtheta, and q here is measured
from the noise lattice origin, so |q| runs to a full 256-cell period: an angle
that swings as B decays over tens of seconds drags the whole pattern sideways
at tens of metres per second, at a rate proportional to |q| — hence fast in
some places, slow in others, and reversing across the wrap. The hard divider
is `clamp(wakeTurbulence * 2.0, 0.0, 0.85)` saturating.

The two frames are now evaluated separately by `foamBreakupNoise` and the
RESULTS are blended. Each frame's pattern is nailed to the water and B only
decides how much of each shows. Open water takes the false side of a branch
that is coherent across whole tiles, so ambient foam pays what it paid before.

This was latent well before this round — the same rotation is in 27f5006 — but
two things exposed it: R5 removed the foam-lookup jitter that had been
shredding the patch outline (so outline and shading no longer moved together),
and R6 put live B over the whole hull length instead of the bow third. Both
were correct changes. Reverting to 27f5006 would hide this rather than fix it.

**The oil-slick / wood-grain marbling.** The second "finer erosion" cut is a
smoothstep of half-width at least 0.16 against noise whose measured standard
deviation is 0.176 — 0.9 sigma. A threshold that wide does not make holes; it
passes about a third of the distribution through a smooth ramp and multiplies
that grey field into the mask. At 12 cm cells it can never be narrower, so
this layer has always been shading rather than erosion, and that smooth
multiplicative field over the coarse islands is the marbling. It now converges
to its analytic mean as the band exceeds the noise's spread, which is what
pre-filtering a threshold actually means. The ramp is kept rather than the
layer deleted, so moving `FINE_RATIO` to a resolvable scale brings a real cut
back automatically instead of silently doing nothing.

**Kelvin mixing — answering the question rather than changing it.** The
pattern is summed, not substituted: `shipWakePatternGradient` is added into
the same `slopeFromGradient(vGradient + swellGrad + detailGrad + ...)` call as
the resolved Gerstner gradient, the residual swell and the procedural detail,
and since R7 the ambient detail runs through the wake at full strength. But it
contributes only a fragment NORMAL. No vertex moves, WaveField is never
written, and `vCompression` — the breaking indicator — is computed in the
vertex stage from the displaced surface alone. So the wake has no height, no
parallax, no silhouette against the horizon, no self-shadowing, and its cusp
line cannot break no matter how steep it gets. The ocean's real waves roll
through it without being deformed by it. That is why it reads as a decal
rather than as water, and no amount of tuning inside the fragment shader
changes it. Making the wake mix properly means giving it a displacement
contribution, which is a WaveField-side change and its own round.

**The foam boundary staircase.** With the hull hidden and the camera directly
above, the whole foam edge was a hard axis-aligned sawtooth locked to the field
texels. That is `smoothTexelUv` at 0.75. R5's own note for that constant says a
full warp "trades the diamond lattice for a grid of 1.5 m plateaus — a
different grid artifact, and a more legible one on a flat sea", and 0.75 turns
out to be on the wrong side of that line: a plateaued field snaps any threshold
laid over it to the texel grid, and the coverage threshold is exactly such a
threshold. A/B'd live at 0.75 / 0.40 / 0 on the wake harness; 0.40 keeps plain
bilinear's organic scallop with no lattice returning, so that is the new
default. Still a lever — `sim.setFoamLookupValues(0, s)` walks it and
`sim.setFoamLookupLegacy(true)` is the exact pre-R5 arm — so this is a
falsifiable default, not a settled taste call.

**On the tests.** The three commits added 246 test lines, 31 of them
`toContain` assertions against Ocean.ts's own source text. Every one still
passed while the bow crest was being cut at its steepest point, because a
source-text assertion cannot see an inequality. `tests/bow-near-field.test.ts`
mirrors the crest profile in JS with the live uniform values and asserts what
the guards actually have to satisfy, in the style `kelvin-pattern.test.ts`
already uses for the stationary-phase solution.

## WK-R10b — the ghost is back, on the level nobody guarded · 2026-08-08

Ash, testing R10: "I'm getting the long streak 100m away issue that we already
fixed before. Like there's a ghost ship 100m away creating its own streak."

Same failure as R5-3, one level out. R5-3 gave the 48 m hull level an edge kill
and left the near and far levels alone, on this argument, which is still in the
file it was written in:

> the near level is 384 m against a trail whose B channel e-folds in about
> 160 m, so anything that comes back around has been multiplied by 2^-9

**Those two numbers are inconsistent.** B's tau is 45 s at the calm setting;
at the 3.59 m/s reference that is a 162 m e-fold, and exp(-384/162) is **9.1
per cent**, not 2^-9's 0.2 per cent. 2^-9 would need a 62 m e-fold. The near
level was left unguarded on a figure roughly forty-five times too small.

Nine per cent was survivable while WK1 injected B from the bow third only. R6
put it along the whole 15.5 m waterline, and `trailFoamFloor` routes B straight
into residual coverage, so nine per cent of the R6 trail is a legible second
wake. The near lookup fades in from 0.443 — 170 m — so the ghost re-enters
unseen at 192 m and then sails INWARD into view, which is why it reads as a
ship pacing you off the beam rather than as a wrap. Ash put it at about 100 m,
which is exactly where it becomes obvious.

R10's fine-cut change is likely to have made it legible sooner rather than
later: converging the sub-pixel erosion to its mean removes the speckle that
was breaking faint distant foam into fragments, so a patch at 9 per cent now
renders as a coherent streak instead of noise. That is the correct behaviour
for the fine cut and the wrong foam to be rendering coherently; the fix belongs
at the source, not in re-hiding it.

**Fix: every level gets a kill band, placed strictly outside its own lookup
fade** — near and hull at (0.45, 0.49) against a 0.443 fade end, far at
(0.462, 0.49) against 0.456. Outside its own fade a level contributes exactly
zero, so the band is free, and it makes recirculation structurally impossible
at any persistence and any injected area. R5-3's closing line — "adding a small
clipmap level to a long-persistence field needs an edge kill, every time" — was
right and should not have been scoped to small levels. `foam-hull-level.test.ts`
now checks the placement rule for all three and carries the survival arithmetic
so the 2^-9 claim cannot come back.

## WK-R10c — the Kelvin far field is off · 2026-08-08

Ash's call, and the code agrees with the verdict rather than only the taste.
`shipWakePatternGradient` is summed into the surface slope alongside the
Gerstner gradient, the residual swell and the detail — it never substituted for
them — but it contributes a fragment NORMAL and nothing else. No vertex moves,
WaveField is never written, and `vCompression` is a vertex-stage quantity, so
the pattern has no height, no parallax, no horizon silhouette, no
self-shadowing, and its cusp cannot break however steep it gets. The sea rolls
through it. It reads as a decal because it is one.

Split rather than deleted. `uShipWakeKelvinStrength` now drives the far field
alone; `uShipWakeStrength` keeps driving the near-field bow pressure front,
which is a different model on a different footing. `wakeKelvinPatternEnabled`
is false by default and `sim.setWakeBowFeatureEnabled('kelvinPattern', true)`
brings it back with no recalibration, since one policy still sets both
amplitudes. The geometry is sound and worth keeping: when the wake gets a
WaveField-side displacement contribution, this is the switch to turn on.

`'wavePattern'` remains the master switch and still governs both, so the bow
front can be taken out independently with
`sim.setWakeBowFeatureEnabled('wavePattern', false)`.

## WK-R11 — the marquee, actually · 2026-08-11

R10 named the marquee and fixed the wrong half of it. Ash reported it again:
the foam's outline stands still while the texture inside it scrolls, in a
smooth oscillation that slowly accelerates, peaks, decelerates and reverses,
and that correlates with no ship DOF he could find — not yaw, roll, pitch or
heave.

**It correlates with none of them because the strongest driver is the wind.**

### The mechanism

Foam has two halves and only one is stored. The outline lives in `FoamField`:
deposited at a seed position, advected with the water, decayed. That half is
correct and has been for several rounds. The *grain* is stored nowhere — it is
`foamBreakupNoise` evaluated per pixel at
`q = mod(vDetail, uDetailWrap) * uDetailFreq`, stretched along a direction so
old foam reads as windrows and trail foam as sheared by the hull.

"Stretch along a direction" is a rotation of `q`, and `q` is measured from the
noise lattice origin — up to a full 256-cell wrap, 614 m at the production
detail scale. So the streak direction is a lever with a 500 m arm: rotating it
by `dtheta` translates the sampled pattern by `|x| * dtheta` metres through
foam that is standing perfectly still. One degree at 500 m is nine metres.

Both frames were live uniforms.

- `uWindDir` is republished every frame from `WorldWind`'s gust process, whose
  direction series is a sum of four sinusoids at 40-240 s and
  `+-DIRECTION_WANDER_DEG * gustiness`. At CURRENT_MODERATE that is a total
  excursion of **3.4 degrees** — invisible in the rig, invisible in the sea
  state — and it alone drags the grain across stationary water at a mean of
  0.37 m/s and a peak of 1.0-1.8 m/s, on the derivative of that sinusoid sum.
  Smoothly accelerating, peaking, decelerating, reversing. That is the
  oscillation, and it belongs to the weather, not the hull.
- `uWakeStreakDir` was published every frame from the instantaneous
  through-water velocity, which yaws with her and wanders with the orbital
  water under her. Faster, confined to the trail.

R10's own note — "Two fixed frames have no such term. Each one's pattern is
nailed to the water" — was true of the blend and false of the frames. Blending
the RESULTS of two moving frames stops the blend being a marquee; it does
nothing about the two marquees being blended. This is the third round to fix an
instance of the same bug, because the rule was never written down:

> **Nothing that scales or rotates `q` may vary at runtime.** Not slowly, not
> by a little. The artifact is proportional to the change, not to its rate, so
> there is no safe speed — filtering makes a marquee permanent instead of
> oscillating, and there is no threshold below which a rotation is free.

### The fix

`scene/foamStreakFrame.ts` holds each frame piecewise constant. A frame changes
only when the live target has left it by a release angle, and then only by
cross-fading two separately evaluated patterns — never by interpolating an
angle, which is the `|q| * dtheta` slide itself. The pending frame is a
snapshot and is never re-aimed mid-fade. The anisotropy (`uFoamStreak`, now
gone) rides inside the frame, because it scales the along axis and a drifting
stretch is a marquee down the frame's own axis.

Release angles are set from the disturbance each frame has to ignore. The wind
frame's 25 degrees clears `WorldWind`'s full 16-degree peak-to-peak wander at
gustiness 1 with margin, so ambient windrows never re-comb on a gust — which is
also right, as windrows follow the mean wind. The wake frame's 12 degrees
clears yaw in a seaway and releases on a genuine course change.

`uWindDir` itself stays live. Its other consumers dot it against a per-pixel
slope (the whitecap bias) or translate by a bounded fetch (the salt haze);
neither has the `|q|` arm. Only the frame is latched.

### Evidence

Debug views 6 and 7 draw the breakup grain alone, everywhere, ignoring
coverage — the instrument this class of bug needed and did not have. With the
camera, the sea and the field all frozen, anything that moves in view 6 is a
live input to a lookup that should have none.

Before: two degrees of wind — less than the sea state's own wander — relocated
the entire pattern. After: the live gust process runs for a minute and the
grain is bit-for-bit still.

### What is still not fixed

`uDetailFreq` / `uDetailWrap` also scale `q`, so a sea-state change still moves
the grain radially. Left live deliberately: they are the sea's texture scale,
shared with every other detail layer, and during a transition the grain moving
with everything else is coherent rather than anomalous.

And the grain is still not a property of the water. One held frame cannot
represent a wake with a bend in it — the whole trail carries the currently
latched course. That is the same accepted lie the live uniform told, now told
stably. Recording a laying direction per texel in `FoamField` is the honest
fix, and it is a `FoamField` round.

## WK-R12 — the three phases and the square edges · 2026-08-11

With the marquee gone Ash could see what was under it: the trail has three
distinct phases, each wider and coarser than the last, with the expansions
happening at fixed distances astern rather than anywhere the water is doing
something. He put them at about one ship length and about ten to twelve.

They are the three clipmap levels, and his distances are the fade edges to
within the reading error of an eye:

| level | extent | resolution | texel  | fade band (from the observer) |
|-------|--------|-----------|--------|-------------------------------|
| hull  | 48 m   | 128       | 0.375 m| 13.7 - 21.3 m  (0.9 - 1.4 LOA)|
| near  | 384 m  | 256       | 1.5 m  | 110 - 170 m    (7.1 - 11 LOA) |
| far   | 1536 m | 128       | 12 m   | 430 - 700 m                   |

Three causes, all separable.

### 1. The footprint compensation was one-dimensional

The injection widens a sub-texel source to `max(r, 0.65 * texel)` so it cannot
fall between texel centres, then scaled the deposit by `r / R`. Widening a disc
is two-dimensional; one ratio compensates one dimension.

What the single ratio preserved was the ribbon's PEAK. The along-track integral
of the widened profile grows with R while its amplitude falls as 1/R, so the
value accumulated at a texel the track crosses came out level-independent —
which reads as "the trail stays as bright" and looks deliberate. Its WIDTH did
not: the ribbon was laid down R wide instead of r wide, and R is the texel. Each
coarser level therefore drew the same trail proportionally wider at the same
brightness. At a 0.6 m source radius the far level was depositing **13x** the
foam area over a 16 m band — the ginormous patch that appeared from nowhere ten
ship lengths astern — and the near level **1.6x**, which is the smaller
expansion a ship length astern.

Squaring the ratio conserves deposited foam AREA across the levels, which is
the invariant that has no shape constant in it: `weight * R^2` is `r^2` at every
level. The hull level's weight is exactly 1 and is unchanged, so the wake as
seen from the ship does not move. Ambient injection never widens and so never
had a footprint weight to correct; the blast radius is the wake alone.

### 2. The level windows were literal squares

`max(off.x, off.y)` is the Chebyshev distance and its iso-lines are
axis-aligned squares, so every level handover was ruled across the sea as a
straight line and the trail changed character along it. That is the "square
outline" around the widened trail and the straight edge on the far patch.
`windowEdge` is now the fourth-power norm: unchanged along the axes, corners
rounded off. Its ball is contained in the old square, so the toroidal wrap is
strictly safer than before rather than merely as safe.

### 3. The hull level's reconstruction has a lattice in it

Bilinear is C0 with a gradient discontinuity at every texel boundary, and a
coverage threshold laid over it snaps to that lattice. At the hull level's
0.375 m texels seen from the rail that is the hard 45-degree sawtooth running
the length of the foam alongside the hull. `smoothTexelUv` was the cheap
approximation of the cure and can only ever trade the lattice against a grid of
plateaus — R10 already found 0.75 was on the wrong side of that trade.

The hull level now takes a four-tap cubic B-spline: C2, no lattice to snap to,
at the cost of about half a texel of softness — 19 cm of sea against a
staircase that reads as a metre. It is affordable because the hull window is
48 m across, so the fetch is now gated and the overwhelming majority of ocean
fragments skip it entirely rather than paying for one unconditional tap. Near
and far keep plain bilinear and the established warp, so the foam-lookup A/B
levers still mean what they meant.

### Not addressed

The hull-to-near handover is still a 4x resolution step and the near-to-far an
8x one. Correcting the deposit stops the trail *expanding* across them, but the
grain necessarily coarsens, and past 170 m the trail is a faint smear rather
than a resolved ribbon. If the mid-distance trail wants to stay legible the
answer is a level sized for it, not more compensation.

## WK-R13 — resolution, because compensation could not fix this · 2026-08-11

R12 stopped the trail *expanding* at the seams. What was left, and what Ash
then reported, was the first seam itself: "that distinct one ship length back
part where the solid wake breaks up into chunks very distinctly".

That break-up is not a fade that is too short. It is the point where the
storage stops being able to say WHERE the foam is and can only say HOW MUCH.

A trail is roughly a 1.2 m ribbon. The hull level's 0.375 m texels resolve it
three across, so the field knows where inside the texel the foam sits and the
shader draws a solid ribbon. The near level's 1.5 m texels swallowed the whole
ribbon, so all the field could record was a coverage fraction — and the
coverage-to-mask threshold, having no idea where in the texel to put it,
scattered that fraction across the texel as noise-shaped chunks. The right
total foam in the wrong arrangement, arriving all at once at the 4x step.

No blend fixes that, because the two levels are describing the ribbon
differently rather than at different sharpness. The lookup's own note — "this
crossfade blends agreeing values at differing sharpness" — stopped being true
the moment R12 made the deposit area-conserving, and was only ever true in the
sense that the levels agreed on brightness while disagreeing on width.

So: resolution.

| level | was | now | texel |
|-------|-----|-----|-------|
| hull | 48 m @ 128 | 96 m @ 256 | 0.375 m, unchanged |
| near | 384 m @ 256 | 384 m @ 512 | 1.5 m -> 0.75 m |
| far | 1536 m @ 128 | unchanged | 12 m |

Three consequences, and the third was not planned:

1. The step between the inner levels is 2x, not 4x, and 0.75 m nearly resolves
   a 1.2 m ribbon — so the near level draws a ribbon rather than counting one.
2. The first handover moves from 13.7-21.3 m (0.9-1.4 LOA) to 27.5-42.5 m
   (1.8-2.7 LOA), blending over 15.1 m instead of 7.5 m. Further astern, over
   twice the distance, where the eye is no longer on it.
3. R12's footprint correction now does nothing at the near level. The widening
   floor is 0.65 texels, which at 0.75 m is 0.49 m, and the stern source radius
   is 0.4-0.72 m — so a typical source is no longer widened there at all and
   the two inner levels agree in amplitude exactly. The coverage step across
   that seam, which R12 had deepened from 38% to 62% while fixing the far one,
   is gone rather than merely reduced. The correction still governs the far
   level and the smallest bow sources.

The old note on `FOAM_HULL_EXTENT` said widening it "would buy trail at the
direct expense of the collar detail it exists for". True only under the
assumption that widening meant spreading the same 128 texels thinner. Doubling
resolution with the window holds 0.375 m exactly.

### Open: this is not measured

The field is about 5.5 MB across six targets, which is nothing. The cost that
matters is the injection pass, and this file's own header names it: it
"evaluates the whole wave sum at every texel — the one place in this system
where resolution costs real time". Texel count across the levels goes from 98k
to 344k, a 3.5x rise on the inject and advect passes, which run at `updateHz`
(24) rather than per frame.

That is a reasoned expectation, not a measurement. **It has not been
benchmarked.** Deferred by Ash to a quiet GPU; run
`npm run perf:revisions -- 3374a13 HEAD --suite representative --rounds 2
--strict-preflight` per `tools/perf/README.md`, with no dev server or browser
competing. If the inject pass turns out to dominate, the near level is the one
to reconsider first — the hull level's rise is small in absolute texels and it
is the one carrying the artifact this round exists for.

---

## WK3 — Spray events and the overtop port · implemented 2026-08-17

**Status: implemented on `claude/coord-wake-wk3`, cut from the nightly
integration branch. 105 test files / 1492 tests green (from 103 / 1456),
production build clean, typecheck clean. Evidence regenerated deliberately —
`contact-baseline.json` moves to format 6 and `spray-events.json` is new.
No performance number is claimed: the machine is thermally throttled and the
measurement is specified rather than taken (§ Performance below).**

WK3 is the last unstarted round of the original plan. WK4 (the Kelvin
keep-or-kill A/B) and WK5 (storm masking and the perf ledger) remain untouched
and unprejudiced by this.

### What an event is

A **tear**, in exactly `CrestSpray`'s sense. It opens the instant the bow's
entry drive crosses a threshold, sheds continuously for as long as she is still
going in, and closes when the drive falls away. It is not a per-frame emission
field and — deliberately — it is not a one-shot burst either.

The one-shot was the tempting design and the crest-spray round already paid for
it: *"the second version emitted each sheet as one instantaneous burst. That
reads as popcorn — discrete puffs going off at random with no relationship to
anything, all with the same duration because they all had the same parameters."*
A bow entry is a moving source with a duration, so it is built as one, and the
shedding rate is re-derived every frame from the live drive. There is no
envelope anywhere in the system.

### What triggers it

The drive is a **power**, not a speed:

    P = ½ · ρ · (dV/dt)⁺ · v²          then    drive = (P / 20 000 W) · wayGate

with `dV/dt` the bow third's immersion rate, `v` its peak wet-contact normal
closing speed, and `wayGate = smoothstep(V, 1.0, 4.7)`. Both kinematic factors
are measured contact facts and the product is zero if either is — which is the
point: the plan asked for the event to be sized by "the actual entry — relative
vertical velocity and the immersed volume rate, not by speed alone".

20 000 W is the `CURRENT_MODERATE` polar reach's own measured p95, so a drive of
1.0 means "as hard as the top 5% of ordinary moderate sailing" — the only
reference in the policy a person can hold in their head.

**Three facts, kept separate, and the third one is load-bearing.** WK0-F1
established that an emitter keyed to `normalEntrySpeedMps` fires at anchor. This
round measured the same anchored case's entry *power*: p95 5 860 W, **peak
22 931 W with a peak immersion rate of 17.0 m³/s** — above the moderate reach's
own p95 of 20 206 W. So the volume-rate term does not rescue the anchor case
either. An anchored hull heaving in a wind sea genuinely *is* displacing water
hard, and only way through the water tells "she is driving her bow in" from "she
is bobbing". That is recorded below as **WK3-F1**.

State machine, entire:

| | |
|---|---|
| closed → open | `drive ≥ arm` and the refractory has expired |
| open → closed | `drive < arm · 0.5`, or the tear has been open 0.5 s |

Hysteresis (the release band) is the whole of the chatter protection; the
refractory is the whole of the rate protection. Nothing else.

### The rate function, and its measured edges

`arm` is the only sea-state term: **0.5 on calm water rising to 1.5 in a gale**,
on `wakePolicy`'s existing `seaMask = smoothstep(W, 0.005, 0.06)`. The 3× ratio
still keeps the rate comparable in moderate water and a gale while the sea's
violence grows around it. The thresholds were lowered after the first embodied
walk-through found no visible bow spray at all.

Measured (`evidence/ship-wake/spray-events.json`, 20 s warm + 60 s at 60 Hz):

| case | V m/s | ° off bow | mask | arm | drive p95 | tears/s | droplets/s |
|---|---:|---:|---:|---:|---:|---:|---:|
| `CURRENT_MODERATE` anchored | 0 | 90 | 0.00 | 0.5 | 0 | **0** | 0 |
| `GLASSY_LONG_SWELL` reach | 0.85 | 90 | 0.00 | 0.5 | 0 | **0** | 0 |
| `CURRENT_MODERATE` reach | 3.29 | 90 | 0.00 | 0.5 | 0.83 | **0.133** | 62.1 |
| `SOUTHERN_OCEAN_ROUGH` reach | 5.24 | 90 | 1.00 | 1.5 | 3.29 | **0.133** | 56.2 |
| `SOUTHERN_OCEAN_ROUGH` running | 5.24 | 135 | 1.00 | 1.5 | 31.04 | **0.283** | 158.0 |

The two reaches land on **exactly the same rate** — one tear every 7.5 seconds
in a moderate breeze and in a Southern Ocean gale alike. Each live tear now
sheds three times the old droplet density and throws it farther outboard and
higher, so the event reads as a substantial bow ejection rather than fine mist.

**Ceilings, and they are reachable rather than decorative.** `1 / 1.5 s = 0.667`
tears per second, and `1 800 × 0.5 / 1.5 = 600` droplets per second sustained.
The heaviest measured sea uses 42.5% of the event ceiling and 26.3% of the
droplet one. The adversarial gate holds the drive at 40× the threshold for a minute and
asserts the rate lands *on* the ceiling and the droplets *on* the bound.

**Monotone**, `CURRENT_MODERATE`, 90 s per point:

| V m/s | 0 | 0.5 | 1 | 1.5 | 2 | 2.5 | 3 | 3.5 | 4 | 4.7 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| drive p95 | 0 | 0 | 0 | 0.023 | 0.088 | 0.225 | 0.532 | 0.770 | 0.989 | 1.538 |
| tears/s | 0 | 0 | 0 | 0 | 0.022 | 0.078 | 0.133 | 0.144 | 0.189 | 0.211 |

Nothing at all below the way onset, then a clean rise. Note the two senses of
monotonicity, because the first version of the exporter gate conflated them and
failed on noise: the rate *function* is monotone and is checked densely on the
drive's p95 (5 400 samples a case); the sampled event *rate* is a realisation of
a stochastic process, and at 40 s it returned counts of 0 and 1 and was not
monotone. The window went to 90 s and the gate now allows a one-event slip while
still requiring the ends to separate.

### Where the spray goes, and why it is not its own system

**Into `CrestSpray`'s existing pool**, via a new `emitBurst(SprayBurstSource)`.
The design left this to the implementing round after reading the class; the
class decides it. That pool already carries the droplet aerodynamics, the
foam-equivalent lighting, the log-depth path, the additive blending, the
emission-disc fade, and the one that settles it — the observer-displacement pass
that makes airborne water stream aft as she advances through the wave field. A
second system would have had to reimplement all six and then be tuned into
agreeing with this one about the same wind. `Spindrift` was deleted for exactly
that reason and is not being rebuilt under another name.

Three things the burst path does differently, all named constants:

- **Its own RNG stream.** Not tidiness. The off/on pair is this project's A/B
  instrument as well as its regression guard, and a burst emitter drawing from
  the sea's stream would shift every subsequent sea droplet — so "hull spray
  off" would not reproduce the build without it. There is a test that asserts
  the sea is bit-identical across the switch.
- **A coarseness bias of 0.75**, moving the size draw from the sea's `u³` toward
  `u^1.2`. This is the single number that decides whether the cue reads as bow
  spray or as fog: a droplet's drag time constant is `vt/g`, so at 100 µm it
  forgets its launch in three frames and simply joins the wind, while at 2 mm it
  holds its throw for a quarter second and falls out. Drawn from the sea's
  spume distribution, a bow burst blows away downwind the instant it is born.
- **Sub-frame birth**, because the curtain lesson applies to any emitter that
  knows the frame rate, and better aerodynamics preserve the artefact rather
  than blurring it.

Aim comes off the contact data and never from a scripted "up and out": the
throw runs along `−relativeWaterVelocity` (her way through the water), the lift
along the water-surface normal, and the outboard component along the stem's own
resolved waterline cut — so one tear is the sheet off *both* bows and the
port/starboard sign is read from `WakeSources`' already-tested classification
rather than reasoned about. `WakeSources` grew `regions.*.immersedVolumeM3` and
a `bowEntry` block to supply this (invariant 2: extend the contract, do not
re-derive beside it).

### The overtop port

`OvertopSpray` is now instantiated by `Schooner`, its group a *sibling* of the
hull in the scene because the events are already in render coordinates.
`resetEffects()` clears it, `activeOvertopSprayCount()` is honest, and
`dispose()` disposes it. Every scale in the class is now the vessel's:

    depth reference = freeboard = 1.696882 m
    speed reference = √(2g · freeboard) = 5.770 m/s

both derived, so a re-loft moves them. The raft passes its own literals
(0.4545 m, 1.818 m/s — the pre-WK3 coefficients' reciprocals) and is
bit-identical apart from the seeded jitter; that grandfathering is recorded in
the class as something to revisit when someone has the raft in front of them,
not as an endorsement.

**Water now has somewhere to arrive.** A puff that falls back to the crown it
came over stops falling, spreads and dies there, so the eye reads water landing
on a deck rather than evaporating in mid-air; and the throw is folded inboard,
because the water's own flow does not know that a sea crossing a rail ends up on
the planking and on a roll can point squarely overboard.

**`Math.random()` is gone, deliberately.** Design invariant 7 permits unseeded
jitter "only where `OvertopSpray` already does", and it did. WK3 spends that
permission in the other direction: the cue is no longer a raft-only ornament but
sits on the vessel every exporter and every capture measures, a seed
reproducing a trace is this project's character, `clear()` now genuinely
restores the initial state, and it cost four lines.

### Findings

#### WK3-F1 — entry *power* fires at anchor too, not just entry speed

WK0-F1's conclusion survives and hardens. Anchored in `CURRENT_MODERATE` the bow
reaches 17.0 m³/s of immersion rate and 22 931 W of entry power, above the
moderate reach's p95. Combining entry speed with immersion rate does not
separate the two states; only way through the water does. The simplification
this buys — a pitching anchored bow throws nothing at all, when in life it
throws water straight up — is deliberate and belongs in design §9's ledger.

#### WK3-F2 — the overtop detector is heading-dominated, not severity-dominated

This is the reason the plan's "longer, more severe" sizing case never worked,
and it is a finding for the physics thread rather than something to fix here.
Sweeping severity at a beam reach:

| sea | Hs (approx) | wind | overtop frames / 7 200 |
|---|---:|---:|---:|
| `MATURE_WIND_SEA` | 3.4 m | 12.5 | 0 |
| `SOUTHERN_OCEAN_ROUGH` | 8.5 m | 18 | 9 |
| `EXTREME_DEBUG` | 14.1 m | 26 | **0** |

Sweeping *heading* in the same sea at the same speed:

| ° off bow | overtop frames / 3 600 | max in one frame | peak depth |
|---:|---:|---:|---:|
| 50 (beating) | 0 | 0 | — |
| 90 (reaching) | 9 | 40 | 0.076 m |
| 135 (running) | **282** | **116** | **1.431 m** |

Thirty-one times the frames and nineteen times the depth, from heading alone.
The severity inversion is probably correct physics rather than a defect — a
longer, higher swell is gentler to a 15.5 m hull than a shorter steeper one, and
steepness is what buries a bow — but it is worth the physics thread's eye, and
it means **sea severity is the wrong axis for sizing overtop and encounter
geometry is the right one**. The committed sizing case is therefore
`SOUTHERN_OCEAN_ROUGH_RUNNING_SIZING` at 135°.

#### WK3-F3 — the raft's strength curve had collapsed her entire range

`min(1, speed·0.55 + depth·2.2)` saturates at about a fifth of her freeboard.
Evaluated on real measurements:

| event | raft curve | freeboard curve |
|---|---:|---:|
| beam-reach peak (0.076 m, 0.859 m/s) | 0.641 — drawn | 0.194 — **not drawn** |
| WK-R-F1 peak (0.151 m, 1.329 m/s) | **1.000** — clamped | 0.319 — a lick |
| running p50 (0.398 m, 1.0 m/s) | 1.000 | 0.408 |
| running peak (1.893 m, 8.10 m/s) | 1.000 | 1.000 |

A 0.15 m lick and a 1.89 m burying were the same picture. The fix is scale, not
silence: her marginal crossings now draw nothing or almost nothing, and the
range between "licked" and "buried" is back. In the committed evidence the beam
reach detects 230 event samples and the cue draws **0** of them; the running
case detects 8 409 and draws 5 877.

#### WK3-F4 — the port made the schooner unconstructible headlessly

`OvertopSpray` called `document.createElement('canvas')` at construction. The
raft is built by no headless test, so this never mattered; the schooner is built
by four, and all four broke the moment the port landed. Guarded — the puffs
still fly, land and count without a texture, so everything about the cue that is
arithmetic stays testable. Worth knowing generally: **putting an existing
raft-era effect on the schooner is a test-environment change as well as a visual
one.**

#### WK3-F5 — the inboard fold was a no-op in the only case it existed for

The first version added `bias · inboard` to the unit flow and renormalised.
`(1,0) + 0.7·(−1,0)` is `(0.3,0)`, which normalises straight back to `(1,0)` —
so a wash heading squarely overboard, the exact case the fold was built for, was
the one case it could not turn. Interpolating between the two directions before
normalising cannot do that. Found by the port/starboard sign test, which is the
third time in this thread rule 5 has earned its place.

#### WK3-F6 — the tear state machine locked up under a pinned drive

An earlier draft carried a separate `armed` flag that only cleared when the
drive fell below the release. The adversarial ceiling gate found what that
costs: the duration cap closed the first tear, the drive never fell, the flag
never cleared, and the cue died silently for the remainder of the run while she
was still burying her bow. The flag was also redundant — chatter protection is
the release band's job and rate protection is the refractory's. Two states, two
rules. **The gate that found this is the one the round briefing asked for; it
found a real bug on its first run rather than confirming a bound.**

#### WK3-F7 — two systems draw airborne water and disagree about blending

Not fixed; it needs Ash's eye. `CrestSpray` is additive, with a comment: *"the
moment the backdrop is brighter than the sprite — any twilight sky — the spray
renders as dark clumps streaking past. Birds, not water."* `OvertopSpray` is
`NormalBlending`, with a comment: *"Sea foam is lit by the sky, not emissive; a
plain blend keeps it from glowing at night."* Both arguments are locally sound
— additive stacking needs many thin sprites and the overtop cue draws a handful
of large ones — but the dark-clumps failure applies to the overtop puffs too,
and nobody has ever looked at them against a sunset, because until this round
they only existed on the raft. **Check the overtop cue at twilight before
trusting it.**

#### WK3-F8 — the contact baseline's polar moved again, independently of WK3

The regeneration in this commit carries two unrelated changes and they must not
be confused. WK3 added the `sprayEvents` and `overtopping.cue` blocks (format 5
→ 6). Separately, the integration branch's sail work moved the solved polar:
`CURRENT_MODERATE` 3.719727 → 3.694336 m/s with leeway 1.0156° → 1.1719° and
balance rudder +0.2734° → −0.2734°; `SOUTHERN_OCEAN_ROUGH` leeway 1.1719° →
1.3281° at an unchanged 5.4209 m/s. Every entry-speed statistic in the baseline
moves with it — bow p95 at the moderate reach goes 0.873 → 1.207 m/s. This is
the plan's own warning arriving on schedule; the regeneration is deliberate and
this paragraph is the "say so in the handover" it asks for.

#### WK3-F9 — `OCEAN_CREST_SPRAY_REPORT.md`'s parameter table is stale

The round briefing sends the next implementer to that report to size spray
against. Three of its rows no longer describe the code: `SHEET_OPACITY` 0.11 is
now `SPRAY_OPACITY` **0.0385** (renamed *and* re-tuned — a factor of 2.9, so
anyone sizing against the report is wrong by that much); `SHEET_SUN_GAIN` 0.30
is now `SPRAY_SUN_GAIN` 0.3, renamed only; and `SHED_PERIOD_FRACTION` no longer
exists at all, removed by the same rewrite that made tears have no scripted
duration. WK3 sized against the live constants. The report has not been edited —
that is a documentation round's call, not this one's.

### What was gated

- **No events at rest.** Both as policy arithmetic (way gate exactly 0, so the
  product is annihilated rather than shrunk) and against the real contact model
  in `CURRENT_MODERATE` at anchor — the state WK0 proved false-fires an
  entry-speed emitter. The test also asserts the bow *was* working while nothing
  fired, so it cannot pass on a becalmed sea.
- **No events on a glassy swell under way.**
- **Bounded in a storm.** The rate ceiling and the sustained droplet ceiling are
  both asserted against the measured cases and against an adversarial run with
  the drive pinned at 40× the threshold, where the rate must land *on* the
  ceiling.
- **Monotone.** In all three drive inputs analytically; in the arm threshold
  against sea energy; in the shed rate against drive; and empirically across the
  ten-point speed sweep, in the exporter.
- **Deterministic.** Same seed and sea produce an identical `sprayEvents` block;
  both new random streams are seeded xorshift; `clear()` restores them.
- **Nothing written to physics.** Asserted directly: twenty detector frames
  leave the whole `WakeSources` output graph byte-identical. The detector holds
  no reference to the body, the wave field or canonical state.
- **The off state is clean.** The sea's spray is bit-identical with the burst
  source disabled, and the `entrySpray` toggle resets the detector so a tear
  cannot resume mid-plunge.

### Performance — specified, not measured

**No number is claimed.** The machine is thermally throttled; Ash runs a cold
pass separately. WK3's plan slice is ≤ 0.3 ms including particle draw. What to
measure, in priority order:

1. **The overtop cue's draw calls.** This is the only part of WK3 that can
   plausibly cost anything: 36 sprites each carrying a cloned `SpriteMaterial`,
   so up to 36 extra draw calls while a wash is on screen. It is only ever on in
   the running-sizing state, but that is also the state with the most going on.
   Measure `activeOvertopSprayCount()` at peak in
   `SOUTHERN_OCEAN_ROUGH_RUNNING_SIZING` and the paired off/on there, not on a
   beam reach where the cue never draws at all.
2. **The `entrySpray` off/on pair** at the same running state. The expectation
   is near zero and the measurement should *confirm* that rather than discover
   it: the CPU cost is one extra region sum in `WakeSources` plus one detector
   update per frame, and the heaviest reference costs 158 droplets/s living under two
   seconds — at most about 316 extra instances against a 16 384 pool that is already
   drawing thousands in that sea.
3. Both by the paired-interleaved-blocks method in `docs/ocean/OCEAN_PERF_HANDOVER.md`,
   against the WK0 baseline, with no dev server or browser competing.

### The ghost streak

Untouched, and I did not chase it. For the record of what it can and cannot be:
WK3 adds no foam injection, reads no foam texture, changes no ocean shader code,
and moves nothing in the lookup or the clipmap. Its only shared mutable state
with anything the ghost lives in is `CrestSpray`'s ring-buffer cursor — with
hull spray on, sea droplets land in different slots — and no slot-dependent
artefact is known. If the streak changes appearance after this lands, that is
information, but nothing here predicts it.

### What Ash should watch, and in which sea states

The round's real gate is the **rhythm**, and I cannot supply it. Two states:

**Moderate** — `CURRENT_MODERATE`, polar reach ≈ 3.3 m/s, embodied camera
forward on the foredeck. Expect **one tear roughly every 7–8 seconds**. The
question is the plan's: do events land when the bow visibly plunges, and *only*
then? The Ocean Lab's new `entry drive X of Y` line is the instrument for
answering it in the moment.
- A burst when the bow was not visibly going in ⇒ the drive is measuring the
  wrong thing, and the immersion-rate term is the suspect.
- A hard visible plunge with nothing fired ⇒ `SPRAY_ARM_DRIVE_CALM` (0.5) is
  too high.

**Storm** — `SOUTHERN_OCEAN_ROUGH`, working sail, ≈ 5.2 m/s. Same 0.133/s by
construction. The question is whether the hull's own spray still reads as *the
ship's* against the sea's own spume, or is simply lost in it.
- Lost ⇒ lower `SPRAY_ARM_DRIVE_ROUGH` from 1.5 (more events) or lower the
  0.25 sea-visibility coefficient in `sizeWakeSprayBurst` (denser events).
- Competing with the sea ⇒ 1.5 goes up.

**Those two numbers are the physical event dials, and their ratio is a third.**
The Ocean Lab now also exposes `Bow-entry spray density` from ×0 to ×4. That
control changes only water shed by a real bow event; it cannot manufacture an
event, move it aft, or change the physical timing.

**Storm running** — 135° off the bow in the same sea. This is the *only* state
in which the overtop cue draws at all, and both of its new behaviours are
unreviewed: does the water read as arriving on the deck, and does the inboard
fold look like water coming aboard rather than being blown across her?

**Live browser verdict, 2026-08-17.** With independent
`SOUTHERN_OCEAN_ROUGH`, storm wind, roughly 5 m/s through the water, and the
shipping density of ×1, a measured bow-entry event (`entry drive 102.93`,
`SHEDDING`) produced a large white tear that visibly cleared the bow at the
plunge. It no longer disappears into the sea's own whitewater. This accepts the
bow-ejection readability question; it does not accept the separate overtop cue
or its inboard fold.

**One more, at night.** The overtop puffs are alpha-blended (WK3-F7). Look at
them against a twilight sky before trusting them; the crest-spray round
concluded that exact combination reads as dark clumps.

Two secondary A/Bs if something looks wrong: **coarseness 0.82** decides arcing
spray versus fog, and **`puffScaleM` 2.6** is a first guess at what a puff should
measure beside a 15.5 m schooner — neither has been seen by anyone.
