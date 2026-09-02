# Sound round handover

**Status:** foundation built, unheard
**Date:** 2026-08-17
**Branch:** `claude/coord-sound-round` (from `master` `ba087c1`)

The game's entire audio surface was 143 lines: a wash on two sinusoids, a hiss,
a pink-ish noise buffer built with `Math.random()`, and one master gain — driven
by `wind.sail`, a raft-era boolean meaning "is the sail up". This round replaces
that with a listener, six voices driven by canonical state, deterministic noise,
closure-driven muffling below decks, and a dev-shell bench for taking the mix
apart.

**Nobody has heard any of it.** Every mapping is gated by test; not one of them
is gated by ear, and the ear is the only authority that matters here. §9 is the
listening list.

---

## 1. What the old code could not say

Worth stating plainly, because it explains most of the design:

| The simulation knew | The sound said |
|---|---|
| Eight sails, live trim, per-sail angle of attack | one boolean: sail up or down |
| Apparent wind at the hull, gusting deterministically | nothing — the hiss keyed off the boolean |
| Significant wave height from a resolved spectrum | a 46-second sine plus a 103-second sine |
| Whitecap coverage calibrated against Monahan | nothing |
| Speed through the water from the resistance model | nothing |
| Roll and pitch rates from the buoyant body | nothing |
| Five rooms below decks and a closure table | nothing |
| Two camera modes, 1400 m apart | nothing — there was no listener |

The sinusoidal wash is the one worth dwelling on. It breathed on two periods
that exist nowhere in the physics, so the sea *sounded* like it was doing
something while doing something else. A wash driven by `WaveField.significantHeight`
breathes too — but it breathes because the sea does.

---

## 2. Architecture

```text
ProductionSimulationRuntime.prepareScenePhase
  └── ambience.update(frameSeaState, frameAmbientWhitecapCoverage)
        │
        ├── SoundSampler.sample(...)   reads canonical state → SoundWorldState
        │     ├── CameraSystem          camera position, mode
        │     ├── VesselRuntime         readAcoustics(), bowWorld, cameraAnchor
        │     ├── WaveField             significantHeight, dominantPeriod
        │     ├── isClosureOpen(...)    the closure table, unmediated
        │     └── lightRoomAt(...)      the interior lighting's own room lookup
        │
        ├── resolveVoices(state, trims, levels)     PURE. No AudioContext.
        │     ├── soundMapping.ts       every curve
        │     ├── interiorAcoustics.ts  room + closures → muffling
        │     └── SoundMixer.ts         live trims, solo, mute
        │
        └── SoundGraph.apply(levels)    thin Web Audio writes; no-op with no context
```

Files, all new except the last three:

| File | Owns |
|---|---|
| `src/audio/noise.ts` | The seeded PRNG and the noise buffer. No `AudioContext`. |
| `src/audio/soundState.ts` | `SoundWorldState` — everything audio may depend on. |
| `src/audio/soundMapping.ts` | Every state→gain/cutoff/rate curve. Pure. |
| `src/audio/interiorAcoustics.ts` | Room + closures → muffling. Pure. |
| `src/audio/SoundMixer.ts` | Trims, solo, mute. Imports nothing. |
| `src/audio/SoundSampler.ts` | The single boundary where audio reads the world. |
| `src/audio/SoundGraph.ts` | Web Audio wiring. Contains no policy. |
| `src/audio/Ambience.ts` | Façade. Four lines of its own logic. |
| `src/debug/SoundPanel.ts` | The A/B bench. |
| `src/vessel/schooner/sailAero.ts` | **+ `sailShakeFraction`** — see §6. |
| `src/runtime/VesselRuntime.ts` | **+ `readAcoustics()`, `bowWorld`** |
| `src/runtime/RuntimeUi.ts` | **+ the sound panel entry** |

The split that matters: **the mapping is pure and the graph is thin.** Every
number that decides what the game sounds like lives in functions with no
`AudioContext` in scope, so the whole design is testable in node and `SoundGraph`
can be rewritten — or replaced with a different audio backend entirely — without
touching a single decision.

