import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  CinematicCameraController,
  NEUTRAL_VESSEL_FRAME_BOTTOM,
  NEUTRAL_VESSEL_FRAME_TOP,
  VESSEL_FRAME_GUARD_TOP,
} from '../src/camera/CinematicCameraController';
import { cinematicElevation } from '../src/camera/cameraTuning';
import {
  vesselFramingEnvelope,
  vesselFramingEnvelopeFromPoints,
  vesselFramingPoints,
} from '../src/camera/vesselFraming';
import type { CameraContext, VesselFramingEnvelope } from '../src/camera/types';
import { Schooner } from '../src/vessel/schooner/Schooner';

const DEG = Math.PI / 180;
const ASPECT = 1440 / 900;
const DESIGN_WATERLINE_Y = 2.5;

interface WaveComponent {
  amplitude: number;
  period: number;
  headingDeg: number;
}

/** Conservative deterministic stand-ins for the production preset families. */
const MODERATE: readonly WaveComponent[] = [
  { amplitude: 0.23, period: 6.3, headingDeg: 0 },
  { amplitude: 0.2, period: 2.89, headingDeg: 40 },
];
const ROUGH: readonly WaveComponent[] = [
  { amplitude: 2.2, period: 15.5, headingDeg: 0 },
  { amplitude: 0.8, period: 11, headingDeg: 25 },
  { amplitude: 2.48, period: 10.6, headingDeg: -15 },
];
const EXTREME: readonly WaveComponent[] = [
  { amplitude: 4, period: 18, headingDeg: 0 },
  { amplitude: 2, period: 12, headingDeg: 30 },
  { amplitude: 7.95, period: 19.8, headingDeg: -10 },
];

function boxCorners(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) points.push(new THREE.Vector3(x, y, z));
    }
  }
  return points;
}

/** Hull through 22 m truck: the pending two-mast rig, not the retired raft. */
const TALL_SHIP_POINTS = boxCorners([-3.2, -1.2, -9.5], [3.2, 22, 11.5]);

function waveTrain(components: readonly WaveComponent[]): {
  advance(dt: number): void;
  at(x: number, z: number): number;
  time(): number;
} {
  const parts = components.map((c) => {
    const omega = (Math.PI * 2) / c.period;
    return {
      amplitude: c.amplitude,
      omega,
      k: (omega * omega) / 9.81,
      dx: Math.sin(c.headingDeg * DEG),
      dz: Math.cos(c.headingDeg * DEG),
    };
  });
  let t = 0;
  return {
    advance(dt: number): void {
      t += dt;
    },
    at(x: number, z: number): number {
      return parts.reduce(
        (sum, p) =>
          sum + p.amplitude * Math.sin(p.k * (p.dx * x + p.dz * z) - p.omega * t),
        0,
      );
    },
    time: () => t,
  };
}

interface SweepSample {
  cameraY: number;
  correction: number;
  locked: boolean;
  waterlineFrame: number;
  frameTop: number;
  frameBottom: number;
  waterUnderCamera: number;
  quaternion: THREE.Quaternion;
}

