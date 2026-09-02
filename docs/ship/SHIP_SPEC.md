# The expedition schooner — canonical specification

What the vessel **is**. This document is the authority on the ship's identity,
dimensions, hydrostatics and appearance, and it is expected to outlive many
build sessions.

`docs/ship/SHIP_ROUND_HANDOVER.md` is the authority on **how and in what order she gets
built**. If the two disagree about sequencing, the handover wins; if they
disagree about the ship, this document wins.

## Provenance

Consolidated 2026-07-31 from two design briefs (`ship-description.txt` and its
revision `ship-description-v2.txt`), which were AI-generated from Ash's
discussion of the game and then reviewed, negotiated and amended in session.
Both source files were deleted after this document absorbed them — they were
written as *asset-delivery briefs for a 3D modeller*, which is the wrong shape
for this codebase (see handover §2), and leaving them in the tree would mislead
a later session. Everything canonical from them is here.

Section 4 (hydrostatics) is **not** from the briefs. It is derived here, and it
is the part a build session must not treat as decorative: it contains the
acceptance criteria for the hull form.

---

## 1. The vessel, in one paragraph

A broad-beamed 15.5 m late-eighteenth-century topsail schooner of approximately
50 tons burthen, built or substantially refitted between about 1765 and 1780,
crewed by eight people and adapted for long-range scientific and surveying
expeditions. She began as a robust coastal merchant or colonial packet and was
bought or chartered into expedition service, so she favours seaworthiness,
capacity and stability over speed. She has a compact but genuinely comfortable
stern cabin for the player-captain, a walkable working deck, a restrained
six-sail rig and a modest foremast lookout. Her exterior is tar-dark brown with
muted-ochre painted trim, warm weathered deck timber and flax-grey sails. She is
intimate and capable, and physically small enough to roll and pitch quickly in
punishing seas.

The emotional target, which outranks every detail below:

> A warm, lamplit wooden home carrying eight familiar people through a world of
> immense oceans, changing weather and distant horizons — warm and inhabited
> within, exposed and vulnerable without.

The player character is the captain. A competent mate and crew work the vessel
continuously; the captain does not personally perform every routine sailing
action. **This does not imply a crew-management system.**

She is not, and must not read as: a fantasy pirate ship, a miniature galleon, a
naval frigate, a nineteenth-century clipper, a modern yacht, a polished museum
exhibit, a floating mansion, or a combat vessel.

She is **not bound to any particular ocean**. The narrative may begin in the
Pacific; the vessel is suitable for long-range oceanic voyages generally. This
matters because the repo carries a real planetary world model (`docs/world/WORLD_MODEL.md`,
`docs/adr/ADR-002-planetary-world-model.md`) — where she sails is a world
decision, deliberately left open here.

---

## 2. Canonical dimensions

