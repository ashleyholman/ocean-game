import * as THREE from 'three';
import type { SeedSample, WaveField } from './Waves';
import { createSeedSample } from './Waves';
import {
  GLSL_LOG_DEPTH_FRAGMENT,
  GLSL_LOG_DEPTH_PARS_FRAGMENT,
  GLSL_LOG_DEPTH_PARS_VERTEX,
  GLSL_LOG_DEPTH_VERTEX,
} from './shaders/lib';

/**
 * Wind-torn spray: everything the sea throws into the air.
 *
 * One system, deliberately. It replaced a separate `Spindrift` that drew fine
 * droplets and this one that drew sheets, and the reason they merged is that
 * once droplets are given honest aerodynamics the difference between them stops
 * being a difference in kind. A sheet and a droplet are the same water at
 * different points of one size distribution, and separating them into two
 * emitters meant two schedules, two budgets and two sets of numbers that had to
 * be tuned into agreeing about the same wind.
 *
 * DROPLETS DO NOT FALL, AND THIS IS THE WHOLE MODEL
 * ------------------------------------------------
 * The first version integrated `v.y -= 9.81 dt`. That is right for a thrown
 * pebble and wrong for everything the sea tears off a crest, and it produced
 * exactly the artefact it deserved: short ballistic arcs that read as a wave
 * crashing over forwards rather than as water being ripped away sideways.
 *
 * Spume is roughly 80 µm to 2 mm. A 100 µm droplet has a terminal velocity near
 * 0.5 m/s and a 2 mm one near 6.8 m/s, so the fine fraction is not falling in
 * any meaningful sense — it is *suspended*, and an 18 m/s wind carries it tens
 * of metres. Vertical turbulence in the wave boundary layer runs about
 * 0.6–0.8 m/s at this wind, which is comfortably enough to loft the small end
 * upward against its own settling.
 *
 * So there is no gravity term here at all. Every particle relaxes towards a
 * target velocity — the wind horizontally, and its own turbulent updraft minus
 * its own terminal velocity vertically — with a time constant that is itself
 * derived: the relaxation time of a settling droplet is `vt/g`, so fine
 * droplets snap to the wind in hundredths of a second while coarse ones hold
 * their launch direction for a quarter of one.
 *
 * That single relation supplies most of the variety in the effect for free. The
 * many fine droplets stream away almost horizontally and travel a long way. The
 * few coarse ones keep their throw, arc, and fall out within a couple of metres.
 * Nothing had to be scripted to make that happen.
 *
 * WHAT A SHEET IS
 * ---------------
 * Not a membrane. When a gale shears across a breaking crest the liquid goes
 * through the usual cascade — sheet, then ligaments, then droplets — and the
 * genuinely connected film survives centimetres. What reads as a coherent veil
 * in a photograph is an *ensemble*: droplets shed from the same stretch of crest
 * within the same moment, sharing a velocity closely enough that they travel
 * together instead of dispersing. The eye integrates the envelope, never the
 * members.
 *
 * So the traced ridge is an emitter, never geometry. A ribbon mesh was the
 * original design and it was wrong three ways: a two-dimensional strip goes
 * edge-on and vanishes as it rotates, it has a hard alpha boundary where water
 * in air has none, and it has no depth.
 *
 * TEARS ARE SUSTAINED, NOT BURSTS
 * -------------------------------
 * The second version emitted each sheet as one instantaneous burst. That reads
 * as popcorn — discrete puffs going off at random with no relationship to
 * anything, all with the same duration because they all had the same
 * parameters.
 *
 * A crest does not do that. It starts tearing at some point along its length,
 * goes on tearing for a fraction of a wave period while it travels, and stops.
 * So a trace no longer emits: it *opens a tear*, on a sub-segment of the ridge
 * with its own width, its own duration and its own rate, and that tear then
 * sheds continuously until it closes. The plume it leaves is the history of a
 * moving source rather than the debris of an explosion.
 *
 * WHY THE RIDGE IS TRACED IN PARAMETER SPACE
 * ------------------------------------------
 * A Gerstner particle orbits about a fixed parameter position, so a breaking
 * ridge is a stationary curve in `p` however violently it is moving in world
 * space, and `FoamField` stores its whitewater against that same coordinate.
 * Tracing here puts spray on the water the foam shader whitened, by
 * construction, and costs one forward evaluation per probe
 * (`WaveField.sampleSeed`) instead of the seven-iteration inverse solve that
 * `sample()` needs. It is also what lets a tear stay attached to its crest while
 * the crest moves: the tear stores parameter coordinates and re-evaluates them
 * every frame, so it rides the wave for free.
 */

export interface CrestSprayQuality {
  /** Particle pool size. */
  capacity: number;
  /**
   * Ridge searches per second.
   *
   * A cost budget rather than a look control, and the reason the shedding rate
   * needs no separate number: a search only opens a tear if it actually finds a
   * qualifying breaking ridge, so a calm sea opens none and a violent one opens
   * many. How often the sea sheds spray is therefore a property of how much
   * breaking crest it has, which is what it should be.
   */
  searchesPerSecond: number;
  /** Radius of the emission disc, metres. */
  radius: number;
  /**
   * Droplets shed per metre of open tear per second, at full wind.
   *
   * Halved when turbulent lofting went in. Droplets that are being carried by
   * eddies instead of falling out survive their full lifetime, so the same
   * shedding rate held roughly five times as many of them in the air at once and
   * ran the pool to saturation — at which point the ring buffer starts recycling
   * droplets that are still flying, and they visibly teleport.
   */
  particlesPerMetreSecond: number;
  /**
   * Ceiling on breaking segments watched at once.
   *
   * This is the dominant CPU cost of the whole system, not the droplets: every
   * segment costs three full wave evaluations per frame to stay registered on a
   * crest that is moving, and a wave evaluation is forty-eight components of
   * sin and cos. Droplets cost a tenth of a trig call each.
   */
  maxSegments: number;
}

export const CREST_SPRAY_DESKTOP: CrestSprayQuality = {
  capacity: 16384,
  searchesPerSecond: 36,
  radius: 100,
  particlesPerMetreSecond: 18,
  maxSegments: 44,
};

/**
 * Mobile keeps the tears and thins them, rather than keeping a few at full
 * density. The storm cue is the coherent structure; a phone that draws six
 * convincing plumes is closer to the truth than one that draws two dense ones
 * and a lot of empty sea.
 */
export const CREST_SPRAY_MOBILE: CrestSprayQuality = {
  capacity: 3072,
  searchesPerSecond: 14,
  radius: 75,
  particlesPerMetreSecond: 6,
  maxSegments: 16,
};

/** Ridge tracing. Step length, turn per step, and the two stopping rules. */
const TRACE_STEP = 2.0;
const TRACE_MAX_STEPS = 11;
const TRACE_TURN = 0.32;

/**
 * Shortest ridge that may tear, metres.
 *
 * This rejection is what keeps the system pointed at organised breaking. A
 * patch too short to trace is a whitecap fleck, and the foam field already
 * represents it.
 */
const MIN_RIDGE_LENGTH = 6.0;

