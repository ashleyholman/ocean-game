/**
 * The pressure field, and the wind that comes out of it.
 *
 * Decision D2 (`docs/weather/WEATHER_CONCEPT.md` §5b): a small physical
 * generator rather than six authored conditions, because it is the only version
 * in which "the glass is falling" and "the wind is getting up" cannot drift
 * apart — one is derived from the other.
 *
 * THE FIELD
 * ---------
 * A seeded sum of plane waves in horizontal position, all carried past the ship
 * by one steering flow: a frozen synoptic chart sliding by, not a boiling one.
 * It is the `WorldWind` idiom one scale up — a pure function, no integration, no
 * `Math.random()`, amplitude-normalised so the dimensionless anomaly can never
 * leave [−1, 1]. Wavelengths run 1200–5000 km and take 18–77 world hours to
 * pass. Each component's amplitude is proportional to its wavelength, so every
 * component contributes equally to the *gradient* and the field is not
 * dominated by its smallest feature.
 *
 * The single steering flow is the load-bearing choice. Because every frequency
 * is `−c⃗·k⃗`, the tendency is `∂u/∂t = −c⃗·∇u` **algebraically** — the glass
 * moves fastest exactly when the isobars under the ship are steepest, and the
 * wind is what the isobars say. Give each component its own period instead and
 * the two become merely correlated: measured over three days, the wind then
 * rose as often on a rising glass as on a falling one. With the steering flow
 * it comes out at r = −0.74 in the committed trace, which is the number this
 * whole round is about.
 *
 * THE VOYAGE BEGINS IN A SETTLED SPELL
 * ------------------------------------
 * Every component starts at a quarter turn, so the field's gradient and its
 * tendency both vanish at the **anchor** — the instant and position where the
 * system was built. Slack isobars, a steady glass, and the weather still to
 * come. That is a design statement, but it is also load-bearing twice over: the
 * present wind is the prevailing wind plus the field's gradient measured from
 * its anchor value, so an anchor on a steep gradient would inverse the whole
 * relationship (see `calibratedWind`), and an exactly-repeatable anchor is what
 * lets WX1 claim **at the anchor the derived wind is the base wind's own
 * floats, bit for bit.**
 *
 * The pressure is deliberately *not* anchored — see `sample`.
 *
 * THE WIND
 * --------
 * Geostrophic: `V = (1/ρf) ẑ × ∇p` gives flow along the isobars with low
 * pressure on the left in the northern hemisphere, then surface friction takes
 * 30% off it and backs it toward the low. `f` is fixed at its 45° value rather
 * than tracked with latitude — a refinement this round deliberately does not
 * model, and pinning it keeps every bound closed-form. The hemisphere *sense*
 * does follow the anchor latitude, matching `SkySystem`'s cumulus veer.
 */
import { ecefToGeodetic } from '../world/wgs84';
import type { Vec3d } from '../world/math';
import { SPEED_GUST_AMPLITUDE_FRACTION } from '../world/WorldWind';
import { createGeographicBasis, geographicBasisFromGeodetic } from '../world/wgs84';
import {
  STANDARD_PRESSURE_HPA,
  WEATHER_BOUNDS,
  clampToWeatherBound,
  wrapCompassDeg,
  type WeatherCloudType,
  type WeatherState,
} from './WeatherState';

/** Fixed default seed; production and evidence share it, as `WorldWind` does. */
export const WEATHER_DEFAULT_SEED = 0x47_6c_61_73; // 'Glas'

/** Peak departure of the dimensionless pressure anomaly, hPa. */
export const PRESSURE_SWING_HPA = 20;

/**
 * The synoptic band: the scale of the depressions a barometer is for. Carried
 * past the ship by the steering flow below, these wavelengths take between 18
 * and 77 world hours to pass, so several systems cross a three-day trace and
 * none of them is so slow it merely sits there.
 *
 * The band was longer to begin with, 1900–11000 km, and the glass moved 5 hPa
 * in three days. Amplitude runs with wavelength — see the loop — so the longest
 * component carries most of the pressure, and if the longest component takes a
 * week to pass, most of the pressure signal is frozen for the whole voyage.
 */
