/**
 * The interior light graph: rooms, portals, and the transfer solve.
 *
 * WHY THIS EXISTS
 * ---------------
 * Below decks the world probe used to arrive as `0.14 × SH(normal)` — a scaled
 * copy of the *open sky's own directional distribution*, indoors. The scale
 * touched the level and not the lopsidedness, so at midday one wall of the
 * captain's cabin sampled the sunward half of the sky and the opposite wall the
 * far half, and the room read as one lit wall and one black one. Enclosure was
 * a constant when the real quantity is *where the openings are*.
 *
 * THE MODEL
 * ---------
 * Daylight enters an interior only through its openings, and every opening the
 * ship has is a rectangle this file can read from the tables that built it:
 * the companionway, the cargo hatch under its grating, the four stern lights,
 * the hatchway boards over the hold, and the three doorways between rooms.
 *
 * Light is carried in **four channels**, one per family of sky opening:
 *
 *   0  the companionway (always open)
 *   1  the cargo hatch, through its grating
 *   2  the stern windows, through their glass
 *   3  the hold's hatchway boards (gated at runtime by openness)
 *
 * At runtime each channel gets one RGB irradiance — the live world SH sampled
 * at the portal's own plane — so the interior reddens at sunset and dies at
 * dark for free, exactly as the companion spot it replaces did. Everything
 * *geometric* is static and solved here once:
 *
 *   - per-vertex cosine-weighted form factors to the openings of the vertex's
 *     own room (`vertexLightResponse` — the directional part: a wall facing
 *     the companionway is brighter than the wall facing away);
 *   - a per-room radiosity solve over the room graph (`roomTransfer` — the
 *     multi-hop part: stern windows → cabin ambient → doorway → landing →
 *     doorway → wardroom, to convergence, because it is a linear solve rather
 *     than a hop count);
 *   - doorway glow folded back into the channels (a doorway is a rectangle
 *     radiating its neighbour room's solved ambient, and that ambient is
 *     linear in the four channel inputs, so a doorway needs no channel of its
 *     own).
 *
 * Direct sun through the openings is deliberately NOT here: the shadow-mapped
 * sun already shines through real holes and is occluded by real planking. This
 * file is the soft skylight and everything after the first bounce.
 *
 * PURE ON PURPOSE
 * ---------------
 * No three imports, same argument as `sphericalHarmonics.ts`: the numbers here
 * have exactly known right answers (a form factor is a contour integral, a
 * radiosity solve conserves energy) and the only way to keep them honest is a
 * test with no GPU in the way. `interiorLightBake.ts` owns the BufferGeometry
 * side; `WorldPbrMaterial.ts` owns the shader side.
 */

import {
  BELOW_DECKS_SPACES,
  BULKHEADS,
  DOORWAY_HALF_BREADTH,
  HATCHWAY_AFT_Z,
  HATCHWAY_FORWARD_Z,
  HATCHWAY_HALF_BREADTH,
  INTERIOR_STEPS,
  STERN_WINDOWS,
  type BelowDecksSpace,
  type SpaceName,
  belowDecksSpace,
  companionXLimits,
  doorwayHeadY,
  inStepsWell,
  spaceClearHeightAt,
  spaceDeckheadY,
  spaceHalfWidthAt,
  spaceSoleArea,
  stepsLowY,
  sternWindowZAt,
} from './deckInterior';
import {
  COMPANION_AFT_Z,
  COMPANION_FORWARD_Z,
  FORE_SCUTTLE_HALF_BREADTH,
  FORE_SCUTTLE_X,
  FORE_SCUTTLE_Z,
  PLATFORM_AFT_Z,
  PLATFORM_FORWARD_Z,
  PLATFORM_SOLE_Y,
} from './hullForm';
import { deckOverheadAt } from './deckSurface';
import { GRATING_BATTEN, GRATING_GAP } from './deckFittings';
import { HOLD_DECKHEAD_Y, HOLD_FLOOR_Y } from './holdStow';
import { SHIP_PALETTE } from './shipGeometry';
import { INTERIOR_FITTING_PALETTE } from './interiorFittingGeometry';

/** The rooms light is solved over: the four walked spaces, plus the hold. */
export type LightRoomName = SpaceName | 'hold';

export const LIGHT_CHANNELS = 5;

/** Channel indices, named. The vec4 attribute and the uniforms share them. */
export const CHANNEL_COMPANION = 0;
export const CHANNEL_HATCH = 1;
export const CHANNEL_WINDOWS = 2;
export const CHANNEL_BOARDS = 3;
/**
 * The fore scuttle over the forecastle.
 *
 * **It has a channel of its own and could not share one.** It wants a runtime
 * gate — shut the lid and the room goes back to being dark — and a gate is a
 * property of a channel, because the runtime's only lever is the value it
 * publishes for one. `CHANNEL_HATCH` was tried first and is wrong for a
 * measured reason rather than a theoretical one: the forecastle's light
 * *before* this scuttle existed also arrived on `CHANNEL_HATCH`, coupled
 * through the wardroom doorway, and metered 2.9e-2 mid-room against the
 * cabin's 7.6e-2 — dim, but a third of the captain's cabin and not nothing.
 * Gating that channel for this room would have taken the scuttle's light away
 * *and* the doorway's, leaving a lid you shut to make the room blacker than
 * the ship had ever drawn it.
 *
 * `CHANNEL_BOARDS` cannot be shared either, and for a different reason worth
 * recording: it is not a sky opening at all. Its irradiance is *re-radiated* —
 * grating-filtered sky plus the wardroom's own solved ambient, summed over
 * every other channel at runtime. That is why it exists, and it is why a hole
 * looking straight up at the sky cannot borrow it.
 */
export const CHANNEL_SCUTTLE = 4;

export interface LightRect {
  readonly name: string;
  /** Centre of the rectangle, ship-local. */
  readonly centre: readonly [number, number, number];
  /** Half-edge vectors spanning the rectangle from its centre. */
  readonly edgeU: readonly [number, number, number];
  readonly edgeV: readonly [number, number, number];
  /** Unit normal on the side the light arrives on — INTO the room. */
  readonly normal: readonly [number, number, number];
}

export interface SkyPortal extends LightRect {
  readonly channel: number;
  /** The room whose vertices see this rectangle directly. */
  readonly room: LightRoomName;
  /**
   * Fraction of the incident light the covering passes. The grating's is the
   * open-cell fraction of its lattice; the glass is period crown glass; the
   * companionway is an open hole. Static — folded into attributes and the
   * solve, never into the runtime uniforms.
   */
  readonly transmittance: number;
  /**
   * Direction the runtime samples the world SH at for this portal's channel —
   * the outward continuation of what the opening faces. Ship-local; the
   * runtime rotates it by the ship's pose.
   */
  readonly sampleNormal: readonly [number, number, number];
}

