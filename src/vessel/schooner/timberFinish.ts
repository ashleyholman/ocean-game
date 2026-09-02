import * as THREE from 'three';
import {
  applyTimberGrain,
  type TimberGrainSpec,
  type TimberWearSite,
} from '../../scene/WorldPbrMaterial';
import {
  CABIN_SOLE_Y,
  CARGO_HATCH_Z,
  COMPANION_AFT_Z,
  COMPANION_FORWARD_Z,
  COMPANION_INBOARD_X,
  QUARTERDECK_FORWARD_Z,
} from './hullForm';
import { RUDDER_STOCK_Z } from './deckFittings';
import { deckLevelAt, levelWalkingY } from './deckSurface';

/**
 * The timber round: what the ship's wood is made of, behind one switch.
 *
 * THE COMPLAINT
 * -------------
 * Ash, unprompted and more than once: *the flat orange wood is ugly.* Two words
 * and both of them turn out to be measurable.
 *
 * **Orange.** Every bare-timber surface on this ship — scrubbed deck, oiled
 * companionway joinery, cabin lining, sole, deck fittings, below-decks
 * furniture, and the spars too — lies between hue **31.9° and 36.7°**. Seven
 * woods, 4.8° of hue between them, at HSL saturation 0.21–0.36. They differ in
 * lightness and in nothing else, which is what makes them read as one material
 * at seven exposures rather than as seven timbers.
 *
 * **Flat.** `jitter()` in `shipwright.ts` — the only variation any timber on
 * this ship has ever had — multiplies r, g and b by *one* factor. It is a
 * brightness scale. No wood surface anywhere varies in hue, in chroma, or with
 * position: measured across the whole ship, exactly one surface has spatially
 * varying colour and it is the cabin floorcloth's walking track, which is
 * canvas. A field of one hue at varying brightness is a flat sheet with uneven
 * light on it, and that is precisely how it reads.
 *
 * WHAT THIS FILE DOES NOT DO, AND WHY
 * -----------------------------------
 * **It does not move roughness.** The round began by re-deriving the finish
 * against the sky the ship actually reflects, because `Schooner.ts`'s `FINISH`
 * table records that its M1 numbers were fitted against a probe at 0.3 strength
 * and that four regions — deck, inboard bulwark, bottom and glazing — were
 * never re-derived when `dba7041` corrected the painted exterior. Two of those
 * four are the timber being complained about. The measurement was taken
 * (`tools/export-timber-finish.mjs`) and its answer is that **roughness is
 * inert on this ship's timber**: across 0.55 → 0.95, at 12°, 30° and 60° sun,
 * the finished picture moves by at most 1.6 display levels of 255 on the deck
 * and 1.6 on the inboard bulwark, and by 0.2 on the cabin lining. The
 * derivation is owed, it has been done, and it says do nothing. See the round
 * write-up for why (outdoors the lobe is already wider than the sky's own
 * variation; below decks the portal path scales environment reflection by a
 * baked sky visibility of zero, so there is no glossy term there at all).
 *
 * **It does not touch the painted hull.** Topsides, wales, transom, boot top,
 * trim and the inboard bulwark are a palette Ash chose under the current
 * display transform (`962aec8`, "Return the hull to tar"), after a verdict that
 * had already reversed once. Reversing it again inside a timber round, without
 * asking, would be the third time this palette was moved by somebody who was
 * actually looking at something else.
 *
 * **It does not touch the rig.** The spars share the complaint exactly — pine
 * at hue 35.7 — and they are the one part of the ship another round is holding
 * open. Recorded, not changed.
 *
 * THE SHAPE OF THE CHANGE
 * -----------------------
 * Three cumulative tiers behind `?timber=`:
 *
 * - `woods` respecs six timbers **at held luminance**. Each is authored as a
 *   hue and a saturation, and the lightness is *solved* so its linear luminance
 *   matches the value it replaces to within about 1%. That is not a dodge: it
 *   keeps every quantity derived from these colours valid — the interior
 *   bounce albedos in `interiorLight.ts`, the deadlight's 0.28-against-0.52
 *   contrast argument, the light bake — and it makes the A/B a question about
 *   colour rather than a brightness change wearing colour's clothes.
 * - `grain` adds the spatial variation nothing on this ship has: board to
 *   board, along a run, and across the grain, in the fragment stage, keyed to
 *   the piece's own position and normal. It varies chroma as well as
 *   brightness, correlated the way timber's is — the dark late-wood band is
 *   also the warm one.
 * - `wear` darkens and burnishes the six places hands and feet actually go.
 *
 * `off` is the default and is byte-identical: every accessor returns the
 * canonical value, no define is set, and the shader source is not spliced.
 * `tests/timber-finish.test.ts` holds that.
 */