---

## 3. The listener

### Mode is not the lever; position is

The brief asked how distance and mode map to what is audible. The answer this
round arrived at is that **mode is not used as a lever at all**, and that turns
out to be the better design rather than a shortcut.

The camera has two modes: cinematic, which pulls back to as much as 1400 m, and
embodied, at the observer's eyes. But the listener is placed by the camera's
*position*, and the room it is in is resolved from that position through the
vessel's inverse transform. So:

- the cinematic camera hears no deck because it is 45–1400 m away, not because
  it is called "cinematic";
- the embodied camera hears the ship because it is aboard;
- a transition between them is continuous, with no branch to cross;
- flying the cinematic camera down into the cabin would muffle correctly, and
  needed no code to make that true.

`state.mode` is still sampled and shown in the panel, because it is useful to
read. Nothing keys off it.

### The sea is a field; the ship is a source

This is the round's central acoustic decision.

**Ship voices** (rigging, cloth, bow, hull) pass through `shipAudibility(distance)`:
inverse-distance in amplitude — the right law for a source radiating into a
half-space — tapered to reach *exactly* zero at 600 m.

```
shipAudibility(d) = 1                                      d ≤ 12 m
                  = (12/d) · (1 − smoothstep(d; 300, 600)) 12 < d < 600 m
                  = 0                                      d ≥ 600 m
```

**Sea voices** (swell, breakers) do not pass through it at all. The sea is not
a thing you can back away from: it is under the camera at 1400 m exactly as
much as it is under your feet on deck. Attenuating it with distance-from-the-ship
would be a category error that merely happens to sound like a fade-out.

The consequence is the good one: **pulling the camera back does not make the
world go quiet — it makes the ship go quiet and leaves you with the sea.**

The distances are chosen against the camera's own authored zoom knots
(12 / 25 / 45 / 130 / 330 / 750 / 1400 m). The ship fades over the 330→750
stretch and is gone before the top two compositions; the default opening
composition at 45 m still carries her at about four fifths.

### Orientation

One voice is spatialised: the bow. `bowPan = sin(bearing)` — full right at 90°,
centre dead ahead and, correctly, centre dead astern, because two ears cannot
tell front from back either.

Only the bow, because only the bow *is* somewhere. The rig is directly overhead
from every point on a 15.5 m deck, the sea is on all sides, and the hull is the
floor. Spatialising those would be motion without information.

The bearing is derived from the listener's **heading**, not its right-hand axis,
which makes it immune to camera roll. The embodied camera inherits a share of
the vessel's roll; a pan that swung with it would put the bow wave in your left
ear at the bottom of every roll. Tilting your head does not move the bow.

---

## 4. The six voices and their curves

Every gain lands in [0, 1] before trims. Every curve is continuous, monotonic in
the direction the world is, and defined at both edges of every input.

Nearly all of them are `x / (x + k)` — zero at zero, strictly increasing,
asymptotic to one, with one legible parameter: **`k` is the input at which you
hear half of this**. Every `*_HALF` constant below is therefore a number that can
be argued with, which a curve fitted to nothing is not.

| Voice | Driven by | Curve | Half at |
|---|---|---|---|
| `swell` | `WaveField.significantHeight` | `0.06 + 0.94·sat(Hs, 2.4)` | Hs = 2.4 m |
| | `WaveField.dominantPeriod` | cutoff `105 + 325/(1 + T/5)` Hz | — |
| `breakers` | `whitecapCoverage` × `min(generation, 1.5)` | `sat(W·g, 0.03)` | W = 3 % |
| | same | centre `900 → 2100` Hz with drive | — |
| `rigging` | **apparent** wind at the hull | `sat(Va², 90)` | Va = 9.5 m/s |
| | same | centre `240 + 46·Va` Hz, capped 1800 | — |
| `cloth` | `shakingClothAreaM2` | `sat(A, 20)` | A = 20 m² |
| | apparent wind | slat `0.6 + 0.12·Va` Hz, capped 5 | — |
| `bow` | speed **through the water** | `sat(V², 6)` | V = 2.45 m/s |
| | same | centre `500 + 90·V` Hz | — |
| `hull` | \|rollRate\| + \|pitchRate\| | `sat(ω, 0.22)` | ω = 0.22 rad/s |