export interface DoorwayPortal extends LightRect {
  /** The room this face glows into. */
  readonly room: LightRoomName;
  /** The room whose solved ambient shines through it. */
  readonly neighbour: LightRoomName;
}

export interface LightRoom {
  readonly name: LightRoomName;
  readonly zAft: number;
  readonly zForward: number;
  readonly soleY: number;
  /** Total interior surface area, m² — sole, deckhead, sides and ends. */
  readonly area: number;
  /** Area-weighted mean albedo, scalar luminance of the linear paint. */
  readonly albedo: number;
  /** Sky-portal + doorway area opening the room's cavity, m². */
  readonly openingArea: number;
}

export interface InteriorLightModel {
  readonly rooms: readonly LightRoom[];
  readonly skyPortals: readonly SkyPortal[];
  readonly doorways: readonly DoorwayPortal[];
  /**
   * Solved room radiosity per unit channel irradiance: `transfer[room][p]` is
   * room's mean surface radiosity when channel `p`'s portal plane receives
   * unit irradiance and every other channel is dark. The multi-hop doorway
   * exchange is inside these numbers — the solve below runs to convergence.
   *
   * The hold is NOT in this map: its input (channel 3) is itself derived from
   * the others, see `boardsIrradianceCoefficients`.
   */
  readonly transfer: ReadonlyMap<LightRoomName, readonly number[]>;
  /** The hold's mean radiosity per unit irradiance on the open boards plane. */
  readonly holdTransfer: number;
  /**
   * Channel 3's runtime derivation. With the boards open, the irradiance on
   * the boards plane is `toGratingF · τ_grating · E₁ + spill · J_wardroom`,
   * where `J_wardroom = Σ transfer[wardroom][p] · E_p`. All static but the
   * E's.
   */
  readonly boards: {
    readonly toGratingF: number;
    readonly gratingTransmittance: number;
    readonly ambientSpill: number;
  };
  /**
   * The warm cast of bounced light: the interior's area-weighted linear
   * albedo, normalised to unit luminance. The transfer numbers carry the
   * magnitude; this carries the colour. One tint for the whole interior —
   * per-room tints would need a vec4 per room per vertex, and the rooms are
   * all oiled oak and scrubbed pine within a few percent of each other.
   */
  readonly bounceTint: readonly [number, number, number];
  /**
   * The spatial shape of each room's ambient bath, per channel — §15.5 item
   * 2's gradient. See `bathGradientAt`.
   */
  readonly bathGradients: ReadonlyMap<
    LightRoomName,
    readonly BathGradientChannel[]
  >;
}

/**
 * One channel's bath gradient in one room: where that channel's flux enters
 * (its own sky portals, and the doorways carrying it from neighbours, each
 * weighted by how much it actually admits), and the normalisation that keeps
 * the gradient a redistribution rather than a light.
 */
export interface BathGradientChannel {
  readonly sources: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly z: number;
    /** Fraction of the channel's inflow this source carries; sums to 1. */
    readonly w: number;
  }>;
  /** Kernel half-falloff distance — the room's own scale. */
  readonly d0: number;
  /** Area-weighted mean of the kernel over the room's surfaces. */
  readonly meanKernel: number;
}

// --- small pure helpers -------------------------------------------------------

function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear RGB of a packed sRGB hex colour, as three authors them. */
export function linearRgbOfHex(hex: number): [number, number, number] {
  return [
    srgbChannelToLinear(((hex >> 16) & 0xff) / 255),
    srgbChannelToLinear(((hex >> 8) & 0xff) / 255),
    srgbChannelToLinear((hex & 0xff) / 255),
  ];
}

export function luminanceOf(rgb: readonly [number, number, number]): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function normalise3(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
}

function cross3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Area of a `LightRect`, m². */
export function rectArea(rect: LightRect): number {
  const c = cross3(rect.edgeU, rect.edgeV);
  return 4 * Math.hypot(c[0], c[1], c[2]);
}

/** The four corners, for the culling frustum test and for tests. */
export function rectCorners(rect: LightRect): [number, number, number][] {
  const { centre: c, edgeU: u, edgeV: v } = rect;
  const corner = (su: number, sv: number): [number, number, number] => [
    c[0] + su * u[0] + sv * v[0],
    c[1] + su * u[1] + sv * v[1],
    c[2] + su * u[2] + sv * v[2],
  ];
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
}

// --- the cosine-weighted form factor ------------------------------------------

/**
 * Cosine-weighted form factor from a point receiver to a rectangle: the
 * fraction of the receiver's cosine-weighted hemisphere the rectangle's
 * *unoccluded* light occupies, in [0, 1]. A receiver whose whole upper
 * hemisphere is the rectangle returns 1; irradiance is then `F × E_portal`
 * when the portal plane carries irradiance `E`.
 *
 * Adaptive quadrature rather than the exact contour integral, deliberately:
 * the contour form needs the rectangle clipped against the receiver's horizon
 * plane, and polygon clipping is exactly the kind of code that is wrong at one
 * corner for a year. Cells refine until they subtend less than ~14° from the
 * receiver, which keeps the near-field error under a percent — and the test
 * suite holds this against a Monte Carlo reference rather than trusting the
 * comment.
 */
export function rectFormFactor(
  px: number,
  py: number,
  pz: number,
  nx: number,
  ny: number,
  nz: number,
  rect: LightRect,
): number {
  const rn = rect.normal;
  let sum = 0;

  // Depth-first refinement over (u, v) cells of the rectangle.
  const cell = (u0: number, u1: number, v0: number, v1: number, depth: number): void => {
    const uc = (u0 + u1) * 0.5;
    const vc = (v0 + v1) * 0.5;
    const cx = rect.centre[0] + uc * rect.edgeU[0] + vc * rect.edgeV[0];
    const cy = rect.centre[1] + uc * rect.edgeU[1] + vc * rect.edgeV[1];
    const cz = rect.centre[2] + uc * rect.edgeU[2] + vc * rect.edgeV[2];

    const dx = cx - px;
    const dy = cy - py;
    const dz = cz - pz;
    const r2 = dx * dx + dy * dy + dz * dz;
    const r = Math.sqrt(r2);

    // Cell extent along its two half-edges.
    const eu = ((u1 - u0) * 0.5) * 2 * Math.hypot(rect.edgeU[0], rect.edgeU[1], rect.edgeU[2]);
    const ev = ((v1 - v0) * 0.5) * 2 * Math.hypot(rect.edgeV[0], rect.edgeV[1], rect.edgeV[2]);
    const extent = Math.max(eu, ev);

    // Refine while a cell subtends more than ~14° — and keep refining right
    // down to depth 12 for receivers close to the plane (a tread just under
    // the companionway, the boards' own faces), where the integrand is
    // near-singular and a shallow cap under-integrates it by orders of
    // magnitude. The refinement is local to those cells, so the deep cap
    // costs nothing in the far field.
    if (depth < 12 && extent > 0.25 * r) {
      const um = (u0 + u1) * 0.5;
      const vm = (v0 + v1) * 0.5;
      cell(u0, um, v0, vm, depth + 1);
      cell(um, u1, v0, vm, depth + 1);
      cell(u0, um, vm, v1, depth + 1);
      cell(um, u1, vm, v1, depth + 1);
      return;
    }

    if (r2 < 1e-8) {
      // The receiver is on the portal plane inside this cell: it sees half of
      // everything, and the quadrature cannot resolve that. Saturate.
      sum += 0.5;
      return;
    }

    const inv = 1 / r;
    // Receiver cosine: the portal sample must be above the receiver's horizon.
    const cosReceiver = (dx * nx + dy * ny + dz * nz) * inv;
    if (cosReceiver <= 0) return;
    // Portal cosine: the receiver must be on the side the light arrives on.
    const cosPortal = -(dx * rn[0] + dy * rn[1] + dz * rn[2]) * inv;
    if (cosPortal <= 0) return;

    const area = eu * ev;
    sum += (cosReceiver * cosPortal * area) / (Math.PI * r2);
  };

  cell(-1, 1, -1, 1, 0);
  return Math.min(sum, 1);
}