export type TimberMode = 'off' | 'woods' | 'grain' | 'wear';

const TIMBER_MODES: readonly TimberMode[] = ['off', 'woods', 'grain', 'wear'];

/** Tier index, so a feature can ask "am I at least at `woods`". */
function tierOf(mode: TimberMode): number {
  return TIMBER_MODES.indexOf(mode);
}

let activeMode: TimberMode = 'off';

export function setTimberMode(mode: TimberMode): void {
  activeMode = mode;
}

export function getTimberMode(): TimberMode {
  return activeMode;
}

export function parseTimberMode(raw: string | null): TimberMode {
  if (raw === null) return 'off';
  if ((TIMBER_MODES as readonly string[]).includes(raw)) return raw as TimberMode;
  throw new Error(
    `[timber] unknown ?timber=${raw} — use ${TIMBER_MODES.join(' | ')}`,
  );
}

/**
 * The six timbers this round has an opinion about.
 *
 * Keyed by what the wood IS rather than by which mesh draws it, because two of
 * them are drawn by three different modules each and one of them (`holdOak`)
 * is drawn under a material that `Schooner.ts` still labels as lining — see
 * the fault note on `TIMBER_OF_MATERIAL`.
 */
export type TimberKey =
  | 'deckPlanking'
  | 'weatherJoinery'
  | 'cabinLining'
  | 'cabinSole'
  | 'deckOak'
  | 'holdOak';

interface TimberSpec {
  /** The value in the canonical palette, whose luminance is preserved. */
  readonly canonical: number;
  /** Target hue, degrees, in sRGB HSL — the axis the complaint is about. */
  readonly hueDeg: number;
  /** Target HSL saturation. Every canonical value sits at 0.21–0.36. */
  readonly saturation: number;
  /** Why this wood is this colour. */
  readonly note: string;
  readonly grain: TimberGrainAuthoring;
}

interface TimberGrainAuthoring {
  /** Board-to-board tone, ± as a fraction of albedo. */
  readonly board: number;
  /** Grain figure along the board, ± as a fraction of albedo. */
  readonly figure: number;
  /** Warm/cool swing carried with the figure, ± as a fraction. */
  readonly chroma: number;
  /** Roughness swing carried with the figure, absolute. */
  readonly roughness: number;
  /** Board width, metres. */
  readonly boardWidthM: number;
  /** Grain cycles per metre across the board, and along it. */
  readonly acrossPerM: number;
  readonly alongPerM: number;
  /** 'fore-aft' for planking and lining; 'vertical' for a stanchion or mast. */
  readonly run: 'fore-aft' | 'vertical';
  /** How hard wear bites on this wood, 0–1. Scrubbed pine takes it hardest. */
  readonly wear: number;
}

/**
 * The respec.
 *
 * Read the hue column down the page: 26, 33, 38, 41, 43 — that spread IS the
 * change. The canonical column is 31.9, 32.1, 34.3, 35.0, 36.7.
 */
