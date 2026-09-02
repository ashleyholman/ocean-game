import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type OceanLabCapability = SimCapability<
  | 'cameras'
  | 'clearFoam'
  | 'crestSpray'
  | 'foam'
  | 'foamAdvectionEnabled'
  | 'foamLookup'
  | 'foamLookupLegacy'
  | 'ocean'
  | 'originX'
  | 'originZ'
  | 'runFoamGainLadder'
  | 'runOceanViolenceEvidence'
  | 'runShapeLadder'
  | 'runWakeContactSheet'
  | 'runWakeWk2ContactSheet'
  | 'runWhitewaterCostBenchmark'
  | 'seaStates'
  | 'setCloudsEnabled'
  | 'setFoamAdvectionEnabled'
  | 'setFoamFrozen'
  | 'setFoamLookupLegacy'
  | 'setFoamLookupValues'
  | 'setFoamStrength'
  | 'setPresentationOrigin'
  | 'setSaltScale'
  | 'setSeaState'
  | 'hullSprayEvents'
  | 'hullSprayDensity'
  | 'setHullSprayDensityScale'
  | 'setWakeBowFeatureEnabled'
  | 'setWakeEffectsEnabled'
  | 'setWakeTrailFeatureEnabled'
  | 'sky'
  | 'wakeBowFeatureEnabled'
  | 'wakeBowPolicy'
  | 'wakeEffectsEnabled'
  | 'wakePatternPolicy'
  | 'wakeSources'
  | 'wakeSpeedThroughWaterMps'
  | 'wakeTrailFeatureEnabled'
  | 'wakeTrailPolicy'
  | 'warmFoam'
  | 'waves'
  | 'world'
>;
import { SEA_STATES } from '../ocean/presets';
import type { SeaState, SwellParams } from '../ocean/seaState';
import { cloneSeaState } from '../ocean/seaState';
import { whitecapCoverage, windSeaFromWind } from '../ocean/spectrum';
import type { SeaCouplingControl } from '../ocean/WindSeaMemory';
import type { DetailMotionMode } from '../scene/Ocean';
import {
  DERIVED_BODY_OPTICS,
  LEGACY_BODY_OPTICS,
} from '../scene/oceanOptics';
import {
  getDaylightExposureLift,
  getSkyFillScale,
  setDaylightExposureLift,
  setSkyFillScale,
} from '../scene/TimeOfDay';
import { FOAM_LOOKUP_LEGACY_JITTER_TEXELS } from '../scene/foamLookup';
import { ControlGroup, ensurePanelStyle } from '../ui/controls';
import type { DevPanel } from '../ui/DevTools';

/**
 * The ocean laboratory.
 *
 * Every meaningful sea-state control, the preset matrix, and a readout of what
 * the spectrum actually resolved to. It exists so a sea can be reasoned about
 * in physical terms — "4 m at 13 s from 200, over a 12 m/s wind that has been
 * blowing a while" — rather than by nudging amplitudes until it looks right.
 *
 * It is development-only, dynamically imported, and holds no state of its own
 * beyond the sea state it is editing: closing the panel does not reset anything
 * and reopening it shows what the world is currently doing.
 */

const CAMERA_VIEWS = [
  { value: 'production', label: 'Production' },
  { value: 'three-quarter', label: 'High three-quarter' },
  { value: 'waterline', label: 'Low waterline' },
  { value: 'crest', label: 'Close crest' },
  { value: 'overview', label: 'High overview' },
  { value: 'horizon', label: 'Wide horizon' },
];

/** Mirrors the modes documented on `Ocean.setDebugView`. */
const DEBUG_VIEWS = [
  { value: '0', label: 'Off — the ocean as drawn' },
  { value: '1', label: 'Silhouette — exact water mask' },
  { value: '2', label: 'Foam alpha' },
  { value: '3', label: 'Foam coverage' },
  { value: '4', label: 'Field — R active, G residual, B hull trail' },
  { value: '5', label: 'Near-level fade' },
];

const DETAIL_MOTION_MODES: Array<{ value: DetailMotionMode; label: string }> = [
  { value: 'directional', label: 'Directional scroll (current)' },
  { value: 'counterflow', label: 'Balanced counterflow' },
  { value: 'evolving', label: 'Evolving in place' },
];

export class OceanLab implements DevPanel {
  readonly element: HTMLDivElement;

  private readonly sim: OceanLabCapability;
  private readonly coupling: SeaCouplingControl | undefined;
  private readonly controls: ControlGroup;
  private readonly readout: HTMLPreElement;
  private wakeReadout: HTMLPreElement | undefined;
  private captureStatus: HTMLPreElement | undefined;
  private draft: SeaState;
  private presetName: string;
  private transitionSeconds = 0;
  private freezeFoam = false;
  private sprayStrength = 2.1;
  private sprayDensity = 1;
  private saltScale = 0.25;
  private accumulated = 0;

  constructor(sim: OceanLabCapability, coupling?: SeaCouplingControl) {
    this.sim = sim;
    this.coupling = coupling;
    ensurePanelStyle();

    this.draft = cloneSeaState(sim.seaStates.state);
    this.presetName = this.draft.name;

    this.element = document.createElement('div');
    this.element.className = 'devpanel';
    this.element.style.top = '12px';
    this.element.style.right = '12px';

    const heading = document.createElement('h2');
    heading.textContent = 'Ocean laboratory';
    this.element.appendChild(heading);

    this.controls = new ControlGroup(this.element);
    this.buildPresets();
    this.buildLayers();
    this.buildEnvironment();
    this.buildWind();
    this.buildSwell('Primary swell', 'primary');
    this.buildSwell('Secondary swell', 'secondary');
    this.buildSurfaceDetail();
    this.buildWaterOptics();
    this.buildWhitewater();
    this.buildWake();
    this.buildCamera();

    this.controls.section('resolved sea');
    this.readout = this.controls.readout();
  }

  // --- application ---------------------------------------------------------

  /**
   * Push the edited state to the simulation.
   *
   * Snapping is the right default for a slider: the operator is looking for
   * cause and effect, and a two-minute morph hides it. The transition control
   * is there when the question is specifically about transitions.
   */
  private apply(): void {
    this.sim.setSeaState(cloneSeaState(this.draft), this.transitionSeconds);
    if (this.transitionSeconds <= 0) this.sim.warmFoam();
  }

  private mutate(edit: (state: SeaState) => void): void {
    const next = cloneSeaState(this.draft);
    edit(next);
    this.draft = next;
    this.apply();
  }