/**
 * Mean form factor from one rectangle to another — the boards plane to the
 * grating above it. Quadrature over the source rectangle of the point form.
 */
export function rectToRectFormFactor(source: LightRect, target: LightRect): number {
  const N = 6;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const u = ((i + 0.5) / N) * 2 - 1;
      const v = ((j + 0.5) / N) * 2 - 1;
      const px = source.centre[0] + u * source.edgeU[0] + v * source.edgeV[0];
      const py = source.centre[1] + u * source.edgeU[1] + v * source.edgeV[1];
      const pz = source.centre[2] + u * source.edgeU[2] + v * source.edgeV[2];
      sum += rectFormFactor(
        px,
        py,
        pz,
        source.normal[0],
        source.normal[1],
        source.normal[2],
        target,
      );
    }
  }
  return sum / (N * N);
}

// --- the openings, read off the ship's own tables ------------------------------

/**
 * Open-cell fraction of the cargo hatch grating: battens laid both ways, so
 * light passes only where gap crosses gap. Derived from the grating's own
 * scantlings rather than chosen — change the battens and the wardroom's light
 * follows.
 */
export function gratingTransmittance(): number {
  const open = GRATING_GAP / (GRATING_BATTEN + GRATING_GAP);
  return open * open;
}

/**
 * Period crown glass, four small panes with their bars. A stated approximation
 * rather than a derivation — glass transmission is a material fact this
 * project has no table for. Bars and dirt are why it is below the 0.9 of
 * clean modern float glass.
 */
export const STERN_GLASS_TRANSMITTANCE = 0.65;

/**
 * What the companionway's open forward face passes, relative to open sky.
 *
 * The shaft exits at the deck break, so its forward face looks out over the
 * waist deck: the upper half of that prospect is sky and rig, the lower half
 * is planking returning deck bounce. Half is the honest low-frequency figure,
 * and it shares the channel (and so the runtime sky sample) with the overhead
 * opening rather than earning a channel of its own.
 */
export const COMPANION_BREAK_FACE_TRANSMITTANCE = 0.5;

/** The deck planking's upper surface just outside an opening, for portal planes. */
function deckYBeside(x: number, z: number, fallback: number): number {
  const over = deckOverheadAt(x, z);
  return over ? over.y : fallback;
}

function buildSkyPortals(): SkyPortal[] {
  const portals: SkyPortal[] = [];

  // The companionway: a bite out of the quarterdeck's forward edge, running
  // from `COMPANION_INBOARD_X` to the ship's side. The portal plane sits at
  // the quarterdeck's own level, sampled just abaft the opening.
  {
    const zMid = (COMPANION_AFT_Z + COMPANION_FORWARD_Z) * 0.5;
    const aft = companionXLimits(COMPANION_AFT_Z);
    const fore = companionXLimits(COMPANION_FORWARD_Z);
    const xLo = (aft.xLo + fore.xLo) * 0.5;
    const xHi = (aft.xHi + fore.xHi) * 0.5;
    const xMid = (xLo + xHi) * 0.5;
    const y = deckYBeside(0.2, COMPANION_AFT_Z - 0.15, 4.43);
    portals.push({
      name: 'companionway',
      channel: CHANNEL_COMPANION,
      room: 'landing',
      centre: [xMid, y, zMid],
      edgeU: [(xHi - xLo) * 0.5, 0, 0],
      edgeV: [0, 0, (COMPANION_FORWARD_Z - COMPANION_AFT_Z) * 0.5],
      normal: [0, -1, 0],
      transmittance: 1,
      sampleNormal: [0, 1, 0],
    });

    // The shaft's open forward face at the deck break.
    const waistY = deckYBeside(xMid, COMPANION_FORWARD_Z + 0.15, 3.88);
    if (y > waistY + 0.05) {
      portals.push({
        name: 'companionway-break-face',
        channel: CHANNEL_COMPANION,
        room: 'landing',
        centre: [xMid, (waistY + y) * 0.5, COMPANION_FORWARD_Z],
        edgeU: [(xHi - xLo) * 0.5, 0, 0],
        edgeV: [0, (y - waistY) * 0.5, 0],
        normal: [0, 0, -1],
        transmittance: COMPANION_BREAK_FACE_TRANSMITTANCE,
        sampleNormal: [0, 1, 0],
      });
    }
  }

  // The cargo hatch, under its grating, over the wardroom's shaft.
  {
    const zMid = (HATCHWAY_AFT_Z + HATCHWAY_FORWARD_Z) * 0.5;
    const y = deckYBeside(HATCHWAY_HALF_BREADTH + 0.2, zMid, 3.9);
    portals.push({
      name: 'cargo-hatch-grating',
      channel: CHANNEL_HATCH,
      room: 'wardroom',
      centre: [0, y, zMid],
      edgeU: [HATCHWAY_HALF_BREADTH, 0, 0],
      edgeV: [0, 0, (HATCHWAY_FORWARD_Z - HATCHWAY_AFT_Z) * 0.5],
      normal: [0, -1, 0],
      transmittance: gratingTransmittance(),
      sampleNormal: [0, 1, 0],
    });
  }

  // The fore scuttle, over the forecastle. Its lid is straight oak with no
  // grating in it, so what it passes when it is up is open sky: transmittance
  // 1, and the plane sits at the planking like the cargo hatch's does.
  //
  // On `CHANNEL_SCUTTLE`, which exists for it — see the constant for why it
  // could share neither of the two channels that already looked like they
  // would do. The runtime gates that channel on the lid, the same way it gates
  // the boards', so shutting the scuttle returns the forecastle to exactly the
  // doorway-lit dark it had before this round cut a hole in it.
  {
    const zMid = FORE_SCUTTLE_Z;
    const y = deckYBeside(
      FORE_SCUTTLE_X + FORE_SCUTTLE_HALF_BREADTH + 0.2,
      zMid,
      4.02,
    );
    portals.push({
      name: 'fore-scuttle',
      channel: CHANNEL_SCUTTLE,
      room: 'forecastle',
      centre: [FORE_SCUTTLE_X, y, zMid],
      edgeU: [FORE_SCUTTLE_HALF_BREADTH, 0, 0],
      edgeV: [0, 0, FORE_SCUTTLE_HALF_BREADTH],
      normal: [0, -1, 0],
      transmittance: 1,
      sampleNormal: [0, 1, 0],
    });
  }

  // The four stern lights, raked with the counter they are cut through.
  for (let i = 0; i < STERN_WINDOWS.length; i++) {
    const w = STERN_WINDOWS[i];
    const zAtSill = sternWindowZAt(w.y - w.halfHeight);
    const zAtHead = sternWindowZAt(w.y + w.halfHeight);
    const dzdy = (zAtHead - zAtSill) / (2 * w.halfHeight);
    // The glass leans aft going down; its inward normal leans forward and up.
    const inward = normalise3([0, -dzdy, 1]);
    portals.push({
      name: `stern-window-${i}`,
      channel: CHANNEL_WINDOWS,
      room: 'cabin',
      centre: [w.x, w.y, sternWindowZAt(w.y)],
      edgeU: [w.halfWidth, 0, 0],
      edgeV: [0, w.halfHeight, dzdy * w.halfHeight],
      normal: inward,
      transmittance: STERN_GLASS_TRANSMITTANCE,
      sampleNormal: [-inward[0], -inward[1], -inward[2]],
    });
  }

  // The hatchway boards over the hold. Transmittance 1: the runtime gates
  // this channel by the boards' openness instead.
  {
    const zMid = (HATCHWAY_AFT_Z + HATCHWAY_FORWARD_Z) * 0.5;
    portals.push({
      name: 'hold-boards',
      channel: CHANNEL_BOARDS,
      room: 'hold',
      centre: [0, PLATFORM_SOLE_Y, zMid],
      edgeU: [HATCHWAY_HALF_BREADTH, 0, 0],
      edgeV: [0, 0, (HATCHWAY_FORWARD_Z - HATCHWAY_AFT_Z) * 0.5],
      normal: [0, -1, 0],
      transmittance: 1,
      sampleNormal: [0, 1, 0],
    });
  }

  return portals;
}

