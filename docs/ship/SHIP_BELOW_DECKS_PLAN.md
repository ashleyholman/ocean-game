# Below decks — the arrangement, and the argument for it

**Status: agreed with Ash on 2026-08-10 and BUILT the same day.** Every room,
floor, bulkhead, doorway, step and the hatchway shaft are standing and walkable;
`docs/ship/SHIP_INTERIOR_HANDOVER.md` section 9 is what the build found, and it
is the authority on the parts of this that changed under measurement. **The
furniture in section 4 is still indicative and still wants Ash's eye** — see
section 7.

The drawing is now generated from the built ship rather than from a copy of this
plan, so if it disagrees with the prose below, the drawing is right.

![the arrangement](below-decks-arrangement.svg)

Redraw it with `npm run ship:belowdecks` after moving any bulkhead.

---

## 1. The fault this round started from

M4 left the cabin as the only room below decks, and the first plan drawn this
round kept the historically ordinary arrangement: accommodation at the two ends,
the hold open in the middle from the keelson to the deck beams.

**That was wrong, and it was wrong by arithmetic rather than by taste.** The
question "how much of the hold do the stores actually need?" had never been
asked. Asked:

| | volume |
|---|---|
| iron ballast, 28.0 t at 4200 kg/m³ stowed | 6.7 m³ |
| fresh water, 9.0 t in casks at ~64% stowage efficiency | 14.1 m³ |
| salt provisions and dry stores, 4.2 t packed | 9.3 m³ |
| **needed** | **30.1 m³** |
| hull volume below y = 2.00 between z −2.4 and +2.6 | **32.4 m³** |

The stores already fitted under a floor at 2.00 m with 2.3 m³ to spare. There
was **1.70 m of unused air** sitting above the cargo along the widest five
metres of the ship, and the first plan gave it away for nothing.

---

## 2. The platform deck, and whether it is honest

A floor over the hold is a **platform deck**. On a working 47-ton schooner in
trade it would be wrong: her hold is open top to bottom because cargo is bulky
and is struck down through the hatch, and the accommodation lives at the ends.

**On a converted expedition vessel it is not merely allowed, it is the defining
move of the conversion.** Exploring ships were bought-in merchant hulls, and
fitting them out consisted precisely of putting platforms and cabins into what
had been cargo space, to house people the hull was never built for. Cook's
*Endeavour* was a Whitby collier and had an entire extra deck added in her 1768
fitting-out to accommodate 94.

`docs/ship/SHIP_SPEC.md` §1 already says she "began as a robust coastal merchant
or colonial packet and was bought or chartered into expedition service." **The
platform is what that sentence means in timber.** It is not an invention; it is
the thing the backstory was implying and nobody had drawn.

**HMS *Beagle* is the closer precedent** — a converted survey brig carrying a
scientific party, which is our fiction exactly. Her lower deck ran: captain's
cabin at the stern, bread stowed in the awkward space around it, a passage
leading forward with sleeping spaces marked off **along one side** for the
master and surgeon, the mess in the centre, and the steward's room, spirit room,
well and gunner's store **grouped near the mainmast**. Section 4 below is that
arrangement on our hull.

**The one place we are more comfortable than the record.** *Beagle*'s midship
headroom was 63 inches — 1.60 m. Ours is 1.84–2.06. That is the same restrained
gameplay easing §6 already spends on the cabin, and it is deliberate. If it ever
reads as too roomy, the lever is the floor height in §5, not the hull.

---

## 3. The two decisions Ash made

**The floor goes at 1.80 m, not 2.00 m.** 2.00 is free but gives 1.73–1.86 m,
which is head-down at the sides. 1.80 gives 1.84–2.06 and costs 4.7 m³ of
stowage.

**That 4.7 m³ is paid for by cutting fresh water from 9.0 t to 4.8 t** — from
281 days of endurance at 4 L/person/day to 150, which is still long for a vessel
that watered every few months. It is a strict win twice over:

| water | ballast to close Archimedes | KG | water + iron volume |
|---|---|---|---|
| 9000 kg (281 days) | 28,025 kg | 1.936 | 20.7 m³ |
| 4800 kg (150 days) | 32,225 kg | **1.898** | **15.2 m³** |

