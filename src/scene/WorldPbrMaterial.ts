import * as THREE from 'three';
import { SH_COEFFICIENT_COUNT } from './sphericalHarmonics';

/**
 * The one place ordinary world surfaces are lit.
 *
 * Every solid object that is not the sea or the sky comes from here, and all
 * the shader surgery in the project lives in this file. No per-object light, no
 * per-object gain, no per-object exposure. Geometry-specific transport is
 * explicit instead: enclosure visibility and nearby diffuse bounce describe
 * where the shared world light can travel rather than changing the light.
 *
 * WHAT THE SURGERY IS FOR
 * -----------------------
 * Three couples two things that have to be separated. `getIBLIrradiance()` and
 * `getIBLRadiance()` are both scaled by the same `envMapIntensity`, so one
 * scalar drives diffuse fill and glossy reflection together — turn it up to
 * make a shaded hull readable and the bright sky in the specular path flares.
 * Worse, three's environment "irradiance" is not a cosine integral at all: it
 * samples the PMREM's roughness-1 mip along the normal, a GGX lobe far narrower
 * than a cosine. The source map contains the sun's circumsolar aureole, so a
 * plank whose normal swings toward the sun's azimuth picks up several times the
 * irradiance an honest convolution gives. That is the pale flashing, and it is
 * why it survived turning the sun off.
 *
 * So: suppress three's environment irradiance entirely, and feed the diffuse
 * term from the L2 probe — a real cosine convolution of the same source — while
 * leaving the PMREM to do the job it is good at, which is glossy reflection.
 *
 * WHY THE SH GOES INTO `iblIrradiance` AND NOT A `LightProbe`
 * -----------------------------------------------------------
 * This is the part that is easy to get subtly wrong, and getting it wrong
 * doubles the sky.
 *
 * In r0.185.1, `lights_fragment_end` merges `irradiance += iblIrradiance` only
 * `#if defined( LAMBERT ) || defined( PHONG )`. For a `MeshStandardMaterial`
 * that branch is compiled out: `iblIrradiance` reaches the diffuse result
 * *exclusively* through `RE_IndirectSpecular_Physical`, which divides it by pi
 * and applies it with the multiple-scattering energy compensation
 * (`lights_physical_pars_fragment`, the `cosineWeightedIrradiance` lines).
 *
 * A scene `LightProbe` does something different: it lands in `irradiance` at
 * `lights_fragment_begin` and flows through `RE_IndirectDiffuse_Physical`. Both
 * paths are live at once. Adding a probe AND injecting here would light the
 * hull with the sky twice — a mistake that looks like "the new pipeline is a
 * bit bright" rather than like a bug. Hence: no `LightProbe` anywhere in the
 * scene, coefficients as a uniform, one path.
 *
 * The difference the compensation term itself makes is small — a few percent on
 * rough dielectric timber. It is taken because it is correct and free, not
 * because it is the answer to anything. Nothing about how dark the hull looks
 * is decided in this file.
 */

/**
 * TERM DIAGNOSTICS
 * ----------------
 * The debug views below are the other half of the same argument. Every "she
 * reads too dark" verdict this project has taken was an impression about a
 * finished picture, and the answer to an impression is always another
 * multiplier. A finished picture is four terms added together; if you can look
 * at them one at a time, the question stops being "is she too dark" and becomes
 * "which term is missing, and who owns it" — and each of those four has exactly
 * one owner: the sun, the PMREM, the SH probe, the paint.
 *
 * They live here for the same reason the surgery does. `Ocean.ts` proved the
 * pattern (`OCEAN_DEBUG_VIEW`): a `#define` so the shipping program is
 * byte-identical with the diagnostics off, and a uniform so switching between
 * them costs nothing.
 */

/**
 * The line in three's own chunk that this adapter rewrites.
 *
 * Matched against the installed `ShaderChunk` at runtime rather than copied, so
 * the modified chunk is always derived from whatever three actually ships. A
 * three upgrade that renames or restructures this either keeps the anchor — in
 * which case the transform still applies — or loses it, in which case
 * `worldLightsFragmentMaps` throws at startup and a test fails first. What must
 * never happen is silent reversion to three's coupled irradiance, which would
 * look like a mild regression and be diagnosed for a week.
 */
export const IBL_IRRADIANCE_ANCHOR = 'iblIrradiance += getIBLIrradiance( geometryNormal );';

/**
 * The guard that makes the injection site safe.
 *
 * `iblIrradiance` must NOT be merged into `irradiance` for physical materials.
 * If a future three drops this guard, the injection below starts double-
 * counting and the fix is to stop injecting, not to scale something down.
 */
export const PHYSICAL_IRRADIANCE_GUARD = '#if defined( LAMBERT ) || defined( PHONG )';

const LOCAL_DIFFUSE_BOUNCE_DEFINE = 'WORLD_PBR_LOCAL_DIFFUSE_BOUNCE';
const PORTAL_LIGHT_DEFINE = 'WORLD_PBR_PORTAL_LIGHT';
const TIMBER_GRAIN_DEFINE = 'WORLD_PBR_TIMBER_GRAIN';
/** Set to the site COUNT, so it doubles as the wear array's size. */
const TIMBER_WEAR_DEFINE = 'WORLD_PBR_TIMBER_WEAR';

/**
 * Channels the portal-light path carries. One per family of ship opening.
 *
 * Four of them ride three `vec4` attributes; the fifth rides `aPortalChannel4`,
 * one channel to its three components. See `interiorLightBake.ts` for why the
 * fifth packs sideways rather than widening the other three.
 */
export const PORTAL_LIGHT_CHANNELS = 5;

/** How many of them the `vec4` attributes carry. The rest ride the `vec3`. */
export const PORTAL_LIGHT_PACKED_CHANNELS = 4;

/**
 * Slots in the room-lift uniform array: slot 0 is outdoors and is pinned at
 * exactly 1, the rest are rooms in the vessel's `LIGHT_ROOM_ORDER`. This file
 * deliberately does not import that list — the scene module knows only "an
 * indexed set of lift dials"; which slot is the captain's cabin is the
 * vessel's business, and a test holds the two counts together.
 */
export const PORTAL_LIGHT_ROOM_SLOTS = 6;