function buildDoorways(): DoorwayPortal[] {
  const out: DoorwayPortal[] = [];
  const roomOn = (z: number, sole: number | null, side: 1 | -1): LightRoomName | null => {
    if (sole === null) return null;
    const inside = z + side * 0.02;
    const space = BELOW_DECKS_SPACES.find(
      (s) => inside >= s.zAft && inside <= s.zForward && Math.abs(s.soleY - sole) < 1e-6,
    );
    return space ? space.name : null;
  };

  for (const bulkhead of BULKHEADS) {
    if (bulkhead.sillY === null) continue;
    const head = doorwayHeadY(bulkhead);
    if (head === null || head <= bulkhead.sillY) continue;
    const aft = roomOn(bulkhead.z, bulkhead.soleAft, -1);
    const forward = roomOn(bulkhead.z, bulkhead.soleForward, 1);
    if (!aft || !forward) continue;

    const centre: [number, number, number] = [
      bulkhead.doorX,
      (bulkhead.sillY + head) * 0.5,
      bulkhead.z,
    ];
    const edgeU: [number, number, number] = [DOORWAY_HALF_BREADTH, 0, 0];
    const edgeV: [number, number, number] = [0, (head - bulkhead.sillY) * 0.5, 0];
    // One rectangle per face: each glows into its own room with the other
    // room's solved ambient behind it.
    out.push({
      name: `${bulkhead.name}-aft-face`,
      room: aft,
      neighbour: forward,
      centre,
      edgeU,
      edgeV,
      normal: [0, 0, -1],
    });
    out.push({
      name: `${bulkhead.name}-forward-face`,
      room: forward,
      neighbour: aft,
      centre,
      edgeU,
      edgeV,
      normal: [0, 0, 1],
    });
  }
  return out;
}

// --- the rooms, measured off the arrangement -----------------------------------

const SOLE_ALBEDO = luminanceOf(linearRgbOfHex(SHIP_PALETTE.base.interiorSole));
const LINING_ALBEDO = luminanceOf(linearRgbOfHex(SHIP_PALETTE.base.interiorLining));
const HOLD_ALBEDO = luminanceOf(linearRgbOfHex(INTERIOR_FITTING_PALETTE.timber));

function roomSurfaceAreas(space: BelowDecksSpace): { sole: number; rest: number } {
  const sole = spaceSoleArea(space);
  const STEPS = 48;
  const span = space.zForward - space.zAft;
  let sides = 0;
  let deckhead = 0;
  for (let i = 0; i < STEPS; i++) {
    const z = space.zAft + (span * (i + 0.5)) / STEPS;
    const half = spaceHalfWidthAt(space, z);
    const clearMid = spaceClearHeightAt(space, 0, z) ?? 0;
    const clearSide = spaceClearHeightAt(space, half * 0.9, z) ?? clearMid;
    sides += 2 * clearSide * (span / STEPS);
    deckhead += 2 * half * (span / STEPS);
  }
  // The two ends: bulkhead faces, or the transom's lining aft of the cabin.
  const endArea = (z: number): number => {
    const half = spaceHalfWidthAt(space, z + (z === space.zAft ? 0.05 : -0.05));
    const clear = spaceClearHeightAt(space, 0, z + (z === space.zAft ? 0.05 : -0.05)) ?? 0;
    return 2 * half * clear;
  };
  const rest = sides + deckhead + endArea(space.zAft) + endArea(space.zForward);
  return { sole, rest };
}

