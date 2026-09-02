# Default compass-course hold bias — headless investigation report

**Status: FINDING CONFIRMED; REMEDIATION IMPLEMENTED AND GATED ·
2026-08-12. See §14 for the outcome.**

This report records a headless investigation of the default game's human
helmsman. It answers one concrete question: when the opening voyage orders a
compass course and leaves the helm to the automated human operator, does the
ship's heading—and, separately, her travelled track—remain statistically
centred on that order over five minutes?

The short answer is **no**. The ship follows the ordered direction broadly,
but the error distribution is not centred. Across eight otherwise identical
five-minute production rollouts, changing only the crew seed, the true bow
heading averaged **1.354° to starboard** of the order. Every rollout had the
same sign. The physical compass and perceived reading were effectively
unbiased; the offset is produced by an event-driven controller that repeatedly
removes corrective helm before reaching the ordered course and has no learned
holding helm with which to balance the sail plan's intentional weather helm.

No controller or production behaviour was changed during this investigation.

---

## 1. Reported observations and the hypothesis under test

Ash reported two related observations:

1. With a heading ordered by default and the automated helmsman controlling
   the tiller, the compass/helm presentation appeared consistently displaced
   a little to one side of the order.
2. When the helmsman applied corrective rudder, he appeared to release it too
   early, before the ship had returned to the target.

The proposed statistical interpretation was sound: an imperfect human may
wander, overshoot and trace an untidy path, but if the imperfections and the
closed-loop controller are mean-centred, independent rollouts should average
to the ordered heading. A persistent same-signed ensemble mean indicates a
systematic term rather than ordinary human variation.

The investigation therefore separated four quantities which can look similar
on the HUD but mean different things:

- **ordered course** — the compass heading spoken to the helmsman;
- **true heading** — the direction of the vessel's bow;
- **compass indication/perception** — the physical card and the delayed,
  quantised reading available to the human model;
- **true course/track** — the direction of travel, which may differ from bow
  heading because of leeway.

Positive errors in this report mean increasing compass heading: **starboard of
the ordered course**. Negative errors mean port.

---

## 2. System under test

The default opening voyage orders the heading already under the bow:

- ordered true/compass heading: **234°**;
- opening speed: **3.0 m/s**;
- sea state: `CURRENT_MODERATE`;
- mean wind: **6.0 m/s toward 144°**, with production gustiness **0.25**;
- full initial sail plan on the authored starboard tack;
- world voyage-distance scale: **30×** ordinary physical travel.

The harness composed the same production objects and seams used by `main.ts`:

```text
SchoonerHorizontalDynamics (240 Hz)
  → SailingCrewSensors
  → physical CompassInstrument and perceived HelmObservation
  → SailingCrew / Helmsman
  → SailingControls rudder target and physical rate limiter
  → resistance + sail-force integration
  → PlanetaryWorld canonical motion
```

There was no renderer, browser, GPU, UI automation or computer-use
interaction. This was a fully headless physics/control test. The fixed-step
simulation remained at the production **240 Hz**; it was called from a
simulated **60 Hz** presentation loop.

### 2.1 Primary rollout configuration

- Duration: **300 seconds** per rollout.
- Evaluation window: **30–300 seconds**. The first 30 seconds were retained in
  the travelled-track result but excluded from settled heading statistics so
  spoken-order pickup and the opening transient did not dominate the mean.
- Production waves and deterministic gust process were identical in every
  rollout.
- Only the deterministic sailing-crew seed changed.
- Number of production rollouts: **8**.
- Statistical interval: two-sided 95% Student-t interval over the eight
  per-rollout settled mean heading errors.

The seeds were deliberately spread over the unsigned 32-bit space rather than
chosen consecutively:

```text
1129465175  3783900944  2143369417  502837890
3157273659  1516742132  4171177901  2530646374
```

Seed `1129465175` (`0x43524557`, “CREW”) is the production default.

### 2.2 Metrics

At 60 Hz the harness recorded:

- signed true-heading error relative to 234°;
- RMS and maximum absolute heading error;
- fraction of settled time on either side of the order;
- signed true-course error;
- compass-indication minus true-heading error;
- perceived-compass minus true-heading error;
- rudder target, interventions and release events;
- physical distance and cross-track distance.