const COMPONENTS = 5;
const WAVELENGTH_SHORTEST_M = 1200e3;
const WAVELENGTH_LONGEST_M = 5000e3;

/**
 * The steering flow that carries the whole pressure pattern, m/s. 18 m/s is
 * 65 km/h, a brisk but ordinary rate for a depression to travel at, and it is
 * what sets every timescale in the field: the shortest wavelength above takes
 * about 29 world hours to pass, which is 58 real minutes at the 30× calendar.
 * Raise this and the weather arrives sooner; it is the tempo dial.
 */
export const STEERING_SPEED_MPS = 18;

/** Air density and the Coriolis parameter at 45°, the geostrophic reference. */
const AIR_DENSITY_KG_PER_M3 = 1.225;
const EARTH_ANGULAR_RATE_RAD_PER_S = 7.2921159e-5;
const CORIOLIS_REFERENCE_LATITUDE_RAD = Math.PI / 4;
const CORIOLIS_REFERENCE =
  2 * EARTH_ANGULAR_RATE_RAD_PER_S * Math.sin(CORIOLIS_REFERENCE_LATITUDE_RAD);

/** Surface wind as a fraction of the geostrophic wind, and its inflow angle. */
const SURFACE_WIND_FRACTION = 0.7;
const SURFACE_INFLOW_DEG = 18;

/** How much straight down-gradient flow survives where Coriolis cannot balance. */
const EQUATORIAL_INFLOW_FRACTION = 0.34;

/**
 * How much of a full synoptic pressure pattern this field's wind carries.
 *
 * The one openly tuned number in the generator, and it needs its reason on the
 * record. The pressure field is calibrated to real depths — ±20 hPa about
 * standard — and the geostrophic wind of a real ±20 hPa pattern at these
 * wavelengths is a gale, correctly. But it does not arrive on a still day: it
 * is superposed on a prevailing wind that is already 6 m/s of *unmodelled*
 * background, so taking the field's wind at full strength doubles every gale.
 * At 0.7 the glass keeps its real depths and its real tendencies and the trace
 * runs 2.3–13.2 m/s about a 6 m/s prevailing, which is weather rather than a
 * replacement climate.
 *
 * This scales the *wind* only. Pressure, and therefore everything the barometer
 * reads, is untouched by it — and because it is a single positive gain, the
 * rigid link between a falling glass and a rising wind survives it intact.
 */
const RESOLVED_WIND_GAIN = 0.7;

/**
 * Degrees of latitude over which the hemisphere sense ramps through zero.
 * Matched in spirit to `SkySystem`'s `CUMULUS_WIND_VEER` equator ramp: there is
 * no geostrophic balance on the equator, and pretending otherwise puts a
 * discontinuity in the wind at 0°.
 */
const HEMISPHERE_RAMP_DEG = 5;

/** Three hours, the interval a synoptic pressure tendency is quoted over. */
export const TENDENCY_SECONDS = 3 * 3600;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const TWO_PI = Math.PI * 2;

/** Deterministic 32-bit LCG — the same constants `WorldWind` uses. */
function lcgNext(state: number): number {
  return (Math.imul(state, 1664525) + 1013904223) >>> 0;
}

interface PressureComponent {
  /** rad/s over weather time. */
  angularFrequency: number;
  /** rad/m along the anchor tangent plane's east and north axes. */
  waveNumberEast: number;
  waveNumberNorth: number;
  /** Normalised so the amplitudes sum to one. */
  amplitude: number;
  phase: number;
}

export interface WeatherSample {
  /** Dimensionless pressure anomaly about standard, in [−1, 1]. */
  anomaly: number;
  /** Its time derivative, 1/s. */
  anomalyRatePerSecond: number;
  /** Absolute normalised pressure gradient, magnitude in [0, 1]. */
  gradientEast: number;
  gradientNorth: number;
}

/** Reused so the per-frame derivation allocates nothing. */
const WIND_SCRATCH = { east: 0, north: 0 };