function buildRooms(skyPortals: readonly SkyPortal[], doorways: readonly DoorwayPortal[]): LightRoom[] {
  const openingAreaOf = (name: LightRoomName): number => {
    let a = 0;
    for (const p of skyPortals) if (p.room === name) a += rectArea(p);
    for (const d of doorways) if (d.room === name) a += rectArea(d);
    return a;
  };

  const rooms: LightRoom[] = BELOW_DECKS_SPACES.map((space) => {
    const { sole, rest } = roomSurfaceAreas(space);
    const area = sole + rest;
    return {
      name: space.name,
      zAft: space.zAft,
      zForward: space.zForward,
      soleY: space.soleY,
      area,
      albedo: (sole * SOLE_ALBEDO + rest * LINING_ALBEDO) / Math.max(area, 1e-6),
      openingArea: openingAreaOf(space.name),
    };
  });

  // The hold: the compartment under the wardroom, floored by the ballast and
  // roofed by the platform's beams, walled by its own bulkheads and the stow.
  // Its cavity is mostly cargo: count the plan twice (floor and deckhead), the
  // perimeter at its clear height, and the stow's own presented faces as
  // roughly one more plan's worth — a stated low-fidelity estimate for a room
  // whose ambient is dominated by its one opening in any case.
  {
    const wardroom = belowDecksSpace('wardroom');
    const plan = spaceSoleArea(wardroom);
    const span = wardroom.zForward - wardroom.zAft;
    const clear = HOLD_DECKHEAD_Y - HOLD_FLOOR_Y;
    const perimeter = 2 * span + 4 * spaceHalfWidthAt(wardroom, (wardroom.zAft + wardroom.zForward) / 2);
    const area = plan * 3 + perimeter * clear;
    rooms.push({
      name: 'hold',
      zAft: wardroom.zAft,
      zForward: wardroom.zForward,
      soleY: HOLD_FLOOR_Y,
      area,
      albedo: HOLD_ALBEDO,
      openingArea: openingAreaOf('hold'),
    });
  }

  return rooms;
}

// --- the solve ------------------------------------------------------------------

/**
 * Solve the room-exchange system for the walked rooms.
 *
 * Unknowns: J_i, the mean radiosity of room i's surfaces, per unit channel
 * irradiance. Each room's surfaces receive the flux its own sky portals admit
 * (spread over its area), the neighbour rooms' radiosity through the doorways,
 * and the room's own radiosity back off the rest of the cavity; they reflect
 * albedo times the total:
 *
 *   J_i = ρ_i [ Σ_p (A_p τ_p / A_i) E_p + Σ_d (A_d / A_i) J_j(d) + (1 − f_i) J_i ]
 *
 * with f_i the room's opening fraction — an integrating sphere with holes,
 * coupled through the holes. Linear, four unknowns, solved exactly by
 * elimination per channel. The hold is kept out and chained (see `boards`).
 */
function solveTransfer(
  rooms: readonly LightRoom[],
  skyPortals: readonly SkyPortal[],
  doorways: readonly DoorwayPortal[],
): Map<LightRoomName, number[]> {
  const solved = rooms.filter((r) => r.name !== 'hold');
  const index = new Map(solved.map((r, i) => [r.name, i]));
  const n = solved.length;

  // Per-channel direct input coefficients: D[i][p] = Σ A_p τ_p / A_i.
  const D: number[][] = solved.map(() => new Array<number>(LIGHT_CHANNELS).fill(0));
  for (const p of skyPortals) {
    const i = index.get(p.room);
    if (i === undefined) continue;
    D[i][p.channel] += (rectArea(p) * p.transmittance) / solved[i].area;
  }

  // System matrix (I − M), M[i][i] = ρ(1 − f), M[i][j] += ρ A_d / A_i.
  const M: number[][] = solved.map(() => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    const f = Math.min(solved[i].openingArea / solved[i].area, 0.9);
    M[i][i] = solved[i].albedo * (1 - f);
  }
  for (const d of doorways) {
    const i = index.get(d.room);
    const j = index.get(d.neighbour);
    if (i === undefined || j === undefined) continue;
    M[i][j] += (solved[i].albedo * rectArea(d)) / solved[i].area;
  }

  // Solve (I − M) J = ρ D e_p for each channel by Gaussian elimination.
  const out = new Map<LightRoomName, number[]>(
    solved.map((r) => [r.name, new Array<number>(LIGHT_CHANNELS).fill(0)]),
  );
  for (let p = 0; p < LIGHT_CHANNELS; p++) {
    const a: number[][] = [];
    for (let i = 0; i < n; i++) {
      const row = new Array<number>(n + 1).fill(0);
      for (let j = 0; j < n; j++) row[j] = (i === j ? 1 : 0) - M[i][j];
      row[n] = solved[i].albedo * D[i][p];
      a.push(row);
    }
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
      }
      [a[col], a[pivot]] = [a[pivot], a[col]];
      const lead = a[col][col];
      if (Math.abs(lead) < 1e-12) continue;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const k = a[r][col] / lead;
        for (let c = col; c <= n; c++) a[r][c] -= k * a[col][c];
      }
    }
    for (let i = 0; i < n; i++) {
      const lead = a[i][i];
      out.get(solved[i].name)![p] = Math.abs(lead) < 1e-12 ? 0 : a[i][n] / lead;
    }
  }
  return out;
}

// --- the bath gradient -----------------------------------------------------------

/**
 * §15.5 item 2: the room-uniform ambient bath hands the whole landing the
 * average of a room dominated by one very bright opening — "too orange and
 * too uniformly bright". The gradient reshapes each channel's bath around
 * where that channel's flux actually enters, and because it lives per
 * channel it composes: in the cabin the window-fed bath concentrates aft
 * while the door-fed bath concentrates at the door, two gradients in one
 * vec4 (and the four windows are four sources inside one of them).
 *
 * The kernel is distance-based and direction-free on purpose. Bounced light
 * is diffuse, and the first bounce concentrates near the opening's footprint
 * — a vertex's own form factor to the portal was considered and rejected as
 * the shape, because the deckhead over a lit sole receives plenty of bounce
 * while seeing none of the hatch.
 *
 * Energy-conserving by construction: the kernel sum is normalised by its
 * area-weighted mean over the room's own surfaces, so the room's mean bath
 * stays exactly the solved J and the gradient redistributes rather than
 * brightens.
 */
function bathKernel(distance: number, d0: number): number {
  const t = distance / d0;
  return 1 / (1 + t * t);
}

