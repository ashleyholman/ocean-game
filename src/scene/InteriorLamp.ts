import * as THREE from 'three';
import {
  LAMP_COLOR,
  LAMP_CORE_RADIANCE,
  LAMP_GLASS_EMISSIVE_INTENSITY,
  LANTERN_SHADOW_LAYER,
  buildLanternAssembly,
  lampSurfaceEmissionLevel,
  type LampMode,
  type LanternAssembly,
} from './Lamp';

/**
 * A lantern hung from a deckhead beam below decks.
 *
 * The same lantern the deck davit carries — `buildLanternAssembly` is shared —
 * but hung below decks and answering to a different question. The deck lamp
 * competes with the SKY, so its daylight rolloff and its on/off latch run on
 * sun elevation and global ambient. A room's lamp competes with the ROOM: the
 * light it has to matter against is whatever the openings deliver, and that
 * dies with the sun's azimuth as much as its elevation — a low sun astern
 * floods the cabin while the same sun forward leaves it black. Sun elevation
 * cannot see that difference. The room's own daylight can, so that is the
 * signal everything here runs on.
 *
 * The signal is feed-forward by construction: the caller derives it from the
 * portal channels (sky plus beam, through the room's transfer weights, times
 * the room's lift) BEFORE any lamp light is added. The lamp cannot see itself,
 * so it cannot flicker against its own contribution.
 *
 * Activation is the castaway's own rule carried below: light the lamp when
 * the light fails — which below decks is a fact about the room, not the sky.
 * Hysteresis keeps the threshold from chattering, and the portal channels
 * refresh slowly enough that a passing cloud is a drift, not an edge. On top
 * of the latch rides the player's own hand — `toggleManual`, the Space
 * action — which holds until the latch next changes its own mind: douse the
 * lamp at night and it stays out until the morning release lets the routine
 * resume; light it at noon and it burns until the evening strike agrees.
 *
 * The lamp HANGS: chain and lantern live in a swing group pivoting at the
 * hook's eye, and a damped pendulum tracks apparent down while the ship
 * rolls under it — which is the whole reason ships hung their lamps.
 */

/**
 * Room daylight luminance below which the lamp is lit, and above which it is
 * put out — in units of the room's lifted mean radiosity (transfer-weighted
 * portal sum × room lift). Calibrated from the baseline sheet at the cabin
 * stand, default heading and lift ×14:
 *
 *     07:00  0.160   morning floods the room — lamp out
 *     14:00  0.047   afternoon, dim but live — lamp out
 *     17:00  0.032   the day starting to fail — the match is struck
 *     18:00  0.020   dim — the lamp is most of the room now
 *     19:00  0.005   near-black without it
 *     22:00  0.000   night
 *
 * Ash's tuning walk (2026-08-14) moved both thresholds up from the first
 * cut (0.022/0.035): the lamp lights a little earlier — 17:00 is lit — and
 * survives a little later into the morning. The off threshold sits close
 * under 14:00's 0.047; if the cabin lift dial ever drops much below ×14
 * the afternoon signal falls with it and this margin is the first casualty
 * — the calibration test is what will say so.
 */
export const ON_BELOW_LUMINANCE = 0.034;
export const OFF_ABOVE_LUMINANCE = 0.043;

/** Presentation-time ramp, seconds — the wick catching, not a switch. */
const RAMP_SECONDS = 2.0;

/**
 * The room luminance at and below which the flame deserves full strength,
 * anchoring the daylight rolloff. By 19:00's measured 0.005 the room is
 * night to the eye and the flame's calibrated brightness is honest; above
 * the reference the flame's *illumination* falls with the square of the
 * ratio, exactly as the deck lantern drowns in the sky. At the 17:00 strike
 * (0.032) suppression is ~0.14 — a presence, not yet the room's light —
 * and a lamp forced on at 07:00 (0.160) lights ~0.6% of nothing.
 */
export const ROOM_REFERENCE_LUMINANCE = 0.012;
export const ROOM_ROLLOFF = 2.0;

/**
 * The applied scene exposure the flame's intensity was calibrated under —
 * 19:00, the hour the room-driven policy hands the room to the lamp.
 *
 * The authored exposure curve keeps rising after sundown (×5 by 22:00) to
 * hold the DECK legible under a dark sky. The deck lantern was tuned under
 * that curve with half its sphere spent on the sea; a close timber box
 * returns every photon, and the first night capture rendered the cabin as
 * one flat clipped orange. So the lamp's illumination divides the curve
 * back out past this reference: a lamp-lit room genuinely looks the same
 * at 19:30 and at 03:00, which no fixed intensity can say under a moving
 * exposure. Clamped at 1 — daylight exposures below the reference are the
 * rolloff's business, not this term's.
 */
