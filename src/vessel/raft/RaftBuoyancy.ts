import {
  BuoyantBody,
  type ContactStation,
  type MassItem,
  type StationImmersion,
  type StationSection,
} from '../BuoyantBody';
import { classifyLongitudinalContact } from '../HullWaterContact';

/** Seasoned softwood driftwood. */
export const RHO_TIMBER = 475;

const RAFT_ADDED_MASS_COEFFICIENT = 1;
const RAFT_DAMPING_RATIO = 0.6;
const COLUMNS = 3;
const ROWS = 8;

/** One deck log. Radii taper from stern (-z) to bow (+z). */
export interface LogGeometry {
  radiusBow: number;
  radiusStern: number;
  length: number;
  x: number;
  y: number;
  z: number;
}

export interface BeamGeometry {
  radius: number;
  length: number;
  y: number;
  z: number;
}

export interface RaftBuoyancyOptions {
  logs: readonly LogGeometry[];
  beams: readonly BeamGeometry[];
  deckLength: number;
  /** Non-flotation masses: mast, step, yard, cordage, sail, figure. */
  topsides: readonly MassItem[];
}

interface FloatSlice {
  radius: number;
  centreY: number;
  length: number;
}

/** The raft's parallel cylinders, integrated as exact circular segments. */
class LogBundleSection implements StationSection {
  readonly floorY: number;

  constructor(
    private readonly slices: readonly FloatSlice[],
    private readonly axisX: number,
    readonly crownY: number,
  ) {
    let lowest = Infinity;
    for (const slice of slices) {
      lowest = Math.min(lowest, slice.centreY - slice.radius);
    }
    this.floorY = lowest === Infinity ? 0 : lowest;
  }

  immerse(waterLocalY: number, _slope: number, out: StationImmersion): void {
    let volume = 0;
    let waterplane = 0;
    for (const slice of this.slices) {
      volume += segmentArea(slice.radius, slice.centreY, waterLocalY) * slice.length;
      waterplane += segmentChord(slice.radius, slice.centreY, waterLocalY) * slice.length;
    }
    out.volume = volume;
    out.waterplaneArea = waterplane;
    out.centroidX = this.axisX;
    out.centroidY = 0;
    // Raft stations are already independent transverse columns; no additional
    // clipped starboard/port waterline pair is needed for their aggregate.
    out.waterlineContactCount = 0;
  }
}

/** Build the raft's contact stations from the same timber records as its meshes. */
export function buildRaftStations(
  logs: readonly LogGeometry[],
  beams: readonly BeamGeometry[],
  deckLength: number,
): ContactStation[] {
  const stations: ContactStation[] = [];
  const sorted = [...logs].sort((a, b) => a.x - b.x);
  const perColumn = Math.ceil(sorted.length / COLUMNS);
  const cellLength = deckLength / ROWS;
  const raftBreadth =
    Math.max(...logs.map((log) => log.x + Math.max(log.radiusBow, log.radiusStern))) -
    Math.min(...logs.map((log) => log.x - Math.max(log.radiusBow, log.radiusStern)));
  const tributaryBreadth = raftBreadth / COLUMNS;

  for (let column = 0; column < COLUMNS; column++) {
    const columnLogs = sorted.slice(column * perColumn, (column + 1) * perColumn);
    if (!columnLogs.length) continue;
    const meanX = columnLogs.reduce((sum, log) => sum + log.x, 0) / columnLogs.length;
    const x0 =
      column === 0 ? -Infinity : (meanX + sorted[column * perColumn - 1].x) / 2;
    const x1 =
      column === COLUMNS - 1
        ? Infinity
        : (meanX + sorted[(column + 1) * perColumn].x) / 2;

    for (let row = 0; row < ROWS; row++) {
      const zc = -deckLength / 2 + cellLength * (row + 0.5);
      const z0 = zc - cellLength / 2;
      const z1 = zc + cellLength / 2;
      const slices: FloatSlice[] = [];
      let crownY = -Infinity;
      const barrierLog =
        column === 0
          ? columnLogs[0]
          : column === COLUMNS - 1
            ? columnLogs[columnLogs.length - 1]
            : undefined;

      for (const log of columnLogs) {
        const a = Math.max(z0, log.z - log.length / 2);
        const b = Math.min(z1, log.z + log.length / 2);
        if (b <= a) continue;
        const t = ((a + b) / 2 - (log.z - log.length / 2)) / log.length;
        const radius =
          log.radiusStern +
          (log.radiusBow - log.radiusStern) * clamp(t, 0, 1);
        slices.push({ radius, centreY: log.y, length: b - a });
        if (barrierLog === undefined) crownY = Math.max(crownY, log.y + radius);
        else if (log === barrierLog) crownY = log.y + radius;
      }

      for (const beam of beams) {
        if (beam.z < z0 || beam.z >= z1) continue;
        const a = Math.max(x0, -beam.length / 2);
        const b = Math.min(x1, beam.length / 2);
        if (b <= a) continue;
        slices.push({ radius: beam.radius, centreY: beam.y, length: b - a });
      }
      if (!slices.length) continue;

      const stationCrownY = crownY === -Infinity ? 0 : crownY;
      stations.push({
        x: meanX,
        z: zc,
        section: new LogBundleSection(slices, meanX, stationCrownY),
        crownY: stationCrownY,
        outerEdge: column === 0 || column === COLUMNS - 1,
        edgeSign: column === 0 ? -1 : column === COLUMNS - 1 ? 1 : 0,
        longitudinalRegion: classifyLongitudinalContact(
          zc,
          -deckLength / 2,
          deckLength / 2,
        ),
        transverseRegion:
          column === 0 ? 'starboard' : column === COLUMNS - 1 ? 'port' : 'centre',
        overtopContactWidthM: cellLength,
        overtopTributaryAreaM2: cellLength * tributaryBreadth,
      });
    }
  }
  return stations;
}