function sweep(
  distance: number,
  components: readonly WaveComponent[],
  {
    seconds = 90,
    dt = 1 / 60,
    pitchAmplitude = 0,
    rollAmplitude = 0,
    aspect = ASPECT,
  } = {},
): SweepSample[] {
  const sea = waveTrain(components);
  const controller = new CinematicCameraController();
  controller.setViewport(aspect);
  controller.setDistance(distance);

  const matrixWorld = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const position = new THREE.Vector3();
  const context: CameraContext = {
    dt,
    vessel: {
      matrixWorld,
      pitch: 0,
      yaw: 0,
      roll: 0,
      x: 0,
      z: 0,
      waterlineY: 0,
      designWaterlineY: DESIGN_WATERLINE_Y,
      framing: vesselFramingEnvelopeFromPoints(TALL_SHIP_POINTS),
    },
    waterHeightAt: (x, z) => sea.at(x, z),
  };
  const vessel = context.vessel as {
    pitch: number;
    roll: number;
    waterlineY: number;
  };

  const samples: SweepSample[] = [];
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    sea.advance(dt);
    const t = sea.time();
    const waterlineY = sea.at(0, 0);
    const pitch = pitchAmplitude * Math.sin((Math.PI * 2 * t) / 13.7);
    const roll = rollAmplitude * Math.sin((Math.PI * 2 * t) / 9.1 + 0.7);
    vessel.pitch = pitch;
    vessel.roll = roll;
    vessel.waterlineY = waterlineY;

    euler.set(pitch, 0, roll);
    quaternion.setFromEuler(euler);
    // Keep local design waterline at the sampled world waterline under YXZ pose.
    position.set(
      0,
      waterlineY - DESIGN_WATERLINE_Y * Math.cos(pitch) * Math.cos(roll),
      0,
    );
    matrixWorld.compose(position, quaternion, new THREE.Vector3(1, 1, 1));

    const pose = controller.update(context);
    if (i * dt < seconds / 3) continue;
    samples.push({
      cameraY: pose.position.y,
      correction: controller.verticalCorrection,
      locked: controller.tripodLocked,
      waterlineFrame: controller.waterlineFramePosition,
      frameTop: controller.vesselFrameTop,
      frameBottom: controller.vesselFrameBottom,
      waterUnderCamera: sea.at(pose.position.x, pose.position.z),
      quaternion: pose.quaternion.clone(),
    });
  }
  return samples;
}

function extent(values: number[]): { min: number; max: number; span: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { min, max, span: max - min };
}

function maxQuaternionMotion(samples: readonly SweepSample[]): number {
  const q0 = samples[0].quaternion;
  let result = 0;
  for (const sample of samples) {
    const dot = Math.abs(q0.dot(sample.quaternion));
    result = Math.max(result, 2 * Math.acos(Math.min(dot, 1)));
  }
  return result;
}

function neutralContext(
  framing: VesselFramingEnvelope,
  designWaterlineY: number,
): CameraContext {
  return {
    dt: 0,
    vessel: {
      matrixWorld: new THREE.Matrix4().makeTranslation(0, -designWaterlineY, 0),
      pitch: 0,
      yaw: 0,
      roll: 0,
      x: 0,
      z: 0,
      waterlineY: 0,
      designWaterlineY,
      framing,
    },
    waterHeightAt: () => 0,
  };
}

