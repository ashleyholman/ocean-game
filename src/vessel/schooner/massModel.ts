import {
  CABIN_SOLE_Y,
  DESIGN_DRAUGHT,
  FORECASTLE_SOLE_Y,
  PLATFORM_SOLE_Y,
  HALF_LENGTH,
  bulwarkTopY,
  deckAtSideY,
  deckLevelRise,
  maxHalfBeamAt,
  stationOffsets,
  walkingDeckY,
} from './hullForm';
import {
  backboneAreaAt,
  backboneBottomY,
  backboneTopY,
  rudderAreaAt,
  rudderBottomY,
  rudderTopY,
} from './backbone';
import { RHO_WATER, displacedVolume, hullStations } from './hydrostatics';
import { PUMP_Z } from './deckFittings';
import { belowDecksSpace, spaceSoleArea } from './deckInterior';
import { createSectionImmersion } from './hullSection';

/**
 * The schooner's canonical mass budget.
 *
 * `docs/ship/SHIP_SPEC.md` section 4.4 fixes the rule this file exists to obey: ballast is
 * a feel parameter, but a coherent one. So nothing here is a lump labelled
 * "the ship weighs this much". Structure is computed from the hull's own
 * geometry, the rig and the stores are itemised at the heights they actually
 * occupy, and **ballast is solved, not chosen** — it is whatever closes
 * Archimedes at the design draught.
 *
 * That makes the ballast figure a diagnostic. If the structure estimate were
 * badly wrong, the solved ballast would come out absurd — negative, or half the
 * displacement — and the model would be telling you so. See
 * `tests/ship-hydrostatics.test.ts`, which asserts the fraction stays in the
 * band a vessel of this type actually carries.
 *
 * The visible barrels and crates of spec section 8 are dressing and are *not*
 * inputs here; section 4.4 forbids deriving mass from them.
 */

/** Seasoned white oak: frames, planking, backbone. */
export const RHO_OAK = 740;
/** Pine and fir: spars, deck planking, joinery. */
export const RHO_SOFTWOOD = 540;
/** Tarred hemp. */
export const RHO_HEMP = 900;
/** Cast and pig iron ballast, as stowed — includes voids between pigs. */
export const RHO_BALLAST_STOWED = 4200;

/**
 * Equivalent thickness of solid oak representing the whole shell: outer
 * planking (~70 mm), doubled frames at close centres (~75 mm smeared), ceiling
 * (~38 mm), plus clamps, shelves and knees. A vessel built for ocean work and
 * ice-free but rough water is framed heavily for her length.
 */
const SHELL_EQUIVALENT_THICKNESS = 0.19;

/** Deck planking plus beams and carlings, smeared over the deck area. */
const DECK_EQUIVALENT_THICKNESS = 0.115;

/**
 * Bulwark planking, stanchions and caprail, smeared over the bulwark's area.
 *
 * Thinner than the shell: a bulwark is a fence carried on the frame heads, not
 * part of the girder. 55 mm of equivalent oak over both sides of 28 m of rail is
 * about 1.1 t.
 */
const BULWARK_EQUIVALENT_THICKNESS = 0.055;

/**
 * The platform deck over the hold: planking, beams and the stanchions under it.
 *
 * Half the weather deck's, because it carries people and stores rather than
 * boarding seas and a rig, and because its beams are shorter — it spans a hull
 * that is 4.2 m wide at 1.80 m, not 4.6 m at the sheer. 55 mm of equivalent oak
 * over 21 m² is about 0.86 t at y 1.71, which is inside the 1.2–1.5 t the plan
 * estimated and lower down than it assumed.
 */
const PLATFORM_EQUIVALENT_THICKNESS = 0.055;

export interface ShipMassItem {
  name: string;
  mass: number;
  x: number;
  y: number;
  z: number;
  /** Own second moment about its own x axis (pitch) and z axis (roll). */
  ixx: number;
  izz: number;
}

/** A compact item whose own inertia is negligible against its lever arms. */
function point(name: string, mass: number, x: number, y: number, z: number): ShipMassItem {
  return { name, mass, x, y, z, ixx: 0, izz: 0 };
}

/** Place an item relative to the walking deck at its own longitudinal station. */
function onDeck(name: string, mass: number, z: number, above: number): ShipMassItem {
  return point(name, mass, 0, walkingDeckY(z) + above, z);
}

