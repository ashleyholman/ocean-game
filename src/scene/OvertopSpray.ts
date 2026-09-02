import * as THREE from 'three';
import type { OvertopEvent } from '../vessel/BuoyantBody';
import { overtopEventStrength } from './wakePolicy';

/**
 * Restrained whitewater for a *detected* overtopping event.
 *
 * This is an acknowledgement, not a concealment. It is emitted only where the
 * buoyancy model has established that a crest has genuinely crossed an outer
 * crown and that the water is moving into the vessel rather than the vessel
 * merely clipping a static mismatch. It never runs to hide geometry, and it is
 * deliberately quiet: a handful of small, short-lived, sky-lit puffs at the
 * entering edge.
 *
 * This is not water on deck. There is no fluid here — that is a later problem
 * (motion physics Phase 4), and the detection in `BuoyantBody` is the hook it
 * uses.
 *
 * WK3: EVERY SCALE IN HERE IS THE VESSEL'S, NOT A NUMBER
 * ------------------------------------------------------
 * This class was written for the raft and its constants were fitted to one.
 * `strength()` in particular was `min(1, speed·0.55 + depth·2.2)` — the same
 * shape as now, with the references 1/2.2 = 0.4545 m and 1/0.55 = 1.818 m/s
 * hidden inside two coefficients. On a 15.5 m schooner those evaluate to 1.063
 * at her *measured* overtop peaks and clamp, so the marginal crossing the
 * baseline records (9 frames in 5 400, peak depth 0.076 m) would have been
 * drawn as a full green-water wash. The references are now the caller's, and
 * `wakePolicy.overtopReferencesFromFreeboard` derives them from the one scale
 * both vessels have. The raft passes its own literals and is unchanged.
 *
 * WHERE THE PUFFS GO, AND WHERE THEY END UP
 * -----------------------------------------
 * Spawn on the *water surface*, never on the timber crown — see `emit()`,
 * where that lesson is recorded. And they now land: a puff that falls back to
 * the crown it came over stops falling, spreads, and dies there, so the eye
 * reads water arriving on a deck rather than water evaporating in mid-air.
 */

const LIFETIME = 0.85;

/**
 * Per-vessel scale for the cue. Every field is a dimension of the ship.
 *
 * The defaults are the raft's, exactly as they were before WK3, so
 * `new OvertopSpray()` still produces the raft's cue — including the two
 * strength references, which are the old coefficients' reciprocals rather than
 * anything freeboard-derived. That is grandfathered, not endorsed: the raft
 * should get freeboard-relative references the next time someone has it in
 * front of them, and doing it here would have changed a legacy vessel's look
 * inside a round about the schooner.
 */
export interface OvertopSprayOptions {
  /** Depth over the crown that alone makes a full wash, metres. */
  depthReferenceM: number;
  /** Entry speed that alone makes a full wash, m/s. */
  speedReferenceMps: number;
  /** Two cue sites in one frame must be at least this far apart, metres. */
  siteSpacingM: number;
  /** Minimum gap between emissions, seconds. */
  cooldownSeconds: number;
  /** Puff pool size. Also the hard bound on how many can be alive at once. */
  capacity: number;
  /** Base sprite radius, metres. A raft-sized puff is invisible on a schooner. */
  puffScaleM: number;
  /**
   * How much of the throw is folded inboard, 0..1.
   *
   * Water coming over a rail goes *onto the deck*. The raft has no rail and no
   * inboard to speak of, so it keeps 0 and its puffs follow the flow alone.
   */
  inboardBias: number;
  /** Seed for the deterministic jitter stream. */
  seed: number;
}

export const RAFT_OVERTOP_SPRAY: OvertopSprayOptions = {
  // 1/2.2 and 1/0.55 — the pre-WK3 coefficients, re-expressed.
  depthReferenceM: 1 / 2.2,
  speedReferenceMps: 1 / 0.55,
  siteSpacingM: 0.9,
  cooldownSeconds: 0.14,
  capacity: 18,
  puffScaleM: 1,
  inboardBias: 0,
  seed: 0x6d2b79f,
};