const TIMBER: Readonly<Record<TimberKey, TimberSpec>> = {
  deckPlanking: {
    canonical: 0x8d7a5c,
    // Holystoned and salt-bleached: the least coloured thing on the ship, and
    // it has to be, because it is the ground every fitting stands on. A deck
    // scrubbed twice a day loses its extractives to the water; what is left is
    // pale fibre with a yellow cast, not tan.
    hueDeg: 43,
    saturation: 0.14,
    note: 'holystoned softwood, salt-bleached',
    grain: {
      // Zero: the deck is already built as planks with the ship's heaviest
      // vertex jitter (0.10). A second board term at a different pitch would
      // beat against the first.
      board: 0,
      figure: 0.11,
      chroma: 0.045,
      roughness: 0.08,
      boardWidthM: 0.13,
      acrossPerM: 26,
      alongPerM: 0.45,
      run: 'fore-aft',
      wear: 1,
    },
  },
  weatherJoinery: {
    canonical: 0xa08258,
    // The companionway coaming and its cheeks: oiled oak that is rained on and
    // dries in the wind. Browner and much duller than the same oak below.
    hueDeg: 38,
    saturation: 0.2,
    note: 'oiled oak, weather side',
    grain: {
      board: 0.07,
      figure: 0.095,
      chroma: 0.05,
      roughness: 0.08,
      boardWidthM: 0.14,
      acrossPerM: 22,
      alongPerM: 0.6,
      run: 'fore-aft',
      wear: 0.8,
    },
  },
  cabinLining: {
    canonical: 0xa08258,
    // The one timber that is allowed to be warm, and the only one that goes
    // *redder*: `SHIP_SPEC` §9 says the cabin's whole point is that it reads
    // warmer and lighter than the exterior, and this is the surface that
    // carries it. It shared a hex with the joinery above; now it does not, and
    // the two meet at the companionway where the difference will show.
    hueDeg: 27,
    saturation: 0.27,
    note: 'oiled oak below, sheltered and never wet',
    grain: {
      board: 0.075,
      figure: 0.09,
      chroma: 0.055,
      roughness: 0.07,
      boardWidthM: 0.16,
      acrossPerM: 20,
      alongPerM: 0.5,
      run: 'fore-aft',
      wear: 0.5,
    },
  },
  cabinSole: {
    canonical: 0x6f5537,
    // Deal, not oak, and scrubbed: yellower than everything around it. It is
    // the floor of three rooms whose walls are the lining above, so putting it
    // 14° of hue away from them is what stops a room being one brown box.
    hueDeg: 41,
    saturation: 0.21,
    note: 'scrubbed deal sole',
    grain: {
      board: 0.07,
      figure: 0.09,
      chroma: 0.045,
      roughness: 0.07,
      boardWidthM: 0.15,
      acrossPerM: 22,
      alongPerM: 0.55,
      run: 'fore-aft',
      wear: 1,
    },
  },
  deckOak: {
    canonical: 0x6a5232,
    // Coamings, gratings, bitts, the windlass, the tiller. Oiled oak on the
    // weather deck: kept up, but weathered.
    hueDeg: 33,
    saturation: 0.25,
    note: 'oiled oak fittings on the weather deck',
    grain: {
      board: 0.065,
      figure: 0.10,
      chroma: 0.05,
      roughness: 0.09,
      boardWidthM: 0.1,
      acrossPerM: 28,
      alongPerM: 0.8,
      run: 'fore-aft',
      wear: 1,
    },
  },
  holdOak: {
    canonical: 0x5b452c,
    // Casks, the pump tube, every stick of furniture below, the deadlights.
    // Bare oak that has been wet and dried a hundred times is the greyest
    // brown aboard — and it is the wood that most needs to stop looking
    // orange, because it is the wood a player is closest to.
    hueDeg: 26,
    saturation: 0.19,
    note: 'bare oak below decks, wet and dried a hundred times',
    grain: {
      board: 0.07,
      figure: 0.10,
      chroma: 0.055,
      roughness: 0.07,
      boardWidthM: 0.1,
      acrossPerM: 28,
      alongPerM: 0.8,
      run: 'fore-aft',
      wear: 0.6,
    },
  },
};

const LUMINANCE_R = 0.2126;
const LUMINANCE_G = 0.7152;
const LUMINANCE_B = 0.0722;

function linearLuminance(colour: THREE.Color): number {
  return LUMINANCE_R * colour.r + LUMINANCE_G * colour.g + LUMINANCE_B * colour.b;
}

/**
 * Solve for the HSL lightness at which `(hue, saturation)` has the canonical
 * colour's linear luminance.
 *
 * Bisection, not algebra: sRGB's transfer function has a linear segment near
 * black and HSL's own construction is piecewise, so the closed form is three
 * cases deep and the inverse is not worth writing. Fifty halvings settle to
 * well under a quantisation step, and the test asserts the result rather than
 * trusting the loop.
 */