Notes on the choices that are not obvious:

- **The swell has a floor of 0.06 and never reaches zero.** A dead flat calm is
  not silent; there is always some slop against the topsides. Setting it to zero
  makes the calm presets sound like a bug rather than a calm.
- **The rigging is squared and keys off *apparent* wind.** Squared because the
  noise a cylinder sheds goes with dynamic pressure, and because the ear's
  complaint about a linear wind curve is that a fresh breeze and a gale sound
  alike. Apparent because a schooner running before a gale has a quiet rig and a
  true-wind hiss would get that exactly backwards. `hullApparentSpeedMps` is
  built on the deterministic instantaneous wind, so **the gusts arrive for free
  and no gust process is duplicated.**
- **The breakers read the ocean phase's own coverage.** Not a second Monahan
  evaluation — the exact float the foam field was scaled by, passed down from
  `ProductionSimulationRuntime`, clamped by the same `min(generation, 1.5)` the
  ocean applies to its statistical far field. This is pinned by test at
  *identity*, not equality.
- **The bow reads `meanRelativeForwardWaterSpeedMps`** from the resistance
  model — speed through the water, not over the ground and not the
  voyage-compressed distance made good. Those differ in a current and the honest
  number for a bow wave is the first.
- **The hull is driven by roll *rate*, not roll angle.** A hull heeled steadily
  to fifteen degrees on a reach is silent; a hull rolling through five is not.
  It is the movement that loads and unloads the fastenings.

---

## 5. Below decks

The interior spaces and their closures already exist and are already read by
four systems. Audio makes it five, and reuses the same `isClosureOpen` — there
is no second notion of "is it open" anywhere in `src/audio/`.

Openness per room, 0 = sealed, 1 = standing on deck:

| Room | Base | With its closure open | Gated by |
|---|---|---|---|
| `landing` | 0.62 | — | *nothing — the companionway has no door* |
| `wardroom` | 0.44 | — | — (the hatchway grating never shuts) |
| `cabin` | 0.24 | — | — (stern windows do not open) |
| `forecastle` | 0.20 | 0.58 | `foreScuttleLid` |
| `hold` | 0.05 | 0.30 | `hatchwayBoards` |

Openness drives two things:

- **gain**: `0.14 + 0.86·openness`. A sealed room is quiet, never silent — a
  ship with every hatch on is still full of the sea.
- **cutoff**: `170 · (19000/170)^openness` Hz. Geometric, not linear, because
  pitch is logarithmic and a linear interpolation spends nine tenths of its
  travel in the top octave and appears to slam shut at the very end.

Three things worth recording about why the numbers are *not* the light model's:

1. **A grating is opaque to light and transparent to sound.** The hatchway's
   grating passes its open-cell fraction of the daylight and essentially all of
   the noise, because audible wavelengths are 0.02–17 m and the lattice pitch is
   centimetres. The cabin's crown glass is the mirror image.
2. **Shutting a closure returns a room to its base, not to zero.** The same
   asymmetry `CHANNEL_SCUTTLE`'s comment records for light: a gate must not
   remove a path the room had before the gate existed.
3. **The hull's groan gets *louder* below decks, not quieter.** It is
   structure-borne — it arrives through the frame at your back, not through the
   hatch — so it bypasses the enclosure bus entirely and is multiplied by 2.1.
   Shutting the hatch does not quiet it; shutting the hatch takes away its
   competition. This is the detail most likely to make below decks feel like a
   different place, and it is the one most in need of Ash's ear.

---

## 6. `sailShakeFraction`, and the boolean that would have clicked