export const EXPOSURE_REFERENCE = 1.27;

/**
 * The flame's luminous intensity, in three.js PointLight units. Same wick as
 * the deck lantern's 1.9, trimmed slightly: an enclosed room returns every
 * spent photon off close timber, where the deck loses half its sphere to
 * the night.
 */
const INTERIOR_FLAME_INTENSITY = 1.6;

/** Ash's dial pick (2026-08-15, raised from 1.25), pending the chart desk. */
const DEFAULT_INTENSITY_SCALE = 1.7;

/**
 * Range of the point light, metres. The refuge is the room: the falloff
 * ends inside the ship rather than reaching the next room through a
 * bulkhead the shadowless light cannot see.
 */
const LIGHT_RANGE = 4.5;

/**
 * The share of the flame handed to the unshadowed FILL light while the
 * occlusion shadow is active. A shadow map kills 100% of a ray the cap or
 * the rudder trunk interrupts, but a real room does not: the timber bounces
 * the lamp back into its own shadows. The fill is that first bounce, told
 * cheaply — same colour, same falloff, no shadow — so occluded regions keep
 * a quarter of the light instead of going to jet black. Derived from the
 * same `renderEmission` as the key, so a cold or drowned lamp fills nothing.
 * While the shadow is off the key is unshadowed anyway and the fill is 0 —
 * splitting there would just double-draw the same light.
 */
const SHADOW_FILL_FRACTION = 0.25;

/** Where the swing pivots, below the hook seat: the eye the chain runs to. */
const PIVOT_DROP = 0.024;

/** Pendulum damping ratio — a few visible cycles, not a metronome. */
const SWING_DAMPING_RATIO = 0.12;

/** The furthest the chain will lean, radians. */
const SWING_MAX_RAD = 0.4;

export class InteriorLamp {
  readonly group = new THREE.Group();
  /** Chain and lantern, pivoting at the hook's eye. */
  private readonly swing = new THREE.Group();
  readonly light: THREE.PointLight;
  /** The bounce fill — see SHADOW_FILL_FRACTION. */
  readonly fillLight: THREE.PointLight;

  mode: LampMode = 'auto';
  /** Artistic multiplier from the debug panel. */
  intensityScale = DEFAULT_INTENSITY_SCALE;

  /** Hysteresis latch: whether the routine wants the lamp lit. */
  private wantsOn = false;
  /**
   * The player's hand, riding over the latch: null defers to the routine.
   * Cleared whenever the latch itself transitions — the crew resumes.
   */
  private manualOverride: boolean | null = null;
  /**
   * Whether the latch has seen a real signal yet. The first tick derives
   * `wantsOn` from the threshold alone: hysteresis is memory, and a lamp
   * that has just come into being has none — without this, a spawn into a
   * bright afternoon would inherit `wantsOn=false`'s opposite from whatever
   * transient the first dark frames fed the latch.
   */
  private latchSeeded = false;
  /** 0..1 presentation ramp towards the wanted state. */
  private litFraction = 0;
  /**
   * Shadows ship ON (Ash's call, 2026-08-15): the cap stops the deckhead
   * bullseye and the room's timber throws true shadows, quarter-filled by
   * the bounce light. The cost is six 256 px faces per LIT lamp — dark
   * hours only, `syncShadowState` gates it — and the night frame with all
   * five burning is still unmeasured; the dial turns it back off.
   */
  private shadowRequested = true;

  /** Pendulum state, radians and radians/second, per swing axis. */
  private tiltX = 0;
  private tiltZ = 0;
  private tiltXVel = 0;
  private tiltZVel = 0;
  private tiltXTarget = 0;
  private tiltZTarget = 0;
  private readonly swingOmega: number;

  /** How hard the flame burns — the flame's own surfaces read this. */
  emission = 0;
  /** `emission` after the room-daylight rolloff — what the light emits. */
  renderEmission = 0;

  private readonly lantern: LanternAssembly;
  private readonly chainMaterial: THREE.MeshStandardMaterial;

