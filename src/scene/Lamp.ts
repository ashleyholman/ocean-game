import * as THREE from 'three';

/**
 * A ship's oil lantern hung from a short davit on the raft's bow quarter.
 *
 * The one artificial light in the world. Its job is to make a hand-sized
 * warm refuge inside an enormous dark ocean — never to illuminate the sea.
 * The range-limited point light physically cannot reach past a few metres,
 * which enforces that promise better than any tuning discipline would.
 *
 * The shape is the old anchor-lamp pattern, which is what it is because of
 * what it has to survive: a brass oil font low down for ballast, a barrel of
 * glass so the flame throws light sideways to the horizon rather than up, a
 * cage of guard rods around the glass because the one thing that ends a
 * lantern at sea is a swinging boom or a boarding wave, a vented cap so it
 * draws without letting rain in, and a bail to hang it from. Built from that
 * reasoning rather than from a silhouette, and hung — not bolted — because a
 * hung lamp stays upright while the raft rolls under it, which is the whole
 * reason ships hung them.
 *
 * Activation is automatic, driven by sun elevation with hysteresis so the
 * threshold cannot flicker: on below -5 degrees, off above -3. The castaway
 * lights the lamp when the light fails, not at a clock time — at high
 * latitudes that can be mid-afternoon, and in polar summer never.
 */

export type LampMode = 'auto' | 'on' | 'off';

/**
 * Vessel meshes opt into this layer in addition to the normal render layer.
 * The lantern's cube-shadow cameras see only this layer, so six point-shadow
 * faces redraw the nearby hull rather than the 83k-vertex ocean disc.
 */
export const LANTERN_SHADOW_LAYER = 1;

/** Roughly 2100 K, linear-space. Mirrored by LAMP_TINT in the ocean shader. */
export const LAMP_COLOR = new THREE.Color(1.0, 0.55, 0.22);

const ON_BELOW_DEG = -5;
const OFF_ABOVE_DEG = -3;
/** Presentation-time ramp, seconds. */
const RAMP_SECONDS = 2.0;

/**
 * Ambient luminance of a moonless night — the anchor for the daylight rolloff
 * below. Measured from `TimeOfDay.ambientRadiance` at −25 degrees sun.
 */
const AMBIENT_REFERENCE = 1.472e-3;

/**
 * How hard the flame's *illumination* is rolled off as the world brightens.
 *
 * A real lantern is not dim at noon — it is irrelevant at noon. It throws
 * maybe 2 lux at two metres against daylight's hundred thousand, so its
 * contribution is five orders of magnitude down and nothing it lights can be
 * told apart from what the sun is already doing. This scene cannot express
 * that: it spans about 8.5 stops from noon to deep night where the real world
 * spans eighteen, so a flame that is correct at midnight is wildly too strong
 * at noon on the same axis. That is not a lamp bug, it is the compression, and
 * this is the lamp paying its share of it.
 *
 * At 1.0 the lamp's contribution falls with the square of the ambient ratio,
 * which lands the rolloff where it belongs. Measured against ambient:
 *
 *     sun +60°  suppression 0.003 — reflection peak 0.14, well under clipping
 *     sun +10°  suppression 0.006 — a faint warm smudge on the water
 *     sun  +2°  suppression 0.013 — starts to clip; the lamp becomes a highlight
 *     sun  −6°  suppression 0.293 — lit and clearly present, not yet dominant
 *     sun −18°  suppression 0.99  — full strength
 *
 * So the lamp drowns and revives smoothly with the sky, and the on/off
 * hysteresis stops being the thing that carries the transition — it is just
 * the castaway striking a match inside a change the light was already making.
 */
const AMBIENT_ROLLOFF = 1.0;

/**
 * The flame's luminous intensity, in three.js's own PointLight units.
 *
 * The single source of truth for how bright this flame is. The ocean derives
 * its own gain from this number rather than carrying a second hand-set one —
 * see `LAMP_WATER_GAIN` in Ocean.ts, which converts it to the ocean shader's
 * irradiance scale. One flame, two renderers, one number.
 */
export const FLAME_INTENSITY = 1.9;

/**
 * Emissive presentation of the visible wick and its sooted-glass envelope.
 *
 * The old core value was 5.0. Under deep-night exposure that entered the
 * global highlight bleach at roughly 25× display white, erasing the 2100 K
 * colour to neutral. 0.60 keeps the wick brighter than the globe while
 * preserving a visible warm-channel separation through the shared tone curve.
 * These do not change the PointLight or the ocean's reflected-lamp energy.
 */
