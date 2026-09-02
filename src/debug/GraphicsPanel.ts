import type * as THREE from 'three';
import type {
  OceanDetailContactSheet,
  OceanDetailContactSheetSet,
  OceanDetailContactSheetView,
  SimCapability,
} from '../runtime/diagnostics/SimHandle';

export type GraphicsPanelCapability = SimCapability<
  | 'lighting'
  | 'ocean'
  | 'oceanTemporalEnabled'
  | 'oceanTemporalStability'
  | 'refreshLighting'
  | 'renderer'
  | 'runOceanCloudHazeContactSheet'
  | 'runOceanDetailBenchmark'
  | 'runOceanDetailCategoryMatrix'
  | 'runOceanDetailCategoryProbe'
  | 'runOceanDetailContactSheet'
  | 'runOceanDetailRepresentationBenchmark'
  | 'runOceanProfileProbe'
  | 'runOceanResidualActiveBenchmark'
  | 'runOceanResidualCategoryMatrix'
  | 'runOceanResidualCategoryProbe'
  | 'runOceanResidualDiff'
  | 'setOceanTemporalEnabled'
  | 'setOceanTemporalStability'
  | 'setSkyRadianceLutEnabled'
  | 'setSunShadowStrength'
  | 'sky'
  | 'stars'
  | 'sunShadowStrength'
  | 'vessel'
>;
import type { LampMode } from '../scene/Lamp';
import type {
  OceanDetailRepresentation,
  OceanResidualLoopMode,
} from '../scene/Ocean';
import { MILKY_WAY_MEASURED_GAIN } from '../scene/MilkyWay';
import {
  STAR_ANCHOR_INTENSITY,
  STAR_ANCHOR_MAGNITUDE,
  STAR_LEGACY_CLOUD_BEAM_POWER,
  STAR_LEGACY_MAGNITUDE_EXPONENT,
  STAR_MAGNITUDE_EXPONENT,
} from '../scene/StarField';
import { ControlGroup, ensurePanelStyle } from '../ui/controls';
import {
  WORLD_DEBUG_VIEWS,
  getPortalSkySource,
  getWorldDebugStops,
  getWorldDebugView,
  setPortalSkySource,
  setWorldDebugStops,
  setWorldDebugView,
} from '../scene/WorldPbrMaterial';
import type { WorldDebugView } from '../scene/WorldPbrMaterial';
import {
  isFibonacciAmbientEnabled,
  isFlatSkyMean,
  isChromaTrimDisabled,
  isLegacyExposure,
  isLegacySkyHue,
  isLegacyToneCurve,
  isLegacyWaterHue,
  isSunDomeMeanEnabled,
  setFibonacciAmbientEnabled,
  setFlatSkyMean,
  setChromaTrimDisabled,
  setLegacyExposure,
  setLegacySkyHue,
  setLegacyToneCurve,
  setLegacyWaterHue,
  setSunDomeMeanEnabled,
} from '../scene/colourPipeline';
import {
  rodDominance,
  scotopicStrength,
  setScotopicStrength,
} from '../scene/scotopic';
import type { DevPanel } from '../ui/DevTools';
import type {
  AdaptationTuning,
  InteriorAdaptationMode,
} from '../vessel/schooner/Schooner';

/**
 * The slice of the schooner the adaptation dials drive. Duck-typed off the
 * vessel rather than imported as the class: the panel serves any vessel, and
 * a raft without a metered eye simply gets no section.
 */
interface AdaptationControls {
  readonly adaptationTuning: AdaptationTuning;
  setAdaptationMode(mode: InteriorAdaptationMode): void;
  adaptationDebug(): {
    mode: InteriorAdaptationMode;
    meter: number | null;
    gainTarget: number;
    gain: number;
  };
  /** Present on vessels that carry the room-lift mode's per-room dials. */
  setRoomLift?(room: string, lift: number): void;
  roomLifts?(): Record<string, number>;
}

function adaptationControlsOf(vessel: unknown): AdaptationControls | null {
  const candidate = vessel as Partial<AdaptationControls>;
  return typeof candidate.setAdaptationMode === 'function' &&
    typeof candidate.adaptationDebug === 'function' &&
    candidate.adaptationTuning !== undefined
    ? (candidate as AdaptationControls)
    : null;
}

/**
 * The slice of the schooner the lanterns-below rows drive. Duck-typed for the
 * same reason as `AdaptationControls`: a vessel without lamps below simply
 * gets no section. One policy drives all rooms' lamps — per-lamp control is
 * the player's own Space action at the lamp.
 */
interface InteriorLampControls {
  setLampsMode(mode: 'auto' | 'on' | 'off'): void;
  setLampsIntensity(scale: number): void;
  setLampsShadow(enabled: boolean): void;
  interiorLampOf(room: string): {
    mode: 'auto' | 'on' | 'off';
    intensityScale: number;
    readonly shadowEnabled: boolean;
  } | null;
}

function interiorLampControlsOf(vessel: unknown): InteriorLampControls | null {
  const candidate = vessel as Partial<InteriorLampControls>;
  return typeof candidate.setLampsMode === 'function' &&
    typeof candidate.interiorLampOf === 'function'
    ? (candidate as InteriorLampControls)
    : null;
}

/**
 * The graphics panel: atmosphere, exposure, ocean optics, stars, moon, lamp.
 *
 * Presentation-only by construction. Everything here multiplies or biases a
 * quantity that is derived downstream of the canonical world — nothing can
 * write back into ECEF state, UTC or the world clock, and the world-state
 * isolation test holds the panel to that.
 */

/** Live multipliers the render loop reads every frame, panel open or not. */
export interface GraphicsState {
  sunMultiplier: number;
  ambientMultiplier: number;
  /** Added to the derived limiting magnitude before the stars read it. */
  starLimitBias: number;
}

export class GraphicsPanel implements DevPanel {
  readonly element: HTMLDivElement;
  readonly state: GraphicsState = {
    sunMultiplier: 1,
    ambientMultiplier: 1,
    starLimitBias: 0,
  };

