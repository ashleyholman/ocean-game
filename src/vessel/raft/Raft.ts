import * as THREE from 'three';
import { GLSL_COMMON } from '../../scene/shaders/lib';
import { Lamp, LANTERN_SHADOW_LAYER } from '../../scene/Lamp';
import { RaftBuoyancy } from './RaftBuoyancy';
import {
  DECK_LENGTH,
  DECK_WIDTH,
  DECK_Y,
  MAST_HEIGHT,
  RAFT_SEED,
  SAIL_WIDTH,
  buildRaftTimber,
  buildRaftTopsides,
  makeRandom,
} from './raftFlotation';
import { OvertopSpray } from '../../scene/OvertopSpray';
import type {
  Vessel,
  VesselPhysicsContext,
  VesselPresentationContext,
} from '../Vessel';

/**
 * A crude improvised raft, roughly 3.2 x 2.2 m, and one small seated figure.
 *
 * The raft floats. It is not animated onto the water and it does not chase a
 * target: `RaftBuoyancy` integrates a rigid body from the hydrostatic pressure
 * on the actual log geometry, sampled against the same surface definition the
 * ocean is rendered from, in the same coordinate space, at the same instant.
 *
 * This class owns the *meshes*. The timber itself — radii, lengths, positions,
 * and the topside mass budget — is built as data in `raftFlotation.ts` and used
 * twice: once to place the cylinders below, once to construct `RaftBuoyancy`.
 * One description of one object is what stops the physics model and the visible
 * timber ever disagreeing, and it is now also what lets the flotation be tested
 * headlessly (`tests/raft-buoyancy-golden.test.ts`), which it could not be while
 * the numbers were trapped inside this constructor.
 */

const SAIL_VERTEX = /* glsl */ `
precision highp float;

#define PI 3.141592653589793

uniform float uFurl;
uniform float uTime;
uniform float uWidth;
uniform float uHeight;

varying vec2 vUv;
varying vec3 vWorld;

void main() {
  vUv = uv;

  // Distance down the cloth from the yard.
  float s = (1.0 - uv.y) * uHeight;
  float freeLen = uHeight * (1.0 - uFurl);
  float open = 1.0 - uFurl;

  vec3 p;
  if (s <= freeLen) {
    p = vec3(position.x, -s, 0.0);

    float edge = sin(uv.x * PI);
    float drop = smoothstep(0.0, 0.40, s / max(uHeight, 1e-3));

    // The cloth is cut and hung by hand: the leech is not straight and the
    // foot scallops between the corners.
    float ragged = sin(uv.y * 5.3 + 1.1) * 0.045 + sin(uv.y * 11.7) * 0.022;
    p.x += ragged * sign(position.x) * open;
    p.y += edge * 0.10 * open * smoothstep(0.55, 1.0, s / max(uHeight, 1e-3));

    // Wind-filled belly plus a slow flutter. Both vanish as the sail furls.
    float belly = edge * drop * (0.265 + 0.045 * sin(uTime * 0.63)) * open;
    float ripple = sin(s * 4.6 - uTime * 2.7 + uv.x * 5.2) * 0.024 * open * drop;
    float luff = sin(uTime * 1.9 + uv.x * 3.1) * 0.016 * open * drop;
    p.z += belly + ripple + luff;
    p.y += -0.045 * edge * open;
  } else {
    // Rolled around a horizontal axis at the foot of the free length.
    float t = s - freeLen;
    float R = 0.042 + 0.080 * uFurl;
    float phi = t / R;
    p = vec3(position.x, -freeLen - R * sin(phi), -R + R * cos(phi));
    // A hand-rolled bundle is never even.
    p.z += sin(uv.x * 7.0) * 0.010 * uFurl;
  }

  // The plane is authored at the finished width, so position.x passes through.
  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const SAIL_FRAGMENT = /* glsl */ `
precision highp float;

${GLSL_COMMON}

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform vec3 uAmbient;
uniform float uFurl;
uniform vec3 uLampPos;
uniform vec3 uLampColor;

varying vec2 vUv;
varying vec3 vWorld;