const WORLD_SH_INJECTION = /* glsl */ `
vec3 worldGeometryNormal = transformNormalByInverseViewMatrix( geometryNormal, viewMatrix );
#ifdef ${PORTAL_LIGHT_DEFINE}
  // Enclosure, per vertex. The bake writes how much open sky this surface
  // actually sees (an interior vertex sees none; a masthead sees all of it)
  // and what arrives through each of the ship's openings instead. uPortalMix
  // is the live A/B: 0 restores the legacy constant-skyVisibility model in
  // the same frame, because a lighting verdict is only valid under the
  // transform it was taken through.
  float worldSkyVisibility = mix( uSkyVisibility, vWorldSkyVisibility, uPortalMix );
  iblIrradiance += worldSkyVisibility * shGetIrradianceAt( worldGeometryNormal, uWorldSh );
  vec3 worldPortalLight =
    vWorldPortalDirect.x * uPortalIrradiance[ 0 ] +
    vWorldPortalDirect.y * uPortalIrradiance[ 1 ] +
    vWorldPortalDirect.z * uPortalIrradiance[ 2 ] +
    vWorldPortalDirect.w * uPortalIrradiance[ 3 ] +
    vWorldPortalBounce.x * uPortalBounce[ 0 ] +
    vWorldPortalBounce.y * uPortalBounce[ 1 ] +
    vWorldPortalBounce.z * uPortalBounce[ 2 ] +
    vWorldPortalBounce.w * uPortalBounce[ 3 ] +
    vWorldPortalChannel4.x * uPortalIrradiance[ 4 ] +
    vWorldPortalChannel4.y * uPortalBounce[ 4 ];
  // The room lift scales only what came through the openings — the sky seen
  // THROUGH a window is not a portal-lit surface and renders at the scene's
  // own exposure, which is the whole design: lit rooms, honest sky. The sun's
  // shadow-mapped beam and the lantern arrive through three's light loop, not
  // this sum, so neither is lifted.
  iblIrradiance += uPortalMix * vWorldRoomLift * worldPortalLight;
#else
  iblIrradiance += uSkyVisibility * shGetIrradianceAt( worldGeometryNormal, uWorldSh );
#endif
#ifdef ${LOCAL_DIFFUSE_BOUNCE_DEFINE}
  // A uniform lower-hemisphere radiator is the low-frequency form of light
  // returned by a nearby floor or deck. Its cosine-convolved irradiance is
  // zero on an upward face, half on a vertical face and full underneath.
  float localBounceWeight = clamp(
    0.5 * ( 1.0 - dot( worldGeometryNormal, normalize( uLocalBounceUpWorld ) ) ),
    0.0,
    1.0
  );
  #ifdef ${PORTAL_LIGHT_DEFINE}
    // The deck bounce is an OUTDOOR term: light the sunlit planking returns
    // at nearby timber. A fitting's underside below that planking cannot
    // receive it — without this gate the mast partners glowed with deck
    // light through the deckhead (§15.5 item 5's second half). Scaled by the
    // baked sky visibility through the A/B mix, so legacy mode is untouched.
    localBounceWeight *= mix( 1.0, vWorldSkyVisibility, uPortalMix );
  #endif
  iblIrradiance += uLocalBounceIrradiance * localBounceWeight;
#endif`;

/**
 * The glossy environment line, scaled by the same enclosure term.
 *
 * The legacy model never touched specular: an interior plank kept reflecting
 * the open-sky PMREM at full strength, a sheen the room has no access to. The
 * portal path scales it with the baked sky visibility — through the A/B mix,
 * so mode 0 reproduces the legacy picture exactly. Only the reflection of the
 * *distant* environment is scaled; direct specular from the sun and the
 * lantern is untouched, which is what a lantern glinting off varnished oak
 * needs.
 */
export const IBL_RADIANCE_ANCHOR =
  'radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );';

const WORLD_RADIANCE_INJECTION = /* glsl */ `
#ifdef ${PORTAL_LIGHT_DEFINE}
  radiance += mix( 1.0, vWorldSkyVisibility, uPortalMix ) * getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
#else
  radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
#endif`;

/** Vertex-stage pass-through of the baked portal attributes. */
export const BEGIN_VERTEX_ANCHOR = '#include <begin_vertex>';

const PORTAL_VERTEX_INJECTION = /* glsl */ `
#ifdef ${PORTAL_LIGHT_DEFINE}
  vWorldPortalDirect = aPortalDirect;
  // The bath gradient A/B, mixed at the vertex where both bakes live: 0 is
  // the flat room-mean bath, 1 the spatially reshaped one. Same varyings,
  // same fragment cost either way.
  vWorldPortalBounce = mix( aPortalBounce, aPortalBounceGradient, uBathGradientMix );
  // The fifth channel, through the same gradient mix, collapsing its three
  // packed components to the two the fragment sum wants.
  vWorldPortalChannel4 = vec2(
    aPortalChannel4.x,
    mix( aPortalChannel4.y, aPortalChannel4.z, uBathGradientMix )
  );
  vWorldSkyVisibility = aSkyVisibility;
  // The room lift, resolved here where the index attribute lives and carried
  // down as one float. uRoomLiftMix 0 pins the factor at exactly 1.0 — the
  // three camera modes render through it untouched — and interpolation across
  // a doorway's triangles is a feature: the blend seam sits where the light
  // seam already does.
  vWorldRoomLift = mix( 1.0, uRoomLift[ int( aRoomIndex + 0.5 ) ], uRoomLiftMix );
#endif`;

const PORTAL_VERTEX_DECLARATIONS =
  `#ifdef ${PORTAL_LIGHT_DEFINE}\n` +
  'attribute vec4 aPortalDirect;\n' +
  'attribute vec4 aPortalBounce;\n' +
  'attribute vec4 aPortalBounceGradient;\n' +
  'attribute vec3 aPortalChannel4;\n' +
  'attribute float aSkyVisibility;\n' +
  'attribute float aRoomIndex;\n' +
  'uniform float uBathGradientMix;\n' +
  `uniform float uRoomLift[ ${PORTAL_LIGHT_ROOM_SLOTS} ];\n` +
  'uniform float uRoomLiftMix;\n' +
  'varying vec4 vWorldPortalDirect;\n' +
  'varying vec4 vWorldPortalBounce;\n' +
  'varying vec2 vWorldPortalChannel4;\n' +
  'varying float vWorldSkyVisibility;\n' +
  'varying float vWorldRoomLift;\n' +
  '#endif\n';

const PORTAL_FRAGMENT_DECLARATIONS =
  `#ifdef ${PORTAL_LIGHT_DEFINE}\n` +
  `uniform vec3 uPortalIrradiance[ ${PORTAL_LIGHT_CHANNELS} ];\n` +
  `uniform vec3 uPortalBounce[ ${PORTAL_LIGHT_CHANNELS} ];\n` +
  'uniform float uPortalMix;\n' +
  'varying vec4 vWorldPortalDirect;\n' +
  'varying vec4 vWorldPortalBounce;\n' +
  'varying vec2 vWorldPortalChannel4;\n' +
  'varying float vWorldSkyVisibility;\n' +
  'varying float vWorldRoomLift;\n' +
  '#endif\n';

// --- procedural timber grain --------------------------------------------------

