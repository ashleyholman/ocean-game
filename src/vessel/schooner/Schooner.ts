import * as THREE from 'three';
import type { BuoyantBody } from '../BuoyantBody';
import type {
  Vessel,
  VesselPhysicsContext,
  VesselPresentationContext,
} from '../Vessel';
import type { WaveField } from '../../scene/Waves';
import { Lamp, LANTERN_SHADOW_LAYER } from '../../scene/Lamp';
import { InteriorLamp } from '../../scene/InteriorLamp';
import { OvertopSpray } from '../../scene/OvertopSpray';
import { overtopReferencesFromFreeboard } from '../../scene/wakePolicy';
import {
  createWorldPbrMaterial,
  getPortalLightMix,
  getRoomLift as getRoomLiftUniform,
  samplePortalSkyIrradiance,
  setPortalLight,
  setRoomLift as setRoomLiftUniform,
  setRoomLiftMix,
  type WorldPbrLocalDiffuseBounce,
} from '../../scene/WorldPbrMaterial';
import {
  CHANNEL_BOARDS,
  CHANNEL_COMPANION,
  CHANNEL_HATCH,
  CHANNEL_SCUTTLE,
  CHANNEL_WINDOWS,
  LIGHT_CHANNELS,
  LIGHT_ROOM_ORDER,
  eyeLightMeterAt,
  interiorLightModel,
  lightRoomIndexOf,
  rectCorners,
  type InteriorLightModel,
  type LightRoomName,
} from './interiorLight';
import {
  bakeEnclosedPortalLight,
  bakeFittingPortalLight,
  bakeSparPortalLight,
} from './interiorLightBake';
import { deckOverheadAt } from './deckSurface';
import {
  HullWetBand,
  type HullWetBandAppearance,
} from '../../scene/HullWetBand';
import type { WakeSources } from '../WakeSources';
import {
  INTERIOR_RENDER_ORDER,
  SHIP_RENDER_ORDER,
  markAsInterior,
} from '../../scene/interiorStencil';
import {
  CABIN_SOLE_Y,
  COMPANION_AFT_Z,
  COMPANION_FORWARD_Z,
  DESIGN_DRAUGHT,
  HULL_LENGTH,
  MAX_BEAM,
  walkingDeckY,
} from './hullForm';
import { companionMidX } from './deckInterior';
import {
  LAMP_DROP,
  LAMP_HANGS,
  LAMP_ROOMS,
  lampHangPoint,
  type LampId,
  type LampRoomName,
} from './lampPlacement';
import { buildSchoonerBuoyancy } from './SchoonerBuoyancy';
import { SchoonerHorizontalDynamics } from './SchoonerHorizontalDynamics';
import { INTERIOR_REGIONS, SHIP_PALETTE, SHIP_REGIONS, buildShipGeometry } from './shipGeometry';
import {
  INTERIOR_FITTING_PALETTE,
  INTERIOR_FITTING_REGIONS,
  buildForeScuttleSoffitGeometry,
  buildHatchwayBoardGeometry,
  buildDeskChairGeometry,
  buildBoxBerthCurtainGeometry,
  buildInteriorFittingGeometry,
  buildSternDeadlightGeometry,
} from './interiorFittingGeometry';
import type { InteriorFittingRegion } from './interiorFittingGeometry';
import { isClosureOpen } from './closures';
import { isStationOccupied } from './seatState';
import type { ClosureName } from './closures';
import type { ShipRegion } from './shipGeometry';
import {
  RIG_PALETTE,
  RIG_REGIONS,
  buildLiveRigGeometry,
  buildStaticRigGeometry,
  refreshLiveRigGeometry,
} from './rigGeometry';
import type { RigLoftState, RigRegion } from './rigGeometry';
import {
  FITTING_PALETTE,
  FITTING_REGIONS,
  buildDeckFittingGeometry,
  buildForeScuttleLidGeometry,
} from './deckFittingGeometry';
import type { FittingRegion } from './deckFittingGeometry';
import { WindCueSet } from './windCueSet';
import type { PaletteOption } from './shipPalettes';
import { updateDeckLocalBounceIrradiance } from './deckLighting';
import { dressTimber, timberKeyOfMaterial } from './timberFinish';
import { ShipWaterState } from './ShipWaterState';
import { advanceSchoonerDeckWater } from './SchoonerDeckWaterAdvance';

/**
 * The schooner: her meshes, and the body they ride on.
 *
 * This adapter owns the *meshes*, while the shape they are built from lives as
 * data elsewhere (`hullForm.ts`,
 * `backbone.ts`, lofted by `shipGeometry.ts`). One description of one object is
 * what stops the physics model and the visible timber ever disagreeing.
 * She is the production `Vessel`; the legacy raft is an independently packaged
 * diagnostic implementation selected only by its debug mode.
 */

/**
 * Where the lantern stands, along the centreline axis.
 *
 * Aft, on the quarterdeck: a working vessel's light belongs by the helm, and it
 * also puts the flame where the camera most often sits behind it, so the pool
 * it throws on the water reads between the viewer and the hull rather than
 * behind her.
 */
const LAMP_Z = -3.0;

/**
 * And which hand it stands on — **starboard, because the companionway took the
 * other one.**
 *
 * It was at +0.85, which is inside the hatch now that the opening has moved off
 * the centreline to port. While the deck was still being lofted across that
 * hole the lantern looked like it was standing on planking; with the hole drawn
 * it would simply hang in the shaft. Mirrored rather than moved fore-and-aft so
 * that the reason it is here at all — by the helm, and behind the camera —
 * survives the change.
 */
const LAMP_X = -0.85;

/**
 * Roughness and metalness per paint region. Nothing here is metal.
 *
 * THE PAINTED EXTERIOR CARRIES +0.30 AGAINST ITS ORIGINAL VALUES
 * --------------------------------------------------------------
 * Not a taste change: a correction to a number that went stale under this
 * hull without anybody moving it.
 *
 * These roughnesses were chosen in the M1 ship round (d984eaa), when she
 * carried her own hand-authored sky probe at `ENV_INTENSITY = 0.3` — a
 * constant whose own comment said full strength would double-count and "she
 * glows". The world lighting round then retired that probe for the scene-wide
 * one at `envMapIntensity = 1`, and repainted her twice while it was in there.
 * The finish was never re-derived. She has been reflecting the sky at 3.3x the
 * strength every value in this table was fitted against, and the old comment
 * on `topsides` — "at 0.72 there was almost no sheen" — was a true statement
 * about a renderer that no longer exists.
 *
 * What that looked like: a hard pale band running the length of the topsides
 * whenever the sun was behind the viewer's shoulder. Measured off the term
 * views at one frozen instant, 30° sun, as the 95th percentile of topsides
 * luminance — the peak, because a mean cannot see a hot-spot and the mean is
 * what said "roughness does nothing" for an afternoon:
 *
 *     roughness   0.52    0.62    0.72    0.82    0.92
 *     p95         99.7    94.1    87.0    80.3    77.5
 *
 * 0.82 is the knee. It takes 19% off the band, which is six sevenths of
 * everything 0.92 gets, and it leaves a visible grazing highlight — that term
 * still reads her form more strongly than a 3% albedo can, which was the true
 * half of the original argument and is why this is +0.30 and not a flattening.
 *
 * Applied as one delta across the painted exterior so the regions keep their
 * relationships: the wales stay glossier than the topsides, the boot top
 * duller than both. Deck, inboard bulwark, bottom and glazing are untouched —
 * they were never in the reflection complaint, and the glazing especially must
 * stay glossy.
 *
 * The candidate palettes in `shipPalettes.ts` carry their own roughness
 * overrides (0.38–0.58) fitted in the same round against the same weak probe.
 * They are deliberately NOT touched here: they are a comparison set that was
 * judged as it stands, and re-deriving them is a palette decision.
 */
const FINISH: Record<ShipRegion, { roughness: number }> = {
  // Tallow-and-white-lead composition: chalky, and the least shiny thing aboard.
  belowWaterline: { roughness: 0.95 },
  bootTop: { roughness: 0.92 },
  // Tar holds a real sheen even when weathered — a grazing highlight down the
  // length of a hull reads its form about as strongly as the albedo does, and
  // on near-black topsides it is most of what there is to read. This is still
  // the term that carries her, not the albedo. It is now a broad sheen rather
  // than a mirrored band, which is what tar at sea actually looks like.
  topsides: { roughness: 0.82 },
  wales: { roughness: 0.78 },
  trim: { roughness: 0.9 },
  transom: { roughness: 0.82 },
  // Scrubbed, salt-bleached and walked on. The most diffuse surface she has.
  deck: { roughness: 0.94 },
  // Oiled oak above deck: sheltered finish, outdoor transport.
  deckJoinery: { roughness: 0.72 },
  inboardBulwark: { roughness: 0.85 },
  glazing: { roughness: 0.25 },
  // Below decks, out of the weather. The sole is scrubbed but sheltered, so it
  // keeps a little more sheen than the deck above it; the lining is oiled
  // joinery rather than paint, and a lantern needs something to glance off or
  // the room reads flat at exactly the hour it is meant to be at its best.
  interiorSole: { roughness: 0.88 },
  interiorLining: { roughness: 0.72 },
};

/**
 * The LEGACY enclosure constant, kept only as the A/B baseline.
 *
 * This was the first pass at enclosure: one scalar on the open sky's SH, which
 * scaled the level and kept the sky's directionality — the documented
 * one-bright-wall fault. The shipping model is the baked portal light
 * (`interiorLight.ts`); this value is what `setPortalLightMix(0)` restores,
 * live and in the same frame, so the old and new pictures can be judged under
 * one transform. Do not retune it: it is a record, not a control.
 */
const INTERIOR_SKY_VISIBILITY = 0.14;

/**
 * How far the eye opens below decks, as an exposure factor.
 *
 * THE HONEST TRANSPORT NEEDED AN HONEST CAMERA. With the portal model in, the
 * cabin's ambient measures ~1% of the exterior — which is what a real cabin
 * with four small lights measures (a daylight factor of a few percent), and
 * which a fixed outdoor exposure renders as black. A person in that cabin
 * sees a warm legible room, because eyes adapt about three orders of
 * magnitude and cameras pick their exposure per shot. This is that term:
 * exposure opening ~2.6 stops as the eye comes below, low-passed like the
 * sky meter so a step through the companionway is an adaptation, not a cut.
 *
 * An EXPOSURE factor and deliberately not a light: it scales the finished
 * frame, so which wall is brighter, where the beam falls and how the dusk
 * dies all survive it exactly. The sky seen up the hatch overexposes while
 * dark-adapted — as it does to an eye. It rides the portal A/B
 * (`setPortalLightMix(0)` disables it with the rest of the new model), and
 * the number is a first pass that wants Ash's eye.
 */
const INTERIOR_EYE_ADAPTATION_GAIN = 10;
/** Seconds to dark-adapt going below, and to give it back on deck. */
const EYE_ADAPTATION_IN_SECONDS = 1.2;
const EYE_ADAPTATION_OUT_SECONDS = 0.35;