  /** World-space position of the flame, refreshed each update. */
  readonly flameWorld = new THREE.Vector3();
  private readonly flameLocal = new THREE.Vector3();

  /**
   * `drop` is the distance from the group origin (the hook's seat on the
   * beam's underside) down to the flame. The chain is sized to fill it.
   */
  constructor(drop = 0.42) {
    // The hook: a short iron strap under the beam with an eye, the kind
    // screwed on so the lamp can be unhooked and carried.
    const iron = new THREE.MeshStandardMaterial({ color: 0x2e2a26, roughness: 0.6, metalness: 0.55 });
    this.chainMaterial = iron;
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.012, 0.09), iron);
    strap.position.set(0, -0.006, 0);
    this.group.add(strap);
    const eye = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.004, 4, 8), iron);
    eye.position.set(0, -PIVOT_DROP, 0);
    this.group.add(eye);

    // Everything below the eye swings. Positions inside are pivot-relative.
    this.swing.position.set(0, -PIVOT_DROP, 0);
    this.group.add(this.swing);
    const flameY = -(drop - PIVOT_DROP);
    // The pendulum's natural frequency comes from its own length — sqrt(g/L),
    // ~0.8 Hz at this drop — so the swing reads as this object's weight on
    // this chain rather than as an authored wobble.
    this.swingOmega = Math.sqrt(9.81 / Math.max(drop - PIVOT_DROP, 0.1));

    // Chain links from the eye down to the bail: VERTICAL rings in
    // alternating perpendicular planes, each hanging through the next —
    // the spacing is derived so one ring's edge sits inside the other's
    // opening, which is what a chain is. The first cut laid the tori
    // nearly flat and evenly apart, and read as a stack of washers on a
    // wire (Ash's walk).
    const LINK_RADIUS = 0.017;
    const LINK_TUBE = 0.0035;
    // Interlock bound: centres closer than 2(R − r) put each ring inside
    // the other; one more tube radius of margin keeps the overlap visible
    // rather than tangent.
    const maxSpacing = 2 * (LINK_RADIUS - LINK_TUBE) - LINK_TUBE;
    // The bail's arch tops out at +0.152 over the flame (see the assembly);
    // the chain's last link must reach it, not a point in the air above.
    const bailTopY = flameY + 0.152;
    const chainSpan = -bailTopY;
    const links = Math.max(2, Math.ceil(chainSpan / maxSpacing));
    const spacing = chainSpan / links;
    for (let i = 0; i < links; i++) {
      const y = -(i + 0.5) * spacing;
      const link = new THREE.Mesh(
        new THREE.TorusGeometry(LINK_RADIUS, LINK_TUBE, 5, 10),
        iron,
      );
      link.position.set(0, y, 0);
      // Odd parity first: the hook's eye faces z, so the top link must
      // face x to pass through it, and the rest alternate from there.
      link.rotation.y = ((i + 1) % 2) * (Math.PI / 2);
      this.swing.add(link);
    }

    this.lantern = buildLanternAssembly(this.swing, 0, flameY);
    this.flameLocal.copy(this.lantern.flameLocal);

    // Physical decay with a range that ends inside the hull. No shadow by
    // default: six depth faces are real money, and the first question is
    // whether the shadowless leak reads at all — `setShadowEnabled` is the
    // A/B that answers it.
    this.light = new THREE.PointLight(LAMP_COLOR, 0, LIGHT_RANGE, 2);
    this.light.position.copy(this.flameLocal);
    this.light.castShadow = false;
    this.light.shadow.mapSize.set(256, 256);
    this.light.shadow.camera.near = 0.1;
    this.light.shadow.camera.far = LIGHT_RANGE;
    this.light.shadow.camera.layers.set(LANTERN_SHADOW_LAYER);
    this.light.shadow.bias = -0.002;
    this.light.shadow.normalBias = 0.015;
    this.light.shadow.radius = 1.25;
    this.light.shadow.camera.updateProjectionMatrix();
    this.swing.add(this.light);

    this.fillLight = new THREE.PointLight(LAMP_COLOR, 0, LIGHT_RANGE, 2);
    this.fillLight.position.copy(this.flameLocal);
    this.fillLight.castShadow = false;
    this.swing.add(this.fillLight);

    // Same rule as the deck lantern: at this scale a shadow-map texel is
    // bigger than the whole guard assembly...
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
    // ...except the cap and crown. Half a metre under a deckhead, the flame
    // would paint a clipped bullseye on the planks straight above; on the
    // real object the vented cap is what stops that, so when the shadow A/B
    // is on, the cap stops it here too. Costs nothing while shadows are off.
    for (const mesh of this.lantern.metalTop) {
      mesh.castShadow = true;
      mesh.layers.enable(LANTERN_SHADOW_LAYER);
    }
  }

  get litLevel(): number {
    return this.litFraction;
  }

  /** What the routine-plus-hand currently wants, 0 or 1. */
  private targetLit(): number {
    if (this.mode !== 'auto') return this.mode === 'on' ? 1 : 0;
    return (this.manualOverride ?? this.wantsOn) ? 1 : 0;
  }

  /**
   * The player's hand on the lamp — the Space action. Flips the lamp against
   * whatever it is currently doing; the override holds until the latch next
   * changes its own state, at which point the routine resumes. Douse at
   * night and it stays out until morning lets it go; light it at noon and
   * it burns until the evening strike agrees with you.
   */
  toggleManual(): void {
    this.manualOverride = this.targetLit() < 0.5;
  }

  /** Whether the lamp is currently wanted lit — the verb's tense. */
  get isWantedLit(): boolean {
    return this.targetLit() > 0.5;
  }

  /**
   * Jump the presentation ramps to their targets. The capture host's
   * determinism hook: a settled frame must not depend on how many frames
   * the settle took. Meaningful only after at least one `update` tick has
   * fed the latch its room signal — the host's settle frames provide that.
   */
  snapLit(): void {
    this.litFraction = this.targetLit();
    this.tiltX = this.tiltXTarget;
    this.tiltZ = this.tiltZTarget;
    this.tiltXVel = 0;
    this.tiltZVel = 0;
  }

  /**
   * Forget the latch's history; the next update re-derives it from the
   * signal alone. The capture host calls this after jumping the clock — a
   * latch is path-dependent by design, and a teleported clock has no path.
   * Inside the hysteresis band the reseeded answer is the day side's: out.
   * The player's override is history too, and clears with it.
   */
  reseedLatch(): void {
    this.latchSeeded = false;
    this.manualOverride = null;
  }

  get isOn(): boolean {
    return this.litFraction > 0.01;
  }

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
   * Advance activation, flame and swing. Presentation time only, like the
   * deck lamp.
   *
   * `roomDaylightLuminance` is the luminance of the room's portal-delivered
   * daylight (sky + beam through the transfer weights, times the room lift),
   * computed BEFORE the lamp's own light — see the class note on feed-forward.
   * Required, not defaulted: a caller that forgets it gets a lamp burning at
   * full strength into a sunlit noon cabin, the exact bug it exists to kill.
   *
   * `sceneExposure` is the frame's authored display exposure — see
   * `EXPOSURE_REFERENCE` for why the flame divides it out at night.
   *
   * `worldDownLocal` is the world's down direction expressed in the lamp
   * group's own frame (ship-local for a lamp mounted unrotated). The chain
   * leans toward it and the pendulum does the rest; omitted, the lamp hangs
   * plumb to its mount.
   */
  update(
    presentationDtSeconds: number,
    elapsedSeconds: number,
    roomDaylightLuminance: number,
    sceneExposure: number,
    worldDownLocal?: THREE.Vector3,
  ): void {
    // Hysteresis on the room's own daylight. The first tick (and any tick
    // after `reseedLatch`) ignores the hysteresis memory: inside the band
    // the convention is the day side's answer — out.
    if (!this.latchSeeded) {
      this.wantsOn = roomDaylightLuminance < ON_BELOW_LUMINANCE;
      this.latchSeeded = true;
    } else if (roomDaylightLuminance < ON_BELOW_LUMINANCE) {
      // The latch changing its own mind releases the player's override —
      // the routine has caught up with whatever the hand was insisting on.
      if (!this.wantsOn) this.manualOverride = null;
      this.wantsOn = true;
    } else if (roomDaylightLuminance > OFF_ABOVE_LUMINANCE) {
      if (this.wantsOn) this.manualOverride = null;
      this.wantsOn = false;
    }

    const target = this.targetLit();
    const step = RAMP_SECONDS > 0 ? presentationDtSeconds / RAMP_SECONDS : 1;
    this.litFraction = THREE.MathUtils.clamp(
      this.litFraction + Math.sign(target - this.litFraction) * step,
      Math.min(this.litFraction, target),
      Math.max(this.litFraction, target),
    );

    // The same still-air breathing as the deck lamp, phase-shifted so the two
    // flames never pulse in step when both are in earshot of one frame.
    const flame =
      1 +
      0.04 * Math.sin(elapsedSeconds * 1.9 + 2.1) * Math.sin(elapsedSeconds * 0.53 + 2.6) +
      0.02 * Math.sin(elapsedSeconds * 3.1 + 1.9);

    const lit = this.litFraction * this.intensityScale * flame;
    this.emission = lit;

    // Daylight rolloff against the ROOM. Never above 1: a room darker than
    // the reference must not amplify the flame.
    const suppression = Math.pow(
      Math.max(roomDaylightLuminance, ROOM_REFERENCE_LUMINANCE) / ROOM_REFERENCE_LUMINANCE,
      -ROOM_ROLLOFF,
    );
    // And the night exposure divided back out, so the lamp-lit room holds
    // one look from dusk to dawn — see EXPOSURE_REFERENCE.
    const exposureCompensation = Math.min(
      1,
      EXPOSURE_REFERENCE / Math.max(sceneExposure, 1e-4),
    );
    this.renderEmission = lit * suppression * exposureCompensation;
    this.syncShadowState();
    const surfaceLit = lampSurfaceEmissionLevel(lit);

    // Illumination is suppressed; the flame's own surfaces are not — daylight
    // does not dim a flame, it only drowns what the flame lights. While the
    // occlusion shadow is active a share of the flame moves to the unshadowed
    // fill (the room's first bounce, see SHADOW_FILL_FRACTION); both halves
    // ride `renderEmission`, so a cold lamp lights and fills nothing.
    const fillShare = this.light.castShadow ? SHADOW_FILL_FRACTION : 0;
    const flux = INTERIOR_FLAME_INTENSITY * this.renderEmission;
    this.light.intensity = flux * (1 - fillShare);
    this.fillLight.intensity = flux * fillShare;
    this.lantern.coreMaterial.color
      .copy(LAMP_COLOR)
      .multiplyScalar(LAMP_CORE_RADIANCE * surfaceLit);
    this.lantern.glassMaterial.emissiveIntensity =
      LAMP_GLASS_EMISSIVE_INTENSITY * surfaceLit;
    this.lantern.flameMesh.scale.set(1, 0.9 + 0.34 * flame, 1);
    this.lantern.flameMesh.rotation.z = 0.05 * Math.sin(elapsedSeconds * 1.35 + 1.1);

    // The swing: a damped pendulum leaning toward apparent down while the
    // ship rolls under the hook. Semi-implicit Euler at the pendulum's own
    // sqrt(g/L); dt clamped so a hitch cannot kick the chain over the beam.
    if (worldDownLocal) {
      const d = worldDownLocal;
      const len = Math.max(Math.hypot(d.x, d.y, d.z), 1e-6);
      this.tiltXTarget = Math.atan2(-d.z / len, -d.y / len);
      this.tiltZTarget = Math.atan2(d.x / len, -d.y / len);
    } else {
      this.tiltXTarget = 0;
      this.tiltZTarget = 0;
    }
    const dt = Math.min(presentationDtSeconds, 0.05);
    const w = this.swingOmega;
    const c = 2 * SWING_DAMPING_RATIO * w;
    this.tiltXVel += (w * w * (this.tiltXTarget - this.tiltX) - c * this.tiltXVel) * dt;
    this.tiltZVel += (w * w * (this.tiltZTarget - this.tiltZ) - c * this.tiltZVel) * dt;
    this.tiltX = THREE.MathUtils.clamp(this.tiltX + this.tiltXVel * dt, -SWING_MAX_RAD, SWING_MAX_RAD);
    this.tiltZ = THREE.MathUtils.clamp(this.tiltZ + this.tiltZVel * dt, -SWING_MAX_RAD, SWING_MAX_RAD);
    this.swing.rotation.x = this.tiltX;
    this.swing.rotation.z = this.tiltZ;

    this.swing.updateMatrixWorld();
    this.flameWorld.copy(this.flameLocal).applyMatrix4(this.swing.matrixWorld);
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of this.lantern.materials) m.dispose();
    this.chainMaterial.dispose();
    this.light.shadow.dispose();
    this.fillLight.shadow.dispose();
  }
}
