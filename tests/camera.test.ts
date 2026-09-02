import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { CameraSystem } from '../src/camera/CameraSystem';
import { CinematicCameraController } from '../src/camera/CinematicCameraController';
import {
  EmbodiedCameraController,
  DEFAULT_LOOK_YAW,
  EYE_ANCHOR,
} from '../src/camera/EmbodiedCameraController';
import { CameraTransition } from '../src/camera/CameraTransition';
import {
  CINEMATIC_DEFAULT_SCALE,
  CINEMATIC_KNOTS,
  ELEVATION_MAX,
  EMBODIED_PITCH_MAX,
  EMBODIED_PITCH_MIN,
  cinematicAltitude,
  cinematicDistance,
  cinematicFov,
  cinematicHorizonFraction,
  easeArrival,
  embodiedDefaultPitch,
  easeArrivalInverse,
  embodiedFov,
  monotoneCubic,
  vesselFrameFraction,
  transitionSeconds,
} from '../src/camera/cameraTuning';
import type { CameraContext } from '../src/camera/types';
import { vesselFramingEnvelopeFromPoints } from '../src/camera/vesselFraming';
import { InputController } from '../src/input/InputController';
import { REACH } from '../src/player/Interactables';
import { Raft } from '../src/vessel/raft/Raft';
import { PlanetaryWorld } from '../src/world/PlanetaryWorld';

/**
 * The camera system, in the eight categories the round's brief asks for.
 *
 * `tests/camera-follow.test.ts` is the ninth and covers the vertical follow in
 * a high sea, which needed a wave train to say anything about; everything here
 * is geometry, state and routing, and needs neither a renderer nor a sea.
 *
 * The recurring principle: assert on what the *pose* came out as, not on what
 * a controller was asked for. Distance, altitude and framing are outputs of
 * curves and clamps, and a test that recomputes the curve cannot see the clamp.
 */

const DEG = Math.PI / 180;
const ASPECT = 1440 / 900;

/** A flat, still sea and a vessel sitting level on it. Enough for the geometry. */
function makeContext(overrides: Partial<CameraContext['vessel']> = {}): CameraContext {
  return {
    dt: 1 / 60,
    vessel: {
      matrixWorld: new THREE.Matrix4(),
      pitch: 0,
      yaw: 0,
      roll: 0,
      x: 0,
      z: 0,
      waterlineY: 0,
      designWaterlineY: 0,
      framing: vesselFramingEnvelopeFromPoints([new THREE.Vector3()]),
      ...overrides,
    },
    waterHeightAt: () => 0,
  };
}

function settle(update: (c: CameraContext) => unknown, context: CameraContext, seconds = 3): void {
  const steps = Math.round(seconds / context.dt);
  for (let i = 0; i < steps; i++) update(context);
}

function isFinitePose(pose: {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
  near: number;
}): boolean {
  return (
    Number.isFinite(pose.position.x) &&
    Number.isFinite(pose.position.y) &&
    Number.isFinite(pose.position.z) &&
    Number.isFinite(pose.quaternion.x) &&
    Number.isFinite(pose.quaternion.y) &&
    Number.isFinite(pose.quaternion.z) &&
    Number.isFinite(pose.quaternion.w) &&
    Number.isFinite(pose.fov) &&
    Number.isFinite(pose.near) &&
    pose.near > 0
  );
}

function newSystem(): CameraSystem {
  const system = new CameraSystem({ setFigureVisible: () => {} });
  system.setViewport(1440, 900);
  return system;
}

// ---------------------------------------------------------------------------
// 1. CINEMATIC SCALE CURVE
// ---------------------------------------------------------------------------

describe('cinematic scale curve', () => {
  it('clamps the scale to [0, 1] and never returns a non-finite value', () => {
    for (const s of [-1e9, -1, -0.001, 0, 0.5, 1, 1.001, 1e9, Number.MAX_VALUE]) {
      expect(Number.isFinite(cinematicDistance(s))).toBe(true);
      expect(Number.isFinite(cinematicAltitude(s))).toBe(true);
      expect(cinematicDistance(s)).toBeGreaterThan(0);
    }
    expect(cinematicDistance(-5)).toBe(cinematicDistance(0));
    expect(cinematicDistance(5)).toBe(cinematicDistance(1));
    expect(Number.isFinite(cinematicDistance(Number.NaN))).toBe(true);
  });

  it('is strictly monotonic in distance and altitude, everywhere', () => {
    // At every point, not merely at the knots. A plain cubic through rising
    // knots can dip backwards between them, which would make the wheel
    // momentarily zoom in while being turned out.
    let previousDistance = -Infinity;
    let previousAltitude = -Infinity;
    for (let i = 0; i <= 4000; i++) {
      const s = i / 4000;
      const d = cinematicDistance(s);
      const a = cinematicAltitude(s);
      expect(d).toBeGreaterThan(previousDistance);
      expect(a).toBeGreaterThan(previousAltitude);
      previousDistance = d;
      previousAltitude = a;
    }
  });

  it('has no rate discontinuity', () => {
    // Monotone cubic Hermite is C1, so the derivative of log-distance is
    // continuous. A jump would read as the zoom changing gear mid-turn.
    const h = 1 / 20000;
    let previousRate = Math.log(cinematicDistance(h)) - Math.log(cinematicDistance(0));
    for (let i = 1; i < 20000; i++) {
      const s = i / 20000;
      const rate = Math.log(cinematicDistance(s + h)) - Math.log(cinematicDistance(s));
      expect(Math.abs(rate - previousRate)).toBeLessThan(1e-4);
      previousRate = rate;
    }
  });

  it('passes through every authored knot', () => {
    for (const knot of CINEMATIC_KNOTS) {
      expect(cinematicDistance(knot.scale)).toBeCloseTo(knot.distance, 6);
    }
  });

  it('reaches the range the round is required to support', () => {
    // The brief's minimum acceptance: 600 m of distance and 180 m of altitude,
    // preferring 800-1000 m and 250-350 m.
    expect(cinematicDistance(1)).toBeGreaterThanOrEqual(600);
    expect(cinematicAltitude(1)).toBeGreaterThanOrEqual(180);
    expect(cinematicAltitude(1)).toBeGreaterThan(250);
    expect(cinematicAltitude(1)).toBeLessThan(350);
    // And substantially closer than the 22 m the old rig bottomed out at.
    expect(cinematicDistance(0)).toBeLessThan(22);
    expect(cinematicDistance(0)).toBeGreaterThanOrEqual(6);
    // Far altitude is materially greater than near, not incidentally so.
    expect(cinematicAltitude(1) / cinematicAltitude(0)).toBeGreaterThan(50);
  });

  it('rejects malformed knot tables rather than interpolating nonsense', () => {
    expect(() => monotoneCubic([0], [1])).toThrow();
    expect(() => monotoneCubic([0, 1], [1])).toThrow();
  });

  it('holds the vessel and the horizon in the same place at every scale', () => {
    // Rule 1 and rule 2 together: the aim never changes across the range, so
    // zooming is a pure translation. Measured through the controller, so a
    // clamp would show up.
    const controller = new CinematicCameraController();
    controller.setViewport(ASPECT);
    const context = makeContext();
    const seen: number[] = [];
    for (const knot of CINEMATIC_KNOTS) {
      controller.setScale(knot.scale);
      settle(controller.update.bind(controller), context, 2);
      seen.push(controller.horizonPlacement);
      expect(controller.distance).toBeCloseTo(knot.distance, 3);
      expect(controller.altitude).toBeCloseTo(knot.distance * Math.sin(11 * DEG), 2);
      expect(controller.orbitElevation / DEG).toBeCloseTo(11, 6);
    }
    for (const h of seen) expect(h).toBeCloseTo(seen[0], 9);
    expect(seen[0]).toBeCloseTo(cinematicHorizonFraction(ASPECT), 6);
  });
});