/**
 * Droplet size range, metres.
 *
 * Spume spans roughly this, and the distribution is heavily weighted to the
 * fine end — which is why the draw below cubes a uniform variate rather than
 * using it directly. The coarse tail is rare and it is supposed to be: those are
 * the few visible individual drops arcing out of an otherwise streaming veil.
 */
const DROPLET_MIN = 80e-6;
const DROPLET_MAX = 2.0e-3;

/**
 * Terminal velocity of a water droplet in air, m/s, for a diameter in metres.
 *
 * The Atlas raindrop fit with its constant offset dropped so the curve passes
 * through zero at zero size instead of going negative below 150 µm. Across the
 * band that matters it is close to the measured values — 0.56 m/s at 100 µm,
 * 1.6 at 300 µm, 4.4 at 1 mm — and it is one exp.
 */
function terminalVelocity(diameter: number): number {
  return 9.65 * (1 - Math.exp(-600 * diameter));
}

/**
 * Turbulent velocity standard deviations, m/s per m/s of wind at 10 m.
 *
 * The first version had a vertical term only, and that was doubly wrong: every
 * droplet relaxed to exactly `wind × 0.96` horizontally, and since the launch
 * spread decays with the droplet's own `vt/g` — hundredths of a second for the
 * fine fraction — they converged to identical horizontal velocity almost at once
 * and then flew in perfect parallel. Spray does not do that, and it is very
 * visible that it does not.
 *
 * It was also backwards. In the atmospheric surface layer the horizontal
 * fluctuations are the *larger* ones: σu ≈ 2.4 u*, σv ≈ 1.9 u*, σw ≈ 1.25 u*,
 * and over water at this wind u* ≈ 0.05 U10 ≈ 0.9 m/s. So the axis that had all
 * of the turbulence is the one that should have had least of it.
 */
const TURBULENT_H_FRACTION = 0.05 * 2.15;
const TURBULENT_W_FRACTION = 0.05 * 1.25;

/** Fraction of the ten-metre wind inherited by fully relaxed airborne water. */
export const SPRAY_WIND_COUPLING = 0.96;

/**
 * Eddy size, radians per metre, and how fast the field evolves.
 *
 * Turbulence is applied as a smooth field sampled at the droplet's position
 * rather than as independent per-droplet noise, and the difference is the whole
 * point: droplets close together are inside the *same* eddy and must be pushed
 * the same way. Independent noise per droplet only blurs a plume; a coherent
 * field makes it writhe as a body, which is what the eye reads as turbulent air.
 *
 * A wavenumber of 0.06 rad/m puts the dominant eddies around a hundred metres
 * across with the harmonics filling in below that — the scale of the gust cells
 * that actually move spray around between wave crests.
 */
const EDDY_K = 0.06;
const EDDY_RATE = 0.5;

/**
 * Frames between turbulent-field updates for any given droplet.
 *
 * Eddies evolve over seconds (EDDY_RATE is 0.5 rad/s), so resampling every
 * droplet every frame buys nothing and costs six trig calls per droplet per
 * frame. The pool is swept in ten interleaved groups: a 6 Hz update per droplet,
 * over which the field turns by 0.08 rad, and a tenth of the cost.
 */
const EDDY_STRIDE = 10;

/**
 * How far a droplet may fall below its birth height before it is retired.
 *
 * Deep, because with honest aerodynamics most droplets never approach it: the
 * fine fraction settles at well under a metre a second and is often climbing.
 * This now retires only the coarse tail, which is exactly what should rejoin the
 * sea quickly.
 */
const SINK_DEPTH = 3.0;

/**
 * Per-sprite contribution, before shape, grain and the life envelope.
 *
 * Named for what it is. An earlier version called this SHEET_OPACITY, from a
 * design in which a "sheet" was an object the system built; there is no such
 * object any more — only droplets and the tears that shed them — and a constant
 * named after a thing that does not exist sends the next reader looking for it.
 *
 * This has been wrong in both directions and the failures look nothing alike.
 * Too low and the system measured 1% of the frame and would not grow when driven
 * sixty times harder. Too high and three hundred overlapping additive sprites
 * saturated their cores into hard-edged white lozenges, which reads as a bug
 * rather than as spray. Low is right, but only once the density is high: a
 * plume's brightness is built by the stacking, so each member has to stack many
 * deep before the sum reaches white.
 */
export const SPRAY_OPACITY = 0.0385;

/**
 * The sun's share of a droplet's radiance, as a multiple of `sunLightIntensity`.
 *
 * Sized against the whitewater the spray is torn from, which is the only
 * defensible reference: a whitecap here is lit by `sunRadiance · foamSunGain`,
 * about 2.7 at a 48-degree sun. The old droplet system used 0.034, giving 0.26 —
 * ten times too dark, and blue-dominated, because with the sun term that small
 * the desaturated sky ambient was effectively the only light on it. Blue spray
 * over blue water is invisible at any opacity.
 */
export const SPRAY_SUN_GAIN = 0.3;

const VERTEX_SHADER = /* glsl */ `
precision highp float;

${GLSL_LOG_DEPTH_PARS_VERTEX}

attribute vec3 iPosition;
attribute vec3 iVelocity;
attribute vec2 iLife;   // (age, lifetime)
attribute vec3 iSize;   // (radius, seed, opacity)

uniform vec2  uFade;    // (start, end) radius of the emission disc, metres
uniform float uStrength;

varying float vFade;
varying vec2  vQuad;
varying float vSeed;
varying float vAge;

void main() {
  float t = clamp(iLife.x / max(iLife.y, 1e-3), 0.0, 1.0);
  if (iLife.y <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off-screen: retired particle
    vFade = 0.0; vQuad = vec2(0.0); vSeed = 0.0; vAge = 0.0;
    return;
  }

  // Fast attack, then a long hold before the tail. Spray has to be dense while
  // it is spray and disperse at the end, not fade from the instant it is born.
  vFade = smoothstep(0.0, 0.06, t) * pow(1.0 - t, 1.4) * iSize.z;

  // Fade out towards the edge of the emission disc. Without this the boundary
  // where the sea stops shedding is a visible ring of water having a calmer day
  // than the water just inside it.
  float ground = length(iPosition.xz);
  vFade *= 1.0 - smoothstep(uFade.x, uFade.y, ground);
  vFade *= uStrength;

  vec4 view = viewMatrix * vec4(iPosition, 1.0);

  // Stretch along the screen-space velocity. Droplets shed together share most
  // of their velocity, so every streak in a plume points the same way — which is
  // the strongest wind cue a renderer has.
  vec3 velView = (viewMatrix * vec4(iVelocity, 0.0)).xyz;
  vec2 dir = velView.xy;
  float speed = length(dir);
  dir = speed > 1e-4 ? dir / speed : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);

  // Keeps stretching as it ages: the parcel is being drawn out by the shear the
  // whole time it is in the air.
  float radius = iSize.x * (1.0 + 0.55 * t);
  float stretch = 1.0 + min(speed * 0.42, 6.0);

  vec2 offset = dir * (position.x * radius * stretch) + perp * (position.y * radius);
  view.xy += offset;

  vQuad = position.xy * 2.0;
  vSeed = iSize.y;
  vAge = t;
  gl_Position = projectionMatrix * view;
  ${GLSL_LOG_DEPTH_VERTEX}
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

${GLSL_LOG_DEPTH_PARS_FRAGMENT}

uniform vec3 uSkyLight;
uniform vec3 uSunLight;
uniform float uForward;
uniform float uOpacity;

varying float vFade;
varying vec2  vQuad;
varying float vSeed;
varying float vAge;

void main() {
  ${GLSL_LOG_DEPTH_FRAGMENT}
  if (vFade <= 0.001) discard;
  float r2 = dot(vQuad, vQuad);
  if (r2 > 1.0) discard;

  // Softer than a hard droplet profile: a sprite stands for a parcel of finely
  // divided water, and its edge has no business being defined.
  float shape = pow(max(1.0 - r2, 0.0), 1.6);

  // Grain, thinning with age. Early on the parcel is dense and nearly uniform;
  // by the end it is lace. Within-sprite noise cannot make plume-scale holes —
  // those come from the distribution of sprites and their staggered deaths — but
  // it stops each sprite reading as a smooth blob.
  float hash = fract(sin(vSeed * 91.7 + vQuad.x * 7.3 + vQuad.y * 11.1) * 43758.5453);
  float grain = mix(0.80 + 0.20 * hash, 0.30 + 0.70 * hash, vAge);

  // Droplets forward-scatter hard: bright looking towards the sun, dim away from
  // it. Without this, spray is a uniform white smear at every angle.
  vec3 lit = uSkyLight + uSunLight * uForward;

  gl_FragColor = vec4(lit, shape * grain * vFade * uOpacity);
}
`;