The M6 cloth round (`claude/coord-m6-sails-alive`, `17e8550`, **not yet on
master**) landed while this round was interrupted. It gives the sails real
deformation, including a flogging mode driven by the aero's attachment curve,
the crew's `cannotDraw`, and the `blanketFactor` that had been computed since S2
and read by nothing.

The first draft of this round summed the area of sails whose `luffing` flag was
set. That flag is exactly `sailLuffFactor(aoaDeg) < 0.5` — **a boolean cut out
of a smooth curve.** Using it would have switched the cloth voice on at full
volume the instant a sail crossed ten degrees: a click, not a luff, and a direct
violation of this round's own continuity gate.

So the derivation now lives in one place, `sailAero.ts`, beside the attachment
curve it is built on:

```ts
sailShakeFraction(aoaDeg, apparentSpeedMps, blanketFactor, cannotDraw): number
  = (1 − attach) · (1 − abackFill) · shakeWind
```

Cloth that is holding shape is quiet and still; cloth pressed firmly against the
shrouds is quiet and still; the cloth that thunders is the cloth in between, and
only when there is wind to move it. That is **one fact about a sail**, and both
what you see and what you hear are functions of it.

`VesselRuntime.readAcoustics()` area-weights it into `shakingClothAreaM2`, and
the mapping takes the gain straight off that area with **no second wind term** —
the wind is already inside the shake fraction, and multiplying again would square
it and make a light-airs luff inaudible.

### Owed on merge with M6 — mechanical, not a design question

1. **`rigGeometry.ts` computes the same `shake` inline.** Delete the local
   `attach` / `abackFill` / `shakeWind` block in `sailLoftLive` and call
   `sailShakeFraction`. It also holds its own copies of `CANNOT_DRAW_ATTACH_CAP`
   (0.5), `ABACK_FULL_DEG` (12) and `FULL_SHAKE_MPS` (8) — the same three
   constants this round exported. **Two copies that agree because someone keeps
   them agreeing is precisely what M6's own `sailLeewardNormal` comment says it
   was fixing; do not leave it that way.**
2. **`cannotDraw` is currently passed `false`.** M6 adds
   `Trimmers.cannotDraw(sail)`, an allocation-free accessor built for the loft;
   master has only `readout()`, which allocates per station per call, and this
   round would not allocate on a frame path to get it. Until merge the sound
   *under-reports* a sail the hand has given up on, which is the safe direction
   to be wrong in. On merge, pass it.
3. **The slat rate should be the loft's phase, not a rig-wide wind curve.** This
   is the weakest number in `soundMapping.ts` and it is called out as such in
   the source. The real flogging frequency is a property of each sail's chord —
   M6 flogs a one-metre chord at 2.4 Hz, longer cloth slower — and draws each
   sail on its own phase. **Until this reads that phase, a sail you can watch
   thundering and the thunder you can hear beat at two unrelated rates.** This
   is the round's first follow-up and it is a merge away, not a design problem.

---

## 7. Determinism

`WorldWind`'s header brags about having no `Math.random()` twenty lines from a
file that had one. Fixed:

- `createNoiseRandom(seed)` is mulberry32 — chosen over an LCG because the low
  bits of an LCG are visibly periodic and a noise buffer is exactly where a weak
  low bit becomes an audible tone.
- Two named seeds (`NOISE_SEED.broadband`, `.broadbandAlt`) feed six voices at
  six mutually non-commensurate playback rates, so no two voices walk in step.
- The buffer is 11 s, up from 5 s: a 5 s loop under a slow fade is audible as a
  pulse once you know to listen for it.
- The spectral tilt is a one-pole leaky integrator at `a = 0.94`, about
  −6 dB/octave above a ~460 Hz corner. Browner than pink, deliberately: sea
  noise at a ship's rail is dominated by the low end and a true-white hiss reads
  as a radio.
- `tests/sound-mapping.test.ts` pins **four actual sample values** by inline
  snapshot. If the pole, the gain or the PRNG changes, the sound of the game
  changes, and that line is the notification.

---

## 8. Dev-shell controls

