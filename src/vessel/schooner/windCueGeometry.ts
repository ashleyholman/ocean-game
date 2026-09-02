import * as THREE from 'three';
import {
  WIND_CUES,
  windCueClothNormal,
  windCueClothPoint,
} from './windCues';
import type { WindCue } from './windCues';
import { SurfaceBuilder, addTube, jitter, makeRandom, rgbOf } from './shipwright';
import type { Rgb, Vec3 } from './shipwright';

/**
 * The wind cues' visible geometry.
 *
 * Same division the rest of the ship keeps: `windCues.ts` decides where
 * everything is and what shape the cloth is, and this file turns that into
 * triangles. Nothing here invents a position — the cloth's vertices come from
 * `windCueClothPoint` and its normals from `windCueClothNormal`, which is the
 * same surface the clearance sweep in `tests/ship-wind-cues.test.ts` measures.
 *
 * TWO GEOMETRIES, AND THE SPLIT IS THE WHOLE POINT
 * -----------------------------------------------
 * The staffs are static and live in ship-local coordinates, so they merge into
 * one buffer like every other fitting. Each piece of **cloth is its own mesh in
 * its own frame**, because its attitude is recomputed every frame from the
 * apparent wind — the one thing aboard that is not baked at build time.
 * `Schooner.ts` owns that per-frame update; this file only hands it the rest
 * shape and where to hang it.
 *
 * WINDING — MEASURED, AND THE ARGUMENT WAS WRONG AGAIN
 * ----------------------------------------------------
 * These grids run along the fly in rows and across the drop in columns, which is
 * the same *description* `rigGeometry.ts` gives its grids, so this file was
 * written with the `flip = true` that file needs. Every triangle came out
 * inverted, and `ship-wind-cues.test.ts` said so on the first run.
 *
 * The description was the trap. `rigGeometry.ts`'s columns run **around** a
 * closed tube, so its rows and columns have the handedness of a solid seen from
 * outside; a flag's columns run **across** an open sheet, and the sheet's normal
 * comes from `windCueClothNormal`'s own cross product — `du × dv`, in that
 * order — which already has the handedness `addGrid` wants unflipped. Two grids
 * that read identically in prose have opposite winding.
 *
 * That is the fourth quantity on this ship to depend on local ordering and come
 * out reversed from an argument that sounded right (`docs/ship/SHIP_DECK_HANDOVER.md` §9,
 * where 488 cap discs did the same). Cloth is `DoubleSide`, which is exactly the
 * case that hides it worst: three flips the normal by `gl_FrontFacing`, so an
 * inverted winding lights the face away from the sun and shades the face toward
 * it, and a flag looks like a flag either way.
 */

export type WindCueRegion = 'bunting' | 'cueStaff';

export const WIND_CUE_REGIONS: readonly WindCueRegion[] = ['bunting', 'cueStaff'];

const WIND_CUE_SEED = 0x62756e74; // 'bunt'

export const WIND_CUE_PALETTE = {
  /**
   * The ensign's field.
   *
   * **No device and no nationality.** `docs/ship/SHIP_SPEC.md` describes a coastal trader
   * bought or chartered into expedition service and never says whose flag she
   * wears, so inventing one would be inventing a fact about the ship. A plain
   * bunting field is what is left, and it is one constant to change when that is
   * decided.
   *
   * Weathered madder rather than a signal red: it has to read against both a
   * grey sea and a lit sky, and it is the only saturated colour on the ship —
   * the hull is tarred near-black, the sails are flax-grey and the trim is
   * ochre, so a flag is the one thing aboard allowed to be a colour.
   */
  ensignRed: 0x8e3226,
  /** The pennant's fly: flax bunting, the same bolt as the sails, a shade paler. */
  flax: 0xc9c0a8,
  /** The pennant's hoist band, so it does not vanish against a bright sky. */
  pennantBand: 0x8e3226,
  /** The dogvane's vane: pale, because its whole job is to be legible. */
  vane: 0xd2c8ae,
  /** Staffs and the pig stick — slushed pine, the same as the spars. */
  pine: 0xa88a5e,
  /** The dogvane's spindle. */
  iron: 0x33353a,
} as const;