/**
 * The metered form of the eye — §15.4.1's "better form", now the default.
 *
 * One fixed gain cannot serve rooms two decades apart: at 14:00 the landing
 * under its open hatch meters ~3, the cabin ~0.05, the forecastle ~0.005.
 * ×10 leaves the cabin below the tone toe (Ash: "almost pitch black...
 * doesn't feel realistic") while already glaring up the companionway. So the
 * camera now meters the light arriving at the eye — `eyeLightMeterAt`, a
 * continuous field with no seam at the deck line — and opens exposure to
 * put that level at a chosen display point:
 *
 *   gain = clamp(ADAPTATION_METER_TARGET / meter, 1, ADAPTATION_GAIN_CAP)
 *
 * TARGET is derived, not felt: display ≈ (meter·ρ/π)·base·gain, so putting a
 * ρ≈0.21 wall near mid-tone (~0.25) under base exposure ~1.2 wants
 * target ≈ 0.25·π/(0.21·1.2) ≈ 3. The CAP is what keeps honesty: the
 * forecastle without its scuttle and the shut hold stay dark because no
 * gain rescues a room whose meter is genuinely nothing. Both are first
 * numbers for Ash's eye — `__drift.setAdaptationMode('fixed')` restores the
 * old constant for the A/B, same frame.
 *
 * Above deck the daytime meter is huge and the clamp holds gain at 1; at
 * night the same law would dark-adapt the deck watch, which is authored
 * territory (the lantern round tuned that darkness), so it ships OFF behind
 * `setNightAdaptation` until it is judged in a night session.
 */
// Ash's picks from the first live walk (2026-08-13); the round closed with
// these as the shipped defaults and a §16.5 worklist of what they cannot
// fix — the night sky through openings and the window-view overexposure
// are model problems, not dial positions.
const ADAPTATION_METER_TARGET = 1.5;
const ADAPTATION_GAIN_CAP = 40;
/** Log-space smoothing: exposure is ratios, and a cut of ×40 should ease. */
const ADAPTATION_DARKEN_TAU_SECONDS = 0.55;
const ADAPTATION_BRIGHTEN_TAU_SECONDS = 0.25;

/**
 * 'metered' reads the light arriving at the eye's POSITION — stable under
 * head movement. 'gaze' reads the cosine cone along the VIEW — the
 * frame-metering behaviour games use, where staring into a dark room opens
 * the exposure before you step in, at the price of pumping when the view
 * sweeps a dark corner. 'fixed' is the old ×10 constant, kept for the A/B.
 *
 * 'room-lift' retires the camera entirely: exposure stays the scene's own,
 * and each room's baked daylight is multiplied by a fixed per-room constant
 * on the SURFACES instead (`setRoomLift` in `WorldPbrMaterial.ts`). The three
 * camera modes above answered "how adapted is the eye"; this one answers
 * "how big do the openings pretend to be" — and because it multiplies only
 * portal light, the sky through a window, the sun's beam and the lantern
 * render at authored exposure from every viewpoint, day and night. §16.5's
 * three night/window complaints are all the camera multiplying the frame;
 * this mode removes the multiplier rather than re-aiming it.
 */
export type InteriorAdaptationMode = 'metered' | 'gaze' | 'fixed' | 'room-lift';

/**
 * The room-lift dials: how much bigger each room pretends its openings are.
 *
 * Ash's picks from the first room-lift walk (2026-08-13), tuned live in
 * daylight. Night needs no numbers of its own — a fixed lift on
 * almost-nothing is still almost-nothing, which is the design. The
 * forecastle's number is a placeholder by his own note ("i'll tune it later
 * after we add scuttle"): no dial rescues a room with no opening (§9.4).
 * His verdict also named the open finding these constants live under: near
 * sundown the cabin goes very dark while the deck is still bright, because
 * the windows channel collapses when the sun is in the wrong half of the
 * sky — §17.4, a sky/channel question, not a dial position.
 */
const ROOM_LIFT_DEFAULTS: Readonly<Record<LightRoomName, number>> = {
  cabin: 14,
  landing: 2.5,
  wardroom: 4,
  hold: 6,
  forecastle: 20,
};

/**
 * How much of the position meter floors the gaze meter. Pure gaze (0) let a
 * downward glance at the landing sole open the exposure ×33 while standing
 * in a sunlit shaft; the floor says the eye never adapts more than
 * 1/floor past what the light AT the eye justifies, however dark the view.
 */
const ADAPTATION_GAZE_FLOOR = 0.25;

/** The live dials on the metered eye, slider-owned; constants above are
 * their shipped defaults. */
export interface AdaptationTuning {
  meterTarget: number;
  gainCap: number;
  darkenTauSeconds: number;
  brightenTauSeconds: number;
  gazeAmbientFloor: number;
}

/**
 * Daylight down the companionway, as a real light.
 *
 * Without it, `INTERIOR_SKY_VISIBILITY` darkens the sole under the open hatch
 * exactly as much as the corner behind the ladder, which is the one thing about
 * this room a player will read as wrong immediately: you can see the sky through
 * the opening and no light arrives with it.
 *
 * A spot rather than a point, aimed straight down, because what it is standing
 * in for is a shaft through a rectangular hole. It carries no shadow map — the
 * cost is real and the thing it would shadow, the ladder, is already the thing
 * the cone is drawing.
 */
const COMPANION_LIGHT_ANGLE = 0.85;
const COMPANION_LIGHT_PENUMBRA = 0.6;
/** Scales the ambient the sky is already supplying, so it dies at dusk with it. */
const COMPANION_LIGHT_GAIN = 5.2;

/**
 * Finish per rig material.
 *
 * The one metal aboard is here. The hull's table says "nothing here is metal"
 * and means it; chain plates and mast caps are wrought iron, and they are worth
 * the metalness because they are small, dark, and the only things on her that
 * catch a hard specular glint — which is exactly how iron reads against timber.
 */
const RIG_FINISH: Record<RigRegion, { roughness: number; metalness: number }> = {
  // Tallow-slushed pine: smoother than the deck, nowhere near the wales' gloss.
  spar: { roughness: 0.58, metalness: 0 },
  // Tarred hemp is matte and fibrous. Gloss here reads as wire.
  rope: { roughness: 0.72, metalness: 0 },
  ironwork: { roughness: 0.52, metalness: 0.55 },
  // Woven flax, weathered. The most diffuse surface on the ship after the deck.
  sailcloth: { roughness: 0.9, metalness: 0 },
};

/**
 * Finish per deck-fitting material.
 *
 * Oak on deck is oiled rather than scrubbed, so it is a shade glossier than the
 * planking's 0.94 and duller than a slushed spar's 0.58. The iron is the rig's,
 * because it is the rig's iron — a windlass gudgeon and a chain plate came off
 * the same smith.
 */
const FITTING_FINISH: Record<FittingRegion, { roughness: number; metalness: number }> = {
  timber: { roughness: 0.86, metalness: 0 },
  ironwork: { roughness: 0.52, metalness: 0.55 },
};

/**
 * The same, for the five materials that appear below decks.
 *
 * A separate table rather than a widening of the one above, because the two
 * lists are different lists — see `FittingMaterial`. The two shared rows carry
 * the deck's own numbers unchanged: a pump tube and a hatch coaming are the
 * same oak and should not disagree because they are drawn by different modules.
 *
 * The three new ones are the whole reason the desk is worth looking at:
 *
 * - **brass** at 0.35/0.85 is the only near-specular surface below decks. It
 *   has one job — take the stern windows' bath and the lantern's cone and hand
 *   them back as a highlight — and metalness is what makes a highlight take the
 *   *colour of the metal* rather than the colour of the light, which is the
 *   entire visual difference between brass and cream paint.
 * - **leather** at 0.74/0. Not the 0.98 the green baize had: wool cloth has no
 *   specular lobe worth the name, and a dressed hide does — a writing skiver
 *   under a lantern has a low broad sheen across it, and that sheen is most of
 *   what separates leather from dark paint.
 * - **paper** at 0.92/0 sits just under the cloth: rag paper is matt but a
 *   rolled chart still has a faint sheen along the curl, and that sheen is most
 *   of what makes a pale cylinder read as paper rather than as a dowel.
 * - **linen and wool at 0.97/0, the roughest surfaces on the ship.** Cloth is
 *   the one material here with no specular lobe at all worth drawing: a woven
 *   nap scatters at every angle, which is exactly why a blanket looks the same
 *   from every seat in the room while a leather squab moves its highlight as
 *   you walk past. Giving them the leather's 0.74 was the first thing tried and
 *   it made the bed look wet.
 */
const INTERIOR_FITTING_FINISH: Record<
  InteriorFittingRegion,
  { roughness: number; metalness: number }
> = {
  timber: { roughness: 0.86, metalness: 0 },
  ironwork: { roughness: 0.52, metalness: 0.55 },
  brass: { roughness: 0.35, metalness: 0.85 },
  leather: { roughness: 0.74, metalness: 0 },
  paper: { roughness: 0.92, metalness: 0 },
  linen: { roughness: 0.97, metalness: 0 },
  wool: { roughness: 0.97, metalness: 0 },
};

/** Exterior paint that can cross the resolved waterline. */
const WET_HULL_REGIONS = new Set<ShipRegion>([
  'belowWaterline',
  'bootTop',
  'topsides',
  'wales',
  'trim',
  'transom',
]);

/**
 * Surfaces inside the weather-deck bowl which receive first-bounce light from
 * the planking. The deck region includes the stair blocks: their top normals
 * reject the lower-hemisphere term while their risers and cheeks receive it.
 */
const DECK_LOCAL_BOUNCE_REGIONS = new Set<ShipRegion>([
  'deck',
  'deckJoinery',
  'inboardBulwark',
]);

export interface SchoonerStats {
  drawCalls: number;
  triangles: number;
  regions: number;
}

export class Schooner implements Vessel {
  readonly kind = 'schooner' as const;
  readonly group = new THREE.Group();
  readonly sceneObjects: readonly THREE.Object3D[];
  readonly body: BuoyantBody;
  /** Authoritative SURV0/SURV1 ledger; deliberately not yet applied to motion. */
  readonly waterState = new ShipWaterState({ closureIsOpen: isClosureOpen });
  readonly horizontalDynamics: SchoonerHorizontalDynamics;
  readonly stats: SchoonerStats;
  readonly halfLengthM = HULL_LENGTH / 2;
  readonly halfBeamM = MAX_BEAM / 2;
  readonly waterlineLocalY = DESIGN_DRAUGHT;

  /** Fixed physics step used by the shared flotation integrator. */
  physicsStep = 1 / 240;

  /** Vessel heading in the transported render frame, radians. */
  yaw = 0;
  /** Positive turns the bow toward model +X/port, radians per second. */
  yawRate = 0;

  /**
   * The lantern, on her deck.
   *
   * It is the one light in the world the schooner carries rather than receives.
   * Two things depend on it beyond the
   * obvious: the ocean's lamp glitter and pool (`ocean.setLamp`), and the
   * night legibility work — after sunset the sea is almost purely specular, so
   * a reflected flame is by far the brightest thing a small vessel can put on
   * the water.
   *
   * `Lamp` owns a real `PointLight`, so the schooner's planking is lit through
   * the same PBR path as everything else. No lamp-specific code lives in the
   * hull.
   */
  readonly lamp = new Lamp();

  /**
   * The lanterns below, one per walked room, hung from the deck beams that
   * `lampPlacement` resolves.
   *
   * The same assembly as the deck lamp on different hooks, answering to a
   * different master: each latch and rolloff runs on ITS room's own portal
   * daylight (`roomDaylight`, derived in `publishPortalLight`), so a lamp
   * lights when its room fails — by dusk or by heading — not when the sky
   * does — which is why the fore scuttle, built on another branch and
   * unknown to this file, drives the forecastle lamp correctly: shut, the
   * room is dark at noon and the lamp burns; open, its signal rises ~170x
   * and the lamp goes out. None of them feed the ocean/sail lamp
   * consumers: the sea has no line of sight to a flame inside the hull.
   */
  readonly interiorLamps: ReadonlyMap<LampId, InteriorLamp>;

  /**
   * Each room's transfer-weighted portal daylight (sky + beam, × the room's
   * lift), as a luminance. Feed-forward for the lamps: computed from the
   * channels BEFORE any lamp light exists, so a lamp never sees itself.
   */
  private readonly roomDaylight: Record<LampRoomName, number> = {
    cabin: 0,
    landing: 0,
    wardroom: 0,
    forecastle: 0,
  };

