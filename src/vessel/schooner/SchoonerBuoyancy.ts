import { BuoyantBody } from '../BuoyantBody';
import type {
  ContactStation,
  MassItem,
  StationImmersion,
  StationSection,
} from '../BuoyantBody';
import { classifyLongitudinalContact } from '../HullWaterContact';
import { hullStations, hydrostaticsAt } from './hydrostatics';
import { DESIGN_DRAUGHT, HULL_LENGTH } from './hullForm';
import { createSectionImmersion } from './hullSection';
import type { Section, SectionImmersion } from './hullSection';
import { buildLoadedShip, massProperties } from './massModel';
import { deckHalfWidth, deckLevelAt } from './deckSurface';

/**
 * The schooner as a floating rigid body.
 *
 * All this does is join the two halves that already exist: the hull form's
 * stations (`hydrostatics.ts`) and the mass budget (`massModel.ts`), handed to
 * the shared `BuoyantBody`. There is no second rigid-body implementation here:
 * schooner-specific behaviour is expressed through geometry and coefficients.
 */

/**
 * Added mass for roll and heave, as a multiple of displaced mass.
 *
 * A hull 2.3 m deep with a turned bilge carries less water with it than a
 * shallow flat body. 0.45 is the conventional estimate
 * for a hull of this beam-to-draught ratio and is documented, not fitted.
 */
const SHIP_ADDED_MASS = 0.45;

/**
 * Heave damping ratio, which also damps pitch through the stations' arms.
 *
 * 0.35 now that roll has its own term below. It used to be 0.18 — a compromise
 * struck when this one number had to cover all three modes, which meant it was
 * pulled well below the truth for heave to avoid over-damping a roll it was in
 * fact barely touching. A hull of this beam-to-draught ratio heaves at nearer
 * 0.3–0.4: heave radiates waves strongly and dies out in a cycle or two.
 */
const SHIP_HEAVE_DAMPING_RATIO = 0.35;

/**
 * Linear roll damping, as a fraction of critical.
 *
 * Radiation and skin friction, which are the parts of roll damping that really
 * are proportional to roll rate. 0.045 is the low end of the range for a
 * ballasted hull with no bilge keels, and it is deliberately low: on its own it
 * would still let her wind up at resonance. The amplitude limit comes from the
 * quadratic term, which is where it comes from on the real vessel.
 */
const SHIP_ROLL_DAMPING_RATIO = 0.075;

/**
 * Quadratic roll damping, per radian.
 *
 * Eddy shedding off the turn of the bilge, which goes as `|phi_dot| * phi_dot`
 * and dominates once she is rolling properly. This is the term that makes the
 * difference between "rolls heavily in a gale" and "lies on her beam ends": a
 * linear-only model has nothing that grows with amplitude, so at resonance it
 * integrates straight into the limiter.
 *
 * 0.42 puts the quadratic moment level with the linear one at about 18° of
 * amplitude, which is where a hull with a bilge as hard as hers starts shedding
 * in earnest. Chosen against the sea-state sweep in `ship-hydrostatics.test.ts`
 * rather than from a formula — Ikeda's method wants a model test to calibrate
 * and we have a sea instead.
 */
const SHIP_ROLL_QUADRATIC_DAMPING = 0.60;

/** Adapts a lofted hull section to the flotation model's station interface. */
class LoftedHullSection implements StationSection {
  private readonly scratch: SectionImmersion = createSectionImmersion();

  constructor(
    private readonly section: Section,
    private readonly length: number,
  ) {}

  get crownY(): number {
    return this.section.crownY;
  }

  get floorY(): number {
    return this.section.floorY;
  }

  immerse(waterLocalY: number, slope: number, out: StationImmersion): void {
    this.section.immerse(waterLocalY, slope, this.scratch);
    out.volume = this.scratch.area * this.length;
    out.waterplaneArea = this.scratch.chord * this.length;
    out.centroidX = this.scratch.centroidX;
    out.centroidY = this.scratch.centroidY;
    out.waterlineContactCount = this.scratch.waterlineContactCount;
    out.waterlineStarboardX = this.scratch.waterlineStarboardX;
    out.waterlineStarboardY = this.scratch.waterlineStarboardY;
    out.waterlinePortX = this.scratch.waterlinePortX;
    out.waterlinePortY = this.scratch.waterlinePortY;
  }
}