The ballast solve replaces the removed water with iron, and iron at 4200 kg/m³
in place of casked water at ~640 stows in a quarter of the volume and sits
lower. **She gets 5.5 m³ of hold back and 38 mm of KG with it** — stiffer, not
tenderer. Re-run from `massModel.buildLightship()` with the water item edited;
the figures above are measured, not estimated.

Stores then need 24.5 m³ against 27.7 m³ under a 1.80 floor: **13% margin.**

---

## 4. The arrangement

Five spaces, three floor heights, and a route from the transom to the stem
without going on deck.

| | space | z | floor | headroom | area |
|---|---|---|---|---|---|
| 1 | captain's cabin | −7.79 → −4.3 | 2.45 | 1.90–2.13 | 9.3 m² |
| 2 | pantry, ladder, spirit locker | −4.3 → −2.4 | 2.45 | 1.83–1.90 | 6.4 m² |
| 3 | wardroom | −2.4 → +2.6 | 1.80 | 1.84–2.06 | 21.0 m² |
| 4 | forecastle | +2.6 → +6.2 | 2.05 | 1.81–2.33 | 12.6 m² |
| 5 | peak | +6.2 → stem | — | — | ~1.7 m² |

**49.3 m² of walkable floor, against the 9.37 m² that exists today.**

Two steps down at the −2.4 bulkhead and one step up at +2.6. Doors through both.

### 4.1 The captain's cabin

Runs aft to the transom, which is where §3's "three to five small cabin windows"
have to go if the exterior is not to be lying. **Four**, in two pairs either side
of the rudder trunk: the stock comes up vertically at z = −7.75 while the transom
rakes aft at 18°, so it stands 0–0.6 m inside the after end and wants a boxed
casing. Cushioned bench across the transom either side of it.

**The furniture is at the sides and the centreline is kept clear, and that is
§6 being obeyed rather than a space left over.** §6 fixes ~1.85 m of standing
height on the *central strip only*, 1.55–1.70 m tapering at the sides, and says
in terms that furniture and the berth go under the low peripheral portions. So:
chart desk and drawers along the port side **facing inboard with a seat in front
of it**; box berth along the starboard side; washstand and sea chest in the
forward corners; the middle left clear because it is the only place a man
straightens up.

At 9.3 m² this is 1.5 m² larger than the first draft and 0.1 m² smaller than
what M4 built. It is the ceiling: the forward bulkhead cannot go past −4.3
without the ladder no longer fitting in the landing. If the ladder ever moves
out of the after end entirely the cabin could take everything abaft the
quarterdeck break — 15.7 m² — and that reads as the floating mansion §3 forbids.

### 4.2 The pantry, the ladder and the spirit locker

**The companionway currently lands in the middle of the captain's cabin.** §9's
first word about that room is "private". This space is the fix: you come down
into a landing with the cabin door aft.

Steward's pantry to port — crockery, the captain's stores, where meals are
dished. Lockable spirit locker to starboard. Oilskin hooks by the door. The
ladder between them, on the centreline.

### 4.3 The wardroom

The room the ship did not have, and the one the game will mostly happen in.

- **Mate's cabin** to port and **surgeon's cabin** to starboard, ~2.4 m² each,
  real rooms with real doors: berth against the ship's side, chest, hooks. The
  surgeon's chest lives in his. **There is no dedicated sick berth** on a vessel
  of eight — a cot is slung in the wardroom, which is also where he would
  operate.
- **The table** amidships on the centreline, aft of the hatchway. All eight eat
  here in two sittings; charts and specimens are worked here.
- **The after bay carries the working gear**: the mainmast at z −1.9, the pump
  well at z −1.35, expedition chests and ship's stores along both sides. This is
  *Beagle*'s "grouped near the main mast", and it is where the noise and the wet
  belong — away from the berths.

The mainmast passes through this room. That is a feature.

### 4.3.1 The hatchway is a shaft, and it decides the room

**The platform's hatchway takes the same footprint as the deck's cargo hatch and
sits directly under it** — z +0.5 to +2.3, 1.5 m across. That is not tidiness;
it is the only way the loading works. A full water cask is 400–500 kg and is
lowered on a whip from a stay or yard: it has to fall down one straight vertical
line from the sky to the stow, through both openings at once. Hatchways on
successive decks were aligned for exactly this reason, with pillars at the
corners of the opening carrying the interrupted beams.

So **the deck's cargo hatch is needed more now, not less.** It is the head of a
two-deck shaft, and it is also the wardroom's only daylight and ventilation —
without it the room is a sealed box.