For each frame distance `ds`, cross-track accumulation used:

```text
cross_track += ds × sin(true_course − ordered_course)
along_track += ds × cos(true_course − ordered_course)
```

The reported physical displacement is what the hull encounters in ordinary
seconds. `PlanetaryWorld` applies the game's 30× voyage scale to canonical map
travel; the corresponding voyage-scale displacement is therefore also stated.

---

## 3. Production rollout results

### 3.1 Eight-seed ensemble

| Crew seed | Mean heading error | Heading RMS | Time starboard | Mean course error | Full track error | Physical cross-track | Interventions |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1129465175 (default) | +1.448° | 1.657° | 97.3% | +0.467° | +0.431° | +7.89 m | 47 |
| 3783900944 | +1.326° | 1.456° | 98.0% | +0.369° | +0.292° | +5.35 m | 47 |
| 2143369417 | +1.294° | 1.523° | 94.0% | +0.320° | +0.299° | +5.49 m | 43 |
| 502837890 | +1.322° | 1.487° | 96.4% | +0.358° | +0.275° | +5.03 m | 43 |
| 3157273659 | +1.090° | 1.250° | 94.7% | +0.114° | +0.062° | +1.13 m | 42 |
| 1516742132 | +1.733° | 1.924° | 99.4% | +0.763° | +0.707° | +12.93 m | 55 |
| 4171177901 | +1.305° | 1.521° | 97.1% | +0.347° | +0.321° | +5.87 m | 44 |
| 2530646374 | +1.311° | 1.630° | 90.4% | +0.352° | +0.308° | +5.63 m | 41 |
| **Ensemble mean** | **+1.354°** | **1.556°** | **95.9%** | **+0.386°** | **+0.337°** | **+6.16 m** | **45.25** |

The 95% interval for the ensemble's settled mean heading error is:

```text
+1.201° to +1.506°
```

Zero is not close to this interval, and all eight rollout means have the same
sign. Under the tested default environment, crew randomness does not average
the ship back onto the ordered heading.

The average physical distance travelled in five minutes was **1,049.37 m**.
The average physical cross-track displacement was **6.16 m**. At the game's
30× voyage scale these correspond to approximately **31.48 km travelled** and
**185 m of cross-track displacement** in canonical world travel.

### 3.2 Default-seed result

For the actual production crew seed:

- ordered heading: **234.000°**;
- settled mean true heading: **235.448°**;
- settled mean heading error: **+1.448°**;
- settled RMS heading error: **1.657°**;
- maximum settled absolute heading error: **3.490°**;
- time starboard of the order: **97.3%**;
- settled mean true-course error: **+0.467°**;
- complete five-minute track error: **+0.431°**;
- physical cross-track displacement: **+7.89 m** over **1,049.03 m**;
- voyage-scaled cross-track displacement: approximately **+237 m** over
  **31.47 km**.

The final instantaneous heading was not used as the finding because it depends
on where a correction cycle happens to be at 300 seconds. Time-domain and
ensemble means are the relevant quantities.

### 3.3 Heading versus travelled track

The ship's track is less biased than her bow. Across the ensemble, settled
true-heading error averaged +1.354° while true-course error averaged +0.386°.
The roughly 0.97° difference is aerodynamic/hydrodynamic leeway opposing part
of the bow offset.

This distinction answers both forms of the original question:

- **Does the bow hold the ordered heading in the mean?** No.
- **Does the vessel broadly travel in the ordered direction?** Yes, but the
  travelled line also retains a smaller, statistically consistent starboard
  bias.

Leeway partially hides the control problem in the track. It does not make the
heading controller mean-correct.

---

## 4. Instrument and perception audit

The five-minute default-seed production run measured:

| Layer | Mean signed error relative to true heading |
|---|---:|
| Physical compass indication | −0.0035° |
| Helmsman's perceived compass reading | +0.0306° |
| Vessel true heading relative to order | +1.4478° |

The instrument and perception errors are two orders of magnitude smaller than
the true-heading offset. They cannot explain it.

This also rules out the possibility that the HUD merely makes a correct vessel
look biased through physical card lag. The displayed card can lag and agitate
in the seaway as designed, but the underlying bow itself spends almost all of
the evaluated run to starboard of the order.