/**
 * Where the grain is applied: after three has resolved the vertex-colour
 * `diffuseColor` and declared `roughnessFactor`, and before
 * `lights_physical_fragment` consumes either.
 *
 * Both of those matter. Applied before `<color_fragment>` there would be no
 * albedo to modulate; applied after `<lights_physical_fragment>` the roughness
 * has already been folded into `material` and moving it does nothing — which
 * fails silently and looks like a grain that only affects colour.
 */
export const TIMBER_GRAIN_ANCHOR = '#include <metalnessmap_fragment>';

/**
 * One wear mark, in the object's own frame.
 *
 * `radiusM` and `strength` are separate because they answer different
 * questions — how far the mark reaches, and whether the wood there is
 * burnished dark by hands or scuffed pale by feet. They travel packed into one
 * `vec4` as `(x, y, z, sign(strength) * radiusM)`, with the magnitude carried
 * by a per-material scalar, because a uniform array is the expensive thing here
 * and a second one would double it for a number that is constant per timber.
 */
export interface TimberWearSite {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radiusM: number;
  /** Positive burnishes (hands), negative scuffs (feet). Magnitude 0–1. */
  readonly strength: number;
}

export interface TimberGrainSpec {
  /** Board-to-board tone, ± as a fraction of albedo. */
  readonly board: number;
  /** Figure along the board, ± as a fraction of albedo. */
  readonly figure: number;
  /** Warm/cool swing carried with the figure, ± as a fraction. */
  readonly chroma: number;
  /** Roughness swing carried with the figure, absolute. */
  readonly roughness: number;
  readonly boardWidthM: number;
  readonly acrossPerM: number;
  readonly alongPerM: number;
  /** True for a mast or a stanchion; false for planking and lining. */
  readonly verticalRun: boolean;
  /** Phase, 0–1, so two timbers meeting at a corner share no board edge. */
  readonly seed: number;
  /** How hard the wear sites bite on this wood, 0–1. 0 compiles wear out. */
  readonly wear: number;
  readonly sites: readonly TimberWearSite[];
}

/**
 * The grain, and why it is a *procedure* rather than a texture.
 *
 * This project has no asset pipeline and does not want one: the hull is an
 * analytic surface, the clouds are marched, the sails are lofted, and a folder
 * of PNGs would be the first thing in the game that could not be re-derived.
 * So the figure is noise, and the only real design question is what to key it
 * to. Screen space crawls. World space slides as the ship moves. UVs do not
 * exist — `SurfaceBuilder` writes position, normal and colour and nothing else.
 *
 * OBJECT SPACE, RESOLVED INTO THE BOARD'S OWN FRAME
 * -------------------------------------------------
 * Every mesh on this ship is built directly in the vessel's frame with no
 * per-mesh transform, so `position` IS the ship frame: it rides with her,
 * through every roll, without a matrix. The board frame is then derived at the
 * fragment: the run axis is the ship's fore-and-aft (planking, lining, sole and
 * every fitting on this ship is laid fore-and-aft), the across axis is
 * `cross(normal, run)`, and a face whose normal *is* the run axis — a transom,
 * a bulkhead, the end of a plank — swaps to the athwartships run, which is how
 * those are actually planked.
 *
 * That resolution is what makes the same three numbers work on a deck, a wall
 * and the underside of a beam. Grain runs ALONG a board, so the noise is fine
 * across the run and stretched down it — `acrossPerM` is 20–28 cycles a metre
 * and `alongPerM` is under one.
 */
const TIMBER_FRAGMENT_DECLARATIONS = /* glsl */ `
uniform vec4 uTimberFigure;
uniform vec4 uTimberScale;
uniform vec2 uTimberRun;
varying vec3 vTimberPosition;
varying vec3 vTimberNormal;
#ifdef ${TIMBER_WEAR_DEFINE}
uniform vec4 uTimberWear[ ${TIMBER_WEAR_DEFINE} ];
#endif

float worldTimberHash( vec3 p ) {
  p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}

float worldTimberNoise( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix(
      mix( worldTimberHash( i + vec3( 0.0, 0.0, 0.0 ) ), worldTimberHash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
      mix( worldTimberHash( i + vec3( 0.0, 1.0, 0.0 ) ), worldTimberHash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ),
      f.y ),
    mix(
      mix( worldTimberHash( i + vec3( 0.0, 0.0, 1.0 ) ), worldTimberHash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
      mix( worldTimberHash( i + vec3( 0.0, 1.0, 1.0 ) ), worldTimberHash( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ),
      f.y ),
    f.z );
}
`;

const TIMBER_FRAGMENT_INJECTION = /* glsl */ `
{
  vec3 timberN = normalize( vTimberNormal );
  vec3 timberRun = mix( vec3( 0.0, 0.0, 1.0 ), vec3( 0.0, 1.0, 0.0 ), uTimberRun.x );
  vec3 timberCross = mix( vec3( 1.0, 0.0, 0.0 ), vec3( 0.0, 0.0, 1.0 ), uTimberRun.x );
  timberRun = mix( timberRun, timberCross, step( 0.7, abs( dot( timberN, timberRun ) ) ) );
  vec3 timberAcross = cross( timberN, timberRun );
  float timberAcrossLen = length( timberAcross );
  timberAcross = timberAcrossLen > 1e-3 ? timberAcross / timberAcrossLen : timberCross;
  float timberAlong = dot( vTimberPosition, timberRun );
  float timberOff = dot( vTimberPosition, timberAcross );

  float timberBoard = floor( timberOff / uTimberScale.x + uTimberScale.w );
  float timberBoardTone = worldTimberHash( vec3( timberBoard, uTimberScale.w, 3.1 ) ) - 0.5;
  vec3 timberP = vec3(
    timberOff * uTimberScale.y,
    timberAlong * uTimberScale.z,
    timberBoard * 5.7 + uTimberScale.w
  );
  // Two octaves. The fine one is the figure; the coarse one, four times
  // longer, is what stops a fifteen-metre run of lining reading as one texture
  // tiled — which is the failure a single octave always has at this scale.
  float timberFigure =
    worldTimberNoise( timberP ) * 0.62 + worldTimberNoise( timberP * 0.23 ) * 0.38 - 0.5;

  float timberTone = 1.0
    + uTimberFigure.x * timberBoardTone * 2.0
    + uTimberFigure.y * timberFigure * 2.0;
  // Late wood is darker AND warmer, so the chroma swing rides the figure with
  // the opposite sign to brightness. A red/blue tilt at constant green: a
  // warm/cool move that barely touches luminance, which matters because
  // luminance is the one thing this round holds fixed.
  float timberWarm = -uTimberFigure.z * timberFigure * 2.0;
  float timberRough = uTimberFigure.w * timberFigure * 2.0;

#ifdef ${TIMBER_WEAR_DEFINE}
  float timberWear = 0.0;
  for ( int i = 0; i < ${TIMBER_WEAR_DEFINE}; i++ ) {
    vec4 site = uTimberWear[ i ];
    float reach = 1.0 - smoothstep( 0.0, abs( site.w ), distance( vTimberPosition, site.xyz ) );
    timberWear += sign( site.w ) * reach * reach;
  }
  timberWear = clamp( timberWear, -1.0, 1.0 ) * uTimberRun.y;
  // Burnished by hands goes darker and smoother; scuffed by feet goes paler
  // and rougher. Same term, opposite signs, which is why the sites are signed.
  timberTone *= 1.0 - 0.16 * timberWear;
  timberRough -= 0.20 * timberWear;
#endif

  diffuseColor.rgb *= timberTone * vec3( 1.0 + timberWarm, 1.0, 1.0 - timberWarm );
  roughnessFactor = clamp( roughnessFactor + timberRough, 0.04, 1.0 );
}`;