  /** Scratch for expressing world-down in the ship's frame, for the swings. */
  private readonly lampDownLocal = new THREE.Vector3(0, -1, 0);
  private readonly lampDownQuat = new THREE.Quaternion();

  /** The shaft of daylight down the companionway. See the constants above. */
  private readonly companionLight = new THREE.SpotLight(0xffffff, 0);

  /**
   * The ensign, the masthead pennant and the dogvane.
   *
   * The one part of her that reads the world rather than being posed by it:
   * `docs/ship/SHIP_DECK_HANDOVER.md` closed M3 recording that she had no wind indicator
   * of any kind, and that it mattered more than dressing because it is how a
   * helmsman reads the wind.
   */
  readonly windCues = new WindCueSet();

  /** WK2's presentation-only wet ribbon on the exterior shell. */
  readonly wetHullBand = new HullWetBand();

  /**
   * One allocation-free local probe shared by the deck, its inward bulwarks
   * and the furniture bolted to it. It represents diffuse light returned by
   * the planking; the open-world probe remains untouched.
   */
  private readonly deckLocalBounce: WorldPbrLocalDiffuseBounce = {
    irradiance: new THREE.Vector3(),
    upWorld: new THREE.Vector3(0, 1, 0),
  };
  private readonly deckBounceReflectance = new THREE.Color(
    SHIP_PALETTE.base.deck,
  );

  /** Everything needing disposal. Widened past the paint materials once the
   * sails brought a custom depth material with them. */
  private readonly materials: THREE.Material[] = [];
  /** The subset that writes the optional ocean-rejection stencil fallback. */
  private readonly interiorMaterials: THREE.Material[] = [];
  /**
   * Every mesh that only exists below decks — the rooms, their fittings and
   * the boards — for the portal culling to hide as one unit. The boards keep
   * their own closure state on top of it (`applyInteriorVisibility`).
   */
  private readonly interiorMeshes: THREE.Mesh[] = [];

  /** The hatchway's boards in each state; exactly one set is ever visible. */
  /**
   * Which meshes belong to which state of which closure.
   *
   * **One map, keyed by closure**, rather than a pair of arrays per hatch. The
   * arrays were fine for one closure and became three pairs for two — and the
   * visibility rule was written out once per pair, which is how a third hatch
   * ends up drawn shut while the floor under it is open.
   *
   * Membership of `interiorMeshes` is orthogonal and stays separate: the
   * scuttle's soffit is interior and is culled with the rooms, while the lid
   * above it stands in open daylight and must never be. A mesh's *state* and a
   * mesh's *storey* are two different questions.
   */
  private readonly closureMeshes = new Map<
    ClosureName,
    { shut: THREE.Mesh[]; open: THREE.Mesh[] }
  >();

  /**
   * The captain's chair, in its two states. A map of one would be silly; when
   * the ship has a second seat this becomes one, keyed the way the closures are.
   */
  private readonly seatMeshes: { tucked: THREE.Mesh[]; drawn: THREE.Mesh[] } = {
    tucked: [],
    drawn: [],
  };

  /**
   * The interior light graph and its per-frame scratch. Built once — the
   * geometry is static; only the four channel irradiances move with the sky.
   */
  private readonly interiorLight: InteriorLightModel = interiorLightModel();
  private readonly portalIrradiance: THREE.Vector3[] = Array.from(
    { length: LIGHT_CHANNELS },
    () => new THREE.Vector3(),
  );
  private readonly portalBounceScratch = new THREE.Vector3();
  private readonly portalSunScratch: THREE.Vector3[] = Array.from(
    { length: LIGHT_CHANNELS },
    () => new THREE.Vector3(),
  );
  private readonly portalDirScratch = new THREE.Vector3();
  private readonly windowsSampleNormalLocal = new THREE.Vector3();
  private readonly wardroomAmbientScratch = new THREE.Vector3();

  /**
   * Portal culling state. `interiorCulled` is what the camera test decided;
   * closure state composes with it rather than fighting over `visible`.
   */
  private interiorCulled = false;
  private interiorCullingEnabled = true;
  /** Whether the camera's eye was below decks at the last visibility test. */
  private eyeBelowDecks = false;
  /** Smoothed dark adaptation, 0 on deck → 1 fully adapted below. */
  private eyeAdaptation = 0;
  /** The eye, ship-local, from the same test — what the meter reads. */
  private readonly eyeLocal = new THREE.Vector3();
  /** The view direction, ship-local — what gaze mode meters along. */
  private readonly eyeViewLocal = new THREE.Vector3(0, 0, -1);
  /**
   * 'room-lift' is this branch's tuning default — the surfaces carry the lie
   * and the camera retires to ×1 (§16.5's through-line, taken the other way).
   * The three camera modes stay one switch away as the A/B; 'gaze' was Ash's
   * pick from the metered walk and remains their default when judged.
   */
  private adaptationMode: InteriorAdaptationMode = 'room-lift';
  /** Night dark-adaptation above deck: authored territory, ships off. */
  private nightAdaptationEnabled = false;
  /** log(gain), smoothed — exposure is ratios, so the easing is too. */
  private smoothedLogGain = 0;
  /** Last meter and target, for the debug readout. */
  private lastEyeMeter: number | null = null;
  private lastGainTarget = 1;
  private readonly meterChannelLum = [0, 0, 0, 0];
  /** Slider-owned; the named constants are the shipped defaults. */
  readonly adaptationTuning: AdaptationTuning = {
    meterTarget: ADAPTATION_METER_TARGET,
    gainCap: ADAPTATION_GAIN_CAP,
    darkenTauSeconds: ADAPTATION_DARKEN_TAU_SECONDS,
    brightenTauSeconds: ADAPTATION_BRIGHTEN_TAU_SECONDS,
    gazeAmbientFloor: ADAPTATION_GAZE_FLOOR,
  };
  private readonly cullScratchMatrix = new THREE.Matrix4();
  private readonly cullScratchVec = new THREE.Vector3();
  private readonly cullFrustum = new THREE.Frustum();
  // The view matrix is derived here from the camera's fresh matrixWorld
  // rather than read off `camera.matrixWorldInverse`, which the renderer only
  // refreshes at render time — one frame stale for a test that runs before
  // the render, and a frame-late frustum is a flash of missing interior every
  // time the eye crosses a coaming.
  private readonly cullViewMatrix = new THREE.Matrix4();
  private readonly cullProjScreenMatrix = new THREE.Matrix4();
  private readonly cullPortalBox = new THREE.Box3();

  /**
   * Show whichever closure state the ship is actually in.
   *
   * Called once at build and again on every toggle. It reads `closures.ts`
   * rather than taking an argument, so the mesh cannot end up showing one thing
   * while `schoonerStandAt` withdraws the floor for another — which is the
   * whole failure mode of a hatch you can see shut and fall through.
   */
  syncClosures(): void {
    this.applyInteriorVisibility();
  }

  /**
   * Show whichever way the captain's chair is standing.
   *
   * Separate entry point from `syncClosures` because a chair is not a closure —
   * `seatState.ts` sets out why at length — but the same discipline: it reads
   * the state rather than taking it, so the drawn chair and the seat the player
   * is actually in cannot part company.
   */
  syncSeat(): void {
    this.applyInteriorVisibility();
  }

  /** The state lists for a closure, created on first use. */
  private closureMeshList(name: ClosureName): { shut: THREE.Mesh[]; open: THREE.Mesh[] } {
    let lists = this.closureMeshes.get(name);
    if (!lists) {
      lists = { shut: [], open: [] };
      this.closureMeshes.set(name, lists);
    }
    return lists;
  }

  /**
   * A pair of state meshes, composed with the storey's own culling.
   *
   * The composition — `!culled && matches`, but only for meshes that are
   * *interior* in the first place — is the boards' hard-won rule, and it is a
   * helper rather than two copies because the chair is the second thing aboard
   * to need it and the deadlights will be the third.
   */
  private applyStatePair(on: THREE.Mesh[], off: THREE.Mesh[], isOn: boolean, culled: boolean): void {
    for (const mesh of on) {
      mesh.visible = isOn && (!this.interiorMeshes.includes(mesh) || !culled);
    }
    for (const mesh of off) {
      mesh.visible = !isOn && (!this.interiorMeshes.includes(mesh) || !culled);
    }
  }

  /**
   * One place decides what below-decks meshes show: the portal culling says
   * whether the interior is drawable at all, the closure state says which set
   * of boards is the true one. Two writers racing over `visible` was the
   * predictable alternative.
   */
  private applyInteriorVisibility(): void {
    const culled = this.interiorCulled && this.interiorCullingEnabled;
    // Storey first: everything below decks rides the culling.
    for (const mesh of this.interiorMeshes) mesh.visible = !culled;
    // Then state, for every closure aboard, by one rule. A mesh that is both
    // interior and stateful ends up with `!culled && matches`, which is the
    // composition the boards needed and nobody has to write twice.
    for (const [name, lists] of this.closureMeshes) {
      this.applyStatePair(lists.open, lists.shut, isClosureOpen(name), culled);
    }
    this.applyStatePair(
      this.seatMeshes.drawn,
      this.seatMeshes.tucked,
      isStationOccupied('deskChair'),
      culled,
    );
  }

  /** The debug switch: `false` draws the interior unconditionally. */
  setInteriorCullingEnabled(enabled: boolean): void {
    this.interiorCullingEnabled = enabled;
    this.applyInteriorVisibility();
  }

  /**
   * The eye's dark adaptation as an exposure factor, 1 on deck.
   *
   * See `INTERIOR_EYE_ADAPTATION_GAIN`. Rides the portal A/B so legacy mode
   * reproduces the old picture bit for bit.
   */
  interiorEyeAdaptation(): number {
    // Room-lift mode: the lie lives on the walls (`uRoomLift`), the frame's
    // exposure is the scene's own — which is the entire fix for the night sky
    // through the stern windows rendering ×gain too bright.
    if (this.adaptationMode === 'room-lift') return 1;
    const mix = getPortalLightMix();
    if (this.adaptationMode === 'fixed') {
      return 1 + (INTERIOR_EYE_ADAPTATION_GAIN - 1) * this.eyeAdaptation * mix;
    }
    return 1 + (Math.exp(this.smoothedLogGain) - 1) * mix;
  }

  setAdaptationMode(mode: InteriorAdaptationMode): void {
    this.adaptationMode = mode;
    // The shader-side A/B follows the mode: every camera mode renders the
    // portal surfaces at exactly ×1 through the mix, so the pre-lift picture
    // is reproduced bit for bit, same frame.
    setRoomLiftMix(mode === 'room-lift' ? 1 : 0);
  }

  /**
   * One room's lift dial, by name. The panel's sliders and the console both
   * come through here so the mapping to uniform slots lives in one place.
   */
  setRoomLift(room: LightRoomName, lift: number): void {
    setRoomLiftUniform(lightRoomIndexOf(room), lift);
  }

  roomLift(room: LightRoomName): number {
    return getRoomLiftUniform(lightRoomIndexOf(room));
  }

  /** The dials as one record, for the readout and the harness. */
  roomLifts(): Record<LightRoomName, number> {
    const out = {} as Record<LightRoomName, number>;
    for (const room of LIGHT_ROOM_ORDER) out[room] = this.roomLift(room);
    return out;
  }

  setNightAdaptation(enabled: boolean): void {
    this.nightAdaptationEnabled = enabled;
  }

  /** One lantern by id, or null for an id no lamp hangs under. */
  interiorLampOf(id: string): InteriorLamp | null {
    return this.interiorLamps.get(id as LampId) ?? null;
  }

  /** One policy for all the lamps below — the panel's rows drive these. */
  setLampsMode(mode: 'auto' | 'on' | 'off'): void {
    for (const lamp of this.interiorLamps.values()) lamp.mode = mode;
  }