describe('assembled ship framing', () => {
  it('captures assembled dimensions once, including a mast added to the hull', () => {
    const ship = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 18));
    hull.position.y = 2;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 20, 8));
    mast.position.set(0, 12, 1.5);
    ship.add(hull, mast);

    const framing = vesselFramingEnvelope(ship);
    expect(framing.points).toHaveLength(8);
    expect(framing.widthM).toBeCloseTo(6, 6);
    expect(framing.heightM).toBeCloseTo(22, 6);
    expect(framing.lengthM).toBeCloseTo(18, 6);

    // The compatibility view is still the same local box, not another authored
    // set of ship dimensions in camera code.
    const points = vesselFramingPoints(ship);
    expect(Math.max(...points.map((p) => p.y))).toBeCloseTo(22, 6);
  });

  it('never asks the scene graph for bounds on the camera frame path', () => {
    const ship = new THREE.Group();
    ship.add(new THREE.Mesh(new THREE.BoxGeometry(7, 24, 23)));
    const boundsSpy = vi.spyOn(THREE.Box3.prototype, 'setFromObject');
    try {
      const framing = vesselFramingEnvelope(ship);
      expect(boundsSpy).toHaveBeenCalledTimes(1);

      const controller = new CinematicCameraController();
      controller.setViewport(ASPECT);
      const context: CameraContext = {
        ...neutralContext(framing, 0),
        dt: 1 / 60,
      };
      for (let i = 0; i < 240; i++) {
        controller.update(context);
      }

      expect(boundsSpy).toHaveBeenCalledTimes(1);
    } finally {
      boundsSpy.mockRestore();
    }
  });

  it('improves the real schooner framing by lifting Y, never by limiting zoom', () => {
    const ship = new Schooner({ advancesWaveField: false });
    try {
      const framing = vesselFramingEnvelope(ship.group);
      const context = neutralContext(framing, ship.body.designWaterlineY);
      expect(framing.heightM).toBeGreaterThan(22);
      expect(framing.lengthM).toBeGreaterThan(22);

      const controller = new CinematicCameraController();
      let sawLift = false;
      for (const aspect of [0.6, ASPECT, 16 / 9, 2.4]) {
        controller.setViewport(aspect);
        controller.setScale(0.4);
        for (let bearing = 0; bearing < 360; bearing += 15) {
          controller.setAzimuth(bearing * DEG);
          const pose = controller.update(context);
          const label = `${aspect} @ ${bearing}`;
          const span = controller.vesselFrameBottom - controller.vesselFrameTop;
          expect(controller.distance, label).toBeCloseTo(45, 8);
          const authoredY = 45 * Math.sin(11 * DEG);
          expect(pose.position.y, label).toBeGreaterThanOrEqual(authoredY - 1e-10);
          sawLift ||= pose.position.y > authoredY + 1e-5;
          if (
            span <=
            NEUTRAL_VESSEL_FRAME_BOTTOM - NEUTRAL_VESSEL_FRAME_TOP + 2e-3
          ) {
            expect(controller.vesselFrameTop, label).toBeGreaterThanOrEqual(
              NEUTRAL_VESSEL_FRAME_TOP - 2e-3,
            );
            expect(controller.vesselFrameBottom, label).toBeLessThanOrEqual(
              NEUTRAL_VESSEL_FRAME_BOTTOM + 2e-3,
            );
          } else {
            expect(
              (controller.vesselFrameTop + controller.vesselFrameBottom) * 0.5,
              label,
            ).toBeCloseTo(0.5, 3);
          }
        }
      }
      expect(sawLift).toBe(true);
    } finally {
      ship.dispose();
    }
  });

  it('keeps the original 12–1400 m scale for schooners and future larger vessels', () => {
    const schooner = vesselFramingEnvelopeFromPoints(TALL_SHIP_POINTS);
    const futureShip = vesselFramingEnvelopeFromPoints(
      boxCorners([-10, -4, -35], [10, 62, 35]),
    );
    const distancesFor = (
      framing: VesselFramingEnvelope,
      designWaterlineY: number,
    ): number[] => {
      const controller = new CinematicCameraController();
      controller.setViewport(ASPECT);
      const context = neutralContext(framing, designWaterlineY);
      return [0, 0.2, 0.4, 0.6, 0.75, 0.88, 1].map((scale) => {
        controller.setScale(scale);
        controller.update(context);
        return controller.distance;
      });
    };

    const expected = [12, 25, 45, 130, 330, 750, 1400];
    for (const actual of [
      distancesFor(schooner, DESIGN_WATERLINE_Y),
      distancesFor(futureShip, 4),
    ]) {
      actual.forEach((distance, index) => {
        expect(distance).toBeCloseTo(expected[index], 10);
      });
    }
  });

  it('uses one exact straight track and one orientation over the full zoom range', () => {
    const framing = vesselFramingEnvelopeFromPoints(TALL_SHIP_POINTS);
    const context = neutralContext(framing, DESIGN_WATERLINE_Y);
    const controller = new CinematicCameraController();
    controller.setViewport(ASPECT);

    let previousDistance = -Infinity;
    let trackOrigin: THREE.Vector3 | undefined;
    let orientation: THREE.Quaternion | undefined;
    const azimuth = controller.orbitAzimuth;
    const elevation = cinematicElevation();
    const direction = new THREE.Vector3(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      -Math.cos(azimuth) * Math.cos(elevation),
    );

    for (let i = 0; i <= 10_000; i++) {
      controller.setScale(i / 10_000);
      const pose = controller.update(context);
      const origin = pose.position
        .clone()
        .addScaledVector(direction, -controller.distance);
      if (i === 0) {
        trackOrigin = origin;
        orientation = pose.quaternion.clone();
        // The schooner-sized envelope raises the close endpoint above the
        // original bottom-of-hull viewpoint while leaving 12 m available.
        expect(trackOrigin.y).toBeGreaterThan(0);
      } else {
        expect(controller.distance).toBeGreaterThan(previousDistance);
        expect(origin.distanceTo(trackOrigin!), `at scale ${i / 10_000}`).toBeLessThan(
          1e-9,
        );
        expect(Math.abs(pose.quaternion.dot(orientation!))).toBeCloseTo(1, 12);
      }
      previousDistance = controller.distance;
    }
  });
});