  private mutateSwell(key: 'primary' | 'secondary', edit: (swell: SwellParams) => void): void {
    this.mutate((state) => {
      edit(state[key] as SwellParams);
    });
  }

  // --- sections ------------------------------------------------------------

  private buildPresets(): void {
    this.controls.section('sea-state presets');
    this.controls.select(
      'Preset',
      SEA_STATES.map((s) => ({ value: s.name, label: s.label })),
      this.presetName,
      (value) => {
        this.presetName = value;
        const preset = SEA_STATES.find((s) => s.name === value);
        if (!preset) return;
        this.draft = cloneSeaState(preset);
        this.apply();
        this.controls.sync();
      },
      () => this.presetName,
    );
    this.controls.slider({
      label: 'Transition',
      min: 0,
      max: 300,
      step: 5,
      value: this.transitionSeconds,
      format: (v) => (v <= 0 ? 'instant' : `${v.toFixed(0)} s`),
      onChange: (v) => {
        this.transitionSeconds = v;
      },
      read: () => this.transitionSeconds,
    });
    this.controls.buttons([
      {
        label: 'Baseline',
        title: 'Jump to the shipping production ocean for a before/after comparison',
        onClick: () => {
          this.presetName = 'CURRENT_MODERATE';
          const preset = SEA_STATES.find((s) => s.name === 'CURRENT_MODERATE')!;
          this.draft = cloneSeaState(preset);
          this.apply();
          this.controls.sync();
        },
      },
      {
        label: 'Copy JSON',
        title: 'Copy the current sea state to the clipboard',
        onClick: () => {
          void navigator.clipboard?.writeText(JSON.stringify(this.draft, null, 2));
        },
      },
    ]);
  }

  /**
   * Layer isolation.
   *
   * The four things stacked on top of each other in any composed sea, in
   * descending scale. Muting is continuous and changes nothing else: Q, the
   * breaking threshold and the detail amplitude are all derived from the whole
   * sea first, so an isolated layer is that layer exactly as it appears in the
   * full composition, not a smaller sea that happens to contain it.
   *
   * This exists because "which of these am I actually looking at?" was not
   * answerable from the panel. A slot count and an Hs cannot distinguish a
   * 62 m swell from a 33 m rider crossing it from a 2.4 m shading texture that
   * holds no slot at all — but the eye reads them as three different oceans.
   */
  private buildLayers(): void {
    this.controls.section('layer isolation — diagnostic');
    const layers = [
      { key: 'swell', label: 'Swell — carriers, sidebands, bound' },
      { key: 'riders', label: 'Riders — the crossed swell fan' },
      { key: 'windSea', label: 'Wind sea — carrier through ladder' },
      { key: 'detail', label: 'Detail shading — normals, not geometry' },
    ] as const;
    for (const { key, label } of layers) {
      this.controls.checkbox(
        label,
        this.sim.waves.layerMask[key],
        (checked) => this.sim.waves.setLayerMask({ [key]: checked }),
        () => this.sim.waves.layerMask[key],
      );
    }
    this.controls.buttons([
      {
        label: 'All',
        title: 'Restore every layer',
        onClick: () => {
          this.sim.waves.setLayerMask({
            swell: true, riders: true, windSea: true, detail: true,
          });
          this.controls.sync();
        },
      },
      ...layers.map(({ key, label }) => ({
        label: `Only ${label.split(' —')[0].toLowerCase()}`,
        title: `Mute everything except: ${label}`,
        onClick: () => {
          this.sim.waves.setLayerMask({
            swell: key === 'swell',
            riders: key === 'riders',
            windSea: key === 'windSea',
            detail: key === 'detail',
          });
          this.controls.sync();
        },
      })),
    ]);
  }

  private buildEnvironment(): void {
    this.controls.section('environment');
    this.controls.checkbox(
      'Freeze Sun, Moon and stars',
      false,
      (checked) => this.sim.world.setPaused(checked),
    );
    // Kill-switch for the whole cloud layer — dome, water reflection and haze
    // at once. Isolates cloud-reflection aliasing from every other speckle
    // source, the same way "Foam off" isolates the whitewater stack.
    this.controls.checkbox(
      'Clouds',
      true,
      (checked) => this.sim.setCloudsEnabled(checked),
    );
    this.controls.slider({
      label: 'Wave amplitude',
      min: 0,
      max: 2.5,
      step: 0.01,
      value: this.sim.waves.amplitude,
      format: (v) => `${v.toFixed(2)}×`,
      onChange: (v) => {
        this.sim.waves.amplitude = v;
        this.sim.ocean.refresh();
      },
      read: () => this.sim.waves.amplitude,
    });

    this.controls.section('diagnostic phase origin — not geography');
    const originButton = (label: string, x: number, z: number) => ({
      label,
      title: 'Presentation phase offset only. Canonical position lives in PlanetaryWorld.',
      onClick: () => {
        this.sim.setPresentationOrigin(x, z);
        this.sim.clearFoam();
        this.sim.warmFoam();
      },
    });
    this.controls.buttons([
      originButton('0', 0, 0),
      originButton('+6 km', 6000, 0),
      originButton('−6 km', -6000, 0),
    ]);
    this.controls.buttons([
      originButton('+60 km', 60000, 0),
      originButton('−60 km', -60000, 0),
      originButton('diag', 42000, -42000),
    ]);
    // The detail-noise stack repeats over exactly one wrap period, so these two
    // must be visually identical. If they are not, the wrap is wrong — which is
    // precisely the defect this round set out to fix, so the test is a button.
    this.controls.buttons([
      {
        label: 'Wrap −ε',
        title: 'Just below the detail wrap boundary',
        onClick: () => this.stepWrap(-0.01),
      },
      {
        label: 'Wrap +ε',
        title: 'Just above the detail wrap boundary — must look identical',
        onClick: () => this.stepWrap(0.01),
      },
      {
        label: '+1 wrap',
        title: 'One whole wrap period further out — must look identical',
        onClick: () => this.stepWrap(1),
      },
    ]);
  }

  /** Detail-noise wrap period, metres. Mirrors `Ocean.detailWrapPeriod`. */
  private get wrapPeriod(): number {
    return 256 * Math.max(this.draft.roughness.detailScale, 0.2);
  }

  private stepWrap(multiples: number): void {
    const period = this.wrapPeriod;
    this.sim.setPresentationOrigin(period * multiples, 0);
  }

