/**
 * A/B switches for the colour pipeline. Diagnostic scaffolding, meant to be
 * deleted once the choices are made.
 *
 * Six independent flags, not one bundle. The bundle came first, on the
 * reasoning that these terms were tuned to cancel each other and so could not
 * be judged alone — which was true of how they were BUILT and false of how they
 * READ. Flipped as a unit they turned out to move different parts of the
 * picture in different directions: the old display transform deepens the sea
 * and dulls the sky at the same time, and no single switch can tell you that.
 *
 * `?legacyColour=1` starts the four display-pipeline flags on, for capture
 * harnesses that want the whole pre-round look in one go.
 *
 * WHEN THESE GO: `skyProjection()` and `skySaturation()` exist only so those
 * two sky constants can move at runtime, which is also why they are uniforms in
 * GLSL rather than constants. Fold them back to `const` in `shaders/lib.ts` and
 * the compiler gets to constant-fold BETA_R_PROJ again — that is the entire
 * standing cost of having the switches.
 */

/** The pre-round sky hue: hand-fitted against ACES, CIE x 0.212, y 0.173. */
const LEGACY_PROJ: readonly [number, number, number] = [0.076, 0.0977, 0.42];
/** Derived — see tools/derive-sky-projection.mjs. CIE x 0.246, y 0.253. */
const CURRENT_PROJ: readonly [number, number, number] = [0.0519, 0.0977, 0.2467];

/**
 * Sky chroma trim. 1.0 means "absent".
 *
 * 1.25 SHIPS, by Ash's eye, and the reasoning that removed it was wrong about
 * why it was there. It arrived as compensation for the ACES shoulder eating
 * chroma out of every bright blue, so when the shoulder went it looked like
 * scaffolding and went too. But the sky it produces is the one that reads, with
 * or without ACES underneath — the three-band scattering model is a projection
 * of a continuous spectrum onto three primaries, and a modest chroma stretch is
 * a defensible correction for what that projection loses, not a lie.
 */
const SKY_CHROMA_TRIM = 1.25;
const NO_CHROMA_TRIM = 1.0;

/**
 * Guarded because the sky model is imported by unit tests, which run in node
 * with no `window`.
 */
const startLegacy =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('legacyColour') === '1';

type Listener = () => void;
const listeners = new Set<Listener>();

/**
 * Subscribe to any switch change. Consumers republish shader uniforms and
 * re-snap the exposure meter, so a flip lands in one frame rather than gliding
 * over the meter's four-second adaptation — an A/B you have to wait out is an
 * A/B you cannot see.
 */
export function onColourPipelineChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

function flag(initial: boolean): {
  get: () => boolean;
  set: (value: boolean) => void;
} {
  let value = initial;
  return {
    get: () => value,
    set: (next: boolean) => {
      if (next === value) return;
      value = next;
      notify();
    },
  };
}

// --- the four display-pipeline switches -------------------------------------

/** ACES Filmic instead of the hue-preserving curve. */
const toneCurve = flag(startLegacy);
/** The fixed 0.335 daylight exposure plateau instead of one adaptation curve. */
const exposureMeter = flag(startLegacy);
/**
 * Turns the chroma trim OFF, which is the A/B direction now that 1.25 ships.
 * Deliberately not part of the `?legacyColour=1` bundle: the trim is no longer
 * a legacy term, so bundling it there would mean the bundle disagreed with the
 * shipping default about a setting the shipping default owns.
 */
const noChromaTrim = flag(false);
/** The hand-fitted sky hue instead of the spectrally derived one. */
const skyHue = flag(startLegacy);

export const isLegacyToneCurve = toneCurve.get;
export const setLegacyToneCurve = toneCurve.set;
export const isLegacyExposure = exposureMeter.get;
export const setLegacyExposure = exposureMeter.set;
export const isChromaTrimDisabled = noChromaTrim.get;
export const setChromaTrimDisabled = noChromaTrim.set;
export const isLegacySkyHue = skyHue.get;
export const setLegacySkyHue = skyHue.set;

/** Spectral projection of Rayleigh in-scatter onto the display primaries. */
export function skyProjection(): readonly [number, number, number] {
  return skyHue.get() ? LEGACY_PROJ : CURRENT_PROJ;
}

/** Post-hoc chroma stretch inside the sky function. */
export function skySaturation(): number {
  return noChromaTrim.get() ? NO_CHROMA_TRIM : SKY_CHROMA_TRIM;
}

/**
 * The shadow toe, on by default. `?noToe=1` compiles it out.
 *
 * NOT a live switch, and the reason is structural rather than laziness: it
 * changes the tone curve's shader SOURCE, and three's program cache is keyed on
 * material parameters, not on chunk text — flipping it at runtime would leave
 * every already-compiled program running the old code and the A/B would be a
 * lie. Everything else here moves a uniform or a cache key, which is why the
 * rest are checkboxes and this one is a URL.
 */
const shadowToe =
  typeof window === 'undefined' ||
  new URLSearchParams(window.location.search).get('noToe') !== '1';

export function isShadowToeEnabled(): boolean {
  return shadowToe;
}

// --- the sun's ambient-fill estimator ---------------------------------------