/** Everything the base wind contributes. Units and conventions as `WeatherState`. */
export interface WeatherBaseWind {
  speedMps: number;
  /** Compass degrees the wind blows toward. */
  directionDeg: number;
  gustiness: number;
}

export interface WeatherFieldAnchor {
  /** ECEF metres where the glass was set. */
  readonly positionEcefM: Readonly<Vec3d>;
  /** The world instant it was set at, UTC seconds. */
  readonly utcSeconds: number;
  /** Anchor latitude, radians — fixes the hemisphere sense for the voyage. */
  readonly latitudeRad: number;
}

/**
 * The generator. Constructed once per voyage; every sample is a pure function
 * of `(weatherElapsedSeconds, positionEcefM)` given the anchor and the seed.
 */
export class WeatherField {
  readonly anchor: WeatherFieldAnchor;
  readonly seed: number;

  private readonly components: readonly PressureComponent[];
  /** Σ aₖ|kₖ|, the closed-form bound on the gradient. */
  private readonly gradientNormalisation: number;
  /** Σ aₖ|ωₖ|, the closed-form bound on the tendency. */
  private readonly rateBoundPerSecond: number;
  /** The steering flow, m/s east/north. The whole chart travels on it. */
  private readonly steeringEastMps: number = 0;
  private readonly steeringNorthMps: number = 0;
  private readonly anchorEastAxis: Vec3d;
  private readonly anchorNorthAxis: Vec3d;
  private readonly anchorGradientEast: number;
  private readonly anchorGradientNorth: number;
  /** The reading the glass showed when the voyage began, hPa. Diagnostic. */
  readonly anchorPressureHpa: number;
  private readonly anchorWindEast: number;
  private readonly anchorWindNorth: number;
  private readonly hemisphereSense: number;

