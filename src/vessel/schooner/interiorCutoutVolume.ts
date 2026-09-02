import type { InteriorCutoutVolume } from '../../scene/interiorCutoutVolume';
import {
  BULWARK_THICKNESS,
  HALF_LENGTH,
  bulwarkOuterHalfBeam,
  counterRakeShift,
  counterStationZ,
  DECK_BEAM_DEPTH,
  deckAtSideY,
  halfBreadthAt,
  transomPlacedZ,
} from './hullForm';
import {
  deckCamberHeight,
  deckHalfWidth,
  deckLevelAt,
  deckStandAt,
  levelWalkingY,
} from './deckSurface';
import {
  BELOW_DECKS_SPACES,
  INTERIOR_STEPS,
  spaceSideHalfWidthAt,
  stepsRoom,
  stepsRunLength,
} from './deckInterior';

/**
 * The lowest useful cut: ballast occupies the floors below this height.
 * Water hidden below it cannot appear in any present or planned interior.
 */
export const SCHOONER_INTERIOR_CUTOUT_MIN_Y = 0.62;

/**
 * The cut stops at the highest weather-deck crown. Above it water is over the
 * ship, not in it, and must remain visible while a crest crosses the deck.
 */
export const SCHOONER_INTERIOR_CUTOUT_MAX_Y = (() => {
  let highest = 0;
  for (let i = 0; i <= 512; i++) {
    const z = -HALF_LENGTH + (2 * HALF_LENGTH * i) / 512;
    const level = deckLevelAt(z);
    highest = Math.max(
      highest,
      levelWalkingY(z, level) + deckCamberHeight(z, level),
    );
  }
  return highest;
})();

/**
 * Keep the discard safely inboard of the moulded shell. Besides protecting the
 * exterior waterline from a sampled-field error, this leaves room for planking,
 * frames and ceiling while still clearing the 0.84 m companionway generously.
 */
export const SCHOONER_INTERIOR_CUTOUT_MARGIN = 0.12;

/** 15 cm longitudinal and 8 cm vertical cells over the bounded volume. */
export const SCHOONER_INTERIOR_CUTOUT_COLUMNS = 105;
export const SCHOONER_INTERIOR_CUTOUT_ROWS = 49;

const Z_MIN =
  -HALF_LENGTH -
  counterRakeShift(-HALF_LENGTH, SCHOONER_INTERIOR_CUTOUT_MAX_Y);
const Z_MAX = HALF_LENGTH;

/**
 * How far abaft the transom the interior section is carried, metres.
 *
 * **The conservative erosion has a boundary problem and the transom is where it
 * bites.** Each texel is the minimum half-breadth over its whole cell, which is
 * right everywhere the section is *narrowing* toward water that is outside the
 * planking. At the after perpendicular the section does not narrow, it stops:
 * the cell straddling the transom takes the minimum of "the full width of the
 * captain's cabin" and "nothing at all", and gets nothing.
 *
 * That was harmless while the cabin stopped 1.2 m short of the transom. It runs
 * aft to it now, so the uncut band lands inside the room — two slivers of open
 * sea in the after corners, right where the stern windows and the bench are,
 * appearing whenever a crest rises the 0.15 m from the design waterline to the
 * sole.
 *
 * One cell of reach fixes it, and the over-cut it buys is the cheapest one
 * available: the water it hides is within 0.16 m of the transom **and above the
 * design waterline**, which is under the counter's own overhang — the transom
 * rakes 0.32 m aft per metre of height, so the hull is already between that
 * water and any eye that could see it.
 */
const TRANSOM_CELL_REACH = (Z_MAX - Z_MIN) / SCHOONER_INTERIOR_CUTOUT_COLUMNS;

/**
 * Exact interior half-breadth at a placed ship-local point.
 *
 * Below the sheer's deck edge this is the moulded shell. Raised decks continue
 * above that edge inside the bulwark, then the width closes across the deck's
 * parabolic camber. Stopping at `halfBreadthAt` alone would leave the upper
 * 0.55 m of the captain's cabin uncut beneath the quarterdeck.
 */