  setLampsIntensity(scale: number): void {
    for (const lamp of this.interiorLamps.values()) lamp.intensityScale = scale;
  }

  setLampsShadow(enabled: boolean): void {
    for (const lamp of this.interiorLamps.values()) lamp.setShadowEnabled(enabled);
  }

  /** The Space action's handlers — see `shipInteractables`. */
  isLampWantedLit(id: string): boolean {
    return this.interiorLampOf(id)?.isWantedLit ?? false;
  }

  toggleLamp(id: string): void {
    this.interiorLampOf(id)?.toggleManual();
  }

  /** Every lantern's state and its room signal, for console and harness. */
  lampsDebug(): Record<
    string,
    {
      room: LampRoomName;
      mode: 'auto' | 'on' | 'off';
      litLevel: number;
      renderEmission: number;
      roomDaylightLuminance: number;
      shadow: boolean;
    }
  > {
    const out: ReturnType<Schooner['lampsDebug']> = {};
    for (const hang of LAMP_HANGS) {
      const lamp = this.interiorLamps.get(hang.id);
      if (!lamp) continue;
      out[hang.id] = {
        room: hang.room,
        mode: lamp.mode,
        litLevel: lamp.litLevel,
        renderEmission: lamp.renderEmission,
        roomDaylightLuminance: this.roomDaylight[hang.room],
        shadow: lamp.shadowActive,
      };
    }
    return out;
  }

  /** The meter, target and applied gain, for the console and the harness. */
  adaptationDebug(): {
    mode: InteriorAdaptationMode;
    meter: number | null;
    gainTarget: number;
    gain: number;
  } {
    return {
      mode: this.adaptationMode,
      meter: this.lastEyeMeter,
      gainTarget: this.lastGainTarget,
      gain: this.interiorEyeAdaptation(),
    };
  }

  /**
   * Jump the eye's adaptation straight to its current target.
   *
   * For deterministic captures only: the inspection harness teleports the
   * eye and cannot wait out a time constant that exists to feel right, not
   * to be right. The target is whatever the last visibility test decided, so
   * callers place the camera, let a frame run, then snap.
   */
  snapEyeAdaptation(): void {
    this.eyeAdaptation = this.eyeBelowDecks ? 1 : 0;
    this.smoothedLogGain = Math.log(this.adaptationGainTarget());
  }

  /**
   * Put the eye back where a freshly loaded ship's eye starts: on deck, in
   * daylight, with no metered gain and no memory of a room.
   *
   * Distinct from `snapEyeAdaptation`, and both are needed. Snapping asks
   * "where should the eye be, given where it is standing now" — which is the
   * right question once the harness has placed the body. This asks nothing:
   * it is called by `resetSimulation`, before anybody has been placed, and its
   * job is to make sure the previous scene's dark hold is not still in the
   * meter when the next scene's placement is snapped against it.
   */
  resetEyeAdaptation(): void {
    this.eyeAdaptation = 0;
    this.smoothedLogGain = 0;
    this.lastEyeMeter = null;
  }

  /**
   * Where the metered exposure wants to be this frame, before smoothing.
   *
   * The channel luminances were published by `publishPortalLight` this frame,
   * beams included, and the boards channel is already gated by its closure —
   * so a shut hold meters at zero and the cap times nothing stays dark.
   */
  private adaptationGainTarget(): number {
    for (let p = 0; p < LIGHT_CHANNELS; p++) {
      const e = this.portalIrradiance[p];
      const s = this.portalSunScratch[p];
      this.meterChannelLum[p] =
        0.2126 * (e.x + s.x) + 0.7152 * (e.y + s.y) + 0.0722 * (e.z + s.z);
    }
    let meter = eyeLightMeterAt(
      this.interiorLight,
      this.eyeLocal.x,
      this.eyeLocal.y,
      this.eyeLocal.z,
      this.meterChannelLum,
    );
    if (this.adaptationMode === 'gaze' && meter !== null) {
      // The view cone, floored by a fraction of the light at the eye: spot
      // metering into a dark corner opens the exposure, but never further
      // than 1/floor past what the position justifies. Ash's ladder rays
      // were the failure this bounds — a downward glance from a sunlit
      // shaft is not a dark room.
      const cone = eyeLightMeterAt(
        this.interiorLight,
        this.eyeLocal.x,
        this.eyeLocal.y,
        this.eyeLocal.z,
        this.meterChannelLum,
        [this.eyeViewLocal.x, this.eyeViewLocal.y, this.eyeViewLocal.z],
      );
      meter = Math.max(
        cone ?? 0,
        this.adaptationTuning.gazeAmbientFloor * meter,
      );
    }
    this.lastEyeMeter = meter;
    // On deck the day meters far past the target and the clamp holds 1; the
    // night would dark-adapt the watch, which stays authored until judged.
    const metered =
      meter ?? (this.nightAdaptationEnabled ? this.meterChannelLum[CHANNEL_COMPANION] : Infinity);
    const tuning = this.adaptationTuning;
    this.lastGainTarget = Math.min(
      Math.max(tuning.meterTarget / Math.max(metered, 1e-6), 1),
      tuning.gainCap,
    );
    return this.lastGainTarget;
  }

  get interiorCullingActive(): boolean {
    return this.interiorCulled && this.interiorCullingEnabled;
  }

  /**
   * Decide whether anything below decks can reach the camera this frame.
   *
   * Below decks, everything is visible. Above, the interior can only be seen
   * through its openings, so it draws only while some opening's rectangle
   * intersects the view frustum — the same rectangles the light comes through,
   * because visibility and illumination travel the same holes. Conservative on
   * purpose: a portal on screen but occluded by the hull still draws the
   * interior, and depth testing eats the cost as it always did.
   */
  updateInteriorVisibility(camera: THREE.Camera): void {
    const local = this.cullScratchVec
      .setFromMatrixPosition(camera.matrixWorld)
      .applyMatrix4(this.cullScratchMatrix.copy(this.group.matrixWorld).invert());
    const deck = deckOverheadAt(local.x, local.z);
    const belowDecks = deck !== null && local.y < deck.y - 0.02 && local.y > 0;
    // Recorded whether or not culling is on: the eye's dark adaptation reads
    // it (`interiorEyeAdaptation`), and an eye does not stop adapting because
    // a debug switch wants the meshes drawn.
    this.eyeBelowDecks = belowDecks;
    this.eyeLocal.copy(local);
    // The camera looks down its own −Z; gaze metering wants that direction
    // in the ship's frame, where the light model's rectangles live.
    this.eyeViewLocal
      .set(0, 0, -1)
      .transformDirection(camera.matrixWorld)
      .transformDirection(this.cullScratchMatrix)
      .normalize();

    if (!this.interiorCullingEnabled) {
      if (this.interiorCulled) {
        this.interiorCulled = false;
        this.applyInteriorVisibility();
      }
      return;
    }

    let visible = belowDecks;
    if (!visible) {
      this.cullViewMatrix.copy(camera.matrixWorld).invert();
      this.cullProjScreenMatrix.multiplyMatrices(
        camera.projectionMatrix,
        this.cullViewMatrix,
      );
      this.cullFrustum.setFromProjectionMatrix(this.cullProjScreenMatrix);
      for (const portal of this.interiorLight.skyPortals) {
        const box = this.cullPortalBox.makeEmpty();
        for (const corner of rectCorners(portal)) {
          box.expandByPoint(
            this.cullScratchVec
              .set(corner[0], corner[1], corner[2])
              .applyMatrix4(this.group.matrixWorld),
          );
        }
        // A portal seen edge-on has a degenerate box; give it a little body,
        // which also covers a camera standing right at the coaming.
        box.expandByScalar(0.15);
        if (this.cullFrustum.intersectsBox(box)) {
          visible = true;
          break;
        }
      }
    }

    if (this.interiorCulled !== !visible) {
      this.interiorCulled = !visible;
      this.applyInteriorVisibility();
    }
  }
  private readonly geometries: THREE.BufferGeometry[] = [];
  /** Rig meshes by region, for the S4 live re-loft to swap geometry on. */
  private readonly rigMeshes = new Map<RigRegion, THREE.Mesh>();
  /** Scratch view of the live meshes' current buffers, for the re-loft. */
  private readonly liveGeometries = new Map<RigRegion, THREE.BufferGeometry>();
  private readonly originPoint = { x: 0, y: 0, z: 0, fx: 0, fz: 0 };

  /**
   * WK3's overtop port. Water coming over her rail, acknowledged.
   *
   * The puffs live in render/world coordinates because the events do, so the
   * group is a *sibling* of the hull in the scene rather than a child of it —
   * adding it under `this.group` would apply her pitch, roll and position to
   * points that already carry them.
   */
  private readonly overtopSpray: OvertopSpray;

  /** Scratch frame handed to the spray so its throw knows which way is inboard. */
  private readonly overtopFrame = { originX: 0, originZ: 0, yaw: 0 };