export const LAMP_CORE_RADIANCE = 0.60;
export const LAMP_GLASS_EMISSIVE_INTENSITY = 0.55;

/** Keep exposure-facing flame surfaces in their calibrated colour range. */
export function lampSurfaceEmissionLevel(emission: number): number {
  return Number.isFinite(emission)
    ? THREE.MathUtils.clamp(emission, 0, 1)
    : 0;
}

/**
 * Height of the flame above the lamp group's origin, metres.
 *
 * The ocean shader reflects a source at this height, and a reflected source's
 * glitter column lengthens with its height above the water — so this is a
 * lighting number as much as a modelling one, and the geometry below is built
 * around it rather than the other way round.
 */
const FLAME_Y = 0.60;

/**
 * The lantern proper — everything from the oil font to the bail — built at a
 * given position, with its own materials so each lamp's emissive state is its
 * own. Shared between the deck lantern (hung from the davit hook) and any
 * interior lamp (hung from a deckhead beam): the object is the same object
 * wherever it hangs, which is true of the real thing too.
 */
export interface LanternAssembly {
  /** Sooted glass shell; its emissive is the "lit globe" the eye reads. */
  glassMaterial: THREE.MeshStandardMaterial;
  /** Unlit flame teardrop; it must not receive its own co-located PointLight. */
  coreMaterial: THREE.MeshBasicMaterial;
  flameMesh: THREE.Mesh;
  /** Local position of the flame within the parent it was built into. */
  flameLocal: THREE.Vector3;
  /**
   * The opaque metal above the flame — cap and crown. On deck these never
   * cast (nothing hangs above a davit but sky); under a deckhead they are
   * what stops the flame painting a bullseye on the planks half a metre up,
   * so an interior lamp opts them into its shadow pass.
   */
  metalTop: THREE.Mesh[];
  /** Every material the build created, for disposal. */
  materials: THREE.Material[];
}

export function buildLanternAssembly(
  parent: THREE.Object3D,
  x: number,
  flameY: number,
): LanternAssembly {
  const iron = new THREE.MeshStandardMaterial({ color: 0x2e2a26, roughness: 0.6, metalness: 0.55 });
  // Brass, tarnished. The font and cap of a real lamp are brass because it
  // does not rust, and a salt-dulled brass is warm without being shiny — it
  // catches the flame's own light from inside, which is most of what makes
  // the object read as lit rather than as a glowing decal.
  const brass = new THREE.MeshStandardMaterial({ color: 0x6b5228, roughness: 0.52, metalness: 0.72 });
  // Sooted glass: barely there when cold, a warm shell when lit. Not
  // transmissive — a physical glass pass costs a render target and would buy
  // nothing at a hand's width across, whereas a cheap emissive shell is
  // exactly the "lit globe" silhouette the eye is looking for at any range.
  const glassMaterial = new THREE.MeshStandardMaterial({
    color: 0x241a10,
    emissive: LAMP_COLOR,
    emissiveIntensity: 0,
    roughness: 0.10,
    metalness: 0,
    transparent: true,
    opacity: 0.30,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const coreMaterial = new THREE.MeshBasicMaterial({
    // The visible wick is an emitter. A lit PBR surface here receives the
    // PointLight placed inside itself at centimetre range and blows through
    // the highlight bleach regardless of its emissive setting.
    color: 0x000000,
    toneMapped: true,
  });

  // Built bottom-up from the oil font, because that is the order the object's
  // proportions come from.

  // Oil font. Wide and low — the mass sits under the flame, which is what
  // keeps a swinging lamp from capsizing itself.
  const font = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.044, 0.072, 10, 1), brass);
  font.position.set(x, flameY - 0.118, 0);
  parent.add(font);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.052, 0.011, 10, 1), brass);
  foot.position.set(x, flameY - 0.159, 0);
  parent.add(foot);

  // Burner collar and the gallery ring the glass sits in.
  const burner = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.030, 0.020, 8, 1), iron);
  burner.position.set(x, flameY - 0.072, 0);
  parent.add(burner);
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(0.064, 0.062, 0.013, 10, 1), brass);
  gallery.position.set(x, flameY - 0.058, 0);
  parent.add(gallery);

  // The glass: a barrel, waisted at both ends where it seats into the
  // gallery below and the cap above. Barrelled rather than straight because
  // the bulge is what throws the flame's light out sideways towards the
  // horizon instead of up at the cap, which is a lantern's whole job.
  const glassProfile = [
    new THREE.Vector2(0.050, 0.000),
    new THREE.Vector2(0.060, 0.024),
    new THREE.Vector2(0.063, 0.062),
    new THREE.Vector2(0.058, 0.104),
    new THREE.Vector2(0.047, 0.128),
  ];
  const glass = new THREE.Mesh(new THREE.LatheGeometry(glassProfile, 12), glassMaterial);
  glass.position.set(x, flameY - 0.052, 0);
  glass.renderOrder = 1;
  parent.add(glass);

  // Guard rods. The signature of a lamp meant for a deck rather than a
  // parlour: the one thing that ends a lantern at sea is a swinging boom or
  // a boarding wave, and four iron rods are what stand between them and the
  // glass. They also break the globe's outline into something legible at
  // range, where a bare bulb of light would just be a blob.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.145, 4, 1), iron);
    rod.position.set(x + Math.cos(a) * 0.069, flameY + 0.011, Math.sin(a) * 0.069);
    parent.add(rod);
  }

  // Vented cap: flared to shed rain, open under the flare so the flame
  // draws. The flare is why lamplight pools downward onto a deck.
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.074, 0.042, 10, 1), iron);
  cap.position.set(x, flameY + 0.100, 0);
  parent.add(cap);
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.020, 0.032, 0.014, 10, 1), iron);
  crown.position.set(x, flameY + 0.128, 0);
  parent.add(crown);

  // Bail handle. Its FEET land in the cap's slope — a bail is pivoted on
  // the lid, and the first cut's wider arch floated its ends in the air
  // beside the cap (Ash's walk). At y +0.112 the cap's cone is 0.043 wide;
  // a 0.040 arch buries both ends in the metal. Top of the arch: +0.152 —
  // the chain and the davit both reach for that number.
  const bail = new THREE.Mesh(new THREE.TorusGeometry(0.040, 0.0042, 4, 11, Math.PI), iron);
  bail.position.set(x, flameY + 0.112, 0);
  parent.add(bail);

  // The flame itself: a teardrop of light at the burner, sitting in the
  // lower third of the glass exactly where an oil wick puts it.
  const flameMesh = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.058, 6, 1), coreMaterial);
  flameMesh.position.set(x, flameY, 0);
  parent.add(flameMesh);

  return {
    glassMaterial,
    coreMaterial,
    flameMesh,
    flameLocal: flameMesh.position.clone(),
    metalTop: [cap, crown],
    materials: [iron, brass, glassMaterial, coreMaterial],
  };
}