export function schoonerInteriorHalfBreadthAt(zPlaced: number, y: number): number {
  if (
    y < SCHOONER_INTERIOR_CUTOUT_MIN_Y ||
    y > SCHOONER_INTERIOR_CUTOUT_MAX_Y
  ) {
    return 0;
  }
  // Carry the transom's own section one cell abaft itself. See
  // `TRANSOM_CELL_REACH`: without it the boundary texel is the conservative
  // minimum of "the room" and "nothing at all", which is nothing, and the sea
  // is drawn in the after corners of the captain's cabin.
  const aftLimit = transomPlacedZ(y);
  const sampleZ =
    zPlaced < aftLimit && zPlaced >= aftLimit - TRANSOM_CELL_REACH ? aftLimit : zPlaced;
  const station = counterStationZ(sampleZ, y);
  if (Number.isNaN(station)) return 0;

  const sheerY = deckAtSideY(station);
  if (y <= sheerY) return halfBreadthAt(station, y);

  const level = deckLevelAt(station);
  const sideY = levelWalkingY(station, level);
  if (y <= sideY) {
    return Math.max(
      bulwarkOuterHalfBeam(station, y) - BULWARK_THICKNESS,
      0,
    );
  }

  const camber = deckCamberHeight(station, level);
  if (camber <= 0 || y > sideY + camber) return 0;
  const width = deckHalfWidth(station, level);
  return width * Math.sqrt(Math.max(1 - (y - sideY) / camber, 0));
}

/**
 * The half-breadth the cut has to reach to keep the sea out of a room, or 0.
 *
 * **The shell alone is not enough, and the reason is the cell grid rather than
 * the shape.** Each texel is a conservative minimum over its whole cell, and the
 * lookup is nearest-cell rather than interpolated, so the value has to be safe
 * everywhere in the cell. Where a room's floor sits close to the turn of the
 * hull that minimum collapses: at the cabin's after end the sole is only 0.17 m
 * above the transom's floor line, the section closes 3 m of half-breadth per
 * metre of height there, and the cell straddling the sole is eroded 0.16 m
 * narrower than the room it is supposed to be hiding. Two strips of open sea,
 * one each side, in the corners where the stern windows are.
 *
 * So the field is told what it is for. Inside a room's own footprint it is at
 * least the room's half-width plus the margin the shader will subtract, which
 * makes "no sea inside a room" a property of the table instead of a coincidence
 * of how the shape happens to be sampled.
 *
 * **What it costs, stated plainly.** In the cells that straddle a sole the cut
 * can now run outside the planking, by at most the amount the erosion was eating
 * — 0.15 m over one cell of length, at the cabin's after corners. That is a
 * patch of hidden sea beside the counter, a hand's breadth each way, and only
 * while the surface is within a cell of the sole's own height. It is the smaller
 * of the two artefacts and it is the one on the outside, where the hull's own
 * topsides are already in front of it.
 */
export function roomCutHalfBreadthAt(zPlaced: number, y: number): number {
  // **Capped by the deck that is actually overhead at this z**, so that the
  // reach below can never lift a room's ceiling out over the weather deck.
  //
  // It does not remove the conflict, it only bounds it. A cell straddling the
  // quarterdeck break holds samples from the landing, whose ceiling is 0.55 m
  // higher than the waist's, and the texel is the largest of them — so water
  // between 3.73 and 4.28 disappears in a 0.155 m strip at the break. That is
  // green water 1.4–2.0 m above the design waterline, over the one place on deck
  // that already has a riser and a ladder breaking up the surface, and it is the
  // side of the trade to be on: capping instead by the *lowest* deck within a
  // cell either way removes it and leaves the top 0.55 m of the landing uncut,
  // which is sea inside a room and is the fault this whole mechanism exists to
  // prevent. Both were measured; see `docs/ocean/OCEAN_INTERIOR_CUTOUT_HANDOVER.md`.
  const over = deckStandAt(0, zPlaced);
  if (!over || y > over.y - DECK_BEAM_DEPTH) return 0;

  const cellY =
    (SCHOONER_INTERIOR_CUTOUT_MAX_Y - SCHOONER_INTERIOR_CUTOUT_MIN_Y) /
    SCHOONER_INTERIOR_CUTOUT_ROWS;
  let widest = 0;
  for (const space of BELOW_DECKS_SPACES) {
    // One cell of reach at each bulkhead and one cell below each sole, for the
    // same reason `TRANSOM_CELL_REACH` exists: a cell that straddles a boundary
    // has to be covered from both sides of it.
    if (zPlaced < space.zAft - TRANSOM_CELL_REACH) continue;
    if (zPlaced > space.zForward + TRANSOM_CELL_REACH) continue;
    if (y < space.soleY - cellY) continue;
    const z = Math.min(Math.max(zPlaced, space.zAft), space.zForward);
    widest = Math.max(widest, spaceSideHalfWidthAt(space, z, Math.max(y, space.soleY), false));
  }

  // **A well reaches below the sole of the room it is cut into**, and the sole
  // is what the loop above stops at. The wardroom well drops the landing to
  // 1.80 — half a metre under the design waterline — so without this the sea is
  // drawn standing in the stairs, which is the exact fault this mechanism
  // exists to prevent, arrived at from under the floor instead of through the
  // side.
  //
  // Cut to the room's *full* half-breadth rather than the well's 0.70, because
  // this function answers a half-breadth about the centreline and cannot say
  // "the starboard 0.70 m only". The over-cut is entirely inside the hull and
  // under a sole that is drawn over it, so nothing can see it from either side.
  for (const steps of INTERIOR_STEPS) {
    if (steps.farY <= steps.sillY + 1e-6) continue;
    const room = stepsRoom(steps);
    if (!room) continue;
    const run = stepsRunLength(steps);
    const zEnd = steps.zTop + steps.direction * run;
    if (zPlaced < Math.min(steps.zTop, zEnd) - TRANSOM_CELL_REACH) continue;
    if (zPlaced > Math.max(steps.zTop, zEnd) + TRANSOM_CELL_REACH) continue;
    if (y < steps.sillY - cellY) continue;
    const z = Math.min(Math.max(zPlaced, room.zAft), room.zForward);
    widest = Math.max(widest, spaceSideHalfWidthAt(room, z, Math.max(y, steps.sillY), false));
  }

  if (widest <= 0) return 0;
  return widest + SCHOONER_INTERIOR_CUTOUT_MARGIN;
}