  constructor(options: { advancesWaveField?: boolean } = {}) {
    // `sceneObjects` is assigned once the body exists, because the overtop
    // cue's own scale comes off her freeboard.
    //
    // The room-lift dials start at their shipped defaults, and the mix follows
    // the mode from the first frame — the uniforms are scene-module state, so
    // the vessel owns pushing them.
    for (const room of LIGHT_ROOM_ORDER) {
      setRoomLiftUniform(lightRoomIndexOf(room), ROOM_LIFT_DEFAULTS[room]);
    }
    setRoomLiftMix(this.adaptationMode === 'room-lift' ? 1 : 0);
    // The direction the stern lights face, ship-local: the mean of the four
    // panes' outward normals (they differ only by the counter's curvature).
    for (const portal of this.interiorLight.skyPortals) {
      if (portal.channel !== CHANNEL_WINDOWS) continue;
      this.windowsSampleNormalLocal.x += portal.sampleNormal[0];
      this.windowsSampleNormalLocal.y += portal.sampleNormal[1];
      this.windowsSampleNormalLocal.z += portal.sampleNormal[2];
    }
    if (this.windowsSampleNormalLocal.lengthSq() < 1e-9) {
      this.windowsSampleNormalLocal.set(0, 0, -1);
    }
    this.windowsSampleNormalLocal.normalize();
    // Wave-field ownership is explicit because two bodies advancing one shared
    // field would run the sea twice. The production adapter owns it; an
    // independently stepped diagnostic may opt out.
    this.body = buildSchoonerBuoyancy({ advancesWaveField: options.advancesWaveField ?? true });
    this.horizontalDynamics = new SchoonerHorizontalDynamics(
      this.body.mass,
      this.body.inertiaYaw,
      this.physicsStep,
    );

    // WK3's overtop port, sized from her own freeboard rather than from the
    // raft's hand-fitted coefficients — 1.6969 m, so a 1.70 m wash or 5.77 m/s
    // of entry is a full one. Her measured overtop peaks on the beam-reach
    // reference are 0.076 m and 0.86 m/s, which come out at 0.19: correctly,
    // nothing at all is drawn for a crossing that marginal. The running sizing
    // case reaches 1.89 m and 8.10 m/s, and that one is a wash.
    this.overtopSpray = new OvertopSpray({
      ...overtopReferencesFromFreeboard(this.body.freeboard),
      // Two sites 0.9 m apart on a 15.5 m hull is two puffs on top of each
      // other. A quarter of her length keeps them reading as separate places
      // the sea came aboard.
      siteSpacingM: 3.9,
      // Slower than the raft's stutter: on a vessel this size a fresh pair of
      // sites every seventh of a second reads as a machine gun rather than as
      // the sea coming aboard.
      cooldownSeconds: 0.35,
      // Her heaviest measured frame carries 118 simultaneous events. The pool
      // is the hard bound on what any of them can draw.
      capacity: 36,
      puffScaleM: 2.6,
      inboardBias: 0.7,
      seed: 0x51a37c9,
    });
    this.sceneObjects = [this.group, this.overtopSpray.group];

    const built = buildShipGeometry();
    let drawCalls = 0;

    for (const region of SHIP_REGIONS) {
      const geometry = built.geometries.get(region);
      if (!geometry) continue;

      // Through the world factory, like every other solid object in the scene.
      // She used to carry her own hand-authored sky probe at a third strength
      // because nothing else in the game had an environment at all and a hull
      // cannot be read without one. That comment ended "the honest fix is
      // scene-wide", and this is it: no ship-specific light, gain or exposure.
      // The optional deck term below is not another source; it is one bounce of
      // that same shared light through nearby timber, expressed as transport.
      const interior = INTERIOR_REGIONS.includes(region);
      // Enclosure is baked per vertex now: form factors to the ship's own
      // openings on four shared channels, and zero open sky. The constant
      // remains only as the live A/B baseline — see `INTERIOR_SKY_VISIBILITY`.
      if (interior) bakeEnclosedPortalLight(geometry);
      // The bulwark's inboard face runs below its deck line, and through the
      // chink at the deck break that timber is visible from the wardroom —
      // an exterior material below decks rendered sun-lit dark red clipping
      // to pink (probed at vessel (1.77, 3.95, −3.11), §15.5 item 5's
      // family). The fitting rule fits it exactly: on or above the planking
      // keeps full sky, below it takes the room.
      const reachesBelowDeck = region === 'inboardBulwark';
      if (reachesBelowDeck) bakeFittingPortalLight(geometry);
      const material = createWorldPbrMaterial({
        color: SHIP_PALETTE.base[region],
        roughness: FINISH[region].roughness,
        metalness: 0,
        localDiffuseBounce: DECK_LOCAL_BOUNCE_REGIONS.has(region)
          ? this.deckLocalBounce
          : undefined,
        skyVisibility: interior ? INTERIOR_SKY_VISIBILITY : 1,
        portalLight: interior || reachesBelowDeck,
        // Per-strake colour variation rides in the vertex attribute; the
        // material's own colour multiplies it, so the base hue stays editable in
        // one place while the planking keeps its variation.
        vertexColors: true,
        name: `ship:${region}`,
      });
      dressTimber(material, timberKeyOfMaterial(`ship:${region}`));
      // Every loft on this ship is one-sided, and a one-sided surface is
      // invisible to the renderer's default back-face shadow pass — the deck
      // cast no shadow of its own, and the sun landed on interior surfaces
      // within a hand's breadth of the deckhead in a closed cabin. §3.3's
      // "an open-ended surface reads as transparency", one pass deeper.
      // Both faces go to the shadow map; the exterior stays acne-free under
      // the existing normal bias (checked by eye at 76° and 30° sun).
      material.shadowSide = THREE.DoubleSide;
      if (WET_HULL_REGIONS.has(region)) {
        this.wetHullBand.attach(material);
      }

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `ship:${region}`;
      // The interior draws *after* the rest of her and marks a stencil where it
      // survives the depth test; the ocean then refuses to draw over the mark.
      // The order is the mechanism, not a tidiness — see `interiorStencil.ts`.
      if (interior) {
        mesh.renderOrder = INTERIOR_RENDER_ORDER;
        markAsInterior(material);
        this.interiorMaterials.push(material);
        this.interiorMeshes.push(mesh);
      } else {
        mesh.renderOrder = SHIP_RENDER_ORDER;
      }
      // Shadow mapping is on and the sun casts, but every ship mesh was opted
      // out of both — so the bulwark did not shade the deck, the hull did not
      // shade itself, and she threw nothing on the water. Correct regardless of
      // how much it happens to buy at any one sun angle; at 76° elevation it is
      // nearly invisible, at 20° it is most of what gives the deck depth.
      //
      // Except the glass: a shadow map is opaque and glass is not, so a
      // casting pane would strike the one beam the cabin is owed — a low sun
      // through the stern lights. The glazing's transmission loss is the
      // portal model's business, not the shadow map's.
      mesh.castShadow = region !== 'glazing';
      mesh.receiveShadow = true;
      // The normal camera and Sun remain on layer 0. The extra layer lets the
      // lantern's six shadow faces draw real vessel geometry without paying to
      // redraw the displaced ocean six times.
      mesh.layers.enable(LANTERN_SHADOW_LAYER);
      this.group.add(mesh);
      this.materials.push(material);
      this.geometries.push(geometry);
      drawCalls++;
    }

    // --- the rig ------------------------------------------------------------
    //
    // Two meshes per material region, not one: the half a live trim can move
    // and the half it cannot (`rigGeometry.ts`'s `LOFT_STEPS`). It costs a few
    // draw calls and buys a re-loft that touches only the swinging spars, the
    // running rigging and the cloth — which is what lets the rig follow the
    // controls every frame instead of in eight-per-second steps.
    const staticRig = buildStaticRigGeometry();
    const liveRig = buildLiveRigGeometry();
    for (const region of RIG_REGIONS) {
      const staticGeometry = staticRig.geometries.get(region);
      const liveGeometry = liveRig.geometries.get(region);
      if (!staticGeometry && !liveGeometry) continue;

      // The masts are the one geometry aboard that runs from the bilge to the
      // sky through every room in the ship, and they were lit as though the
      // whole tube stood on deck — about seven times brighter than the rooms
      // they pass through (`SHIP_INTERIOR_HANDOVER.md` §14.14). They live in
      // the `spar` region — in the LIVE half, because the loft rebuilds every
      // spar together — so both spar geometries take the baked enclosure ramp.
      // The static half is all above deck and bakes to full sky, which is the
      // same picture at the cost of one attribute; a per-frame `writeInto`
      // never touches the baked attributes, and the one path that swaps whole
      // geometries re-bakes (`updateRigLoft`).
      if (region === 'spar') {
        if (staticGeometry) bakeSparPortalLight(staticGeometry);
        if (liveGeometry) bakeSparPortalLight(liveGeometry);
      }
      const material = createWorldPbrMaterial({
        color: RIG_PALETTE[region],
        roughness: RIG_FINISH[region].roughness,
        metalness: RIG_FINISH[region].metalness,
        vertexColors: true,
        portalLight: region === 'spar',
        name: `rig:${region}`,
      });
      material.color.setScalar(1);
      if (region === 'sailcloth') {
        // A sail is a surface, not a solid: from the lee side you are looking at
        // its back, and half the time the camera is there.
        material.side = THREE.DoubleSide;
      }

      let depthMaterial: THREE.MeshDepthMaterial | undefined;
      if (region === 'sailcloth') {
        /**
         * A sail has no thickness, so it shadows itself.
         *
         * It writes its own depth into the shadow map at exactly the depth it is
         * then shaded at, and the comparison becomes a coin toss per texel: the
         * cloth comes out under a fine moiré that follows the camber's iso-depth
         * contours. `shadowSide` is the usual answer and cannot work here —
         * there is no thickness for the back face to hide behind, so front and
         * back are the same plane. (Three already defaults `DoubleSide` to a
         * `BackSide` shadow, which is why setting it changed nothing.)
         *
         * A custom depth material biases the sail's *own* contribution to the
         * shadow map and nothing else's. The light's global `shadow.bias` would
         * do it too and would drag every hull surface with it — the hull's
         * self-shadowing is correct and was tuned in the lighting round.
         *
         * So she keeps both: sails still throw their shadow across the deck and
         * across each other, which at this scale is one of the strongest cues
         * that the rig is a three-dimensional object rather than a decal.
         */
        depthMaterial = new THREE.MeshDepthMaterial({
          depthPacking: THREE.RGBADepthPacking,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: 4,
          polygonOffsetUnits: 6,
        });
        this.materials.push(depthMaterial);
      }
      this.materials.push(material);

      for (const [geometry, live] of [
        [staticGeometry, false],
        [liveGeometry, true],
      ] as const) {
        if (!geometry) continue;
        const mesh = new THREE.Mesh(geometry, material);
        // Both halves keep the region's name. The debug sheets identify a
        // material by it (`rigLayoutSheet.ts` paints `rig:spar` one flat
        // colour), and a rig split for rebuild cost is still one rig to
        // anything looking at it.
        mesh.name = `rig:${region}`;
        // Ahead of the interior, so a spar standing in front of the companionway
        // has written its depth before the sole below decks tests against it.
        mesh.renderOrder = SHIP_RENDER_ORDER;
        // Rope does not cast. A 17 mm ratline is far below one shadow-map texel
        // at this scale, so what it casts is not a rope's shadow but a dashed
        // line of aliasing that crawls as she rolls — and there are 78 of them.
        // The spars and the sails carry the rig's shadow, which is the part
        // that reads.
        mesh.castShadow = region !== 'rope';
        mesh.receiveShadow = true;
        if (depthMaterial) mesh.customDepthMaterial = depthMaterial;
        this.group.add(mesh);
        this.geometries.push(geometry);
        if (live) this.rigMeshes.set(region, mesh);
        drawCalls++;
      }
    }

    // --- the deck's furniture ------------------------------------------------
    // After the rig, because it is drawn last for no reason but reading order:
    // the hull, then what is stepped in it, then what is bolted to it.
    const fittings = buildDeckFittingGeometry();
    for (const region of FITTING_REGIONS) {
      const geometry = fittings.geometries.get(region);
      if (!geometry) continue;

      // Fittings reach below the planking — the partners, the grating, the
      // bitts' feet — and an exterior material down there is a daylight leak
      // into the rooms (§15.5 item 5). The bake encloses only what is under
      // a deck; everything standing on one keeps its sky, so above deck this
      // is the same picture it always was.
      bakeFittingPortalLight(geometry);
      const material = createWorldPbrMaterial({
        color: FITTING_PALETTE[region],
        roughness: FITTING_FINISH[region].roughness,
        metalness: FITTING_FINISH[region].metalness,
        localDiffuseBounce: this.deckLocalBounce,
        portalLight: true,
        vertexColors: true,
        name: `fitting:${region}`,
      });
      dressTimber(material, region === 'timber' ? 'deckOak' : null);
      material.shadowSide = THREE.DoubleSide;

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `fitting:${region}`;
      mesh.renderOrder = SHIP_RENDER_ORDER;
      // These are the objects a first-person player is closest to, so their
      // shadows are the ones that read: a coaming's shadow lying across the
      // planking is most of what says the deck has a floor rather than a
      // texture.
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.layers.enable(LANTERN_SHADOW_LAYER);
      this.group.add(mesh);
      this.materials.push(material);
      this.geometries.push(geometry);
      drawCalls++;
    }

    // --- the fore scuttle's lid, both ways -----------------------------------
    // Exterior joinery: same material and lighting as every other fitting on
    // the planking, because that is what it is. Two meshes, one visible — see
    // `buildForeScuttleLidGeometry`.
    for (const open of [false, true]) {
      const set = buildForeScuttleLidGeometry(open);
      for (const region of FITTING_REGIONS) {
        const geometry = set.geometries.get(region);
        if (!geometry) continue;
        bakeFittingPortalLight(geometry);
        const material = createWorldPbrMaterial({
          color: FITTING_PALETTE[region],
          roughness: FITTING_FINISH[region].roughness,
          metalness: FITTING_FINISH[region].metalness,
          localDiffuseBounce: this.deckLocalBounce,
          portalLight: true,
          vertexColors: true,
          name: `fitting:scuttleLid:${open ? 'open' : 'shut'}`,
        });
        dressTimber(material, region === 'timber' ? 'deckOak' : null);
        material.shadowSide = THREE.DoubleSide;

        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `fitting:scuttleLid:${open ? 'open' : 'shut'}`;
        mesh.renderOrder = SHIP_RENDER_ORDER;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.layers.enable(LANTERN_SHADOW_LAYER);
        this.group.add(mesh);
        this.materials.push(material);
        this.geometries.push(geometry);
        const lid = this.closureMeshList('foreScuttleLid');
        (open ? lid.open : lid.shut).push(mesh);
        drawCalls++;
      }
    }

    // --- what stands below decks ---------------------------------------------
    // The pump's tube and well, and the hold's stow. Separate from the deck's
    // fittings above for one reason and it is not tidiness: these are interior,
    // so they take `INTERIOR_SKY_VISIBILITY` and they mark the interior stencil.
    // Drawn into the deck's fitting mesh they would be lit as though they stood
    // on the quarterdeck, and the sea would draw straight over the hold.
    const belowDecks = buildInteriorFittingGeometry();
    for (const region of INTERIOR_FITTING_REGIONS) {
      const geometry = belowDecks.geometries.get(region);
      if (!geometry) continue;

      bakeEnclosedPortalLight(geometry);
      const material = createWorldPbrMaterial({
        color: INTERIOR_FITTING_PALETTE[region],
        roughness: INTERIOR_FITTING_FINISH[region].roughness,
        metalness: INTERIOR_FITTING_FINISH[region].metalness,
        skyVisibility: INTERIOR_SKY_VISIBILITY,
        portalLight: true,
        vertexColors: true,
        name: `interior:${region}`,
      });
      dressTimber(material, region === 'timber' ? 'holdOak' : null);
      material.shadowSide = THREE.DoubleSide;

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `interior:${region}`;
      mesh.renderOrder = INTERIOR_RENDER_ORDER;
      markAsInterior(material);
      this.interiorMaterials.push(material);
      this.interiorMeshes.push(mesh);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.layers.enable(LANTERN_SHADOW_LAYER);
      this.group.add(mesh);
      this.materials.push(material);
      this.geometries.push(geometry);
      drawCalls++;
    }

    // --- the shut scuttle's soffit -------------------------------------------
    // One state, drawn into the interior family so it is baked, culled and lit
    // as the piece of forecastle deckhead it is. See `foreScuttleSoffit`.
    {
      const set = buildForeScuttleSoffitGeometry();
      for (const region of INTERIOR_FITTING_REGIONS) {
        const geometry = set.geometries.get(region);
        if (!geometry) continue;
        bakeEnclosedPortalLight(geometry);
        const material = createWorldPbrMaterial({
          // The FITTING oak, because that is what the vertex attribute this
          // material multiplies was filled from. It used to name the lining,
          // and that was a claim about the drawn surface which the drawn
          // surface did not honour: `dressTimber` calls `color.setScalar(1)` on
          // the line below, so the argument never reached a pixel either way
          // and the only thing it did was mislead the next reader — including
          // `TIMBER_OF_MATERIAL`, which had to carry a paragraph explaining
          // that its own row was describing a fault. Byte-identical.
          //
          // The ROUGHNESS is still the lining's, and that one is live: 0.72
          // where `INTERIOR_FITTING_FINISH.timber` is 0.86. Left alone because
          // changing it moves pixels, which is Ash's call and not this round's.
          // REVIEW_QUEUE 1.5e.
          color: INTERIOR_FITTING_PALETTE.timber,
          roughness: FINISH.interiorLining.roughness,
          metalness: 0,
          skyVisibility: INTERIOR_SKY_VISIBILITY,
          portalLight: true,
          vertexColors: true,
          name: 'interior:scuttleSoffit',
        });
        material.shadowSide = THREE.DoubleSide;
        dressTimber(material, timberKeyOfMaterial('interior:scuttleSoffit'));
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = 'interior:scuttleSoffit';
        mesh.renderOrder = INTERIOR_RENDER_ORDER;
        markAsInterior(material);
        this.interiorMaterials.push(material);
        this.interiorMeshes.push(mesh);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.layers.enable(LANTERN_SHADOW_LAYER);
        this.group.add(mesh);
        this.materials.push(material);
        this.geometries.push(geometry);
        this.closureMeshList('foreScuttleLid').shut.push(mesh);
        drawCalls++;
      }
    }

    // --- the deadlights over the stern lights --------------------------------
    // One state, the scuttle soffit's case: unshipped they are inside the stern
    // lockers and there is nothing to draw. Fitting materials rather than the
    // lining's, and `addSternDeadlights` gives the reason — a board the colour
    // of the wall behind it does not read as shut.
    {
      const set = buildSternDeadlightGeometry();
      for (const region of INTERIOR_FITTING_REGIONS) {
        const geometry = set.geometries.get(region);
        if (!geometry) continue;
        bakeEnclosedPortalLight(geometry);
        const name = `interior:deadlight:${region}`;
        const material = createWorldPbrMaterial({
          color: INTERIOR_FITTING_PALETTE[region],
          roughness: INTERIOR_FITTING_FINISH[region].roughness,
          metalness: INTERIOR_FITTING_FINISH[region].metalness,
          skyVisibility: INTERIOR_SKY_VISIBILITY,
          portalLight: true,
          vertexColors: true,
          name,
        });
        dressTimber(material, region === 'timber' ? 'holdOak' : null);
        material.shadowSide = THREE.DoubleSide;
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = name;
        mesh.renderOrder = INTERIOR_RENDER_ORDER;
        markAsInterior(material);
        this.interiorMaterials.push(material);
        this.interiorMeshes.push(mesh);
        // **It casts, and that is half of what shipping one does.** The soft
        // channel gated in `publishPortalLight` is the sky's light through the
        // opening; the sun's own beam comes through the same hole as a
        // shadow-mapped directional and is stopped by real planking. A
        // deadlight that gated the channel and not the beam would shut the
        // cabin's daylight off and leave four rectangles of sunlight lying
        // across the sole.
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.layers.enable(LANTERN_SHADOW_LAYER);
        this.group.add(mesh);
        this.materials.push(material);
        this.geometries.push(geometry);
        this.closureMeshList('sternDeadlights').shut.push(mesh);
        drawCalls++;
      }
    }

    // --- the hatchway's boards, both ways ------------------------------------
    // Two meshes, one visible. See `buildHatchwayBoardGeometry` for why this is
    // not one mesh whose vertices move.
    for (const open of [false, true]) {
      const set = buildHatchwayBoardGeometry(open);
      for (const region of INTERIOR_FITTING_REGIONS) {
        const geometry = set.geometries.get(region);
        if (!geometry) continue;
        bakeEnclosedPortalLight(geometry);
        const material = createWorldPbrMaterial({
          // The fitting oak the vertex attribute actually carries — see the
          // scuttle soffit above for why this used to say lining, and why the
          // roughness beside it still does. REVIEW_QUEUE 1.5e.
          color: INTERIOR_FITTING_PALETTE.timber,
          roughness: FINISH.interiorLining.roughness,
          metalness: 0,
          skyVisibility: INTERIOR_SKY_VISIBILITY,
          portalLight: true,
          vertexColors: true,
          name: `interior:boards:${open ? 'open' : 'shut'}`,
        });
        material.shadowSide = THREE.DoubleSide;
        dressTimber(
          material,
          timberKeyOfMaterial(`interior:boards:${open ? 'open' : 'shut'}`),
        );
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `interior:boards:${open ? 'open' : 'shut'}`;
        mesh.renderOrder = INTERIOR_RENDER_ORDER;
        markAsInterior(material);
        this.interiorMaterials.push(material);
        this.interiorMeshes.push(mesh);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.layers.enable(LANTERN_SHADOW_LAYER);
        this.group.add(mesh);
        this.materials.push(material);
        this.geometries.push(geometry);
        const boards = this.closureMeshList('hatchwayBoards');
        (open ? boards.open : boards.shut).push(mesh);
        drawCalls++;
      }
    }

    // --- the captain's berth curtain, both ways -----------------------------
    // Closed linen spans the berth mouth and actually screens it; open linen
    // is gathered at the foot. Both are interior state meshes, so closure state
    // and portal culling compose by the same rule as the hatchway boards.
    for (const open of [false, true]) {
      const set = buildBoxBerthCurtainGeometry(open);
      for (const region of INTERIOR_FITTING_REGIONS) {
        const geometry = set.geometries.get(region);
        if (!geometry) continue;
        bakeEnclosedPortalLight(geometry);
        const name = `interior:berth-curtain:${open ? 'open' : 'closed'}:${region}`;
        const material = createWorldPbrMaterial({
          color: INTERIOR_FITTING_PALETTE[region],
          roughness: INTERIOR_FITTING_FINISH[region].roughness,
          metalness: INTERIOR_FITTING_FINISH[region].metalness,
          skyVisibility: INTERIOR_SKY_VISIBILITY,
          portalLight: true,
          vertexColors: true,
          name,
        });
        material.shadowSide = THREE.DoubleSide;
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = name;
        mesh.renderOrder = INTERIOR_RENDER_ORDER;
        markAsInterior(material);
        this.interiorMaterials.push(material);
        this.interiorMeshes.push(mesh);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.layers.enable(LANTERN_SHADOW_LAYER);
        this.group.add(mesh);
        this.materials.push(material);
        this.geometries.push(geometry);
        const curtain = this.closureMeshList('captainsBerthCurtain');
        (open ? curtain.open : curtain.shut).push(mesh);
        drawCalls++;
      }
    }

    // --- the captain's chair, both ways --------------------------------------
    // The boards' pattern again. Unlike the boards it takes the *fitting*
    // palette rather than the lining's, because a chair is a piece of furniture
    // standing in the room and not a part of the room's fabric — and because
    // its squab is leather, which the lining has no row for.
    for (const drawnOut of [false, true]) {
      const set = buildDeskChairGeometry(drawnOut);
      for (const region of INTERIOR_FITTING_REGIONS) {
        const geometry = set.geometries.get(region);
        if (!geometry) continue;
        bakeEnclosedPortalLight(geometry);
        const name = `interior:chair:${drawnOut ? 'drawn' : 'tucked'}:${region}`;
        const material = createWorldPbrMaterial({
          color: INTERIOR_FITTING_PALETTE[region],
          roughness: INTERIOR_FITTING_FINISH[region].roughness,
          metalness: INTERIOR_FITTING_FINISH[region].metalness,
          skyVisibility: INTERIOR_SKY_VISIBILITY,
          portalLight: true,
          vertexColors: true,
          name,
        });
        dressTimber(material, region === 'timber' ? 'holdOak' : null);
        material.shadowSide = THREE.DoubleSide;
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = name;
        mesh.renderOrder = INTERIOR_RENDER_ORDER;
        markAsInterior(material);
        this.interiorMaterials.push(material);
        this.interiorMeshes.push(mesh);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.layers.enable(LANTERN_SHADOW_LAYER);
        this.group.add(mesh);
        this.materials.push(material);
        this.geometries.push(geometry);
        (drawnOut ? this.seatMeshes.drawn : this.seatMeshes.tucked).push(mesh);
        drawCalls++;
      }
    }
    this.syncClosures();

    // --- the wind cues -------------------------------------------------------
    // Last, and not merged with anything: their cloth is the only geometry
    // aboard whose orientation is recomputed every frame, so each piece needs
    // its own transform. See `windCueSet.ts`.
    this.group.add(this.windCues.group);
    drawCalls += this.windCues.drawCalls;

    this.stats = {
      drawCalls,
      triangles:
        built.triangleCount +
        staticRig.triangleCount +
        liveRig.triangleCount +
        fittings.triangleCount +
        this.windCues.triangleCount,
      regions:
        built.geometries.size +
        staticRig.geometries.size +
        liveRig.geometries.size +
        fittings.geometries.size,
    };

    // On the quarterdeck, off the centreline to starboard, standing on the
    // walking surface rather than floating over it — `walkingDeckY` is the same
    // function the deck geometry is lofted from, so the lantern's foot cannot
    // drift away from the planks it sits on when the sheer is retuned.
    this.lamp.group.position.set(LAMP_X, walkingDeckY(LAMP_Z) + 0.02, LAMP_Z);
    this.lamp.group.rotation.y = 0.35;
    this.group.add(this.lamp.group);

    // In the opening, a little under the deck, aimed straight down. Sited from
    // the companionway's own constants rather than from figures typed here, so
    // that reversing the ladder's orientation — which is two constants in
    // `deckInterior.ts` — carries the light with it.
    {
      const z = (COMPANION_AFT_Z + COMPANION_FORWARD_Z) * 0.5;
      const y = walkingDeckY(z) - 0.1;
      this.companionLight.position.set(companionMidX(z), y, z);
      this.companionLight.angle = COMPANION_LIGHT_ANGLE;
      this.companionLight.penumbra = COMPANION_LIGHT_PENUMBRA;
      this.companionLight.decay = 1.1;
      this.companionLight.distance = 6;
      this.companionLight.castShadow = false;
      this.companionLight.target.position.set(companionMidX(z), CABIN_SOLE_Y, z);
      this.group.add(this.companionLight);
      this.group.add(this.companionLight.target);
    }

    // The lanterns below: one per walked room, each hook seated on the
    // underside of a real deck beam — `lampPlacement` owns the spots and
    // the beam snap, and the interactables read the same table for the
    // Space action's reach.
    const lamps = new Map<LampId, InteriorLamp>();
    for (const hang of LAMP_HANGS) {
      const lamp = new InteriorLamp(LAMP_DROP);
      const point = lampHangPoint(hang.id);
      lamp.group.position.set(point.x, point.y, point.z);
      this.group.add(lamp.group);
      lamps.set(hang.id, lamp);
    }
    this.interiorLamps = lamps;

    this.group.name = 'schooner';
    // Matches the rotation `BuoyantBody.transform` composes: Ry(yaw) then
    // Rx(pitch) then Rz(roll). Leaving this at the default XYZ puts the roll and
    // pitch axes in the wrong order and she leans the wrong way in a quartering
    // sea — subtly enough to look like a physics bug.
    this.group.rotation.order = 'YXZ';
  }