/** One traced ridge, sampled at its vertices. Reused between searches. */
interface Ridge {
  count: number;
  /** Parameter-space position of each vertex — what a tear stores. */
  px: Float64Array;
  pz: Float64Array;
  /** Cumulative arc length along the displaced polyline, metres. */
  s: Float64Array;
  length: number;
}

function createRidge(): Ridge {
  const n = TRACE_MAX_STEPS * 2 + 1;
  return {
    count: 0,
    px: new Float64Array(n),
    pz: new Float64Array(n),
    s: new Float64Array(n),
    length: 0,
  };
}

/**
 * A stretch of breaking crest that the tracer has found and is watching.
 *
 * Held in parameter space, so it stays on its crest while the crest travels and
 * heaves — see the note on parameter space in the file header. Its endpoints and
 * midpoint are re-evaluated every frame, which keeps it registered and gives the
 * droplets it sheds the water's own orbital velocity to launch from.
 *
 * IT HAS NO DURATION, AND THAT IS THE POINT
 * -----------------------------------------
 * The previous version gave each of these an open time, a scripted lifetime and
 * a close, and Ash could see every one of them: viewed head-on the sea had a row
 * of distinct point sources spaced along each crest, each switching on, running
 * for a beat, and switching off. Any scripted envelope on an emitter is visible
 * as exactly that.
 *
 * A segment now carries a `weight` re-derived every frame from the *live*
 * breaking indicator at its own position, through the same ramp the foam shader
 * uses. So it fades up as its crest steepens into breaking and fades away as the
 * crest passes, with no event anywhere: shedding is a continuous function of how
 * hard that piece of water is breaking at this instant. A segment is evicted when
 * its weight falls to nothing, and a fresh search will rediscover the same crest
 * if it is still going.
 */
interface Segment {
  active: boolean;
  /** Parameter-space endpoints of the traced ridge. */
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Parameter-space midpoint, kept for the duplicate check. */
  mx: number;
  mz: number;
  /** Live breaking intensity, 0..1. Re-derived every frame. */
  weight: number;
  /** Current world length, metres. Re-derived every frame. */
  worldLength: number;
  carry: number;
}

function createSegment(): Segment {
  return {
    active: false,
    ax: 0,
    az: 0,
    bx: 0,
    bz: 0,
    mx: 0,
    mz: 0,
    weight: 0,
    worldLength: 0,
    carry: 0,
  };
}

/**
 * Closest two segments may sit before the second is rejected as a duplicate,
 * metres in parameter space.
 *
 * Searches are random, so without this the same vigorously breaking crest gets
 * found repeatedly and stacks several segments on top of each other — which
 * multiplies the shedding rate there for no physical reason and eats slots that
 * other crests need.
 */
const SEGMENT_MIN_SPACING = 7.0;

/**
 * Water thrown into the air by something that is not a wave.
 *
 * WK3 feeds hull-entry spray into this pool rather than standing up a second
 * particle system, and this interface is the whole of what the pool needs to
 * know about where it came from: an origin, a line to spread along, three
 * directions and three speeds. Nothing here mentions a hull, deliberately —
 * the merge-don't-duplicate history in this file's header is why the system
 * exists in one piece, and a `Spindrift` shaped like "the bow's own emitter"
 * is exactly the thing that got deleted.
 *
 * The alternative — a points system in this class's image — was rejected after
 * reading the class. This pool already carries the droplet aerodynamics, the
 * foam-equivalent lighting, the log-depth path, the additive blending, the
 * emission-disc fade, and the one that decides it: the observer-displacement
 * pass that makes airborne water stream aft as the ship advances through the
 * wave field. A second system would have had to reimplement all six and then
 * be tuned into agreeing with this one about the same wind.
 */
export interface SprayBurstSource {
  originX: number;
  originY: number;
  originZ: number;
  /** Half the source line. Droplets are placed at origin ± this. */
  spreadX: number;
  spreadY: number;
  spreadZ: number;
  /** Unit direction of the main throw. */
  alongX: number;
  alongY: number;
  alongZ: number;
  /** Unit direction of the lift, normally the water-surface normal. */
  liftX: number;
  liftY: number;
  liftZ: number;
  throwSpeedMps: number;
  liftSpeedMps: number;
  /** Speed along +spread at its far end; scales linearly to zero at the origin. */
  outboardSpeedMps: number;
  dropletCount: number;
  /** 0..1 droplet-size bias: 0 draws sea spume, 1 draws heavy drops. */
  coarseness: number;
  /** Per-droplet opacity weight, 1 being the sea's own. */
  opacity: number;
}

/**
 * Exponent on the uniform variate that draws droplet size, at the two ends of
 * the coarseness bias.
 *
 * The sea's own draw is `u³` — see `DROPLET_MIN`/`DROPLET_MAX`: spume is
 * overwhelmingly fine and the coarse tail is rare on purpose. Water torn off a
 * stem is a sheet coming apart and is much coarser, and the difference is not
 * cosmetic: a droplet's drag time constant is vt/g, so at 100 µm it forgets its
 * launch in three frames and simply joins the wind, while at 2 mm it holds its
 * throw for a quarter of a second and falls out. Drawn from the sea's
 * distribution, a bow burst would blow away downwind the instant it was born
 * instead of arcing out from the bow.
 */
const BURST_SIZE_EXPONENT_FINE = 3.0;
const BURST_SIZE_EXPONENT_COARSE = 0.6;

export class CrestSpray {
  readonly points: THREE.Mesh;
  /** Public kill switch that leaves ridge detection running. */
  enabled = true;