function heldLuminanceColour(spec: TimberSpec): THREE.Color {
  const want = linearLuminance(new THREE.Color(spec.canonical));
  const probe = new THREE.Color();
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    probe.setHSL(spec.hueDeg / 360, spec.saturation, mid, THREE.SRGBColorSpace);
    if (linearLuminance(probe) < want) lo = mid;
    else hi = mid;
  }
  probe.setHSL(
    spec.hueDeg / 360,
    spec.saturation,
    (lo + hi) / 2,
    THREE.SRGBColorSpace,
  );
  return probe;
}

/** The respec'd colours, solved once at load. Linear, like `THREE.Color`. */
const RESPEC: Readonly<Record<TimberKey, THREE.Color>> = Object.fromEntries(
  (Object.keys(TIMBER) as TimberKey[]).map((key) => [
    key,
    heldLuminanceColour(TIMBER[key]),
  ]),
) as Record<TimberKey, THREE.Color>;

/** The respec'd colour of one timber, for tests and for the round write-up. */
export function timberColour(key: TimberKey): THREE.Color {
  return RESPEC[key].clone();
}

/** What it replaces, so a test can compare the pair rather than a literal. */
export function timberCanonicalColour(key: TimberKey): THREE.Color {
  return new THREE.Color(TIMBER[key].canonical);
}

export function timberKeys(): readonly TimberKey[] {
  return Object.keys(TIMBER) as TimberKey[];
}

/**
 * The per-channel ratio a material carries so its baked vertex colours land on
 * the respec'd timber.
 *
 * **A ratio, and this is the whole reason the change is one line per material
 * rather than thirty in the geometry builders.** Every ship material is built
 * `vertexColors: true` and then has `material.color.setScalar(1)` applied, so
 * the vertex attribute is the only thing deciding colour and the material's own
 * colour is a free multiplier sitting unused. `Schooner.applyPalette` already
 * exploits exactly this for the palette sheet, and says why: a per-channel
 * ratio retints the timber while preserving its plank-to-plank variation *as a
 * proportion of it*. Both colours are linear, so the ratio is linear.
 */
function timberTint(key: TimberKey, out: THREE.Color): THREE.Color {
  const base = new THREE.Color(TIMBER[key].canonical);
  const want = RESPEC[key];
  return out.setRGB(
    want.r / Math.max(base.r, 1e-4),
    want.g / Math.max(base.g, 1e-4),
    want.b / Math.max(base.b, 1e-4),
    THREE.LinearSRGBColorSpace,
  );
}

/**
 * Which timber a named ship material is made of.
 *
 * **`interior:boards:*` and `interior:scuttleSoffit` are `holdOak` because
 * that is what they draw**, and this row used to describe a fault instead. The
 * fault was in the construction, not here: both materials named the lining as
 * their colour, both `interiorFittingGeometry.ts` comments said the piece
 * "takes the lining's timber", and neither was true of a single pixel — the
 * material colour is destroyed by `setScalar(1)` before it draws and the vertex
 * attribute was filled from `INTERIOR_FITTING_PALETTE.timber`. The declarations
 * now say oak, which is byte-identical and leaves the mapping honest.
 *
 * One half of it is still open and is a look decision rather than a mistake:
 * they carry the LINING'S roughness, 0.72 against the fitting oak's 0.86 — a
 * pairing that exists nowhere else aboard. And the comments' intent, that these
 * pieces should be lining at 0xa08258 rather than oak at 0x5b452c, is a 1.8x
 * albedo change in an unlit room. Both are REVIEW_QUEUE 1.5e, with 1.5b.
 */
const TIMBER_OF_MATERIAL: Readonly<Record<string, TimberKey>> = {
  'ship:deck': 'deckPlanking',
  'ship:deckJoinery': 'weatherJoinery',
  'ship:interiorLining': 'cabinLining',
  'ship:interiorSole': 'cabinSole',
  'interior:boards:open': 'holdOak',
  'interior:boards:shut': 'holdOak',
  'interior:scuttleSoffit': 'holdOak',
};

