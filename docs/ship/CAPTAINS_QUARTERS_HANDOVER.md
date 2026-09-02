# The captain's quarters — round handover

## Follow-up — 16 August 2026

The cabin has had a restrained period pass since the original round recorded
below:

- The light/dark chequer is gone. The runner is now a **plain iron-oxide
  red painted-canvas floorcloth**, with a rubbed central walking track, doubled
  hems, one sewn bolt seam and small tack heads. It is canvas, not a plush rug.
- A compact **leather-faced, brass-strapped sea chest** now occupies the port
  gap between the hanging press and chart desk. A face-down **tell-tale compass**
  hangs over the rudder trunk where the captain can read it from below.
- The desk instrument is no longer the familiar c.1800 three-tier boxed marine
  chronometer. It is a **Kendall K1/K2-like large pair-cased marine watch** in a
  shallow fitted travelling case, appropriate to a 1770s expedition and labelled
  in the room as the marine timekeeper.

The floorcloth is now **106 triangles**: 56 for the softly varied field and 50
for hems, seam, edge returns and tack heads. A geometry test locks the field to
one worn red hue so the checkerboard cannot return accidentally.

Unlike the original round's historical note below, this follow-up was visually
checked in the production cabin at afternoon light with the lanterns lit: the
runner reads as one worn red canvas, the chest keeps clear of the desk and press,
the timekeeper's round face is legible, and the tell-tale sits under the after
deckhead rather than through it.

Branch `claude/captain-cabin-furnishings-64bf66`, rebased onto master at
`954e826` — which is to say **after** the furniture-rotation round, whose
`align: 'side'` this now uses. Suite green (1162 passing, 94 files),
`tsc --noEmit` clean, `npm run build` clean.

**Nothing here has been looked at.** Ash's instruction for this round was that
visual verification is his, and no screenshot was taken. Everything below is
either measured off the geometry or asserted in the suite; none of it is a claim
about how the room looks.

## How to look at it

```bash
npm run dev
```

`?interiorView=desk` still opens seated at the desk — stand up (Space) and you
are in the middle of the room with all of it around you. Look at it **at night
with the lamp lit**, for the reason the desk round's handover gives: the cabin
lantern is what the joinery was built for.

```
__drift.world.state.worldSecondsPerRealSecond = 0
__drift.world.state.worldInstantUtcSeconds += 3600*3
__drift.setLamps('on')
```

## What landed

| | |
| --- | --- |
| **F1** | The after bulkhead panelled, and two stern lockers across the transom |
| **F2** | The box berth, starboard, head aft — drawers, lee board, bedding, curtain |
| **F3** | Washstand in the starboard forward corner; hanging locker port, against the forward bulkhead; bookshelf over the foot of the berth |
| **F4** | The painted canvas floorcloth down the lane (now plain worn red, not chequered) |
| **F5** | The chronometer, on the desk, reading the world clock, and it opens |
| **F6** | The captain's sea chest and the face-down tell-tale compass |

Two new materials — `linen` and `wool` — the first soft things aboard. The wool
is madder red and is the only saturated colour below decks; that is deliberate
and it is the one thing in the room that is not a shade of the wall.

## The measurements that decided things

- **The stern lockers are 0.48 m, not 0.42.** The window sills are 1.243 m above
  the sole and a seated eye is 0.78 m above its seat, so a chair-height locker
  puts the eye 43 mm *below* the sill and the only thing through the glass is
  sky. At 0.48 the eye is 17 mm above it. No seated station is built on them —
  Ash's call is that you stand to look out — but the piece is not a joke.
- **The lockers' lids run aft past the sole's own edge** to meet the raked
  lining, and their carcases do not. The wall is plumb for its first 0.16 m and
  then rakes; a carcase run back to the lining's height at 0.48 would be standing
  on 98 mm of nothing.
- **Everything against the ship's side lies along it.** Measured, worst gap
  between a piece's outboard timber and the lining:

  | | square | turned |
  |---|---|---|
  | berth (1.90 m) | 0.230 m | **0.024 m** |
  | bookshelf (0.82 m) | ~0.10 m | **0.017 m** |
  | washstand (0.58 m) | ~0.07 m | **0.020 m** |
  | hanging locker (0.74 m) | ~0.09 m | **<0.001 m** |

  The stern lockers stay square: they stand against the *transom*, and a yaw
  would turn them out of parallel with the wall they are built against.
- **The bedding does not follow the taper and the boards do.** A mattress is a
  sewn rectangle that was carried down the companionway; it lies against the side
  at one end and leaves a little board showing at the other, which is what a real
  one does.
- **The hanging locker's height is derived**, not typed: the lowest deckhead over
  its own footprint less a hand's breadth. It came out 1.728 m.
- Panelling costs **230 triangles**. The original chequered floorcloth cost 60;
  the constructed plain canvas in the follow-up above costs **106**.

## Faults found by building, worth remembering

1. **Port and starboard invert which face is outboard.** `RoomPlacement` reports
   `xLo`/`xHi` as a span; to port the outboard face is `xHi`, to starboard it is
   `xLo`. Every existing piece in this cabin was a port piece, so the washstand
   — copied from them onto the other side — hung its splashback in the middle of
   the room and its towel rail inside the hull. **Nothing threw and no test
   failed.** The piece was simply built inside out. Both starboard pieces now name
   the two faces instead of remembering which is which.