export class Lamp {
  readonly group = new THREE.Group();
  readonly light: THREE.PointLight;

  mode: LampMode = 'auto';
  /** Artistic multiplier from the debug panel. */
  intensityScale = 1;

  /** Hysteresis latch: whether the lamp wants to be lit. */
  private wantsOn = false;
  /** 0..1 presentation ramp towards the wanted state. */
  private litFraction = 0;
  /** User/debug intent; the actual cube map also requires visible emission. */
  private shadowRequested = true;

  /**
   * 0..1 emission: lit fraction, artistic scale and flame flicker, with no
   * renderer's intensity units baked in.
   *
   * This is what the ocean shader reads. The PointLight's intensity is the
   * deck's number and belongs to three.js's light loop; keeping the two apart
   * is what stops a trim to the planks from silently retuning the sea.
   */
  emission = 0;

  /**
   * `emission` after the daylight rolloff — what every consumer of the lamp's
   * *illumination* reads: the deck's PointLight, the sail, the ocean.
   *
   * Kept apart from `emission` because they answer different questions.
   * `emission` is how hard the flame is burning, which is a fact about the
   * flame and is what gameplay and the flame's own emissive surfaces want.
   * This is how much that flame matters against the sky it is competing with,
   * which is a fact about the scene's compressed dynamic range.
   *
   * The split is why a lamp lit at noon still looks lit — the glass and the
   * wick keep their own radiance, because daylight does not dim a flame — while
   * lighting nothing you could notice, because at noon it genuinely doesn't.
   */
  renderEmission = 0;

  private readonly coreMaterial: THREE.MeshBasicMaterial;
  private readonly glassMaterial: THREE.MeshStandardMaterial;
  private readonly flameMesh: THREE.Mesh;
  private readonly materials: THREE.Material[] = [];

  /** World-space position of the flame, refreshed each update. */
  readonly flameWorld = new THREE.Vector3();
  private readonly flameLocal = new THREE.Vector3();