  constructor(anchorPositionEcefM: Readonly<Vec3d>, anchorUtcSeconds: number, seed = WEATHER_DEFAULT_SEED) {
    this.seed = seed >>> 0;

    const geodetic = ecefToGeodetic(anchorPositionEcefM, {
      latitudeRad: 0,
      longitudeRad: 0,
      heightM: 0,
    });
    const basis = geographicBasisFromGeodetic(
      geodetic.latitudeRad,
      geodetic.longitudeRad,
      createGeographicBasis(),
    );
    this.anchorEastAxis = basis.east;
    this.anchorNorthAxis = basis.north;
    this.anchor = {
      positionEcefM: {
        x: anchorPositionEcefM.x,
        y: anchorPositionEcefM.y,
        z: anchorPositionEcefM.z,
      },
      utcSeconds: anchorUtcSeconds,
      latitudeRad: geodetic.latitudeRad,
    };

    const latitudeDeg = geodetic.latitudeRad * RAD_TO_DEG;
    const ramp = Math.max(-1, Math.min(1, latitudeDeg / HEMISPHERE_RAMP_DEG));
    // An ODD smoothstep through the equator: the circulation sense reverses
    // across the line without a discontinuity and vanishes exactly on it. It
    // has to be odd — an even one would give the southern hemisphere northern
    // circulation, which is the kind of sign fault house rule 7 exists for.
    const magnitude = Math.abs(ramp);
    this.hemisphereSense =
      Math.sign(ramp) * magnitude * magnitude * (3 - 2 * magnitude);

    let state = this.seed;
    const draw = (): number => {
      state = lcgNext(state);
      return state / 0x1_0000_0000;
    };
    // THE PATTERN ADVECTS; IT DOES NOT TUMBLE.
    //
    // One steering flow carries the whole chart, which is what a weather map
    // actually does over two or three days, and it is the only construction in
    // which the glass and the wind are rigidly related rather than merely
    // sharing a seed. Give each component its own period and the tendency and
    // the gradient are two different sums over the same cosines, correlated
    // and no more: measured across 72 hours, the wind rose as often on a
    // rising glass as on a falling one. Set every frequency to `−c⃗·k⃗` instead
    // and the field is a frozen pattern sliding past at `c⃗`, which makes
    //
    //     ∂u/∂t = −c⃗ · ∇u
    //
    // an algebraic identity rather than a hope. The glass moves fastest
    // exactly when the isobars under the ship are steepest, and the wind is
    // what the isobars say. Taylor's frozen-field hypothesis, doing real work.
    //
    // What is given up: the pattern cannot deepen or fill as it passes, only
    // arrive and leave. Detuning each component slightly would restore that at
    // the cost of weakening the identity above, and it is deliberately left to
    // a later round rather than smuggled in here.
    const steeringHeadingRad = (draw() * 2 - 1) * 40 * DEG_TO_RAD;
    this.steeringEastMps = STEERING_SPEED_MPS * Math.cos(steeringHeadingRad);
    this.steeringNorthMps = STEERING_SPEED_MPS * Math.sin(steeringHeadingRad);

    const built: PressureComponent[] = [];
    const wavelengthRatio = WAVELENGTH_LONGEST_M / WAVELENGTH_SHORTEST_M;
    let amplitudeSum = 0;
    for (let i = 0; i < COMPONENTS; i++) {
      const spacing = COMPONENTS > 1 ? i / (COMPONENTS - 1) : 0;
      const wavelengthJitter = 0.85 + 0.3 * draw();
      const wavelength =
        WAVELENGTH_SHORTEST_M * wavelengthRatio ** spacing * wavelengthJitter;
      // Systems travel roughly eastward at these latitudes; ±70° of scatter
      // keeps the field from being a single marching front.
      const heading = (draw() * 2 - 1) * 70 * DEG_TO_RAD;
      // THE VOYAGE BEGINS IN A SETTLED SPELL, and it has to. Every component
      // starts at a quarter turn, so every cosine — and therefore the whole
      // field's gradient AND its tendency — is zero at the anchor: slack
      // isobars and a steady glass, with the weather still to come.
      //
      // This is not decoration, it is what makes the wind legible. The present
      // wind is the prevailing wind plus the field's gradient *measured from
      // its anchor value*. Leave the phases free and that anchor value is
      // typically a steep gradient, and the sign of the whole relationship
      // inverts: the wind then blows hardest when the isobars are flattest,
      // which is precisely backwards and measured at r = −0.41 before this
      // line existed. With the anchor slack, a departure from it is a real
      // gradient, and a falling glass brings wind the way it should.
      //
      // The sign is seeded so the field still starts somewhere different each
      // time, and the periods are incommensurate, so the components fall out
      // of step immediately after and never meaningfully re-cohere.
      const phase = draw() < 0.5 ? Math.PI / 2 : -Math.PI / 2;
      // Amplitude ∝ wavelength: every component then contributes the same
      // amount to the gradient, so the wind is not a function of the smallest
      // feature in the field.
      const amplitude = wavelength;
      amplitudeSum += amplitude;
      const waveNumber = TWO_PI / wavelength;
      const waveNumberEast = waveNumber * Math.cos(heading);
      const waveNumberNorth = waveNumber * Math.sin(heading);
      built.push({
        // θ = k⃗·x⃗ + ωt with ω = −c⃗·k⃗ is the pattern k⃗·(x⃗ − c⃗t): advected,
        // not evolving. This one line is what makes ∂u/∂t = −c⃗·∇u exact.
        angularFrequency: -(
          this.steeringEastMps * waveNumberEast +
          this.steeringNorthMps * waveNumberNorth
        ),
        waveNumberEast,
        waveNumberNorth,
        amplitude,
        phase,
      });
    }

    let gradientBound = 0;
    let rateBound = 0;
    for (const component of built) {
      component.amplitude /= amplitudeSum;
      gradientBound +=
        component.amplitude *
        Math.hypot(component.waveNumberEast, component.waveNumberNorth);
      rateBound += component.amplitude * Math.abs(component.angularFrequency);
    }
    this.components = built;
    this.gradientNormalisation = gradientBound;
    this.rateBoundPerSecond = rateBound;

    // The anchor readings, taken once — the glass being set at the start of
    // the voyage, and the wind the voyage starts in.
    const raw = this.rawSample(0, 0, 0);
    this.anchorPressureHpa = STANDARD_PRESSURE_HPA + PRESSURE_SWING_HPA * raw.anomaly;
    this.anchorGradientEast = raw.gradientEast;
    this.anchorGradientNorth = raw.gradientNorth;
    const anchorWind = geostrophicWind(
      raw.gradientEast,
      raw.gradientNorth,
      this.windScaleMps,
      this.hemisphereSense,
      { east: 0, north: 0 },
    );
    this.anchorWindEast = anchorWind.east;
    this.anchorWindNorth = anchorWind.north;
  }