const TIMBER_VERTEX_DECLARATIONS =
  'varying vec3 vTimberPosition;\nvarying vec3 vTimberNormal;\n';

/**
 * `objectNormal` and not `normal`: the grain has to resolve the board's frame
 * from the surface's own orientation in the ship, and `normal` by this point
 * is on its way to view space. `<beginnormal_vertex>` runs before
 * `<begin_vertex>`, so both are in scope here.
 */
const TIMBER_VERTEX_INJECTION = /* glsl */ `
  vTimberPosition = position;
  vTimberNormal = objectNormal;`;

interface TimberUniforms {
  uTimberFigure: THREE.IUniform<THREE.Vector4>;
  uTimberScale: THREE.IUniform<THREE.Vector4>;
  uTimberRun: THREE.IUniform<THREE.Vector2>;
  uTimberWear?: THREE.IUniform<THREE.Vector4[]>;
}

/**
 * Give a world material procedural timber grain.
 *
 * Called after construction rather than passed to the factory, because the
 * thing that decides a material is timber is the vessel's palette policy and
 * the factory is scene-level: `WorldPbrMaterial` knows how to draw grain and
 * has no idea what a companionway coaming is.
 *
 * Uniform objects are per material and are NOT shared: six timbers carry six
 * different figures, and one shared object would give the whole ship the last
 * one written. The define splits three's own program cache, which is what
 * keeps a material without grain compiling the shader it compiled before.
 */
export function applyTimberGrain(
  material: THREE.MeshStandardMaterial,
  spec: TimberGrainSpec,
): void {
  const uniforms: TimberUniforms = {
    uTimberFigure: {
      value: new THREE.Vector4(
        spec.board,
        spec.figure,
        spec.chroma,
        spec.roughness,
      ),
    },
    uTimberScale: {
      value: new THREE.Vector4(
        Math.max(spec.boardWidthM, 1e-3),
        spec.acrossPerM,
        spec.alongPerM,
        spec.seed,
      ),
    },
    uTimberRun: {
      value: new THREE.Vector2(spec.verticalRun ? 1 : 0, spec.wear),
    },
  };
  material.defines ??= {};
  material.defines[TIMBER_GRAIN_DEFINE] = '';
  if (spec.wear > 0 && spec.sites.length > 0) {
    material.defines[TIMBER_WEAR_DEFINE] = String(spec.sites.length);
    uniforms.uTimberWear = {
      value: spec.sites.map(
        (site) =>
          new THREE.Vector4(
            site.x,
            site.y,
            site.z,
            Math.sign(site.strength) * site.radiusM,
          ),
      ),
    };
  }
  material.userData.timberGrain = uniforms;
  material.needsUpdate = true;
}

/** Whether a material draws grain. For the tests and the inspection probe. */
export function isTimberGrainMaterial(material: THREE.Material): boolean {
  return material.defines !== undefined && TIMBER_GRAIN_DEFINE in material.defines;
}

/**
 * Splice the grain into a physical fragment shader. Exported for the drift
 * test, like `worldLightsFragmentMaps`.
 */
export function timberGrainFragmentShader(fragmentShader: string): string {
  if (!fragmentShader.includes(TIMBER_GRAIN_ANCHOR)) {
    throw new Error(
      `WorldPbrMaterial: three's physical fragment shader no longer contains ` +
        `"${TIMBER_GRAIN_ANCHOR}". The timber grain has to modulate albedo and ` +
        'roughness between the point they are resolved and the point the light ' +
        'loop consumes them; spliced anywhere else it silently draws nothing.',
    );
  }
  return fragmentShader.replace(
    TIMBER_GRAIN_ANCHOR,
    TIMBER_GRAIN_ANCHOR + TIMBER_FRAGMENT_INJECTION,
  );
}

/** Cache key. Distinguishes these programs from stock standard materials. */
const PROGRAM_CACHE_KEY = 'world-pbr-5';

/**
 * Three's `lights_fragment_maps`, with environment irradiance replaced by the
 * world probe and environment radiance scaled by baked enclosure.
 *
 * Exported for the drift test.
 */
export function worldLightsFragmentMaps(): string {
  const chunk = THREE.ShaderChunk.lights_fragment_maps;
  if (!chunk.includes(IBL_IRRADIANCE_ANCHOR)) {
    throw new Error(
      'WorldPbrMaterial: three\'s lights_fragment_maps no longer contains the ' +
        'environment-irradiance line this adapter rewrites. The world lighting ' +
        'path must be re-derived against the new chunk before it can be trusted.',
    );
  }
  if (!chunk.includes(IBL_RADIANCE_ANCHOR)) {
    throw new Error(
      'WorldPbrMaterial: three\'s lights_fragment_maps no longer contains the ' +
        'environment-radiance line the portal path scales. An interior surface ' +
        'reflecting the full open-sky PMREM is the fault this scaling removes; ' +
        're-derive against the new chunk rather than shipping it back.',
    );
  }
  if (!THREE.ShaderChunk.lights_fragment_end.includes(PHYSICAL_IRRADIANCE_GUARD)) {
    throw new Error(
      'WorldPbrMaterial: three\'s lights_fragment_end no longer guards ' +
        '"irradiance += iblIrradiance" to LAMBERT/PHONG. Injecting the world ' +
        'probe into iblIrradiance would now double-count sky diffuse.',
    );
  }
  return chunk
    .replace(IBL_IRRADIANCE_ANCHOR, WORLD_SH_INJECTION)
    .replace(IBL_RADIANCE_ANCHOR, WORLD_RADIANCE_INJECTION);
}

// --- term diagnostics --------------------------------------------------------

/**
 * Where the display-referred terms are substituted: three's own line in
 * `meshphysical`'s main, immediately before the tone curve runs.
 *
 * An include directive in the material's fragment source rather than a
 * `ShaderChunk`, because that is where the ordering lives — the fact that
 * `opaque_fragment` composes `gl_FragColor` and `tonemapping_fragment` then
 * transforms it is a property of this shader's main, not of either chunk. The
 * anchors are asserted in `tests/world-lighting.test.ts` against
 * `THREE.ShaderLib.physical.fragmentShader` for the same reason the irradiance
 * anchor is: a three upgrade that moves them must fail loudly here rather than
 * quietly produce a diagnostic that photographs the wrong thing.
 */
