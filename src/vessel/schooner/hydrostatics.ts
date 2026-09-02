import {
  DESIGN_DRAUGHT,
  HULL_LENGTH,
  MAX_BEAM,
  STATION_COUNT,
  STATION_SPACING,
  stationOffsets,
  stationZ,
} from './hullForm';
import { CompositeSection, HullSection, createSectionImmersion } from './hullSection';
import type { Section, SectionImmersion } from './hullSection';
import { appendageSectionsAt } from './backbone';

/**
 * Schooner hydrostatics: the numbers `docs/ship/SHIP_SPEC.md` section 4 says the shape must
 * produce, computed from the shape rather than asserted alongside it.
 *
 * Everything here is a still-water property of the hull at a level waterline.
 * It is deliberately separate from `BuoyantBody`, which is the dynamic body:
 * these are the quantities you check a hull *with*, and they must be derivable
 * without instantiating a wave field or running an integrator.
 */

export const RHO_WATER = 1025;
export const GRAVITY = 9.81;

/** One station of the flotation model: a section and the slab of hull it owns. */
export interface HullStation {
  /** Longitudinal position, metres, +z forward. */
  z: number;
  /** Length of hull this station integrates, metres. */
  length: number;
  /**
   * The moulded section — the fair body from the offsets table, above the
   * rabbet. This is what the form coefficients are reported against, because
   * that is what a table of offsets means.
   */
  moulded: HullSection;
  /** Backbone and rudder below the rabbet. See `backbone.ts`. */
  appendages: HullSection[];
  /**
   * Everything at this station that displaces water: moulded body plus
   * appendages. This is what the flotation model integrates, and it is the only
   * one of the three a caller should reach for unless it specifically wants the
   * moulded body alone.
   */
  section: Section;
}

let cachedStations: HullStation[] | undefined;

/**
 * The flotation stations, built once from the hull form.
 *
 * Cached because the sections are pure geometry — the hull does not change at
 * runtime — and rebuilding 39 polygons per query would make the hydrostatic
 * solves below quadratic for no reason.
 */
export function hullStations(): HullStation[] {
  if (cachedStations) return cachedStations;
  const stations: HullStation[] = [];
  for (let i = 0; i < STATION_COUNT; i++) {
    const z = stationZ(i);
    const offsets = stationOffsets(z);
    if (offsets.length < 2) continue;
    const moulded = new HullSection(offsets);
    const appendages = appendageSectionsAt(z);
    stations.push({
      z,
      length: STATION_SPACING,
      moulded,
      appendages,
      section:
        appendages.length > 0
          ? new CompositeSection([moulded, ...appendages])
          : moulded,
    });
  }
  cachedStations = stations;
  return stations;
}

/** Still-water properties of the hull at one level waterline. */
export interface Hydrostatics {
  /** Draught the figures were taken at, metres above baseline. */
  draught: number;
  /** Displaced volume, m³ — moulded body plus appendages. What floats her. */
  volume: number;
  /** Displaced volume of the moulded body alone, m³. */
  mouldedVolume: number;
  /** Displaced volume of backbone and rudder, m³. See `backbone.ts`. */
  appendageVolume: number;
  /** Displacement, kg. */
  displacement: number;
  /** Waterplane area, m². */
  waterplaneArea: number;
  /** Centre of buoyancy above baseline, metres. */
  kb: number;
  /** Longitudinal centre of buoyancy, metres (+forward of midships). */
  lcb: number;
  /** Transverse second moment of the waterplane, m⁴. */
  transverseInertia: number;
  /** Longitudinal second moment of the waterplane about the LCF, m⁴. */
  longitudinalInertia: number;
  /** Metacentric radius BM, metres. */
  bm: number;
  /** Longitudinal metacentric radius BM_L, metres. */
  bmL: number;
  /** Transverse metacentre above baseline, metres. */
  km: number;
  /** Waterline length, metres. */
  waterlineLength: number;
  /** Waterline beam, metres. */
  waterlineBeam: number;
  /**
   * Form coefficients — block, waterplane, midship, prismatic.
   *
   * Reported against the **moulded** volume, per naval-architecture convention:
   * a hull's coefficients describe the fair body the offsets draw, not the
   * timber bolted under it. Quoting them on the appended volume would inflate Cb
   * by 0.017 and make them incomparable with the tables they were faired against
   * (`docs/ship/SHIP_SPEC.md` section 4.1).
   */
  blockCoefficient: number;
  waterplaneCoefficient: number;
  midshipCoefficient: number;
  prismaticCoefficient: number;
}

const scratch: SectionImmersion = createSectionImmersion();

/** Displaced volume at a level waterline, m³. */
export function displacedVolume(draught: number): number {
  let volume = 0;
  for (const st of hullStations()) {
    st.section.immerse(draught, 0, scratch);
    volume += scratch.area * st.length;
  }
  return volume;
}

/**
 * Solve the level waterline that displaces `mass` kilograms.
 *
 * Bisection rather than Newton: the volume curve is monotonic but only
 * piecewise smooth — a station's floor entering the water is a kink — and 60
 * bisections resolve to well below a micrometre, which costs nothing at
 * construction time. The bracket comes from the geometry because the keel now
 * extends below the moulded baseline at y = 0.
 */