/** How far along the pennant its hoist band runs. */
const PENNANT_BAND_FRACTION = 0.28;

/** Cloth grid resolution: along the fly, and across the drop. */
const CLOTH_GRID: Record<string, { along: number; across: number }> = {
  ensign: { along: 14, across: 8 },
  mastheadPennant: { along: 18, across: 4 },
  dogvane: { along: 8, across: 3 },
};

export interface WindCueGeometrySet {
  /** All three staffs, merged, in ship-local coordinates. */
  staffs: THREE.BufferGeometry;
  /** One cloth per cue, in the cue's own frame, keyed by cue name. */
  cloths: Map<string, THREE.BufferGeometry>;
  triangleCount: number;
}

function clothColour(cue: WindCue, u: number): Rgb {
  if (cue.cloth === 'flax' && u < PENNANT_BAND_FRACTION) {
    return rgbOf(WIND_CUE_PALETTE.pennantBand);
  }
  return rgbOf(WIND_CUE_PALETTE[cue.cloth]);
}

function buildCloth(cue: WindCue, random: () => number): THREE.BufferGeometry {
  const grid = CLOTH_GRID[cue.name] ?? { along: 12, across: 6 };
  const builder = new SurfaceBuilder();

  const points: Vec3[][] = [];
  const normals: Vec3[][] = [];
  const colours: Rgb[][] = [];

  for (let i = 0; i <= grid.along; i++) {
    const u = i / grid.along;
    const rowP: Vec3[] = [];
    const rowN: Vec3[] = [];
    const rowC: Rgb[] = [];
    // Panel-to-panel variation across the bunting, for the same reason the
    // sails carry it: cloth is sewn from strips that weather differently, and
    // an evenly coloured flag is the flattest thing in any frame.
    const base = jitter(clothColour(cue, u), random, 0.05);
    for (let j = 0; j <= grid.across; j++) {
      const v = j / grid.across;
      rowP.push(windCueClothPoint(cue, u, v));
      rowN.push(windCueClothNormal(cue, u, v));
      rowC.push(base);
    }
    points.push(rowP);
    normals.push(rowN);
    colours.push(rowC);
  }

  // Not flipped. See the winding note at the head of this file — that is a
  // measured fact about this grid, not a guess about grids in general.
  builder.addGrid(points, normals, colours, false);
  return builder.toGeometry();
}

export function buildWindCueGeometry(): WindCueGeometrySet {
  const random = makeRandom(WIND_CUE_SEED);
  const staffBuilder = new SurfaceBuilder();
  const cloths = new Map<string, THREE.BufferGeometry>();
  let triangleCount = 0;

  for (const cue of WIND_CUES) {
    const colour = jitter(rgbOf(WIND_CUE_PALETTE[cue.staffMaterial]), random, 0.04);
    addTube(
      staffBuilder,
      cue.staff.foot,
      cue.staff.head,
      cue.staff.footRadius,
      cue.staff.headRadius,
      8,
      2,
      colour,
    );

    if (cue.bracket) {
      addTube(
        staffBuilder,
        cue.bracket.from,
        cue.bracket.to,
        cue.bracket.radius,
        cue.bracket.radius,
        6,
        1,
        jitter(rgbOf(WIND_CUE_PALETTE.iron), random, 0.04),
      );
    }

    const cloth = buildCloth(cue, random);
    cloths.set(cue.name, cloth);
    triangleCount += (cloth.index?.count ?? 0) / 3;
  }

  const staffs = staffBuilder.toGeometry();
  triangleCount += staffBuilder.triangleCount;
  return { staffs, cloths, triangleCount };
}