export const OPAQUE_FRAGMENT_ANCHOR = '#include <opaque_fragment>';

/** The last line of main, after tone curve, colour transform, fog and dither. */
export const DITHERING_FRAGMENT_ANCHOR = '#include <dithering_fragment>';

/** Enables the diagnostic branches. Absent on every shipping compile. */
const WORLD_DEBUG_DEFINE = 'WORLD_PBR_DEBUG';

export type WorldDebugView =
  | 'off'
  | 'direct-diffuse'
  | 'direct-specular'
  | 'indirect-diffuse'
  | 'indirect-specular'
  | 'normals'
  | 'albedo'
  | 'linear';

export interface WorldDebugViewInfo {
  view: WorldDebugView;
  /** The value the shader branches on. Order matters: the branches are ranges. */
  code: number;
  label: string;
  /**
   * What a pixel in this view MEANS.
   *
   * Carried as data rather than left in a comment because it is printed onto
   * the diagnostic sheet. A debug image whose units nobody can state is how a
   * diagnostic becomes another impression.
   */
  meaning: string;
}

/**
 * The seven views the design asked for, plus off.
 *
 * TWO FAMILIES, AND THE SPLIT IS THE WHOLE POINT.
 *
 * Codes 1-4 are the four `ReflectedLight` accumulators — scene-referred
 * radiance, exactly as the beauty frame's own terms. They are substituted
 * BEFORE the tone curve and so travel the ordinary path: same exposure, same
 * shoulder, same colour transform. What you see is that term's actual
 * contribution to the finished picture, laid beside the finished picture at the
 * same scale. Route them around the curve instead and every comparison with the
 * frame they came from needs a mental transform nobody performs correctly.
 *
 * Codes 5-7 are written AFTER everything, so the number the shader computed is
 * the number in the framebuffer. Normals and albedo are already display-
 * referred and an exposure of 0.3 would make nonsense of both; `linear` is the
 * one that is explicitly about what the curve did, so passing it through the
 * curve would be circular. Read them with a colour picker: 8-bit code / 255 is
 * the quantity.
 *
 * The sea and the sky keep rendering normally in every view — they are not
 * world PBR surfaces. That is deliberate: a term floating in the finished
 * world is legible, and the same hull cut out on black is not. `Ocean.ts` has
 * its own switch for when the water is the suspect.
 */
export const WORLD_DEBUG_VIEWS: readonly WorldDebugViewInfo[] = [
  { view: 'off', code: 0, label: 'off — beauty', meaning: 'the finished picture' },
  {
    view: 'direct-diffuse',
    code: 1,
    label: '1 · direct diffuse',
    meaning: 'sun and lantern on the paint · through the tone curve',
  },
  {
    view: 'direct-specular',
    code: 2,
    label: '2 · direct specular',
    meaning: 'sun and lantern glints · through the tone curve',
  },
  {
    view: 'indirect-diffuse',
    code: 3,
    label: '3 · indirect diffuse',
    meaning: 'the SH probe on the paint · through the tone curve',
  },
  {
    view: 'indirect-specular',
    code: 4,
    label: '4 · indirect specular',
    meaning: 'the PMREM reflection · through the tone curve',
  },
  {
    view: 'normals',
    code: 5,
    label: '5 · world normals',
    meaning: 'world normal * 0.5 + 0.5 · raw · +X red +Y green +Z blue',
  },
  {
    view: 'albedo',
    code: 6,
    label: '6 · albedo',
    meaning: 'linear reflectance · raw · code/255 is the number',
  },
  {
    view: 'linear',
    code: 7,
    label: '7 · pre-tonemap linear',
    meaning: 'outgoing radiance before exposure and curve · raw · x 2^stops',
  },
];

function debugViewInfo(view: WorldDebugView): WorldDebugViewInfo {
  const found = WORLD_DEBUG_VIEWS.find((entry) => entry.view === view);
  if (!found) throw new Error(`WorldPbrMaterial: unknown debug view "${view}".`);
  return found;
}

/**
 * The four accumulators, substituted before the tone curve.
 *
 * Read after `opaque_fragment` rather than before, so `aomap_fragment` has
 * already scaled the indirect pair: what is photographed is what reached the
 * pixel, not what the light loop proposed.
 */
const DISPLAY_REFERRED_DEBUG = /* glsl */ `
#ifdef ${WORLD_DEBUG_DEFINE}
  if ( uWorldDebugView > 0.5 && uWorldDebugView < 4.5 ) {
    vec3 worldDebugTerm = reflectedLight.directDiffuse;
    if ( uWorldDebugView > 3.5 )      worldDebugTerm = reflectedLight.indirectSpecular;
    else if ( uWorldDebugView > 2.5 ) worldDebugTerm = reflectedLight.indirectDiffuse;
    else if ( uWorldDebugView > 1.5 ) worldDebugTerm = reflectedLight.directSpecular;
    gl_FragColor = vec4( worldDebugTerm, gl_FragColor.a );
  }
#endif`;

/**
 * The three raw views, written past the end of the display path.
 *
 * `geometryNormal` and not `normal`: the diagnostic must show the normal the
 * lighting was actually evaluated with, or it answers a question about a
 * different shader.
 */
const SCENE_REFERRED_DEBUG = /* glsl */ `
#ifdef ${WORLD_DEBUG_DEFINE}
  if ( uWorldDebugView > 4.5 ) {
    vec3 worldDebugRaw = diffuseColor.rgb;
    if ( uWorldDebugView < 5.5 ) {
      worldDebugRaw = transformNormalByInverseViewMatrix( geometryNormal, viewMatrix ) * 0.5 + 0.5;
    } else if ( uWorldDebugView > 6.5 ) {
      worldDebugRaw = outgoingLight * exp2( uWorldDebugStops );
    }
    gl_FragColor = vec4( worldDebugRaw, gl_FragColor.a );
  }
#endif`;

/**
 * Splice both diagnostic blocks into a physical fragment shader.
 *
 * Exported for the drift test, like `worldLightsFragmentMaps`.
 */
export function worldDebugFragmentShader(fragmentShader: string): string {
  for (const anchor of [OPAQUE_FRAGMENT_ANCHOR, DITHERING_FRAGMENT_ANCHOR]) {
    if (fragmentShader.includes(anchor)) continue;
    throw new Error(
      `WorldPbrMaterial: three's physical fragment shader no longer contains ` +
        `"${anchor}". The term diagnostics cannot be positioned relative to the ` +
        'tone curve, and a debug view photographed at the wrong point in the ' +
        'chain is worse than none.',
    );
  }
  return fragmentShader
    .replace(OPAQUE_FRAGMENT_ANCHOR, OPAQUE_FRAGMENT_ANCHOR + DISPLAY_REFERRED_DEBUG)
    .replace(DITHERING_FRAGMENT_ANCHOR, DITHERING_FRAGMENT_ANCHOR + SCENE_REFERRED_DEBUG);
}