void main() {
  // Geometric normal from screen-space derivatives: robust for a mesh that is
  // deformed entirely in the vertex shader.
  vec3 N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 V = normalize(cameraPosition - vWorld);
  if (dot(N, V) < 0.0) N = -N;

  // Faded, patched, off-white rag. Sun-bleached, not laundered.
  vec3 base = vec3(0.400, 0.376, 0.330);
  float patchMask = step(0.52, vnoise(vUv * vec2(2.6, 3.1)));
  base *= mix(1.0, 0.760, patchMask);
  float patch2 = step(0.62, vnoise(vUv * vec2(4.3, 2.2) + 11.0));
  base *= mix(1.0, 1.140, patch2);
  float stain = vnoise(vUv * 6.5 + 3.0);
  base *= 0.76 + 0.40 * stain;
  float grime = vnoise(vUv * vec2(1.7, 2.9) + 21.0);
  base *= 0.86 + 0.22 * smoothstep(0.25, 0.75, grime);
  base *= 0.955 + 0.045 * sin(vUv.y * 220.0);

  float ndl = max(dot(N, uSunDir), 0.0);
  // Thin cloth: most of the drama is the sun coming through from behind.
  // One layer of cloth transmits; a furled roll is many layers and does not —
  // without the gate the stowed bundle lit up like a glass tube whenever the
  // sun was behind it.
  float single = 1.0 - uFurl * 0.85;
  float through = pow(max(dot(-N, uSunDir), 0.0), 1.7) * 0.80 * single;

  float ndlMoon = max(dot(N, uMoonDir), 0.0);
  float throughMoon = pow(max(dot(-N, uMoonDir), 0.0), 1.7) * 0.60 * single;

  // The lamp: an inverse-square point a couple of metres away, so the foot of
  // the cloth warms at night while the head stays dark.
  vec3 toLamp = uLampPos - vWorld;
  float lampD2 = dot(toLamp, toLamp);
  vec3 Ll = toLamp * inversesqrt(max(lampD2, 1e-4));
  float lampAtten = 1.0 / (1.0 + lampD2);

  // The 1/PI matches the Lambert normalisation the raft's standard materials
  // use, so the cloth and the timber sit in the same light instead of the sail
  // reading as a lit panel next to a black deck.
  vec3 color = base * (uAmbient
    + uSunColor * (ndl * 0.72 + through)
    + uMoonColor * (ndlMoon * 0.85 + throughMoon)
    + uLampColor * max(dot(N, Ll), 0.0) * lampAtten) * (1.0 / PI);

  gl_FragColor = vec4(color, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Raft implements Vessel {
  readonly kind = 'raft' as const;
  readonly group = new THREE.Group();
  /** Mast endpoints in raft space; the tap target is the segment between them. */
  readonly mastBase = new THREE.Vector3();
  readonly mastTop = new THREE.Vector3();

  /** Water height under the raft centre this frame — used by the camera rig. */
  waterHeight = 0;

  /** Masthead in raft-local coordinates. The camera transition clears it. */
  readonly mastHead = new THREE.Vector3();

  /** The floating body. Public so the diagnostic harness can read it. */
  readonly body: RaftBuoyancy;
  readonly spray = new OvertopSpray();
  readonly sceneObjects: readonly THREE.Object3D[];
  readonly halfLengthM = DECK_LENGTH / 2;
  readonly halfBeamM = DECK_WIDTH / 2;
  readonly waterlineLocalY = 0;
  /** The night lantern. Public for the graphics panel's mode controls. */
  readonly lamp = new Lamp();

  private readonly hull = new THREE.Group();
  private readonly rigging = new THREE.Group();
  private readonly sailMesh: THREE.Mesh;
  private readonly sailMaterial: THREE.ShaderMaterial;
  private readonly yard: THREE.Mesh;
  private readonly figure: THREE.Group;

  private readonly materials: THREE.Material[] = [];
  private yaw = 0;
  private readonly originPoint = { x: 0, y: 0, z: 0 };

  /**
   * Physics substep, seconds. Fixed in production; the diagnostic harness
   * overrides it to prove the result does not depend on it.
   */
  physicsStep: number | undefined = undefined;

  /**
   * Height of the deck-log *axes* above the raft origin. Note this is not the
   * deck surface: the walking surface is a log radius higher, at about 0.25.
   */
  private readonly deckY = DECK_Y;

  constructor() {
    this.sceneObjects = [this.group, this.spray.group];
    const rand = makeRandom(RAFT_SEED);

    // Flotation geometry. Built as data in `raftFlotation.ts` and handed to
    // both the meshes below and the physics, so the two cannot disagree. The
    // generator is passed in rather than owned there because the lashings and
    // mast wraps further down continue the same sequence.
    const timber = buildRaftTimber(rand);
    const { logs: logGeometry, beams: beamGeometry } = timber;

    const woodColors = [0x6b5842, 0x5d4c38, 0x796650, 0x554637, 0x6f5b45];
    const woods = woodColors.map((c) => {
      const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.92, metalness: 0.0 });
      this.materials.push(m);
      return m;
    });
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0x8a7a5c, roughness: 0.95 });
    this.materials.push(ropeMat);

    // --- deck logs -------------------------------------------------------
    // `rotation.x = PI/2` followed by `rotation.z` (Euler XYZ, so Z applies
    // first) maps the cylinder axis to (-sin z, 0, cos z) — exactly horizontal,
    // pointing along +Z. So `radiusTop` is the bow end and each log's vertical
    // extent is precisely its axis height plus or minus the local radius.
    for (let i = 0; i < logGeometry.length; i++) {
      const record = logGeometry[i];
      const geo = new THREE.CylinderGeometry(
        record.radiusBow,
        record.radiusStern,
        record.length,
        7,
        1,
      );
      const log = new THREE.Mesh(geo, woods[i % woods.length]);
      log.rotation.x = Math.PI / 2;
      log.rotation.z = timber.logTilt[i];
      log.position.set(record.x, record.y, record.z);
      this.hull.add(log);
    }

    // --- cross beams beneath the logs -------------------------------------
    for (let i = 0; i < beamGeometry.length; i++) {
      const record = beamGeometry[i];
      const geo = new THREE.CylinderGeometry(0.075, 0.070, record.length, 6, 1);
      const beam = new THREE.Mesh(geo, woods[2]);
      beam.rotation.z = Math.PI / 2;
      beam.rotation.y = timber.beamYaw[i];
      beam.position.set(0, record.y, record.z);
      this.hull.add(beam);
    }

    // --- rope lashings ----------------------------------------------------
    // A flattened loop around the raft's cross-section at each beam station.
    for (const z of [-1.06, 1.06]) {
      const geo = new THREE.TorusGeometry(1.0, 0.021, 5, 26);
      const loop = new THREE.Mesh(geo, ropeMat);
      loop.scale.set(DECK_WIDTH * 0.53, 0.20, 1);
      loop.position.set(0, this.deckY - 0.02, z);
      this.hull.add(loop);
    }
    // Short lashings binding individual logs, deliberately uneven.
    for (let i = 0; i < 6; i++) {
      const geo = new THREE.TorusGeometry(0.14, 0.016, 4, 12);
      const tie = new THREE.Mesh(geo, ropeMat);
      tie.rotation.y = Math.PI / 2;
      tie.scale.set(1, 0.55, 1);
      tie.position.set(-0.85 + rand() * 1.7, this.deckY + 0.045, -1.06 + (i % 2) * 2.12 + (rand() - 0.5) * 0.1);
      this.hull.add(tie);
    }

    this.group.add(this.hull);

    // --- mast --------------------------------------------------------------
    const mastHeight = MAST_HEIGHT;
    const mastGeo = new THREE.CylinderGeometry(0.042, 0.062, mastHeight, 6, 1);
    const mast = new THREE.Mesh(mastGeo, woods[3]);
    mast.position.set(0.04, this.deckY + mastHeight / 2 - 0.02, -0.34);
    mast.rotation.x = 0.045;
    mast.rotation.z = -0.022;
    this.rigging.add(mast);
    this.mastBase.set(0.04, this.deckY, -0.34);
    this.mastTop.set(0.04, this.deckY + mastHeight, -0.34);
    this.mastHead.copy(this.mastTop);

    // Mast step: a rough block lashed to the deck.
    const stepGeo = new THREE.BoxGeometry(0.30, 0.14, 0.34);
    const step = new THREE.Mesh(stepGeo, woods[4]);
    step.position.set(0.04, this.deckY + 0.10, -0.34);
    step.rotation.y = 0.08;
    this.rigging.add(step);

    for (let i = 0; i < 3; i++) {
      const geo = new THREE.TorusGeometry(0.075, 0.014, 4, 10);
      const wrap = new THREE.Mesh(geo, ropeMat);
      wrap.rotation.x = Math.PI / 2 + (rand() - 0.5) * 0.2;
      wrap.position.set(0.04, this.deckY + 0.20 + i * 0.07, -0.335);
      this.rigging.add(wrap);
    }

    // --- stays -------------------------------------------------------------
    const mastTop = new THREE.Vector3(0.04 + 0.055, this.deckY + mastHeight - 0.05, -0.34 + 0.115);
    const stayAnchors = [
      new THREE.Vector3(-1.0, this.deckY + 0.04, 1.45),
      new THREE.Vector3(1.0, this.deckY + 0.04, 1.45),
      new THREE.Vector3(0.0, this.deckY + 0.04, -1.5),
    ];
    for (const anchor of stayAnchors) {
      const dir = new THREE.Vector3().subVectors(anchor, mastTop);
      const len = dir.length();
      const geo = new THREE.CylinderGeometry(0.010, 0.010, len, 4, 1);
      const stay = new THREE.Mesh(geo, ropeMat);
      stay.position.copy(mastTop).addScaledVector(dir, 0.5);
      stay.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      this.rigging.add(stay);
    }

    // --- yard and sail -------------------------------------------------------
    const sailWidth = SAIL_WIDTH;
    const sailHeight = 1.92;

    const yardGeo = new THREE.CylinderGeometry(0.030, 0.026, sailWidth + 0.24, 5, 1);
    this.yard = new THREE.Mesh(yardGeo, woods[1]);
    this.yard.rotation.z = Math.PI / 2;
    this.yard.rotation.x = 0.03;
    this.rigging.add(this.yard);

    const sailGeo = new THREE.PlaneGeometry(sailWidth, 1, 14, 18);
    this.sailMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uFurl: { value: 1 },
        uTime: { value: 0 },
        uWidth: { value: sailWidth },
        uHeight: { value: sailHeight },
        uSunDir: { value: new THREE.Vector3(0, 0.1, -1) },
        uSunColor: { value: new THREE.Vector3(1, 1, 1) },
        uMoonDir: { value: new THREE.Vector3(0, -0.1, 1) },
        uMoonColor: { value: new THREE.Vector3(0, 0, 0) },
        uAmbient: { value: new THREE.Vector3(0.2, 0.22, 0.28) },
        uLampPos: { value: new THREE.Vector3() },
        uLampColor: { value: new THREE.Vector3() },
      },
      vertexShader: SAIL_VERTEX,
      fragmentShader: SAIL_FRAGMENT,
      side: THREE.DoubleSide,
    });
    this.sailMesh = new THREE.Mesh(sailGeo, this.sailMaterial);
    this.sailMesh.frustumCulled = false;
    this.rigging.add(this.sailMesh);

    this.group.add(this.rigging);

    // --- figure --------------------------------------------------------------
    this.figure = buildFigure(this.materials);
    this.figure.position.set(-0.18, this.deckY + 0.06, 1.02);
    this.figure.rotation.y = -0.42;
    this.group.add(this.figure);

    // A small bundle of spare cordage: one object, not an inventory.
    const bundleGeo = new THREE.TorusGeometry(0.13, 0.045, 5, 12);
    const bundle = new THREE.Mesh(bundleGeo, ropeMat);
    bundle.rotation.x = Math.PI / 2;
    bundle.position.set(0.72, this.deckY + 0.08, 0.42);
    this.group.add(bundle);

    this.group.rotation.order = 'YXZ';

    // Raft-local shadows: timber, rigging and figure cast onto the deck.
    // The sail is excluded — its cloth is deformed entirely in the vertex
    // shader, so the default depth material would cast the undeformed plane's
    // shadow, which is worse than none.
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const isSail = object === this.sailMesh;
      object.castShadow = !isSail;
      object.receiveShadow = !isSail;
      if (!isSail) object.layers.enable(LANTERN_SHADOW_LAYER);
    });

    // The lantern, lashed to a short post on the bow quarter beside the
    // castaway. Added after the shadow pass above: at its scale a shadow-map
    // texel is bigger than the cage, and it opts out internally.
    // Deliberately absent from the buoyancy topsides: a kilogram of lamp is
    // far below the physics' resolution, and this round must not move the
    // raft's dynamics by a hair.
    this.lamp.group.position.set(0.82, this.deckY, 0.88);
    this.lamp.group.rotation.y = -0.35;
    this.group.add(this.lamp.group);

    // --- flotation ------------------------------------------------------------
    // Everything that is not a log or a cross beam is a topside mass. Positions
    // are the same literals the meshes above were placed with, so the physics
    // and the picture describe one object.
    const topsides = buildRaftTopsides();

    this.body = new RaftBuoyancy({
      logs: logGeometry,
      beams: beamGeometry,
      deckLength: DECK_LENGTH,
      topsides,
    });

    // --- critical dry points --------------------------------------------------
    // Heights come from the geometry, not from round numbers. The deck surface
    // is the crown of the centre logs, which is a log radius above `deckY`.
    const byX = [...logGeometry].sort((a, b) => a.x - b.x);
    const centreLogs = byX.slice(3, 6);
    const deckCrown =
      centreLogs.reduce((a, l) => a + l.y + (l.radiusBow + l.radiusStern) / 2, 0) / centreLogs.length;

    this.body.addCriticalPoint('DECK_CENTRE', 0, deckCrown, 0);
    this.body.addCriticalPoint('DECK_BOW', 0, deckCrown, 1.2);
    this.body.addCriticalPoint('DECK_STERN', 0, deckCrown, -1.2);
    this.body.addCriticalPoint('MAST_STEP', 0.04, this.deckY + 0.17, -0.34);
    this.body.addCriticalPoint('FIGURE_TORSO', -0.18, 0.2926, 1.075);
    // With the sail furled the yard sits at deckY + 0.62 and the rolled cloth
    // hangs a further (0.042 + 0.080) below the sail origin. This is the
    // "folded-sail lever" of the bug report, and the worst case: raising the
    // sail lifts the whole assembly by 1.66 m.
    this.body.addCriticalPoint('FOLDED_SAIL', 0.06, this.deckY + 0.62 - 0.03 - 0.122, -0.30);
    this.body.addCriticalPoint('YARD', 0.06, this.deckY + 0.62, -0.30);
  }

  advancePhysics(context: VesselPhysicsContext): void {
    const {
      dt,
      waves,
      localX,
      localZ,
      wind,
      elapsed,
    } = context;
    // A raft with a square sail lies roughly with the wind, wandering slowly.
    this.yaw =
      wind.headingRad +
      Math.sin(elapsed * 0.075) * 0.11 +
      Math.sin(elapsed * 0.028 + 1.7) * 0.07;

    // Integrate the floating body. This advances the wave field internally, one
    // fixed substep at a time, so buoyancy is evaluated on the surface that
    // exists at each instant — and `waves.time` afterwards is the instant the
    // ocean must be rendered at.
    this.body.update(dt, waves, localX, localZ, this.yaw, this.physicsStep);

    this.waterHeight = this.body.centreWaterY;
  }

  updatePresentation(context: VesselPresentationContext): void {
    const {
      dt,
      localX,
      localZ,
      wind,
      elapsed,
      sunDirection,
      sunColor,
      sunIntensity,
      moonDirection,
      moonColor,
      moonIntensity,
      ambientRadiance,
    } = context;

    // The body pivots about its centre of mass, which sits above and slightly
    // aft of the model origin, so the origin swings a little as the raft tilts.
    this.body.worldPoint(0, 0, 0, localX, localZ, this.yaw, this.originPoint);
    this.group.position.set(this.originPoint.x, this.originPoint.y, this.originPoint.z);
    this.group.rotation.set(this.body.pitch, this.yaw, this.body.roll);

    this.spray.update(dt, this.body.overtopEvents);

    // --- sail ---------------------------------------------------------------
    const furl = 1 - this.sail01(wind.sail);
    const yardY = this.deckY + 0.62 + wind.sail * 1.66;
    this.yard.position.set(0.06, yardY, -0.30);
    this.sailMesh.position.set(0.06, yardY - 0.03, -0.30);

    // --- lamp ---------------------------------------------------------------
    // Needs the finished matrixWorld for the flame's world position, and the
    // presentation clock so the flame breathes at wall speed.
    this.group.updateMatrixWorld();
    const sunElevationDeg =
      Math.asin(Math.min(Math.max(sunDirection.y, -1), 1)) * (180 / Math.PI);
    // Luminance of the sky's own fill, which is what the lamp's daylight
    // rolloff measures itself against.
    const ambientLuminance =
      0.2126 * ambientRadiance.x + 0.7152 * ambientRadiance.y + 0.0722 * ambientRadiance.z;
    this.lamp.update(dt, sunElevationDeg, elapsed, ambientLuminance);

    const u = this.sailMaterial.uniforms;
    u.uFurl.value = furl;
    u.uTime.value = elapsed;
    (u.uLampPos.value as THREE.Vector3).copy(this.lamp.flameWorld);
    (u.uLampColor.value as THREE.Vector3)
      .set(1.0, 0.55, 0.22)
      .multiplyScalar(this.lamp.light.intensity);
    (u.uSunDir.value as THREE.Vector3).copy(sunDirection);
    (u.uSunColor.value as THREE.Vector3)
      .set(sunColor.r, sunColor.g, sunColor.b)
      .multiplyScalar(sunIntensity);
    (u.uMoonDir.value as THREE.Vector3).copy(moonDirection);
    (u.uMoonColor.value as THREE.Vector3)
      .set(moonColor.r, moonColor.g, moonColor.b)
      .multiplyScalar(moonIntensity);
    // Real radiance, so the cloth genuinely goes dark after sunset instead of
    // hanging in the night like a lit paper screen. 3.2 rather than 5.0: with
    // the direct sun restored to the sky's own illuminant scale, an ambient
    // this strong was the reason a sunset-facing sail stayed cold and grey.
    (u.uAmbient.value as THREE.Vector3).copy(ambientRadiance).multiplyScalar(3.2);

    this.spray.setLight(ambientRadiance, sunColor, sunIntensity);

    // The figure breathes. Barely.
    this.figure.position.y = this.deckY + 0.06 + Math.sin(elapsed * 0.9) * 0.008;
  }

  /** Presentation heading of the raft this frame, radians. */
  get heading(): number {
    return this.yaw;
  }

  resetEffects(): void {
    this.spray.clear();
  }

  activeOvertopSprayCount(): number {
    return this.spray.activeCount;
  }

  /**
   * Show or hide the castaway.
   *
   * The embodied camera sits at the figure's eyes, inside the head sphere, and
   * a camera rendering from inside a head renders the inside of a head. This is
   * the whole of the first-person visibility compromise for this round: the
   * figure is culled, and no first-person body is built to replace it. The
   * camera system drives it by proximity, so it also covers the last few frames
   * of a transition without a special case.
   */
  setEmbodiedFigureVisible(visible: boolean): void {
    this.figure.visible = visible;
  }

  updateTrimPickTargets(low: THREE.Vector3, high: THREE.Vector3): void {
    this.group.updateMatrixWorld();
    low.copy(this.mastBase).applyMatrix4(this.group.matrixWorld);
    high.copy(this.mastTop).applyMatrix4(this.group.matrixWorld);
  }

  private sail01(v: number): number {
    return v * v * (3 - 2 * v);
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.sailMaterial.dispose();
    this.spray.dispose();
    this.lamp.dispose();
  }
}