The human profile explicitly declares no persistent left/right reading bias,
and the observed numbers agree with that declaration.

---

## 5. Rudder-release audit

Ash's follow-up anecdote was that the helmsman appears to release corrective
rudder before returning to the ordered course. The recorded intervention trace
supports that observation directly.

In the five-minute default-seed production run:

- total helm interventions: **47**;
- transitions from nonzero requested rudder to amidships: **21**;
- releases while perceived heading was still starboard of the order:
  **21 of 21**;
- releases explicitly before the perceived crossing for the correction being
  applied: **17 of 21**;
- mean absolute perceived error at release: **1.524°**;
- release-error range: **0.5° to 2.5°**, always on the starboard side;
- mean nonzero rudder-pulse duration: **3.124 seconds**;
- settled time with the rudder target exactly amidships: **69.8%**;
- settled mean rudder target: **0.623° of port helm**.

Distribution of perceived error at release:

| Heading still starboard by | Release count |
|---:|---:|
| 0.5° | 2 |
| 1.0° | 4 |
| 1.5° | 7 |
| 2.0° | 7 |
| 2.5° | 1 |

The four releases not classified as “before crossing for the current
correction” followed a counter-rudder phase. They do not weaken the main
finding: all 21 zero-rudder commands were issued with the perceived vessel
still on the same starboard side of the ordered course.

---

## 6. Flat-water mirrored-tack control

The production ensemble deliberately kept waves and gusts identical so only
the crew seed varied. A second control removed both waves and gust variation,
then reflected the wind and every sail trim about the same ordered heading.
This asks whether the human controller has an intrinsic compass/right-handed
bias, or whether the offset follows the ship's steady aerodynamic yaw.

Four seeds were run for five minutes on each tack:

| Crew seed | Flat default tack mean | Flat mirrored tack mean | Pair midpoint |
|---:|---:|---:|---:|
| 1129465175 | +1.542° | −1.613° | −0.036° |
| 3783900944 | +0.836° | −1.572° | −0.368° |
| 2143369417 | +1.579° | −1.671° | −0.046° |
| 502837890 | +1.617° | −1.557° | +0.030° |
| **Mean** | **+1.393°** | **−1.603°** | **−0.105°** |

The bias reverses with the tack. The mirrored pair-midpoint interval includes
zero; with this small four-pair control there is no evidence of a fixed
starboard preference in perception or action randomness. The approximately
1.50° half-span is the tack-following component.

This control also excludes waves and gusts as the source of the persistent
offset. The necessary remaining disturbance is the sail plan's steady weather
helm.

---

## 7. Root-cause analysis

The result is not one bug in isolation. It is the closed-loop consequence of
an intentional vessel tendency and three controller policies.

### 7.1 The plant has intentional weather helm

Full sail on the opening beam reach supplies a persistent yaw moment toward
the wind. That is deliberate and already recorded by the committed S3 helm
evidence. Its 8 m/s full-sail beam-reach fixture needs **2.102° of balancing
rudder** to zero net yaw moment. The production opening is at 6 m/s rather than
that fixture's 8 m/s, so 2.102° is supporting evidence, not an exact production
set point.

Weather helm itself is not the defect. A competent helmsman should carry a
small persistent balancing helm and superimpose finite corrections on it.

### 7.2 Correct response trend is sufficient to schedule zero rudder

`Helmsman.finishResponseWatch` schedules an intervention to zero rudder when
the vessel is answering the requested turn and **any** of these is true:

```text
the perceived course has crossed the order
OR the compass trend matches the requested turn
OR absolute perceived error is below 1.6° × 1.4 = 2.24°
```

The second condition means “she has begun answering” can be treated as
“corrective helm can come off,” even with material course error remaining. The
third deliberately widens the ordinary deadband during response watching.
Human decision and motor delay mean release does not execute at the exact
instant of consideration, but the measured trace shows that this delay still
did not carry the vessel to the target: every release occurred on the original
side.

Ash's early-release observation is therefore not merely a visual impression;
it matches both the policy and the resulting event data.

### 7.3 The ordinary deadband always eases toward zero, not a holding helm

