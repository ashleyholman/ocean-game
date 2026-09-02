# Wake and water effects — project plan

**Status: execution authority accompanying `docs/wake/WAKE_WATER_DESIGN.md`,
2026-08-06. WK0–WK2 are implemented; WK0's pre-thread baseline is captured and
the strengthened WK1 and incremental WK2 GPU gates both pass on the merged
desktop code. On 2026-08-07 Ash directed the combined wake on by default, then
rejected the look under sail; the WK-R recovery round
(`docs/wake/WAKE_WATER_HANDOVER.md`, final section) fixed the trail-destroying advection
resample, recalibrated deposits, added registration/structure, and built WK4's
pattern early — the WK4 pre-build gate is therefore spent; what remains of it
is Ash's keep/kill-and-calibrate at the WK-R A/B. WK3 (spray events and the
overtop port) is unchanged and still ahead.** Read the design doc first; this document only
sequences it. Rounds are prefixed **WK** (WK0–WK5) to avoid colliding with
the sailing thread's S-rounds and its finding labels (W1 is taken).

Baseline: **S1–S4 merged** — she sails and steers under force, and S4's live
trim landed under WK-R. WK0–WK1 read nothing S3-specific and could start
against S2 if scheduling demands it, but the plan assumes steering exists so
turning wakes can be seen and judged. Note for every later round: this
thread's exporter *solves* the captive polar rather than reading a table, so
any S-round that changes sail aero or trim moves every wake number sampled at
those speeds. Regenerate the baseline deliberately after such a merge, and say
so in the handover.

Each round is a self-contained checkpoint in the established style: headless
evidence + deterministic gates first, Ash's eyes before merge, a handover
note at the end. WK0–WK2 now have implementation records in the handover. WK4
has a decision gate *before* build, not after.

---

## 0. Rules for every round (implementer briefing)

An implementation session starting cold reads, in order:
`docs/wake/WAKE_WATER_DESIGN.md` → this file's round section → the file-map row it
touches → the handover of the round before it. For substrate context:
`docs/ship/SHIP_MOTION_PHYSICS_HANDOVER.md` §Phase 3 (the contact contract),
`src/scene/FoamField.ts`'s header comment (the parameter-space trick — read
it until it is obvious), and `docs/ocean/OCEAN_CREST_SPRAY_REPORT.md` (the two paid-for
spray lessons).

Non-negotiables, beyond the design doc's invariants (§3, all binding):

1. **Run `npm test` before touching anything**; do not trust stale test
   counts in docs. Regenerate evidence only when your change intends it, and
   commit changed evidence *with* the code that changed it.
2. **Do not touch** hull coefficients, the mass model, damping, the wave
   field's evaluation or phase, sea presets, the foam field's existing R/G
   behaviour at zero hull speed, or anything in the sailing thread's S-round
   files — unless the round explicitly says so.
3. **No forces.** If you find yourself writing to vessel dynamics or
   `CanonicalWorldState`, you have left this project's territory.
4. **Every visible thing gets a lab toggle the day it is born.** The off/on
   pair is simultaneously the perf measurement, the A/B instrument and the
   regression guard. No toggle, no merge.
5. **Signs are set by test, not by reasoning** — the day they are born.
   Course-vs-heading (leeway), port/starboard waterline sides, throw
   directions from relative flow: each gets a pinned test. Model +x = port;
   `hullForm.ts` is the authority.
6. **Determinism.** Seeded processes in anything evidence touches; no
   `Date.now()`/`Math.random()` there. Fixed 240 Hz physics; effects read,
   never step, the simulation.
7. **Anything visible needs Ash** at the reference states (design §5) before
   merge. Screenshot discipline: hard-reload before trusting a capture, and
   assert shader defines/toggles in the capture metadata — this codebase has
   been burned by screenshots of the wrong build.
8. **Surface findings in full.** Out-of-scope discoveries go in the handover.
   Ash decides scope, not the implementer.
9. **Perf off/on pair in every round** that adds GPU work, by the
   paired-interleaved-blocks method (`docs/ocean/OCEAN_PERF_HANDOVER.md`), against the
   round's slice of the 1.5 ms budget (design §7). Report the numbers in the
   handover even when they pass.

Known adjacent debt, *not* to be silently fixed in passing (report if
touched): `Schooner.resetEffects()` is empty; the raft still owns the only
`OvertopSpray` instance; `Vessel.activeOvertopSprayCount()` exists mostly for
one lab readout line.

### Cross-thread coordination (this is a parallel thread — respect the lanes)