/** Area-weighted sample points over a walked room's surfaces. */
function roomSurfaceSamples(
  name: LightRoomName,
): Array<{ x: number; y: number; z: number; area: number }> {
  const samples: Array<{ x: number; y: number; z: number; area: number }> = [];
  if (name === 'hold') {
    const wardroom = belowDecksSpace('wardroom');
    const span = wardroom.zForward - wardroom.zAft;
    for (let i = 0; i < 12; i++) {
      const z = wardroom.zAft + (span * (i + 0.5)) / 12;
      const half = spaceHalfWidthAt(wardroom, z);
      for (let j = 0; j < 5; j++) {
        const x = -half + (2 * half * (j + 0.5)) / 5;
        const area = (span / 12) * ((2 * half) / 5);
        samples.push({ x, y: HOLD_FLOOR_Y + 0.01, z, area });
        samples.push({ x, y: HOLD_DECKHEAD_Y - 0.01, z, area });
      }
    }
    return samples;
  }

  const space = belowDecksSpace(name);
  const span = space.zForward - space.zAft;
  const STEPS = 16;
  for (let i = 0; i < STEPS; i++) {
    const z = space.zAft + (span * (i + 0.5)) / STEPS;
    const half = spaceHalfWidthAt(space, z);
    const deckhead = spaceDeckheadY(space, 0, z) ?? space.soleY + 2.2;
    for (let j = 0; j < 7; j++) {
      const x = -half + (2 * half * (j + 0.5)) / 7;
      const area = (span / STEPS) * ((2 * half) / 7);
      samples.push({ x, y: space.soleY + 0.01, z, area });
      samples.push({ x, y: deckhead - 0.01, z, area });
    }
    // The two side walls, at their clear height where the hull allows.
    const clearSide = spaceClearHeightAt(space, half * 0.95, z) ?? deckhead - space.soleY;
    for (let j = 0; j < 4; j++) {
      const y = space.soleY + (clearSide * (j + 0.5)) / 4;
      const area = (span / STEPS) * (clearSide / 4);
      samples.push({ x: half - 0.01, y, z, area });
      samples.push({ x: -half + 0.01, y, z, area });
    }
  }
  return samples;
}

function buildBathGradients(
  rooms: readonly LightRoom[],
  skyPortals: readonly SkyPortal[],
  doorways: readonly DoorwayPortal[],
  transfer: ReadonlyMap<LightRoomName, readonly number[]>,
  holdTransfer: number,
): Map<LightRoomName, BathGradientChannel[]> {
  const out = new Map<LightRoomName, BathGradientChannel[]>();
  for (const room of rooms) {
    const d0 = Math.max(0.5 * (room.zForward - room.zAft), 1.2);
    const samples = roomSurfaceSamples(room.name);
    const channels: BathGradientChannel[] = [];
    for (let p = 0; p < LIGHT_CHANNELS; p++) {
      const raw: Array<{ x: number; y: number; z: number; w: number }> = [];
      for (const portal of skyPortals) {
        if (portal.room !== room.name || portal.channel !== p) continue;
        raw.push({
          x: portal.centre[0],
          y: portal.centre[1],
          z: portal.centre[2],
          w: rectArea(portal) * portal.transmittance,
        });
      }
      for (const doorway of doorways) {
        if (doorway.room !== room.name) continue;
        const neighbour =
          doorway.neighbour === 'hold'
            ? p === CHANNEL_BOARDS
              ? holdTransfer
              : 0
            : (transfer.get(doorway.neighbour)?.[p] ?? 0);
        if (neighbour <= 0) continue;
        raw.push({
          x: doorway.centre[0],
          y: doorway.centre[1],
          z: doorway.centre[2],
          w: rectArea(doorway) * neighbour,
        });
      }
      const total = raw.reduce((sum, s) => sum + s.w, 0);
      if (total <= 0) {
        channels.push({ sources: [], d0, meanKernel: 1 });
        continue;
      }
      const sources = raw.map((s) => ({ ...s, w: s.w / total }));
      let kernelArea = 0;
      let area = 0;
      for (const sample of samples) {
        let k = 0;
        for (const s of sources) {
          k += s.w * bathKernel(Math.hypot(sample.x - s.x, sample.y - s.y, sample.z - s.z), d0);
        }
        kernelArea += k * sample.area;
        area += sample.area;
      }
      channels.push({
        sources,
        d0,
        meanKernel: area > 0 ? kernelArea / area : 1,
      });
    }
    out.set(room.name, channels);
  }
  return out;
}

/** The gradient's value for one room's channel at a point; room-mean is 1. */
export function bathGradientAt(
  model: InteriorLightModel,
  room: LightRoomName,
  channel: number,
  x: number,
  y: number,
  z: number,
): number {
  const gradient = model.bathGradients.get(room)?.[channel];
  if (!gradient || gradient.sources.length === 0) return 1;
  let k = 0;
  for (const s of gradient.sources) {
    k += s.w * bathKernel(Math.hypot(x - s.x, y - s.y, z - s.z), gradient.d0);
  }
  return k / Math.max(gradient.meanKernel, 1e-9);
}

// --- the model, built once ------------------------------------------------------

let cachedModel: InteriorLightModel | null = null;

export function interiorLightModel(): InteriorLightModel {
  if (cachedModel) return cachedModel;

  const skyPortals = buildSkyPortals();
  const doorways = buildDoorways();
  const rooms = buildRooms(skyPortals, doorways);
  const transfer = solveTransfer(rooms, skyPortals, doorways);

  const hold = rooms.find((r) => r.name === 'hold')!;
  const boardsPortal = skyPortals.find((p) => p.channel === CHANNEL_BOARDS)!;
  const grating = skyPortals.find((p) => p.channel === CHANNEL_HATCH)!;
  const fHold = Math.min(hold.openingArea / hold.area, 0.9);
  const holdTransfer =
    (hold.albedo * (rectArea(boardsPortal) / hold.area)) / (1 - hold.albedo * (1 - fHold));

  // What the open boards plane sees looking up: the grating straight overhead
  // up the shaft, and the wardroom's own lit surfaces round it.
  const toGratingF = rectToRectFormFactor(
    {
      name: 'boards-as-receiver',
      centre: boardsPortal.centre,
      edgeU: boardsPortal.edgeU,
      edgeV: boardsPortal.edgeV,
      normal: [0, 1, 0],
    },
    grating,
  );

  // The warm tint of everything after the first bounce.
  const soleRgb = linearRgbOfHex(SHIP_PALETTE.base.interiorSole);
  const liningRgb = linearRgbOfHex(SHIP_PALETTE.base.interiorLining);
  const mixed: [number, number, number] = [
    (soleRgb[0] + 2 * liningRgb[0]) / 3,
    (soleRgb[1] + 2 * liningRgb[1]) / 3,
    (soleRgb[2] + 2 * liningRgb[2]) / 3,
  ];
  const lum = Math.max(luminanceOf(mixed), 1e-6);
  const bounceTint: [number, number, number] = [mixed[0] / lum, mixed[1] / lum, mixed[2] / lum];

  cachedModel = {
    rooms,
    skyPortals,
    doorways,
    transfer,
    holdTransfer,
    boards: {
      toGratingF,
      gratingTransmittance: grating.transmittance,
      ambientSpill: 1 - toGratingF,
    },
    bounceTint,
    bathGradients: buildBathGradients(
      rooms,
      skyPortals,
      doorways,
      transfer,
      holdTransfer,
    ),
  };
  return cachedModel;
}

// --- room assignment ------------------------------------------------------------

/**
 * Is the point inside the band of a well cut into this room's sole — the
 * treads, risers and framing of a flight descending out of it? Those
 * surfaces belong to the room the flight stands in (`stepsRoom`), which is
 * the room whose light falls down the well onto them.
 */