/**
 * One shared uniform object per control, exactly as the SH coefficients are.
 *
 * Three hands `shader.uniforms` straight through to the compiled program's
 * uniform map and reads `.value` off it every frame, so mutating the one object
 * publishes to every material at once and none can be left a mode behind.
 */
const worldDebugViewUniform: THREE.IUniform<number> = { value: 0 };
const worldDebugStopsUniform: THREE.IUniform<number> = { value: 0 };

/**
 * Live world materials, so a mode change can flip the define on all of them.
 *
 * The registry exists only because the define is a compile-time switch; the
 * uniform needs no such thing. Entries remove themselves on dispose (see the
 * factory) so a lab that builds and drops materials cannot grow the set without
 * bound.
 */
const worldMaterials = new Set<THREE.MeshStandardMaterial>();

let activeDebugView: WorldDebugView = 'off';

export function getWorldDebugView(): WorldDebugView {
  return activeDebugView;
}

/** True when any world surface is drawing a diagnostic rather than a picture. */
export function isWorldDebugViewActive(): boolean {
  return activeDebugView !== 'off';
}

/**
 * Select a term view for every world PBR surface at once.
 *
 * Recompiles only on the off/on transition, because that is the only thing the
 * define changes; stepping between the seven views is a uniform write.
 */
export function setWorldDebugView(view: WorldDebugView): void {
  const info = debugViewInfo(view);
  activeDebugView = view;
  worldDebugViewUniform.value = info.code;

  const wanted = info.code > 0;
  for (const material of worldMaterials) {
    const defines = material.defines;
    if (!defines) continue;
    if (wanted === (WORLD_DEBUG_DEFINE in defines)) continue;
    if (wanted) defines[WORLD_DEBUG_DEFINE] = '';
    else delete defines[WORLD_DEBUG_DEFINE];
    material.needsUpdate = true;
  }
}

/**
 * Stops of gain on the `linear` view only.
 *
 * A power of two and nothing else, so it is exactly invertible: the picture
 * still reports a number, you just divide it back. It exists because the raw
 * outgoing radiance of a tarred hull at night is a handful of thousandths and
 * an 8-bit framebuffer renders that as black — which is indistinguishable from
 * the term being absent, and telling those two apart is the entire job. It does
 * NOT apply to the four accumulator views: those already carry the scene's own
 * exposure, and a second gain on top would make them incomparable with the
 * beauty frame they exist to be compared with.
 */
export function setWorldDebugStops(stops: number): void {
  worldDebugStopsUniform.value = stops;
}

export function getWorldDebugStops(): number {
  return worldDebugStopsUniform.value;
}

/**
 * The live SH coefficients, shared by every material this factory makes.
 *
 * One set of `Vector3` objects handed to every compiled program, mutated in
 * place by `setWorldSh`. Publishing new light is then O(9) regardless of how
 * many materials exist, and no material can be accidentally left a generation
 * behind — there is only one generation to be on.
 */
const worldShUniform: THREE.Vector3[] = Array.from(
  { length: SH_COEFFICIENT_COUNT },
  () => new THREE.Vector3(),
);

/** Publish a generation of world lighting to every world material at once. */
export function setWorldSh(coefficients: ArrayLike<number>): void {
  for (let i = 0; i < SH_COEFFICIENT_COUNT; i++) {
    worldShUniform[i].set(
      coefficients[i * 3],
      coefficients[i * 3 + 1],
      coefficients[i * 3 + 2],
    );
  }
}

/**
 * The world probe's cosine-convolved irradiance at a world direction, off the
 * same coefficients every shader reads.
 *
 * The mirror of the `shGetIrradianceAt` chunk, evaluated CPU-side so the
 * portal channels sample exactly the light the walls do — including whatever
 * probe gain the environment runtime published. The constants are three's own
 * (see `sphericalHarmonics.ts` for why they must not be "fixed").
 */
export function sampleWorldShIrradiance(
  direction: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  const { x, y, z } = direction;
  const sh = worldShUniform;
  out.copy(sh[0]).multiplyScalar(0.886227);
  out.addScaledVector(sh[1], 2.0 * 0.511664 * y);
  out.addScaledVector(sh[2], 2.0 * 0.511664 * z);
  out.addScaledVector(sh[3], 2.0 * 0.511664 * x);
  out.addScaledVector(sh[4], 2.0 * 0.429043 * x * y);
  out.addScaledVector(sh[5], 2.0 * 0.429043 * y * z);
  out.addScaledVector(sh[6], 0.743125 * z * z - 0.247708);
  out.addScaledVector(sh[7], 2.0 * 0.429043 * x * z);
  out.addScaledVector(sh[8], 0.429043 * (x * x - y * y));
  out.x = Math.max(out.x, 0);
  out.y = Math.max(out.y, 0);
  out.z = Math.max(out.z, 0);
  return out;
}

/**
 * The portal channels' sky sampler: the world source MAP integrated
 * directly (`WorldLighting.sourceIrradiance`), injected here by the
 * environment runtime so the vessel stays scene-agnostic.
 *
 * History matters for reading this: it was built to fix a suspected L2
 * starvation of the dusk sky, and its first measurement REFUTED that — map
 * and SH agree within ~2% on the real sky at every hour tried (§17.6); the
 * dusk-dark cabin is honest hemisphere-vs-pane composition. It ships as the
 * default anyway because it is exact where the basis can be made to lie (a
 * compact spike inflates L2 anti-solar irradiance ~1.8× — see the tests),
 * and the 'sh' side of the A/B is the proof of equivalence, kept live. The
 * sampler returns false while it has nothing published, and the SH answers
 * instead.
 */
export type PortalSkySource = 'map' | 'sh';

type PortalSkySampler = (direction: THREE.Vector3, out: THREE.Vector3) => boolean;

let portalSkySampler: PortalSkySampler | null = null;
let portalSkySource: PortalSkySource = 'map';

export function setPortalSkySampler(sampler: PortalSkySampler | null): void {
  portalSkySampler = sampler;
}

export function setPortalSkySource(source: PortalSkySource): void {
  portalSkySource = source;
}

export function getPortalSkySource(): PortalSkySource {
  return portalSkySource;
}

/**
 * Irradiance arriving on a portal plane facing `direction`: the source map
 * when available and selected, the SH reconstruction otherwise. One entry
 * point so the A/B is a true same-frame switch and the fallback is the same
 * code path as the legacy side.
 */
export function samplePortalSkyIrradiance(
  direction: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  if (portalSkySource === 'map' && portalSkySampler?.(direction, out)) return out;
  return sampleWorldShIrradiance(direction, out);
}