`considerCourseIntervention` uses a base deadband of **1.6°**. Once a focused
reading is inside it, any material existing rudder request is changed to
exactly zero.

There is no state representing the small helm needed to balance recurring
weather helm. There is also no integral or adaptive term. Consequently the
controller can correct displacement but cannot learn the steady disturbance:

```text
weather helm turns the bow starboard
  → error crosses the intervention threshold
  → finite port-rudder pulse
  → correct turn begins
  → rudder returns to zero before the ordered course
  → weather helm resumes the same drift
```

The result is a one-sided limit cycle, not zero-mean wandering.

### 7.4 Minimum pulse and cooldown make the cycle coarse

Outside the deadband, any computed correction smaller than 3° is promoted to
a **minimum 3° rudder target**. After returning to zero, a settled correction
has a **3-second cooldown**. These policies are symmetric and do not create
starboard bias by themselves, but they reinforce pulse–release–wait behaviour
instead of establishing a small continuous balance.

Reducing the deadband alone would likely increase intervention chatter. Raising
the pulse alone would likely increase overshoot. Neither supplies the missing
steady-state control term.

### 7.5 Why randomness does not rescue the mean

Perception noise and rudder execution error are zero-mean. That is necessary,
but it is not sufficient for a mean-correct closed loop. Random perturbations
are being added around a deterministic cycle whose centre is already displaced
by weather helm plus zero-rudder release policy. Independent seeds therefore
change the texture, cadence and excursions while retaining the same signed
mean.

---

## 8. The existing evidence blind spot

The committed S5 evidence is useful but does not state the property investigated
here:

- calm and `CURRENT_MODERATE` course-hold cases are **120 seconds**, not five
  minutes;
- both use the single default crew seed;
- heading accuracy is gated by unsigned RMS only: at most **2°** in the calm
  case and **5°** in `CURRENT_MODERATE`;
- no gate records signed mean heading error, time spent on either side, ground
  track or cross-track distance;
- the `hasCorrectWatchEaseEpisode` calculation succeeds if any intervention
  after the first nonzero command has a smaller rudder magnitude. It does not
  test the course error or predicted crossing at which the easing happened.

A persistent 1.35° offset can therefore pass the RMS gate. More subtly, the
release behaviour implicated here helps satisfy the existing “correct ease”
gate because the gate checks only that easing occurred, not whether it occurred
at a correct time.

The relevant existing regression suite remained green after the investigation:

```text
tests/opening-voyage.test.ts
tests/ship-sailing-crew.test.ts

2 test files passed; 22 tests passed
```

That green result is compatible with this report. It demonstrates a missing
acceptance property, not a contradiction in the collected data.

---

## 9. Theories considered

| Theory | Result |
|---|---|
| Physical compass card is biased | Rejected: −0.0035° mean indication error. |
| Human perceived reading is biased | Rejected: +0.0306° mean perception error. |
| Production crew seed is unlucky | Rejected: all eight independent seed means are starboard. |
| Waves or gusts create the mean | Rejected: flat, ungusty control retains the bias. |
| Human action model is intrinsically right-handed | Rejected: mirrored tack reverses the bias. |
| HUD needle only makes a correct vessel look wrong | Rejected: true bow telemetry carries the offset. |
| Leeway explains the whole observation | Rejected: it reduces track bias but not heading bias. |
| Weather helm plus early zero-rudder release creates a one-sided cycle | Supported by production, release-event and mirrored-tack data. |

---

## 10. Recommended solution

The fix should preserve S5's governing abstraction: the helmsman may use only
plausible observations and must remain event-like. It should not replace him
with a continuous controller reading true heading, yaw rate or aerodynamic
truth.

### 10.1 Add an adaptive holding-helm estimate

Give the helmsman a slowly changing `holdingRudderDeg` associated with the
active compass-course order. It should be learned only from the same perceived
events available to the current human model:

- after easing, did drift repeatedly resume toward the same side?
- did successive corrections require the same rudder sign?
- did the vessel remain comfortable with a smaller retained rudder?

The transient course correction should be superimposed on this learned base:

```text
requested rudder = learned holding helm + finite course correction
```

When the response is satisfactory, “ease” should normally mean ease toward the
holding helm, not automatically all the way to zero.