  /**
   * The unresolved background wind this field is a departure from: the
   * prevailing wind minus the resolved geostrophic wind at the anchor. Exposed
   * because it is the one quantity that says how much of the voyage's wind is
   * modelled and how much is assumed.
   */
  backgroundWind(base: Readonly<WeatherBaseWind>): { east: number; north: number } {
    const baseRad = base.directionDeg * DEG_TO_RAD;
    return {
      east: base.speedMps * Math.sin(baseRad) - this.anchorWindEast,
      north: base.speedMps * Math.cos(baseRad) - this.anchorWindNorth,
    };
  }

  /** The geostrophic wind vector at the anchor, m/s east/north. */
  get anchorWind(): { east: number; north: number; speedMps: number } {
    return {
      east: this.anchorWindEast,
      north: this.anchorWindNorth,
      speedMps: Math.hypot(this.anchorWindEast, this.anchorWindNorth),
    };
  }

  /** Peak pressure departure either way from standard, hPa. */
  get pressureBoundHpa(): number {
    return PRESSURE_SWING_HPA;
  }

  /** Peak tendency the field can produce, hPa per three hours. */
  get tendencyBoundHpaPer3h(): number {
    return PRESSURE_SWING_HPA * this.rateBoundPerSecond * TENDENCY_SECONDS;
  }

  /**
   * Peak geostrophic wind the field's own pressure pattern implies at full
   * gradient, m/s, at the 45° reference latitude. The honest physical number,
   * before `RESOLVED_WIND_GAIN`.
   */
  get geostrophicBoundMps(): number {
    return (
      (PRESSURE_SWING_HPA * this.gradientNormalisation * 100) /
      (AIR_DENSITY_KG_PER_M3 * CORIOLIS_REFERENCE)
    );
  }

  /** The scale actually used for the wind — the above, gained down. */
  get windScaleMps(): number {
    return this.geostrophicBoundMps * RESOLVED_WIND_GAIN;
  }

  /** Sample the raw field, before the anchor is subtracted. */
  private rawSample(
    weatherElapsedSeconds: number,
    eastM: number,
    northM: number,
  ): WeatherSample {
    let anomaly = 0;
    let rate = 0;
    let gradientEast = 0;
    let gradientNorth = 0;
    for (const c of this.components) {
      const theta =
        c.angularFrequency * weatherElapsedSeconds +
        c.waveNumberEast * eastM +
        c.waveNumberNorth * northM +
        c.phase;
      const sin = Math.sin(theta);
      const cos = Math.cos(theta);
      anomaly += c.amplitude * sin;
      rate += c.amplitude * c.angularFrequency * cos;
      gradientEast += c.amplitude * c.waveNumberEast * cos;
      gradientNorth += c.amplitude * c.waveNumberNorth * cos;
    }
    return {
      anomaly,
      anomalyRatePerSecond: rate,
      gradientEast: gradientEast / this.gradientNormalisation,
      gradientNorth: gradientNorth / this.gradientNormalisation,
    };
  }

  /** Anchor-relative offsets of a position, in the anchor tangent plane. */
  tangentOffsetM(positionEcefM: Readonly<Vec3d>): { eastM: number; northM: number } {
    const dx = positionEcefM.x - this.anchor.positionEcefM.x;
    const dy = positionEcefM.y - this.anchor.positionEcefM.y;
    const dz = positionEcefM.z - this.anchor.positionEcefM.z;
    return {
      eastM:
        dx * this.anchorEastAxis.x +
        dy * this.anchorEastAxis.y +
        dz * this.anchorEastAxis.z,
      northM:
        dx * this.anchorNorthAxis.x +
        dy * this.anchorNorthAxis.y +
        dz * this.anchorNorthAxis.z,
    };
  }