/**
 * The portal-light channels, shared by every material that opts in — one
 * generation, mutated in place, exactly as the SH coefficients are.
 *
 * `irradiance` is what arrives on each opening's plane from the world;
 * `bounce` is the same light after the interior's timber has coloured it.
 * Who fills them and from what is the vessel's business (`Schooner.ts`);
 * this file only owns the plumbing that gets them to the fragments.
 */
const portalIrradianceUniform: THREE.Vector3[] = Array.from(
  { length: PORTAL_LIGHT_CHANNELS },
  () => new THREE.Vector3(),
);
const portalBounceUniform: THREE.Vector3[] = Array.from(
  { length: PORTAL_LIGHT_CHANNELS },
  () => new THREE.Vector3(),
);

/**
 * The live A/B between the portal model and the legacy constant.
 *
 * 1 is the portal model. 0 reproduces the old picture exactly — the
 * per-material `skyVisibility` constant back on the SH term, unscaled
 * environment reflection, and (via `Schooner.ts`) the companion spot relit —
 * in the same frame, no reload, because a lighting verdict is only valid
 * under the transform it was taken through.
 */
const portalMixUniform: THREE.IUniform<number> = { value: 1 };

/**
 * The bath-gradient A/B: 1 (default, Ash's call) reshapes each room's
 * ambient bath around where its light enters; 0 restores the flat room-mean
 * bath, same frame. Rides beside the portal mix and is judged under it.
 */
const bathGradientMixUniform: THREE.IUniform<number> = { value: 1 };

export function setBathGradientMix(mix: number): void {
  bathGradientMixUniform.value = Math.min(Math.max(mix, 0), 1);
}

export function getBathGradientMix(): number {
  return bathGradientMixUniform.value;
}

/** Publish one channel's portal light to every opted-in material at once. */
export function setPortalLight(
  channel: number,
  irradiance: THREE.Vector3,
  bounce: THREE.Vector3,
): void {
  portalIrradianceUniform[channel].copy(irradiance);
  portalBounceUniform[channel].copy(bounce);
}

/**
 * Whether a material carries the portal-light path — i.e. its fragments sum
 * the baked channel attributes against the live channel uniforms. The
 * inspection probe asks this to decide which decomposition a surface owes.
 */
export function isPortalLightMaterial(material: THREE.Material): boolean {
  return material.defines !== undefined && PORTAL_LIGHT_DEFINE in material.defines;
}

/**
 * Read one channel's live portal light back, for the inspection probe.
 *
 * Copies, not references: the probe decomposes a frame after the fact, and a
 * report that mutates when the next frame publishes is a report that lies.
 */
export function getPortalLight(channel: number): {
  irradiance: THREE.Vector3;
  bounce: THREE.Vector3;
} {
  return {
    irradiance: portalIrradianceUniform[channel].clone(),
    bounce: portalBounceUniform[channel].clone(),
  };
}

export function setPortalLightMix(mix: number): void {
  portalMixUniform.value = Math.min(Math.max(mix, 0), 1);
}

export function getPortalLightMix(): number {
  return portalMixUniform.value;
}

/**
 * The per-room daylight lift — the 'room-lift' adaptation mode's whole
 * mechanism.
 *
 * One fixed factor per room multiplying only the baked portal sum: the lie is
 * "the openings are bigger than they are", told on the walls and never on the
 * camera. The sky through a window, the sun's shadow-mapped beam and the
 * lantern all render at the scene's own exposure whatever these dials say —
 * which is what keeps night honest: a lifted room cannot un-darken the sky,
 * and ×4 of a moon-slither is still a slither.
 *
 * Deliberately NOT normalised against the current light level. A lift that
 * divides by the room's meter is the ×40-on-the-night-sky failure reborn on
 * the walls; these are constants Ash tunes in daylight, and night inherits
 * them untouched.
 */
const roomLiftUniform: THREE.IUniform<number[]> = {
  value: new Array<number>(PORTAL_LIGHT_ROOM_SLOTS).fill(1),
};

/**
 * The room-lift A/B: 1 applies the dials, 0 renders every portal surface at
 * exactly ×1 — the three camera-gain modes run through this at 0 and are
 * pixel-identical to the pre-lift picture. Owned by the vessel's mode switch,
 * not set directly by panels.
 */
const roomLiftMixUniform: THREE.IUniform<number> = { value: 0 };

/** One room's lift dial. Slot 0 is outdoors and refuses to move off 1. */
export function setRoomLift(slot: number, lift: number): void {
  if (!Number.isInteger(slot) || slot <= 0 || slot >= PORTAL_LIGHT_ROOM_SLOTS) return;
  roomLiftUniform.value[slot] = Math.min(Math.max(lift, 1), 100);
}

export function getRoomLift(slot: number): number {
  return roomLiftUniform.value[slot] ?? 1;
}

export function setRoomLiftMix(mix: number): void {
  roomLiftMixUniform.value = Math.min(Math.max(mix, 0), 1);
}

export function getRoomLiftMix(): number {
  return roomLiftMixUniform.value;
}

export interface WorldPbrParameters {
  color?: THREE.ColorRepresentation;
  roughness?: number;
  metalness?: number;
  vertexColors?: boolean;
  name?: string;
  /**
   * Irradiance returned by a nearby diffuse lower hemisphere.
   *
   * This is transport, not a material gain: `irradiance` already contains the
   * source light, the emitting surface's reflectance and its effective view
   * factor. `upWorld` orients that local hemisphere. The shader supplies only
   * the receiver's cosine integral — zero upward, half on a wall, full on an
   * underside — before the ordinary physical diffuse BRDF is applied.
   *
   * The vectors are retained by reference so a moving object can update one
   * allocation-free state shared by all of its participating materials.
   */
  localDiffuseBounce?: WorldPbrLocalDiffuseBounce;
  /**
   * How much of the sky this surface can actually see, 0–1. Default 1.
   *
   * **Not a look control, and specifically not the intensity knob the note
   * below forbids.** The world probe is a single spherical harmonic sampled from
   * the open sky, and every surface in the game receives all of it — which is
   * right for everything that has been in the game until now, because
   * everything has been outdoors. A room under a deck is the first surface that
   * is *enclosed*, and the model has no term for enclosure at all: the captain's
   * cabin came out lit exactly as brightly as the quarterdeck over it.
   *
   * With `portalLight` set this constant is only the LEGACY half of the live
   * A/B (`setPortalLightMix(0)`); the shipping value comes from the baked
   * per-vertex attributes instead. Without `portalLight` it works exactly as
   * it always did.
   */
  skyVisibility?: number;
  /**
   * Light this material by the baked portal attributes.
   *
   * The honest form of enclosure `skyVisibility` stood in for: per-vertex
   * `aSkyVisibility` scales the SH probe and the environment reflection, and
   * two vec4s of baked form factors bring daylight in through the ship's
   * openings on the four shared channels (`setPortalLight`).
   *
   * **Every geometry drawn with such a material MUST carry the three baked
   * attributes** (`interiorLightBake.ts` writes them). WebGL defaults an
   * unbound attribute to w = 1, which here would light a room with the hold's
   * channel — a bug that looks like moonlight. The bake asserts; do not rely
   * on the default.
   */
  portalLight?: boolean;
}