/**
 * Place an interior item above the floor it stands on.
 *
 * **The floor is an argument, and it was a baked constant.** This read
 * `CABIN_SOLE_Y + above` when the cabin's sole was the only floor below decks.
 * There are three now — 2.45 aft, 1.80 over the hold, 2.05 forward — and the
 * three items forward of the cabin were all being weighed against the wrong one,
 * 0.40–0.45 m too high. It is 13 mm of KG in the *safe* direction, which is
 * exactly why it survived: nothing looks wrong when a ship is reported slightly
 * more tender than she is.
 *
 * The same shape as `standAt(x, z, reachY)` in M4: the caller knows which floor
 * it means, and a default would quietly hand back the cabin's answer at every
 * call site nobody thought about.
 */
function belowDecks(
  name: string,
  mass: number,
  z: number,
  soleY: number,
  above: number,
): ShipMassItem {
  return point(name, mass, 0, soleY + above, z);
}

/** Girth of one side of a station, and the height of the girth's centroid. */
function sectionGirth(z: number): { girth: number; centroidY: number } {
  const offsets = stationOffsets(z, 48);
  let girth = 0;
  let moment = 0;
  for (let i = 1; i < offsets.length; i++) {
    const dy = offsets[i].y - offsets[i - 1].y;
    const db = offsets[i].halfBreadth - offsets[i - 1].halfBreadth;
    const seg = Math.hypot(dy, db);
    girth += seg;
    moment += seg * (offsets[i].y + offsets[i - 1].y) * 0.5;
  }
  return { girth, centroidY: girth > 0 ? moment / girth : 0 };
}

/** Shell area of the whole hull, both sides, keel to deck edge. m². */
export function shellArea(): number {
  let area = 0;
  for (const st of hullStations()) area += 2 * sectionGirth(st.z).girth * st.length;
  return area;
}

/** Area of the weather deck. m². */
export function deckArea(): number {
  let area = 0;
  for (const st of hullStations()) area += 2 * maxHalfBeamAt(st.z) * st.length;
  return area;
}

/**
 * Structure, rig, stores and people — everything except ballast.
 *
 * Distributed items are emitted per station rather than lumped at a centroid,
 * so the longitudinal inertia comes out of the distribution instead of being
 * estimated on top of it. That matters: pitch inertia is dominated by where the
 * structure is, not by how much of it there is.
 */
