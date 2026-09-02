# Night lighting below decks — the round after the daylight model

Written at the close of the interior lighting round (2026-08-12), for the
session that builds the warm night interior Ash asked for. Read
`SHIP_INTERIOR_HANDOVER.md` §15 first: it describes the machinery this round
plugs into, and the fault history that shaped it.

## 1. What you inherit, and why it was built this way

The daylight round left the interior lit by a **portal/room graph**
(`src/vessel/schooner/interiorLight.ts`):

- Four **channels** of light, one per family of opening — companionway,
  cargo-hatch grating, stern windows, hold boards. Each channel is one RGB
  irradiance uniform per frame; everything geometric (form factors to the
  openings, doorway glow, the room-to-room radiosity transfer) is **baked
  per vertex** at build time (`interiorLightBake.ts`).
- The channel uniforms are fed from the live sky probe plus the sun's beam
  flux (`Schooner.publishPortalLight`). Nothing below decks has a
  time-of-day curve: **the interior reddens at sunset and dies at dark
  because the sky does.** That dying is this round's starting gun — the spec
  (§9) wants the lantern to take over as the room's light, and the handover
  moment is already physical.
- **Eye adaptation** (`INTERIOR_EYE_ADAPTATION_GAIN` in `Schooner.ts`) opens
  the exposure ~3.3 stops below decks, low-passed like the sky meter. At
  night this is the term that will make a single lantern read as *enough*;
  its interaction with flame brightness is a look decision that does not
  exist until the lantern does.
- **Portal culling**: when no opening is on screen from above deck, nothing
  below decks renders. A lantern's light must not resurrect hidden meshes —
  it does not: the lantern lights what is drawn, and what is drawn is decided
  by the camera, not the light.

The deck lamp (`scene/Lamp.ts`) is the proven pattern for a flame: a real
`PointLight` through the shared PBR path, shadow faces on
`LANTERN_SHADOW_LAYER`, flicker driven in one place, no per-object gain.

## 2. What this round builds

1. **The gimballed cabin lantern, and its siblings.** `SHIP_SPEC.md` §9 names
   the cabin's; the landing and wardroom likely each carry one plain lantern.
   They are interior fittings — place them through `interiorFittings.ts`'s
   anchoring system so furniture and light move together — and interactables:
   Space lights and douses them (`shipInteractables.ts` has the mechanism and
   `UsePrompt` the interface; the boards are the worked example).
2. **One real light per occupied room, ambient for the rest.** A
   `PointLight` with shadow faces is the room-you-are-in experience; three of
   them is a frame-time problem. The room graph is the cheap half: a lit
   lantern in the landing contributes flux to the landing's budget and leaks
   through the doorways exactly as daylight does — see §3 for the one piece
   of plumbing that needs adding.
3. **Glow through the openings, both directions.** Lantern light up the
   companionway onto the deck at night, and — the beauty shot — the stern
   windows warm over a dark sea. The portal rectangles are the source of
   truth for where that glow lives; the exterior expression (emissive
   glazing, a soft light spill on the counter) is this round's craft.
4. **The dusk handover, judged by eye.** Sail her through sunset with the
   lantern lit: the shaft light dies, the flame takes the room. No code
   should be needed for the handover itself — if it is, something upstream
   broke.

## 3. The one missing piece of plumbing, specced

The baked bounce attributes are **per sky-portal channel**, so a lantern
cannot ride them: its room's ambient response is baked against the wrong
source direction set — and there is no channel whose uniform it could borrow
without also lighting other rooms through that channel's own attributes.

The clean plug is **one more vec4 attribute: per-room ambient bath weights.**
The bake already computes the bath (`1 − ΣF` in
`interiorLight.vertexLightResponse`); writing it per *room* instead of folded
per *channel* gives the shader `aRoomBath[roomIndex]`, and the runtime a
`uRoomAmbient[5]` (cabin, landing, wardroom, forecastle, hold) that ANY
source can pay into:

    uRoomAmbient[r] = Σ_lanterns transfer-ish(r, lantern) × flameRadiance

with the room-to-room spill using the same doorway couplings
`interiorLight.solveTransfer` already builds (expose the solve's matrix, or
re-run it with the lantern's room as the input — it is a 4×4). ~30 lines in
the bake, one uniform array in `WorldPbrMaterial`, and the daylight path is
untouched. Do NOT try to fake it by adding lantern light into the sky
channels: their attributes encode *where the sky's openings are*, and a
lantern is not an opening.

## 4. Numbers and cautions

- **The flame's radiance should come from the deck lamp's**, not be chosen
  fresh: one flame, one physics. If the cabin lantern reads wrong at the
  same radiance, the difference is enclosure, and the room model is the
  thing to interrogate.
- **Shadow budget**: the deck lamp's six faces at 256 px are the precedent.
  One interior lantern casting real shadows (the ladder! the mast through
  the wardroom!) is likely affordable if only the occupied room's lantern
  casts; measure before committing to more.
- **The interior stencil** (`interiorStencil.ts`): new interior meshes must
  `markAsInterior` and take `INTERIOR_RENDER_ORDER`, or the sea will draw
  over the lantern through the hull at night.
- **Every new interior geometry must be baked** (`bakeEnclosedPortalLight`)
  — a portal-lit material over an unbaked geometry reads WebGL's (0,0,0,1)
  attribute default and lights itself with the hold's channel. The
  runtime test suite (`interior-light-runtime.test.ts`) enumerates and will
  catch it.
- **Adaptation at night**: the gain currently keys only on "below decks".
  A lit lantern arguably *reduces* dark adaptation; if the night look
  fights the constant, that is the moment to switch adaptation to metering
  the solved room ambient (§15.4.1 of the interior handover) rather than to
  grow a second constant.

## 5. What was deliberately not started

- No moon in the sky probe yet (the moon pass is specced from the
  lantern/night round of the world lighting thread). When it lands,
  moonlight down the hatch arrives through the portal channels with no
  interior work at all — that is the test of whether this round kept the
  machinery clean.
- Deadlights (stern-window shutters) are furnishing; when they exist they
  gate the windows channel the way the boards gate the hold's.
- The peak and the sealed under-floor compartments stay dark. They are
  sealed; a lantern cannot be carried in; nothing to do.