/** Build the schooner's contact stations from the lofted hull. */
export function buildSchoonerStations(): ContactStation[] {
  return hullStations().map((st) => ({
    x: 0,
    z: st.z,
    section: new LoftedHullSection(st.section, st.length),
    // The schooner's crown is its deck edge for the full length: a sea that
    // reaches the rail comes aboard wherever it reaches it.
    crownY: st.section.crownY,
    outerEdge: true,
    edgeSign: 0,
    longitudinalRegion: classifyLongitudinalContact(
      st.z,
      -HULL_LENGTH / 2,
      HULL_LENGTH / 2,
    ),
    // This station integrates the full starboard-to-port cross-section. Its
    // two real side intersections are exposed by HullWaterContact.
    transverseRegion: 'centre',
    // Hydrostatic station slabs are a non-overlapping partition of the 15.5 m
    // hull: 39 × HULL_LENGTH/39. One boarding event selects one rail, so its
    // critical-flow width is exactly this slab length and its finite prism owns
    // only the matching half-deck, never both port and starboard catchments.
    overtopContactWidthM: st.length,
    overtopTributaryAreaM2:
      st.length * deckHalfWidth(st.z, deckLevelAt(st.z)),
  }));
}

export interface SchoonerBuoyancyOptions {
  /**
   * Whether she advances the wave field. Defaults to true.
   *
   * True is right for a body that owns its field — every headless test builds
   * its own `WaveField` and would otherwise sit on a frozen sea. False is right
   * only when something else is already driving the same field, which in the
   * running scene means a diagnostic vessel. See `BuoyantBodyOptions.advancesWaveField`.
   */
  advancesWaveField?: boolean;
}

/** The loaded schooner, floating. */
export function buildSchoonerBuoyancy(
  options: SchoonerBuoyancyOptions = {},
): BuoyantBody {
  const { items } = buildLoadedShip();
  const masses: MassItem[] = items.map((it) => ({
    mass: it.mass,
    x: it.x,
    y: it.y,
    z: it.z,
    ixx: it.ixx,
    izz: it.izz,
  }));

  // GM comes from the hull's own hydrostatics rather than being restated here;
  // it only scales the linear roll damping, but a second copy of it would be a
  // second thing to keep true.
  const h = hydrostaticsAt(DESIGN_DRAUGHT);
  const properties = massProperties(items);

  return new BuoyantBody({
    stations: buildSchoonerStations(),
    masses,
    addedMassCoefficient: SHIP_ADDED_MASS,
    dampingRatio: SHIP_HEAVE_DAMPING_RATIO,
    rollDampingRatio: SHIP_ROLL_DAMPING_RATIO,
    rollQuadraticDamping: SHIP_ROLL_QUADRATIC_DAMPING,
    metacentricHeight: h.km - properties.comY,
    advancesWaveField: options.advancesWaveField ?? true,
  });
}

/**
 * Measure the roll period by free decay.
 *
 * Heel her, let go on flat water, and time the zero crossings — which is how
 * the period is measured on a real vessel, by an inclining-and-release trial.
 * It is the only way to see the period the *integrator* actually produces
 * rather than the one the closed-form estimate predicts, and the two differ by
 * the damping: a damped period runs longer than the natural one by
 * `1/sqrt(1 - zeta^2)`.
 */