  private buildWind(): void {
    this.controls.section('local wind');
    // DECISION D5, WHERE IT BELONGS: coupled in play, Independent in the lab.
    //
    // Every slider in this section describes the wind that GREW this sea, not
    // the wind now — the two are different quantities since WX2. Coupled, the
    // weather owns the wind and the sea chases it on a sea-like lag, so moving
    // a slider here declares "the wind is this, now" and the whole chain is
    // re-based on it (`WeatherSystem.recalibrateTo`). Independent, the weather
    // goes on doing whatever it likes to the wind while this sea stays exactly
    // where it is put — which is the only way to build a rough sea under a
    // light air and look at it.
    if (this.coupling) {
      const coupling = this.coupling;
      this.controls.select(
        'Weather coupling',
        [
          { value: 'follow', label: 'Follow weather — the sea remembers' },
          { value: 'independent', label: 'Independent — this panel decides' },
        ],
        coupling.coupled ? 'follow' : 'independent',
        (value) => coupling.setCoupled(value === 'follow'),
        () => (coupling.coupled ? 'follow' : 'independent'),
      );
    }
    // Runs past the 32 m/s validity ceiling on purpose: wave growth saturates
    // there (see `effectiveGrowthWind`) while whitecaps, streaks and spray keep
    // scaling, and the slider's top decade exists to exercise that contract.
    this.controls.slider({
      label: 'Speed',
      min: 0,
      max: 40,
      step: 0.1,
      value: this.draft.generatingWind.speedMps,
      format: (v) => `${v.toFixed(1)} m/s`,
      onChange: (v) => this.mutate((s) => { s.generatingWind.speedMps = v; }),
      read: () => this.draft.generatingWind.speedMps,
    });
    this.controls.slider({
      label: 'Direction',
      min: 0,
      max: 359,
      step: 1,
      value: this.draft.generatingWind.directionDeg,
      format: (v) => `${v.toFixed(0)}° true`,
      onChange: (v) =>
        this.mutate((s) => {
          s.generatingWind.directionDeg = v;
        }),
      read: () => this.draft.generatingWind.directionDeg,
    });
    this.controls.slider({
      label: 'Maturity (fetch)',
      min: 0,
      max: 1,
      step: 0.01,
      value: this.draft.generatingWind.maturity,
      format: (v) => `${(v * 100).toFixed(0)}%`,
      onChange: (v) => this.mutate((s) => { s.generatingWind.maturity = v; }),
      read: () => this.draft.generatingWind.maturity,
    });
    this.controls.slider({
      label: 'Gustiness',
      min: 0,
      max: 1,
      step: 0.01,
      value: this.draft.generatingWind.gustiness,
      format: (v) => v.toFixed(2),
      onChange: (v) => this.mutate((s) => { s.generatingWind.gustiness = v; }),
      read: () => this.draft.generatingWind.gustiness,
    });
    this.controls.slider({
      label: 'Wind-sea steepness',
      min: 0,
      max: 1,
      step: 0.01,
      value: this.draft.windSeaSteepness,
      format: (v) => v.toFixed(2),
      onChange: (v) => this.mutate((s) => {
        (s as { windSeaSteepness: number }).windSeaSteepness = v;
      }),
      read: () => this.draft.windSeaSteepness,
    });
  }

  private buildSwell(title: string, key: 'primary' | 'secondary'): void {
    this.controls.section(title);
    const get = (): SwellParams => this.draft[key] as SwellParams;

    this.controls.checkbox(
      'Enabled',
      get().enabled,
      (checked) => this.mutateSwell(key, (s) => { s.enabled = checked; }),
      () => get().enabled,
    );
    this.controls.slider({
      label: 'Significant height',
      min: 0,
      max: 12,
      step: 0.05,
      value: get().significantHeight,
      format: (v) => `${v.toFixed(2)} m`,
      onChange: (v) => this.mutateSwell(key, (s) => { s.significantHeight = v; }),
      read: () => get().significantHeight,
    });
    this.controls.slider({
      label: 'Peak period',
      min: 3,
      max: 22,
      step: 0.1,
      value: get().peakPeriod,
      format: (v) => `${v.toFixed(1)} s`,
      onChange: (v) => this.mutateSwell(key, (s) => { s.peakPeriod = v; }),
      read: () => get().peakPeriod,
    });
    this.controls.slider({
      label: 'Direction',
      min: 0,
      max: 359,
      step: 1,
      value: get().directionDeg,
      format: (v) => `${v.toFixed(0)}° true`,
      onChange: (v) => this.mutateSwell(key, (s) => { s.directionDeg = v; }),
      read: () => get().directionDeg,
    });
    this.controls.slider({
      label: 'Directional spread',
      min: 2,
      max: 60,
      step: 0.5,
      value: get().spreadDeg,
      format: (v) => `${v.toFixed(1)}°`,
      onChange: (v) => this.mutateSwell(key, (s) => { s.spreadDeg = v; }),
      read: () => get().spreadDeg,
    });
    this.controls.slider({
      label: 'Steepness',
      min: 0,
      max: 1,
      step: 0.01,
      value: get().steepness,
      format: (v) => v.toFixed(2),
      onChange: (v) => this.mutateSwell(key, (s) => { s.steepness = v; }),
      read: () => get().steepness,
    });
    this.controls.slider({
      label: 'Groupiness',
      min: 0,
      max: 1,
      step: 0.01,
      value: get().groupiness,
      format: (v) => `${v.toFixed(2)} (${(4.5 + 9 * v).toFixed(0)} waves/set)`,
      onChange: (v) => this.mutateSwell(key, (s) => { s.groupiness = v; }),
      read: () => get().groupiness,
    });
  }