  /**
   * The field at a place and a weather instant. Absolute in every component.
   *
   * The pressure is deliberately **not** re-zeroed at the anchor. Setting the
   * glass to standard at the start of the voyage sounds like what calibrating a
   * barometer means, and it was the first thing built, but it puts the anchor
   * wherever the field happens to be — and if that is near the bottom of the
   * field's range the glass can rise for three days and never fall once. The
   * pressure is centred on standard instead, so a voyage may begin in a high or
   * in a low and the glass has somewhere to go in both directions. Nothing
   * downstream needs the anchor reading to be 1013.25; only the *wind* has to
   * be exact there, and that is handled where the wind is.
   */
  sample(
    weatherElapsedSeconds: number,
    positionEcefM: Readonly<Vec3d>,
  ): WeatherSample {
    const { eastM, northM } = this.tangentOffsetM(positionEcefM);
    return this.rawSample(weatherElapsedSeconds, eastM, northM);
  }

  get anchorGradient(): { east: number; north: number; magnitude: number } {
    return {
      east: this.anchorGradientEast,
      north: this.anchorGradientNorth,
      magnitude: Math.hypot(this.anchorGradientEast, this.anchorGradientNorth),
    };
  }

  /**
   * The field's own geostrophic surface wind at an instant and a place, m/s
   * east/north, before the anchor is subtracted.
   *
   * WX2 needs this in public: re-calibrating the prevailing wind (a preset
   * button, an ocean-lab slider) means declaring that *this* instant's field
   * wind is the new zero of the departure, so the newly chosen wind is what
   * blows right now and the weather goes on departing from it.
   */
  geostrophicWindAt(
    weatherElapsedSeconds: number,
    positionEcefM: Readonly<Vec3d>,
    out: { east: number; north: number } = { east: 0, north: 0 },
  ): { east: number; north: number } {
    const sample = this.sample(weatherElapsedSeconds, positionEcefM);
    return geostrophicWind(
      sample.gradientEast,
      sample.gradientNorth,
      this.windScaleMps,
      this.hemisphereSense,
      out,
    );
  }

  /**
   * The whole record. `base` supplies the prevailing wind; the field supplies
   * the departure from it.
   *
   * `calibration` is the field wind the departure is measured *from*, and
   * defaults to the voyage anchor — which is WX1's behaviour verbatim, so the
   * committed series evidence is untouched by WX2. A caller that has declared
   * a new prevailing wind mid-voyage passes the field wind at that instant
   * instead, which puts the departure back at exactly zero there and keeps
   * the bit-for-bit guard below intact.
   */
  derive(
    weatherElapsedSeconds: number,
    positionEcefM: Readonly<Vec3d>,
    base: Readonly<WeatherBaseWind>,
    calibration?: Readonly<{ east: number; north: number }>,
  ): WeatherState {
    const sample = this.sample(weatherElapsedSeconds, positionEcefM);

    const pressureHpa = clampToWeatherBound(
      'pressureHpa',
      STANDARD_PRESSURE_HPA + PRESSURE_SWING_HPA * sample.anomaly,
    );
    // The trailing `+ 0` folds IEEE −0 into +0 *after* the clamp, which would
    // otherwise hand it straight back — a steady glass must not read as falling
    // by a negative nothing. `WorldWind` folds its own zero the same way.
    const pressureTrendHpaPer3h =
      clampToWeatherBound(
        'pressureTrendHpaPer3h',
        PRESSURE_SWING_HPA * sample.anomalyRatePerSecond * TENDENCY_SECONDS,
      ) + 0;

    geostrophicWind(
      sample.gradientEast,
      sample.gradientNorth,
      this.windScaleMps,
      this.hemisphereSense,
      WIND_SCRATCH,
    );
    const wind = calibratedWind(
      WIND_SCRATCH.east,
      WIND_SCRATCH.north,
      calibration ? calibration.east : this.anchorWindEast,
      calibration ? calibration.north : this.anchorWindNorth,
      base,
    );

    return {
      weatherElapsedSeconds,
      pressureHpa,
      pressureTrendHpaPer3h,
      windSpeedMps: wind.speedMps,
      windDirectionDeg: wind.directionDeg,
      // WX1 passes gustiness through untouched. The gust field is WX3's round
      // but the temporal WorldWind process remains a separate point sample.
      gustiness: base.gustiness,
      // The spatial field uses a physical maximum departure. Matching the
      // existing temporal process's documented peak fraction gives the old
      // dimensionless control a legible migration without changing it.
      gustExcessMps: clampToWeatherBound(
        'gustExcessMps',
        wind.speedMps * base.gustiness * SPEED_GUST_AMPLITUDE_FRACTION,
      ),
      ...this.deriveSky(pressureHpa, pressureTrendHpaPer3h),
    };
  }