  private readonly controls: ControlGroup;
  private readonly readout: HTMLPreElement;
  private readonly oceanProfileReadout: HTMLPreElement;
  private readonly sim: GraphicsPanelCapability;
  private contactSheetDialog: HTMLDialogElement | null = null;
  private accumulated = 0;
  private adaptation: AdaptationControls | null = null;
  private adaptationReadout: HTMLPreElement | null = null;
  /** Slider rows shown only in 'room-lift' mode. */
  private readonly adaptationLiftFields: HTMLElement[] = [];
  /** Slider rows for the camera modes' meter, hidden under 'room-lift'. */
  private readonly adaptationCameraFields: HTMLElement[] = [];

  constructor(sim: GraphicsPanelCapability) {
    this.sim = sim;
    ensurePanelStyle();

    this.element = document.createElement('div');
    this.element.className = 'devpanel';
    this.element.style.top = '12px';
    this.element.style.right = '12px';

    const heading = document.createElement('h2');
    heading.textContent = 'Graphics · clear-sky profile';
    this.element.appendChild(heading);

    this.controls = new ControlGroup(this.element);
    const u = sim.ocean.material.uniforms;

    // A/B SCAFFOLDING — remove with scene/colourPipeline.ts once the colour
    // pipeline is settled. Six independent switches: the pre-round look was
    // four changes at once, and flipped together they move different parts of
    // the picture in different directions, so they are judged apart.
    this.controls.section('colour pipeline (A/B)');
    const legacySwitch = (
      label: string,
      read: () => boolean,
      write: (value: boolean) => void,
      after?: () => void,
    ): void => {
      this.controls.checkbox(
        label,
        read(),
        (checked) => {
          write(checked);
          // Snap the meter rather than letting it glide over its 4 s
          // adaptation: an A/B you have to wait out is an A/B you cannot see.
          sim.refreshLighting();
          after?.();
        },
        read,
      );
    };
    legacySwitch('Legacy tone curve (ACES)', isLegacyToneCurve, setLegacyToneCurve);
    legacySwitch('Legacy exposure (0.335 daylight plateau)', isLegacyExposure, setLegacyExposure);
    legacySwitch('Sky chroma trim OFF (×1.0)', isChromaTrimDisabled, setChromaTrimDisabled);
    legacySwitch('Legacy sky hue (hand-fitted)', isLegacySkyHue, setLegacySkyHue);
    legacySwitch(
      'Sun dome-mean fill (fixes the 26 deg spike)',
      isSunDomeMeanEnabled,
      setSunDomeMeanEnabled,
    );
    legacySwitch(
      'Fibonacci ambient fill (256 dirs, no rings)',
      isFibonacciAmbientEnabled,
      setFibonacciAmbientEnabled,
    );
    legacySwitch('Flat sky mean (pre-probe reflection)', isFlatSkyMean, setFlatSkyMean);
    legacySwitch('Legacy water hue (flat backscatter)', isLegacyWaterHue, setLegacyWaterHue, () =>
      sim.ocean.publishWaterBodyColour(),
    );

    // The observer, not the display. Live rather than a page-load switch,
    // because a legibility judgement needs both sides in one session — and
    // unlike the toe this only moves a uniform, so no compiled program is
    // left running the other version of it. See scene/scotopic.ts.
    this.controls.slider({
      label: 'Scotopic vision (optional)',
      min: 0,
      max: 1,
      step: 0.05,
      value: scotopicStrength(),
      format: (v) => (v <= 0 ? 'off' : `${(v * 100).toFixed(0)}%`),
      onChange: (v) => setScotopicStrength(v),
    });

    this.controls.section('lighting balance');
    this.controls.slider({
      label: 'Direct sun ×',
      min: 0,
      max: 3,
      step: 0.05,
      value: 1,
      format: (v) => `${v.toFixed(2)}×`,
      onChange: (v) => {
        this.state.sunMultiplier = v;
      },
    });
    // Scales the world probe — BOTH halves of it, diffuse and specular
    // together. Diagnostic only, and the coupling is the point: the failure
    // this pipeline replaced was a single scalar that drove fill and reflection
    // as if they were independent look controls. A gain that moves them
    // together is asking "is there enough indirect light"; one that moves only
    // the fill is just re-creating the bug with a nicer label.
    this.controls.slider({
      label: 'World probe × (diag)',
      min: 0,
      max: 3,
      step: 0.05,
      value: 1,
      format: (v) => `${v.toFixed(2)}×`,
      onChange: (v) => {
        this.state.ambientMultiplier = v;
      },
    });

    /**
     * How much of the direct beam a shadow removes.
     *
     * Physically it should be all of it. What is missing is not the shadow but
     * the *bounce*: a bulwark's shadow on a deck is filled by light kicked off
     * the lit planking a metre away, and nothing here models interreflection at
     * that range. Admitting the missing bounce here is more honest than lifting
     * the ambient everywhere, which would also flatten the sea and the sky.
     */
    this.controls.slider({
      label: 'Sun shadow strength',
      min: 0,
      max: 1,
      step: 0.01,
      value: sim.sunShadowStrength(),
      format: (v) => `${(v * 100).toFixed(0)} % of the beam`,
      onChange: (v) => sim.setSunShadowStrength(v),
      read: () => sim.sunShadowStrength(),
    });

    // The metered eye's dials, present only when the vessel carries one.
    // Mode first because it changes what the sliders mean: 'gaze' meters the
    // view cone (frame-metering feel, brightens a dark room you stare into,
    // pumps on dark corners), 'metered' the position, 'fixed' the old ×10.
    const adaptation = adaptationControlsOf(sim.vessel);
    if (adaptation) {
      this.adaptation = adaptation;
      this.controls.section('interior eye adaptation');
      this.controls.select(
        'Mode',
        [
          { value: 'room-lift', label: 'room lift — lit rooms, honest sky' },
          { value: 'metered', label: 'metered — light at the eye' },
          { value: 'gaze', label: 'gaze — light in the view' },
          { value: 'fixed', label: 'fixed ×10 (legacy A/B)' },
        ],
        adaptation.adaptationDebug().mode,
        (value) =>
          adaptation.setAdaptationMode(value as InteriorAdaptationMode),
        () => adaptation.adaptationDebug().mode,
      );
      // The portal-sky A/B (§17.6) sits outside the mode-owned rows because
      // it feeds the CHANNELS — every adaptation mode renders through it.
      // Unchecked restores the L2 SH; the two measured within ~2% of each
      // other on the real sky, and this switch is how that stays checkable.
      this.controls.checkbox(
        'Portal sky from source map (off: L2 SH)',
        getPortalSkySource() === 'map',
        (checked) => setPortalSkySource(checked ? 'map' : 'sh'),
        () => getPortalSkySource() === 'map',
      );
      // The room-lift dials: per-room constants on the SURFACES, live in the
      // frame the slider moves. Dial positions persist across an A/B round
      // trip — only the ROWS come and go with the mode (Ash's ask: a meter
      // target beside a lift dial reads as if both do something).
      const lifts = adaptation.roomLifts?.();
      if (lifts && adaptation.setRoomLift) {
        const setLift = adaptation.setRoomLift.bind(adaptation);
        for (const room of Object.keys(lifts)) {
          this.adaptationLiftFields.push(
            this.controls.slider({
              label: `Lift · ${room}`,
              min: 1,
              max: 40,
              step: 0.5,
              value: lifts[room],
              format: (v) => `×${v.toFixed(1)}`,
              onChange: (v) => setLift(room, v),
              read: () => adaptation.roomLifts?.()[room] ?? 1,
            }),
          );
        }
      }
      const cameraDial = (field: HTMLElement): void => {
        this.adaptationCameraFields.push(field);
      };
      const tuning = adaptation.adaptationTuning;
      cameraDial(this.controls.slider({
        label: 'Meter target',
        min: 0.2,
        max: 12,
        step: 0.1,
        value: tuning.meterTarget,
        // What the dial means: lower renders every room dimmer at its own
        // meter — "the cabin should stay honestly a little dim" is this.
        format: (v) => v.toFixed(1),
        onChange: (v) => {
          tuning.meterTarget = v;
        },
        read: () => tuning.meterTarget,
      }));
      cameraDial(this.controls.slider({
        label: 'Gain cap',
        min: 1,
        max: 300,
        step: 1,
        value: tuning.gainCap,
        format: (v) => `×${v.toFixed(0)}`,
        onChange: (v) => {
          tuning.gainCap = v;
        },
        read: () => tuning.gainCap,
      }));
      cameraDial(this.controls.slider({
        label: 'Gaze ambient floor',
        min: 0,
        max: 1,
        step: 0.05,
        value: tuning.gazeAmbientFloor,
        // 0 is pure spot metering (stare at a dark corner and the room
        // blows out); 1 collapses gaze into position metering.
        format: (v) => v.toFixed(2),
        onChange: (v) => {
          tuning.gazeAmbientFloor = v;
        },
        read: () => tuning.gazeAmbientFloor,
      }));
      cameraDial(this.controls.slider({
        label: 'Darken response',
        min: 0.05,
        max: 5,
        step: 0.05,
        value: tuning.darkenTauSeconds,
        format: (v) => `${v.toFixed(2)} s`,
        onChange: (v) => {
          tuning.darkenTauSeconds = v;
        },
        read: () => tuning.darkenTauSeconds,
      }));
      cameraDial(this.controls.slider({
        label: 'Brighten response',
        min: 0.05,
        max: 5,
        step: 0.05,
        value: tuning.brightenTauSeconds,
        format: (v) => `${v.toFixed(2)} s`,
        onChange: (v) => {
          tuning.brightenTauSeconds = v;
        },
        read: () => tuning.brightenTauSeconds,
      }));
      this.adaptationReadout = this.controls.readout();
      this.syncAdaptationDialVisibility();
    }

    // The lanterns below: the room-driven flames, one policy for all four
    // rooms. Each latch and rolloff answers to its own room's lifted
    // daylight (see InteriorLamp), so there is no threshold dial here — the
    // policy is scene-driven and the trims are the flames', not the rooms'.
    // The cabin's lamp stands in as the read-back for all of them.
    const lampControls = interiorLampControlsOf(sim.vessel);
    const cabinLamp = lampControls?.interiorLampOf('cabin');
    if (lampControls && cabinLamp) {
      this.controls.section('lanterns below');
      this.controls.select(
        'Flames',
        [
          { value: 'auto', label: 'auto — lit when the room fails' },
          { value: 'on', label: 'forced on' },
          { value: 'off', label: 'forced off' },
        ],
        cabinLamp.mode,
        (value) => lampControls.setLampsMode(value as 'auto' | 'on' | 'off'),
        () => cabinLamp.mode,
      );
      this.controls.slider({
        label: 'Flame trim',
        min: 0,
        max: 3,
        step: 0.05,
        value: cabinLamp.intensityScale,
        format: (v) => `×${v.toFixed(2)}`,
        onChange: (v) => lampControls.setLampsIntensity(v),
        read: () => cabinLamp.intensityScale,
      });
      // Six point-shadow faces PER LIT LAMP so the vented cap stops the
      // flame painting a bullseye on the deckhead and the room's timber
      // throws true shadows — the cost/look A/B, off by default.
      this.controls.checkbox(
        'Occlusion shadows',
        cabinLamp.shadowEnabled,
        (checked) => lampControls.setLampsShadow(checked),
        () => cabinLamp.shadowEnabled,
      );
    }

    // The alternative to another blind multiplier sweep. Every slider above
    // this line changes a picture; this one decomposes it. When the hull looks
    // wrong the first move is to step through the four terms and find which one
    // is missing — each has exactly one owner — rather than to guess which gain
    // to move. See `scene/WorldPbrMaterial.ts` for what each view means, and
    // note that the sea and the sky keep rendering normally: only world PBR
    // surfaces answer to this.
    this.controls.section('world PBR terms (diag)');
    this.controls.select(
      'Term view',
      WORLD_DEBUG_VIEWS.map((view) => ({ value: view.view, label: view.label })),
      getWorldDebugView(),
      (value) => setWorldDebugView(value as WorldDebugView),
      () => getWorldDebugView(),
    );
    this.controls.slider({
      label: 'Linear view stops',
      min: -4,
      max: 12,
      step: 1,
      value: getWorldDebugStops(),
      // The factor, not the exponent: the view is exactly invertible and the
      // label has to say by how much or the picture stops being a measurement.
      format: (v) => (v === 0 ? '×1 (raw)' : `×${Math.pow(2, v).toFixed(v < 0 ? 3 : 0)}`),
      onChange: (v) => setWorldDebugStops(v),
      read: () => getWorldDebugStops(),
    });

    this.controls.section('ocean optics');
    this.controls.checkbox(
      'Ocean detail TAA',
      sim.oceanTemporalEnabled(),
      (checked) => sim.setOceanTemporalEnabled(checked),
      () => sim.oceanTemporalEnabled(),
    );
    this.controls.slider({
      label: 'Ocean stability',
      min: 0,
      max: 100,
      step: 1,
      value: sim.oceanTemporalStability(),
      format: (v) => `${v.toFixed(0)} / 100`,
      onChange: (v) => sim.setOceanTemporalStability(v),
      read: () => sim.oceanTemporalStability(),
    });
    this.controls.checkbox(
      'Cached gas-sky LUT',
      sim.ocean.skyRadianceLutEnabled,
      (checked) => sim.setSkyRadianceLutEnabled(checked),
      () => sim.ocean.skyRadianceLutEnabled,
    );
    this.controls.slider({
      label: 'Body sky gain',
      min: 0,
      max: 1,
      step: 0.01,
      value: (u.uBodyGains.value as THREE.Vector2).x,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        (u.uBodyGains.value as THREE.Vector2).x = v;
      },
    });
    this.controls.slider({
      label: 'Body sun gain',
      min: 0,
      max: 1,
      step: 0.01,
      value: (u.uBodyGains.value as THREE.Vector2).y,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        (u.uBodyGains.value as THREE.Vector2).y = v;
      },
    });
    this.controls.slider({
      label: 'Glitter roughness ×',
      min: 0.2,
      max: 2.5,
      step: 0.05,
      value: u.uRoughnessScale.value as number,
      format: (v) => `${v.toFixed(2)}×`,
      onChange: (v) => {
        u.uRoughnessScale.value = v;
      },
    });
    this.controls.slider({
      label: 'Reflect lobe ratio',
      min: 0.1,
      max: 1,
      step: 0.05,
      value: u.uReflectLobeRatio.value as number,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        u.uReflectLobeRatio.value = v;
      },
    });
    this.controls.slider({
      label: 'Grazing rolloff',
      min: 0,
      max: 1,
      step: 0.05,
      value: u.uGrazingRolloff.value as number,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        u.uGrazingRolloff.value = v;
      },
    });
    this.controls.slider({
      label: 'Haze distance',
      min: 1500,
      max: 20000,
      step: 100,
      value: u.uHazeDistance.value as number,
      format: (v) => `${(v / 1000).toFixed(1)} km`,
      onChange: (v) => {
        u.uHazeDistance.value = v;
      },
    });
    this.controls.slider({
      label: 'Moon glitter gain',
      min: 0,
      max: 12,
      step: 0.25,
      value: u.uMoonSpecular.value as number,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        u.uMoonSpecular.value = v;
      },
    });

    this.controls.section('ocean GPU probe');
    const waveSlotOptions = [0, 12, 24, 36, 48].map((value) => ({
      value: String(value),
      label: String(value),
    }));
    this.controls.select(
      'Vertex wave slots',
      waveSlotOptions,
      String(sim.ocean.profileSettings.vertexWaveSlots),
      (value) => {
        sim.ocean.setProfileSettings({
          ...sim.ocean.profileSettings,
          vertexWaveSlots: Number(value),
        });
      },
      () => String(sim.ocean.profileSettings.vertexWaveSlots),
    );
    this.controls.select(
      'Residual wave slots',
      waveSlotOptions,
      String(sim.ocean.profileSettings.residualWaveSlots),
      (value) => {
        sim.ocean.setProfileSettings({
          ...sim.ocean.profileSettings,
          residualWaveSlots: Number(value),
        });
      },
      () => String(sim.ocean.profileSettings.residualWaveSlots),
    );
    this.controls.checkbox(
      'Residual phase/cosine',
      sim.ocean.profileSettings.residualPhaseEnabled,
      (residualPhaseEnabled) => {
        sim.ocean.setProfileSettings({
          ...sim.ocean.profileSettings,
          residualPhaseEnabled,
        });
      },
      () => sim.ocean.profileSettings.residualPhaseEnabled,
    );
    this.controls.select(
      'Residual loop structure',
      [
        { value: 'shipping', label: 'legacy 48-slot baseline' },
        { value: 'active', label: 'wavelength active window' },
        { value: 'branchless', label: 'branchless selects' },
        { value: 'texture', label: 'texelFetch params' },
        { value: 'rolled', label: 'dynamic bound' },
      ],
      sim.ocean.profileSettings.residualLoopMode,
      (value) => {
        sim.ocean.setProfileSettings({
          ...sim.ocean.profileSettings,
          residualLoopMode: value as OceanResidualLoopMode,
        });
      },
      () => sim.ocean.profileSettings.residualLoopMode,
    );
    const maximumDetailOctaves = sim.ocean.profileSettings.detailOctaves;
    this.controls.select(
      'Detail octaves',
      Array.from({ length: maximumDetailOctaves + 1 }, (_, value) => ({
        value: String(value),
        label: String(value),
      })),
      String(maximumDetailOctaves),
      (value) => {
        sim.ocean.setProfileSettings({
          ...sim.ocean.profileSettings,
          detailOctaves: Number(value),
        });
      },
      () => String(sim.ocean.profileSettings.detailOctaves),
    );
    this.controls.select(
      'Detail representation',
      [
        { value: 'analytic', label: 'analytic 5-octave reference' },
        { value: 'cached-256', label: 'faithful cache · 256²' },
        { value: 'cached-512', label: 'faithful cache · 512²' },
        { value: 'cached-768', label: 'faithful cache · 768²' },
        { value: 'cached-1024', label: 'faithful cache · 1024² · default' },
        { value: 'cached-2048', label: 'faithful cache · 2048²' },
        { value: 'hybrid', label: 'hybrid · analytic 0–2 + filtered micro' },
        { value: 'prefiltered', label: 'rejected 3-band diagnostic' },
      ],
      sim.ocean.profileSettings.detailRepresentation,
      (value) => {
        sim.ocean.setProfileSettings({
          ...sim.ocean.profileSettings,
          detailRepresentation: value as OceanDetailRepresentation,
        });
      },
      () => sim.ocean.profileSettings.detailRepresentation,
    );
    this.controls.select(
      'Filtered texture field',
      [
        { value: 'spectral', label: 'directional spectrum' },
        { value: 'value-noise', label: 'periodic value noise' },
      ],
      sim.ocean.profileSettings.detailTextureStyle,
      (value) => {
        sim.ocean.setProfileSettings({
          ...sim.ocean.profileSettings,
          detailTextureStyle: value as 'spectral' | 'value-noise',
        });
      },
      () => sim.ocean.profileSettings.detailTextureStyle,
    );
    this.controls.checkbox(
      'Foam fragment work',
      sim.ocean.profileSettings.foamEnabled,
      (foamEnabled) => {
        sim.ocean.setProfileSettings({
          ...sim.ocean.profileSettings,
          foamEnabled,
        });
      },
      () => sim.ocean.profileSettings.foamEnabled,
    );
    this.controls.checkbox(
      'Flat fragment baseline',
      sim.ocean.profileSettings.flatFragment,
      (flatFragment) => {
        sim.ocean.setProfileSettings({
          ...sim.ocean.profileSettings,
          flatFragment,
        });
      },
      () => sim.ocean.profileSettings.flatFragment,
    );
    this.controls.buttons([
      {
        label: 'Run component sweep',
        title: 'Freezes the current view, warms each shader, then averages raw GPU timer rotations.',
        onClick: () => {
          this.oceanProfileReadout.textContent = 'Starting ocean component probe…';
          void sim.runOceanProfileProbe((report) => {
            this.oceanProfileReadout.textContent = report;
          }).then(
            (report) => {
              this.oceanProfileReadout.textContent = report;
            },
            (error: unknown) => {
              this.oceanProfileReadout.textContent =
                error instanceof Error ? error.message : String(error);
            },
          );
        },
      },
      {
        label: 'Measure categories',
        title:
          'Renders two lossless diagnostic passes and reports how many residual slots each ocean pixel actually needs.',
        onClick: () => {
          this.oceanProfileReadout.textContent = 'Starting residual category probe…';
          void sim.runOceanResidualCategoryProbe((report) => {
            this.oceanProfileReadout.textContent = report;
          }).then(
            (report) => {
              this.oceanProfileReadout.textContent = report;
            },
            (error: unknown) => {
              this.oceanProfileReadout.textContent =
                error instanceof Error ? error.message : String(error);
            },
          );
        },
      },
      {
        label: 'Measure category matrix',
        title:
          'Measures close, production, and maximum-high cameras across calm, default, and Southern Ocean seas, then restores the scene.',
        onClick: () => {
          this.oceanProfileReadout.textContent = 'Starting residual category matrix…';
          void sim.runOceanResidualCategoryMatrix((report) => {
            this.oceanProfileReadout.textContent = report;
          }).then(
            (report) => {
              this.oceanProfileReadout.textContent = report;
            },
            (error: unknown) => {
              this.oceanProfileReadout.textContent =
                error instanceof Error ? error.message : String(error);
            },
          );
        },
      },
      {
        label: 'Benchmark active window',
        title:
          'Runs the complete legacy and active-window oceans in A-B-B-A order with raw GPU frame timers.',
        onClick: () => {
          this.oceanProfileReadout.textContent = 'Starting active-window benchmark…';
          void sim.runOceanResidualActiveBenchmark((report) => {
            this.oceanProfileReadout.textContent = report;
          }).then(
            (report) => {
              this.oceanProfileReadout.textContent = report;
            },
            (error: unknown) => {
              this.oceanProfileReadout.textContent =
                error instanceof Error ? error.message : String(error);
            },
          );
        },
      },
      {
        label: 'Benchmark detail stack',
        title:
          'Runs the complete active-window ocean with five and zero detail octaves in A-B-B-A order.',
        onClick: () => {
          this.oceanProfileReadout.textContent = 'Starting detail-stack benchmark…';
          void sim.runOceanDetailBenchmark((report) => {
            this.oceanProfileReadout.textContent = report;
          }).then(
            (report) => {
              this.oceanProfileReadout.textContent = report;
            },
            (error: unknown) => {
              this.oceanProfileReadout.textContent =
                error instanceof Error ? error.message : String(error);
            },
          );
        },
      },
      {
        label: 'Benchmark detail replacement',
        title:
          'Runs analytic A against the currently selected non-analytic detail candidate in A-B-B-A order.',
        onClick: () => {
          this.oceanProfileReadout.textContent = 'Starting detail-replacement benchmark…';
          void sim.runOceanDetailRepresentationBenchmark((report) => {
            this.oceanProfileReadout.textContent = report;
          }).then(
            (report) => {
              this.oceanProfileReadout.textContent = report;
            },
            (error: unknown) => {
              this.oceanProfileReadout.textContent =
                error instanceof Error ? error.message : String(error);
            },
          );
        },
      },
      {
        label: 'Open previous detail sheet',
        title:
          'Freezes the current scene and captures analytic A, E1 1024², E2 2048², and F hybrid.',
        onClick: () => {
          this.captureDetailContactSheet('previous-round');
        },
      },
      {
        label: 'Open smaller-cache sheet',
        title:
          'Freezes the current scene and captures analytic A plus the 768², 512², and 256² faithful caches.',
        onClick: () => {
          this.captureDetailContactSheet('smaller-caches');
        },
      },
      {
        label: 'Open previous close sheet',
        title:
          'Cuts to a steep embodied over-the-side view and captures analytic A, E1 1024², E2 2048², and F hybrid.',
        onClick: () => {
          this.captureDetailContactSheet('previous-round', 'embodied-down');
        },
      },
      {
        label: 'Open smaller-cache close sheet',
        title:
          'Cuts to a steep embodied over-the-side view and captures analytic A plus the 768², 512², and 256² faithful caches.',
        onClick: () => {
          this.captureDetailContactSheet('smaller-caches', 'embodied-down');
        },
      },
      {
        label: 'Open ocean haze A/B sheet',
        title:
          'Captures six frozen, sideways embodied ocean views. A is the legacy per-pixel cloud march; B is the stable gas-only haze fix.',
        onClick: () => {
          this.captureCloudHazeContactSheet();
        },
      },
      {
        label: 'Measure detail octaves',
        title:
          'Reports how many analytic detail octaves the current frozen view evaluates per ocean pixel.',
        onClick: () => {
          this.oceanProfileReadout.textContent = 'Starting detail octave probe…';
          void sim.runOceanDetailCategoryProbe((report) => {
            this.oceanProfileReadout.textContent = report;
          }).then(
            (report) => {
              this.oceanProfileReadout.textContent = report;
            },
            (error: unknown) => {
              this.oceanProfileReadout.textContent =
                error instanceof Error ? error.message : String(error);
            },
          );
        },
      },
      {
        label: 'Measure detail matrix',
        title:
          'Measures live detail octaves across calm, production, and Southern Ocean seas at close, medium, and maximum-high cameras.',
        onClick: () => {
          this.oceanProfileReadout.textContent = 'Starting detail octave matrix…';
          void sim.runOceanDetailCategoryMatrix((report) => {
            this.oceanProfileReadout.textContent = report;
          }).then(
            (report) => {
              this.oceanProfileReadout.textContent = report;
            },
            (error: unknown) => {
              this.oceanProfileReadout.textContent =
                error instanceof Error ? error.message : String(error);
            },
          );
        },
      },
      {
        label: 'Verify loop variants',
        title:
          'Freezes the view and pixel-diffs each residual loop structure against shipping, with a shipping-vs-shipping control row.',
        onClick: () => {
          this.oceanProfileReadout.textContent = 'Starting residual loop diff…';
          void sim.runOceanResidualDiff((report) => {
            this.oceanProfileReadout.textContent = report;
          }).then(
            (report) => {
              this.oceanProfileReadout.textContent = report;
            },
            (error: unknown) => {
              this.oceanProfileReadout.textContent =
                error instanceof Error ? error.message : String(error);
            },
          );
        },
      },
      {
        label: 'Restore default',
        onClick: () => {
          sim.ocean.resetProfileSettings();
          sim.setSkyRadianceLutEnabled(true);
          this.oceanProfileReadout.textContent =
            'Default active-window ocean + faithful 1024² detail restored.';
        },
      },
    ]);
    this.oceanProfileReadout = this.controls.readout();
    this.oceanProfileReadout.textContent =
      'Manual switches recompile the ocean shader.\nThe sweep freezes the view and reports raw mean ± SD.';

    // Cloud tuning is judged by watching, not by reading — how fast a sky
    // should drift is the sort of question a slider answers in ten seconds and
    // an argument never does. All three are presentation-only: the coverages
    // are thresholds on a noise field, and the rate is a multiplier on world
    // time that the clock integrates, so moving it changes how fast the sky
    // goes from here rather than teleporting it.
    this.controls.section('clouds');
    this.controls.slider({
      label: 'Cumulus cover',
      min: 0.15,
      max: 0.95,
      step: 0.01,
      // Presented the way it reads on screen. The uniform is a THRESHOLD, so
      // it runs backwards: lower means more cloud.
      value: 1 - (sim.sky.uniforms.uCloudCover.value as number),
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        sim.sky.uniforms.uCloudCover.value = 1 - v;
      },
      read: () => 1 - (sim.sky.uniforms.uCloudCover.value as number),
    });
    this.controls.slider({
      label: 'Drift rate',
      min: 0,
      max: 4,
      step: 0.05,
      value: sim.sky.timeRate,
      // 1.00 is the honest figure — the deck drifts at the speed the current
      // weather implies, in wall-clock time like the waves. Above it is
      // timelapse again, kept on the dial because "how fast should a sky
      // look" is a watching question; see CLOUD_WALL_RATE.
      format: (v) => (v <= 0.001 ? 'frozen' : `${v.toFixed(2)}× wall clock`),
      onChange: (v) => {
        sim.sky.timeRate = v;
      },
      read: () => sim.sky.timeRate,
    });

    this.controls.section('stars');
    this.controls.slider({
      label: 'Limiting-mag bias',
      min: -3,
      max: 3,
      step: 0.1,
      value: 0,
      format: (v) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1)),
      onChange: (v) => {
        this.state.starLimitBias = v;
      },
    });

    // Both of these are uniforms rather than constants precisely so they can
    // be walked while looking at the sky. The endpoints are the shipped value
    // and the value this round replaced, so the A/B is a real before-and-after
    // rather than a taste slider with no anchor.
    const starUniforms = sim.stars.material.uniforms;
    this.controls.slider({
      label: 'Magnitude exponent',
      min: STAR_LEGACY_MAGNITUDE_EXPONENT,
      max: STAR_MAGNITUDE_EXPONENT,
      step: 0.005,
      value: starUniforms.uMagnitudeExponent.value as number,
      // 0.4 is the photometric law; 0.23 is what shipped before this round and
      // is what made four fifths of the catalogue the same brightness.
      format: (v) =>
        v >= STAR_MAGNITUDE_EXPONENT - 1e-6
          ? '0.400 — physical'
          : v <= STAR_LEGACY_MAGNITUDE_EXPONENT + 1e-6
            ? '0.230 — legacy flat'
            : v.toFixed(3),
      onChange: (v) => {
        starUniforms.uMagnitudeExponent.value = v;
      },
      read: () => starUniforms.uMagnitudeExponent.value as number,
    });
    // The two dials that decide whether the field reads as a night sky or as
    // a scatter of headlights. Faint-end level moves the WHOLE ladder, because
    // it is the rung everything else is measured from; glare size decides only
    // how far the handful of over-range stars spread.
    this.controls.slider({
      label: 'Faint-end level',
      min: 0.001,
      max: 0.03,
      step: 0.0005,
      value: starUniforms.uAnchorIntensity.value as number,
      // Reported as a ratio against the shipped level rather than as a display
      // code: the code depends on the sky the star lands on, and quoting one
      // is how the first pass talked itself into a number four times off.
      format: (v) =>
        `mag ${STAR_ANCHOR_MAGNITUDE} · ${(v / STAR_ANCHOR_INTENSITY).toFixed(2)}× shipped`,
      onChange: (v) => {
        starUniforms.uAnchorIntensity.value = v;
      },
      read: () => starUniforms.uAnchorIntensity.value as number,
    });
    this.controls.slider({
      label: 'Glare size',
      min: 0.5,
      max: 4,
      step: 0.1,
      value: starUniforms.uHaloSigmaMax.value as number,
      // Sigma is not the thing anyone can see; the sprite it forces is. 3.9
      // was the first pass, and a 23-pixel star reads as the moon.
      format: (v) => `${v.toFixed(1)}σ · ${(6 * v).toFixed(0)} px sprite`,
      onChange: (v) => {
        starUniforms.uHaloSigmaMax.value = v;
      },
      read: () => starUniforms.uHaloSigmaMax.value as number,
    });
    this.controls.slider({
      label: 'Cloud beam power',
      min: STAR_LEGACY_CLOUD_BEAM_POWER,
      max: 10,
      step: 0.25,
      value: starUniforms.uCloudBeamPower.value as number,
      format: (v) =>
        v <= STAR_LEGACY_CLOUD_BEAM_POWER + 1e-6
          ? '1.00 — legacy linear alpha'
          : `${v.toFixed(2)} optical depths`,
      onChange: (v) => {
        starUniforms.uCloudBeamPower.value = v;
      },
      read: () => starUniforms.uCloudBeamPower.value as number,
    });

    // The band's two open questions, both of them watching questions. Gain is
    // anchored at the real 2.5-to-1 contrast but the display it is judged on
    // is not a dark sky at 3am; chroma has no physical answer at all, because
    // the naked-eye Milky Way is colourless and everything above zero here is
    // a photographic choice.
    this.controls.section('milky way');
    this.controls.slider({
      label: 'Peak gain',
      min: 0,
      max: 0.06,
      step: 0.001,
      value: sim.sky.uniforms.uMilkyWayGain.value as number,
      // Quoted against the PHYSICALLY MEASURED contrast, not against whatever
      // ships, so the size of the departure stays on screen in either
      // direction. The shipped 0.008 reads as 0.53x — restrained, deliberately.
      format: (v) =>
        v <= 0.0005
          ? 'off'
          : `${v.toFixed(3)} · ${(v / MILKY_WAY_MEASURED_GAIN).toFixed(2)}× measured`,
      onChange: (v) => {
        sim.sky.uniforms.uMilkyWayGain.value = v;
      },
      read: () => sim.sky.uniforms.uMilkyWayGain.value as number,
    });
    this.controls.slider({
      label: 'Chroma',
      min: 0,
      max: 1,
      step: 0.05,
      value: sim.sky.uniforms.uMilkyWayChroma01.value as number,
      // 0 is what the eye actually sees at this surface brightness; 1 is the
      // photograph the map was made from.
      format: (v) =>
        v <= 0.001
          ? 'grey — as the eye sees it'
          : v >= 0.999
            ? 'full — as photographed'
            : v.toFixed(2),
      onChange: (v) => {
        sim.sky.uniforms.uMilkyWayChroma01.value = v;
      },
      read: () => sim.sky.uniforms.uMilkyWayChroma01.value as number,
    });

    this.controls.section('raft lamp');
    this.controls.select(
      'Mode',
      [
        { value: 'auto', label: 'Automatic (sun elevation)' },
        { value: 'on', label: 'Forced on' },
        { value: 'off', label: 'Forced off' },
      ],
      sim.vessel.lamp.mode,
      (v) => {
        sim.vessel.lamp.mode = v as LampMode;
      },
      () => sim.vessel.lamp.mode,
    );
    this.controls.slider({
      label: 'Lamp intensity ×',
      min: 0,
      max: 3,
      step: 0.05,
      value: sim.vessel.lamp.intensityScale,
      format: (v) => `${v.toFixed(2)}×`,
      onChange: (v) => {
        sim.vessel.lamp.intensityScale = v;
      },
      read: () => sim.vessel.lamp.intensityScale,
    });
    this.controls.slider({
      label: 'Lamp on water',
      min: 0,
      max: 8,
      step: 0.1,
      value: u.uLampGain.value as number,
      format: (v) => v.toFixed(1),
      onChange: (v) => {
        u.uLampGain.value = v;
      },
    });

    this.controls.section('telemetry');
    this.readout = this.controls.readout();
  }

  private captureDetailContactSheet(
    set: OceanDetailContactSheetSet,
    view: OceanDetailContactSheetView = 'current',
  ): void {
    this.oceanProfileReadout.textContent = 'Capturing detail contact sheet…';
    void this.sim.runOceanDetailContactSheet(set, view, (report) => {
      this.oceanProfileReadout.textContent = report;
    }).then(
      (sheet) => {
        this.oceanProfileReadout.textContent =
          `Contact sheet captured · ${sheet.condition}`;
        this.showContactSheet(sheet);
      },
      (error: unknown) => {
        this.oceanProfileReadout.textContent =
          error instanceof Error ? error.message : String(error);
      },
    );
  }

  private captureCloudHazeContactSheet(): void {
    this.oceanProfileReadout.textContent = 'Capturing ocean haze A/B sheet…';
    void this.sim.runOceanCloudHazeContactSheet((report) => {
      this.oceanProfileReadout.textContent = report;
    }).then(
      (sheet) => {
        this.oceanProfileReadout.textContent =
          `Contact sheet captured · ${sheet.condition}`;
        this.showContactSheet(sheet);
      },
      (error: unknown) => {
        this.oceanProfileReadout.textContent =
          error instanceof Error ? error.message : String(error);
      },
    );
  }

  private showContactSheet(sheet: OceanDetailContactSheet): void {
    this.contactSheetDialog?.remove();
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', `${sheet.title} contact sheet`);
    Object.assign(dialog.style, {
      width: '100vw',
      height: '100vh',
      maxWidth: 'none',
      maxHeight: 'none',
      margin: '0',
      padding: '10px',
      border: '0',
      borderRadius: '0',
      background: '#09111c',
      color: '#d9e9f4',
      font: '500 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
      overflow: 'auto',
      zIndex: '1000',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      marginBottom: '10px',
    });
    const title = document.createElement('strong');
    title.textContent = `${sheet.title} · ${sheet.condition}`;
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.addEventListener('click', () => dialog.close());
    header.append(title, close);
    dialog.appendChild(header);

    const grid = document.createElement('div');
    Object.assign(grid.style, {
      display: 'grid',
      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
      alignItems: 'start',
      gap: '10px',
    });
    for (const capture of sheet.captures) {
      const figure = document.createElement('figure');
      Object.assign(figure.style, {
        margin: '0',
        display: 'grid',
        gridTemplateRows: 'auto auto',
      });
      const label = document.createElement('figcaption');
      label.textContent = capture.label;
      label.style.marginBottom = '4px';
      const image = document.createElement('img');
      image.src = capture.dataUrl;
      image.alt = `${capture.label}, ${sheet.condition}`;
      Object.assign(image.style, {
        display: 'block',
        width: '100%',
        height: 'auto',
        objectFit: 'contain',
        borderRadius: '4px',
        border: '1px solid rgba(150, 190, 220, 0.22)',
      });
      figure.append(label, image);
      grid.appendChild(figure);
    }
    dialog.appendChild(grid);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.appendChild(dialog);
    this.contactSheetDialog = dialog;
    dialog.showModal();
  }

  /**
   * Which dial rows a mode shows: 'room-lift' gets the per-room lifts, the
   * camera modes get the meter's target/cap/floor/taus. A meter target
   * sitting beside a lift dial reads as if both do something (Ash's ask).
   */
  private syncAdaptationDialVisibility(): void {
    if (!this.adaptation) return;
    const roomLift = this.adaptation.adaptationDebug().mode === 'room-lift';
    for (const field of this.adaptationLiftFields) {
      field.style.display = roomLift ? '' : 'none';
    }
    for (const field of this.adaptationCameraFields) {
      field.style.display = roomLift ? 'none' : '';
    }
  }

  update(dtSeconds: number): void {
    this.controls.sync();
    this.accumulated += dtSeconds;
    if (this.accumulated < 0.25) return;
    this.accumulated = 0;

    if (this.adaptation && this.adaptationReadout) {
      const debug = this.adaptation.adaptationDebug();
      this.adaptationReadout.textContent =
        debug.mode === 'room-lift'
          ? `mode ${debug.mode} · camera ×1 · lifts on the walls`
          : `mode ${debug.mode} · meter ${debug.meter === null ? 'sky' : debug.meter.toFixed(4)}` +
            ` · target ×${debug.gainTarget.toFixed(1)} · applied ×${debug.gain.toFixed(1)}`;
      // In the update path rather than the select's onChange so a console
      // `__drift.setAdaptationMode(...)` moves the panel too.
      this.syncAdaptationDialVisibility();
    }

    const lighting = this.sim.lighting;
    const lamp = this.sim.vessel.lamp;
    const RAD = 180 / Math.PI;
    const az =
      lighting.solarAzimuthRad === null
        ? 'pole'
        : `${(lighting.solarAzimuthRad * RAD).toFixed(1)}°`;
    const ambient = lighting.ambientRadiance;
    const skyLum =
      0.2126 * ambient.x + 0.7152 * ambient.y + 0.0722 * ambient.z;
    this.readout.textContent = [
      `sun elev   ${(lighting.solarElevationRad * RAD).toFixed(2)}°  az ${az}`,
      `moon elev  ${(lighting.lunarElevationRad * RAD).toFixed(2)}°  lit ${(lighting.moonIlluminatedFraction * 100).toFixed(0)}%`,
      `sky lum    ${skyLum.toFixed(4)}`,
      `exposure   target ${lighting.exposure.toFixed(3)} · applied ${this.sim.renderer.toneMappingExposure.toFixed(3)}`,
      // The TARGET, read straight off this frame's meter. What the pass is
      // actually applying lags it by a ~4 s dark-adaptation constant, so the
      // two disagree while the light is moving — which is the point of the
      // lag, not a discrepancy to reconcile here.
      `observer   retinal ${lighting.retinalLuminance.toExponential(2)} cd/m2 · rod target ${scotopicStrength() <= 0 ? 'off' : rodDominance(lighting.retinalLuminance).toFixed(3)}`,
      `moon       power ${lighting.moonPower.toFixed(4)} · direct ${lighting.moonLightIntensity.toFixed(3)} · meter ${lighting.adaptationLuminance.toExponential(2)}`,
      `stars      limit m ${(lighting.limitingMagnitude + this.state.starLimitBias).toFixed(2)}`,
      `moon phase bright ${lighting.moonPhaseBright.toFixed(3)}`,
      `lamp       ${lamp.mode} · ${lamp.isOn ? 'lit' : 'out'} · level ${lamp.litLevel.toFixed(2)}`,
    ].join('\n');
  }

  dispose(): void {
    this.contactSheetDialog?.remove();
    this.element.remove();
  }
}

export function createGraphicsPanel(sim: GraphicsPanelCapability): GraphicsPanel {
  return new GraphicsPanel(sim);
}