/**
 * Draw the puff sprite, or return nothing where there is no canvas to draw on.
 *
 * The guard is not defensive clutter. Before WK3 the only owner of this class
 * was the raft, which no headless test builds; the port put it on the schooner,
 * which four of them do, and an unguarded `document.createElement` turned every
 * one of those into `ReferenceError: document is not defined`. A vessel should
 * not become unconstructible in a test runner because it acknowledges water on
 * deck.
 *
 * The puffs still fly, land and count without a texture, so everything about
 * the cue that is arithmetic stays testable headlessly. Only the picture is
 * absent, and only where there was never going to be one.
 */
function makePuffTexture(): THREE.Texture | undefined {
  if (typeof document === 'undefined') return undefined;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0.0, 'rgba(255,255,255,0.95)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.40)');
  gradient.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  // Break the perfect circle up so it reads as spray rather than a soft dot.
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + 0.7;
    const r = size * (0.20 + 0.26 * ((Math.sin(i * 12.9898) * 43758.5453) % 1));
    ctx.beginPath();
    ctx.arc(size / 2 + Math.cos(a) * r, size / 2 + Math.sin(a) * r, size * 0.09, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

interface Puff {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  vx: number;
  vy: number;
  vz: number;
  scale: number;
  /** Height the puff came over. Below it, it has arrived and stops falling. */
  landingY: number;
  landed: boolean;
}

/**
 * Where the vessel is, so a puff can be thrown *inboard*.
 *
 * Only wanted by callers that set a non-zero `inboardBias`. The hull sits at
 * the render origin as far as the wave frame is concerned, but not exactly, so
 * the origin is passed rather than assumed.
 */
export interface OvertopVesselFrame {
  originX: number;
  originZ: number;
  yaw: number;
}

export class OvertopSpray {
  readonly group = new THREE.Group();

  private readonly options: OvertopSprayOptions;
  private readonly puffs: Puff[] = [];
  private readonly texture: THREE.Texture | undefined;
  private readonly material: THREE.SpriteMaterial;
  private cooldown = 0;
  private lastSite = { x: 0, z: 0 };
  /**
   * Deterministic jitter stream.
   *
   * Design invariant 7 permits unseeded randomness "only where `OvertopSpray`
   * already does", and this class did: `Math.random()` in the spawn path. WK3
   * spends that permission in the other direction and seeds it, because the
   * cue is no longer a raft-only ornament — it is now on the schooner, which is
   * the vessel every exporter and every capture measures, and a seed that
   * reproduces a trace is this project's character. It also makes `clear()`
   * genuinely restore the initial state, which the raft's `resetEffects()`
   * never quite did. Four lines.
   */
  private rngState: number;
  /** Set false to keep the cue out of production while detection still runs. */
  enabled = true;

  /** Diagnostic: how many puffs are alive. */
  get activeCount(): number {
    return this.puffs.reduce((n, p) => n + (p.sprite.visible ? 1 : 0), 0);
  }

  /** The hard ceiling on live puffs. Emission cannot exceed it by construction. */
  get capacity(): number {
    return this.options.capacity;
  }

  constructor(options: Partial<OvertopSprayOptions> = {}) {
    this.options = { ...RAFT_OVERTOP_SPRAY, ...options };
    this.rngState = this.options.seed >>> 0 || 1;
    this.texture = makePuffTexture();
    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      opacity: 0,
      // Sea foam is lit by the sky, not emissive; a plain blend keeps it from
      // glowing at night.
      blending: THREE.NormalBlending,
    });

    for (let i = 0; i < this.options.capacity; i++) {
      const sprite = new THREE.Sprite(this.material.clone());
      sprite.visible = false;
      sprite.renderOrder = 2;
      this.group.add(sprite);
      this.puffs.push({
        sprite,
        age: 0,
        life: LIFETIME,
        vx: 0,
        vy: 0,
        vz: 0,
        scale: 0.3,
        landingY: -Infinity,
        landed: false,
      });
    }
    this.group.renderOrder = 2;
  }

  private random(): number {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 4294967296;
  }

  /** How hard the water is coming aboard: 0 = a lick, 1 = a proper wash. */
  strengthOf(event: Readonly<OvertopEvent>): number {
    return overtopEventStrength(
      event.depth,
      event.speed,
      this.options.depthReferenceM,
      this.options.speedReferenceMps,
    );
  }

  /** Tint the spray with the current sky irradiance so it darkens after sunset. */
  setLight(ambient: THREE.Vector3, sunColor: THREE.Color, sunIntensity: number): void {
    // 0.023 = the old 0.06 rescaled by 3.05/8.0 through the sunScale change.
    const r = Math.min(1, ambient.x * 3.2 + sunColor.r * sunIntensity * 0.023);
    const g = Math.min(1, ambient.y * 3.2 + sunColor.g * sunIntensity * 0.023);
    const b = Math.min(1, ambient.z * 3.2 + sunColor.b * sunIntensity * 0.023);
    for (const puff of this.puffs) {
      (puff.sprite.material as THREE.SpriteMaterial).color.setRGB(
        0.72 + 0.28 * r,
        0.74 + 0.26 * g,
        0.76 + 0.24 * b,
      );
    }
  }

  /** Remove every live puff and restore the initial deterministic state. */
  clear(): void {
    for (const puff of this.puffs) {
      puff.sprite.visible = false;
      puff.landed = false;
    }
    this.cooldown = 0;
    this.rngState = this.options.seed >>> 0 || 1;
  }

  update(
    dt: number,
    events: readonly OvertopEvent[],
    frame?: Readonly<OvertopVesselFrame>,
  ): void {
    const { cooldownSeconds, siteSpacingM } = this.options;
    this.cooldown = Math.max(0, this.cooldown - dt);

    if (this.enabled && events.length && this.cooldown === 0) {
      // Detection is deliberately sensitive, because it is also a measurement.
      // The *cue* is not: the outer logs of a raft are wet more or less
      // continuously, and a puff for every centimetre of that would be
      // decoration, not information. Only a real wash gets acknowledged.
      //
      // At most two sites per frame, and they must be at least `siteSpacingM`
      // apart, so a crest lighting up half the stations at once produces a
      // couple of marks where the water is actually crossing the timber rather
      // than a wall of foam. The schooner needs this more than the raft ever
      // did: her heaviest measured frame carries 118 simultaneous events.
      const ranked = [...events]
        .filter((e) => this.strengthOf(e) > 0.3)
        .sort((a, b) => this.strengthOf(b) - this.strengthOf(a));
      let emitted = 0;
      for (const event of ranked) {
        if (emitted >= 2) break;
        if (emitted === 1) {
          const first = this.lastSite;
          if (Math.hypot(event.x - first.x, event.z - first.z) < siteSpacingM) {
            continue;
          }
        }
        this.emit(event, frame);
        this.lastSite = { x: event.x, z: event.z };
        emitted++;
      }
      if (emitted) this.cooldown = cooldownSeconds;
    }

    for (const puff of this.puffs) {
      if (!puff.sprite.visible) continue;
      puff.age += dt;
      const u = puff.age / puff.life;
      if (u >= 1) {
        puff.sprite.visible = false;
        puff.landed = false;
        continue;
      }
      if (!puff.landed) {
        // Gravity, and it is right here where it is wrong in `CrestSpray`. A
        // wash coming over a rail is a coherent slug of water, not an 80 µm
        // droplet suspended in the wind, and a slug does fall. 5.2 rather than
        // 9.81 because it is still being fed from below by the crest that put
        // it there.
        puff.vy -= 5.2 * dt;
      }
      puff.sprite.position.x += puff.vx * dt;
      puff.sprite.position.y += puff.vy * dt;
      puff.sprite.position.z += puff.vz * dt;

      // It has arrived. Water that comes over a rail lands on something and
      // runs across it; without this the cue is a puff that climbs, stops and
      // evaporates in mid-air with nowhere to have gone.
      if (!puff.landed && puff.vy < 0 && puff.sprite.position.y <= puff.landingY) {
        puff.landed = true;
        puff.sprite.position.y = puff.landingY;
        puff.vy = 0;
      }
      if (puff.landed) {
        // Spread and lose way across the planking, rather than sliding on
        // forever at the speed it came aboard with.
        const drag = Math.max(0, 1 - 2.6 * dt);
        puff.vx *= drag;
        puff.vz *= drag;
      }

      // Grow a little, then fade out; peak opacity is deliberately low. A
      // landed puff flattens faster — it is spreading, not travelling.
      const scale = puff.scale * (1 + u * (puff.landed ? 1.8 : 0.9));
      puff.sprite.scale.set(scale, scale, scale);
      const fade = u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85;
      (puff.sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, fade) * 0.46;
    }
  }

  private emit(
    event: OvertopEvent,
    frame?: Readonly<OvertopVesselFrame>,
  ): void {
    const { inboardBias, puffScaleM } = this.options;
    const s = this.strengthOf(event);
    const count = 2 + Math.round(s * 2);
    // Throw the spray the way the water is actually moving, taken from the
    // Gerstner orbital velocity at that station rather than from a guess about
    // which side the crest came from.
    const flow = Math.hypot(event.flowX, event.flowZ);
    let fx = flow > 1e-3 ? event.flowX / flow : 0;
    let fz = flow > 1e-3 ? event.flowZ / flow : 0;

    // Fold the throw inboard. Water crossing a rail ends up on the deck, and
    // the flow alone does not know that — on a roll it can point squarely
    // overboard. The inboard direction is the one that reduces the site's
    // distance from the vessel's centreline; its sign is therefore read off the
    // geometry rather than chosen, and is pinned by test.
    //
    // A BLEND, NOT AN ADDITION, AND THE DIFFERENCE IS NOT COSMETIC
    // ------------------------------------------------------------
    // The first version added `bias · inboard` to the unit flow and
    // renormalised. That is silently a no-op whenever the two are colinear:
    // (1,0) + 0.7·(-1,0) is (0.3,0), which normalises straight back to (1,0) —
    // so the one case the fold exists for, a wash heading squarely overboard,
    // was the one case it could not turn. Interpolating between the two
    // directions before normalising cannot do that.
    if (frame && inboardBias > 0) {
      const dx = event.x - frame.originX;
      const dz = event.z - frame.originZ;
      // Lateral axis of the hull in the render frame, and the site's offset
      // along it. Which side is positive does not matter; only that inboard is
      // the way back toward zero.
      const lateralX = Math.cos(frame.yaw);
      const lateralZ = -Math.sin(frame.yaw);
      const offset = dx * lateralX + dz * lateralZ;
      if (Math.abs(offset) > 1e-4) {
        const inboardSign = offset > 0 ? -1 : 1;
        const inboardX = inboardSign * lateralX;
        const inboardZ = inboardSign * lateralZ;
        const blendX = fx * (1 - inboardBias) + inboardX * inboardBias;
        const blendZ = fz * (1 - inboardBias) + inboardZ * inboardBias;
        const length = Math.hypot(blendX, blendZ);
        if (length > 1e-6) {
          fx = blendX / length;
          fz = blendZ / length;
        }
      }
    }

    for (let i = 0; i < count; i++) {
      const puff = this.puffs.find((p) => !p.sprite.visible);
      // The pool is the hard bound: a frame carrying more washes than there are
      // free puffs draws the strongest of them and drops the rest, rather than
      // recycling water that is still in the air.
      if (!puff) return;
      const jitter = (n: number) => (this.random() - 0.5) * n;
      puff.sprite.visible = true;
      puff.landed = false;
      puff.age = 0;
      puff.life = LIFETIME * (0.75 + this.random() * 0.5);
      puff.scale = (0.22 + s * 0.3 + this.random() * 0.1) * puffScaleM;
      // Spawn on the *water surface*, not on the timber crown. During an
      // overtop the crown is by definition below the surface, so spawning there
      // put every puff underwater where the depth test discarded it until it
      // had climbed clear — the cue fired correctly and was invisible.
      puff.sprite.position.set(
        event.x + jitter(0.3 * puffScaleM),
        event.y + event.depth + 0.04,
        event.z + jitter(0.3 * puffScaleM),
      );
      // The crown it came over is where it has to end up: that edge is the
      // deck at side on both vessels.
      puff.landingY = event.y;
      const throwSpeed = 0.3 + s * 0.7;
      puff.vx = fx * throwSpeed + jitter(0.3);
      puff.vy = 0.55 + s * 1.2 + this.random() * 0.35;
      puff.vz = fz * throwSpeed + jitter(0.3);
      (puff.sprite.material as THREE.SpriteMaterial).opacity = 0;
      puff.sprite.scale.setScalar(puff.scale);
    }
  }

  dispose(): void {
    for (const puff of this.puffs) (puff.sprite.material as THREE.SpriteMaterial).dispose();
    this.material.dispose();
    this.texture?.dispose();
  }
}