  /**
   * Arm the fallback stencil writer, or remove it for the shader-volume path.
   *
   * Leaving the writes active in the shader arm would benchmark both techniques
   * at once: the ocean would ignore the stencil, but the interior would still
   * pay to populate it. The two paths have to be complete alternatives.
   */
  setInteriorStencilEnabled(enabled: boolean): void {
    for (const material of this.interiorMaterials) {
      if (enabled) markAsInterior(material);
      else material.stencilWrite = false;
    }
  }

  /** Advance flotation and, in production, force-integrated horizontal motion. */
  advancePhysics(context: VesselPhysicsContext): void {
    const {
      dt,
      waves,
      localX,
      localZ,
      encounterVelocity,
      horizontalMotion,
    } = context;

    if (horizontalMotion) {
      const advanced = this.horizontalDynamics.advance(
        dt,
        this.body,
        waves,
        localX,
        localZ,
        encounterVelocity,
        this.yaw,
        this.yawRate,
        horizontalMotion,
      );
      this.yaw = advanced.yawRad;
      this.yawRate = advanced.yawRateRadPerSecond;
      // SURV1's production sidecar consumes the exact body pose paired with
      // each fixed-step crown-entry fact. Boarding and conservative deck
      // transport share the water clock; the load remains unread by motion and
      // scuppers, downflooding and wash presentation remain outside this seam.
      advanceSchoonerDeckWater(
        this.waterState,
        advanced.substeps,
        this.body.overtopEvents,
        this.body.substepAttitudes,
      );
    } else {
      // Viewers and diagnostic harnesses retain prescribed kinematics and the
      // flotation body's own fixed-step accumulator.
      this.body.update(
        dt,
        waves,
        localX,
        localZ,
        this.yaw,
        this.physicsStep,
        encounterVelocity.x,
        encounterVelocity.z,
      );
    }
  }

