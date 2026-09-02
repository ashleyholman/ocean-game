/** One already-registered waterline point in the ocean's XZ parameter space. */
export interface BowWakePointXZ {
  x: number;
  z: number;
}

/**
 * Finite near-field source fitted to the live forward waterline.
 *
 * `tip` is the most-forward complete cut. `shoulder` is two renderer stations
 * aft, roughly 2.4 m on the schooner: far enough to measure the working bow's
 * real breadth, but still forward of the midship body.
 *
 * `crownHalfWidthM` is a FLOOR expressed as a fraction of the measured
 * shoulder, not a measurement in its own right. In production the floor always
 * wins: the most-forward complete cut sits where the hull is narrowest, so
 * `tipHalfWidthM` is a fraction of a metre against a shoulder half-breadth of
 * around two, and 0.58 of the latter is the larger number every frame. The max
 * is kept because a bluffer hull — a barge, a cut-down bow — genuinely can
 * present a tip wider than that, and there the measurement should win. Do not
 * read the max as evidence that the live tip span is driving the render on
 * this schooner; it is not, and WK-R9's note claiming otherwise was wrong.
 */
export interface BowPressureFrontGeometry {
  tipCentreX: number;
  tipCentreZ: number;
  tipHalfWidthM: number;
  shoulderCentreX: number;
  shoulderCentreZ: number;
  shoulderHalfWidthM: number;
  crownHalfWidthM: number;
}

export const BOW_PRESSURE_SHOULDER_STATIONS_AFT = 2;
export const BOW_PRESSURE_CROWN_SHOULDER_FRACTION = 0.58;

/** Resolve one stable geometry object from packed port/starboard stations. */
export function resolveBowPressureFrontGeometry(
  points: readonly BowWakePointXZ[],
  stationCount: number,
  out: BowPressureFrontGeometry,
): boolean {
  const available = Math.min(
    Math.max(Math.floor(stationCount), 0),
    Math.floor(points.length / 2),
  );
  if (available === 0) {
    out.tipCentreX = 0;
    out.tipCentreZ = 0;
    out.tipHalfWidthM = 0;
    out.shoulderCentreX = 0;
    out.shoulderCentreZ = 0;
    out.shoulderHalfWidthM = 0;
    out.crownHalfWidthM = 0;
    return false;
  }

  const tipIndex = (available - 1) * 2;
  const shoulderIndex = Math.max(
    available - 1 - BOW_PRESSURE_SHOULDER_STATIONS_AFT,
    0,
  ) * 2;
  const tipPort = points[tipIndex];
  const tipStarboard = points[tipIndex + 1];
  const shoulderPort = points[shoulderIndex];
  const shoulderStarboard = points[shoulderIndex + 1];

  out.tipCentreX = (tipPort.x + tipStarboard.x) * 0.5;
  out.tipCentreZ = (tipPort.z + tipStarboard.z) * 0.5;
  out.tipHalfWidthM = Math.hypot(
    tipPort.x - tipStarboard.x,
    tipPort.z - tipStarboard.z,
  ) * 0.5;
  out.shoulderCentreX = (shoulderPort.x + shoulderStarboard.x) * 0.5;
  out.shoulderCentreZ = (shoulderPort.z + shoulderStarboard.z) * 0.5;
  out.shoulderHalfWidthM = Math.hypot(
    shoulderPort.x - shoulderStarboard.x,
    shoulderPort.z - shoulderStarboard.z,
  ) * 0.5;
  out.crownHalfWidthM = Math.max(
    out.tipHalfWidthM,
    out.shoulderHalfWidthM * BOW_PRESSURE_CROWN_SHOULDER_FRACTION,
  );
  return true;
}