**`?debug=sound`**, or the **Sound** tab in the developer shell.

| Control | What it does |
|---|---|
| Muted | Same state the `M` key toggles. Starts muted. |
| Master gain | 0…1, default 0.22 (inherited unchanged from the raft-era value). |
| Hear only | Solo: silences the other five. **The A/B lever.** |
| swell / breakers / rigging / cloth / bow / hull | Per-voice trim, 0…1. |
| All to unity | Reset every trim and clear the solo. |

And a live readout, which turned out to be the most useful part:

```
context   absent (silent)
listener  cinematic  46.4 m from her
room      open air   air 1.00 @ 19000 Hz
closures  boards laid   scuttle shut
bow pan   -0.17   slat 1.40 Hz
master    0.000

voice     level              gain     Hz   driver
swell     #######...........  0.366    249   Hs 1.16
breakers  ..................  0.007    908   whitecap 0.00
rigging   ##................  0.086    547   app. wind 6.68
cloth     #.................  0.070    680   shaking m² 7.46
bow       ###...............  0.155    769   thru water 2.99
hull      #.................  0.051    155   work rate 0.05
```

*(a real capture from the opening voyage, sound still muted)*

The third column is the point. **"The rigging is too loud" and "the rigging is
responding to the wrong number" are different faults with the same symptom**, and
until the driver sat beside the gain there was no way to tell them apart without
reading the source. It also works with the sound muted and before any gesture,
because the mapping runs whether or not there is anything to play it through.

---

## 9. What Ash should listen to

Nothing below has been heard. Start the server with the `drift-sound` launch
entry, open `?debug=sound`, click once to allow audio, and untick Muted.

**Solo each voice first, in this order.** Judging the mix before judging the
voices is how a bad voice hides behind a good one.

1. **`swell` alone, in three seas.** Ocean lab → a calm, `CURRENT_MODERATE`, and
   the worst storm preset. Question: does the *floor* in a calm read as "quiet
   sea" or as "something is broken"? And does the cutoff dropping with period
   make a long swell feel long, or just muffled?
2. **`breakers` alone, sweeping wind speed 0→28 m/s.** The half-point is at 3 %
   coverage, about force 6. Question: does the hiss arrive at the same moment
   the whitecaps become visible? They are driven by the same number, so if they
   disagree it is the *curve*, not the data.
3. **`rigging` alone, then the decisive test: hold a course and bear away.**
   Apparent wind falls as she turns downwind. **The rig should audibly quieten
   as you bear away and rise as you harden up, at constant true wind.** If that
   one thing works, the round's central claim is good.
4. **`cloth` alone. Luff her deliberately** — head up until the headsails shake.
   Two questions, and they are separate: is the *level* right (one headsail vs.
   the mainsail let fly), and does the *beat* look wrong against the cloth?
   Expect the beat to be wrong; see §6.3.
5. **`bow` alone, from stopped to hull speed** (~4.5 m/s). Also walk forward and
   aft in embodied view and turn on the spot — the pan is the only spatial cue
   in the game and it either reads or it does not.
6. **`hull` alone, in a beam sea.** Then go below. **It should get louder, not
   quieter.** This is the most opinionated decision in the round.
7. **The camera pull-back.** Full mix, embodied → cinematic → full zoom out.
   The intended effect is that the ship goes quiet and the sea does not. Does
   1400 m feel like watching a ship across water, or like a bug?
8. **The hatches.** Full mix, embodied, go below to the forecastle and work the
   scuttle lid; go into the hold and work the hatchway boards. Is the difference
   between open and shut *legible*, and is a shut hold too dead or not dead
   enough?
9. **Only then, the full mix**, in a calm and in a storm. What is masking what.

---

## 10. Deliberately not built

- **Any audio asset.** Everything is procedural. The project has no asset
  pipeline for sound and this round did not invent one.