/**
 * When set, the SUN's aerosol lobe is replaced by its own normalisation
 * wherever a MEAN of the sky is taken — the seven-sample ambient fill, the
 * 256-direction harmonic probe, and the eight-sample horizon ring the exposure
 * meter reads. The dome you actually look at is untouched either way.
 *
 * THE BUG. `ambientRadiance` averages the sky over seven directions: the
 * zenith, a ring at 26 degrees and a ring at 54. The aerosol phase function is
 * g = 0.94 for a high source — about 43 at the light's own direction and 0.11
 * twenty-five degrees off it, a factor of four hundred inside a few degrees.
 * Seven point samples do not estimate that mean, they play a lottery, and the
 * measured daylight fill reads 0.323 at 70 degrees sun, 0.353 at 45, and
 * 1.296 at 25 — a 2.4x spike as the sun crosses the sample ring, and the whole
 * scene's fill jumps with it.
 *
 * The same fault on the MOON was fixed outright in Part B of the night thread,
 * where at the new moon strength it made the fill pulse fourfold as the moon
 * tracked. This one is behind a switch and DEFAULT OFF for one reason: fixing
 * it moves daylight, and "daylight is bit-identical" is a standing acceptance
 * clause of Part A. Off, the sun's path runs the identical arithmetic it always
 * did — see the byte-identity test — so this costs nothing until Ash A/Bs it.
 *
 * `?sunDomeMean=1` opens with it on; the graphics panel and
 * `tools/ab-sheet.mjs` both flip it live.
 */
const sunDomeMean = flag(
  typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('sunDomeMean') === '1',
);
export const isSunDomeMeanEnabled = sunDomeMean.get;
export const setSunDomeMeanEnabled = sunDomeMean.set;

/**
 * When set, `ambientRadiance` stops being a flat average of SEVEN fixed
 * directions and becomes the cosine-weighted mean over the 256-direction
 * Fibonacci set the harmonic probe already evaluates every frame.
 *
 * WHY THIS RATHER THAN ANOTHER PATCH. `sunDomeMean` above, and the moon's copy
 * of it fixed outright in Part B, are two workarounds for one structural fault:
 * the fill is estimated from seven directions arranged on RINGS — the zenith, a
 * ring at 26 degrees, a ring at 53 — so any bright thing in the sky spikes the
 * whole scene's fill as it crosses one of them and drops back between them. A
 * spherical Fibonacci set has no rings to cross. It ends the class instead of
 * naming its members one at a time.
 *
 * MEASURED against a converged 8192-direction integral of the same quantity.
 * See docs/graphics/AMBIENT_SET_ROUND.md for the sweeps.
 *
 *   - The seven-sample set is out by 4.65x at a 26 degree sun, 3.14x at 53 and
 *     2.11x at 88 — and still 3 to 15 percent high BETWEEN the rings, because
 *     the aureole's tail keeps landing in it.
 *   - The 256-direction cosine mean is within 2 percent everywhere.
 *   - Under a drifting cloud deck — which no fix in this thread has ever
 *     addressed — the seven-sample fill swings 27.6 percent RMS and up to
 *     1.82x. The Fibonacci set brings that to 2.7 percent.
 *
 * COSINE-WEIGHTED, and that is a measurement too. A diffuse fill IS irradiance
 * over pi, so the cosine weight is the physically right one; it is also the
 * only weighting that preserves the LEVEL. A uniform solid-angle mean of the
 * very same 256 directions runs 1.30-1.36x brighter all day, because it drags
 * the bright horizon band into the fill — the one thing HORIZON_SAMPLES exists
 * to keep out. A cosine weight vanishes at the horizon and keeps it out by
 * construction.
 *
 * IT COSTS NOTHING, and that is a count of calls rather than a timing. Those
 * 256 directions are already evaluated and cached for the probe, so the fill
 * becomes a second reduction of a cache that already exists, while the seven
 * sky evaluations and seven cloud marches the old path ran every frame simply
 * stop. The ON arm does strictly LESS work than the OFF arm.
 *
 * DEFAULT OFF because it moves daylight — about 5 percent darker away from the
 * rings and 4 at night, and under cloud by up to 15 percent in EITHER direction,
 * because the seven-sample error there is a wander rather than a level — and
 * "daylight is bit-identical" is Part
 * A's standing clause. Off, the seven-sample path runs the identical arithmetic
 * it always did; see the byte-identity test.
 *
 * `?fibonacciAmbient=1` opens with it on; the graphics panel and
 * `tools/ab-sheet.mjs` both flip it live.
 */
const fibonacciAmbient = flag(
  typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('fibonacciAmbient') === '1',
);
export const isFibonacciAmbientEnabled = fibonacciAmbient.get;
export const setFibonacciAmbientEnabled = fibonacciAmbient.set;

// --- the two ocean switches -------------------------------------------------

/**
 * When set, the sea's rough reflection converges to a single cosine-weighted
 * average of the whole dome — the pre-probe behaviour — instead of to the
 * order-2 harmonic projection. Implemented by collapsing the probe to its own
 * l=0 term rather than by branching, so both paths run the same shader code and
 * the comparison isolates the directional bands.
 */
const flatSkyMean = flag(false);
export const isFlatSkyMean = flatSkyMean.get;
export const setFlatSkyMean = flatSkyMean.set;

/**
 * When set, the water column's backscatter goes back to the near-grey
 * (0.00105, 0.00094, 0.00112) it had before — a blue-to-red ratio of 1.07
 * against seawater's actual 3.63.
 */
const legacyWaterHue = flag(false);
export const isLegacyWaterHue = legacyWaterHue.get;
export const setLegacyWaterHue = legacyWaterHue.set;