  private buildSurfaceDetail(): void {
    this.controls.section('surface detail');
    this.controls.select(
      'Detail motion',
      DETAIL_MOTION_MODES,
      this.sim.ocean.detailMotionMode,
      (value) => {
        const mode = DETAIL_MOTION_MODES.find((candidate) => candidate.value === value)?.value;
        if (mode) this.sim.ocean.setDetailMotionMode(mode);
      },
      () => this.sim.ocean.detailMotionMode,
    );
    this.controls.slider({
      label: 'Fine roughness',
      min: 0,
      max: 2,
      step: 0.01,
      value: this.draft.roughness.fineRoughness,
      format: (v) => v.toFixed(2),
      onChange: (v) => this.mutate((s) => { s.roughness.fineRoughness = v; }),
      read: () => this.draft.roughness.fineRoughness,
    });
    this.controls.slider({
      label: 'Detail scale',
      min: 1.0,
      max: 6.0,
      step: 0.05,
      value: this.draft.roughness.detailScale,
      format: (v) => `${v.toFixed(2)} m (wrap ${(256 * v).toFixed(0)} m)`,
      onChange: (v) => this.mutate((s) => { s.roughness.detailScale = v; }),
      read: () => this.draft.roughness.detailScale,
    });
    // A gain on the derived detail amplitude, not an absolute slope — the base
    // tracks the unresolved slope band (see WaveField.detailAmplitude).
    this.controls.slider({
      label: 'Detail gain',
      min: 0,
      max: 2,
      step: 0.01,
      value: this.draft.roughness.detailStrength,
      format: (v) => `×${v.toFixed(2)}`,
      onChange: (v) => this.mutate((s) => { s.roughness.detailStrength = v; }),
      read: () => this.draft.roughness.detailStrength,
    });
    this.controls.slider({
      label: 'Gust streaks',
      min: 0,
      max: 1,
      step: 0.01,
      value: this.draft.roughness.gustStreak,
      format: (v) => v.toFixed(2),
      onChange: (v) => this.mutate((s) => { s.roughness.gustStreak = v; }),
      read: () => this.draft.roughness.gustStreak,
    });
    // Energy-neutral reshaping of the drawn detail band — the chop-character
    // A/B. Both sliders at 0 is the shipping shader exactly; neither can
    // change the sea's total roughness, only where and how it is drawn.
    this.controls.slider({
      label: 'Mid-band shift',
      min: 0,
      max: 1,
      step: 0.01,
      value: this.sim.ocean.detailShape.midShift,
      format: (v) => (v <= 0 ? 'off (pre-round)' : `${(v * 100).toFixed(0)}%`),
      onChange: (v) =>
        this.sim.ocean.setDetailShape({
          midShift: v,
          crestSkew: this.sim.ocean.detailShape.crestSkew,
        }),
      read: () => this.sim.ocean.detailShape.midShift,
    });
    this.controls.slider({
      label: 'Crest skew',
      min: 0,
      max: 1,
      step: 0.01,
      value: this.sim.ocean.detailShape.crestSkew,
      format: (v) => (v <= 0 ? 'off (pre-round)' : v.toFixed(2)),
      onChange: (v) =>
        this.sim.ocean.setDetailShape({
          midShift: this.sim.ocean.detailShape.midShift,
          crestSkew: v,
        }),
      read: () => this.sim.ocean.detailShape.crestSkew,
    });
    // How far real geometry runs below the 3.5 m floor. At 0 everything
    // shorter is shading; at 1 the floor sits near 1.1 m and the short rungs
    // are art-boosted, so the near field carries genuine displaced chop.
    this.controls.slider({
      label: 'Micro chop',
      min: 0,
      max: 1,
      step: 0.01,
      value: this.draft.roughness.microChop,
      format: (v) => v.toFixed(2),
      onChange: (v) => this.mutate((s) => { s.roughness.microChop = v; }),
      read: () => this.draft.roughness.microChop,
    });
  }