  constructor() {
    // --- materials ------------------------------------------------------
    // The davit's own; the lantern assembly brings its brass, glass and flame.
    const timber = new THREE.MeshStandardMaterial({ color: 0x5d4c38, roughness: 0.92 });
    const iron = new THREE.MeshStandardMaterial({ color: 0x2e2a26, roughness: 0.6, metalness: 0.55 });
    const rope = new THREE.MeshStandardMaterial({ color: 0x9a8a68, roughness: 0.95 });
    this.materials.push(timber, iron, rope);

    // --- the davit ------------------------------------------------------
    // A post lashed between two deck logs, raked a few degrees off plumb
    // because nothing on this raft was set with a spirit level, and a short
    // arm over the water side to hang the lamp clear of the timber.
    const RAKE = -0.06;
    const POST_H = 0.86;
    const topX = Math.sin(-RAKE) * POST_H;
    const topY = Math.cos(-RAKE) * POST_H;

    const postMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.034, POST_H, 6, 1), timber);
    postMesh.position.set(topX / 2, topY / 2, 0);
    postMesh.rotation.z = RAKE;
    this.group.add(postMesh);

    // Two rope bands at the foot: the join that actually holds the post up.
    for (const [i, y] of [0.085, 0.155].entries()) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.031, 0.0075, 4, 9), rope);
      band.position.set(Math.sin(-RAKE) * y, y, 0);
      band.rotation.set(Math.PI / 2, 0, RAKE + i * 0.3);
      this.group.add(band);
    }

    const hook = new THREE.Vector3(topX + 0.105, topY - 0.058, 0);
    const armFoot = new THREE.Vector3(topX, topY - 0.015, 0);
    const arm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.014, 0.017, armFoot.distanceTo(hook), 5, 1),
      timber,
    );
    arm.position.copy(armFoot).lerp(hook, 0.5);
    arm.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      hook.clone().sub(armFoot).normalize(),
    );
    this.group.add(arm);

    const eye = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.0035, 4, 8), iron);
    eye.position.copy(hook);
    this.group.add(eye);

    // --- the lantern ----------------------------------------------------
    // Hung, not bolted: a hung lamp stays upright while the raft rolls under
    // it, which is the whole reason ships hung them. The assembly itself is
    // shared with the interior lamp — same object, different hook.
    const lantern = buildLanternAssembly(this.group, hook.x, FLAME_Y);

    // One link joins the davit's eye to the bail. The bail's arch sits lower
    // than it once did — its feet now land on the cap, where a bail's feet
    // belong — and the link spans what that opened up, passing through both
    // rings the way the interior lamps' chains do.
    const link = new THREE.Mesh(new THREE.TorusGeometry(0.027, 0.004, 4, 9), iron);
    link.position.set(hook.x, (hook.y + FLAME_Y + 0.152) / 2, 0);
    link.rotation.y = Math.PI / 2;
    this.group.add(link);
    this.glassMaterial = lantern.glassMaterial;
    this.coreMaterial = lantern.coreMaterial;
    this.flameMesh = lantern.flameMesh;
    this.flameLocal.copy(lantern.flameLocal);
    this.materials.push(...lantern.materials);

    // --- the light -----------------------------------------------------
    // Physical decay with a hard range: the refuge is the raft, not the sea.
    // The ocean shader windows its own lamp radiance at this same 7.5 m.
    this.light = new THREE.PointLight(LAMP_COLOR, 0, 7.5, 2);
    this.light.position.copy(this.flameLocal);
    // A point source needs six depth faces, but each face contains only the
    // vessel-shadow layer (never the ocean). 256 px resolves a 15.5 m hull at
    // this light's 7.5 m range while keeping the first geometry-driven version
    // small enough to profile honestly before any fallback is considered.
    // Off until the flame contributes measurable radiance. A point shadow is
    // six passes, so paying it during daylight or while the lamp is cold would
    // be pure waste. `syncShadowState` turns it on with the illumination.
    this.light.castShadow = false;
    this.light.shadow.mapSize.set(256, 256);
    this.light.shadow.camera.near = 0.12;
    this.light.shadow.camera.far = 7.5;
    this.light.shadow.camera.layers.set(LANTERN_SHADOW_LAYER);
    this.light.shadow.bias = -0.002;
    this.light.shadow.normalBias = 0.015;
    this.light.shadow.radius = 1.25;
    this.light.shadow.camera.updateProjectionMatrix();
    this.group.add(this.light);

    // The lantern cage itself neither casts nor receives vessel shadows; at
    // its scale a shadow-map texel is bigger than the whole guard assembly.
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
  }

  /** Current 0..1 lit state, after mode, hysteresis and ramp. */
  get litLevel(): number {
    return this.litFraction;
  }

  /**
   * Jump the presentation ramp to its target. The capture host's determinism
   * hook: a settled frame must not depend on how many frames the settle took.
   */
  snapLit(): void {
    this.litFraction =
      this.mode === 'auto' ? (this.wantsOn ? 1 : 0) : this.mode === 'on' ? 1 : 0;
  }

  get isOn(): boolean {
    return this.litFraction > 0.01;
  }

  /** Geometry-driven lantern shadow switch used by visual and cost A/Bs. */
  setShadowEnabled(enabled: boolean): void {
    this.shadowRequested = enabled;
    this.syncShadowState();
  }

  get shadowEnabled(): boolean {
    return this.shadowRequested;
  }

  get shadowActive(): boolean {
    return this.light.castShadow;
  }

  private syncShadowState(): void {
    const active = this.shadowRequested && this.renderEmission > 1e-4;
    if (this.light.castShadow === active) return;
    this.light.castShadow = active;
    this.light.shadow.needsUpdate = active;
  }

  /**
   * Advance activation and flame. Presentation time only: the ramp and the
   * flame breathe at wall-clock speed however fast the world clock runs.
   *
   * `ambientLuminance` is `TimeOfDay.ambientRadiance`'s luminance, and it only
   * feeds the daylight rolloff — see `renderEmission`. Required rather than
   * defaulted: a caller that forgets it would get a lantern that burns at full
   * strength at noon, which is the exact bug this parameter exists to kill.
   */
  update(
    presentationDtSeconds: number,
    sunElevationDeg: number,
    elapsedSeconds: number,
    ambientLuminance: number,
  ): void {
    // Hysteresis on the astronomical input.
    if (sunElevationDeg < ON_BELOW_DEG) this.wantsOn = true;
    else if (sunElevationDeg > OFF_ABOVE_DEG) this.wantsOn = false;

    const target = this.mode === 'auto' ? (this.wantsOn ? 1 : 0) : this.mode === 'on' ? 1 : 0;
    const step = RAMP_SECONDS > 0 ? presentationDtSeconds / RAMP_SECONDS : 1;
    this.litFraction = THREE.MathUtils.clamp(
      this.litFraction + Math.sign(target - this.litFraction) * step,
      Math.min(this.litFraction, target),
      Math.max(this.litFraction, target),
    );

    // A slow, restrained breathing — an oil flame in still air, not a strobe.
    const flame =
      1 +
      0.04 * Math.sin(elapsedSeconds * 1.9) * Math.sin(elapsedSeconds * 0.53 + 1.3) +
      0.02 * Math.sin(elapsedSeconds * 3.1 + 0.7);

    const lit = this.litFraction * this.intensityScale * flame;
    this.emission = lit;

    // Daylight rolloff. Anchored at a moonless night, where the flame's
    // absolute value was calibrated and is honest, and falling from there as
    // the sky brightens past it. Never above 1: a night darker than the
    // reference (the airglow floor is the reference) must not amplify the lamp.
    const suppression = Math.pow(
      Math.max(ambientLuminance, AMBIENT_REFERENCE) / AMBIENT_REFERENCE,
      -AMBIENT_ROLLOFF,
    );
    this.renderEmission = lit * suppression;
    this.syncShadowState();

    // Point-light scaling can exceed one in the lab, but feeding that same
    // multiplier into the visible wick/globe only pushes their pixels into
    // the global white-highlight bleach. The light flux still follows the
    // full multiplier; presentation surfaces stop at their calibrated burn.
    const surfaceLit = lampSurfaceEmissionLevel(lit);

    // Illumination is suppressed; the flame's own surfaces are not. Daylight
    // does not dim a flame — it only makes what the flame lights indiscernible
    // from what the sun is already lighting. So a lamp burning at noon still
    // reads as burning if you look straight at it, and lights nothing.
    this.light.intensity = FLAME_INTENSITY * this.renderEmission;
    this.coreMaterial.color
      .copy(LAMP_COLOR)
      .multiplyScalar(LAMP_CORE_RADIANCE * surfaceLit);
    // The globe glows with the flame inside it. This, not the wick, is what
    // reads as "lit" past a few metres — and it is what the sea reflects, which
    // is why the ocean shader's sphere-light radius is the globe's, not the
    // flame's.
    this.glassMaterial.emissiveIntensity =
      LAMP_GLASS_EMISSIVE_INTENSITY * surfaceLit;
    // The flame leans and lengthens on the same breath that dims it, so the
    // flicker is a moving object rather than a brightness envelope.
    this.flameMesh.scale.set(1, 0.9 + 0.34 * flame, 1);
    this.flameMesh.rotation.z = 0.05 * Math.sin(elapsedSeconds * 1.35 + 0.4);

    this.flameWorld.copy(this.flameLocal).applyMatrix4(this.group.matrixWorld);
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.light.shadow.dispose();
  }
}