export function timberKeyOfMaterial(name: string): TimberKey | null {
  return TIMBER_OF_MATERIAL[name] ?? null;
}

/**
 * Set a ship material's colour, and its grain, according to the active tier.
 *
 * Replaces the bare `material.color.setScalar(1)` every ship material carried.
 * At `off` it *is* that call and sets no define, so the shipping program is the
 * one that shipped before this round.
 */
export function dressTimber(
  material: THREE.MeshStandardMaterial,
  key: TimberKey | null,
): void {
  material.color.setScalar(1);
  if (key === null || tierOf(activeMode) < tierOf('woods')) return;
  timberTint(key, material.color);
  if (tierOf(activeMode) < tierOf('grain')) return;
  applyTimberGrain(material, grainSpecOf(key));
}

function grainSpecOf(key: TimberKey): TimberGrainSpec {
  const g = TIMBER[key].grain;
  return {
    board: g.board,
    figure: g.figure,
    chroma: g.chroma,
    roughness: g.roughness,
    boardWidthM: g.boardWidthM,
    acrossPerM: g.acrossPerM,
    alongPerM: g.alongPerM,
    verticalRun: g.run === 'vertical',
    // A per-timber phase, so two woods meeting at a corner do not share a
    // board edge. Derived from the authored hue rather than typed, because a
    // typed seed is a number nobody can check.
    seed: (TIMBER[key].hueDeg * 0.137) % 1,
    wear: tierOf(activeMode) >= tierOf('wear') ? g.wear : 0,
    sites: tierOf(activeMode) >= tierOf('wear') ? WEAR_SITES : [],
  };
}

/**
 * Where the ship is actually worn.
 *
 * Six places, every one of them derived from a named constant rather than
 * typed as a coordinate, because a wear mark 200 mm off the ladder it belongs
 * to is worse than no wear mark. Positive strength burnishes — a handrail and a
 * tiller take hand grease, go darker and take a sheen. Negative scuffs — a deck
 * around a hatchway is walked to bare pale fibre, which is the opposite
 * direction and the reason this is signed rather than scalar.
 */
const WEAR_SITES: readonly TimberWearSite[] = (() => {
  const deckY = (z: number): number => levelWalkingY(z, deckLevelAt(z));
  const companionX = COMPANION_INBOARD_X + 0.42;
  return [
    // The cargo hatch: everything that goes below in the waist crosses this
    // coaming, and the planking round it is the most walked deck on the ship.
    { x: 0, y: deckY(CARGO_HATCH_Z), z: CARGO_HATCH_Z, radiusM: 1.6, strength: -1 },
    // The head of the companionway, at the break — the way below.
    {
      x: companionX,
      y: deckY(COMPANION_FORWARD_Z),
      z: COMPANION_FORWARD_Z - 0.2,
      radiusM: 1.0,
      strength: -0.7,
    },
    // Its ladder, below: treads and cheeks, gripped on the way down.
    {
      x: companionX,
      y: CABIN_SOLE_Y + 0.9,
      z: COMPANION_AFT_Z + 0.4,
      radiusM: 1.1,
      strength: 0.9,
    },
    // The quarterdeck ladder, starboard — `DECK_STAIRS` stands on one hand.
    {
      x: -1.0,
      y: deckY(QUARTERDECK_FORWARD_Z) + 0.25,
      z: QUARTERDECK_FORWARD_Z + 0.3,
      radiusM: 0.9,
      strength: 0.8,
    },
    // The tiller and the deck the helmsman stands on.
    {
      x: 0,
      y: deckY(RUDDER_STOCK_Z + 0.9) + 0.55,
      z: RUDDER_STOCK_Z + 0.9,
      radiusM: 1.0,
      strength: 0.9,
    },
    // The caprail abreast the hatch: the rail a body holds crossing the waist.
    { x: 1.9, y: deckY(0.6) + 1.05, z: 0.6, radiusM: 1.4, strength: 0.7 },
  ];
})();

/** For the write-up and the test: where the wear marks landed. */
export function timberWearSites(): readonly TimberWearSite[] {
  return WEAR_SITES;
}