export function solveWaterline(mass: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const st of hullStations()) {
    lo = Math.min(lo, st.section.floorY);
    hi = Math.max(hi, st.section.crownY);
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (displacedVolume(mid) * RHO_WATER < mass) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Full still-water hydrostatics at a level waterline. */
export function hydrostaticsAt(draught: number): Hydrostatics {
  const stations = hullStations();

  let volume = 0;
  let mouldedVolume = 0;
  let waterplaneArea = 0;
  let momentY = 0;
  let momentZ = 0;
  let transverseInertia = 0;
  let waterplaneMomentZ = 0;
  let midshipArea = 0;
  let maxSectionArea = 0;

  // Waterline dimensions and the waterplane the coefficients are quoted against
  // are **moulded**, tracked separately from the physical waterplane above.
  //
  // Not pedantry: the stem's forward face stands proud of the moulded forefoot,
  // so the appended body cuts the surface 0.44 m further forward than the fair
  // body does. Letting that into L_wl stretched it from 14.31 to 14.71 and moved
  // every coefficient that divides by it — Cb read 0.449 and Cp 0.620 for a hull
  // whose shape had not changed at all. A form coefficient describes the surface
  // the planking is bent around; the timber bolted to the front of it is not part
  // of that surface.
  let mouldedWaterplaneArea = 0;
  let wlForward = -Infinity;
  let wlAft = Infinity;
  let waterlineBeam = 0;

  for (const st of stations) {
    st.section.immerse(draught, 0, scratch);
    const a = scratch.area;
    const halfChord = scratch.chord / 2;

    volume += a * st.length;
    momentY += a * scratch.centroidY * st.length;
    momentZ += a * st.z * st.length;

    const strip = scratch.chord * st.length;
    waterplaneArea += strip;
    waterplaneMomentZ += strip * st.z;
    // Second moment of a strip of half-width b about the centreline: (2/3)b³.
    //
    // The strip is treated as one span centred on the centreline. That is exact
    // here because the moulded body and the backbone never pierce the surface at
    // the same station — where the backbone is cut by the waterline, forward of
    // the forefoot, the moulded body is entirely above it and contributes no
    // chord at all. `ship-hydrostatics.test.ts` asserts that rather than trusting
    // it: if a future fairing broke it, this line would quietly over-read BM.
    transverseInertia += (2 / 3) * halfChord ** 3 * st.length;

    // Form coefficients describe the moulded body; see the note on the fields.
    st.moulded.immerse(draught, 0, scratch);
    const moulded = scratch.area;
    mouldedVolume += moulded * st.length;
    mouldedWaterplaneArea += scratch.chord * st.length;
    if (moulded > maxSectionArea) maxSectionArea = moulded;
    if (Math.abs(st.z) < STATION_SPACING) midshipArea = Math.max(midshipArea, moulded);

    if (scratch.chord > 1e-6) {
      wlForward = Math.max(wlForward, st.z + st.length / 2);
      wlAft = Math.min(wlAft, st.z - st.length / 2);
      waterlineBeam = Math.max(waterlineBeam, scratch.chord);
    }
  }

  const lcf = waterplaneArea > 0 ? waterplaneMomentZ / waterplaneArea : 0;
  let longitudinalInertia = 0;
  for (const st of stations) {
    st.section.immerse(draught, 0, scratch);
    longitudinalInertia += scratch.chord * st.length * (st.z - lcf) ** 2;
  }

  const kb = volume > 0 ? momentY / volume : 0;
  const lcb = volume > 0 ? momentZ / volume : 0;
  const bm = volume > 0 ? transverseInertia / volume : 0;
  const bmL = volume > 0 ? longitudinalInertia / volume : 0;
  const waterlineLength = wlForward > wlAft ? wlForward - wlAft : 0;

  const boxVolume = waterlineLength * waterlineBeam * draught;

  return {
    draught,
    volume,
    mouldedVolume,
    appendageVolume: volume - mouldedVolume,
    displacement: volume * RHO_WATER,
    waterplaneArea,
    kb,
    lcb,
    transverseInertia,
    longitudinalInertia,
    bm,
    bmL,
    km: kb + bm,
    waterlineLength,
    waterlineBeam,
    blockCoefficient: boxVolume > 0 ? mouldedVolume / boxVolume : 0,
    waterplaneCoefficient:
      waterlineLength * waterlineBeam > 0
        ? mouldedWaterplaneArea / (waterlineLength * waterlineBeam)
        : 0,
    midshipCoefficient:
      waterlineBeam * draught > 0 ? midshipArea / (waterlineBeam * draught) : 0,
    prismaticCoefficient:
      maxSectionArea * waterlineLength > 0
        ? mouldedVolume / (maxSectionArea * waterlineLength)
        : 0,
  };
}

/** The hull's principal dimensions, for reporting alongside the figures above. */
export const PRINCIPAL_DIMENSIONS = {
  length: HULL_LENGTH,
  beam: MAX_BEAM,
  designDraught: DESIGN_DRAUGHT,
} as const;