  /** Pose geometry and update carried presentation effects after physics. */
  updatePresentation(context: VesselPresentationContext): void {
    const {
      dt,
      localX,
      localZ,
      sunDirection,
      sunColor,
      sunIntensity,
      elapsed,
      ambientRadiance,
      skyHemisphericRadiance,
      apparentWindRender,
    } = context;
    this.pose(localX, localZ);

    // A real deck is part of the lighting environment around anything standing
    // inside its bulwarks. The pale planking receives both the sky and the Sun
    // and returns a small warm, low-frequency field; without that first bounce,
    // a wall facing away from the direct beam has only the distant sky/sea
    // probe and its red paint falls almost to black. Keep this separate from
    // the world probe: raising that would also relight the ocean and every
    // outdoor surface, while this transport exists only because the ship is
    // close to itself.
    this.deckLocalBounce.upWorld
      .set(0, 1, 0)
      .applyQuaternion(this.group.quaternion)
      .normalize();
    updateDeckLocalBounceIrradiance(
      this.deckLocalBounce.irradiance,
      this.deckLocalBounce.upWorld,
      skyHemisphericRadiance,
      sunDirection,
      sunColor,
      sunIntensity,
      this.deckBounceReflectance,
    );

    // After `pose`, and for the same reason the lantern is: the free-flying cues
    // are aimed in the world and handed back into the ship's frame, so they need
    // this frame's rotation rather than last frame's. A pennant given a stale
    // quaternion lags the roll it is supposed to be independent of, which reads
    // as the flag swinging every time she rolls — the exact artefact the
    // world-frame treatment exists to avoid.
    this.windCues.update(
      dt,
      apparentWindRender.x,
      apparentWindRender.z,
      this.yaw,
      this.group.quaternion,
    );

    // After `pose`, because the flame's world position is read off the finished
    // matrix — a lantern updated before the hull is posed reports last frame's
    // position, and the pool it throws on the water lags the ship that carries
    // it by exactly one frame, which reads as the reflection sliding.
    const sunElevationDeg =
      Math.asin(Math.min(Math.max(sunDirection.y, -1), 1)) * (180 / Math.PI);
    const a = ambientRadiance;
    const ambientLuminance = 0.2126 * a.x + 0.7152 * a.y + 0.0722 * a.z;
    this.lamp.update(dt, sunElevationDeg, elapsed, ambientLuminance);

    // WK3's overtop port. After `pose`, because the frame the inboard throw is
    // resolved against is this frame's, not last frame's — the same reason the
    // lantern and the wind cues are here.
    this.overtopFrame.originX = this.originPoint.x;
    this.overtopFrame.originZ = this.originPoint.z;
    this.overtopFrame.yaw = this.yaw;
    this.overtopSpray.update(dt, this.body.overtopEvents, this.overtopFrame);
    this.overtopSpray.setLight(ambientRadiance, sunColor, sunIntensity);

    // The companionway's shaft is *the sky's* light arriving through a hole, so
    // it is driven by the same ambient radiance the probe carries rather than by
    // a curve of its own. It therefore reddens at sunset and dies at dark
    // without anything here knowing what time it is — and when the lantern
    // becomes the room's light instead, this going out is what hands over.
    //
    // It is the LEGACY half of the interior A/B now: the portal model carries
    // the shaft's light as a real term with a real gradient, so running the
    // spot on top of it would count the same hole twice. The mix keeps it
    // alive exactly as far as the legacy model is dialled back in.
    this.companionLight.color.setRGB(a.x, a.y, a.z).multiplyScalar(
      1 / Math.max(ambientLuminance, 1e-4),
    );
    this.companionLight.intensity =
      ambientLuminance * COMPANION_LIGHT_GAIN * (1 - getPortalLightMix());

    // The eye adapts toward where it is, faster coming back to daylight than
    // going down into the dark — the asymmetry real adaptation has. This
    // binary state serves the 'fixed' A/B mode; the metered field below is
    // what the camera runs on.
    const adaptTarget = this.eyeBelowDecks ? 1 : 0;
    const tau = this.eyeBelowDecks
      ? EYE_ADAPTATION_IN_SECONDS
      : EYE_ADAPTATION_OUT_SECONDS;
    this.eyeAdaptation +=
      (1 - Math.exp(-dt / Math.max(tau, 1e-3))) * (adaptTarget - this.eyeAdaptation);

    this.publishPortalLight(sunDirection, sunColor, sunIntensity);

    // The lanterns below run on the signals the publish above just derived —
    // this frame's rooms, not last frame's. Same post-`pose` reasoning as the
    // deck lamp: each flame's world position is read off the finished matrix.
    // World-down in the ship's frame drives every swing: the ship rolls, the
    // chains stay with the world.
    this.lampDownLocal
      .set(0, -1, 0)
      .applyQuaternion(this.lampDownQuat.copy(this.group.quaternion).invert());
    for (const hang of LAMP_HANGS) {
      this.interiorLamps.get(hang.id)?.update(
        dt,
        elapsed,
        this.roomDaylight[hang.room],
        context.sceneExposure,
        this.lampDownLocal,
      );
    }

    // The metered exposure follows the light at the eye — published just
    // above, so the meter reads this frame's channels, not last frame's.
    const logTarget = Math.log(this.adaptationGainTarget());
    const gainTau =
      logTarget > this.smoothedLogGain
        ? this.adaptationTuning.darkenTauSeconds
        : this.adaptationTuning.brightenTauSeconds;
    this.smoothedLogGain +=
      (1 - Math.exp(-dt / Math.max(gainTau, 1e-3))) *
      (logTarget - this.smoothedLogGain);
  }