  /**
   * The sky and the rain the glass implies.
   *
   * Split out from `derive` so the evidence can walk it across pressures the
   * voyage never reaches — otherwise these fields, which nothing renders until
   * WX4 and WX5, would sit unexercised and rot. Everything here is derived from
   * one scalar with legible consequences, which is the whole brief: not a model.
   */
  deriveSky(
    pressureHpa: number,
    pressureTrendHpaPer3h: number,
  ): Pick<
    WeatherState,
    | 'cloudCoverThreshold'
    | 'cloudType'
    | 'cloudCeilingM'
    | 'precipRateMmPerHour'
    | 'visibilityM'
    | 'electricalActivity'
    | 'gustPatchMetres'
    | 'gustPeriodSeconds'
  > {
    // 25 hPa below standard is a deep low; 3 hPa in three hours is a glass
    // dropping fast enough to shorten sail on. Weighted toward the level
    // rather than the rate, because a low that has already arrived is worse
    // weather than one that is merely on its way.
    const lowness = clamp01((STANDARD_PRESSURE_HPA - pressureHpa) / 25);
    const falling = clamp01(-pressureTrendHpaPer3h / 3);
    const severity = clamp01(0.62 * lowness + 0.38 * falling);

    const precipRateMmPerHour = clampToWeatherBound(
      'precipRateMmPerHour',
      severity <= 0.45 ? 0 : 22 * ((severity - 0.45) / 0.55) ** 1.6,
    );

    return {
      gustPatchMetres: clampToWeatherBound('gustPatchMetres', 90 + 240 * severity),
      gustPeriodSeconds: clampToWeatherBound('gustPeriodSeconds', 46 - 26 * severity),
      cloudCoverThreshold: clampToWeatherBound(
        'cloudCoverThreshold',
        0.7 - 0.4 * severity,
      ),
      cloudType: cloudTypeFor(severity),
      cloudCeilingM: clampToWeatherBound('cloudCeilingM', 1100 - 700 * severity),
      precipRateMmPerHour,
      // 9000 m is `oceanOptics.ts`'s clear-air haze distance and is reproduced
      // exactly when it is not raining: exp(0) is 1.
      visibilityM: clampToWeatherBound(
        'visibilityM',
        9000 * Math.exp(-0.09 * precipRateMmPerHour),
      ),
      electricalActivity: clampToWeatherBound(
        'electricalActivity',
        clamp01((severity - 0.72) / 0.28),
      ),
    };
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function cloudTypeFor(severity: number): WeatherCloudType {
  if (severity < 0.15) return 'fair';
  if (severity < 0.4) return 'cumulus';
  if (severity < 0.7) return 'stratocumulus';
  return 'overcast';
}

/**
 * The surface wind vector implied by a pressure gradient, east/north, m/s.
 *
 * Geostrophic balance is `V = (1/ρf) ẑ × ∇p`, i.e. `(−∂p/∂N, ∂p/∂E)`: the flow
 * runs along the isobars with low pressure on the left in the northern
 * hemisphere, which is Buys Ballot's law. Surface friction then takes 30% off
 * it and backs it toward the low by 18°, the usual figure over water. The
 * geostrophic term ramps through zero across the equator, where nothing can be
 * in geostrophic balance; what survives there is flow straight down the
 * gradient from high to low, which is what actually happens.
 */
export function geostrophicWind(
  gradientEast: number,
  gradientNorth: number,
  scaleMps: number,
  hemisphereSense: number,
  out: { east: number; north: number },
): { east: number; north: number } {
  const alongEast = -gradientNorth * scaleMps;
  const alongNorth = gradientEast * scaleMps;

  const inflowRad = SURFACE_INFLOW_DEG * DEG_TO_RAD * hemisphereSense;
  const cosInflow = Math.cos(inflowRad);
  const sinInflow = Math.sin(inflowRad);

  const ageostrophic = 1 - Math.abs(hemisphereSense);
  out.east =
    SURFACE_WIND_FRACTION *
    (hemisphereSense * (alongEast * cosInflow - alongNorth * sinInflow) -
      EQUATORIAL_INFLOW_FRACTION * ageostrophic * gradientEast * scaleMps);
  out.north =
    SURFACE_WIND_FRACTION *
    (hemisphereSense * (alongEast * sinInflow + alongNorth * cosInflow) -
      EQUATORIAL_INFLOW_FRACTION * ageostrophic * gradientNorth * scaleMps);
  return out;
}

/**
 * The present wind: the prevailing wind plus the field's geostrophic departure
 * from what it was blowing when the voyage began.
 *
 * **Why a sum and not a scaling.** The geostrophic operator is linear, so the
 * wind of a total pressure field is the sum of the winds of its parts:
 *
 *     ∇p_total = ∇p_background + ∇p_resolved
 *     V        = V_prevailing  + geostrophic(∇p_resolved)
 *
 * This field resolves the second term only. The first — the planetary-scale
 * gradient that makes a trade wind — is not modelled, and setting it to
 * whatever makes the voyage begin in the wind we already had is both the
 * honest statement of our ignorance and the thing that makes the anchor exact.
 * That is why the departure is taken against `anchor…`: it is not a fudge, it
 * is the background term, and a constant gradient has no curvature so it
 * distorts nothing about how the resolved weather behaves.
 *
 * Two forms were tried and rejected before this one. Scaling the prevailing
 * wind by the gradient's *ratio* to its anchor value collapsed the wind to
 * calm every time the isobars flattened — a becalmed ship every few hours and
 * a compass that span 45° in six minutes as the vector crossed the origin.
 * Anchoring the pressure to exactly 1013.25 hPa as well put the whole voyage
 * on one side of standard, so the glass could rise but never fall, which is
 * the one thing this round exists to make it do.
 *
 * THE EXACTNESS GUARD is the whole basis of WX1's pixel-identical claim. At the
 * anchor the departure is `x − x` in both components, exactly +0 — but the base
 * wind still has to come back out as *its own floats*, not as a round trip
 * through `hypot` and `atan2` that would land a few ULPs away and move every
 * consumer of the wind by a hair. Same species of guard as `WorldWind`'s
 * `offset + 0` folding of −0.
 */
export function calibratedWind(
  east: number,
  north: number,
  anchorEast: number,
  anchorNorth: number,
  base: Readonly<WeatherBaseWind>,
): { speedMps: number; directionDeg: number } {
  const departureEast = east - anchorEast;
  const departureNorth = north - anchorNorth;
  if (departureEast === 0 && departureNorth === 0) {
    return { speedMps: base.speedMps, directionDeg: base.directionDeg };
  }

  const baseRad = base.directionDeg * DEG_TO_RAD;
  const totalEast = base.speedMps * Math.sin(baseRad) + departureEast;
  const totalNorth = base.speedMps * Math.cos(baseRad) + departureNorth;

  const speedMps = Math.min(
    WEATHER_BOUNDS.windSpeedMps.max,
    Math.hypot(totalEast, totalNorth),
  );
  // A vector's bearing is continuous through north by construction: 359° → 1°
  // is one small step of `atan2`, never a 358° jump. The wrap happens once,
  // here, and `compassDeltaDeg` is what any consumer must difference it with.
  const directionDeg =
    totalEast === 0 && totalNorth === 0
      ? base.directionDeg
      : wrapCompassDeg(Math.atan2(totalEast, totalNorth) * RAD_TO_DEG);

  return { speedMps, directionDeg };
}