export function buildLightship(): ShipMassItem[] {
  const items: ShipMassItem[] = [];
  const stations = hullStations();

  // --- shell, distributed by girth -----------------------------------------
  for (const st of stations) {
    const { girth, centroidY } = sectionGirth(st.z);
    const mass = 2 * girth * st.length * SHELL_EQUIVALENT_THICKNESS * RHO_OAK;
    // The centroid is the girth-weighted mean height, computed rather than
    // guessed. The first pass here assumed 0.56 of the depth, which put the
    // shell 0.6 m too high and cost about 0.17 m of GM on its own: with a hard
    // turn of bilge, a large share of the plank is low and nearly horizontal.
    items.push(point(`shell@${st.z.toFixed(2)}`, mass, 0, centroidY, st.z));
  }

  // --- weather deck ---------------------------------------------------------
  for (const st of stations) {
    const width = 2 * maxHalfBeamAt(st.z);
    const mass = width * st.length * DECK_EQUIVALENT_THICKNESS * RHO_SOFTWOOD;
    const raised = deckLevelRise(st.z);
    items.push(point(`deck@${st.z.toFixed(2)}`, mass, 0, deckAtSideY(st.z) + raised, st.z));
  }

  // --- bulwarks -------------------------------------------------------------
  // Added with the bulwark geometry in M1, per the handover's M1 note: the shell
  // above is smeared "keel to deck edge" and stops there, so without this the
  // ship would carry ~28 m of timber at y ≈ 4.3 that the mass model could not
  // see. It is worth about 0.05 m of GM — inside the spec's band, which is the
  // reason it is a one-item fix and not a hull problem.
  //
  // Planking, stanchions and caprail smeared over the bulwark's area, both
  // sides. Lighter per square metre than the shell: it is a fence, not structure.
  for (const st of stations) {
    const height = bulwarkTopY(st.z) - (deckAtSideY(st.z) + deckLevelRise(st.z));
    if (height <= 0) continue;
    const area = 2 * height * st.length;
    const mass = area * BULWARK_EQUIVALENT_THICKNESS * RHO_OAK;
    const y = deckAtSideY(st.z) + deckLevelRise(st.z) + height / 2;
    items.push(point(`bulwark@${st.z.toFixed(2)}`, mass, 0, y, st.z));
  }

  // --- backbone: keel, forefoot, deadwood, sternpost -------------------------
  // Solid oak below the rabbet, taken from the same profile that displaces the
  // water and that M1 lofts — see `backbone.ts`.
  //
  // The first model carried three hand-sized lumps. A lump cannot follow a
  // deeper dragged keel or be checked against the visible timber, so the
  // backbone is emitted per station and its longitudinal distribution falls
  // out of the same shape as its volume and mesh.
  for (const st of stations) {
    const area = backboneAreaAt(st.z);
    if (area <= 0) continue;
    const mass = area * st.length * RHO_OAK;
    const y = (backboneBottomY(st.z) + backboneTopY(st.z)) / 2;
    items.push(point(`backbone@${st.z.toFixed(2)}`, mass, 0, y, st.z));
  }

  // --- rudder, from the same blade that displaces the water ----------------
  // The old model hid half of a combined tiller-and-rudder lump at a guessed
  // height. Deriving the blade from its geometry keeps its volume, oak mass and
  // visible depth coherent when the keel changes.
  for (const st of stations) {
    const area = rudderAreaAt(st.z);
    if (area <= 0) continue;
    const mass = area * st.length * RHO_OAK;
    const y = (rudderBottomY() + rudderTopY(st.z)) / 2;
    items.push(point(`rudder@${st.z.toFixed(2)}`, mass, 0, y, st.z));
  }

  // --- interior joinery: bulkheads, berths, soles, ladders ------------------
  items.push(belowDecks('joinery, forecastle', 1250, 3.2, FORECASTLE_SOLE_Y, 0.45));
  items.push(belowDecks('joinery, wardroom', 900, 0.2, PLATFORM_SOLE_Y, 0.35));
  items.push(belowDecks('joinery, cabin', 1400, -5.5, CABIN_SOLE_Y, 0.65));

  // --- the platform deck ----------------------------------------------------
  // **Weight nobody had counted.** 21 m² of walkable floor is beams on
  // stanchions with planking over them, and the ballast solve had never seen a
  // kilogram of it — the plan flagged it at 1.2–1.5 t as the last thing to add
  // before trusting its own KG figure.
  //
  // Derived rather than written, from the area the room actually has: 0.055 m of
  // equivalent solid oak covers plank, beam and stanchion, the same device the
  // shell and the bulwark already use. Its centroid is half a beam-depth under
  // the sole, because a deck's mass is mostly in the beams under the planking.
  {
    const wardroom = belowDecksSpace('wardroom');
    const area = spaceSoleArea(wardroom);
    items.push(
      point(
        'platform deck',
        area * PLATFORM_EQUIVALENT_THICKNESS * RHO_OAK,
        0,
        wardroom.soleY - 0.09,
        (wardroom.zAft + wardroom.zForward) * 0.5,
      ),
    );
  }

  // --- rig ------------------------------------------------------------------
  // Spec section 2 puts the main masthead 19–20 m above the waterline, so
  // 21.5–22.3 above the baseline. A lower mast's centroid sits near a third of
  // its length; the topmast rides above it.
  //
  // These are volumes of timber, not guesses. The mainmast is 14.5 m at a mean
  // radius of 0.145, which is 0.96 m^3 of pine — 526 kg, not the 1180 the first
  // pass carried. Getting the spars wrong is expensive twice over: the rig sits
  // 9 m up, so its mass drives KG, and its distance from the roll axis drives
  // the roll radius of gyration. Halving an over-estimate here moved GM by more
  // than any other single correction in the model.
  items.push(point('mainmast, lower', 526, 0, 9.6, -1.9));
  items.push(point('main topmast', 73, 0, 18.2, -1.9));
  items.push(point('foremast, lower', 480, 0, 9.0, 4.1));
  items.push(point('fore topmast', 65, 0, 17.0, 4.1));
  items.push(onDeck('bowsprit', 233, 8.2, 0.2));
  items.push(onDeck('main boom and gaff', 221, -4.2, 0.97));
  items.push(onDeck('fore boom and gaff', 160, 1.6, 1.71));
  items.push(point('fore topsail yard', 88, 0, 13.4, 4.1));
  items.push(point('standing rigging', 850, 0, 10.2, 1.0));
  items.push(point('running rigging', 265, 0, 6.4, 0.6));
  items.push(point('sails, bent and furled', 300, 0, 6.8, 0.4));

  // --- fittings -------------------------------------------------------------
  items.push(onDeck('windlass and bitts', 480, 5.6, 0.3));
  items.push(onDeck('anchors', 760, 6.0, 0.35));
  items.push(point('anchor cable', 1150, 0, 1.5, 4.4));
  // **Weighed 1.95 m from where it is drawn.** `deckFittings.PUMP_Z` is
  // `MAINMAST_Z + 0.55` = −1.35, and its own comment says why: a pump stands at
  // the mast because the well is there. This item said +0.6. At 130 kg that is
  // about 3 mm of LCG and nothing looks wrong anywhere, which is exactly how two
  // sources for one position survive. Imported now, so there is one.
  items.push(onDeck('bilge pump', 130, PUMP_Z, 0.45));
  items.push(onDeck('tiller', 180, -6.4, 0.55));
  items.push(onDeck('dinghy, lashed', 340, 0.9, 0.45));
  items.push(belowDecks('galley hearth', 420, 2.6, FORECASTLE_SOLE_Y, 0.55));
  items.push(onDeck('stern lantern, binnacle, minor fittings', 260, -5.2, 0.55));

  // --- consumables and people ----------------------------------------------
  // Water and salt provisions stow low, in the hold, over the flat of the keel.
  //
  // **4800 kg and not 9000, and it is what buys the platform deck.** The floor
  // over the hold at 1.80 rather than the free 2.00 costs 4.7 m³ of stowage, and
  // this is where it is paid: 281 days of endurance at 4 L/person/day down to
  // 150, which is still long for a vessel that watered every few months. The
  // ballast solve replaces the removed weight with iron, and iron at 4200 kg/m³
  // in place of casked water at ~640 effective stows in a quarter of the volume
  // and sits on the floors instead of on top of them. She gets 5.5 m³ of hold
  // back *and* a lower KG for it. `docs/ship/SHIP_BELOW_DECKS_PLAN.md` section 3.
  items.push(point('fresh water', 4800, 0, 1.35, 0.4));
  items.push(point('provisions and dry stores', 4200, 0, 1.7, 1.6));
  items.push(belowDecks('expedition equipment and chests', 900, -2.2, PLATFORM_SOLE_Y, 0.15));
  items.push(onDeck('spare spars, timber and cordage', 700, 2.0, 0.25));
  items.push(onDeck('eight people and effects', 8 * 88, -1.0, 0.95));

  return items;
}

