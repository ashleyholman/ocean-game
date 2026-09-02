# SURV2 scupper geometry and headless drainage foundation

Implemented 2026-08-18. This is the first bounded slice of SURV2. It authors
the physical drainage apertures and proves their one-way head calculation on
the existing 240 Hz water ledger. It does **not** yet wire scuppers to live body
pose and wave samples, draw holes in the bulwark, or claim the full SURV2 gate.

## What landed

`SchoonerScupperGeometry.ts` defines sixteen authored freeing slots: four in each of the
four existing fore/aft-side water-graph openings, hence eight per side. Every
slot is placed from the same `deckLevelAt`, `levelWalkingY`,
`bulwarkOuterHalfBeam`, wall thickness, and counter rake that place the drawn
deck and bulwark. There is no second guessed deck height or hull breadth.

Each slot is 0.42 m long by 0.13 m high. One aggregate graph edge therefore
has 0.2184 m² clear area; one vessel side has 0.4368 m². The slots are spread
through the quarterdeck, waist, and forecastle without crossing either deck
break, with closer spacing around the low part of the sheer.

The area has a named modern safety reference, not a retrospective certificate.
The 36-inch bulwark row in 46 CFR 171.150 gives 423.2 cm² of freeing-port area
per metre over the after two-thirds of a vessel. Applying that row to this
15.5 m hull gives 0.4373 m² per side; the authored geometry is within 0.2%.
That regulation describes a modern vessel class and is used only to keep a
provisional game geometry out of an arbitrary area regime.

Source: [46 CFR 171.150, historical official edition](https://www.govinfo.gov/content/pkg/CFR-1997-title46-vol7/pdf/CFR-1997-title46-vol7-part171.pdf).

## Hydraulic model

`SchoonerScupperDrainage.ts` receives explicit outside sea-surface world
heights along every physical aperture. It compares those samples with the
four-cell plan-area water surface and aperture sill after applying the
production attitude signs:

- positive roll lowers starboard;
- positive pitch lowers the bow;
- local-up projects onto world up as `cos(roll) cos(pitch)`.

The cell surface rises from the lowest sampled centreline/deck-edge control or
physical aperture endpoint rather than from the mean centroid of a multi-level
deck cell. High-level slots therefore stay dry until water reaches them, and
the uncapped hydraulic request approaches zero faster than the available-volume
ceiling as volume approaches zero.

For a vertical rectangular slot, the submerged portion sees constant
inside-minus-outside pressure head. The portion above the outside surface is a
free outfall and integrates

`width × integral(sqrt(2 g (insideY - y)), dy)`.

The resolver first clips the longitudinal interval at the exact linear
sill/water intersection. It then samples the outside wave at the endpoints of
eight fixed 52.5 mm panels, treats each short span as a chord, clips every
inside/outside head crossing, and uses eight-point Gauss-Legendre quadrature on
the remaining active pieces. Even a narrow wet sliver at one physical end is
therefore sampled, while pitch and bounded outside-wave variation are resolved
across all 0.42 m rather than only at the centre. The result is then multiplied
by `Cd = 0.61`. USBR
quotes about 0.61 for a fully contracted sharp-edged rectangular orifice. This
ship has a 90 mm timber passage rather than the reference apparatus, so the
coefficient is explicitly provisional, not fitted to a desired survival
outcome.

Source: [USBR Water Measurement Manual, orifice relationships](https://www.usbr.gov/tsc/techreferences/mands/wmm/chap02_08.html).

The graph edge remains one-way. If the outside sea surface meets or exceeds the
inside surface, requested drainage is exactly zero; the sea cannot enter through
a negative "drain" request. Boarding remains owned by overtopping contacts.
`ShipWaterState` independently caps simultaneous outlet requests by the water
actually present, closes external discharge in the mass ledger, and prevents a
cell going negative.

## Evidence

`tests/ship-scupper-drainage.test.ts` proves:

- sixteen finite, correctly sided apertures sit at canonical deck-edge sills;
- graph clear areas equal the physical aperture sums;
- per-side area is 0.4368 m² and stays within 0.2% of the named reference;
- a partly wet dry-outfall slot equals the analytic integral;
- a 0.7 rad pitched slot matches a 20,000-strip reference within 0.5%, and
  0.1–5 mm end slivers match a closed-form 2-D integral within `1e-5` relative;
- a smooth outside-wave crossing with only 5 mm positive head matches a
  20,000-strip reference within 0.5%;
- partial and full submergence reduce or stop discharge by outside head;
- the exact dry state returns one frozen result without sampling the sea, and
  epsilon volumes converge to zero requested flux;
- combined heel/pitch probes prove aperture endpoints make the source-volume
  cap a safety ceiling rather than the dry-limit drainage law;
- equal upright port/starboard cells drain equally;
- positive heel favours the lowered starboard side; and
- a three-second drain produces strict-equal complete ledgers at 30, 60, 120,
  and 240 Hz with conservation residual below `1e-12 m³`.

Focused verification at landing: 12/12 tests and whole-tree typecheck passed.

## Explicit boundaries and next step

- The slots are water geometry, not yet holes in the rendered bulwark mesh.
- The four-cell surface spreads volume over one plan area above the lowest
  sampled deck edge. It is not a resolved shallow-water sheet, local gutter
  cross-section, or wet-area integration.
- Outside wave height is a fixed eight-panel chord model across each 0.42 m
  slot, not an unbounded sub-aperture wave reconstruction.
- No production caller yet supplies substep body origin/attitude plus a wave
  height at all sixteen outlets.
- There is no blocked-scupper diagnostic arm or retained-low-side evidence run.
- No wash, downflooding, rain, pump, mass feedback, or capsize behaviour is
  implied by this slice.

The next SURV2 step is to sample each outlet's outside wave height at the same
body substep as deck transport, compose those four drainage requests into that
water step, and freeze the calm-drainage plus blocked/heel evidence matrix.