- **Crew sound of any kind.** And when it comes: **no shanties.** Call-and-response
  work songs are post-1815 merchant practice and the word itself is 1850s; ours
  would be twenty years early. `CREW_COMFORTS_CONCEPT.md` §3.1 has what is
  period-correct instead — wordless "singing out" at the windlass and halyards,
  a fiddle or fife, songs off watch in the dog watches. All of it needs either
  assets or a synthesis model, so it is a round of its own.
- **Individual creaks.** The hull voice is a *groan* — a filtered noise band that
  swells and eases with the roll. A creak is a transient and a noise band cannot
  make one. Doing it properly means an impulse voice triggered on fastening load
  crossing a threshold, which means the buoyant body publishing something it
  does not publish today.
- **Reverb of any kind.** The enclosure is a lowpass and a gain. A real cabin has
  a tail; a convolution reverb needs an impulse response, which is an asset.
  A cheap feedback-delay network is possible and is the obvious next thing if
  below decks reads as "quieter outdoors" rather than "indoors".
- **Wave-impact transients.** A sea coming aboard, a bow slamming out of a
  trough. `HullWaterContact` publishes `verticalEntrySpeedMps` per station and
  it is exactly the trigger such a voice would want — probably the highest-value
  voice not in this round.
- **Doppler, air absorption, occlusion of the sea by the hull.** Nothing here
  moves fast enough for Doppler to be honest, and the other two are below the
  resolution of a six-voice procedural mix.
- **Rain, thunder, terrain.** The weather round is live in a sibling worktree;
  audio should follow whatever it settles on rather than guess.

---

## 11. Not measured

**No performance number was taken.** Ash's machine is running eight agents and
is thermally throttled; a measurement now would be a measurement of heat.

For the cold-machine pass:

1. **Steady-state CPU cost of `Ambience.update`.** Should be small — one
   sampler pass, ~40 arithmetic ops, ~16 `setTargetAtTime` calls — but it is on
   every frame in `prepareScene` and has never been timed.
2. **One 4×4 matrix inverse per frame** in `SoundSampler.roomOfListener`, for
   the room lookup. Almost certainly noise; if it is not, it can be skipped
   whenever `vesselDistanceM` exceeds the hull's bounding radius.
3. **Web Audio's own thread cost**: six looping buffer sources, seven biquads,
   one oscillator, one panner. Independent of frame rate, so it shows up as
   audio-thread load rather than in the frame profiler.
4. **Memory**: two 11-second mono buffers at the device sample rate — about
   4.2 MB at 48 kHz. If that is unwelcome on mobile, the honest lever is buffer
   seconds, not voice count.

---

## 12. Faults found and not fixed

Reported rather than fixed, per the round's rules.

1. **`WindSystem.sail` is now unread by the audio system but still exists**, and
   still animates raft cloth on the production schooner's behalf. `wind.sail`,
   `sailRaised`, `toggleSail`, `targetDriftSpeedMps`, `driftSpeedSailUp/Down`
   are all raft-era. The `R` key still toggles it and the hint line still
   advertises "R for the sail". On the production schooner it now drives nothing
   audible and, as far as this round can tell, nothing visible either. Someone
   should confirm and delete it.
2. **`docs/audio/` did not exist before this round**, and neither did any audio
   entry in `docs/README.md`'s index. This handover is the first; the index
   still needs the link.
3. **The `?debug=<panel>` deep link and `preview_start` interact badly across
   worktrees.** A bare `npm run dev` launch entry runs in the *session's* cwd,
   not the worktree being edited — which made the new panel appear to be missing
   when it was only absent from the branch being served. The `--prefix` pattern
   `drift-master` already uses is the fix; a `drift-sound` entry now exists.
   Worth knowing generally: **every agent verifying a UI change in a worktree is
   exposed to this**, and the symptom is "my change isn't there".
4. **`CameraSystem.telemetry()` allocates a fresh record per call.** Fine for a
   panel, and this round avoided it, but it is a trap for anything on a frame
   path.
5. **The M6 branch and this one both need `Trimmers.cannotDraw`** and only M6
   has it. Noted in §6.2; flagging separately because it is a coordination fact,
   not a code one.