  private readonly quality: CrestSprayQuality;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;

  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly posAttr: THREE.InstancedBufferAttribute;
  private readonly velAttr: THREE.InstancedBufferAttribute;
  private readonly lifeAttr: THREE.InstancedBufferAttribute;
  private readonly sizeAttr: THREE.InstancedBufferAttribute;

  /** Per-particle aerodynamics. CPU only — see the file header. */
  /** Settling velocity, m/s, negative. Constant for a droplet's life. */
  private readonly settle: Float32Array;
  /** Current turbulent velocity, sampled from the eddy field. */
  private readonly turb: Float32Array;
  private readonly invTau: Float32Array;
  private readonly birthY: Float32Array;

  private readonly probe: SeedSample = createSeedSample();
  private readonly endA: SeedSample = createSeedSample();
  private readonly endB: SeedSample = createSeedSample();
  private readonly ridge: Ridge = createRidge();
  private readonly traceX = new Float64Array(TRACE_MAX_STEPS * 2 + 1);
  private readonly traceZ = new Float64Array(TRACE_MAX_STEPS * 2 + 1);
  private readonly segments: Segment[];
  private readonly endM: SeedSample = createSeedSample();

  /** Scratch for `sampleEddy`, which is called per droplet per frame. */
  private eddyX = 0;
  private eddyY = 0;
  private eddyZ = 0;
  private eddyPhase = 0;

  private cursor = 0;
  private searchCarry = 0;
  /** Deterministic sequence, so a captured run reproduces exactly. */
  private rngState = 0x51f3a7d;
  /**
   * A second, independent deterministic stream, for burst sources only.
   *
   * Not tidiness. The off/on pair is this project's A/B instrument as well as
   * its regression guard, and a burst emitter drawing from the sea's stream
   * would shift every subsequent sea droplet — so "hull spray off" would not
   * reproduce the build without hull spray, and no A/B taken across the switch
   * would be an A/B. With its own stream, a disabled or absent burst source
   * leaves the sea bit-identical.
   */
  private burstRngState = 0x2f9b41c;
  private liveCount = 0;
  private burstCount = 0;
  private activityValue = 0;
  private densityScale = 1;

  constructor(quality: CrestSprayQuality) {
    this.quality = quality;
    const n = quality.capacity;

    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n * 2);
    this.size = new Float32Array(n * 3);
    this.settle = new Float32Array(n);
    this.turb = new Float32Array(n * 3);
    this.invTau = new Float32Array(n);
    this.birthY = new Float32Array(n);

    this.segments = [];
    for (let i = 0; i < quality.maxSegments; i++) this.segments.push(createSegment());