/**
 * Sample the canonical swept hull into the ocean's compact lookup texture.
 * Each texel is the minimum half-breadth over its whole cell, sampled on a
 * 5x5 lattice. That conservative erosion matters at the sheer and rise of
 * floor: interpolating across their jump to zero would cut a notch in water
 * that is just outside the planking. A sub-cell fringe left inside the shell is
 * hidden behind the lining; an over-cut outside it would be visible.
 *
 * RGBA is intentional even though only R is used. It is the most portable
 * float DataTexture layout across the WebGL2/ANGLE targets used by the game,
 * and the complete table is only about 80 KiB.
 */
export function createSchoonerInteriorCutoutVolume(): InteriorCutoutVolume {
  const width = SCHOONER_INTERIOR_CUTOUT_COLUMNS;
  const height = SCHOONER_INTERIOR_CUTOUT_ROWS;
  const data = new Float32Array(width * height * 4);
  const cellZ = (Z_MAX - Z_MIN) / width;
  const cellY =
    (SCHOONER_INTERIOR_CUTOUT_MAX_Y - SCHOONER_INTERIOR_CUTOUT_MIN_Y) /
    height;
  const SUBDIVISIONS = 4;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      // Two accumulations, and they go opposite ways on purpose.
      //
      // The shell is a bound the cut must not *exceed*, so its cell value is the
      // minimum: an over-cut shows as a notch in water that is outside the
      // planking. A room is a region the cut must *cover*, so its cell value is
      // the maximum: an under-cut shows as sea on the floor. Composing them the
      // other way round — one min over `max(shell, room)` — quietly takes the
      // narrowest room in the cell, which is 0.10 m out where the forecastle
      // closes toward the stem and 0.16 m out at the transom.
      let shellMin = Infinity;
      let roomMax = 0;
      for (let sy = 0; sy <= SUBDIVISIONS; sy++) {
        const y =
          SCHOONER_INTERIOR_CUTOUT_MIN_Y +
          (row + sy / SUBDIVISIONS) * cellY;
        for (let sz = 0; sz <= SUBDIVISIONS; sz++) {
          const z = Z_MIN + (column + sz / SUBDIVISIONS) * cellZ;
          shellMin = Math.min(shellMin, schoonerInteriorHalfBreadthAt(z, y));
          roomMax = Math.max(roomMax, roomCutHalfBreadthAt(z, y));
        }
      }
      data[(row * width + column) * 4] = Math.max(shellMin, roomMax);
    }
  }

  return {
    width,
    height,
    zMin: Z_MIN,
    zMax: Z_MAX,
    yMin: SCHOONER_INTERIOR_CUTOUT_MIN_Y,
    yMax: SCHOONER_INTERIOR_CUTOUT_MAX_Y,
    margin: SCHOONER_INTERIOR_CUTOUT_MARGIN,
    data,
  };
}