**An earlier draft of this plan drew the two hatches offset and different
sizes.** That was wrong and it is worth recording as the shape of the mistake:
the deck hatch was treated as decoration on the deck rather than as the top of a
route through the ship.

The opening is boarded flush and walked on, the way M3's cargo-hatch grating
already is; you lift the boards to strike stores down. **That is what makes the
arrangement work at all** — the hatchway occupies the centre of the wardroom's
forward half, so the mate's and surgeon's cabins flank it and the passage
crosses over it. Nothing can be built in that footprint at any level.

### 4.4 The forecastle

**Four hands, not six.** The complement in §11 includes a surgeon-naturalist and
an astronomer-illustrator: those are the scientific party, they are afterguard,
and they do not sleep in the crew's quarters. Forward berth the boatswain and
carpenter, two able seamen and the cook. **12.6 m² for four is 3.1 m² each**,
which is generous for a period forecastle.

The **galley** is here, at the aft end against the bulkhead, with its dresser —
shelving, preparation surface, secured pots — opposite. That placement is not a
guess twice over: 18th–19th century vessels carried the galley in the forecastle,
and `massModel.ts` already weighs the galley hearth at z = +2.6.

Sea chests round the walls, doubling as the seating, and a hinged table at the
foremast. The foremast passes through between the ladder and the berths.

### 4.5 The peak, and everything under the floors

Nothing is unaccounted for:

| volume | contents |
|---|---|
| the peak, forward of +6.2 | **sail room and boatswain's store** — spare sails, cordage, blocks, the carpenter's gear |
| under the forecastle floor | **cable tier** — the anchor cable, which `massModel` already places at y 1.5, z 4.4 |
| under the wardroom floor | **the hold** — iron ballast on the floors, water casks, then salt provisions and dry stores |
| under the captain's and landing floors | **bread room and lazarette** — dry provisions, in the space *Beagle* used for exactly this |

Stowage is a craft, not a pile, and it is worth drawing as one: ballast pigs
between the frames, dunnage over them, then casks on their sides in tiers, each
upper cask nested in the hollow between two below and chocked with wooden
wedges, the whole mass rammed solid so nothing can shift. What you see down the
hatch is a honeycomb of cask ends in the dark. One cask, instanced.

---

## 5. Constants this moved — all landed

| constant | was | is | why |
|---|---|---|---|
| `CABIN_AFT_Z` | −6.6 | `transomPlacedZ(2.45)` = −7.799 | stern windows §3 already promised |
| `CABIN_FORWARD_Z` | −3.4 | −4.3 | makes room for the landing |
| `COMPANION_AFT_Z` | −5.4 | −4.15 | out of the captain's room |
| `COMPANION_FORWARD_Z` | −3.7 | −3.0 | with it |
| `COMPANION_RISERS` | 7 | 7, at 0.287 m | the drop is 2.012 m; tread is now 0.117 m and the flight 71° |
| — | — | `PLATFORM_SOLE_Y = 1.80` | new |
| — | — | `PLATFORM_AFT_Z = QUARTERDECK_FORWARD_Z`, `PLATFORM_FORWARD_Z = +2.6` | new; the after one is *derived*, because a bulkhead under a deck break is where the ceiling changes |
| — | — | `FORECASTLE_SOLE_Y = 2.05`, `FORECASTLE_FORWARD_Z = +6.2` | new |
| — | — | `DOORWAY_OFFSET = 0.75` | new, and it was not in this plan — see §6 |
| `massModel` fresh water | 9000 kg | 4800 kg | §3; ballast 28.0 → 31.4 t, KG 1.936 → 1.887, GM 0.660 |

**Measured against this plan's predictions:** cabin 9.29 m² (9.3), landing
6.44 (6.4), wardroom 21.02 (21.0), forecastle 12.57 (12.6), total **49.32 m²**
against 49.3. The plan's drawing tool and the ship read one width function, which
is why.

---

## 6. Findings for the code — all closed, plus three the build turned up

### 6.1 What the build found that this plan did not