function inWellBandOf(
  space: BelowDecksSpace,
  x: number,
  y: number,
  z: number,
): boolean {
  for (const steps of INTERIOR_STEPS) {
    if (Math.abs(steps.farY - space.soleY) > 1e-6) continue;
    if (!inStepsWell(steps, x, z)) continue;
    if (y >= stepsLowY(steps) - 0.03) return true;
  }
  return false;
}

/**
 * The canonical room order behind `aRoomIndex` — aft to forward, hold between
 * the room it underlies and the forecastle. The bake writes indices against
 * this list and the room-lift uniform array is laid out by it, so the order is
 * part of the baked data's meaning: append, never reorder.
 */
export const LIGHT_ROOM_ORDER: readonly LightRoomName[] = [
  'cabin',
  'landing',
  'wardroom',
  'hold',
  'forecastle',
];

/**
 * `aRoomIndex` encoding: 0 is outdoors or no room at all (sealed voids, the
 * open deck), rooms are 1-based in `LIGHT_ROOM_ORDER`. Zero as the safe
 * default matters: an unbaked or fully-outdoor vertex must resolve to a lift
 * of exactly 1, not to some room's dial.
 */
export function lightRoomIndexOf(room: LightRoomName | null): number {
  if (room === null) return 0;
  const i = LIGHT_ROOM_ORDER.indexOf(room);
  return i < 0 ? 0 : i + 1;
}

/**
 * How far a surface query steps off the vertex along its normal before asking
 * which room it is in, so a bulkhead's two faces land in their own rooms.
 * Shared by `vertexLightResponse` and the bake's room-index writer — the two
 * lookups must agree or a vertex could carry one room's light and another
 * room's lift.
 */
export const VERTEX_ROOM_NUDGE = 0.04;

/**
 * The room a point is in, or null when it is not in one — inside a sealed
 * compartment (bread room, cable tier, the peak), buried in the stow, or not
 * below decks at all. Callers baking a surface nudge the query off the surface
 * along its normal first, so a bulkhead's two faces land in their own rooms.
 */
export function lightRoomAt(x: number, y: number, z: number): LightRoomName | null {
  // The hold first: it underlies the wardroom's z-range.
  if (
    z >= PLATFORM_AFT_Z &&
    z <= PLATFORM_FORWARD_Z &&
    y >= HOLD_FLOOR_Y - 0.35 &&
    y < PLATFORM_SOLE_Y - 0.02
  ) {
    return 'hold';
  }

  for (const space of BELOW_DECKS_SPACES) {
    if (z < space.zAft || z > space.zForward) continue;
    // A room reaches down to its sole — except where a flight of steps is
    // cut *into* that sole, where it reaches down the well to the lower
    // floor. §15.5's black treads were exactly this: every cut below a sole
    // needs a room assignment, or everything in it bakes to zero. Stated
    // over INTERIOR_STEPS rather than one well's numbers so the next flight
    // anyone cuts inherits the rule.
    if (y < space.soleY - 0.03 && !inWellBandOf(space, x, y, z)) continue;
    const zIn = Math.min(Math.max(z, space.zAft + 0.02), space.zForward - 0.02);
    const deckhead =
      spaceDeckheadY(space, Math.abs(x) < 1.2 ? x : 0, zIn) ?? space.soleY + 2.2;
    // The shafts rise above the room's own deckhead: the companion shaft in
    // the landing and the hatchway's cut in the wardroom belong to the rooms
    // they open into.
    let ceiling = deckhead + 0.35;
    if (space.name === 'landing' && z >= COMPANION_AFT_Z - 0.1 && z <= COMPANION_FORWARD_Z) {
      ceiling = deckhead + 1.4;
    }
    if (space.name === 'wardroom' && z >= HATCHWAY_AFT_Z - 0.1 && z <= HATCHWAY_FORWARD_Z + 0.1) {
      ceiling = deckhead + 1.0;
    }
    if (y <= ceiling) return space.name;
  }
  return null;
}

// --- per-vertex response ---------------------------------------------------------

export interface VertexLightResponse {
  /** Form factor × transmittance to each channel's own-room sky portals. */
  readonly direct: readonly number[];
  /**
   * Bounced-light weight per channel: doorway glow from neighbour rooms plus
   * the room's own ambient bath, in units of the channel's portal irradiance.
   * Tinted at runtime by the model's `bounceTint`.
   */
  readonly bounce: readonly number[];
  /**
   * The same bounce with the bath spatially redistributed by the room's
   * per-channel gradient (`bathGradientAt`) — same glow, same room mean,
   * different shape. The shader mixes between the two so the gradient is a
   * same-frame A/B, exactly like the portal mix it rides beside.
   */
  readonly bounceGradient: readonly number[];
}

/**
 * **`LIGHT_CHANNELS` long, not a four-tuple.**
 *
 * These three were `[number, number, number, number]`, which was an accurate
 * description of the model for as long as there were four channels and a trap
 * the moment there were five: the tuple type pinned the *length* while every
 * consumer iterated `LIGHT_CHANNELS`, so adding a channel left index 4 as
 * `undefined` and each `reduce` over it produced `NaN`. Three tests failed
 * with `expected NaN to be less than 1.35` and none of them named the array.
 *
 * A length that has to agree with a constant should be written in terms of it.
 */
function zeroChannels(): number[] {
  return new Array<number>(LIGHT_CHANNELS).fill(0);
}

const ZERO_RESPONSE: VertexLightResponse = {
  direct: zeroChannels(),
  bounce: zeroChannels(),
  bounceGradient: zeroChannels(),
};

/**
 * The light arriving at an EYE at a point below decks, as one scalar — the
 * meter the continuous exposure adaptation reads.
 *
 * `channelLum` is the luminance each channel's portal plane carries right
 * now, sun beam included (the room's brightness includes its beam-lit
 * patches). The receiver is an eye, not a surface, so each opening is
 * integrated with the receiver aimed straight at it — the orientation that
 * sees the most of it — rather than against one fixed normal. That
 * overstates a sphere's average by a bounded factor, which the meter's
 * target constant absorbs; what matters here is the SHAPE of the field:
 * large where a bright opening fills the view, falling smoothly with
 * distance and angle, room after room, with no seam at any threshold. This
 * is what replaces the binary below-decks flag: walking up the companionway
 * the form factor to the sky opening grows to ~1 and the meter converges to
 * the daylight outside before the room lookup ever flips to null.
 *
 * Returns null where there is no room — on deck, or sealed voids — where
 * the caller meters the open sky instead.
 */