export interface BallastSolution {
  /** Total ballast required to close Archimedes at the design draught, kg. */
  mass: number;
  /** Stowed volume of that ballast, m³. */
  volume: number;
  /** Ballast as a fraction of displacement. */
  fraction: number;
  /** Longitudinal centroid the ballast had to be placed at for level trim. */
  longitudinalCentre: number;
  items: ShipMassItem[];
}

/**
 * Solve the ballast.
 *
 * Iron pigs stowed on the floors, over the flat of the keel and centred a little
 * aft of amidships so the vessel floats level rather than by the head. The
 * distribution matters as much as the total: it is what sets KG, and therefore
 * GM, and therefore the roll period.
 */
export function solveBallast(lightship: ShipMassItem[]): BallastSolution {
  const displacement = displacedVolume(DESIGN_DRAUGHT) * RHO_WATER;
  const lightMass = lightship.reduce((a, i) => a + i.mass, 0);
  const mass = displacement - lightMass;

  // --- trim ----------------------------------------------------------------
  // Ballast is placed to bring the centre of gravity onto the centre of
  // buoyancy, which is what floating on her designed lines means. This is not a
  // cosmetic correction: with the ballast simply spread symmetrically the
  // lightship's LCG sat 0.30 m forward of the LCB and she trimmed by the head,
  // which on a hull with a fine forefoot buries the bow in a head sea.
  //
  // Solving it is what a shipwright does with the same freedom — the iron goes
  // where it must for her to swim right.
  const lcb = longitudinalCentreOfBuoyancy();
  let lightMoment = 0;
  for (const it of lightship) lightMoment += it.mass * it.z;
  const ballastZ = (lcb * displacement - lightMoment) / mass;

  // Spread over the flat of the keel about that centroid, tapering at the ends
  // of the run. The shares are symmetric, so the group's centroid is `ballastZ`
  // exactly and the trim solve above is not disturbed by the distribution.
  const spread = [
    { offset: -2.8, share: 0.1 },
    { offset: -1.6, share: 0.18 },
    { offset: -0.5, share: 0.22 },
    { offset: 0.5, share: 0.22 },
    { offset: 1.6, share: 0.18 },
    { offset: 2.8, share: 0.1 },
  ];
  const items = spread.map((s) =>
    point(
      `ballast@${(ballastZ + s.offset).toFixed(1)}`,
      mass * s.share,
      0,
      BALLAST_Y,
      ballastZ + s.offset,
    ),
  );

  return {
    mass,
    volume: mass / RHO_BALLAST_STOWED,
    fraction: mass / displacement,
    longitudinalCentre: ballastZ,
    items,
  };
}