**The doorways cannot be on the centreline, because both masts are.** This plan
put no x on its doors and section 4.3 says the passage "crosses over the boards",
which reads as amidships; the drawing had them off-centre and the drawing was
right. The mainmast passes through the wardroom at z = −1.9, **0.5 m from the
after bulkhead**, and a body of 0.26 m radius keeps 0.44 m from a mast and 0.29 m
from a bulkhead — so that corner needs 0.73 m of clearance and has 0.5 m. The
walk found it rather than the drawing: she crossed the wardroom, was pushed round
the mainmast, and was then wedged between the two with no way aft. `DOORWAY_OFFSET`
is 0.75 m, to starboard aft and to port forward, and the passage dog-legs — which
is what a below-decks passage on a vessel with masts through it always does.

**Four stern windows at the exterior's own size do not fit the room.** The shell
at the after perpendicular is 1.32 m in half-breadth at sill height, but the
*room* is 1.136: the quarterdeck overhead is narrower than the hull under it and
the lining takes another 60 mm. Two windows of the exterior's 0.42 m width would
not fit between the rudder trunk and the ship's side with any timber between
them. They are 0.34 × 0.44 instead — taller and narrower, which is also what a
stern light of the period looks like.

**The cabin's after wall is plumb where the transom rakes.** Following the rake
would carry the ceiling out over a wedge of counter that has no floor under it.
Carried up plumb, the wedge is dead space behind the panelling — which is what it
is on a real ship — and each window sits in a 0.29 m reveal, which is what a
stern window on a raked transom looks like from inside.

### 6.2 The findings this plan listed, and what happened to them

**The companion ladder is a domestic stair, not a ship's ladder.** A ship's
ladder at 60–65° needs about 1.15 m of run for the 2.03 m drop; the built one
takes 1.7 m. `docs/ship/SHIP_INTERIOR_HANDOVER.md` already owed this resize —
it is now also a plan constraint, because the landing is only 1.9 m long and
the deck opening shortens with it.

**The bilge pump is drawn in one place and weighed in another.** `deckFittings.ts`
puts it at `PUMP_Z = MAINMAST_Z + 0.55` = −1.35, and its own comment says why:
*"A pump stands at the mast because the well is there."* `massModel.ts` weighs
it with `onDeck('bilge pump', 130, 0.6, 0.45)` — z = +0.6, **1.95 m out of
place.** At 130 kg it is about 3 mm of LCG and nothing will look wrong, which is
exactly why it survived. It is the same fault as `hullForm.cabinHeadroomAt` and
`INDEX_Y_LO` before it: **two sources for one position.**

**`massModel.belowDecks()` has one below-decks datum baked into a helper.** It
returns `CABIN_SOLE_Y + above`, and there are three floors now. Three items hang
off it forward of the cabin — joinery forward, joinery amidships, the galley
hearth — and they sit 0.40–0.45 m too high, about 13 mm of KG in the safe
direction. The helper needs the floor passed in, the way `standAt` had to take
`reachY` in M4.

**The platform deck has weight nobody has counted.** 21 m² of planking on beams
with stanchions is on the order of 1.2–1.5 t at y ≈ 1.8, and the ballast solve
has not seen it. Add it before trusting the KG figure in §3.

---

## 7. Still open

> **Ash walked her on 2026-08-11 and found nine faults; they are fixed and the
> account is `docs/ship/SHIP_INTERIOR_HANDOVER.md` section 10.** Three items in
> the list below moved as a result and say so where they stand. What that round
> changed in this plan's own numbers: **nothing in section 4 or 5** — the sole
> areas, the floor heights and the bulkhead stations are all as published. The
> cabin's after *wall* now rakes with the transom (handover section 10.7), which
> gives the room 0.67 m of length at head height without moving its floor.

> **The hold is built, and the pump reaches it — 2026-08-11.** See
> `docs/ship/SHIP_INTERIOR_HANDOVER.md` section 13. What that round changed in
> this plan's numbers: **nothing**. The stow it draws is this section's own
> arithmetic made visible — ballast solved to y 0.880, dunnage, then casks in
> two nested tiers to 1.770 under a sole at 1.800. §4.5's "honeycomb of cask
> ends in the dark" is standing, and the hatchway's working well is **0.870 m**
> clear, which a body crosses on its hands and knees.