The estimate should reset or decay when its assumptions materially change:

- a new standing compass-course order;
- a tack or major wind-side change detectable from human cues;
- a large canvas/trim change;
- loss of way;
- direct player takeover and later reacquisition.

This is human-plausible. A real helmsman feels that the vessel consistently
wants to round up and carries a little helm against it; no hidden physics
telemetry is required.

### 10.2 Tighten the release decision

Correct trend alone should not be sufficient to command zero rudder.

Use the existing perceived error and anticipated heading machinery to require
one of:

- perceived or anticipated crossing of the ordered course;
- a narrow release band with a predicted time-to-arrival consistent with the
  sampled human reaction/motor delay;
- a deliberate stepped reduction toward the learned holding helm while the
  remaining error continues to close.

The response-watch path and ordinary compass-check path should share the same
arrival prediction. At present one path uses an anticipated reading to choose
rudder while the other can release on a coarse trend label; those definitions
of “answering correctly” should agree.

It remains reasonable for a human to ease before the mathematical crossing.
The target property is not “every release occurs after zero.” It is that
prediction plus inertia produces a distribution centred around the ordered
course rather than 21 releases all on one side.

### 10.3 Tune deadband, minimum change and cooldown second

Keep the 1.6° deadband, 3° minimum pulse and 3-second restart cooldown until a
holding-helm term and coherent release rule exist. Then retune them together
against both cadence and signed bias.

Shrinking the deadband first risks turning an understandable human intervention
loop into chatter. The structural steady-state omission should be corrected
before feel constants are adjusted.

---

## 11. Proposed regression and acceptance plan

Add the failing evidence before changing the controller.

### 11.1 Five-minute ensemble gate

Run at least 16 deterministic crew seeds for 300 seconds, excluding the first
30 seconds from settled metrics. Hold environment and wind seed constant.

Suggested provisional gates:

- absolute ensemble signed mean true-heading error ≤ **0.25°**;
- 95% interval includes zero and remains within a declared practical band;
- per-run RMS remains within the existing competent-human band;
- no rollout develops persistent hard helm or unstable oscillation;
- intervention cadence and unchanged-target periods retain the existing human
  feel gates.

The 0.25° value is a proposed engineering acceptance threshold, not a claim
that a historical human helmsman steered to quarter-degree precision. It
applies to the **ensemble mean**, not each untidy individual trace.

### 11.2 Mirrored-tack symmetry gate

On flat water with zero gustiness:

- run matched seeds on mirrored wind and trim;
- require the two ensemble means to be equal and opposite within tolerance;
- require their pair midpoint to remain near zero;
- keep heading RMS and intervention cadence comparable across tacks.

This separates a tack-following plant/controller equilibrium from an
unintended compass-direction bias.

### 11.3 Release-quality evidence

Record, for every nonzero-to-eased intervention:

- perceived error and confidence at consideration;
- perceived/anticipated heading rate;
- prior, next and holding rudder targets;
- predicted crossing time;
- error when the new rudder target executes;
- minimum error and side reached before the next correction.

Gate the distribution rather than demanding one exact human action. In a
steady weather-helm fixture, releases and subsequent closest approaches should
not remain entirely on one side of the order.

### 11.4 Track metric

Retain a separate course/track gate. A heading controller can improve while
track still differs because of leeway, and vice versa. Record:

- mean true-heading error;
- mean true-course error;
- physical and voyage-scaled cross-track displacement;
- distance made good along the ordered heading.

### 11.5 Invariants to retain

- exact caller-rate invariance on the 240 Hz grid;
- human policy receives `HelmObservation`, never truth telemetry;
- physical compass response and seaway displacement remain unchanged unless
  independently justified;
- direct takeover remains immediately authoritative;
- standing order reacquisition retains real response delay;
- all randomness remains seeded and purpose-isolated.

---

## 12. Suggested implementation sequence

1. Extend `SailingCrewEvidence` with signed mean, side occupancy, track and
   release-quality metrics; commit the currently failing evidence.
2. Add the flat mirrored-tack ensemble fixture.
3. Introduce an observation-derived holding-helm estimate.
4. Make response-watch easing target the holding helm and require coherent
   arrival prediction.