/** Longitudinal centre of buoyancy at the design draught, metres. */
function longitudinalCentreOfBuoyancy(): number {
  const scratch = createSectionImmersion();
  let volume = 0;
  let moment = 0;
  for (const st of hullStations()) {
    st.section.immerse(DESIGN_DRAUGHT, 0, scratch);
    volume += scratch.area * st.length;
    moment += scratch.area * st.z * st.length;
  }
  return volume > 0 ? moment / volume : 0;
}

/**
 * Height of the ballast's centroid above the baseline.
 *
 * Iron sits on the floors, immediately above the keel and limber holes, so this
 * is close to the bottom of the hold and there is very little freedom in it.
 * That is the point: KG is mostly *not* adjustable on a vessel like this, so
 * the metacentric height that falls out is close to the one she must have.
 */
const BALLAST_Y = 0.62;

export interface MassProperties {
  mass: number;
  comX: number;
  comY: number;
  comZ: number;
  /** Second moment about the transverse axis through the CoM — pitch. */
  inertiaPitch: number;
  /** Second moment about the longitudinal axis through the CoM — roll. */
  inertiaRoll: number;
  /** Second moment about the vertical axis through the CoM — yaw. */
  inertiaYaw: number;
  /** Transverse radius of gyration, metres. */
  rollRadiusOfGyration: number;
  /** Longitudinal radius of gyration, metres. */
  pitchRadiusOfGyration: number;
}

/** Reduce a set of items to total mass, centre of mass and inertias. */
export function massProperties(items: readonly ShipMassItem[]): MassProperties {
  let mass = 0;
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (const it of items) {
    mass += it.mass;
    mx += it.mass * it.x;
    my += it.mass * it.y;
    mz += it.mass * it.z;
  }
  const comX = mx / mass;
  const comY = my / mass;
  const comZ = mz / mass;

  let ixx = 0;
  let iyy = 0;
  let izz = 0;
  for (const it of items) {
    const dx = it.x - comX;
    const dy = it.y - comY;
    const dz = it.z - comZ;
    ixx += it.ixx + it.mass * (dy * dy + dz * dz);
    iyy += it.mass * (dx * dx + dz * dz);
    izz += it.izz + it.mass * (dx * dx + dy * dy);
  }

  return {
    mass,
    comX,
    comY,
    comZ,
    inertiaPitch: ixx,
    inertiaRoll: izz,
    inertiaYaw: iyy,
    rollRadiusOfGyration: Math.sqrt(izz / mass),
    pitchRadiusOfGyration: Math.sqrt(ixx / mass),
  };
}

/** The complete loaded ship: lightship plus solved ballast. */
export function buildLoadedShip(): {
  items: ShipMassItem[];
  ballast: BallastSolution;
  properties: MassProperties;
} {
  const lightship = buildLightship();
  const ballast = solveBallast(lightship);
  const items = [...lightship, ...ballast.items];
  return { items, ballast, properties: massProperties(items) };
}

/** Longitudinal extent of the hull, for callers that need it alongside the mass. */
export const HULL_HALF_LENGTH = HALF_LENGTH;