  /**
   * The body-radiance A/B and its live trims.
   *
   * "Shipping" and "Derived" apply whole value sets (see
   * DERIVED_BODY_OPTICS for the radiometry); the sliders expose each factor
   * for the eye to argue with afterwards. Everything routes through
   * Ocean.applyOptics, so the hull's reflected sea follows every change.
   */
  private buildWaterOptics(): void {
    this.controls.section('water optics — body radiance A/B');
    this.controls.buttons([
      {
        label: 'A legacy (pre-round)',
        title: 'The eye-tuned body chain this replaced: 5.6 ambient, 0.32/0.30 gains',
        onClick: () => {
          this.sim.ocean.applyOptics(LEGACY_BODY_OPTICS);
          this.controls.sync();
        },
      },
      {
        label: 'B derived (shipping)',
        title:
          'π ambient conversion, 1/Q upwelling, foam compensated, harder grazing rolloff',
        onClick: () => {
          this.sim.ocean.applyOptics(DERIVED_BODY_OPTICS);
          this.controls.sync();
        },
      },
    ]);
    const optics = (): typeof this.sim.ocean.optics => this.sim.ocean.optics;
    // The sea's own shadowing. 0 is every previous build: crest and trough
    // lit by an identical hemisphere, which is what made the near field a
    // flat wash. 1 is the derived geometry; above that is the eye's call.
    this.controls.slider({
      label: 'Wave sky occlusion',
      min: 0,
      max: 4,
      step: 0.05,
      value: this.sim.ocean.waveOcclusion,
      format: (v) =>
        v <= 0 ? 'off (pre-round)' : `×${v.toFixed(2)}${v === 1 ? ' (derived)' : ''}`,
      onChange: (v) => this.sim.ocean.setWaveOcclusion(v),
      read: () => this.sim.ocean.waveOcclusion,
    });
    // The direct "how much sky is in the water" knob. Art, not physics:
    // below 1 the water reflects less than Fresnel says. The physical version
    // of the same complaint is Grazing rolloff below, which bottoms out at
    // f90 = 0.3; this one goes to zero.
    this.controls.slider({
      label: 'Sky reflection gain',
      min: 0,
      max: 1.5,
      step: 0.05,
      value: this.sim.ocean.reflectionGain,
      format: (v) => (v === 1 ? '×1.00 (Fresnel)' : `×${v.toFixed(2)}`),
      onChange: (v) => this.sim.ocean.setReflectionGain(v),
      read: () => this.sim.ocean.reflectionGain,
    });
    // Daylight exposure lift. Ramps in with sun elevation and is exactly 1
    // at and below the horizon, so evening and night cannot be touched by it.
    this.controls.slider({
      label: 'Daylight exposure lift',
      min: 1,
      max: 3,
      step: 0.05,
      value: getDaylightExposureLift(),
      format: (v) => (v === 1 ? '×1.00 (metered only)' : `×${v.toFixed(2)} at high sun`),
      onChange: (v) => setDaylightExposureLift(v),
      read: () => getDaylightExposureLift(),
    });
    // Daylight/sunset sky radiance trim. Moves the drawn dome AND the ocean's
    // reflection together; the shared astronomical night ramp phases it back
    // to 1 once the daylight exposure lift is absent.
    this.controls.slider({
      label: 'Day sky radiance',
      min: 0.3,
      max: 1.6,
      step: 0.02,
      value: this.sim.sky.uniforms.uSkyGainTrim.value as number,
      format: (v) => (v === 1 ? '×1.00 (as modelled)' : `×${v.toFixed(2)}`),
      onChange: (v) => { this.sim.sky.uniforms.uSkyGainTrim.value = v; },
      read: () => this.sim.sky.uniforms.uSkyGainTrim.value as number,
    });
    // Key-to-fill. This is a WHOLE-SCENE daylight control, not an ocean one —
    // it is here because this is the panel the look is being judged from.
    // 1.0 is the flat, overcast-reading daylight; 0.6 lands near a clear day's
    // 8:1. The night ramp restores 1 without changing this authored day value.
    this.controls.slider({
      label: 'Day sky fill (key:fill)',
      min: 0.2,
      max: 1.5,
      step: 0.05,
      value: getSkyFillScale(),
      format: (v) => `×${v.toFixed(2)}  (ratio ≈ ${(4.83 / Math.max(v, 0.01)).toFixed(1)}:1)`,
      onChange: (v) => setSkyFillScale(v),
      read: () => getSkyFillScale(),
    });
    // The far-field washout control: how much the sea's own roughness lifts
    // the grazing incidence angle. 0 is the old plain-Schlick sky mirror.
    this.controls.slider({
      label: 'Grazing roughness lift',
      min: 0,
      max: 3,
      step: 0.05,
      value: this.sim.ocean.grazingSlopeLift,
      format: (v) => (v <= 0 ? 'off (sky-mirror distance)' : `×${v.toFixed(2)}`),
      onChange: (v) => this.sim.ocean.setGrazingSlopeLift(v),
      read: () => this.sim.ocean.grazingSlopeLift,
    });
    // The spread between the sea's darkest and lightest tones. Hue-preserving.
    this.controls.slider({
      label: 'Water contrast',
      min: 0.5,
      max: 2.5,
      step: 0.05,
      value: this.sim.ocean.waterContrast,
      format: (v) => (v === 1 ? '×1.00 (off)' : `γ ${v.toFixed(2)}`),
      onChange: (v) => this.sim.ocean.setWaterContrast(v),
      read: () => this.sim.ocean.waterContrast,
    });
    // Sparkle: variance restored to a term that only ever drew its mean.
    this.controls.slider({
      label: 'Sun sparkle',
      min: 0,
      max: 2.5,
      step: 0.05,
      value: this.sim.ocean.sparkleStrength,
      format: (v) => (v <= 0 ? 'off (plain GGX mean)' : `σ ${v.toFixed(2)}`),
      onChange: (v) => this.sim.ocean.setSparkleStrength(v),
      read: () => this.sim.ocean.sparkleStrength,
    });
    // How much a reflection aimed below the horizon loses. 0 restores the old
    // fold, which handed those rays the bright horizon band.
    this.controls.slider({
      label: 'Below-horizon block',
      min: 0,
      max: 1,
      step: 0.05,
      value: this.sim.ocean.horizonBlock,
      format: (v) => (v <= 0 ? 'off (old fold)' : `${(v * 100).toFixed(0)}%`),
      onChange: (v) => this.sim.ocean.setHorizonBlock(v),
      read: () => this.sim.ocean.horizonBlock,
    });
    this.controls.slider({
      label: 'Ambient gain',
      min: 1,
      max: 8,
      step: 0.05,
      value: optics().ambientIrradianceGain,
      format: (v) => `${v.toFixed(2)} (π=3.14 shipping, legacy 5.6)`,
      onChange: (v) => this.sim.ocean.applyOptics({ ambientIrradianceGain: v }),
      read: () => optics().ambientIrradianceGain,
    });
    this.controls.slider({
      label: 'Body sky gain',
      min: 0,
      max: 0.6,
      step: 0.005,
      value: optics().bodySkyGain,
      format: (v) => `${v.toFixed(3)} (1/Q=0.25 shipping, legacy 0.32)`,
      onChange: (v) => this.sim.ocean.applyOptics({ bodySkyGain: v }),
      read: () => optics().bodySkyGain,
    });
    this.controls.slider({
      label: 'Body sun gain',
      min: 0,
      max: 0.6,
      step: 0.005,
      value: optics().bodySunGain,
      format: (v) => `${v.toFixed(3)} (1/Q=0.25 shipping, legacy 0.30)`,
      onChange: (v) => this.sim.ocean.applyOptics({ bodySunGain: v }),
      read: () => optics().bodySunGain,
    });
    this.controls.slider({
      label: 'Grazing rolloff',
      min: 0,
      max: 1,
      step: 0.01,
      value: optics().grazingRolloff,
      format: (v) => `${v.toFixed(2)} (shipping 0.68, legacy 0.55)`,
      onChange: (v) => this.sim.ocean.applyOptics({ grazingRolloff: v }),
      read: () => optics().grazingRolloff,
    });
    this.controls.slider({
      label: 'Foam sky gain',
      min: 0,
      max: 1.2,
      step: 0.01,
      value: optics().foamSkyGain,
      format: (v) => `${v.toFixed(2)} (shipping 0.10, legacy 0.42)`,
      onChange: (v) => this.sim.ocean.applyOptics({ foamSkyGain: v }),
      read: () => optics().foamSkyGain,
    });
  }