export function eyeLightMeterAt(
  model: InteriorLightModel,
  x: number,
  y: number,
  z: number,
  channelLum: readonly number[],
  view: readonly [number, number, number] | null = null,
  depth = 0,
): number | null {
  const room = lightRoomAt(x, y, z);
  if (!room) return null;

  // An eye above a downward deck opening's plane is OUTDOORS, whatever the
  // room lookup says: your head is above the hole. The shaft ceiling
  // extensions admit a band of positions above the portal plane, and a
  // one-sided portal radiates nothing upward — so the meter there saw only
  // the dim bath, and the first step down the companion ladder snapped the
  // exposure ×14 (Ash's two marked rays, 18 cm apart, sat either side of
  // it). Above the plane the sky is the light; the clamp holds gain at 1.
  for (const portal of model.skyPortals) {
    if (portal.room !== room || portal.normal[1] > -0.7) continue;
    if (y <= portal.centre[1] - 0.02) continue;
    const du = Math.hypot(portal.edgeU[0], portal.edgeU[1], portal.edgeU[2]);
    const dv = Math.hypot(portal.edgeV[0], portal.edgeV[1], portal.edgeV[2]);
    if (
      Math.abs(x - portal.centre[0]) <= du + 0.25 &&
      Math.abs(z - portal.centre[2]) <= dv + 0.25
    ) {
      return null;
    }
  }

  let meter = 0;
  let seen = 0;
  // Two receivers, one integral. Position mode aims the receiver at each
  // opening — "how much light is arriving here from anywhere", stable under
  // head movement. Gaze mode fixes the receiver along the view direction —
  // the cosine-weighted cone of what is actually in frame, which is what a
  // frame-metering game camera responds to: stare into the dark cabin from
  // the lit landing and the meter falls with the view, so the dark room
  // brightens BEFORE the step through the door. The cost of that honesty is
  // pumping — stare at a dark corner and the room opens up — which is why
  // the smoothing time constants are dials beside the mode switch, and why
  // the caller floors the gaze answer against the position one.
  const aimedFactor = (rect: LightRect): number => {
    if (view) {
      return rectFormFactor(x, y, z, view[0], view[1], view[2], rect);
    }
    const dx = rect.centre[0] - x;
    const dy = rect.centre[1] - y;
    const dz = rect.centre[2] - z;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-6) return 0.5;
    return rectFormFactor(x, y, z, dx / length, dy / length, dz / length, rect);
  };

  const ambientLumOf = (name: LightRoomName): number => {
    if (name === 'hold') {
      return model.holdTransfer * channelLum[CHANNEL_BOARDS];
    }
    const transfer = model.transfer.get(name);
    if (!transfer) return 0;
    let lum = 0;
    for (let p = 0; p < LIGHT_CHANNELS; p++) lum += transfer[p] * channelLum[p];
    return lum;
  };

  for (const portal of model.skyPortals) {
    if (portal.room !== room) continue;
    const f = aimedFactor(portal);
    if (f <= 0) continue;
    seen += f;
    meter += f * portal.transmittance * channelLum[portal.channel];
  }
  for (const doorway of model.doorways) {
    if (doorway.room !== room) continue;
    const f = aimedFactor(doorway);
    if (f <= 0) continue;
    seen += f;
    // An eye sees THROUGH an open door — the bright landing beyond, not the
    // door's mean glow. One-hop directionality is the stated model for
    // surfaces (§15.3), but for the meter it put an 8× seam at every door
    // plane (measured at the cabin door), which is exactly the exposure
    // jump this field exists to remove. So one level of recursion: a
    // doorway carries the neighbour's own eye-field evaluated just beyond
    // it, and the neighbour's doorways fall back to mean radiosity.
    let through = ambientLumOf(doorway.neighbour);
    if (depth === 0) {
      // The recursion stays position-aimed even in gaze mode: what shines
      // through a door you are looking at is the neighbour room's light
      // from every direction, not just the slice aligned with your view.
      const beyond = eyeLightMeterAt(
        model,
        doorway.centre[0] - doorway.normal[0] * 0.08,
        doorway.centre[1] - doorway.normal[1] * 0.08,
        doorway.centre[2] - doorway.normal[2] * 0.08,
        channelLum,
        null,
        1,
      );
      if (beyond !== null) through = beyond;
    }
    meter += f * through;
  }
  meter += Math.max(1 - seen, 0) * ambientLumOf(room);
  return meter;
}

/**
 * The static light response of one surface point — the whole of what the bake
 * writes into the two vec4 vertex attributes.
 *
 * `nudge` moves the query off its surface along the normal before the room is
 * looked up, so the two faces of one bulkhead resolve to their own rooms.
 */
export function vertexLightResponse(
  model: InteriorLightModel,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  nudge = VERTEX_ROOM_NUDGE,
): VertexLightResponse {
  const room = lightRoomAt(x + nx * nudge, y + ny * nudge, z + nz * nudge);
  if (!room) return ZERO_RESPONSE;

  const direct = zeroChannels();
  const bounce = zeroChannels();
  const bounceGradient = zeroChannels();
  let seen = 0;

  for (const portal of model.skyPortals) {
    if (portal.room !== room) continue;
    const f = rectFormFactor(x, y, z, nx, ny, nz, portal);
    if (f <= 0) continue;
    direct[portal.channel] += f * portal.transmittance;
    seen += f;
  }

  const transferOf = (name: LightRoomName): readonly number[] | null =>
    name === 'hold' ? null : (model.transfer.get(name) ?? null);

  for (const doorway of model.doorways) {
    if (doorway.room !== room) continue;
    const f = rectFormFactor(x, y, z, nx, ny, nz, doorway);
    if (f <= 0) continue;
    seen += f;
    const neighbour = transferOf(doorway.neighbour);
    if (neighbour) {
      for (let p = 0; p < LIGHT_CHANNELS; p++) {
        bounce[p] += f * neighbour[p];
        bounceGradient[p] += f * neighbour[p];
      }
    } else if (doorway.neighbour === 'hold') {
      bounce[CHANNEL_BOARDS] += f * model.holdTransfer;
      bounceGradient[CHANNEL_BOARDS] += f * model.holdTransfer;
    }
  }

  // The ambient bath: the rest of the hemisphere is the room's own surfaces
  // at their solved radiosity — flat in `bounce`, reshaped by the room's
  // per-channel gradient in `bounceGradient` (same mean, different where).
  const bath = Math.max(1 - seen, 0);
  if (room === 'hold') {
    bounce[CHANNEL_BOARDS] += bath * model.holdTransfer;
    bounceGradient[CHANNEL_BOARDS] +=
      bath * model.holdTransfer * bathGradientAt(model, room, CHANNEL_BOARDS, x, y, z);
  } else {
    const own = transferOf(room);
    if (own) {
      for (let p = 0; p < LIGHT_CHANNELS; p++) {
        bounce[p] += bath * own[p];
        bounceGradient[p] += bath * own[p] * bathGradientAt(model, room, p, x, y, z);
      }
    }
  }

  return { direct, bounce, bounceGradient };
}