describe('cinematic tripod dead zone', () => {
  it('is exactly stationary in the moderate production family at every scale', () => {
    for (const distance of [12, 25, 45, 130, 330, 750, 1400]) {
      const samples = sweep(distance, MODERATE, {
        pitchAmplitude: 1.2 * DEG,
        rollAmplitude: 2.5 * DEG,
      });
      expect(extent(samples.map((s) => s.cameraY)).span, `${distance} m`).toBeLessThan(1e-9);
      expect(samples.every((s) => s.locked), `${distance} m`).toBe(true);
    }
  });

  it('never rotates for heave, pitch, roll, water clearance, or elapsed idle time', () => {
    const closeExtreme = sweep(12, EXTREME, {
      seconds: 180,
      pitchAmplitude: 10 * DEG,
      rollAmplitude: 16 * DEG,
    });
    expect(extent(closeExtreme.map((s) => s.cameraY)).span).toBeGreaterThan(1);
    expect(maxQuaternionMotion(closeExtreme)).toBeLessThan(1e-12);
  });

  it('uses minimum upward-only Y safety when close rough seas reach the guard', () => {
    for (const [sea, pitch, roll] of [
      [ROUGH, 5 * DEG, 9 * DEG],
      [EXTREME, 10 * DEG, 16 * DEG],
    ] as const) {
      const samples = sweep(12, sea, { pitchAmplitude: pitch, rollAmplitude: roll });
      expect(extent(samples.map((s) => s.correction)).span).toBeGreaterThan(0.25);
      for (const sample of samples) {
        expect(sample.waterlineFrame).toBeGreaterThanOrEqual(VESSEL_FRAME_GUARD_TOP - 1e-6);
        expect(sample.cameraY).toBeGreaterThan(sample.waterUnderCamera);
      }
    }
  });

  it('locks again once distance makes even adversarial heave safe in frame', () => {
    const rough = sweep(130, ROUGH, {
      pitchAmplitude: 5 * DEG,
      rollAmplitude: 9 * DEG,
    });
    const extreme = sweep(330, EXTREME, {
      pitchAmplitude: 10 * DEG,
      rollAmplitude: 16 * DEG,
    });
    expect(rough.every((s) => s.locked)).toBe(true);
    expect(extreme.every((s) => s.locked)).toBe(true);
    expect(extent(rough.map((s) => s.cameraY)).span).toBeLessThan(1e-9);
    expect(extent(extreme.map((s) => s.cameraY)).span).toBeLessThan(1e-9);
  });

  it('records the first wholly locked distance across portrait, desktop and ultra-wide', () => {
    const firstLockedDistance = (
      sea: readonly WaveComponent[],
      pitchAmplitude: number,
      rollAmplitude: number,
      aspect = ASPECT,
    ): number => {
      for (let distance = 15; distance <= 400; distance += 5) {
        const samples = sweep(distance, sea, {
          seconds: 60,
          pitchAmplitude,
          rollAmplitude,
          aspect,
        });
        if (samples.every((s) => s.locked)) return distance;
      }
      return Infinity;
    };

    const thresholds = {
      portraitRough: firstLockedDistance(ROUGH, 5 * DEG, 9 * DEG, 0.6),
      portraitExtreme: firstLockedDistance(EXTREME, 10 * DEG, 16 * DEG, 0.6),
      desktopRough: firstLockedDistance(ROUGH, 5 * DEG, 9 * DEG),
      desktopExtreme: firstLockedDistance(EXTREME, 10 * DEG, 16 * DEG),
      ultraWideRough: firstLockedDistance(ROUGH, 5 * DEG, 9 * DEG, 2.4),
      ultraWideExtreme: firstLockedDistance(EXTREME, 10 * DEG, 16 * DEG, 2.4),
    };
    expect(thresholds).toEqual({
      portraitRough: 50,
      portraitExtreme: 85,
      desktopRough: 25,
      desktopExtreme: 65,
      ultraWideRough: 15,
      ultraWideExtreme: 60,
    });
  });
});