  private buildWhitewater(): void {
    this.controls.section('whitewater');
    this.controls.slider({
      label: 'Threshold bias',
      min: -1,
      max: 1,
      step: 0.01,
      value: this.draft.whitewater.thresholdBias,
      format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}σ`,
      onChange: (v) => this.mutate((s) => { s.whitewater.thresholdBias = v; }),
      read: () => this.draft.whitewater.thresholdBias,
    });
    this.controls.slider({
      label: 'Generation',
      min: 0,
      max: 3,
      step: 0.01,
      value: this.draft.whitewater.generation,
      format: (v) => v.toFixed(2),
      onChange: (v) => this.mutate((s) => { s.whitewater.generation = v; }),
      read: () => this.draft.whitewater.generation,
    });
    this.controls.slider({
      label: 'Persistence',
      min: 0.5,
      max: 40,
      step: 0.5,
      value: this.draft.whitewater.persistenceSeconds,
      format: (v) => `${v.toFixed(1)} s`,
      onChange: (v) => this.mutate((s) => { s.whitewater.persistenceSeconds = v; }),
      read: () => this.draft.whitewater.persistenceSeconds,
    });
    this.controls.slider({
      label: 'Breakup',
      min: 0,
      max: 1,
      step: 0.01,
      value: this.draft.whitewater.breakup,
      format: (v) => v.toFixed(2),
      onChange: (v) => this.mutate((s) => { s.whitewater.breakup = v; }),
      read: () => this.draft.whitewater.breakup,
    });
    this.controls.slider({
      label: 'Wind advection',
      min: 0,
      max: 0.2,
      step: 0.001,
      value: this.draft.whitewater.windAdvection,
      format: (v) => `${(v * 100).toFixed(1)}% of wind`,
      onChange: (v) => this.mutate((s) => { s.whitewater.windAdvection = v; }),
      read: () => this.draft.whitewater.windAdvection,
    });
    this.controls.slider({
      label: 'Spray intensity',
      min: 0,
      max: 2,
      step: 0.01,
      value: this.draft.whitewater.sprayIntensity,
      format: (v) => v.toFixed(2),
      onChange: (v) => this.mutate((s) => { s.whitewater.sprayIntensity = v; }),
      read: () => this.draft.whitewater.sprayIntensity,
    });
    // The scale from the field's density units to rendered coverage. Not a
    // preset field: it is one number for the whole ocean, and it is here rather
    // than baked in because the value it replaced was calibrated against a
    // persistent field that the lookup was fading to nothing.
    this.controls.slider({
      label: 'Coverage gain',
      min: 0,
      max: 4,
      step: 0.05,
      value: this.sim.ocean.foamCoverageGain,
      format: (v) => `×${v.toFixed(2)}`,
      onChange: (v) => this.sim.ocean.setFoamCoverageGain(v),
      read: () => this.sim.ocean.foamCoverageGain,
    });
    // Eyeball-only control. Whether the advection resample is what makes the
    // far field shimmer is a question about motion, and the still frames and
    // pixel statistics that answered every other question in this round are
    // both blind to it.
    this.controls.checkbox(
      'Foam advection (drift downwind)',
      this.sim.foamAdvectionEnabled(),
      (checked) => this.sim.setFoamAdvectionEnabled(checked),
      () => this.sim.foamAdvectionEnabled(),
    );
    this.controls.checkbox(
      'Freeze foam history',
      this.freezeFoam,
      (checked) => {
        this.freezeFoam = checked;
        this.sim.setFoamFrozen(checked);
      },
      () => this.freezeFoam,
    );
    this.controls.buttons([
      { label: 'Clear foam', onClick: () => this.sim.clearFoam() },
      { label: 'Warm up', onClick: () => this.sim.warmFoam() },
      { label: 'Foam off', onClick: () => this.sim.setFoamStrength(0) },
      { label: 'Foam on', onClick: () => this.sim.setFoamStrength(1) },
    ]);

    // --- storm spray ----------------------------------------------------
    // Both of these are look decisions on a system whose failure modes are
    // only visible in motion — a still cannot tell a streaming veil from a
    // blob sliding across the water — so they are live controls rather than
    // constants somebody tunes by rebuilding.
    this.controls.section('storm spray');
    this.controls.checkbox(
      'Crest spray',
      this.sim.crestSpray.enabled,
      (checked) => {
        this.sim.crestSpray.enabled = checked;
        if (!checked) this.sim.crestSpray.clear();
      },
      () => this.sim.crestSpray.enabled,
    );
    this.controls.slider({
      label: 'Spray brightness',
      min: 0,
      max: 3,
      step: 0.05,
      value: this.sprayStrength,
      format: (v) => `×${v.toFixed(2)}`,
      onChange: (v) => {
        this.sprayStrength = v;
        this.sim.crestSpray.setStrength(v);
      },
      read: () => this.sprayStrength,
    });
    // Airborne salt loading, as a multiple of SALT_DENSITY_FULL. Zero is the
    // regression guard: the layer must be able to leave the frame completely.
    this.controls.slider({
      label: 'Salt loading',
      min: 0,
      max: 4,
      step: 0.05,
      value: this.saltScale,
      format: (v) => `×${v.toFixed(2)}`,
      onChange: (v) => {
        this.saltScale = v;
        this.sim.setSaltScale(v);
      },
      read: () => this.saltScale,
    });
    // A multiplier on a derived value, not the value itself. How much the sea
    // sheds is set by how many metres of crest are actually breaking and how
    // hard — this scales that answer rather than replacing it, so a change of
    // sea state still moves the spray on its own. There is deliberately no
    // duration control any more: shedding follows the live breaking indicator,
    // so a crest starts and stops on its own physics.
    this.controls.slider({
      label: 'Shed density',
      min: 0,
      max: 3,
      step: 0.05,
      value: this.sprayDensity,
      format: (v) => `×${v.toFixed(2)}`,
      onChange: (v) => {
        this.sprayDensity = v;
        this.sim.crestSpray.setDensity(v);
      },
      read: () => this.sprayDensity,
    });


    this.controls.section('whitewater diagnostics');
    this.controls.select(
      'Debug view',
      DEBUG_VIEWS,
      String(this.sim.ocean.debugView),
      (value) => this.sim.ocean.setDebugView(Number(value)),
      () => String(this.sim.ocean.debugView),
    );
    this.controls.buttons([
      {
        label: 'Evidence sheet',
        title: 'Five seas x four views, photographed and measured',
        onClick: () => {
          void this.runCapture('violence', (report) =>
            this.sim.runOceanViolenceEvidence('ocean-violence', report),
          );
        },
      },
      {
        label: 'Gain ladder',
        title: 'The same four conditions at five foam coverage gains',
        onClick: () => {
          void this.runCapture('gain ladder', (report) => this.sim.runFoamGainLadder(report));
        },
      },
      {
        label: 'Shape ladder',
        title: "Five levers of the ocean's shape, five rungs each",
        onClick: () => {
          void this.runCapture('shape ladder', (report) => this.sim.runShapeLadder(report));
        },
      },
      {
        label: 'Cost A/B',
        title: 'GPU cost of the whitewater layer being drawn, bracketed A-B-B-A',
        onClick: () => {
          void this.runCapture('whitewater cost', async (report) => {
            const text = await this.sim.runWhitewaterCostBenchmark(report);
            report(text);
          });
        },
      },
    ]);
    this.captureStatus = this.controls.readout();
  }

  /**
   * Run a capture and report where it got to.
   *
   * These take seconds and hold the render loop, so silence while one runs
   * looks exactly like a hang.
   */
  private async runCapture(
    what: string,
    run: (onProgress: (report: string) => void) => Promise<unknown>,
  ): Promise<void> {
    const status = this.captureStatus;
    if (!status) return;
    status.textContent = `${what}: starting…`;
    let last = '';
    try {
      await run((report) => {
        last = report;
        status.textContent = report;
      });
      // The benchmarks' last progress call is their result, so keep it rather
      // than overwriting a table of timings with "done".
      status.textContent = last || `${what}: complete`;
    } catch (error) {
      status.textContent = `${what} failed: ${String(error)}`;
    }
  }

  /** WK1/WK2 controls plus the source instrumentation retained from WK0. */
  private buildWake(): void {
    this.controls.section('hull wake — trail · full waterline · wet hull');
    this.controls.checkbox(
      'Wake effects master',
      this.sim.wakeEffectsEnabled(),
      (checked) => this.sim.setWakeEffectsEnabled(checked),
      () => this.sim.wakeEffectsEnabled(),
    );
    const feature = (
      label: string,
      name: Parameters<OceanLabCapability['setWakeTrailFeatureEnabled']>[0],
    ): void => {
      this.controls.checkbox(
        label,
        this.sim.wakeTrailFeatureEnabled(name),
        (checked) => this.sim.setWakeTrailFeatureEnabled(name, checked),
        () => this.sim.wakeTrailFeatureEnabled(name),
      );
    };
    feature('Stern R/G/B injection', 'injection');
    feature('Pale bubble haze', 'bubbleHaze');
    feature('Suppress ambient breaks', 'whitecapSuppression');
    feature('Trail foam floor (B flecks)', 'trailFoamFloor');
    const bowFeature = (
      label: string,
      name: Parameters<OceanLabCapability['setWakeBowFeatureEnabled']>[0],
    ): void => {
      this.controls.checkbox(
        label,
        this.sim.wakeBowFeatureEnabled(name),
        (checked) => this.sim.setWakeBowFeatureEnabled(name, checked),
        () => this.sim.wakeBowFeatureEnabled(name),
      );
    };
    bowFeature('Hull waterline R/G/B', 'collar');
    bowFeature('Resolved wet hull band', 'wetHull');
    bowFeature('Bow normal mound candidate', 'bowMound');
    bowFeature('Ship wave pattern', 'wavePattern');
    bowFeature('Bow-only entry spray (WK3 events)', 'entrySpray');
    this.controls.slider({
      label: 'Bow-entry spray density',
      min: 0,
      max: 4,
      step: 0.1,
      value: this.sim.hullSprayDensity(),
      format: (v) => `×${v.toFixed(1)} (bow only)`,
      onChange: (v) => this.sim.setHullSprayDensityScale(v),
      read: () => this.sim.hullSprayDensity(),
    });

    // Not a wake switch — this lookup serves every whitecap in the sea — but it
    // lives here because the wake is where its failure is legible, and because
    // judging it means watching a trail that is already on the water.
    this.controls.section('foam lookup — reconstruction A/B (all foam, not just the wake)');
    this.controls.checkbox(
      'Legacy 0.9-texel sample jitter',
      this.sim.foamLookupLegacy(),
      (checked) => this.sim.setFoamLookupLegacy(checked),
      () => this.sim.foamLookupLegacy(),
    );
    this.controls.slider({
      label: 'Sample jitter',
      min: 0,
      max: FOAM_LOOKUP_LEGACY_JITTER_TEXELS,
      step: 0.05,
      value: this.sim.foamLookup.jitterTexels,
      format: (v) =>
        `${v.toFixed(2)} texel (${(v * this.sim.foam.nearTexelSizeM).toFixed(2)} m)`,
      onChange: (v) =>
        this.sim.setFoamLookupValues(v, this.sim.foamLookup.smoothing),
      read: () => this.sim.foamLookup.jitterTexels,
    });
    this.controls.slider({
      label: 'Texel-fraction warp',
      min: 0,
      max: 1,
      step: 0.05,
      value: this.sim.foamLookup.smoothing,
      format: (v) =>
        v === 0 ? 'plain bilinear' : `${v.toFixed(2)} of quintic`,
      onChange: (v) =>
        this.sim.setFoamLookupValues(this.sim.foamLookup.jitterTexels, v),
      read: () => this.sim.foamLookup.smoothing,
    });
    this.controls.buttons([
      {
        label: 'WK1 A/B sheet',
        title:
          'Three polar reference seas, cinematic and embodied-aft, with component subtraction columns',
        onClick: () => {
          void this.runCapture('wake WK1 sheet', (report) =>
            this.sim.runWakeContactSheet(report),
          );
        },
      },
      {
        label: 'WK2 A/B sheet',
        title:
          'Three polar reference seas, embodied-bow first, with collar / wet-band / mound subtraction columns',
        onClick: () => {
          void this.runCapture('wake WK2 sheet', (report) =>
            this.sim.runWakeWk2ContactSheet(report),
          );
        },
      },
    ]);
    this.wakeReadout = this.controls.readout();
  }

  private buildCamera(): void {
    this.controls.section('camera');
    this.controls.select(
      'View',
      CAMERA_VIEWS,
      'production',
      (value) => this.applyCamera(value),
    );
  }

  /**
   * Diagnostic viewpoints.
   *
   * These move the production camera rather than building a second one. The
   * camera round made that literal: the request is expressed as a distance and
   * an altitude, and `CameraSystem` solves the cinematic scale and elevation
   * that produce them. Its sea-clearance clamp applies, so a viewpoint asked
   * for below the local crests is raised to clear them; genuine waterline
   * inspection belongs to the buoyancy lab's dedicated cameras.
   */
  private applyCamera(view: string): void {
    const views: Record<string, [number, number]> = {
      // distance from the raft, altitude above mean water
      'three-quarter': [26, 14],
      waterline: [9, 0.9],
      crest: [5.5, 1.6],
      overview: [90, 62],
      horizon: [34, 3.4],
      production: [34, 11],
    };
    const [distance, altitude] = views[view] ?? views.production;
    this.sim.cameras.setMode('cinematic');
    this.sim.cameras.setDiagnosticView(distance, altitude);
  }

  // --- readout -------------------------------------------------------------

  update(dtSeconds: number): void {
    this.accumulated += dtSeconds;
    if (this.accumulated < 0.15) return;
    this.accumulated = 0;
    this.controls.sync();

    const waves = this.sim.waves;
    const sea = this.sim.seaStates.state;
    const windSea = windSeaFromWind(
      sea.generatingWind.speedMps,
      sea.generatingWind.maturity,
    );
    const controller = this.sim.seaStates;

    const muted = (Object.keys(waves.layerMask) as Array<keyof typeof waves.layerMask>)
      .filter((k) => !waves.layerMask[k]);

    const lines = [
      `sea          ${sea.name}`,
      `purpose ${sea.purpose}`,
      // Loud, because every number below it is the whole sea's, not the
      // muted sea's — the mute is applied after they are derived.
      ...(muted.length ? [`MUTED        ${muted.join(', ')}`] : []),
      controller.transitioning
        ? `transition   ${(controller.progress * 100).toFixed(0)}% -> ${controller.target.name}`
        : 'transition   settled',
      '',
      `Hs combined  ${waves.significantHeight.toFixed(2)} m`,
      `max crest    ${waves.amplitudeSum.toFixed(2)} m (sum of amplitudes)`,
      `dominant Tp  ${waves.dominantPeriod.toFixed(2)} s`,
      `longest      ${waves.longestWavelength.toFixed(1)} m`,
      `components   ${waves.count} of 48`,
      '',
      `wind sea     Hs ${windSea.significantHeight.toFixed(2)} m  Tp ${windSea.peakPeriod.toFixed(2)} s`,
      `mean sq slope ${waves.meanSquareSlope.toFixed(4)} (unresolved ${waves.unresolvedSlopeVariance.toFixed(4)})`,
      `global Q     ${waves.globalQ.toFixed(3)}`,
      `sum(QAk)     ${waves.steepnessSum.toFixed(3)}  (folds above 1)`,
      `break at J   ${waves.breakingThreshold.toFixed(3)}`,
      `whitecap W   ${(whitecapCoverage(sea.generatingWind.speedMps) * 100).toFixed(2)}%`,
      '',
      `phase origin ${this.sim.originX().toFixed(0)}, ${this.sim.originZ().toFixed(0)} m (not geography)`,
      `detail wrap  ${this.wrapPeriod.toFixed(1)} m`,
      `detail motion ${this.sim.ocean.detailMotionMode}`,
      `foam drift   ${this.sim.foam.drift.x.toFixed(1)}, ${this.sim.foam.drift.y.toFixed(1)} m (advects the field)`,
      `foam window  ${this.sim.foam.nearOrigin.x.toFixed(2)}, ${this.sim.foam.nearOrigin.y.toFixed(2)} m (sub-texel remainder; must stay on the observer)`,
      `foam gain    ×${this.sim.ocean.foamCoverageGain.toFixed(2)}`,
      `foam memory  ${(this.sim.foam.memoryBytes / 1048576).toFixed(2)} MB`,
      `spray live   ${this.sim.crestSpray.activeCount} in ${this.sim.crestSpray.tearCount} tears`,
      `solve resid  ${waves.lastSolveResidual.toExponential(2)} m`,
    ];
    this.readout.textContent = lines.join('\n');

    const wakeReadout = this.wakeReadout;
    if (wakeReadout) {
      const sources = this.sim.wakeSources;
      const stern = sources.sternWaterline;
      const sternWidth = stern.active
        ? Math.hypot(
            stern.port.x - stern.starboard.x,
            stern.port.y - stern.starboard.y,
            stern.port.z - stern.starboard.z,
          )
        : 0;
      const regionLine = (name: 'bow' | 'midships' | 'stern'): string => {
        const value = sources.regions[name];
        return `${name.padEnd(8)} wet ${String(value.wetStationCount).padStart(2)}  ` +
          `wl ${String(value.waterlinePointCount).padStart(2)}  ` +
          `entry ${value.meanEntrySpeedMps.toFixed(2)} / ${value.peakEntrySpeedMps.toFixed(2)} m/s`;
      };
      const policy = this.sim.wakeTrailPolicy;
      const bowPolicy = this.sim.wakeBowPolicy;
      const patternPolicy = this.sim.wakePatternPolicy;
      const sprayEvents = this.sim.hullSprayEvents;
      const sprayPolicy = sprayEvents.policy;
      wakeReadout.textContent = [
        `master   ${this.sim.wakeEffectsEnabled() ? 'ON' : 'off'}`,
        `speed    ${this.sim.wakeSpeedThroughWaterMps().toFixed(2)} m/s through water`,
        stern.active
          ? `stern    station ${stern.stationIndex} · ${sternWidth.toFixed(2)} m segment`
          : 'stern    no complete waterline segment',
        `bow      ${sources.bowWaterlinePointCount} active points`,
        regionLine('bow'),
        regionLine('midships'),
        regionLine('stern'),
        `trail    R ${policy.activeFoamRatePerSecond.toFixed(2)}  ` +
          `G ${policy.residualFoamRatePerSecond.toFixed(2)}  ` +
          `B ${policy.turbulenceRatePerSecond.toFixed(2)} /s`,
        `shape    radius ${policy.sourceRadiusM.toFixed(2)} m  ` +
          `tau ${policy.turbulenceTauSeconds.toFixed(1)} s  ` +
          `sea mask ${(policy.seaMask * 100).toFixed(0)}%`,
        `collar   drive ${bowPolicy.collarDrive.toFixed(2)}  ` +
          `R ${bowPolicy.activeFoamRatePerSecond.toFixed(2)}  ` +
          `G ${bowPolicy.residualFoamRatePerSecond.toFixed(2)}  ` +
          `B ${bowPolicy.turbulenceRatePerSecond.toFixed(2)} /s`,
        `bow shape radius ${bowPolicy.sourceRadiusM.toFixed(2)} m  ` +
          `track tear ${bowPolicy.tearLengthM.toFixed(2)} m  ` +
          `mound ${bowPolicy.moundNormalStrength.toFixed(3)}`,
        `wet hull ${sources.resolvedWaterlineStationCount} resolved cuts  ` +
          `${bowPolicy.wetBandHeightM.toFixed(2)} m band`,
        `pattern  λ ${patternPolicy.wavelengthM.toFixed(1)} m  ` +
          `slope ${patternPolicy.normalStrength.toFixed(3)}  ` +
          `wedge ${patternPolicy.wedgeLengthM.toFixed(0)} m`,
        `overtop  ${sources.activeOvertopEventCount} active events`,
        // WK3. The drive against its own threshold is the only readout that
        // answers "why did nothing happen just then", which is the question
        // an episodic effect always raises.
        `entry    drive ${sprayPolicy.entryDrive.toFixed(2)} of ` +
          `${sprayPolicy.armThreshold.toFixed(2)}  ` +
          `way ${(sprayPolicy.wayGate * 100).toFixed(0)}%  ` +
          `${sprayPolicy.entryPowerW.toFixed(0)} W`,
        `tears    ${sprayEvents.eventCount} opened  ` +
          `${sprayEvents.tearIsOpen ? 'SHEDDING' : 'idle'}  ` +
          `dV/dt ${sprayEvents.bowImmersionRateM3PerSec.toFixed(1)} m3/s  ` +
          `density ×${this.sim.hullSprayDensity().toFixed(1)}  ` +
          `ceiling ${sprayPolicy.eventCeilingPerSecond.toFixed(2)}/s`,
      ].join('\n');
    }
  }

  dispose(): void {
    this.element.remove();
  }
}

export function createOceanLab(
  sim: OceanLabCapability,
  coupling?: SeaCouplingControl,
): DevPanel {
  return new OceanLab(sim, coupling);
}