// ---------------------------------------------------------------------------
// 2. CAMERA FRAMING STATE
// ---------------------------------------------------------------------------

describe('camera framing state', () => {
  it('cuts diagnostic mode changes without leaving a transition running', () => {
    const system = newSystem();
    expect(system.modeName).toBe('cinematic');

    system.setDiagnosticMode('embodied');
    expect(system.modeName).toBe('embodied');
    expect(system.isTransitioning).toBe(false);

    system.setDiagnosticMode('cinematic');
    expect(system.modeName).toBe('cinematic');
    expect(system.isTransitioning).toBe(false);
  });

  it('retains the orbit azimuth across a zoom', () => {
    const system = newSystem();
    const context = makeContext();
    system.update(context);
    const azimuth = system.cinematic.orbitAzimuth;
    system.drag(180, 0, 1440, 900);
    // A flick carries inertia that decays over about a quarter second. Let it
    // die before measuring, or this test is about the decay rather than about
    // whether zooming rotates the scene.
    settle(system.update.bind(system), context, 4);
    const after = system.cinematic.orbitAzimuth;
    expect(after).not.toBeCloseTo(azimuth, 6); // the flick did move it

    for (let i = 0; i < 60; i++) system.zoomBy(0.01);
    settle(system.update.bind(system), context, 1);
    expect(system.cinematicScale).toBe(1);
    system.zoomBy(-0.9);
    settle(system.update.bind(system), context, 1);
    expect(system.cinematic.orbitAzimuth).toBeCloseTo(after, 6);
  });

  it('keeps the elevation offset as an offset, so scale re-solves the framing', () => {
    const system = newSystem();
    const context = makeContext();
    system.update(context);
    // Grab-the-world vertically too: dragging *down* pushes the camera up.
    system.drag(0, 120, 1440, 900);
    settle(system.update.bind(system), context, 4);
    const raised = system.cinematic.orbitElevation;
    expect(raised).toBeGreaterThan(11 * DEG);

    system.cinematic.setScale(1);
    settle(system.update.bind(system), context, 1);
    // Same offset from the authored elevation, at a completely different scale.
    expect(system.cinematic.orbitElevation).toBeCloseTo(raised, 6);
    expect(system.cinematic.altitude).toBeCloseTo(
      cinematicDistance(1) * Math.sin(raised),
      2,
    );
  });

  it('clamps elevation to the orbit limits however hard it is pushed', () => {
    const system = newSystem();
    const context = makeContext();
    for (let i = 0; i < 200; i++) {
      system.drag(0, -900, 1440, 900);
      system.update(context);
    }
    expect(system.cinematic.orbitElevation).toBeLessThanOrEqual(ELEVATION_MAX + 1e-9);
    expect(isFinitePose(system.cinematic.pose)).toBe(true);
    for (let i = 0; i < 400; i++) {
      system.drag(0, 900, 1440, 900);
      system.update(context);
    }
    // Never below the sea: on a flat sea the floor is the water clearance.
    expect(system.cinematic.pose.position.y).toBeGreaterThan(0);
    expect(isFinitePose(system.cinematic.pose)).toBe(true);
  });

  it('survives resize and orientation change with a valid composition', () => {
    const system = newSystem();
    const context = makeContext();
    for (const [w, h] of [
      [3840, 2160],
      [1440, 900],
      [390, 844],
      [844, 390],
      [1, 1],
      [2, 1],
    ]) {
      system.setViewport(w, h);
      settle(system.update.bind(system), context, 0.5);
      expect(isFinitePose(system.cinematic.pose), `${w}x${h}`).toBe(true);
      const aspect = w / h;
      expect(system.camera.fov).toBeCloseTo(cinematicFov(aspect) / DEG, 6);
      const t = system.telemetry();
      expect(t.horizonFromTop).toBeGreaterThan(0);
      expect(t.horizonFromTop).toBeLessThan(1);
      // The vessel's place in frame is angular, so it survives the aspect change
      // — but only where the field of view is not against its own clamp. At a
      // square viewport the 62 degree vertical maximum makes the optical pitch
      // that puts the horizon a third down *exceed* the 11 degree elevation, so
      // the axis passes a little below the vessel and the vessel sits just above
      // centre instead of just below it: 0.492 rather than 0.547. Nothing
      // breaks, and no supported viewport is that shape, but the composition is
      // only pinned across the four the round is actually required to serve.
      const vessel = vesselFrameFraction(
        cinematicHorizonFraction(aspect),
        Math.tan(cinematicFov(aspect) / 2),
      );
      expect(vessel, `${w}x${h}`).toBeGreaterThan(0.45);
      expect(vessel, `${w}x${h}`).toBeLessThan(0.65);
    }

    for (const [w, h] of [
      [3840, 2160],
      [1440, 900],
      [390, 844],
      [844, 390],
    ]) {
      const aspect = w / h;
      const vessel = vesselFrameFraction(
        cinematicHorizonFraction(aspect),
        Math.tan(cinematicFov(aspect) / 2),
      );
      expect(vessel, `${w}x${h}`).toBeGreaterThan(0.53);
      expect(vessel, `${w}x${h}`).toBeLessThan(0.60);
    }
  });

  it('restores the documented composition on reset', () => {
    const system = newSystem();
    const context = makeContext();
    system.drag(300, -200, 1440, 900);
    system.zoomBy(0.3);
    settle(system.update.bind(system), context, 1);

    system.resetCinematic();
    settle(system.update.bind(system), context, 1);
    expect(system.cinematicScale).toBeCloseTo(CINEMATIC_DEFAULT_SCALE, 9);
    expect(system.cinematic.orbitAzimuth / DEG).toBeCloseTo(132, 6);
    expect(system.cinematic.orbitElevation / DEG).toBeCloseTo(11, 6);
    expect(system.cinematic.horizonPlacement).toBeCloseTo(
      cinematicHorizonFraction(ASPECT),
      6,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. MODE MANAGER
// ---------------------------------------------------------------------------

describe('mode manager', () => {
  it('toggles between the two modes and lands in the requested one', () => {
    const system = newSystem();
    const context = makeContext();
    expect(system.modeName).toBe('cinematic');
    system.toggleMode();
    expect(system.modeName).toBe('embodied');
    settle(system.update.bind(system), context, 3);
    expect(system.isTransitioning).toBe(false);
    system.toggleMode();
    expect(system.modeName).toBe('cinematic');
    settle(system.update.bind(system), context, 3);
    expect(system.isTransitioning).toBe(false);
  });

  it('preserves the cinematic composition across a round trip', () => {
    const system = newSystem();
    const context = makeContext();
    system.cinematic.setScale(0.82);
    system.drag(220, -90, 1440, 900);
    settle(system.update.bind(system), context, 4);
    const before = { ...system.framing };

    system.toggleMode();
    settle(system.update.bind(system), context, 3);
    system.toggleMode();
    settle(system.update.bind(system), context, 3);

    expect(system.framing.scale).toBeCloseTo(before.scale, 9);
    expect(system.framing.elevationOffset).toBeCloseTo(before.elevationOffset, 9);
    // The azimuth is recovered rather than stored: the outward trip installs
    // the bearing on the embodied look and the return trip reads it back off.
    // That round-trips to well under a degree — the difference is the head
    // model's roll and pitch follow perturbing the bearing it is read from —
    // rather than to the bit, which is the price of never spinning on a switch.
    expect(Math.abs(system.framing.azimuth - before.azimuth)).toBeLessThan(0.5 * DEG);
  });

  it('backs out along the way the player was looking', () => {
    // The other half of the arrival rule. Turn your head while aboard, leave,
    // and the camera withdraws along your line of sight rather than swinging
    // round to the azimuth the orbit happened to be at when you came aboard.
    const system = newSystem();
    const context = makeContext();
    const bearing = (q: THREE.Quaternion): number => {
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      return Math.atan2(-f.x, -f.z);
    };
    const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

    settle(system.update.bind(system), context, 2);
    system.toggleMode();
    settle(system.update.bind(system), context, 3);

    for (const turn of [0.7, -1.9, 2.8]) {
      system.embodied.lookBy(turn, 0);
      settle(system.update.bind(system), context, 1);
      const before = bearing(system.camera.quaternion);

      system.toggleMode();
      settle(system.update.bind(system), context, 4);
      expect(system.modeName).toBe('cinematic');
      const after = bearing(system.camera.quaternion);
      expect(Math.abs(wrap(after - before)), `turn ${turn}`).toBeLessThan(1 * DEG);

      // Back aboard for the next one.
      system.toggleMode();
      settle(system.update.bind(system), context, 4);
    }
  });

  it('comes aboard facing the way the camera was already facing', () => {
    // The wart this replaced: the castaway faces the bow, the camera is
    // somewhere else, and the difference was spent as a spin in the middle of
    // a one-second dive. Now the bearing is inherited and the dive is a dive.
    const system = newSystem();
    const context = makeContext();
    const bearing = (q: THREE.Quaternion): number => {
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      return Math.atan2(-f.x, -f.z);
    };
    const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

    for (const azimuth of [0, 1.1, 2.6, -2.0, Math.PI]) {
      const fresh = newSystem();
      fresh.framing = { azimuth, elevationOffset: 0, scale: CINEMATIC_DEFAULT_SCALE };
      settle(fresh.update.bind(fresh), context, 2);
      const before = bearing(fresh.camera.quaternion);

      fresh.setMode('embodied');
      settle(fresh.update.bind(fresh), context, 3);
      const after = bearing(fresh.camera.quaternion);
      expect(Math.abs(wrap(after - before)), `azimuth ${azimuth}`).toBeLessThan(1 * DEG);
    }

    // And the pitch levels to the authored embodied pitch rather than being
    // inherited, so a bird's-eye orbit does not land staring at the deck.
    system.cinematic.setScale(0.6);
    system.drag(0, 600, 1440, 900);
    settle(system.update.bind(system), context, 4);
    expect(system.cinematic.opticalPitch / DEG).toBeGreaterThan(40);
    system.setMode('embodied');
    settle(system.update.bind(system), context, 3);
    expect(system.look.pitch / DEG).toBeCloseTo(embodiedDefaultPitch(ASPECT) / DEG, 6);
  });

  it('turns through nothing at all on an immediate there-and-back', () => {
    const system = newSystem();
    const context = makeContext();
    settle(system.update.bind(system), context, 2);
    const before = system.camera.quaternion.clone();

    system.toggleMode();
    settle(system.update.bind(system), context, 3);
    system.toggleMode();
    settle(system.update.bind(system), context, 3);

    expect(Math.abs(before.dot(system.camera.quaternion))).toBeCloseTo(1, 9);
  });

  it('keeps a look the player set while aboard, until they leave and return', () => {
    const system = newSystem();
    const context = makeContext();
    system.toggleMode();
    settle(system.update.bind(system), context, 3);
    system.drag(400, 130, 1440, 900);
    const turned = { ...system.look };
    settle(system.update.bind(system), context, 1);
    // Held for as long as the player is aboard.
    expect(system.look.yaw).toBeCloseTo(turned.yaw, 9);
    expect(system.look.pitch).toBeCloseTo(turned.pitch, 9);
  });

  it('gives input to exactly one mode, and to neither mid-flight', () => {
    const system = newSystem();
    const context = makeContext();
    settle(system.update.bind(system), context, 1);

    // Cinematic: a drag orbits and does not move the embodied look.
    const look0 = { ...system.look };
    const azimuth0 = system.cinematic.orbitAzimuth;
    system.drag(150, 0, 1440, 900);
    expect(system.cinematic.orbitAzimuth).not.toBeCloseTo(azimuth0, 9);
    expect(system.look.yaw).toBeCloseTo(look0.yaw, 12);

    // Mid-transition: neither.
    system.toggleMode();
    system.update(context);
    expect(system.isTransitioning).toBe(true);
    const framing1 = { ...system.framing };
    const look1 = { ...system.look };
    system.drag(500, 200, 1440, 900);
    system.zoomBy(0.5);
    expect(system.framing.azimuth).toBeCloseTo(framing1.azimuth, 12);
    expect(system.framing.scale).toBeCloseTo(framing1.scale, 12);
    expect(system.look.yaw).toBeCloseTo(look1.yaw, 12);

    // Embodied: a drag looks and does not orbit.
    settle(system.update.bind(system), context, 3);
    const framing2 = { ...system.framing };
    const look2 = { ...system.look };
    system.drag(150, 0, 1440, 900);
    expect(system.look.yaw).not.toBeCloseTo(look2.yaw, 9);
    expect(system.framing.azimuth).toBeCloseTo(framing2.azimuth, 12);
    // And the wheel is inert in embodied mode.
    system.zoomBy(0.5);
    expect(system.cinematicScale).toBeCloseTo(framing2.scale, 12);
  });

  it('owns exactly one camera, which nothing else can render from', () => {
    const system = newSystem();
    const context = makeContext();
    settle(system.update.bind(system), context, 1);
    expect(system.camera).toBeInstanceOf(THREE.PerspectiveCamera);
    // The controllers produce poses, not cameras: there is nothing on either of
    // them a renderer would accept, which is what makes "one active camera"
    // structural rather than a convention someone has to keep.
    const cameras: unknown[] = [
      (system.cinematic as unknown as Record<string, unknown>).camera,
      (system.embodied as unknown as Record<string, unknown>).camera,
      (system.transition as unknown as Record<string, unknown>).camera,
    ];
    for (const c of cameras) expect(c).toBeUndefined();

    // And the one camera carries the active mode's pose, whichever that is.
    const cinematicPos = system.cinematic.pose.position.clone();
    expect(system.camera.position.distanceTo(cinematicPos)).toBeLessThan(1e-9);
    system.toggleMode();
    settle(system.update.bind(system), context, 3);
    expect(
      system.camera.position.distanceTo(system.embodied.pose.position),
    ).toBeLessThan(1e-9);
  });

  it('adds no audio listener, in either mode or during the change', () => {
    // Ambience is deliberately non-positional Web Audio. The invariant is that
    // the camera system never grows a THREE.AudioListener — one would be a
    // second, silent audio graph competing with the real one.
    const system = newSystem();
    const context = makeContext();
    const hasListener = (): boolean =>
      system.camera.children.some((c) => c instanceof THREE.AudioListener);
    expect(hasListener()).toBe(false);
    system.toggleMode();
    system.update(context);
    expect(hasListener()).toBe(false);
    settle(system.update.bind(system), context, 3);
    expect(hasListener()).toBe(false);
    expect(system.camera.children.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. TRANSITION
// ---------------------------------------------------------------------------

describe('transition', () => {
  it('solves a duration inside the authored band at every distance', () => {
    for (const d of [0, 1, 12, 45, 330, 1400, 1e5]) {
      const s = transitionSeconds(d);
      expect(s).toBeGreaterThanOrEqual(0.7);
      expect(s).toBeLessThanOrEqual(1.4);
    }
    expect(transitionSeconds(1400)).toBeGreaterThan(transitionSeconds(12));
  });

  it('reaches the destination pose exactly, from every scale', () => {
    for (const scale of [0, CINEMATIC_DEFAULT_SCALE, 1]) {
      const system = newSystem();
      const context = makeContext();
      system.cinematic.setScale(scale);
      settle(system.update.bind(system), context, 2);

      system.setMode('embodied');
      settle(system.update.bind(system), context, 3);
      expect(system.isTransitioning, `scale ${scale}`).toBe(false);
      expect(
        system.camera.position.distanceTo(system.embodied.pose.position),
        `scale ${scale}`,
      ).toBeLessThan(1e-9);
      expect(system.camera.fov).toBeCloseTo(system.embodied.pose.fov, 9);
      expect(system.camera.near).toBeCloseTo(system.embodied.pose.near, 12);

      system.setMode('cinematic');
      settle(system.update.bind(system), context, 3);
      expect(
        system.camera.position.distanceTo(system.cinematic.pose.position),
      ).toBeLessThan(1e-9);
      expect(system.camera.near).toBeCloseTo(system.cinematic.pose.near, 12);
    }
  });

  it('advances monotonically and stays finite the whole way', () => {
    const system = newSystem();
    const context = makeContext();
    system.cinematic.setScale(1);
    settle(system.update.bind(system), context, 2);

    system.setMode('embodied');
    let previous = -1;
    let steps = 0;
    while (system.isTransitioning && steps < 600) {
      system.update(context);
      const p = system.telemetry().transitionProgress;
      expect(p).toBeGreaterThanOrEqual(previous);
      previous = p;
      expect(isFinitePose(system.camera as unknown as Parameters<typeof isFinitePose>[0])).toBe(
        true,
      );
      expect(system.camera.matrixWorld.elements.every(Number.isFinite)).toBe(true);
      steps++;
    }
    expect(steps).toBeGreaterThan(30);
    expect(previous).toBeCloseTo(1, 6);
  });

  it('reverses mid-flight without a discontinuity', () => {
    const system = newSystem();
    const context = makeContext();
    settle(system.update.bind(system), context, 2);

    system.setMode('embodied');
    for (let i = 0; i < 19; i++) system.update(context);
    const previous = system.camera.position.clone();
    system.update(context);
    const ordinaryStep = system.camera.position.distanceTo(previous);
    const before = system.camera.position.clone();

    system.setMode('cinematic');
    system.update(context);
    // Smootherstep satisfies s(1 - u) = 1 - s(u), so reflecting the elapsed
    // time lands on the value the other direction was about to produce. The
    // reversal therefore costs two frames of travel — one to get back to where
    // the reflection puts it and one for the frame itself — and not a jump.
    expect(ordinaryStep).toBeGreaterThan(0);
    expect(system.camera.position.distanceTo(before)).toBeLessThan(ordinaryStep * 3);
    settle(system.update.bind(system), context, 3);
    expect(system.modeName).toBe('cinematic');
    expect(
      system.camera.position.distanceTo(system.cinematic.pose.position),
    ).toBeLessThan(1e-9);
  });

  it('runs straight, with the vertical rate a fixed share of the horizontal', () => {
    // The property the straight line exists for. A path with a vertical final
    // tangent — which is what the first version had, and what any arc onto a
    // point directly above the destination has — finishes its horizontal travel
    // while it is still several metres up, and spends the last third of the
    // move dropping. Straight means the two rates are locked together for the
    // whole run, so it reads as one movement.
    const transition = new CameraTransition();
    const cinematic = new CinematicCameraController();
    cinematic.setViewport(ASPECT);
    const embodied = new EmbodiedCameraController();
    embodied.setViewport(ASPECT);
    const sample = new THREE.Vector3();
    const context = makeContext();

    for (const scale of [0, 0.25, 0.5, 0.75, 1]) {
      cinematic.reset();
      cinematic.setScale(scale);
      settle(cinematic.update.bind(cinematic), context, 2);
      settle(embodied.update.bind(embodied), context, 2);
      const from = cinematic.pose.position;
      const to = embodied.pose.position;
      const total = from.distanceTo(to);
      const totalDrop = from.y - to.y;

      let previous = -1;
      for (let i = 0; i <= 100; i++) {
        const t = i / 100;
        transition.samplePath(from, to, t, sample);
        expect(Number.isFinite(sample.x + sample.y + sample.z)).toBe(true);
        // Monotone approach: the remaining distance only ever falls.
        const remaining = sample.distanceTo(to);
        if (previous >= 0) expect(remaining).toBeLessThanOrEqual(previous + 1e-9);
        previous = remaining;
        // The share of the descent done equals the share of the path done, to
        // floating point. This is the assertion the old arc failed.
        const droppedShare = (from.y - sample.y) / Math.max(totalDrop, 1e-6);
        const travelledShare = (total - remaining) / Math.max(total, 1e-6);
        expect(droppedShare, `scale ${scale} t ${t}`).toBeCloseTo(travelledShare, 6);
      }
      transition.samplePath(from, to, 1, sample);
      expect(sample.distanceTo(to)).toBeLessThan(1e-9);
    }
  });

  it('leaves quickly and arrives slowly', () => {
    // The ease is asymmetric on purpose: peak speed at two fifths rather than
    // in the middle, so the camera sheds speed as it closes rather than
    // arriving at its fastest.
    const speeds: number[] = [];
    const h = 1e-4;
    for (let i = 1; i < 100; i++) {
      const u = i / 100;
      speeds.push((easeArrival(u + h) - easeArrival(u - h)) / (2 * h));
    }
    const peak = speeds.indexOf(Math.max(...speeds)) / 100;
    expect(peak).toBeGreaterThan(0.3);
    expect(peak).toBeLessThan(0.5);
    // Two thirds of the way there by half time, against a half for a symmetric
    // ease. And the last fifth of the clock covers only a few percent.
    expect(easeArrival(0.5)).toBeGreaterThan(0.6);
    expect(easeArrival(0.8)).toBeGreaterThan(0.94);
    // Still C1 at both ends, so there is no snap leaving and none landing.
    expect(easeArrival(0)).toBe(0);
    expect(easeArrival(1)).toBeCloseTo(1, 12);
    expect(speeds[0]).toBeLessThan(0.2);
    expect(speeds[speeds.length - 1]).toBeLessThan(0.2);
    // Monotone, so progress never goes backwards.
    let previous = -1;
    for (let i = 0; i <= 1000; i++) {
      const v = easeArrival(i / 1000);
      expect(v).toBeGreaterThanOrEqual(previous);
      previous = v;
    }
  });

  it('inverts its own ease exactly enough to reverse on', () => {
    for (let i = 0; i <= 100; i++) {
      const u = i / 100;
      expect(easeArrivalInverse(easeArrival(u))).toBeCloseTo(u, 3);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. EMBODIED LOOK
// ---------------------------------------------------------------------------

describe('embodied look', () => {
  it('turns through a full circle without inverting or wrapping badly', () => {
    const controller = new EmbodiedCameraController();
    controller.setViewport(ASPECT);
    const context = makeContext();
    const forward = new THREE.Vector3();
    const seen: number[] = [];
    // 72 steps of 5 degrees: one full turn.
    for (let i = 0; i < 72; i++) {
      controller.lookBy(5 * DEG, 0);
      const pose = controller.update(context);
      expect(isFinitePose(pose)).toBe(true);
      forward.set(0, 0, -1).applyQuaternion(pose.quaternion);
      // Level look: the forward axis must stay near the horizontal plane, and
      // must never flip its vertical sense, which is what a lookAt with an up
      // vector does as it passes through the pole.
      //
      // The bound scales with the field of view, because the authored pitch
      // does: holding the horizon a third of the way down a *wider* frame needs
      // more elevation. At the 100-degree horizontal field this is 12.7 degrees
      // up, so 0.3 rather than the 0.2 that suited the old 88.
      expect(Math.abs(forward.y)).toBeLessThan(0.3);
      seen.push(Math.atan2(forward.x, -forward.z));
    }
    // The bearing swept a full turn: consecutive steps all move the same way.
    let total = 0;
    for (let i = 1; i < seen.length; i++) {
      let d = seen[i] - seen[i - 1];
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      expect(d).toBeLessThan(0); // grab-the-world: +yaw swings the view one way
      total += d;
    }
    // 72 samples means 71 deltas of five degrees: 355, not 360.
    expect(Math.abs(total)).toBeCloseTo(355 * DEG, 3);
  });

  it('reaches the zenith and the downward limit, and stops there', () => {
    const controller = new EmbodiedCameraController();
    controller.setViewport(ASPECT);
    const context = makeContext();
    const forward = new THREE.Vector3();

    for (let i = 0; i < 200; i++) controller.lookBy(0, 5 * DEG);
    let pose = controller.update(context);
    expect(controller.pitch).toBeCloseTo(EMBODIED_PITCH_MAX, 9);
    expect(isFinitePose(pose)).toBe(true);
    forward.set(0, 0, -1).applyQuaternion(pose.quaternion);
    expect(forward.y).toBeGreaterThan(Math.sin(88 * DEG));

    for (let i = 0; i < 400; i++) controller.lookBy(0, -5 * DEG);
    pose = controller.update(context);
    expect(controller.pitch).toBeCloseTo(EMBODIED_PITCH_MIN, 9);
    expect(isFinitePose(pose)).toBe(true);
    forward.set(0, 0, -1).applyQuaternion(pose.quaternion);
    expect(forward.y).toBeLessThan(-Math.sin(84 * DEG));
  });

  it('holds the yaw steady while looking straight up', () => {
    // The pole is where a look-at-with-up basis degenerates and the heading
    // snaps. Composing from quaternions, it does not.
    const controller = new EmbodiedCameraController();
    controller.setViewport(ASPECT);
    const context = makeContext();
    controller.look = { yaw: 1.1, pitch: EMBODIED_PITCH_MAX };
    const a = controller.update(context).quaternion.clone();
    controller.lookBy(0, 5 * DEG); // clamped: no change
    const b = controller.update(context).quaternion.clone();
    expect(controller.yaw).toBeCloseTo(1.1, 12);
    expect(Math.abs(a.dot(b))).toBeCloseTo(1, 12);
  });

  it('stays finite under violent vessel attitudes', () => {
    const controller = new EmbodiedCameraController();
    controller.setViewport(ASPECT);
    const matrix = new THREE.Matrix4();
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    for (let i = 0; i < 600; i++) {
      const pitch = Math.sin(i * 0.31) * 55 * DEG;
      const roll = Math.cos(i * 0.47) * 65 * DEG;
      const yaw = i * 0.05;
      euler.set(pitch, yaw, roll);
      matrix.makeRotationFromEuler(euler);
      matrix.setPosition(Math.sin(i * 0.2) * 3, Math.sin(i * 0.13) * 9, Math.cos(i * 0.2) * 3);
      const context = makeContext({ matrixWorld: matrix, pitch, yaw, roll });
      const pose = controller.update(context);
      expect(isFinitePose(pose)).toBe(true);
      // Stabilisation attenuates: the inherited tilt is a fraction of the
      // vessel's, never more than it.
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
      expect(Number.isFinite(up.y)).toBe(true);
    }
  });

  it('opens onto open water rather than into the sail', () => {
    const controller = new EmbodiedCameraController();
    controller.setViewport(ASPECT);
    const context = makeContext();
    controller.resetLook();
    const pose = controller.update(context);
    // Derived from the figure's own yaw, not eyeballed.
    expect(controller.yaw).toBeCloseTo(DEFAULT_LOOK_YAW, 9);
    expect(controller.pitch).toBeCloseTo(embodiedDefaultPitch(ASPECT), 9);
    // The eye is at the authored anchor, and the rig is behind it: the view
    // faces +z, the figure sits at z = 1.06, the mast is at the origin.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    expect(pose.position.z).toBeCloseTo(EYE_ANCHOR.z, 9);
    expect(forward.z).toBeGreaterThan(0.7);
  });

  it('opens on two thirds sky at every supported aspect', () => {
    // Authored as a frame fraction, not an angle, because the embodied field of
    // view clamps at both ends of the aspect range — a fixed pitch would put
    // the horizon somewhere different on a phone than on a desktop.
    for (const [w, h] of [
      [3840, 2160],
      [1440, 900],
      [390, 844],
      [844, 390],
    ]) {
      const aspect = w / h;
      const tanHalf = Math.tan(embodiedFov(aspect) / 2);
      const pitch = embodiedDefaultPitch(aspect);
      // The horizon's depression is zero from an eye a metre off the water, so
      // its frame fraction is the composition equation at d = 0.
      const horizon = 0.5 * (1 + Math.tan(pitch) / tanHalf);
      expect(horizon, `${w}x${h}`).toBeCloseTo(2 / 3, 9);
      expect(pitch, `${w}x${h}`).toBeGreaterThan(0); // looking up, not down
    }
  });

  it('uses a human field of view that never becomes a fisheye', () => {
    // The guard band is 40-90 vertical, and it is a guard for extreme aspects
    // rather than a working range: at 100 degrees horizontal a normal display
    // lands between 55 and 70, and the bounds only bite on a phone in portrait
    // or an ultra-wide slit. They used to be 64-78, which pinned the field over
    // most of the panel slider's travel and made the control look broken.
    for (const aspect of [0.46, 1, 16 / 9, 21 / 9, 4]) {
      const fov = embodiedFov(aspect) / DEG;
      expect(fov).toBeGreaterThanOrEqual(40 - 1e-9);
      expect(fov).toBeLessThanOrEqual(90 + 1e-9);
    }
    // And on the displays anyone actually uses, nothing is clamped at all: the
    // horizontal reference is what decides the picture.
    for (const aspect of [16 / 9, 16 / 10, 2.1, 21 / 9]) {
      const fov = embodiedFov(aspect) / DEG;
      expect(fov, `aspect ${aspect.toFixed(2)}`).toBeGreaterThan(40 + 1e-9);
      expect(fov, `aspect ${aspect.toFixed(2)}`).toBeLessThan(90 - 1e-9);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. WORLD-STATE ISOLATION
// ---------------------------------------------------------------------------

describe('world-state isolation', () => {
  it('leaves the canonical planetary state untouched', () => {
    const world = new PlanetaryWorld({
      worldInstantUtcSeconds: 1_700_000_000,
      latitudeRad: -41 * DEG,
      longitudeRad: 174 * DEG,
      initialCourseRad: 1.2,
      initialSpeedMps: 1.4,
    });
    const before = JSON.stringify(world.createSnapshot());

    const system = newSystem();
    const context = makeContext();
    // Everything the camera can be asked to do.
    for (const scale of [0, 0.5, 1]) {
      system.cinematic.setScale(scale);
      system.drag(220, -140, 1440, 900);
      system.zoomBy(0.2);
      system.setViewport(3840, 2160);
      settle(system.update.bind(system), context, 1);
    }
    system.toggleMode();
    settle(system.update.bind(system), context, 3);
    system.drag(-300, 90, 390, 844);
    system.toggleMode();
    settle(system.update.bind(system), context, 3);
    system.reset();
    system.setDiagnosticView(700, 200);
    settle(system.update.bind(system), context, 1);

    expect(JSON.stringify(world.createSnapshot())).toBe(before);
  });

  it('has no route to canonical state through its own interface', () => {
    // Structural, not behavioural: the camera reads a `CameraContext`, and
    // there is nothing on it that could move the vessel, advance a clock or
    // reach an ECEF coordinate. If that ever changes, this fails.
    const context = makeContext();
    expect(Object.keys(context).sort()).toEqual(
      ['dt', 'vessel', 'waterHeightAt'].sort(),
    );
    expect(Object.keys(context.vessel).sort()).toEqual(
      [
        'designWaterlineY',
        'framing',
        'matrixWorld',
        'pitch',
        'roll',
        'waterlineY',
        'x',
        'yaw',
        'z',
      ].sort(),
    );
    expect(Object.keys(context.vessel.framing).sort()).toEqual(
      ['heightM', 'lengthM', 'points', 'radiusM', 'widthM'].sort(),
    );
  });

  it('runs on presentation time, not on the accelerated world clock', () => {
    // The follow spring and every filter are exponential in dt. Two runs that
    // cover the same *presentation* seconds in different step sizes must agree,
    // which is what makes the camera frame-rate independent — and it is also
    // why nothing here may ever be handed a world-time delta.
    const settleAt = (dt: number): THREE.Vector3 => {
      const controller = new CinematicCameraController();
      controller.setViewport(ASPECT);
      const context = makeContext();
      (context as { dt: number }).dt = dt;
      const matrix = new THREE.Matrix4().setPosition(4, 0, -3);
      (context.vessel as { matrixWorld: THREE.Matrix4 }).matrixWorld = matrix;
      (context.vessel as { x: number }).x = 4;
      (context.vessel as { z: number }).z = -3;
      const steps = Math.round(6 / dt);
      for (let i = 0; i < steps; i++) controller.update(context);
      return controller.pose.position.clone();
    };
    const at60 = settleAt(1 / 60);
    const at144 = settleAt(1 / 144);
    const at30 = settleAt(1 / 30);
    expect(at60.distanceTo(at144)).toBeLessThan(0.01);
    expect(at60.distanceTo(at30)).toBeLessThan(0.02);
  });
});

// ---------------------------------------------------------------------------
// 7. INPUT
// ---------------------------------------------------------------------------

/** The smallest surface `InputController` actually touches. */
class FakeElement {
  clientWidth = 1440;
  clientHeight = 900;
  readonly listeners = new Map<string, Array<(e: unknown) => void>>();

  addEventListener(type: string, fn: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  setPointerCapture(): void {}
  releasePointerCapture(): void {}

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }

  fire(type: string, event: Record<string, unknown>): void {
    const base = { preventDefault: () => {}, ...event };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(base);
  }

  get listenerCount(): number {
    let n = 0;
    for (const list of this.listeners.values()) n += list.length;
    return n;
  }
}

describe('input', () => {
  let element: FakeElement;
  let windowStub: FakeElement;
  let system: CameraSystem;
  let controller: InputController;
  let sailToggles: number;
  let uses: number;

  beforeEach(() => {
    element = new FakeElement();
    windowStub = new FakeElement();
    (globalThis as { window?: unknown }).window = windowStub;
    system = newSystem();
    sailToggles = 0;
    uses = 0;
    controller = new InputController(element as unknown as HTMLElement, system, {
      onToggleSail: () => {
        sailToggles++;
      },
      onTapSail: () => {
        sailToggles++;
      },
      onToggleMute: () => {},
      onFirstInteraction: () => {},
      onUse: () => { uses++; },
      touchWalkingEnabled: true,
    });
    system.update(makeContext());
  });

  afterEach(() => {
    controller.dispose();
    delete (globalThis as { window?: unknown }).window;
  });

  const down = (id: number, x: number, y: number): void =>
    element.fire('pointerdown', { pointerId: id, clientX: x, clientY: y });
  const move = (id: number, x: number, y: number): void =>
    element.fire('pointermove', { pointerId: id, clientX: x, clientY: y });
  const up = (id: number, x: number, y: number): void =>
    element.fire('pointerup', { pointerId: id, clientX: x, clientY: y });
  const touchDown = (id: number, x: number, y: number): void =>
    element.fire('pointerdown', {
      pointerId: id,
      pointerType: 'touch',
      clientX: x,
      clientY: y,
    });
  const touchMove = (id: number, x: number, y: number): void =>
    element.fire('pointermove', {
      pointerId: id,
      pointerType: 'touch',
      clientX: x,
      clientY: y,
    });
  const touchUp = (id: number, x: number, y: number): void =>
    element.fire('pointerup', {
      pointerId: id,
      pointerType: 'touch',
      clientX: x,
      clientY: y,
    });

  /** Put a vertical mast segment under a real screen point at eye distance. */
  const mastAt = (distance: number): { x: number; y: number } => {
    const forward = new THREE.Vector3();
    system.camera.getWorldDirection(forward);
    const centre = system.camera.position.clone().addScaledVector(forward, distance);
    controller.pickLow.copy(centre).add(new THREE.Vector3(0, -0.7, 0));
    controller.pickHigh.copy(centre).add(new THREE.Vector3(0, 0.7, 0));
    const projected = centre.project(system.camera);
    return {
      x: ((projected.x + 1) / 2) * element.clientWidth,
      y: ((1 - projected.y) / 2) * element.clientHeight,
    };
  };

  it('orbits on a one-pointer drag', () => {
    const azimuth = system.cinematic.orbitAzimuth;
    down(1, 700, 400);
    move(1, 850, 400);
    up(1, 850, 400);
    expect(system.cinematic.orbitAzimuth).not.toBeCloseTo(azimuth, 6);
    // Dragging right swings the orbit the documented way, not the other one.
    expect(system.cinematic.orbitAzimuth).toBeLessThan(azimuth);
  });

  it('pinches to zoom, in log space, symmetrically', () => {
    const scale0 = system.cinematicScale;
    down(1, 600, 400);
    down(2, 800, 400);
    move(2, 1000, 400); // spread
    const spread = system.cinematicScale;
    expect(spread).toBeLessThan(scale0);
    move(2, 800, 400); // back
    expect(system.cinematicScale).toBeCloseTo(scale0, 6);
    up(1, 600, 400);
    up(2, 800, 400);
  });

  it('uses simultaneous left-touch walking and right-touch looking when embodied', () => {
    system.setDiagnosticMode('embodied');
    const yaw = system.embodied.yaw;

    touchDown(1, 240, 600);
    touchMove(1, 300, 520);
    const walking = controller.movementAxes();
    expect(walking.forward).toBeGreaterThan(0.5);
    expect(walking.right).toBeGreaterThan(0.3);
    // The walking thumb does not turn the head.
    expect(system.embodied.yaw).toBeCloseTo(yaw, 12);

    touchDown(2, 1100, 450);
    touchMove(2, 1200, 450);
    expect(system.embodied.yaw).not.toBeCloseTo(yaw, 6);
    // Looking with the second thumb does not disturb held walking intent.
    expect(controller.movementAxes()).toEqual(walking);

    touchUp(1, 300, 520);
    expect(controller.movementAxes()).toEqual({ forward: 0, right: 0 });
    touchUp(2, 1200, 450);
  });

  it('gives a resting walking thumb a dead zone and caps full travel', () => {
    system.setDiagnosticMode('embodied');
    touchDown(1, 240, 600);
    touchMove(1, 246, 594);
    expect(controller.movementAxes()).toEqual({ forward: 0, right: 0 });
    touchMove(1, 1240, -400);
    const axes = controller.movementAxes();
    expect(Math.hypot(axes.forward, axes.right)).toBeCloseTo(1, 12);
  });

  it('ends touch walking on pointer cancellation or lost focus without treating it as a tap', () => {
    system.setDiagnosticMode('embodied');
    touchDown(1, 240, 600);
    touchMove(1, 240, 500);
    expect(controller.movementAxes().forward).toBeGreaterThan(0);
    element.fire('pointercancel', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 240,
      clientY: 500,
    });
    expect(controller.movementAxes()).toEqual({ forward: 0, right: 0 });
    expect(system.modeName).toBe('embodied');
    expect(sailToggles).toBe(0);

    touchDown(2, 240, 600);
    touchMove(2, 240, 500);
    windowStub.fire('blur', {});
    expect(controller.movementAxes()).toEqual({ forward: 0, right: 0 });
  });

  it('keeps cinematic touch orbit and pinch unchanged', () => {
    const azimuth = system.cinematic.orbitAzimuth;
    const scale = system.cinematicScale;
    touchDown(1, 200, 400);
    touchMove(1, 300, 400);
    expect(system.cinematic.orbitAzimuth).not.toBeCloseTo(azimuth, 6);
    expect(controller.movementAxes()).toEqual({ forward: 0, right: 0 });
    touchDown(2, 800, 400);
    touchMove(2, 1000, 400);
    expect(system.cinematicScale).not.toBeCloseTo(scale, 6);
    touchUp(1, 300, 400);
    touchUp(2, 1000, 400);
  });

  it('does not reserve the left half when the active vessel cannot walk', () => {
    controller.dispose();
    controller = new InputController(element as unknown as HTMLElement, system, {
      onToggleSail: () => {},
      onToggleMute: () => {},
      onFirstInteraction: () => {},
      onUse: () => { uses++; },
      touchWalkingEnabled: false,
    });
    system.setDiagnosticMode('embodied');
    const yaw = system.embodied.yaw;
    touchDown(1, 200, 450);
    touchMove(1, 300, 450);
    expect(system.embodied.yaw).not.toBeCloseTo(yaw, 6);
    expect(controller.movementAxes()).toEqual({ forward: 0, right: 0 });
  });

  it('works a pointed-at mast only from embodied reach', () => {
    system.setDiagnosticMode('embodied');
    system.update(makeContext());
    const at = mastAt(REACH - 0.4);
    down(1, at.x + 200, at.y);
    up(1, at.x + 200, at.y);
    expect(sailToggles).toBe(0);

    down(2, at.x, at.y);
    up(2, at.x, at.y);
    expect(sailToggles).toBe(1);
  });

  it('keeps the visible production raft mast base tappable when its top is behind the eye', () => {
    const raft = new Raft();
    try {
      raft.group.updateMatrixWorld(true);
      raft.updateTrimPickTargets(controller.pickLow, controller.pickHigh);
      const eye = system.embodied.eyeLocal;
      const dx = controller.pickLow.x - eye.x;
      const dz = controller.pickLow.z - eye.z;
      system.setDiagnosticMode('embodied');
      system.look = {
        // `EmbodiedCameraController` looks along (-sin(yaw), -cos(yaw)).
        yaw: Math.atan2(-dx, -dz),
        pitch: -40 * DEG,
      };
      system.update(makeContext());

      const base = controller.pickLow.clone().project(system.camera);
      const top = controller.pickHigh.clone().project(system.camera);
      expect(base.z).toBeGreaterThan(-1);
      expect(base.z).toBeLessThan(1);
      expect(Math.abs(base.x)).toBeLessThan(1);
      expect(Math.abs(base.y)).toBeLessThan(1);
      expect(top.z).toBeGreaterThan(1);

      const x = ((base.x + 1) / 2) * element.clientWidth;
      const y = ((1 - base.y) / 2) * element.clientHeight;
      down(1, x, y);
      up(1, x, y);
      expect(sailToggles).toBe(1);
    } finally {
      raft.dispose();
    }
  });

  it('rejects a mast beyond reach even when it is large and under the pointer', () => {
    system.setDiagnosticMode('embodied');
    system.update(makeContext());
    const at = mastAt(REACH + 1.2);
    down(1, at.x, at.y);
    up(1, at.x, at.y);
    expect(sailToggles).toBe(0);
  });

  it('keeps R global but refuses the object mast tap in cinematic view', () => {
    const at = mastAt(1.5);
    down(1, at.x, at.y);
    up(1, at.x, at.y);
    expect(sailToggles).toBe(0);

    windowStub.fire('keydown', { code: 'KeyR', repeat: false });
    expect(sailToggles).toBe(1);
  });

  it('normalises the wheel across deltaMode, so one notch is one notch', () => {
    const step = (deltaY: number, deltaMode: number): number => {
      system.resetCinematic();
      system.update(makeContext());
      const before = system.cinematicScale;
      element.fire('wheel', { deltaY, deltaMode });
      return system.cinematicScale - before;
    };
    const pixels = step(100, 0);
    const lines = step(3, 1);
    expect(pixels).toBeGreaterThan(0);
    // Firefox reports three lines per notch. Treated as pixels that is 33x too
    // small — several hundred notches to cross the range.
    expect(lines / pixels).toBeGreaterThan(0.3);
    expect(lines / pixels).toBeLessThan(3);
    expect(step(-100, 0)).toBeLessThan(0);
  });

  it('toggles the mode on V and on a double tap, but not on a single one', () => {
    element.fire('wheel', { deltaY: 0, deltaMode: 0 });
    windowStub.fire('keydown', { code: 'KeyV', repeat: false });
    expect(system.modeName).toBe('embodied');
    windowStub.fire('keydown', { code: 'KeyV', repeat: false });
    expect(system.modeName).toBe('cinematic');
    // Auto-repeat must not strobe the mode.
    windowStub.fire('keydown', { code: 'KeyV', repeat: true });
    expect(system.modeName).toBe('cinematic');

    // A single tap on open water does nothing; two in quick succession switch.
    down(3, 200, 700);
    up(3, 200, 700);
    expect(system.modeName).toBe('cinematic');
    down(4, 202, 702);
    up(4, 202, 702);
    expect(system.modeName).toBe('embodied');
  });

  it('leaves R unbound on a vessel with no drift sail', () => {
    // The retirement, pinned. `onToggleSail` is absent on the production
    // schooner, and absent has to mean the key does nothing rather than the
    // key doing something invisible: R reached `WindSystem.toggleSail`, whose
    // only readers are the raft's canvas and one word in a debug panel.
    controller.dispose();
    let unboundToggles = 0;
    controller = new InputController(element as unknown as HTMLElement, system, {
      onToggleMute: () => {},
      onFirstInteraction: () => {
        unboundToggles++;
      },
      onUse: () => { uses++; },
      touchWalkingEnabled: true,
    });

    windowStub.fire('keydown', { code: 'KeyR', repeat: false });
    expect(sailToggles).toBe(0);
    // And it does not even count as the player arriving: the first-gesture
    // hook is what starts the audio context, and a key that is not bound on
    // this vessel must not be what unmutes the sea.
    expect(unboundToggles).toBe(0);

    // The keys that ARE bound still are, so this is a narrowing rather than a
    // keyboard that stopped listening.
    windowStub.fire('keydown', { code: 'Space', repeat: false });
    expect(uses).toBe(1);
  });

  it('does not steal keystrokes from form fields', () => {
    // Two keys now, because Space and the sail parted company: Space is "use
    // what you are looking at" and R is the canvas. Both have to be refused
    // while a field has focus, and this test earns its keep only if it probes
    // the key that is actually bound.
    windowStub.fire('keydown', {
      code: 'KeyR',
      repeat: false,
      target: { tagName: 'INPUT' },
    });
    expect(sailToggles).toBe(0);
    windowStub.fire('keydown', { code: 'KeyR', repeat: false });
    expect(sailToggles).toBe(1);

    windowStub.fire('keydown', {
      code: 'Space',
      repeat: false,
      target: { tagName: 'INPUT' },
    });
    expect(uses).toBe(0);
    windowStub.fire('keydown', { code: 'Space', repeat: false });
    expect(uses).toBe(1);
  });

  it('releases every listener it took', () => {
    expect(element.listenerCount + windowStub.listenerCount).toBeGreaterThan(0);
    controller.dispose();
    expect(element.listenerCount).toBe(0);
    expect(windowStub.listenerCount).toBe(0);
    // dispose() is called again in afterEach; it must stay harmless.
  });

  it('survives a pointer that never went down and a viewport of zero', () => {
    move(99, 10, 10);
    up(99, 10, 10);
    element.clientWidth = 0;
    element.clientHeight = 0;
    down(1, 0, 0);
    move(1, 5, 5);
    up(1, 5, 5);
    expect(Number.isFinite(system.cinematic.orbitAzimuth)).toBe(true);
    expect(Number.isFinite(system.cinematicScale)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. SERIALISATION BOUNDARY
// ---------------------------------------------------------------------------

describe('serialisation boundary', () => {
  it('keeps camera state out of the canonical world snapshot', () => {
    const world = new PlanetaryWorld({
      worldInstantUtcSeconds: 1_700_000_000,
      latitudeRad: 0.2,
      longitudeRad: -0.4,
      initialCourseRad: 0.9,
      initialSpeedMps: 1.1,
    });
    const snapshot = world.createSnapshot();
    const flat = JSON.stringify(snapshot).toLowerCase();
    for (const word of ['camera', 'azimuth', 'elevation', 'cinematic', 'embodied', 'fov']) {
      expect(flat.includes(word), `snapshot mentions "${word}"`).toBe(false);
    }
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        'paused',
        'positionEcefM',
        'surfaceFrameEcef',
        'velocityEcefMps',
        'version',
        'worldInstantUtcSeconds',
        'worldSecondsPerRealSecond',
      ].sort(),
    );
  });

  it('round-trips the camera composition through plain data', () => {
    // The framing and look objects are the whole of the camera's persistable
    // state, and they are plain numbers — so if they are ever stored, they go
    // somewhere of their own rather than into the world snapshot.
    const system = newSystem();
    const context = makeContext();
    system.cinematic.setScale(0.63);
    system.drag(140, -70, 1440, 900);
    settle(system.update.bind(system), context, 1);
    system.toggleMode();
    settle(system.update.bind(system), context, 3);
    system.drag(200, 60, 1440, 900);

    const saved = JSON.parse(
      JSON.stringify({ framing: system.framing, look: system.look }),
    ) as { framing: typeof system.framing; look: typeof system.look };

    const restored = newSystem();
    restored.framing = saved.framing;
    restored.look = saved.look;
    settle(restored.update.bind(restored), context, 1);

    expect(restored.framing.scale).toBeCloseTo(system.framing.scale, 12);
    expect(restored.framing.azimuth).toBeCloseTo(system.framing.azimuth, 12);
    expect(restored.look.yaw).toBeCloseTo(system.look.yaw, 12);
    expect(restored.look.pitch).toBeCloseTo(system.look.pitch, 12);
  });

  it('sanitises a restored composition rather than trusting it', () => {
    const system = newSystem();
    const context = makeContext();
    system.framing = { azimuth: 40, elevationOffset: 12, scale: 9 };
    system.look = { yaw: 900, pitch: 900 };
    settle(system.update.bind(system), context, 1);
    expect(system.cinematicScale).toBe(1);
    expect(system.look.pitch).toBeCloseTo(EMBODIED_PITCH_MAX, 9);
    expect(Math.abs(system.look.yaw)).toBeLessThanOrEqual(Math.PI);
    expect(system.cinematic.orbitElevation).toBeLessThanOrEqual(ELEVATION_MAX + 1e-9);
    expect(isFinitePose(system.cinematic.pose)).toBe(true);
  });
});