    const quad = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(quad, 3));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);

    this.posAttr = new THREE.InstancedBufferAttribute(this.pos, 3);
    this.velAttr = new THREE.InstancedBufferAttribute(this.vel, 3);
    this.lifeAttr = new THREE.InstancedBufferAttribute(this.life, 2);
    this.sizeAttr = new THREE.InstancedBufferAttribute(this.size, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.velAttr.setUsage(THREE.DynamicDrawUsage);
    this.lifeAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('iPosition', this.posAttr);
    this.geometry.setAttribute('iVelocity', this.velAttr);
    this.geometry.setAttribute('iLife', this.lifeAttr);
    this.geometry.setAttribute('iSize', this.sizeAttr);
    this.geometry.instanceCount = n;
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uSkyLight: { value: new THREE.Vector3(0.5, 0.55, 0.6) },
        uSunLight: { value: new THREE.Vector3(1, 1, 1) },
        uForward: { value: 0.5 },
        uOpacity: { value: SPRAY_OPACITY },
        uFade: { value: new THREE.Vector2(quality.radius * 0.72, quality.radius) },
        // Spray brightness. 2.1 by Ash's eye against SOUTHERN_OCEAN_ROUGH, which
        // is the state that actually exercises this — a calm sea sheds almost
        // nothing, so the multiplier has little to act on there and the value is
        // effectively set by the sea that shows it.
        uStrength: { value: 2.1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Additive. A spray sprite is mostly empty space that transmits whatever
      // is behind it and scatters a little extra light in. Alpha blending
      // instead *replaces* the backdrop with the sprite's own radiance, and the
      // moment the backdrop is brighter than the sprite — any twilight sky — the
      // spray renders as dark clumps streaking past. Birds, not water. Additive
      // can only lighten.
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    this.points = new THREE.Mesh(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  get activeCount(): number {
    return this.liveCount;
  }

  /** Breaking segments currently shedding. Diagnostic. */
  get tearCount(): number {
    let n = 0;
    for (const seg of this.segments) if (seg.active) n++;
    return n;
  }

  /**
   * Smoothed 0..1 measure of how hard the sea is throwing spray.
   *
   * Airborne salt loading is driven by recent breaking, and a value that has
   * already been through the wind gate, the intensity control and the actual
   * supply of breaking ridge is the honest summary of that. Its time constant is
   * seconds, so a gust thickens the air a beat after it raises the spray.
   */
  get activity(): number {
    return this.activityValue;
  }

  /** Droplets shed from burst sources since construction. Diagnostic. */
  get burstDropletCount(): number {
    return this.burstCount;
  }

  clear(): void {
    this.life.fill(0);
    this.lifeAttr.needsUpdate = true;
    for (const seg of this.segments) seg.active = false;
    this.cursor = 0;
    this.searchCarry = 0;
    this.rngState = 0x51f3a7d;
    this.burstRngState = 0x2f9b41c;
    this.liveCount = 0;
    this.burstCount = 0;
    this.activityValue = 0;
  }

  setStrength(strength: number): void {
    this.material.uniforms.uStrength.value = strength;
  }

  /** Multiplier on the derived shedding rate. Lab only; production runs at 1. */
  setDensity(scale: number): void {
    this.densityScale = Math.max(scale, 0);
  }

  private random(): number {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 4294967296;
  }

  /** The burst stream's draw. Same generator, deliberately separate state. */
  private burstRandom(): number {
    let x = this.burstRngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.burstRngState = x >>> 0;
    return this.burstRngState / 4294967296;
  }

  private burstGaussian(): number {
    const u = Math.max(this.burstRandom(), 1e-6);
    const v = this.burstRandom();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Turbulent air velocity at a point, into the eddy scratch.
   *
   * A smooth field rather than per-droplet noise, because droplets close
   * together are inside the same eddy and have to be pushed the same way. That
   * coherence is the difference between a plume that writhes as a body and one
   * that merely looks fuzzy.
   *
   * Three sinusoid products per axis, at incommensurate wavenumbers so the field
   * does not visibly tile, drifting in time. It is not divergence-free and does
   * not need to be: nothing here conserves mass, and what the eye is reading is
   * that neighbouring droplets share a push while distant ones do not.
   */
  private sampleEddy(
    x: number,
    z: number,
    t: number,
    sigmaH: number,
    sigmaW: number,
  ): void {
    const a1 = Math.sin(x * EDDY_K + t * EDDY_RATE);
    const b1 = Math.cos(z * EDDY_K * 0.87 - t * EDDY_RATE * 0.71);
    const a2 = Math.cos(x * EDDY_K * 2.3 - t * EDDY_RATE * 1.37);
    const b2 = Math.sin(z * EDDY_K * 1.9 + t * EDDY_RATE * 1.13);
    // Two octaves, the second at a third of the weight: the large eddy carries
    // the plume and the small one breaks its edge up.
    this.eddyX = (a1 * b1 + 0.34 * a2 * b2) * sigmaH * 1.5;
    this.eddyZ = (b1 * a2 + 0.34 * b2 * a1) * sigmaH * 1.5;
    this.eddyY = (a1 * b2 + 0.34 * a2 * b1) * sigmaW * 1.5;
  }

  /** Normal deviate. Spread wants a tail; uniform does not. */
  private gaussian(): number {
    const u = Math.max(this.random(), 1e-6);
    const v = this.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  update(
    dt: number,
    waves: WaveField,
    windDirX: number,
    windDirZ: number,
    windSpeed: number,
    intensity: number,
    gustiness: number,
    elapsed: number,
    observerDisplacementX = 0,
    observerDisplacementZ = 0,
  ): void {
    // The render frame follows the vessel. Waterborne tear coordinates and
    // already-airborne droplets therefore move backwards by the exact distance
    // the observer advanced through the wave field this frame. Keeping this as
    // a displacement (rather than re-integrating a nominal speed) also follows
    // the fixed buoyancy substeps when a rendered frame has a remainder.
    if (observerDisplacementX !== 0 || observerDisplacementZ !== 0) {
      for (const seg of this.segments) {
        if (!seg.active) continue;
        seg.ax -= observerDisplacementX;
        seg.mx -= observerDisplacementX;
        seg.bx -= observerDisplacementX;
        seg.az -= observerDisplacementZ;
        seg.mz -= observerDisplacementZ;
        seg.bz -= observerDisplacementZ;
      }
      for (let i = 0; i < this.quality.capacity; i++) {
        if (this.life[i * 2 + 1] <= 0) continue;
        this.pos[i * 3] -= observerDisplacementX;
        this.pos[i * 3 + 2] -= observerDisplacementZ;
      }
    }
    this.integrate(dt, windDirX * windSpeed, windDirZ * windSpeed, windSpeed, elapsed);

    // Tearing needs a wind that can rip a crest apart, which is a higher bar
    // than the one that merely makes it crumble into foam. Below a near gale a
    // breaking crest spills; it does not shed.
    const windGate = smoothstep(9.0, 19.0, windSpeed);
    const gust = 1 + gustiness * 0.9 * Math.sin(elapsed * 0.31 + 1.7) * Math.sin(elapsed * 0.13);
    const shedStrength = intensity * windGate * Math.max(gust, 0.1);

    const tau = 4.0;
    this.activityValue +=
      (Math.min(shedStrength, 1.5) / 1.5 - this.activityValue) * (1 - Math.exp(-dt / tau));

    if (!this.enabled || shedStrength <= 0.002 || waves.count === 0) {
      for (const seg of this.segments) seg.active = false;
      this.flush();
      return;
    }

    // Look for new breaking ridges at a fixed rate. A search that finds nothing
    // opens nothing, so how often the sea sheds is set by how much breaking
    // crest it has rather than by a number.
    this.searchCarry += dt * this.quality.searchesPerSecond;
    let searches = Math.min(Math.floor(this.searchCarry), 4);
    this.searchCarry -= searches;
    while (searches-- > 0) {
      if (this.traceRidge(waves, windDirX, windDirZ)) {
        this.recordSegment();
      }
    }

    this.shedFromSegments(dt, waves, windDirX, windDirZ, windSpeed, shedStrength, elapsed);
    this.flush();
  }

  /**
   * Advance every live droplet.
   *
   * No gravity term: see the file header. Each droplet relaxes towards the wind
   * horizontally and towards `turbulent updraft − terminal velocity` vertically,
   * at its own rate.
   */
  private integrate(
    dt: number,
    windX: number,
    windZ: number,
    windSpeed: number,
    elapsed: number,
  ): void {
    const sigmaH = TURBULENT_H_FRACTION * windSpeed;
    const sigmaW = TURBULENT_W_FRACTION * windSpeed;
    this.eddyPhase = (this.eddyPhase + 1) % EDDY_STRIDE;
    let live = 0;
    for (let i = 0; i < this.quality.capacity; i++) {
      const l = i * 2;
      if (this.life[l + 1] <= 0) continue;
      const age = this.life[l] + dt;
      if (age >= this.life[l + 1]) {
        this.life[l + 1] = 0;
        continue;
      }
      this.life[l] = age;

      const p = i * 3;

      // Refresh this droplet's eddy every EDDY_STRIDE frames. The sample
      // position is offset by a per-droplet jitter (carried in the sprite seed)
      // so that two droplets sharing an eddy still differ a little, which is the
      // sub-eddy scale the field itself is too smooth to supply.
      if (i % EDDY_STRIDE === this.eddyPhase) {
        const jitter = this.size[i * 3 + 1];
        this.sampleEddy(
          this.pos[p] + jitter,
          this.pos[p + 2] - jitter,
          elapsed,
          sigmaH,
          sigmaW,
        );
        this.turb[p] = this.eddyX;
        this.turb[p + 1] = this.eddyY;
        this.turb[p + 2] = this.eddyZ;
      }

      const k = Math.min(this.invTau[i] * dt, 1);
      this.vel[p + 0] +=
        (windX * SPRAY_WIND_COUPLING + this.turb[p] - this.vel[p + 0]) * k;
      this.vel[p + 1] += (this.settle[i] + this.turb[p + 1] - this.vel[p + 1]) * k;
      this.vel[p + 2] +=
        (windZ * SPRAY_WIND_COUPLING + this.turb[p + 2] - this.vel[p + 2]) * k;

      this.pos[p + 0] += this.vel[p + 0] * dt;
      this.pos[p + 1] += this.vel[p + 1] * dt;
      this.pos[p + 2] += this.vel[p + 2] * dt;

      // Rejoined the sea. With honest settling speeds this now retires only the
      // coarse tail; the fine fraction is usually still climbing.
      if (this.pos[p + 1] < this.birthY[i] - SINK_DEPTH) {
        this.life[l + 1] = 0;
        continue;
      }
      live++;
    }
    this.liveCount = live;
  }

  private flush(): void {
    this.posAttr.needsUpdate = true;
    this.velAttr.needsUpdate = true;
    this.lifeAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }

  /**
   * Find a connected breaking ridge.
   *
   * Seed by rejection on the shader's own `breakBand`, then walk the ridge in
   * both directions, steering at each step towards whichever of three candidate
   * headings carries the most compression. The initial heading is the wind's
   * perpendicular — where a wind-sea crest runs on average and nowhere in
   * particular in any given instant — and the search corrects it within two or
   * three steps, then tracks the real curvature of the crest.
   */
  private traceRidge(waves: WaveField, windDirX: number, windDirZ: number): boolean {
    const band: [number, number] = [0, 0];
    waves.breakBand(band);
    const gate = band[0];

    const radius = this.quality.radius;
    let seedX = 0;
    let seedZ = 0;
    let found = false;
    for (let attempt = 0; attempt < 24; attempt++) {
      const r = radius * Math.sqrt(this.random());
      const a = this.random() * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      waves.sampleSeed(x, z, this.probe);
      if (this.probe.compression < gate) continue;
      // Breaking happens on the downwind face. The foam injection weights by the
      // signed slope along the wind for the same reason: keying on slope
      // magnitude instead puts a symmetric collar of spray round every crest,
      // which is the clearest tell of an effect that does not know which way the
      // wind is blowing.
      const ny = Math.max(this.probe.normalY, 1e-3);
      const slopeAlongWind =
        (-this.probe.normalX / ny) * windDirX + (-this.probe.normalZ / ny) * windDirZ;
      if (slopeAlongWind < -0.02) continue;
      seedX = x;
      seedZ = z;
      found = true;
      break;
    }
    if (!found) return false;

    const headingA = Math.atan2(windDirX, -windDirZ) + Math.PI / 2;
    const centre = TRACE_MAX_STEPS;
    this.traceX[centre] = seedX;
    this.traceZ[centre] = seedZ;
    let lo = centre;
    let hi = centre;

    for (let side = 0; side < 2; side++) {
      let heading = side === 0 ? headingA : headingA + Math.PI;
      let x = seedX;
      let z = seedZ;
      for (let step = 0; step < TRACE_MAX_STEPS; step++) {
        let bestHeading = 0;
        let bestX = 0;
        let bestZ = 0;
        let best = -Infinity;
        for (let turn = -1; turn <= 1; turn++) {
          const h = heading + turn * TRACE_TURN;
          const cx = x + Math.sin(h) * TRACE_STEP;
          const cz = z - Math.cos(h) * TRACE_STEP;
          waves.sampleSeed(cx, cz, this.probe);
          if (this.probe.compression > best) {
            best = this.probe.compression;
            bestHeading = h;
            bestX = cx;
            bestZ = cz;
          }
        }
        // The ridge ended. Stopping here is what keeps a tear inside one
        // breaking crest instead of bridging two.
        if (best < gate) break;
        heading = bestHeading;
        x = bestX;
        z = bestZ;
        if (side === 0) {
          hi++;
          this.traceX[hi] = x;
          this.traceZ[hi] = z;
        } else {
          lo--;
          this.traceX[lo] = x;
          this.traceZ[lo] = z;
        }
      }
    }

    const ridge = this.ridge;
    let count = 0;
    let length = 0;
    let lastX = 0;
    let lastZ = 0;
    let lastY = 0;
    for (let i = lo; i <= hi; i++) {
      waves.sampleSeed(this.traceX[i], this.traceZ[i], this.probe);
      ridge.px[count] = this.traceX[i];
      ridge.pz[count] = this.traceZ[i];
      if (count > 0) {
        length += Math.hypot(
          this.probe.x - lastX,
          this.probe.height - lastY,
          this.probe.z - lastZ,
        );
      }
      lastX = this.probe.x;
      lastY = this.probe.height;
      lastZ = this.probe.z;
      ridge.s[count] = length;
      count++;
    }
    ridge.count = count;
    ridge.length = length;

    return count >= 2 && length >= MIN_RIDGE_LENGTH;
  }

  /**
   * Record the traced ridge as a segment to shed from.
   *
   * The whole ridge, not a narrow sub-segment of it. The previous version cut a
   * short stretch out of each trace — most of them a few metres — so from
   * head-on the sea read as a line of distinct nozzles rather than as a crest
   * letting go along its length. Droplets are placed uniformly along the full
   * ridge instead, and the variation in *where* a crest sheds hardest now comes
   * from the weight tracking real breaking rather than from a chosen width.
   */
  private recordSegment(): void {
    const ridge = this.ridge;
    const mid = this.pointAt(ridge.length * 0.5);

    // Already watching this crest?
    for (const seg of this.segments) {
      if (!seg.active) continue;
      if (Math.hypot(seg.mx - mid.x, seg.mz - mid.z) < SEGMENT_MIN_SPACING) return;
    }

    // Free slot, or displace the faintest one so a fresh discovery is never
    // locked out by a pool full of barely-breaking water.
    let slot = this.segments.find((seg) => !seg.active);
    if (!slot) {
      let weakest = this.segments[0];
      for (const seg of this.segments) if (seg.weight < weakest.weight) weakest = seg;
      slot = weakest;
    }

    const a = this.pointAt(0);
    const b = this.pointAt(ridge.length);
    slot.active = true;
    slot.ax = a.x;
    slot.az = a.z;
    slot.bx = b.x;
    slot.bz = b.z;
    slot.mx = mid.x;
    slot.mz = mid.z;
    slot.weight = 0;
    slot.worldLength = ridge.length;
    slot.carry = 0;
  }

  /** Parameter-space point at an arc length along the traced ridge. */
  private pointAt(distance: number): { x: number; z: number } {
    const ridge = this.ridge;
    const target = Math.min(Math.max(distance, 0), ridge.length);
    let seg = 0;
    while (seg < ridge.count - 2 && ridge.s[seg + 1] < target) seg++;
    const span = Math.max(ridge.s[seg + 1] - ridge.s[seg], 1e-4);
    const u = Math.min(Math.max((target - ridge.s[seg]) / span, 0), 1);
    return {
      x: ridge.px[seg] + (ridge.px[seg + 1] - ridge.px[seg]) * u,
      z: ridge.pz[seg] + (ridge.pz[seg + 1] - ridge.pz[seg]) * u,
    };
  }

  /**
   * Re-evaluate every segment against the live sea and shed from it.
   *
   * Three wave evaluations per segment — both ends and the middle — which keeps
   * the segment registered on a crest that is moving and bending, supplies the
   * orbital velocity to launch from, and measures how hard this piece of water
   * is breaking *now*. That last one is the whole shedding schedule: there is no
   * timer anywhere in this function.
   */
  private shedFromSegments(
    dt: number,
    waves: WaveField,
    windDirX: number,
    windDirZ: number,
    windSpeed: number,
    shedStrength: number,
    elapsed: number,
  ): void {
    const sigmaH = TURBULENT_H_FRACTION * windSpeed;
    const sigmaW = TURBULENT_W_FRACTION * windSpeed;
    const band: [number, number] = [0, 0];
    waves.breakBand(band);

    for (const seg of this.segments) {
      if (!seg.active) continue;

      waves.sampleSeed(seg.ax, seg.az, this.endA);
      waves.sampleSeed(seg.mx, seg.mz, this.endM);
      waves.sampleSeed(seg.bx, seg.bz, this.endB);

      // The same ramp the foam injection uses, so spray and whitewater agree
      // about what is breaking. Averaged over the three probes rather than taken
      // at one, so a segment straddling the end of a crest fades rather than
      // flickering on its midpoint.
      seg.weight =
        (smoothstep(band[0], band[1], this.endA.compression) +
          smoothstep(band[0], band[1], this.endM.compression) +
          smoothstep(band[0], band[1], this.endB.compression)) /
        3;

      // Stopped breaking. No close event, no fade-out schedule — the weight went
      // to nothing on its own and the slot is simply free again.
      if (seg.weight < 0.02) {
        seg.active = false;
        continue;
      }

      seg.worldLength =
        Math.hypot(this.endA.x - this.endM.x, this.endA.height - this.endM.height, this.endA.z - this.endM.z) +
        Math.hypot(this.endM.x - this.endB.x, this.endM.height - this.endB.height, this.endM.z - this.endB.z);

      seg.carry +=
        seg.worldLength *
        seg.weight *
        this.quality.particlesPerMetreSecond *
        shedStrength *
        this.densityScale *
        dt;
      let emit = Math.min(Math.floor(seg.carry), 64);
      seg.carry -= emit;

      while (emit-- > 0) {
        this.spawn(dt, windDirX, windDirZ, windSpeed, elapsed, sigmaH, sigmaW);
      }
    }
  }

  /**
   * Shed one droplet from the segment currently loaded into the endpoint
   * scratch.
   *
   * Everything that varies between droplets is drawn here rather than once per
   * segment per frame. The previous version computed one launch velocity for a
   * whole tear and gave it to every droplet emitted that frame, which quantised
   * the plume into per-frame slabs of identical water. The coherence a plume
   * needs comes from neighbouring droplets sharing the *field* they fly through —
   * the wind and the eddy — not from sharing a birth certificate.
   */
  private spawn(
    dt: number,
    windDirX: number,
    windDirZ: number,
    windSpeed: number,
    elapsed: number,
    sigmaH: number,
    sigmaW: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.quality.capacity;
    const p = i * 3;
    const l = i * 2;
    const s = i * 3;

    // Uniform along the segment, piecewise-linear through the midpoint so a
    // curved crest is followed rather than chorded.
    const t = this.random();
    let e0 = this.endA;
    let e1 = this.endM;
    let u = t * 2;
    if (t >= 0.5) {
      e0 = this.endM;
      e1 = this.endB;
      u = (t - 0.5) * 2;
    }
    const bx = e0.x + (e1.x - e0.x) * u;
    const by = e0.height + (e1.height - e0.height) * u;
    const bz = e0.z + (e1.z - e0.z) * u;
    const ovx = e0.velocityX + (e1.velocityX - e0.velocityX) * u;
    const ovy = e0.velocityY + (e1.velocityY - e0.velocityY) * u;
    const ovz = e0.velocityZ + (e1.velocityZ - e0.velocityZ) * u;

    // Launched from the water, not from the air above it. This used to start
    // droplets 0.15–0.70 m clear of the crest — a detached band hanging over the
    // wave, which is exactly how it read.
    //
    // REVERTED: an across-crest scatter sat here, to stop the source being a
    // mathematical line of zero width. It is a real defect and the scatter was
    // the right shape of fix, but it did not resolve the discrete-origins
    // artefact it was aimed at — that turned out to be near-crest droplet
    // density, not source width — so it is out until the density question is
    // settled and it can be judged on its own.
    this.pos[p + 0] = bx;
    this.pos[p + 1] = by + this.random() * 0.10;
    this.pos[p + 2] = bz;
    this.birthY[i] = this.pos[p + 1];

    // Per-droplet share of the wind. Spume is torn off, so the wind supplies
    // most of the launch, but how much any one parcel gets is a lottery.
    const kick = 0.28 + this.random() * 0.40;
    const launchX = ovx + windDirX * windSpeed * kick;
    const launchZ = ovz + windDirZ * windSpeed * kick;
    const launchY = Math.max(ovy, 0) * 0.55 + 0.5 + this.random() * 0.9;

    const flight = Math.hypot(launchX, launchZ) || 1;
    const alongX = launchX / flight;
    const alongZ = launchZ / flight;
    const acrossX = -alongZ;
    const acrossZ = alongX;

    // Tight across the plume, loose along the flight. Making these equal is the
    // difference between a veil that streams and a ball that expands.
    const dAlong = this.gaussian() * 2.1;
    const dAcross = this.gaussian() * 0.3;
    this.vel[p + 0] = launchX + alongX * dAlong + acrossX * dAcross;
    this.vel[p + 1] = launchY + this.gaussian() * 0.5;
    this.vel[p + 2] = launchZ + alongZ * dAlong + acrossZ * dAcross;

    // Droplet size, heavily weighted fine. Everything below follows from it.
    const sizeU = this.random();
    const coarse = sizeU * sizeU * sizeU;
    const diameter = DROPLET_MIN + (DROPLET_MAX - DROPLET_MIN) * coarse;
    const vt = terminalVelocity(diameter);
    // The relaxation time of a settling droplet is vt/g, so this is one number
    // doing two jobs honestly: fine droplets couple to the wind in hundredths of
    // a second, coarse ones hold their throw for a quarter of one.
    this.invTau[i] = 9.81 / Math.max(vt, 0.05);
    this.settle[i] = -vt;
    // Seed the turbulent velocity immediately rather than at the first strided
    // update, so a droplet is never briefly flying in dead-straight air.
    this.sampleEddy(this.pos[p], this.pos[p + 2], elapsed, sigmaH, sigmaW);
    this.turb[p] = this.eddyX;
    this.turb[p + 1] = this.eddyY;
    this.turb[p + 2] = this.eddyZ;

    // A fine droplet is an unresolvable mist, so its sprite is a large soft
    // parcel; a coarse one is a visible individual drop, so its sprite is small
    // and tight. The correlation runs backwards from the intuition and it is what
    // lets one system cover both the veil and the glint.
    this.size[s] = 0.75 - 0.68 * coarse + this.random() * 0.12;
    this.size[s + 1] = this.random() * 100;
    // Big soft parcels overlap many deep and must not saturate; small sharp ones
    // are seen alone and would vanish at the same weight.
    this.size[s + 2] = 0.7 + 1.9 * coarse;

    // Sub-frame birth, and it is not cosmetic.
    //
    // Droplets are shed in the shedding pass, which runs once a frame, so
    // without this every droplet in the sea is born on a frame boundary. Each
    // frame's cohort is then a thin curtain launched simultaneously along the
    // crest, and the next frame's curtain is born a sixtieth of a second later —
    // by which time the wind has carried the previous one 26 cm downwind. The
    // sea grows evenly spaced bands of spray, and viewed across the wind they
    // read as vertical stripes. Measured before this went in: 4,711 live
    // droplets occupying 134 distinct ages, every one exactly on a frame
    // boundary.
    //
    // What makes it survive is the thing that made the trajectories right. The
    // launch velocity has a real spread, which ought to blur 26 cm away inside a
    // tenth of a second — but the drag time constant is vt/g, about 0.03 s for
    // the fine fraction, so that spread is erased almost immediately and every
    // droplet thereafter travels at wind-plus-eddy. The curtains never diffuse.
    // Better aerodynamics preserve birth-time structure more faithfully, so the
    // emitter must not know what the frame rate is.
    //
    // Fixed by giving each droplet a uniform birth instant within the frame and
    // flying it forward to now. One random draw and three multiply-adds.
    const flown = this.random() * dt;
    this.pos[p + 0] += this.vel[p + 0] * flown;
    this.pos[p + 1] += this.vel[p + 1] * flown;
    this.pos[p + 2] += this.vel[p + 2] * flown;

    // Capped well below what the aerodynamics alone would give, and the reason is
    // a division of labour rather than a budget. A droplet still flying after
    // three seconds has travelled fifty metres and is nowhere near the crest that
    // threw it: it has stopped being part of a legible plume and become general
    // murk in the air. That is exactly what the airborne salt loading draws, as a
    // smooth extinction, for a fraction of the cost.
    this.life[l] = flown;
    this.life[l + 1] = (1.8 - 1.3 * coarse) * (0.7 + this.random() * 0.6);
  }

  /**
   * Shed one frame's worth of droplets from a non-wave source.
   *
   * Called after `update()`, so these droplets are born on the same side of
   * `integrate` as the sea's own and get the same treatment next frame — the
   * one visible difference is that they are not in `activeCount` until then.
   * That is deliberate: `activity` drives the airborne salt loading, and salt
   * in the air is a property of how hard the *sea* is breaking, not of one
   * ship's bow.
   *
   * Returns the number actually shed, which is what the caller should meter
   * against a budget. A disabled system, a zero count or a non-finite source
   * touches neither the ring cursor nor the burst stream, so the off state
   * reproduces a build with no burst source at all, bit for bit.
   */
  emitBurst(
    source: Readonly<SprayBurstSource>,
    dt: number,
    // No wind *direction*: unlike a crest tear, a burst's launch is fully
    // specified by its source, and the wind reaches these droplets exactly the
    // way it reaches every other one — through `integrate`'s relaxation. The
    // speed is still wanted, for the turbulent field they are seeded into.
    windSpeed: number,
    elapsed: number,
  ): number {
    if (!this.enabled) return 0;
    const requested = Math.floor(source.dropletCount);
    if (!(requested > 0) || !(dt > 0)) return 0;

    const sigmaH = TURBULENT_H_FRACTION * windSpeed;
    const sigmaW = TURBULENT_W_FRACTION * windSpeed;
    const coarseness = Math.min(Math.max(source.coarseness, 0), 1);
    const sizeExponent =
      BURST_SIZE_EXPONENT_FINE +
      (BURST_SIZE_EXPONENT_COARSE - BURST_SIZE_EXPONENT_FINE) * coarseness;
    // A tear that asks for more than the pool holds is a bug upstream, not
    // something to serve: recycling live droplets is what makes them teleport.
    const count = Math.min(requested, this.quality.capacity >> 2);

    // `spread` is a displacement in metres — it positions droplets along the
    // source line. The outboard *velocity* needs its direction only, or the
    // throw would be scaled by however wide the cut happens to be this frame.
    const spreadLength = Math.hypot(
      source.spreadX,
      source.spreadY,
      source.spreadZ,
    );
    const spreadUnitX = spreadLength > 1e-6 ? source.spreadX / spreadLength : 0;
    const spreadUnitY = spreadLength > 1e-6 ? source.spreadY / spreadLength : 0;
    const spreadUnitZ = spreadLength > 1e-6 ? source.spreadZ / spreadLength : 0;

    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.quality.capacity;
      const p = i * 3;
      const l = i * 2;
      const s = i * 3;

      // Uniform along the source line. `spread` is half of it, so this runs
      // from one side of the stem to the other and the sign of `along` is the
      // side the droplet is on — the outboard push follows it linearly and is
      // zero on the centreline, which is what a stem splitting water does.
      const across = this.burstRandom() * 2 - 1;
      this.pos[p + 0] = source.originX + source.spreadX * across;
      this.pos[p + 1] = source.originY + source.spreadY * across;
      this.pos[p + 2] = source.originZ + source.spreadZ * across;
      this.birthY[i] = this.pos[p + 1];

      const throwSpeed = source.throwSpeedMps;
      const liftSpeed = source.liftSpeedMps;
      const outboard = source.outboardSpeedMps * across;
      let vx =
        source.alongX * throwSpeed +
        source.liftX * liftSpeed +
        spreadUnitX * outboard;
      let vy =
        source.alongY * throwSpeed +
        source.liftY * liftSpeed +
        spreadUnitY * outboard;
      let vz =
        source.alongZ * throwSpeed +
        source.liftZ * liftSpeed +
        spreadUnitZ * outboard;

      // Tight across the sheet, loose along it — the same asymmetry the sea's
      // spawn uses, and for the same reason: equal spread makes a ball that
      // expands rather than a veil that streams.
      const flight = Math.hypot(vx, vz) || 1;
      const alongX = vx / flight;
      const alongZ = vz / flight;
      const dAlong = this.burstGaussian() * 0.9;
      const dAcross = this.burstGaussian() * 0.35;
      vx += alongX * dAlong - alongZ * dAcross;
      vz += alongZ * dAlong + alongX * dAcross;
      vy += this.burstGaussian() * 0.35;
      this.vel[p + 0] = vx;
      this.vel[p + 1] = vy;
      this.vel[p + 2] = vz;

      const coarse = Math.pow(this.burstRandom(), sizeExponent);
      const diameter = DROPLET_MIN + (DROPLET_MAX - DROPLET_MIN) * coarse;
      const vt = terminalVelocity(diameter);
      this.invTau[i] = 9.81 / Math.max(vt, 0.05);
      this.settle[i] = -vt;
      this.sampleEddy(this.pos[p], this.pos[p + 2], elapsed, sigmaH, sigmaW);
      this.turb[p] = this.eddyX;
      this.turb[p + 1] = this.eddyY;
      this.turb[p + 2] = this.eddyZ;

      this.size[s] = 0.75 - 0.68 * coarse + this.burstRandom() * 0.12;
      this.size[s + 1] = this.burstRandom() * 100;
      this.size[s + 2] = (0.7 + 1.9 * coarse) * source.opacity;

      // Sub-frame birth, for the reason the sea's spawn documents at length:
      // an emitter that knows the frame rate produces curtains, and better
      // aerodynamic coupling preserves them rather than blurring them out.
      const flown = this.burstRandom() * dt;
      this.pos[p + 0] += this.vel[p + 0] * flown;
      this.pos[p + 1] += this.vel[p + 1] * flown;
      this.pos[p + 2] += this.vel[p + 2] * flown;
      this.life[l] = flown;
      this.life[l + 1] = (1.8 - 1.3 * coarse) * (0.7 + this.burstRandom() * 0.6);
    }

    this.burstCount += count;
    this.flush();
    return count;
  }

  setLight(
    ambient: THREE.Vector3,
    sunColor: THREE.Color,
    sunIntensity: number,
    forwardScatter: number,
  ): void {
    const u = this.material.uniforms;
    // Mie scattering is achromatic — the reason spray, foam and cloud are all
    // white. Keep the ambient's energy and discard most of its hue: sky-blue
    // droplets read as blue grit the moment they cross anything paler than the
    // sky.
    const luma = ambient.x * 0.2126 + ambient.y * 0.7152 + ambient.z * 0.0722;
    (u.uSkyLight.value as THREE.Vector3)
      .set(
        ambient.x + (luma - ambient.x) * 0.75,
        ambient.y + (luma - ambient.y) * 0.75,
        ambient.z + (luma - ambient.z) * 0.75,
      )
      .multiplyScalar(2.4);
    (u.uSunLight.value as THREE.Vector3).set(
      sunColor.r * sunIntensity,
      sunColor.g * sunIntensity,
      sunColor.b * sunIntensity,
    );
    u.uForward.value = forwardScatter;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