/** Build the raft's mass items from its timber and carried masses. */
export function buildRaftMasses(
  logs: readonly LogGeometry[],
  beams: readonly BeamGeometry[],
  topsides: readonly MassItem[],
): MassItem[] {
  const items: MassItem[] = [];
  for (const log of logs) {
    const rb = log.radiusStern;
    const rt = log.radiusBow;
    const volume = (Math.PI / 3) * log.length * (rb * rb + rb * rt + rt * rt);
    const mass = volume * RHO_TIMBER;
    const meanRadius = (rb + rt) / 2;
    items.push({
      mass,
      x: log.x,
      y: log.y,
      z: log.z,
      ixx: (mass * (3 * meanRadius * meanRadius + log.length * log.length)) / 12,
      izz: (mass * meanRadius * meanRadius) / 2,
    });
  }
  for (const beam of beams) {
    const mass = Math.PI * beam.radius * beam.radius * beam.length * RHO_TIMBER;
    items.push({
      mass,
      x: 0,
      y: beam.y,
      z: beam.z,
      ixx: (mass * beam.radius * beam.radius) / 2,
      izz: (mass * (3 * beam.radius * beam.radius + beam.length * beam.length)) / 12,
    });
  }
  items.push(...topsides);
  return items;
}

/** Raft-specific construction over the shared vessel buoyancy engine. */
export class RaftBuoyancy extends BuoyantBody {
  constructor(options: RaftBuoyancyOptions) {
    super({
      stations: buildRaftStations(options.logs, options.beams, options.deckLength),
      masses: buildRaftMasses(options.logs, options.beams, options.topsides),
      addedMassCoefficient: RAFT_ADDED_MASS_COEFFICIENT,
      dampingRatio: RAFT_DAMPING_RATIO,
    });
  }
}

function segmentArea(radius: number, centreY: number, waterY: number): number {
  const depth = waterY - (centreY - radius);
  if (depth <= 0) return 0;
  if (depth >= 2 * radius) return Math.PI * radius * radius;
  const height = radius - depth;
  return (
    radius * radius * Math.acos(height / radius) -
    height * Math.sqrt(Math.max(radius * radius - height * height, 0))
  );
}

function segmentChord(radius: number, centreY: number, waterY: number): number {
  const depth = waterY - (centreY - radius);
  if (depth <= 0 || depth >= 2 * radius) return 0;
  const height = radius - depth;
  return 2 * Math.sqrt(Math.max(radius * radius - height * height, 0));
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