/**
 * One seated human, about 1.75 m if they stood up. Deliberately low detail —
 * a readable silhouette at 90 px is worth far more here than a face.
 */
function buildFigure(materials: THREE.Material[]): THREE.Group {
  const group = new THREE.Group();

  // Albedo high enough to model in direct daylight; the night silhouette is
  // carried by the light levels, not by painting the figure nearly black.
  const cloth = new THREE.MeshStandardMaterial({ color: 0x4c4a52, roughness: 0.95 });
  const skin = new THREE.MeshStandardMaterial({ color: 0x6d5a49, roughness: 0.85 });
  materials.push(cloth, skin);

  // Torso, leaning back against the mast bundle.
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.135, 0.34, 3, 8), cloth);
  torso.position.set(0, 0.40, 0.055);
  torso.rotation.x = -0.30;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.098, 10, 8), skin);
  head.position.set(0, 0.685, -0.045);
  group.add(head);

  // Thighs forward, shins down: a person sitting on a low deck.
  const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.082, 0.30, 3, 6), cloth);
  thigh.position.set(-0.085, 0.135, 0.30);
  thigh.rotation.x = Math.PI / 2 - 0.22;
  group.add(thigh);

  const thigh2 = thigh.clone();
  thigh2.position.x = 0.085;
  thigh2.rotation.x = Math.PI / 2 - 0.16;
  group.add(thigh2);

  const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.062, 0.26, 3, 6), cloth);
  shin.position.set(-0.085, 0.075, 0.53);
  shin.rotation.x = Math.PI / 2 - 0.85;
  group.add(shin);

  const shin2 = shin.clone();
  shin2.position.x = 0.085;
  shin2.rotation.x = Math.PI / 2 - 0.78;
  group.add(shin2);

  // Arms resting, one hand back on the deck.
  const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.30, 3, 6), cloth);
  arm.position.set(-0.185, 0.315, 0.10);
  arm.rotation.x = -0.55;
  arm.rotation.z = 0.16;
  group.add(arm);

  const arm2 = arm.clone();
  arm2.position.x = 0.185;
  arm2.rotation.z = -0.22;
  arm2.rotation.x = -0.30;
  group.add(arm2);

  return group;
}
