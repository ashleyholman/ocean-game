/**
 * The registry of A/B switches a paired contact sheet may photograph.
 *
 * A switch earns a place here by satisfying one requirement that turns out to
 * be the whole discipline: **it must be readable, not just writable.** A sheet
 * that sets an arm and captions the frame with what it set is a sheet that
 * cannot detect the case where the arm did not take — a live toggle that
 * needed a uniform republish, a URL value silently rejected as out of range, a
 * flag that only exists when some other object was constructed at boot. Every
 * entry below reports its live value back, and `renderTier.ts` fails the
 * capture when the read-back disagrees with the request.
 *
 * SCOPE IS THE OTHER HALF
 * -----------------------
 * `live` switches move a uniform or a cache key and can be flipped between two
 * renders of one frozen simulation state. Those give the strongest possible
 * A/B: literally the same water, the same instant, the same eye, one thing
 * different.
 *
 * `reload` switches change shader SOURCE TEXT, which three's program cache is
 * not keyed on — flipping one at runtime leaves every compiled program running
 * the old code and the comparison becomes a lie (see `toneMapping.ts` and
 * `colourPipeline.ts`, which both say so at their switch). These need one page
 * load per arm, and the sheet builder interleaves at the shot level across two
 * concurrently loaded pages rather than pretending it can flip them in place.
 *
 * NOT REGISTERED, AND WHY: `sim.setCloudsEnabled` and
 * `sim.setSkyRadianceLutEnabled` are write-only on the simulation facade, and
 * `?legacyColour=1` is a bundle of three of the flags below rather than a
 * switch of its own. Give the first two a reader and they belong here.
 */

import {
  isChromaTrimDisabled,
  isFibonacciAmbientEnabled,
  isFlatSkyMean,
  isLegacyExposure,
  isLegacySkyHue,
  isLegacyToneCurve,
  isLegacyWaterHue,
  isShadowToeEnabled,
  isSunDomeMeanEnabled,
  setChromaTrimDisabled,
  setFibonacciAmbientEnabled,
  setFlatSkyMean,
  setLegacyExposure,
  setLegacySkyHue,
  setLegacyToneCurve,
  setLegacyWaterHue,
  setSunDomeMeanEnabled,
} from '../scene/colourPipeline';
import { scotopicStrength, setScotopicStrength } from '../scene/scotopic';
import { isLegacyMoonlight, setLegacyMoonlight } from '../scene/TimeOfDay';
import { TONE_SHOULDER } from '../scene/toneMapping';
import {
  getTerrainDrawOrder,
  setTerrainDrawOrder,
  TERRAIN_DRAW_ORDERS,
  type TerrainDrawOrder,
} from '../terrain/terrainDrawOrder';
import { getTimberMode } from '../vessel/schooner/timberFinish';
import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type AbSwitchCapability = SimCapability<
  | 'foamLookupLegacy'
  | 'sailClothMode'
  | 'sky'
  | 'stars'
  | 'oceanTemporalEnabled'
  | 'setFoamLookupLegacy'
  | 'setOceanTemporalEnabled'
  | 'setSunShadowing'
  | 'setVesselSkyOcclusion'
  | 'setWakeBowFeatureEnabled'
  | 'setWakeEffectsEnabled'
  | 'shadowingState'
  | 'vesselSkyOcclusionEnabled'
  | 'wakeBowFeatureEnabled'
  | 'wakeEffectsEnabled'
>;

export interface AbSwitch {
  /** Registry name — what `--switch` takes, and what labels the sheet. */
  name: string;
  /** One line for `--list`, in the terms the decision is actually about. */
  summary: string;
  /**
   * `live`: flips in place between two renders of one frozen state.
   * `reload`: changes shader source; needs its own page load per arm.
   */
  scope: 'live' | 'reload';
  /** The shipping arm, so a sheet can mark which side is the status quo. */
  defaultArm: string;
  /** The arms to photograph when the caller names none. */
  arms: readonly string[];
  /** Present only on `live` switches. */
  apply?(sim: AbSwitchCapability, arm: string): void;
  /** The live value, read from the thing that actually holds it. */
  read(sim: AbSwitchCapability): string;
  /**
   * Present only on `reload` switches: the query parameters that select an
   * arm at page load.
   */
  urlFor?(arm: string): Record<string, string>;
}

const bit = (value: boolean): string => (value ? '1' : '0');
const isOn = (arm: string): boolean => arm === '1';