  /**
   * Feed the four portal channels from the live world probe and the sun.
   *
   * TWO QUANTITIES PER CHANNEL, AND THE SPLIT IS WHAT STOPS DOUBLE-COUNTING
   * -----------------------------------------------------------------------
   * `uPortalIrradiance` (the direct attribute's multiplier) carries the SKY's
   * diffuse irradiance on the opening's plane and nothing else: a wall facing
   * the companionway sees soft sky through the hole. The sun's own beam
   * through that hole is the shadow-mapped sun's job — a surface either sees
   * the disc (and the shadow map lights it exactly) or does not (and gets
   * nothing), so putting the sun into the direct channel would pay every
   * beam-lit surface twice.
   *
   * `uPortalBounce` carries sky PLUS the sun's beam flux projected onto the
   * opening — because once the beam has landed on the sole it is not a beam
   * any more, it is the room's brightest light source, and at noon it is
   * nearly all of what lights a real cabin. This was measured, not reasoned:
   * without the term the midday interior sat at the few percent of exterior
   * luminance a fixed-exposure camera renders as black, and the legacy spot's
   * 5.2x gain turned out to be an unlabelled stand-in for exactly this flux.
   * It dies with the sun's cosine at dusk, which is the handover the lantern
   * round inherits.
   */
  private publishPortalLight(
    sunDirection: THREE.Vector3,
    sunColor: THREE.Color,
    sunIntensity: number,
  ): void {
    const model = this.interiorLight;
    const sun = Math.max(sunIntensity, 0);

    // Channels 0 and 1 look straight up the ship's own deck axis, which the
    // deck bounce already maintains this frame. Sampled from the world source
    // map (§17.6: measured equivalent to the SH on the real sky, exact where
    // a spiky sky would defeat the basis) — `samplePortalSkyIrradiance`
    // carries the A/B and the pre-first-readback fallback.
    const up = this.deckLocalBounce.upWorld;
    const eUp = this.portalIrradiance[CHANNEL_COMPANION];
    samplePortalSkyIrradiance(up, eUp);
    this.portalIrradiance[CHANNEL_HATCH].copy(eUp);
    const sunUp = sun * Math.max(up.dot(sunDirection), 0);
    this.portalSunScratch[CHANNEL_COMPANION]
      .set(sunColor.r, sunColor.g, sunColor.b)
      .multiplyScalar(sunUp);
    this.portalSunScratch[CHANNEL_HATCH].copy(this.portalSunScratch[CHANNEL_COMPANION]);

    // Channel 4 is the fore scuttle: the same straight-up sky and the same
    // beam as the cargo hatch — an open hole in the planking is an open hole —
    // **and nothing at all while its lid is down.**
    //
    // Set here, before the wardroom's ambient is summed below, rather than
    // after it. The sum reads `portalIrradiance` for every channel but the
    // boards', and these vectors persist between frames, so a channel written
    // later than its readers is a channel read one frame stale. The scuttle's
    // coupling into the wardroom is nil either way; the ordering is right
    // because the next channel to want a gate might not be.
    const scuttleOpen = isClosureOpen('foreScuttleLid');
    this.portalIrradiance[CHANNEL_SCUTTLE].copy(eUp);
    this.portalSunScratch[CHANNEL_SCUTTLE].copy(this.portalSunScratch[CHANNEL_HATCH]);
    if (!scuttleOpen) {
      this.portalIrradiance[CHANNEL_SCUTTLE].set(0, 0, 0);
      this.portalSunScratch[CHANNEL_SCUTTLE].set(0, 0, 0);
    }

    // Channel 2 looks where the stern lights do — so a low sun astern floods
    // the cabin at the end of the day, and noon leaves the windows to the sky —
    // **and nothing at all while the deadlights are shipped.**
    //
    // The scuttle's rule, one room aft, and gated in the same place and for the
    // same ordering reason: the sum below reads `portalIrradiance` for every
    // channel but the boards', so a channel written after its readers is a
    // channel read one frame stale. It matters more here than it did for the
    // scuttle — the cabin's ambient genuinely does couple through the door into
    // the landing and on into the wardroom, which is a chain the solve carries
    // and a stale frame would carry wrongly.
    const windowsDir = this.portalDirScratch
      .copy(this.windowsSampleNormalLocal)
      .applyQuaternion(this.group.quaternion)
      .normalize();
    samplePortalSkyIrradiance(windowsDir, this.portalIrradiance[CHANNEL_WINDOWS]);
    const sunWindows = sun * Math.max(windowsDir.dot(sunDirection), 0);
    this.portalSunScratch[CHANNEL_WINDOWS]
      .set(sunColor.r, sunColor.g, sunColor.b)
      .multiplyScalar(sunWindows);
    if (!isClosureOpen('sternDeadlights')) {
      this.portalIrradiance[CHANNEL_WINDOWS].set(0, 0, 0);
      this.portalSunScratch[CHANNEL_WINDOWS].set(0, 0, 0);
    }

    // Channel 3 is the chain down the shaft: grating-filtered light straight
    // overhead, plus the wardroom's own solved ambient spilling over the
    // opening — and nothing at all while the boards are down.
    const wardroom = model.transfer.get('wardroom');
    const ambient = this.wardroomAmbientScratch.set(0, 0, 0);
    if (wardroom) {
      for (let p = 0; p < LIGHT_CHANNELS; p++) {
        if (p === CHANNEL_BOARDS) continue;
        ambient.addScaledVector(this.portalIrradiance[p], wardroom[p]);
        ambient.addScaledVector(this.portalSunScratch[p], wardroom[p]);
      }
    }
    const boards = this.portalIrradiance[CHANNEL_BOARDS];
    boards
      .copy(eUp)
      .add(this.portalSunScratch[CHANNEL_HATCH])
      .multiplyScalar(model.boards.toGratingF * model.boards.gratingTransmittance)
      .addScaledVector(ambient, model.boards.ambientSpill);
    this.portalSunScratch[CHANNEL_BOARDS].set(0, 0, 0);
    if (!isClosureOpen('hatchwayBoards')) boards.set(0, 0, 0);

    // Publish. The direct multiplier is sky-only; the bounce multiplier is
    // sky plus sun, tinted by the interior's own timber — what comes straight
    // through a hole is sky-coloured, what has touched the room first is warm.
    const tint = model.bounceTint;
    for (let p = 0; p < LIGHT_CHANNELS; p++) {
      const e = this.portalIrradiance[p];
      const s = this.portalSunScratch[p];
      this.portalBounceScratch.set(
        (e.x + s.x) * tint[0],
        (e.y + s.y) * tint[1],
        (e.z + s.z) * tint[2],
      );
      setPortalLight(p, e, this.portalBounceScratch);
    }

    // Each lamp room's own daylight, for the lantern hanging in it: the
    // same J = Σ transfer·(E+S) the boards' ambient-spill uses, times the
    // room's lift DIAL — deliberately not the mix-weighted lift the walls
    // show. The camera modes are legacy A/Bs, and a mode flip that also
    // flipped a lamp would compare two changes at once; each latch judges
    // its room as the shipping mode presents it, whatever mode the frame is
    // in. Strictly feed-forward — no lamp light exists in these terms, so a
    // lamp cannot see itself.
    for (const room of LAMP_ROOMS) {
      const transfer = model.transfer.get(room);
      let r = 0;
      let g = 0;
      let b = 0;
      if (transfer) {
        for (let p = 0; p < LIGHT_CHANNELS; p++) {
          const w = transfer[p];
          if (!w) continue;
          const e = this.portalIrradiance[p];
          const s = this.portalSunScratch[p];
          r += w * (e.x + s.x);
          g += w * (e.y + s.y);
          b += w * (e.z + s.z);
        }
      }
      this.roomDaylight[room] =
        (0.2126 * r + 0.7152 * g + 0.0722 * b) * this.roomLift(room);
    }
  }

  resetEffects(): void {
    this.overtopSpray.clear();
  }

  /** Publish the current contact-resolved wet ribbon to all exterior paints. */
  updateWetHullBand(
    sources: Readonly<WakeSources>,
    appearance: Readonly<HullWetBandAppearance>,
  ): void {
    this.wetHullBand.update(sources, appearance);
  }

  /**
   * Restore her horizontal state — heading included — to the loaded ship's.
   *
   * `yaw` was missing here, and its absence is the whole of the "vessel
   * attitude does not return" finding. Zeroing the rate but keeping the angle
   * hands the next run a hull already turned some way off the wind, so the
   * sails meet a different apparent angle on the first substep and the
   * divergence compounds with every frame of the settle — which is precisely
   * the measured signature: 0.026 mm of camera displacement after four warm
   * frames, 1.8 mm after forty.
   *
   * The caller is expected to re-derive the production heading afterwards
   * (`VesselRuntime.resetHorizontalMotion` does); zero is the authored value
   * this field is constructed with, not a course.
   */
  resetHorizontalMotion(): void {
    this.horizontalDynamics.reset();
    // This is the production opening-state restart boundary used by the
    // simulation reset. Shipped water is physical run state, not an effect;
    // leaving it aboard would make a reset begin from the previous sea trial.
    this.waterState.reset();
    this.yaw = 0;
    this.yawRate = 0;
  }

  activeOvertopSprayCount(): number {
    return this.overtopSpray.activeCount;
  }

  /**
   * Repaint her for a palette comparison. Debug only.
   *
   * The canonical colours are baked into the geometry's vertex attribute at
   * build time — that is what carries the per-strake variation, so the planking
   * differs plank to plank rather than being one flat wash. The material colour
   * multiplies it. So a repaint is a per-channel RATIO from the canonical
   * colour to the candidate, which retints the hull while preserving the
   * variation as a proportion of it.
   *
   * Both colours are linear (`THREE.Color` converts the sRGB hex on
   * construction), so the ratio is a linear-space ratio and the stated
   * reflectances mean what they say.
   */
  applyPalette(option: PaletteOption): void {
    this.deckBounceReflectance.set(
      option.colours.deck ?? SHIP_PALETTE.base.deck,
    );
    for (const mesh of this.group.children) {
      if (!(mesh instanceof THREE.Mesh)) continue;
      // Hull only. The rig's meshes live in the same group and carry `rig:`
      // names; repainting them from a hull palette would blank them to white,
      // because a hull palette has no entry for canvas or tarred hemp.
      if (!mesh.name.startsWith('ship:')) continue;
      const region = mesh.name.replace('ship:', '') as ShipRegion;
      const material = mesh.material as THREE.MeshStandardMaterial;

      const target = option.colours[region];
      if (target === undefined) {
        // Back to the timber round's own tint, not to white: the candidate
        // palettes override four painted regions and nothing else, so a plain
        // `setScalar(1)` here would strip the deck, the lining, the sole and
        // the joinery of their respec the moment a palette sheet was rendered
        // — and the sheet would then be comparing hull paints against a hull
        // whose timber had silently changed underneath them.
        dressTimber(material, timberKeyOfMaterial(mesh.name));
      } else {
        const base = new THREE.Color(SHIP_PALETTE.base[region]);
        const want = new THREE.Color(target);
        material.color.setRGB(
          want.r / Math.max(base.r, 1e-4),
          want.g / Math.max(base.g, 1e-4),
          want.b / Math.max(base.b, 1e-4),
          THREE.LinearSRGBColorSpace,
        );
      }
      material.roughness = option.roughness[region] ?? FINISH[region].roughness;
    }
  }

  /** Settle her onto the surface without integrating. */
  snapToSurface(waves: WaveField, localX = 0, localZ = 0): void {
    this.body.snapToSurface(waves, localX, localZ, this.yaw);
    this.pose(localX, localZ);
  }

  private pose(localX: number, localZ: number): void {
    // The group's origin is the ship's baseline on the centreline at midships —
    // the origin `hullForm.ts` draws in — so the body is asked where that point
    // has ended up rather than being told where to put it.
    this.body.worldPoint(0, 0, 0, localX, localZ, this.yaw, this.originPoint);
    this.group.position.set(this.originPoint.x, this.originPoint.y, this.originPoint.z);
    this.group.rotation.set(this.body.pitch, this.yaw, this.body.roll);
    this.group.updateMatrixWorld();
  }

  /**
   * Re-loft the rig at a live trim state (S4): booms swung, gaffs lowered,
   * sails gathered, furls bundled. Only the meshes a live state can move are
   * rebuilt — the masts, tops, shrouds and ratlines around them are never
   * touched. Geometry swaps in place, so the materials, including the
   * sailcloth's custom depth material, carry over untouched.
   *
   * Cheap enough to call every frame, which is what `main.ts` does while any
   * control is still travelling: at ~0.5 ms this is a rig that follows the
   * sheets, where a whole-rig rebuild had to be rationed to eight a second
   * and the cloth moved in visible steps.
   */
  updateRigLoft(state: RigLoftState): void {
    for (const [region, mesh] of this.rigMeshes) {
      this.liveGeometries.set(region, mesh.geometry as THREE.BufferGeometry);
    }
    // Ordinary frames write into the buffers already on the GPU and return
    // nothing. A sail crossing furled changes the cloth's vertex count, and
    // only then is there a geometry to swap.
    for (const [region, geometry] of refreshLiveRigGeometry(state, this.liveGeometries)) {
      const mesh = this.rigMeshes.get(region);
      if (!mesh) continue;
      // A fresh geometry has no baked enclosure attributes, and its material
      // reads them: unbaked, WebGL's (0,0,0,1) attribute default would light
      // the whole rig with the hold's channel the moment a sail crossed
      // furled. Re-bake before the swap is visible.
      if (region === 'spar') bakeSparPortalLight(geometry);
      const old = mesh.geometry as THREE.BufferGeometry;
      mesh.geometry = geometry;
      const index = this.geometries.indexOf(old);
      if (index >= 0) this.geometries[index] = geometry;
      old.dispose();
    }
  }

  dispose(): void {
    this.lamp.dispose();
    this.overtopSpray.dispose();
    for (const lamp of this.interiorLamps.values()) lamp.dispose();
    this.windCues.dispose();
    for (const m of this.materials) m.dispose();
    for (const g of this.geometries) g.dispose();
    this.group.clear();
  }
}