export interface WorldPbrLocalDiffuseBounce {
  readonly irradiance: THREE.Vector3;
  readonly upWorld: THREE.Vector3;
}

/**
 * Build a world-lit standard material.
 *
 * `envMapIntensity` is 1 and stays 1. It is not a look control; the only unit
 * conversion in the whole lighting system is the named sun constant in
 * `TimeOfDay`, and the day this factory grows an intensity parameter is the day
 * the coupling this file exists to remove comes back.
 */
export function createWorldPbrMaterial(
  parameters: WorldPbrParameters = {},
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: parameters.color ?? 0xffffff,
    roughness: parameters.roughness ?? 0.7,
    metalness: parameters.metalness ?? 0,
    vertexColors: parameters.vertexColors ?? false,
  });
  if (parameters.name) material.name = parameters.name;
  material.envMapIntensity = 1;

  // Per material, not shared: two materials with different sky visibility must
  // not point at one uniform object. They still share a compiled program —
  // this is a uniform rather than a define, so the cache key is untouched.
  const skyVisibility = { value: parameters.skyVisibility ?? 1 };
  material.userData.skyVisibility = skyVisibility;
  const localDiffuseBounce = parameters.localDiffuseBounce;
  if (localDiffuseBounce) {
    material.defines ??= {};
    material.defines[LOCAL_DIFFUSE_BOUNCE_DEFINE] = '';
  }
  const portalLight = parameters.portalLight === true;
  if (portalLight) {
    material.defines ??= {};
    material.defines[PORTAL_LIGHT_DEFINE] = '';
  }

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSkyVisibility = skyVisibility;
    shader.uniforms.uWorldSh = { value: worldShUniform };
    shader.uniforms.uWorldDebugView = worldDebugViewUniform;
    shader.uniforms.uWorldDebugStops = worldDebugStopsUniform;
    if (localDiffuseBounce) {
      shader.uniforms.uLocalBounceIrradiance = {
        value: localDiffuseBounce.irradiance,
      };
      shader.uniforms.uLocalBounceUpWorld = {
        value: localDiffuseBounce.upWorld,
      };
    }
    if (portalLight) {
      shader.uniforms.uPortalIrradiance = { value: portalIrradianceUniform };
      shader.uniforms.uPortalBounce = { value: portalBounceUniform };
      shader.uniforms.uPortalMix = portalMixUniform;
      shader.uniforms.uBathGradientMix = bathGradientMixUniform;
      shader.uniforms.uRoomLift = roomLiftUniform;
      shader.uniforms.uRoomLiftMix = roomLiftMixUniform;
      shader.vertexShader =
        PORTAL_VERTEX_DECLARATIONS +
        shader.vertexShader.replace(
          BEGIN_VERTEX_ANCHOR,
          BEGIN_VERTEX_ANCHOR + PORTAL_VERTEX_INJECTION,
        );
    }
    // Read off the material rather than off `parameters`: whether a surface is
    // timber is decided by the vessel's palette policy AFTER this factory has
    // returned, and `onBeforeCompile` does not run until the first render. The
    // splice is conditional and not `#ifdef`-guarded so that a session with the
    // switch off compiles the shader it compiled before this round, character
    // for character.
    const timber = material.userData.timberGrain as TimberUniforms | undefined;
    if (timber) {
      shader.uniforms.uTimberFigure = timber.uTimberFigure;
      shader.uniforms.uTimberScale = timber.uTimberScale;
      shader.uniforms.uTimberRun = timber.uTimberRun;
      if (timber.uTimberWear) shader.uniforms.uTimberWear = timber.uTimberWear;
      shader.vertexShader =
        TIMBER_VERTEX_DECLARATIONS +
        shader.vertexShader.replace(
          BEGIN_VERTEX_ANCHOR,
          BEGIN_VERTEX_ANCHOR + TIMBER_VERTEX_INJECTION,
        );
    }
    // The declarations go at global scope, not next to the injections: the
    // injection sites are inside main(), where a uniform declaration will not
    // compile. Three's own version and precision prologue is prepended after
    // this, so the top of the user shader is the right place.
    //
    // The diagnostic uniforms are declared under the same guard as the branches
    // that read them, so a shipping compile carries neither.
    shader.fragmentShader =
      'uniform float uSkyVisibility;\n' +
      `uniform vec3 uWorldSh[ ${SH_COEFFICIENT_COUNT} ];\n` +
      PORTAL_FRAGMENT_DECLARATIONS +
      `#ifdef ${LOCAL_DIFFUSE_BOUNCE_DEFINE}\n` +
      'uniform vec3 uLocalBounceIrradiance;\n' +
      'uniform vec3 uLocalBounceUpWorld;\n' +
      '#endif\n' +
      `#ifdef ${WORLD_DEBUG_DEFINE}\n` +
      'uniform float uWorldDebugView;\n' +
      'uniform float uWorldDebugStops;\n' +
      '#endif\n' +
      (timber ? TIMBER_FRAGMENT_DECLARATIONS : '') +
      worldDebugFragmentShader(
        timber
          ? timberGrainFragmentShader(
              shader.fragmentShader.replace(
                '#include <lights_fragment_maps>',
                worldLightsFragmentMaps(),
              ),
            )
          : shader.fragmentShader.replace(
              '#include <lights_fragment_maps>',
              worldLightsFragmentMaps(),
            ),
      );
  };
  // Without this three reuses one compiled program for every material that
  // shares its feature set — including stock standard materials elsewhere in
  // the scene, which must keep three's own irradiance. `material.defines` is
  // part of three's own key, so the diagnostic define splits the cache by
  // itself and does not belong here.
  material.customProgramCacheKey = () => PROGRAM_CACHE_KEY;

  // Defaulted rather than assumed: three seeds `MeshStandardMaterial.defines`
  // with STANDARD, but its own type says the field is optional and the registry
  // below reads it on every mode change.
  material.defines ??= {};
  if (isWorldDebugViewActive()) material.defines[WORLD_DEBUG_DEFINE] = '';
  worldMaterials.add(material);
  // Self-deregistering rather than asking every caller to remember, which keeps
  // the containment promise at the top of this file honest: nothing outside
  // this module has to know the registry exists.
  const disposeMaterial = material.dispose.bind(material);
  material.dispose = () => {
    worldMaterials.delete(material);
    disposeMaterial();
  };

  return material;
}