The sailing thread (S4–S7) runs concurrently. Files both threads will touch:
`src/main.ts` (wiring), `src/vessel/schooner/Schooner.ts` (WK3's overtop
port; S4's moving rig), `src/debug/SchoonerViewer.ts` (lab panels). Rules:

- WK changes to shared files are **additive and minimal** — new call sites,
  no reshaping of existing flow. Anything structural goes in new files.
- Rebase onto master at round start; if an S-round has landed since the WK
  branch cut, re-run the full test suite *and* the perf pair before claiming
  either.
- Visual A/Bs state which S-round baseline they were captured against. S4
  changes what the ship looks like; a wake A/B taken across that boundary is
  not an A/B.

---

## WK0 — Instrumentation and baseline

**Goal:** measure the sources before building anything they feed; zero
visible change.

**Build**
- `src/vessel/WakeSources.ts`: condense the contact buffer into the source
  set (stern waterline segment, bow waterline points, per-region mean/peak
  entry speeds, active event list) per design §4.1. Pure, allocation-free,
  unit-tested against hand-built contact fixtures.
- `tools/export-ship-wake.mjs` + `npm run ship:wake` →
  `evidence/ship-wake/contact-baseline.json`: seeded runs, three reference
  states × that state's polar speed (plus zero speed), recording
  waterline-crossing rates, entry-speed distributions, overtop counts,
  source values over time. This is the sizing data for every later round.
- Lab: a wake panel skeleton in `OceanLab`/`SchoonerViewer` showing live
  source values; master toggle plumbing (off by default, nothing to show yet).
- Perf: capture the pre-thread baseline with the headless method and commit
  it to the evidence directory — the number every later off/on pair is
  honest against.

**Gates:** production pixel-identical (the one self-certifiable claim);
deterministic exporter (two runs, identical JSON); full suite green.
**Ash checkpoint:** none required — nothing visible. Handover note only.

---

## WK1 — The trail

**Goal:** the flagship round. She leaves a wake: white water at the stern
that streams astern, decays into a smoothed pale band, curves through tacks,
and shows leeway. Design §4.2–4.3.

**Build**
- `FoamField`: B channel = hull turbulence; hull-source uniforms in the
  inject pass (stern segment + strengths from policy); `uDecay` vec2 → vec3;
  verify blend state and alpha handling against the third channel by test,
  not assumption.
- `Ocean` shader: smooth band (detail-octave damping + micro-normal
  flattening ∝ B), pale bubble haze albedo term, ambient whitecap suppression
  in the band. Each behind its own toggle for the A/B.
- `src/scene/wakePolicy.ts`: the speed/sea-state/wind scaling (design §5),
  stern terms only this round.
- Stern R/G foam injection (the white component) sharing the same uniforms.
- Wiring in `main.ts`: sources → policy → foam options, additive.

**Evidence & gates**
- Contract tests: zero injection at zero speed; trail direction follows the
  course vector under an imposed leeway case (sign test); B decay exactness
  at arbitrary step; existing foam behaviour bit-identical with the master
  toggle off.
- Exporter grows an injection-record section; regenerate deliberately.
- Perf pair: ≤ 0.6 ms slice.
- `wakeContactSheet.ts` first version: pinned camera, reference states,
  toggle combinations.

**Ash checkpoint (blocking):** A/B at the three reference states, cinematic
and embodied, including a tack under steering — the trail's curve through it
is the point of assuming S3. Calibrate the §5 perceptual targets; write the
accepted numbers into `wakePolicy.ts` comments.

**Risks:** the blend-state assumption (found early by the bit-identical
test); trail readability at 24 Hz injection against a 3.35 m/s ship (a
texel is 1.5 m — the stern moves ~2 texels per sim step; if stepping shows,
the fix is segment-injection along the per-step track, still in the same
pass).

---

## WK2 — The bow and the waterline

**Goal:** the bow wave's foam collar and the wet hull, continuous effects
completing the at-speed picture. Design §4.2 (bow terms), §4.3.

**Build**
- Bow-point R/G (and a little B) injection, onset/saturation per policy;
  collar torn downwind at `CrestSpray`'s coupling.
- Wet band on the hull material near the actual waterline contacts (darkened
  albedo/raised gloss ribbon above the resolved waterline, fed from
  `WakeSources`, not from design draught) — the sea finally acknowledges the
  solid body from the hull's side too.
- Optional candidate behind its own toggle: a small analytic bow-mound
  normal perturbation at the stem. Ash may kill it at the checkpoint; built
  so removal is one block.

**Evidence & gates:** collar strength curve exported; wet-band height tracks
resolved waterline in a pitching seeded run (test); perf pair ≤ 0.2 ms;
sheet updated. **Ash checkpoint (blocking):** embodied camera leads this one
— the deck view is where the collar and wet hull live.

---

## WK3 — Spray events and the overtop port

**Goal:** episodic water: entry spray when the bow drives into a crest;
overtopping acknowledged on the schooner. Design §4.4.

**Build**
- Entry-spray emission from bow-region `normalEntrySpeedMps` threshold
  crossings, throw from relative flow + surface normal, droplet aerodynamics
  and foam-consistent lighting per invariant 6. First choice: feed
  `CrestSpray`'s existing pool as a second source; own points system only if
  its schedule genuinely cannot take a hull source — decide after reading
  the class, record the reasoning in the handover.
- Overtop port: instantiate `OvertopSpray` for the schooner, retune
  `strength()` for her freeboard, make `activeOvertopSprayCount()` honest,
  empty `resetEffects()` fixed. **WK0-F2 constraint:** the four WK0 reference
  runs recorded *zero* overtop events, including Southern rough at 5.29 m/s,
  so the baseline cannot size `strength()`. Build a dedicated deterministic
  sizing case first — longer, more severe, or heading-targeted until the
  detector genuinely fires — committed as an intentional evidence extension
  beside `contact-baseline.json`, never as a silent change to it. Do not
  retune the physics-owned overtop detector to make events appear; if it
  seems wrong, that is a finding for the physics thread (rule 8).
  **Updated 2026-08-08 (WK-R-F1):** after the S4 merge the Southern reference
  *does* fire — 334 event samples across 11 frames, peak depth 0.151 m —
  because the trim-to-draw polar solves to a faster, less-leeway operating
  point. Both changes are needed; neither alone fires it. WK0-F2's "no
  reference run overtops" is therefore spent, but 11 marginal frames in 60 s
  are a floor, not a calibration set: still build the dedicated heavier
  sizing case.
- Policy: thresholds rise with ambient sea energy (storm = punctuation, not
  fountain). **WK0-F1 constraint:** wave orbital motion alone gives the
  anchored bow a 0.675 m/s p95 (1.595 m/s max) `normalEntrySpeedMps`, so an
  emitter keyed to entry speed alone fires at anchor. The event trigger must
  combine entry speed with speed through water — two separate facts, per the
  WK1 policy's zero-speed rule — and the no-emission-at-anchor gate below is
  the test that enforces it.

**Evidence & gates:** event-rate table (threshold × reference state) from
the exporter plus the new sizing case, sanity-checked against WK0
distributions; no emission at anchor in calm *and* in `CURRENT_MODERATE`
(test — the moderate case is the one WK0-F1 proves can false-fire); perf
pair ≤ 0.3 ms including particle draw.
**Ash checkpoint (blocking):** moderate + storm states; the question is
rhythm — do events land when the bow visibly plunges, and only then.

---

## WK4 — The pattern (decision gate first)

**Gate, before any build:** with WK1–WK3 aboard, Ash looks at the ship at
speed on quiet water and decides whether the Kelvin pattern earns its shader
cost (design §2 argues it is subtle at her Froude numbers; design §10.2
gives it ~50%). No is a completed round: record the decision in the
handover and close.

**If built:** analytic hull-frame transverse + divergent block in the ocean
fragment shader, normals only; `λ = 2πV²/g` by test; fades with ambient
energy and turn rate; own toggle; ≤ 0.3 ms; A/B on glassy water where it
lives or dies. Removal stays one shader block by construction.

---

## WK5 — Weather, night, mobile, and the ledger

**Goal:** integration polish and closing the books. No new systems.

**Build**
- Storm masking final pass with the violence work's states — shared look
  review so hull effects and sea violence compose rather than compete.
- Night check: trail under moon and lamp (should be free via foam lighting —
  verify, don't assume); embodied lamp-on-wake capture for the record.
- Mobile: caps and defaults per design §7; verify on the mobile quality path.
- Final perf ledger: cumulative off/on against the WK0 baseline, all
  subsystems, committed to evidence. If over 1.5 ms, the compressible items
  are named in design §10.3 — cutting is Ash's call, made on numbers.
- Handover note for the thread: what exists, what was accepted at each A/B,
  the documented lies (design §9), and what a future water-on-deck or
  slamming-physics round would re-point at.

**Gates:** full suite green; production build; every toggle default-on state
agreed with Ash; evidence regenerated once, deliberately, as the thread's
closing state.

---

## Deferred, deliberately (and where the hooks are)

- **Slamming forces, green-water loads, shipped-water mass** — motion
  physics thread Phase 4. Our cues key off contact kinematics; re-point at
  physics events when they exist.
- **Wake–wave interaction** (trail damping incoming waves) — presentation
  ledger item 2; would need surface authority we refuse on principle.
- **Current/leeway decomposition** — when physics distinguishes speed
  through water from speed over ground, `wakePolicy` swaps its input in one
  place (design §4.1).
- **Crew-visible effects** (spray on sails, wet deck from spray) — S-thread
  and deck-furnishing territory; note as findings if the A/Bs make them
  conspicuous by absence.