export function measureRollDecay(
  body: BuoyantBody,
  waves: { advance(dt: number): void; sample: unknown },
  initialRollRadians: number,
  seconds = 40,
): { period: number; crossings: number[] } {
  const step = 1 / 240;
  const field0 = waves as Parameters<BuoyantBody['update']>[1];

  // Settle onto the (flat) surface first. `update` snaps an unsettled body to
  // the water and zeroes its attitude, so heeling her before that would simply
  // be undone on the first step.
  body.reset();
  body.snapToSurface(field0, 0, 0, 0);
  body.roll = initialRollRadians;
  body.rollRate = 0;

  const crossings: number[] = [];
  let previous = body.roll;
  let t = 0;

  const field = field0;
  for (let i = 0; i < Math.round(seconds / step); i++) {
    body.update(step, field, 0, 0, 0);
    t += step;
    if (previous > 0 !== body.roll > 0) {
      // Linear interpolation onto the crossing, so the period does not inherit
      // the substep as quantisation noise.
      const frac = previous / (previous - body.roll);
      crossings.push(t - step + step * frac);
    }
    previous = body.roll;
  }

  if (crossings.length < 3) return { period: Number.NaN, crossings };

  // Half a period per crossing; drop the first, which carries the release
  // transient.
  const used = crossings.slice(1);
  const span = used[used.length - 1] - used[0];
  return { period: (2 * span) / (used.length - 1), crossings };
}

export interface PitchDecayPeak {
  timeSeconds: number;
  pitchRadians: number;
}

export interface PitchDecayResult {
  /** Damped oscillation period measured from zero crossings. */
  period: number;
  /** Effective damping ratio from successive same-direction peaks. */
  dampingRatio: number;
  crossings: number[];
  peaks: PitchDecayPeak[];
}

/**
 * Pitch free-decay trial, parallel to `measureRollDecay` but with damping
 * evidence retained as well as period.
 *
 * The release angle itself is recorded as the first positive peak. Later
 * extrema are detected when pitch rate changes sign. Damping uses peaks on the
 * same side of equilibrium, one full cycle apart, so the logarithmic-decrement
 * conversion uses 2*pi rather than accidentally treating a half-cycle as a
 * whole one.
 */
export function measurePitchDecay(
  body: BuoyantBody,
  waves: Parameters<BuoyantBody['update']>[1],
  initialPitchRadians: number,
  seconds = 30,
): PitchDecayResult {
  const step = 1 / 240;

  body.reset();
  body.snapToSurface(waves, 0, 0, 0);
  body.pitch = initialPitchRadians;
  body.pitchRate = 0;

  const crossings: number[] = [];
  const peaks: PitchDecayPeak[] = [
    { timeSeconds: 0, pitchRadians: initialPitchRadians },
  ];
  let previousPitch = body.pitch;
  let previousRate = body.pitchRate;
  let timeSeconds = 0;

  for (let i = 0; i < Math.round(seconds / step); i++) {
    body.update(step, waves, 0, 0, 0);
    timeSeconds += step;

    if (previousPitch > 0 !== body.pitch > 0) {
      const fraction = previousPitch / (previousPitch - body.pitch);
      crossings.push(timeSeconds - step + step * fraction);
    }

    if (
      previousRate !== 0 &&
      previousRate > 0 !== body.pitchRate > 0 &&
      Math.abs(previousPitch) > 1e-8
    ) {
      peaks.push({ timeSeconds: timeSeconds - step, pitchRadians: previousPitch });
    }

    previousPitch = body.pitch;
    previousRate = body.pitchRate;
  }

  let period = Number.NaN;
  if (crossings.length >= 3) {
    // Drop the first crossing, which carries the release transient.
    const used = crossings.slice(1);
    period = (2 * (used[used.length - 1] - used[0])) / (used.length - 1);
  }

  const decrements: number[] = [];
  for (let i = 0; i < peaks.length; i++) {
    const a = peaks[i];
    for (let j = i + 1; j < peaks.length; j++) {
      const b = peaks[j];
      if (a.pitchRadians > 0 !== b.pitchRadians > 0) continue;
      const first = Math.abs(a.pitchRadians);
      const second = Math.abs(b.pitchRadians);
      if (first > second && second > 1e-7) {
        decrements.push(Math.log(first / second));
      }
      break;
    }
  }

  const usable = decrements.slice(0, 3);
  const meanDecrement = usable.length
    ? usable.reduce((sum, value) => sum + value, 0) / usable.length
    : Number.NaN;
  const dampingRatio = Number.isFinite(meanDecrement)
    ? meanDecrement / Math.sqrt(4 * Math.PI ** 2 + meanDecrement ** 2)
    : Number.NaN;

  return { period, dampingRatio, crossings, peaks };
}