5. Retune deadband/minimum-change/cooldown only if the new traces need it.
6. Regenerate committed crew evidence and run the full sailing/ship-physics
   suites.
7. Repeat Ash's live HUD review. The numerical gate certifies centring; the
   live pass decides whether the operator still looks recognisably human.

---

## 13. Limitations

- The production confidence interval covers variation from the eight selected
  crew seeds under one fixed default environmental realization. It is not a
  claim about every wind, sail plan, sea state or ordered course.
- The mirrored control used four paired seeds. It is strong enough to identify
  sign reversal but should be expanded in committed regression evidence.
- Cross-track accumulation used framewise true course and physical distance;
  the 30× voyage figures are scaled equivalents, suitable at this distance but
  not a replacement for a future long-range route/geodesic analysis.
- No candidate controller change was implemented or tuned, so the suggested
  thresholds have not yet been tested for feasibility and feel together.
- The investigation tested the existing generic competent operator, not named
  crew, fatigue, skill differences or magnetic compass deviation, all of which
  remain outside S5.

These limitations do not affect the central finding: under the current default
opening, the heading distribution is consistently displaced to starboard, and
the intervention trace confirms that the current helmsman repeatedly removes
corrective rudder before returning to the order.

---

## 14. Outcome (implemented 2026-08-12, same day)

The remediation was implemented in `src/vessel/schooner/crew/Helmsman.ts`,
adopting §10's structure with the learning machinery deliberately simplified:

- **Holding helm (§10.1) — adopted, simplified.** One scalar
  `holdingHelmDeg`, nudged 0.5° toward the corrective side each time a
  course-drift correction is actually scheduled; alternating corrections
  cancel. No per-tack memory: the estimate resets on a new standing order and
  when the felt wind side flips, and simply re-learns. Corrections
  superimpose on it, both ease paths return to it instead of to zero, and the
  3° minimum pulse now applies to the correction component rather than the
  total.
- **Release rule (§10.2) — adopted with less machinery.** The coarse
  trend-label disjunct and the widened `1.4 ×` deadband release are gone. A
  watched correction releases only at a perceived crossing, or when the
  existing `ANTICIPATION_SECONDS` swing projection (the same one the
  compass-check path already used) says she is arriving. No new prediction
  apparatus was added, and with no compass reading there is no release.
- **Feel constants (§10.3) — untouched**, as prescribed. The settled-
  correction cooldown and busy/comfortable attention now measure "at rest"
  against the carried helm instead of amidships, which is the same policy
  restated.

Two additional defects were found while building the mirrored-tack gate:

- `SailingControls.reset()` restored the **authored starboard-tack trims**
  regardless of the trims the vessel was constructed with, so any
  construction-time trim (the production opening rig included) did not
  survive a dynamics reset. The first mirrored fixtures sailed a backed rig
  at 1.6 m/s because of it. Reset now restores the as-built trims.
- The committed `crew-baseline.json` no longer matched what the current code
  regenerates — physics drift since the original S5 checkpoint that the
  gate-reading tests could not see. It has been regenerated with the new
  format (v2: signed settled statistics and the centring gate).

Acceptance now lives in two places:

- `tests/ship-sailing-crew-bias.test.ts` (slow, sailing): a live 6-seed ×
  180 s × both-tacks flat ensemble. Measured after the fix: default-tack
  ensemble mean **−0.10°** (was **+1.69°** on this fixture), mirrored
  **+0.22°**, mean pair midpoint **+0.06°**, eases split 10/12 and 13/9
  across the order instead of 21-of-21 on one side. Fixed-rudder probes
  confirmed the plant itself is mirror-symmetric with a **≈0.53°** balance
  helm at the 6 m/s opening reach (the S3 2.102° figure is the 8 m/s
  fixture).
- `helmHoldsCourseCentred` in the committed evidence: the 180 s default-seed
  calm and moderate holds must keep their settled signed mean within 0.6°
  and 0.9° respectively (regenerated at −0.12° and +0.55°).

The §11.1 ideal (16 seeds × 300 s, ±0.25°) was traded down to keep the suite
runnable (~75 s); the thresholds above are the measured-with-margin
equivalents for this ensemble size. Ash's live HUD review (§12 step 7)
remains the final word on whether the operator still reads as human.