- ~~**Furniture placement is indicative and nothing is built.**~~ **Superseded
  on 2026-08-17** for the captain's cabin (which was furnished across three
  earlier rounds) and now for the wardroom and the forecastle —
  `docs/ship/SHIP_INTERIOR_HANDOVER.md` section 21 is the account. What was
  true and stays true is the last clause: **the arrangement still wants Ash's
  eye**, and rather more than before, because it is now built rather than
  drawn. What that round changed in this plan's own numbers: **nothing in
  section 4 or 5**, but three of §4.3's and §4.4's indicative dimensions did
  not survive contact and the handover names each with the fixture that took
  it — the mate's cabin is 0.80 m inside rather than 1.25, the forecastle's
  hinged leaf is 0.54 m across rather than the drawing's, and the galley's
  dresser is one station forward of "opposite". The landing is the one room
  below decks with nothing built in it.
- **The astronomer has no door** — a curtained berth in the wardroom as drawn.
  Turning the instrument press into a third cabin is the alternative. **Still
  open, and now with a place to put it**: the wardroom's after bay is where a
  cot would sling, between the chest runs and clear of the mess table.
- ~~**Interior lighting is untouched, and is now the front of the queue.**~~
  **Superseded — four lighting rounds have landed since this was written.** The
  night round (`docs/ship/NIGHT_LIGHTING_HANDOVER.md`), the portal bake, the
  lanterns and the interior-lighting round in
  `docs/ship/SHIP_INTERIOR_HANDOVER.md` section 20 between them replaced the
  single scalar this paragraph is about: **`INTERIOR_SKY_VISIBILITY` no longer
  exists.** What answers the same question now is five `LIGHT_CHANNELS`, one per
  opening, each gated by whether its own closure is shut — which is why the
  forecastle goes dark when the fore scuttle's lid goes on. The prediction in
  the last sentence was right and is now the *reason* the lanterns are where
  they are: the wardroom carries two and the forecastle one, hung on Ash's own
  ray marks.

  It also turned out to constrain the furniture, which nobody expected. Every
  full deck beam in the forward two thirds of the wardroom is cut by the
  hatchway, so the room's forward lantern hangs on the one beam stub outboard of
  the carlings — the same deckhead the mate's cabin wanted. The lamp kept it.
  See handover section 21.
- **The crew have no way on deck of their own.** The drawing shows a ladder in
  the forecastle and there is nowhere to put its hatch: the cargo hatch's coaming
  ends at +2.39, the fore fife rail crosses the centreline at +3.48, and the
  foremast is at +4.10 — the longest clear run on the centreline between the
  forecastle's after bulkhead and the mast is 0.66 m, against the 1.15 m the
  companionway needs. **The fore rail did not move on 2026-08-11** — only the
  main one did, and for the opposite reason — so this is unchanged. ~~**Not
  built, deliberately**~~: the alternatives were a scuttle offset to one side
  (which fits at x ≈ 1.35 and is period-normal) or moving the fife rail, and
  both are changes to the weather deck that were not part of this plan.

  **Superseded — the fore scuttle is built.** Ash took the first alternative,
  and `docs/ship/SHIP_INTERIOR_HANDOVER.md` section 18 is the account: the
  scuttle is cut at x −1.100, z +3.000, 0.75 m square, with a hinged lid on a
  coaming, a seven-rung ladder spiked to its after coaming and a soffit that is
  the forecastle's ceiling while the lid is on. The crew have their own way on
  deck and the paragraph above is history rather than a plan. It cost the
  forecastle's furniture one move: the galley's dresser is now forward of the
  scuttle instead of opposite the hearth, because the ladder stands where §4.4
  drew the dresser.
- **The walker's `crouchHeight` and eye-ducking now fire — and in a second place
  nobody had counted on.** The landing-to-wardroom doorway is 1.263 m of clear
  opening, so a body ducks through it; that is what the arrangement honestly
  gives and Ash accepted it, but the eye drops abruptly at the bulkhead rather
  than over the approach. See handover section 10.5.
- **The walker's `crouchHeight` and eye-ducking now fire.** Measured minima on
  the centreline: cabin 1.874, landing 1.822, wardroom 1.921, forecastle 1.807.
  At the sides: 1.816 / 1.755 / 1.848 / **1.728**. The forecastle's 1.728 m at the
  side is under the 1.75 m body, so the duck is exercised for the first time.
  Expect it to be wrong.

---

## 8. Tools

`npm run ship:belowdecks` redraws `below-decks-arrangement.svg` from the hull's
own offsets. The room-width function in it is the check on itself: asked for the
cabin M4 built, it returns 9.37 m², which is the figure that round measured.