2. **The berth's bunk bottom went through the ship.** One board across both bays
   at the wider bay's width stood 92 mm outboard of the frames at the head —
   invisible from inside the room, because the wrong part was behind the mattress
   and inside the lining. This is the fault `tests/captains-quarters.test.ts`
   exists for.
3. **`addTube` sweeps a solid tube, so there is no ring in this vocabulary.**
   The chronometer's gimbal ring was drawn as a bar and was a 0.15 m cylinder
   lying across the dial, hiding the one pale surface the object has. Caught by
   `ship-interior.test.ts`'s existing "desk items are boxes" assertion, which
   turned out to be a better rule than the reason written on it.
4. **The floorcloth was one line inside the wrong scope.** Its natural home was
   inside `addPanel`, beside the planking it lies on, where it would have been
   right for exactly as long as the cabin has no hole in its floor — the wardroom
   is laid in five panels because it has two.
5. **Two of the new tests were wrong in instructive ways.** A collider does *not*
   have to reach the sole to stop a body (the walker is a full-height cylinder;
   the desk's own carcase starts 75 mm up too), and a square-cut edge scribed to a
   raked wall is *supposed* to be buried in the lining — the line it may not cross
   is the moulded transom, 60 mm further out.

## The barometer, and why there is not one

Ash's condition was that an instrument must actually work. **There is no
atmospheric pressure anywhere in the world model** — grepped, not assumed. The
mean wind comes from a sea-state preset that does not evolve, and the gusts are a
pure function of time with 8–240 second periods. A barometer's entire job is to
*lead* the weather by hours and there is no weather that changes over hours for
it to lead; built now it would read a number invented on the spot, which is the
white circle on the wall from the desk round with a better face.

It wants a weather round first: a slow pressure series driving mean wind and sea
state, on the same deterministic-function-of-time pattern `WorldWind` already
uses. After that the barometer is an afternoon's work.

The chronometer needs none of that, which is why it is the one that went in. It
reads `worldInstantUtcSeconds` and the ship's longitude off the live navigation
telemetry, and the open view shows Greenwich mean time, ship's mean time, and the
longitude the difference implies — mean time and labelled as such, because the
equation of time is real and a figure quietly called "apparent" that is not would
be worse than one that says which it is.

## Deliberately not in this round

- **Deadlights** — shutters over the glass in heavy weather. `deckInterior.ts`
  names these as the honest answer to a following sea and calls them a debt the
  furnishing pass owes, so they are still owed and they are the obvious next
  piece. The closure table already has the machinery.
- **A mirror over the washstand.** It wants a reflective material, and a pale
  disc on a wall is the barometer's own failure.
- **A swinging cot**, curtains as simulated cloth, a seated station at the stern
  lockers.
- **The timber.** The floorcloth gives the room one rectangle that is not made of
  wood. It is not the materials round and should not be counted as one.

## What the rebase onto the rotation round changed

Master gained `align: 'side'` while this was out, and it is used here rather
than merely coexisting with it.

- **The berth's two-bay carcase is deleted.** It was the right answer to the
  taper before the piece could turn — 0.138 m against a square box's 0.230 —
  and turning it gets 0.024 m from one box instead of two, with no lapped bunk
  bottom, no per-bay end boards, and nothing that can be sized to the wrong bay.
  Two mechanisms for one taper in one room is how somebody ends up fixing the
  wrong one.
- **The shelf, the washstand and the press turn too**, each for its own reason,
  written on each. The shelf has the least choice: it is screwed *to* the lining,
  and a square shelf on a curving one has nothing at its far end to screw into.
- **Two latent frame bugs surfaced, and one of them was master's.**
  `ship-interior.test.ts` compared a solid's *ship-frame* centre against the
  desk's *own-frame* well bounds. That was right by coincidence while the desk
  was square and stayed right after it turned only because the manual sits near
  the pivot, where the displacement is small. Adding a second desk item out at
  the forward corner failed it, and the item was innocent. `roomFitting.ts` now
  exports `shipToFrame` — the inverse, written once, because writing it by hand
  at the point of use produced `cos(−yaw), sin(−yaw)` fed through the forward
  expression, which is that expression again rather than its inverse.
- **This file's own test helper unpacked boxes by hand** as centre ± half and so
  quietly understated where the turned berth's timber was — in the direction that
  passes. It goes through `boxCorners` now.
- **The floorcloth was reading two `xInboard` values from two different frames.**
  Both come back through `frameToShip` at the station the cloth covers.

The transom panelling is unaffected and stays lofted: that round's rotation is a
*yaw*, and the after wall needs a *pitch*. `cabinJoinery.ts` says so explicitly.

## Files worth reading first

- `src/vessel/schooner/cabinFurniture.ts` — the berth, the lockers, the stand,
  the press, the shelf, and why the taper is fought in some places and allowed to
  show in others
- `src/vessel/schooner/cabinJoinery.ts` — the two surfaces that cannot be boxes,
  and why
- `tests/captains-quarters.test.ts` — the invariants a room full of built-in
  joinery has that a room with one desk in it did not