/** A plain on/off flag over a paired setter and getter. */
function flagSwitch(
  name: string,
  summary: string,
  defaultArm: '0' | '1',
  set: (sim: AbSwitchCapability, on: boolean) => void,
  get: (sim: AbSwitchCapability) => boolean,
): AbSwitch {
  return {
    name,
    summary,
    scope: 'live',
    defaultArm,
    arms: ['0', '1'],
    apply: (sim, arm) => set(sim, isOn(arm)),
    read: (sim) => bit(get(sim)),
  };
}

/** A colour-pipeline flag: no simulation involved, just the module's own state. */
function colourFlagSwitch(
  name: string,
  summary: string,
  set: (on: boolean) => void,
  get: () => boolean,
): AbSwitch {
  return {
    name,
    summary,
    scope: 'live',
    defaultArm: '0',
    arms: ['0', '1'],
    apply: (_sim, arm) => set(isOn(arm)),
    read: () => bit(get()),
  };
}

export const AB_SWITCHES: readonly AbSwitch[] = [
  // --- the ocean's own temporal resolve ------------------------------------
  {
    ...flagSwitch(
      'oceanTaa',
      'ocean detail temporal resolve — 1 accumulates detail history, 0 draws it fresh',
      '0',
      (sim, on) => sim.setOceanTemporalEnabled(on),
      (sim) => sim.oceanTemporalEnabled(),
    ),
    // The resolve object is only CONSTRUCTED when `?oceanTaa=1` is on the URL
    // (main.ts). Without it the live setter has nothing to enable and the
    // read-back stays 0 — which is exactly the silent substitution this
    // registry exists to catch, so the page must be loaded with the flag on
    // and the arms flipped live from there.
    summary:
      'ocean detail temporal resolve — load the page with ?oceanTaa=1, then flip live',
  },

  // --- the colour pipeline's six, all awaiting a verdict --------------------
  colourFlagSwitch(
    'legacyToneCurve',
    'ACES Filmic (1) against the hue-preserving curve that ships (0)',
    setLegacyToneCurve,
    isLegacyToneCurve,
  ),
  colourFlagSwitch(
    'legacyExposure',
    'the fixed 0.335 daylight plateau (1) against one adaptation curve (0)',
    setLegacyExposure,
    isLegacyExposure,
  ),
  colourFlagSwitch(
    'noChromaTrim',
    'sky chroma trim OFF (1) against the 1.25 stretch that ships (0)',
    setChromaTrimDisabled,
    isChromaTrimDisabled,
  ),
  colourFlagSwitch(
    'legacySkyHue',
    'the hand-fitted sky hue (1) against the spectrally derived one (0)',
    setLegacySkyHue,
    isLegacySkyHue,
  ),
  colourFlagSwitch(
    'sunDomeMean',
    "the sun's aerosol lobe replaced by its normalisation in the sky MEANS (1) " +
      'against the seven-sample point estimate that ships (0) — watch the fill ' +
      'as the sun crosses 26 degrees elevation',
    setSunDomeMeanEnabled,
    isSunDomeMeanEnabled,
  ),
  colourFlagSwitch(
    'fibonacciAmbient',
    'the ambient fill as a 256-direction cosine mean of the sky (1) against ' +
      'the seven fixed directions that ship (0) — the deeper fix under both ' +
      'aureole bugs. Watch the sun cross 26 and 53 degrees, and watch a ' +
      'cloud deck drift, which is the larger fault and the one nothing else ' +
      'has touched',
    setFibonacciAmbientEnabled,
    isFibonacciAmbientEnabled,
  ),
  colourFlagSwitch(
    'flatSkyMean',
    'rough sea reflection collapsed to a cosine mean (1) against the L2 probe (0)',
    setFlatSkyMean,
    isFlatSkyMean,
  ),
  colourFlagSwitch(
    'legacyWaterHue',
    'the near-grey water backscatter (1) against seawater’s 3.63 blue:red (0)',
    setLegacyWaterHue,
    isLegacyWaterHue,
  ),

  // --- lighting and water levers with real read-back ------------------------
  flagSwitch(
    'sunShadow',
    'geometry sun shadowing: hull and displaced waves cast (1) or do not (0)',
    '1',
    (sim, on) => sim.setSunShadowing(on),
    (sim) => sim.shadowingState().sun,
  ),
  flagSwitch(
    'vesselSkyOcclusion',
    'the hull’s analytic bite out of the sky hemisphere',
    '1',
    (sim, on) => sim.setVesselSkyOcclusion(on),
    (sim) => sim.vesselSkyOcclusionEnabled(),
  ),
  flagSwitch(
    'foamLookupLegacy',
    'the legacy 0.9-texel foam sample jitter (1) against the quintic warp (0)',
    '0',
    (sim, on) => sim.setFoamLookupLegacy(on),
    (sim) => sim.foamLookupLegacy(),
  ),
  flagSwitch(
    'wakeEffects',
    'every hull-sourced water effect from WK1 on',
    '1',
    (sim, on) => sim.setWakeEffectsEnabled(on),
    (sim) => sim.wakeEffectsEnabled(),
  ),

  // --- the wake's far field, off by default since WK-R10 --------------------
  flagSwitch(
    'kelvinPattern',
    'the far-field Kelvin wedge alone (1) against the near-field bow front on ' +
      'its own (0, ships) — REVIEW_QUEUE 4.2, "keep or kill". It reads as a ' +
      'decal because a normal-only wake cannot mix with water that has height',
    '0',
    (sim, on) => sim.setWakeBowFeatureEnabled('kelvinPattern', on),
    (sim) => sim.wakeBowFeatureEnabled('kelvinPattern'),
  ),

  // --- the cloud cache against the march it approximates --------------------
  {
    name: 'cloudLiveMarch',
    summary:
      'the cloud dome drawn by the reference per-pixel march (1) against the ' +
      'cache composite that ships (0) — REVIEW_QUEUE 3.9, "is the cache’s ' +
      'softness acceptable"',
    // A define, so it recompiles — but `setLiveMarch` sets `needsUpdate`, which
    // is exactly the step three's program cache misses when a source-text
    // switch is flipped behind its back. That makes this the rare shader-source
    // switch that is honestly live, and the read-back is the define itself.
    scope: 'live',
    defaultArm: '0',
    arms: ['0', '1'],
    apply: (sim, arm) => sim.sky.setLiveMarch(isOn(arm)),
    read: (sim) => bit('CLOUD_LIVE_MARCH' in sim.sky.material.defines),
  },

  // --- the observer's own rods ----------------------------------------------
  {
    name: 'scotopic',
    summary:
      'the rejected night-only observer model: 0 ships (the unlifted direct ' +
      'display path), while 1 opts into dark-pixel lift, blue-grey ' +
      'desaturation and softening for comparison',
    // Live, and the module says why at `setScotopicStrength`: the operator is a
    // uniform on a full-screen pass, and `onScotopicChange` clears the rod
    // low-pass's latch so a flip lands in the very next frame rather than four
    // seconds later. Both arms therefore come off ONE frozen night.
    scope: 'live',
    defaultArm: '0',
    arms: ['0', '1'],
    apply: (_sim, arm) => setScotopicStrength(arm === '1' ? 1 : 0),
    // The strength itself, from the module the shader reads — not the URL that
    // asked for it. `?scotopic=` also accepts a fraction, so this reports the
    // arm only when the arm is what actually took.
    read: () => (scotopicStrength() >= 1 ? '1' : String(scotopicStrength())),
  },

  // --- the moon's sky power, Part B's headline number -----------------------
  {
    name: 'legacyMoonlight',
    summary:
      "the moon's sky power before Part B (1) against the value that ships " +
      '(0) — REVIEW_QUEUE 3.2. Measured on `ambientRadiance` at a −25° sun ' +
      'with a full moon at 40°, the two arms are 1.79x and 12.14x the moonless ' +
      'airglow floor. Needs a scene with a moon actually up, which is what the ' +
      "`dayOfYear` scene field is for: the opening day's moon is 9.7 % lit and " +
      'below the horizon, where both arms are identically zero',
    // Live, and the strongest kind: `moonPower` is a CPU-side product
    // recomputed by `refreshFromAstronomy` and pushed to `uMoonPower`, so the
    // arm lands through the `refreshLighting` that `captureAb` already runs
    // after applying one. Nothing recompiles and nothing integrates.
    scope: 'live',
    defaultArm: '0',
    arms: ['0', '1'],
    apply: (_sim, arm) => setLegacyMoonlight(isOn(arm)),
    read: () => bit(isLegacyMoonlight()),
  },

  // --- M6's sail presentation -----------------------------------------------
  {
    name: 'cloth',
    summary:
      'the M6 deformable cloth (alive, ships) against the pre-M6 flat loft ' +
      '(flat), with `still` freezing the flogging clock while keeping the ' +
      'shape — REVIEW_QUEUE 2.6. Wants a point of sail: five of that line’s ' +
      'six items are conditions rather than views, so pair it with the ' +
      '`trueWindAngleDeg` scene field',
    // Page-load, and in both directions. `flat` decides whether a cloth state
    // is ATTACHED to the loft at all (`VesselRuntime`'s constructor), and
    // `animate` is fixed on the same object at the same moment; the rig is
    // built once, so an arm chosen after the ship exists is an arm that does
    // nothing. Exactly the silent substitution the read-back requirement
    // exists to catch — which is why the read below comes from the loft state
    // and not from the option that asked for it.
    scope: 'reload',
    defaultArm: 'alive',
    arms: ['alive', 'flat'],
    read: (sim) => sim.sailClothMode(),
    urlFor: (arm) => ({ cloth: arm }),
  },

  // --- where the star dome is parked in depth -------------------------------
  {
    name: 'starDome',
    summary:
      'star dome depth: far (ships) parks it at 0.98x the far plane; near restores the 485 m dome, which painted stars over terrain 6 km off and over the sea past half a kilometre',
    // Live, and worth saying why: the anchor is read inside `StarField.update`
    // every frame and only rescales the mesh, so a flip lands on the next
    // render with no recompile and no cache key. That makes this the strongest
    // shape of A/B available — both arms off one frozen night.
    scope: 'live',
    defaultArm: 'far',
    arms: ['far', 'near'],
    apply: (sim, arm) => {
      sim.stars.domeAnchor = arm === 'near' ? 'near' : 'far';
    },
    read: (sim) => sim.stars.domeAnchor,
  },

  // --- which side of the sea the land is drawn on ---------------------------
  {
    name: 'terrainOrder',
    summary:
      'terrain draw order: after (ships — the sea shades every fragment then land paints over it) against before, which lets fixed-function depth reject ocean hidden behind land. Expect an identical picture; the diff panel is there to prove it, because the depth function is LESS and the waterline is where a tie changes hands',
    // Live for the same reason `starDome` is: nothing here is compiled into a
    // shader. Moving a render order re-sorts one draw list on the next frame,
    // so both arms come off ONE frozen sea, one instant, one eye.
    scope: 'live',
    defaultArm: 'after',
    arms: TERRAIN_DRAW_ORDERS,
    apply: (_sim, arm) => setTerrainDrawOrder(arm as TerrainDrawOrder),
    read: () => getTerrainDrawOrder(),
  },

  // --- page-load switches: shader source, so one load per arm ---------------
  {
    name: 'shoulder',
    summary:
      'tone-curve shoulder join, in multiples of display white — 0.80 ships, 0.70 spreads the blue sky band over ~9 levels instead of 3',
    scope: 'reload',
    defaultArm: '0.8',
    arms: ['0.8', '0.7'],
    read: () => String(TONE_SHOULDER),
    urlFor: (arm) => ({ shoulder: arm }),
  },
  {
    name: 'noToe',
    summary: 'the shadow toe: 0 keeps it (ships), 1 compiles it out',
    scope: 'reload',
    defaultArm: '0',
    arms: ['0', '1'],
    read: () => bit(!isShadowToeEnabled()),
    urlFor: (arm): Record<string, string> => (isOn(arm) ? { noToe: '1' } : {}),
  },
  {
    name: 'timber',
    summary:
      'the timber round, cumulative: off ships; woods respecs six wood ' +
      'colours at held luminance (hue 26-43 where all six now sit inside 5 ' +
      'degrees); grain adds board, figure and warm/cool variation in the ' +
      'fragment; wear darkens the six places hands and feet go. Look at the ' +
      'cabin by lamplight, the wardroom unlit, and the deck at low sun',
    // Page-load and unavoidably so, in BOTH halves: `woods` is read while the
    // vessel's materials are constructed, and `grain` is a define that changes
    // shader source, which three's program cache is not keyed on.
    scope: 'reload',
    defaultArm: 'off',
    arms: ['off', 'woods', 'grain', 'wear'],
    read: () => getTimberMode(),
    urlFor: (arm) => ({ timber: arm }),
  },
];

export function findAbSwitch(name: string): AbSwitch {
  const found = AB_SWITCHES.find((entry) => entry.name === name);
  if (found) return found;
  throw new Error(
    `unknown A/B switch '${name}' — known: ${AB_SWITCHES.map((s) => s.name).join(', ')}`,
  );
}

/** Every registered switch's live value, for the capture's tier stamp. */
export function readAllAbSwitches(
  sim: AbSwitchCapability,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of AB_SWITCHES) out[entry.name] = entry.read(sim);
  return out;
}