| Quantity | Value |
|---|---|
| Hull length, stem to sternpost | 15.5 m |
| Overall length including bowsprit | 20 m |
| Maximum beam | 5.0 m |
| Loaded draught, moulded | 2.30 m |
| Loaded draught, to bottom of keel | 2.52 m forward, 2.87 m aft |
| Waterline to main masthead | 19–20 m |
| Burthen (Builder's Old Measurement) | 45–55 tons |
| Permanent complement | 8 |
| Masts | 2 |
| Steering | long tiller, mechanically direct to the rudder |
| Construction | carvel-planked timber over heavy timber frames |

The hull is **relatively broad and full-bodied for its length** — L/B ≈ 3.1,
which is a working merchant proportion, not the 4.5–5.0 of a racing schooner.
Do not narrow her.

**The burthen figure checks out and is not a typo.** BOM tonnage on a ~13.0 m
keel with 5.0 m beam is `(42.65 − 9.84) × 16.40 × 8.20 / 94 = 47 tons`, which
lands mid-band. Note that BOM is a *cargo capacity* measure and is not the same
quantity as displacement (§4) — the two differ by a factor of about 1.65 for
this type, and both numbers are correct. Nobody should "fix" the discrepancy.

---

## 3. Silhouette and hull form

She should have:

- a broad, rounded working bow;
- a projecting bowsprit;
- two moderately raked masts, the mainmast taller;
- moderate sheer, rising toward bow and stern;
- practical but not excessive bulwark height;
- a compact raised afterdeck / quarterdeck;
- a lower central working deck;
- a subtly raised forecastle;
- a broad transom stern with three to five small cabin windows;
- a relatively deep hull for accommodation and stores;
- restrained ornamentation.

Avoid: a towering stern castle, a large external deckhouse, excessive stern
galleries, an oversized figurehead, exaggerated sheer, implausibly tall or thin
spars, and decorative geometry that eats working space.

At distance she must be immediately recognisable by two masts, a long bowsprit,
fore-and-aft working sails and a single square topsail forward. She should look
tiny against the open sea and still read as a believable home.

---

## 4. Hydrostatics — derived, and binding

**This section is the hull's acceptance test.** The offsets table is correct when
these numbers come out of it; it is wrong otherwise, regardless of how she looks.

### 4.1 Assumed form coefficients

| | Value | Basis |
|---|---|---|
| Waterline length `L_wl` | 14.3 m | 15.5 m stem-to-sternpost less stem rake |
| Waterline beam `B_wl` | 4.8 m | 5.0 m max beam, slight tumblehome |
| Draught `T` | 2.3 m | given |
| Block coefficient `Cb` | 0.48 | full-bodied merchant hull |
| Waterplane coefficient `Cw` | 0.78 | consistent with `Cb` 0.48 |

### 4.2 The estimate, and what the hull actually produced

The paper estimate predates the faired hull. **The measured column supersedes
it**: these figures come from `src/vessel/schooner/hydrostatics.ts` and the canonical mass
budget, and are asserted by the ship tests.

| | Estimated | **Measured** | |
|---|---:|---:|---|
| Moulded volume | — | **75.08 m³** | fair body above the rabbet |
| Appendage volume | — | **4.51 m³** | keel, forefoot, deadwood and rudder |
| Displaced volume ∇ | 75.8 m³ | **79.59 m³** | |
| Displacement Δ | 77.7 t | **81.58 t** | seawater |
| Block coefficient Cb | 0.48 | **0.456** | moulded |
| Midship coefficient Cm | — | **0.706** | moulded |
| Prismatic coefficient Cp | — | **0.631** | moulded |
| Centre of buoyancy KB | 1.27 m | **1.460 m** | |
| Metacentric radius BM | 1.04 m | **1.087 m** | |
| Metacentre KM | 2.31 m | **2.547 m** | |
| Centre of gravity KG | 1.56 m | **1.936 m** | loaded mass model |
| Metacentric height GM | 0.75 m | **0.611 m** | |

Form coefficients are quoted on the moulded volume, per convention: they
describe the fair surface the planking follows. Physical flotation includes the
timber below it.

M1's backbone was coherent but visually and structurally too slight: 0.16 m
below the rabbet and dead-level across most of the vessel. The canonical form
now has a **0.38 m moulded keel with 0.35 m of drag aft**. The rabbet rises on a
curve rather than diagonal cuts, opening a proper forefoot forward and deadwood
aft above the straight keel. The rudder reaches the keel heel. The same profiles
produce the visible mesh, displaced volume and oak mass; there is no appendage
allowance or visual-only extension.

The coordinate zero remains the moulded baseline at the top of the keel.
Consequently the 2.30 m design draught is moulded draught: the vessel actually
draws **2.52 m forward and 2.87 m aft** to the deepest timber.

Deck, sole, bulwarks and freeboard remain at M1 height. The accepted hull-form
work therefore does not buy a lower roll amplitude by lowering topside mass.
With 28.03 t of ballast (34.4% of displacement), GM is 0.611 m and measured
free-decay remains **5.96 s**. The keel correction improves the ship without
pre-empting the dedicated seakeeping work.

Mass placement follows the same one-description rule. Deck equipment and
people are located relative to the walking deck, interior joinery relative to
the cabin sole, and rudder mass is derived from the blade geometry. Moving a
supporting surface can no longer leave its carried mass behind at a stale
absolute height.

### 4.3 Binding figures

| Quantity | Value | How it is held |
|---|---|---|
| Moulded volume | 75–77 m³ | asserted |
| Displaced volume ∇ | 78–81 m³ | asserted |
| Appendage share of ∇ | 4.8–6.8% | asserted |
| Displacement Δ | 79.5–82.5 t | asserted |
| Moulded draught at that displacement | 2.30 m | solved, asserted |
| Navigational draught | 2.52 m forward, 2.87 m aft | derived, asserted |
| Trim | level — LCG placed on LCB | solved, asserted |
| Metacentric height GM | 0.55–0.85 m | asserted |
| Ballast fraction | 0.25–0.38 of Δ | asserted |
| KG / depth to deck | 0.44–0.57 | asserted |

`KG` at 1.936 m is 0.51 of the moulded-baseline-to-deck depth, which is where a ballasted
timber vessel of this type sits.

The appendage share is banded rather than pinned because it is integrated from
shaped geometry. The band catches the keel or rudder silently doubling without
turning their form into a correction factor.

### 4.4 Ballast is a feel parameter, but a coherent one

`GM` may be tuned to taste during the physics work. It must remain consistent
with displacement, draught, trim, longitudinal centre of gravity, both radii of
gyration, water and provision loading, and the depletion of stores over a
voyage. **Mass properties are never derived from the visible number of barrels
and crates on deck** — the props are dressing, the mass model is the model.

---

## 5. Motion and seakeeping

### 5.1 Roll — measured

**Free-decay period: 5.96 s.** Heel her 10° on flat water, release, and time the
zero crossings — the same trial you would run on the real vessel. Measured by
`measureRollDecay` in `src/vessel/schooner/SchoonerBuoyancy.ts`.

This supersedes the 4.3 s estimate, which was wrong twice over: it used the
under-estimated `GM` above, and it ignored added inertia entirely. The
integrator agrees with the closed form to 0.3% —

```
stiffness  = ρ g ∇ · GM              = 489 kN·m/rad   (GM 0.611)
I_virtual  = I_roll · (1 + a_m)      = 436,741 kg·m²  (a_m = 0.45)
T          = 2π √(I_virtual / k)     = 5.939 s   vs 5.955 s measured
```

— so 5.96 s is the model's physics, not an artefact of the substep.

As a third opinion, the classical empirical formula `T = 2·C·B/√GM` with
`C = 0.373 + 0.023(B/T) − 0.043(L/100) = 0.416` gives **5.33 s**. Our 5.96 s
sits about 12% above that, inside the formula's own scatter.

**She is still a small vessel and should move like one.** 5.96 s is quick for a
ship; it is not the slow majestic sway of something large. Do not reshape her to
manufacture one.

### 5.1.1 Roll damping — fixed, and how

Roll damping is **not** the single ratio the other modes use. It has its own
linear and quadratic terms, in `ShipBuoyancy.ts`.

The reason is structural rather than a matter of tuning. Station damping is a
vertical force applied at each station's immersed centroid, and the roll torque
it produces is that force times the centroid's *transverse* offset. The raft has
three columns of stations 1.1 m off the centreline, so roll came out damped for
free. A hull's stations sit on the centreline and its immersed centroid barely
leaves it — 0.2 m at 10° of heel, and exactly zero upright, which is when roll
rate peaks. **A declared damping ratio of 0.18 was reaching roll as an effective
0.0011.** She lost 0.7% of amplitude per cycle and wound up onto the
integrator's ±40° limiter in three of the ten sea states.

| Term | Value | What it is |
|---|---|---|
| Linear, fraction of critical | 0.075 | radiation and skin friction |
| Quadratic, per radian | 0.60 | eddy shedding off the turn of the bilge |
| Heave / pitch ratio | 0.35 | was 0.18, held down by the old compromise |

The quadratic term is the important one. Real roll damping is strongly
nonlinear, and that nonlinearity is what limits a ship's roll at resonance — a
linear-only model has nothing that grows with amplitude, so it integrates
straight into a knockdown. Measured effective damping ratio, by logarithmic
decrement on a free decay:

| Release angle | Effective ζ |
|---|---|
| 5° | 0.045 |
| 12° | 0.053 |
| 25° | 0.065 |

That rise with amplitude is the signature of the quadratic term and it is
asserted in `ship-hydrostatics.test.ts`, not merely produced.

The heave ratio went **0.18 → 0.35** at the same time. It had been pulled well
below the truth for heave in order not to over-damp a roll it was barely
touching; with roll handled separately it can be what a hull of this
beam-to-draught ratio actually shows.

### 5.2 Pitch — permanent measurement exposes an earlier discrepancy

The earlier ad-hoc figure here was `T_pitch ≈ 2.2 s`. The permanent Phase 0
free-decay harness does not reproduce it: a settled 5° release on flat water,
integrated at 240 Hz for 30 seconds, measures **3.249 s** with an effective
damping ratio of **0.406**. The current undamped hydrostatic/inertia calculation
is **2.751 s**, making the measured damped period 1.181 times the closed-form
value.

The executable **3.249 s** result is now the recorded baseline. The old 2.2 s
number is retained here as provenance, not as a target to tune toward. Any later
coefficient change must explain this gap and regenerate
`evidence/ship-response/zero-speed-baseline.json` rather than silently forcing
the implementation back to the older note.

### 5.3 Resonance with the existing sea states

Two presets in `src/ocean/presets.ts` matter, and both are already in the box:

- **`CROSSING_SEAS`** carries a wind-sea peak near **4.13 s**
  ([presets.ts:303](src/ocean/presets.ts:303)). Against the *measured* 5.96 s
  roll period this is no longer the near-coincidence the first draft of this
  document claimed — the two are 44% apart. It remains reachable, because the
  excitation is the **encounter** period, which heading and speed shift; but it
  is a condition to be steered into, not one she sits in.
- **`WIND_CHOP`** peaks near **3.16 s**, deep-water wavelength **15.5 m**
  ([presets.ts:164](src/ocean/presets.ts:164)) — almost exactly the hull length.
  Wavelength ≈ LOA is the maximum-pitch condition, and this one is unaffected by
  the stability corrections above. It stands as the pitch test case.

**Do not tune these behaviours out because they are uncomfortable.** They are
emergent consequences of a correct hull in a correct sea. Response must
eventually be measured across headings, speeds, loading conditions and damping.

### 5.4 The lookout is the comfort landmine

The lookout sits ~10 m above deck, ~11.5 m above the roll axis. That lever turns
roll into lateral translation. Recomputed on the measured 5.96 s period, against
the roll amplitudes the damped model actually produces beam-on:

| Condition | Roll | Lateral swing | Peak speed | Peak acceleration |
|---|---|---|---|---|
| `CURRENT_MODERATE` | ±8° | ±1.6 m | 1.7 m/s | 0.18 g |
| `MATURE_WIND_SEA` | ±20° | ±3.9 m | 4.2 m/s | **0.45 g** |
| `SOUTHERN_OCEAN_ROUGH` | ±34° | ±6.4 m | **7.2 m/s** | **0.77 g** |

Gentler at the top than the 5.8 m/s and 0.86 g the 4.3 s estimate implied,
because a slower roll moves the masthead more slowly through the same arc — but
the worst sea still throws the lookout across 12.8 m of arc at highway speed.
Roughly eight times what a point on deck experiences, and a qualitatively
different place to stand.

The existing head-stabilisation model was found by sitting in it and is
documented at
[EmbodiedCameraController.ts:117](src/camera/EmbodiedCameraController.ts:117)
(roll 0.10, pitch 0.20, heave 0.90). Those constants are a starting point aloft,
not a solution.

## 6. Stern geometry and the captain's-cabin headroom solve

The original brief wanted 1.85–1.95 m of headroom throughout the stern cabin.
On a 15.5 m hull that fights "no towering stern castle" directly. **Resolved
deliberately in favour of restrained gameplay easing:**

| | Requirement |
|---|---|
| Quarterdeck rise | 0.45–0.55 m |
| Clear standing height | ~1.85 m, **central strip only** |
| Headroom at sides / under beams | 1.55–1.70 m, tapering |
| Cabin sole | as low as practical without unrealistically intruding on bilge or ballast |
| Deck camber | exploited for centreline height, not decorative |
| Furniture and berth | placed under the *low* peripheral portions |

The 1.95 m target is removed. The result should feel slightly more comfortable
than an uncompromised historical vessel of this size, while still looking
cramped, structurally plausible and unmistakably shipboard.

**The headroom is an input to the hull form, not a check applied afterward.**
Working the stack — deck at side ~1.5 m above waterline, +0.5 m rise, +camber,
−0.18 m of beam depth, sole just above the waterline — lands at roughly
1.80–1.85 m. It works, but only just. A hull lofted without this constraint in
the offsets will come out 5 cm short, and by then the hull is expensive.

---

## 7. Rig

A small topsail schooner, deliberately restrained so a tiny crew can work her.

### 7.1 Principal sails — eight

1. gaff mainsail
2. gaff foresail
3. fore staysail
4. jib
5. outer / flying jib
6. square fore topsail
7. **main gaff topsail** — *added by amendment, 2026-08-03*
8. main-topmast staysail (the fisherman) — permitted below, and taken up

A small main-topmast staysail may be added **only** if it is historically
coherent and earns its implementation cost visually. It was; it is item 8.

> **Amendment, 2026-08-03 — the main gaff topsail.**
>
> This list read "six" and did not include a gaff topsail on the main. Section
> 7.2 removes the square *main* topsail and gives a good reason for it, and that
> exclusion was read across to fore-and-aft canvas on the same mast, which it
> never covered. The two are different sails: one is square rig on a schooner's
> mainmast, which is wrong for the type; the other is the ordinary fore-and-aft
> topsail that nearly every gaff-rigged vessel of the period sets over her
> mainsail.
>
> The cost of the omission was visible. Her main topmast carried about five
> metres of bare stick over the largest sail in the plan, and the empty triangle
> above the mainsail was the biggest remaining hole in the broadside silhouette
> — which section 3 makes a requirement rather than a preference.
>
> Head hoisted on the topmast, tack hauled down to the gaff jaws, clew out to
> the gaff's peak. It adds no spar: the gaff it already has is its foot spar, so
> the sail is bound to the mainsail's trim and swings with it.

### 7.2 Explicitly removed

All topgallants, topgallant yards and their running rigging. Also the **square**
*main* topsail — square topsails on the foremast only is the classic topsail
schooner arrangement, so its absence needs no further justification.

The word *square* is load-bearing and was added by the 2026-08-03 amendment
above. This clause excludes a yard and square canvas on the mainmast. It says
nothing about the fore-and-aft gaff topsail set on the same mast, and it should
not be read as though it did.

### 7.2.1 One square topsail, not two — a date constraint

The fore topsail is a **single** sail on **two** yards: a fixed lower yard whose
arms its clews haul down to, and a hoisting topsail yard its head is bent to.

A sail split into two, set between an upper and lower topsail yard with a bare
yard beneath, is the **double topsail** — an 1850s invention, some seventy years
after her date in section 2. She carried that arrangement for one build round
because the topsail had been raised up the topmast to clear the fore gaff's
peak, which was the wrong fix for a real conflict: a gaff and a square topsail
share height and never share space, because one is set abaft the mast and the
other forward of it. Do not "correct" the single topsail into a double one.

### 7.3 Spars and standing rigging

Foremast, mainmast, topmast sections, bowsprit, gaffs, booms, fore-topsail yard,
shrouds, ratlines, forestays, backstays, deadeyes, lanyards, chain plates,
channels, crosstrees, and structurally credible attachment points.

### 7.4 Running rigging

Enough functional line to be believable: halyards, sheets, braces, lifts,
topping lifts, reefing lines, clewlines where appropriate, jib and staysail
controls.

> **Every important rope connects functional components. Do not scatter
> decorative ropes.**

This principle is load-bearing, not stylistic. It is the same contract
`RaftBuoyancy` is built on — one description of one object, no drift — and it
means the rigging is a **topology graph of real attachment points**, not a pile
of cylinders that happen to look like rope. It costs more up front and is the
only way the sail states stay coherent later.

Static rigging may be merged for performance. Anything that may later move must
remain logically separable.

---

## 8. Deck arrangement

A principal persistent environment: walkable, visually comprehensible, and
physically organised. Maintain clear circulation paths. Eight people must be
able to work, pass one another and handle lines plausibly. Do not dress her as a
theatrical pirate set, and do not fill empty areas with arbitrary barrels.

**Bow and forecastle** — bowsprit heel and supporting structure, anchor-handling
gear, windlass, riding bitts, hawseholes, anchor cable, fore hatch, compact crew
companionway, rope and tackle storage, forward lookout position, low forecastle
structure. The bow should feel exposed, energetic and wet in heavy weather.

**Forward heads** — historically plausible, near the bow, as a discreet
non-interactive detail. This implies no mechanics, no animation and no usable
bathroom. Keep it visually restrained.

**Central working deck** — cargo hatch with grating, bilge pump, secured water
casks, a *limited* number of provision barrels, spare spars, lashed sailcloth,
functional rope coils at their working stations, mast partners, belaying-pin
rails, access to crew accommodation and galley, open working space, one small
lashed dinghy, one or two generic expedition chests.

**Quarterdeck and stern** — modest raised quarterdeck, long tiller, tiller tackle
where appropriate, binnacle and compass, officer-of-the-watch position,
companionway to the captain's cabin, deck light or skylight over the stern
accommodation, signal halyards, stern lantern, clear circulation around the
mainmast and boom. **The tiller must sweep a mechanically plausible arc and
occupy real working space** — it is not a prop.

---

## 9. The captain's cabin

The most important interior in the game. Private, warm and comfortable by
eighteenth-century shipboard standards; compact and multifunctional. Beneath the
raised afterdeck.

**Form** — 7–9 m² of irregular floor area, headroom per §6, curved hull sides,
visible structural beams, three to five small stern or quarter windows, warm
timber, no modern freestanding bedroom furniture.

**Furnishings** — built-in box berth with mattress, wool blankets and a privacy
curtain; fixed writing and chart desk; chart drawers; shelving with retaining
rails; cushioned stern bench; sea chest; compact washstand with ceramic basin and
jug; coat hooks; secured bookshelf; telescope; dividers; parallel rulers; compass
or navigational instrument; logbook prop; ink and writing implements secured
against movement; gimballed lantern; personal-storage locker; a small number of
restrained personal objects.

She should be at her best at night — lantern light, creaking timber, moving
shadows, water audible beyond the stern. The interior is **warmer and lighter
than the dark exterior**; that contrast is the point of the room.

**Scenes the room must eventually support** (not build now): sleeping, sitting or
standing at the desk, inspecting a chart, consulting the log, receiving authored
voyage updates, making narrative choices, looking out the stern windows, exiting
onto the quarterdeck.

"Voyage updates" means **authored narrative presentation**, not a management
simulation.

---

## 10. Other interior spaces

Believable structural volume is preserved for all of these. Only the captain's
cabin and its access route need full detail.

- **Mate's berth** — small, minimally private sleeping and navigation space.
- **Crew accommodation** — hammocks or compact berths, sea chests, mess surface,
  limited storage, low headroom. No private cabins for ordinary sailors.
- **Galley** — compact hearth or stove, secured pots and utensils, preparation
  surface, chimney or flue, fire-safe surrounding structure.
- **Hold** — enclosing volume, plausible beams and supports, a shallow low-detail
  area visible through the cargo hatch, casks and crates and cordage suggested in
  shadow, the deeper hold disappearing into darkness or an occluding proxy.
  Do not spend geometry on inaccessible deep storage; keep it extensible.

---

## 11. Complement

Exactly eight, every one of them multi-functional:

1. captain — player character
2. master / first mate
3. boatswain and carpenter
4. able seaman
5. able seaman
6. sailor and cook
7. surgeon-naturalist
8. astronomer, illustrator, interpreter or scientific assistant

She must look capable of supporting eight, and feel **occupied and somewhat
crowded** when all are aboard. No accommodation for dozens of anonymous crew.

Eight is a hard constraint on interior volume **even with nobody rendered** —
berthing, headroom and deck spacing are sized by complement, so the number binds
the hull now rather than when characters arrive.

---

## 12. Stores and exchange items

**Do not use the phrase "trade goods."** She is not necessarily a commercial
trader and no commerce system is implied.

She may canonically carry small quantities of expedition supplies, diplomatic
gifts, scientific equipment, emergency exchange items, spare tools, cloth, iron
hardware, needles, knives and mirrors — objects suitable for formal gift-giving
or emergency barter. Represent these as **one or two generic secured chests**.

---

## 13. Armament

**The canonical vessel has no visible armament.** No carriage guns, gun ports,
swivel guns, muskets, pistols, ammunition stores, armoury, or combat-oriented
deck arrangement.

She may plausibly carry ordinary small arms in the fiction; they are not
represented. Optionally preserve two discreet reinforced rail positions where
swivel guns *could* be fitted in a later narrative variant — not visually
prominent.

**She must not signal naval combat, piracy or a weapons system to the player.**

---

## 14. The dinghy

One very small wooden tender, a separate named object, lashed securely aboard
with believable lifting eyes or sling points, positioned so a future launch
arrangement stays geometrically possible, and contributing clearly to the
silhouette.

Three authored states are eventually wanted — lashed aboard, absent while
ashore, floating alongside — with transitions by cut or fade. No launch or
recovery animation, no davit or tackle simulation, no controllable boat.

---

## 15. Lookout and climbable rigging

Ratlines on the foremast shrouds with credible hand and foot spacing; crosstrees
or a modest lower topmast platform; a small expedition-modified lookout position;
rope lifelines; room for one person to pause; unobstructed views of horizon and
deck. **9–11 m above the upper deck.**

No large barrel-shaped pirate crow's nest.

**Traversal is authored, not simulated.** The climb will use a ladder volume or
spline attached to the ship's reference frame — not physical hand placement on
individual ropes, not deforming rope traversal, not IK, not collision with every
ratline. The geometry must therefore carry named anchors: climb-start, one or
more transitions, and lookout-standing.

See §5.4 for why this location needs its own comfort work.

---

## 16. Materials, paint and weathering

A deliberate canonical aesthetic, not a suggestion.

**Exterior palette** — upper hull in dark tarred brown; wale strakes distinctly
darker; restrained muted-yellow or earthy ochre trim; warm weathered deck timber;
oiled timber masts and spars; darker mastheads; flax-grey or cream-grey
sailcloth; period ironwork, tar and hemp.

| Region | Colour | Linear lum. | Roughness |
|---|---|---:|---:|
| topsides | `0x3a2f27` tarred | ~3% | 0.52 |
| transom | `0x342a23` | ~2.5% | 0.52 |
| wales | `0x261e19` | ~1.5% | 0.48 |
| bootTop | `0x2b2521` | ~2% | 0.62 |
| belowWaterline | `0xb9b3a4` tallow | ~46% | 0.95 |
| deck | `0x8d7a5c` | ~20% | 0.94 |
| trim | `0x9c7b3a` | ~22% | 0.60 |
| inboardBulwark | `0x6d3b2d` | — | 0.85 |

**The palette is as dark as it reads, and it has now been blamed three times for
something that was never the paint.** The topsides sit near 3% linear
reflectance — darker than charcoal, exactly as "very dark tarred brown" implies.

*First:* during M1 she rendered as a featureless black silhouette. The cause was
that `scene.environment` was null and no material carried a reflection map, so a
dark glossy hull had nothing to reflect — and such a surface is mostly visible
because of the sky *in* it. *Second:* an attempt to fix that by lightening the
topsides to 15% **under that same broken lighting** produced a flat tan boat.

*Third, and the interesting one.* With the world lighting rebuilt — a
camera-independent radiance source, an L2 probe for diffuse, a PMREM for
specular, no ship-specific gain anywhere — the question could finally be asked
properly, so four palettes were rendered on a controlled sheet: three lights, one
frozen instant and one sea per row, so that along any row the only variable was
the paint. Oiled larch at ~16% won, and was adopted.

Then the display transform changed. ACES was replaced with a hue-preserving
curve, and measured, ACES had been removing 20-30% of the chroma from every
bright band. Re-rendering the same sheet reversed the verdict: tar stopped
reading as a black hole, because the curve that had been crushing it was gone,
and the larch that looked like warm timber under ACES now read light and tan —
the same failure the 15% experiment produced. So the palette came back here.

**A palette verdict is only valid under the display transform it was taken
through.** `src/vessel/schooner/shipPalettes.ts` keeps every candidate renderable, and
`schoonerViewer.paletteSheet()` re-renders the comparison, so the next time this
question comes up it can be re-measured rather than re-remembered.

**If she ever goes flat and black again, run `window.worldLightingAudit()` before
touching these values.** A source map of zeros publishes a black probe, and a
black probe is indistinguishable from a deliberately dark palette.

**Trail boards** — simple timber with *painted* ochre decoration. Painted
scrollwork or a restrained geometric flourish. No sculpted or procedurally
carved relief; it is expensive here and buys little.

**Below the waterline** — kept as a separate material region so its treatment can
be chosen later (pale protective composition, dark merchant coating, or early
copper sheathing if justified). **Do not commit to copper without a separate
decision** — it implies money and a naval or wealthy-institutional refit.

**Weathering** — she is operational and maintained: salt staining, faded paint,
worn deck boards, local tar stains, repaired planking, patched sails, mismatched
replacement timber, wear at working surfaces. Not rot, not abandonment, not
theatrical decay, not polished luxury timber.

---

## 17. Explicit visual exclusions

No skull-and-crossbones imagery, visible guns, broadside gun ports, pirate
styling, large crow's nest, ornate golden carving, towering stern structures,
three or more masts, topgallants, clipper features, modern yacht fittings,
unjustified steering wheel, modern glazing, electric lighting, modern beds,
hotel-like cabins, oversized figurehead, broad naval colour stripes, random
decorative rope, impossible rigging, overly narrow proportions, enormous sails,
implausibly thin spars, unrealistically empty deck, excessive deck clutter,
modern safety rails, or theatrical decay.

---

## 18. What this document deliberately does not cover

Sequencing, milestones, acceptance gates, the buoyancy rework, the character
controller, collision strategy, interior lighting zones, the performance budget,
and the migration away from the raft. All of that is `docs/ship/SHIP_ROUND_HANDOVER.md`.
