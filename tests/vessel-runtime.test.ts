import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import {
  VesselRuntime,
  type VesselRuntimeInput,
  type VesselRuntimeOptions,
} from '../src/runtime/VesselRuntime';
import type { RuntimeSailClothMode } from '../src/runtime/RuntimeOptions';
import type {
  SailClothFlow,
  SailClothState,
} from '../src/vessel/schooner/rigGeometry';
import {
  modelYawForVelocity,
  resolveTrueHeadingDirection,
  VesselSpeedTarget,
} from '../src/vessel/VesselMotion';
import {
  AUTHORED_TRIM_RAD,
  SAILS,
  type RigTrimAnglesRad,
  type SailName,
} from '../src/vessel/schooner/rig';
import { PlanetaryWorld } from '../src/world/PlanetaryWorld';
import { readFileSync } from 'node:fs';
import { DECK_LENGTH, DECK_WIDTH } from '../src/vessel/raft/raftFlotation';
import { HULL_LENGTH } from '../src/vessel/schooner/hullForm';

interface FixtureOptions {
  production?: boolean;
  schooner?: boolean;
  walker?: boolean;
  /**
   * The Vessel-contract dimensions the runtime snapshots at construction.
   * Overridable because the raft and the schooner are different vessels and
   * the occlusion capsule is supposed to notice.
   */
  hull?: { halfLengthM: number; halfBeamM: number; waterlineLocalY: number };
  /** M6: which sail presentation the runtime should feed the loft. */
  sailClothMode?: RuntimeSailClothMode;
}

function createFixture({
  production = false,
  schooner: withSchooner = true,
  walker: withWalker = false,
  hull = { halfLengthM: 8, halfBeamM: 2.5, waterlineLocalY: 2 },
  sailClothMode,
}: FixtureOptions = {}) {
  const calls: string[] = [];
  const physicsContexts: unknown[] = [];
  const presentationContexts: unknown[] = [];
  const cameraContexts: unknown[] = [];
  const rigStates: Array<{
    trims: RigTrimAnglesRad;
    hoists: Record<SailName, number>;
    cloth?: SailClothState;
  }> = [];
  /**
   * The aero's per-sail verdict, as the runtime reads it off
   * `SchoonerSailForces.lastResult`. Mutable so a test can put one sail on the
   * edge and watch the cloth answer.
   */
  const perSail = SAILS.map((sail) => ({
    name: sail.name,
    active: true,
    aoaDeg: 22,
    luffing: false,
    apparentSpeedMps: 9,
    blanketFactor: 1,
  }));
  const cannotDraw = new Set<SailName>();
  const occlusionEndpoints: Array<{
    stern: THREE.Vector3;
    bow: THREE.Vector3;
    sternValue: THREE.Vector3;
    bowValue: THREE.Vector3;
  }> = [];

  const group = new THREE.Group();
  const updateMatrixWorld = group.updateMatrixWorld.bind(group);
  group.updateMatrixWorld = (force?: boolean): void => {
    calls.push('vessel.matrix');
    updateMatrixWorld(force);
  };

  const body = {
    designWaterlineY: 2.3,
    roll: 0.08,
    designWaterlineWorldY: () => {
      calls.push('body.waterline');
      return 4.25;
    },
  };
  const vessel = {
    kind: 'schooner',
    group,
    sceneObjects: [],
    body,
    lamp: {
      flameWorld: new THREE.Vector3(1, 2, 3),
      renderEmission: new THREE.Color(0.8, 0.6, 0.4),
    },
    halfLengthM: hull.halfLengthM,
    halfBeamM: hull.halfBeamM,
    waterlineLocalY: hull.waterlineLocalY,
    physicsStep: 1 / 240,
    advancePhysics: (context: unknown) => {
      calls.push('vessel.physics');
      physicsContexts.push(context);
    },
    updatePresentation: (context: unknown) => {
      calls.push('vessel.presentation');
      presentationContexts.push(context);
    },
    activeOvertopSprayCount: () => 0,
    resetEffects: () => undefined,
    dispose: () => undefined,
    yaw: 0.3,
    yawRate: 0.04,
    horizontalDynamics: {
      lastAdvance: {
        resistance: {
          rudderAngleRad: 0,
          rudderInflowSpeedMps: 0,
          rudderEffectiveAoaDeg: 0,
          rudderStallFactor: 1,
          rudderDeflectionYawMomentNm: 0,
        },
      },
    },
    snapToSurface: () => calls.push('schooner.snap'),
    resetHorizontalMotion: () => calls.push('schooner.reset'),
    updateRigLoft: (state: {
      trims: RigTrimAnglesRad;
      hoists: Record<SailName, number>;
      cloth?: SailClothState;
    }) => {
      calls.push('schooner.rig');
      // Snapshot the flow: the runtime rewrites the record in place, so
      // holding the live object would make every entry look identical.
      rigStates.push({
        ...state,
        cloth: state.cloth
          ? {
              flow: Object.fromEntries(
                SAILS.map((s) => [s.name, { ...state.cloth!.flow[s.name] }]),
              ) as Record<SailName, SailClothFlow>,
              elapsedSeconds: state.cloth.elapsedSeconds,
              animate: state.cloth.animate,
            }
          : undefined,
      });
    },
  };

  const embodiedEye = new THREE.Vector3();
  const embodiedHead = new THREE.Vector3();
  const cameras = {
    modeName: 'embodied',
    stabilisation: { worldUp: 0, vesselUp: 0 },
    embodied: {
      eyeLocal: embodiedEye,
      headLocal: embodiedHead,
      yaw: 0.45,
    },
    look: { yaw: 0, pitch: 0 },
    setDiagnosticMode: () => calls.push('camera.mode'),
    update: (context: unknown) => {
      calls.push('camera.update');
      cameraContexts.push(context);
    },
  };

  const walkerInputs: unknown[] = [];
  const walkerGravities: unknown[] = [];
  const deckWalker = withWalker
    ? {
        x: 0,
        z: 0,
        placeAt: (x: number, z: number) => {
          calls.push(`walker.place:${x},${z}`);
        },
        eyeY: () => 1.7,
        step: (_dt: number, input: unknown, gravity: unknown) => {
          calls.push('walker.step');
          walkerInputs.push(input);
          walkerGravities.push(gravity);
        },
      }
    : undefined;

  const input: VesselRuntimeInput = {
    pickLow: new THREE.Vector3(),
    pickHigh: new THREE.Vector3(),
    movementAxes: () => {
      calls.push('input.axes');
      return { forward: 0.6, right: -0.25 };
    },
  };
  const world = new PlanetaryWorld({
    worldInstantUtcSeconds: 1_700_000_000,
    latitudeRad: -0.6,
    longitudeRad: 2.4,
    initialCourseRad: 1.1,
    initialSpeedMps: 3,
    voyageSecondsPerRealSecond: 1,
  });
  const waves = {
    originWorldX: 12,
    originWorldZ: -7,
    frameHeading: 0,
    setFrameHeadingDeg(value: number) {
      calls.push('waves.heading');
      this.frameHeading = value;
    },
    sampleHeight: () => 0,
  };
  const wind = {
    direction: new THREE.Vector2(0, -1),
    strength: 0,
    setOceanWind: (heading: number, strength: number) => {
      calls.push('wind.mean');
      wind.direction.set(Math.sin(heading), -Math.cos(heading));
      wind.strength = strength;
    },
  };
  const worldWind = {
    meanSpeedMps: 0,
    meanDirectionTowardDeg: 0,
    gustiness: 0,
    instantaneousSpeedMps: 0,
    instantaneousDirectionTowardDeg: 0,
    gustDirectionOffsetDeg: 0,
    setMean(speedMps: number, directionDeg: number, gustiness: number) {
      calls.push('world-wind.mean');
      this.meanSpeedMps = speedMps;
      this.meanDirectionTowardDeg = directionDeg;
      this.gustiness = gustiness;
      this.instantaneousSpeedMps = speedMps;
      this.instantaneousDirectionTowardDeg = directionDeg;
    },
    advance: () => calls.push('world-wind.advance'),
  };
  const lighting = {
    sunDirection: new THREE.Vector3(0.2, 0.8, -0.4),
    sunLightColor: new THREE.Color(0.9, 0.8, 0.7),
    moonDirection: new THREE.Vector3(-0.3, 0.4, 0.8),
    moonLightColor: new THREE.Color(0.3, 0.4, 0.5),
    ambientRadiance: new THREE.Vector3(0.1, 0.2, 0.3),
    hemisphericRadiance: new THREE.Vector3(0.12, 0.18, 0.24),
  };
  const ocean = {
    setLamp: () => calls.push('ocean.lamp'),
    setVesselOcclusion: (stern: THREE.Vector3, bow: THREE.Vector3) => {
      calls.push('ocean.occlusion');
      occlusionEndpoints.push({
        stern,
        bow,
        sternValue: stern.clone(),
        bowValue: bow.clone(),
      });
    },
    setInteriorCutoutTransform: () => calls.push('ocean.cutout'),
  };
  const trimDegrees = Object.fromEntries(
    Object.entries(AUTHORED_TRIM_RAD).map(([name, radians]) => [
      name,
      (radians * 180) / Math.PI,
    ]),
  ) as Record<keyof RigTrimAnglesRad, number>;
  const hoists = Object.fromEntries(
    SAILS.map((sail) => [sail.name, 1]),
  ) as Record<SailName, number>;
  const initialTrims: Array<{ sail: SailName; degrees: number }> = [];
  const sailingControls = {
    trimDeg: (name: keyof RigTrimAnglesRad) => trimDegrees[name],
    hoistFraction: (name: SailName) => hoists[name],
    setInitialTrimDeg: (sail: SailName, degrees: number) => {
      calls.push('sails.initial-trim');
      initialTrims.push({ sail, degrees });
      trimDegrees[sail as keyof RigTrimAnglesRad] = degrees;
    },
  };
  let frameHeadingDeg = 0;
  const sailForces = {
    get frameHeadingDeg() {
      return frameHeadingDeg;
    },
    set frameHeadingDeg(value: number) {
      calls.push('sails.heading');
      frameHeadingDeg = value;
    },
    lastResult: {
      windage: { forceModelXN: 0, forceModelZN: 0 },
      perSail,
      rollTorqueNm: 0,
      yawMomentNm: 0,
      luffingCount: 0,
    },
  };
  const sailingCrew = {
    trimmers: { cannotDraw: (sail: SailName) => cannotDraw.has(sail) },
  };
  const speedTarget = new VesselSpeedTarget(() => 2.5);
  const runtime = new VesselRuntime({
    vessel,
    schooner: withSchooner ? vessel : undefined,
    sailForces: withSchooner ? sailForces : undefined,
    sailingControls: withSchooner ? sailingControls : undefined,
    sailingCrew: withSchooner ? sailingCrew : undefined,
    cameras,
    deckWalker,
    vesselFraming: {
      points: [],
      widthM: 5,
      heightM: 20,
      lengthM: 16,
      radiusM: 11,
    },
    world,
    waves,
    wind,
    worldWind,
    lighting,
    ocean,
    speedTarget,
    productionEncounterEnabled: production,
    sailClothMode,
    initialTrueHeadingRad: 0.7,
    input: () => input,
    captureContacts: () => calls.push('wake.capture'),
  } as unknown as VesselRuntimeOptions);

  return {
    runtime,
    calls,
    initialTrims,
    physicsContexts,
    presentationContexts,
    cameraContexts,
    rigStates,
    occlusionEndpoints,
    walkerInputs,
    walkerGravities,
    vessel,
    body,
    group,
    cameras,
    deckWalker,
    world,
    waves,
    wind,
    worldWind,
    lighting,
    speedTarget,
    trimDegrees,
    hoists,
    perSail,
    cannotDraw,
  };
}

describe('vessel runtime', () => {
  it('retains stable phase records and presents vessel, walker, then camera', () => {
    const fixture = createFixture({ walker: true });
    const { runtime } = fixture;

    runtime.integrate(0.02, 3);
    runtime.integrate(0.03, 4);
    expect(fixture.calls.slice(0, 4)).toEqual([
      'vessel.physics',
      'wake.capture',
      'vessel.physics',
      'wake.capture',
    ]);
    expect(fixture.physicsContexts).toEqual([
      runtime.physicsContext,
      runtime.physicsContext,
    ]);
    expect(runtime.physicsContext.encounterVelocity).toBe(
      runtime.encounterVelocity,
    );
    expect(runtime.physicsContext.dt).toBe(0.03);
    expect(runtime.physicsContext.elapsed).toBe(4);

    fixture.calls.length = 0;
    fixture.group.rotation.set(0.1, 0.2, -0.3);
    runtime.present(0.04, 5);
    expect(fixture.calls).toEqual([
      'vessel.presentation',
      'vessel.matrix',
      'input.axes',
      'walker.step',
      'body.waterline',
      'camera.update',
    ]);
    expect(fixture.presentationContexts[0]).toBe(
      runtime.presentationContext,
    );
    expect(runtime.presentationContext.sunDirection).toBe(
      fixture.lighting.sunDirection,
    );
    expect(runtime.presentationContext.ambientRadiance).toBe(
      fixture.lighting.ambientRadiance,
    );
    expect(fixture.walkerInputs[0]).toEqual({
      forward: 0.6,
      right: -0.25,
      yaw: 0.45,
    });

    const firstCameraContext = fixture.cameraContexts[0] as {
      dt: number;
      vessel: {
        matrixWorld: THREE.Matrix4;
        pitch: number;
        yaw: number;
        roll: number;
        x: number;
        z: number;
        waterlineY: number;
      };
    };
    expect(firstCameraContext.vessel.matrixWorld).toBe(
      fixture.group.matrixWorld,
    );
    expect(firstCameraContext.vessel).toBe(runtime.cameraAnchor);
    expect(firstCameraContext.vessel).toMatchObject({
      pitch: 0.1,
      yaw: 0.2,
      roll: -0.3,
      x: 0,
      z: 0,
      waterlineY: 4.25,
    });
    runtime.present(0.05, 6);
    expect(fixture.cameraContexts[1]).toBe(firstCameraContext);
    expect(firstCameraContext.dt).toBe(0.05);
    expect(fixture.walkerGravities[1]).toBe(
      fixture.walkerGravities[0],
    );
  });

  it('keeps production integration canonical and preserves captive tow signs', () => {
    const fixture = createFixture({ production: true });
    const { runtime, world, vessel } = fixture;
    const advance = vi.spyOn(world, 'advancePhysicsSeconds');

    runtime.advanceWorldMotion(0.25);
    expect(advance).not.toHaveBeenCalled();
    expect(runtime.horizontalMotionBridge.mode).toBe('free');
    expect(runtime.physicsContext.horizontalMotion).toBe(
      runtime.horizontalMotionBridge,
    );

    runtime.prescribeVesselSpeedMps(4);
    runtime.motionControls.setTrueHeadingRad(0.9);
    runtime.diagnosticTowLeewayRad = 0.2;
    const towIdentity =
      runtime.horizontalMotionBridge.towVelocityWorldMps;
    runtime.advanceWorldMotion(0.25);

    const heading = { x: 0, z: 0 };
    resolveTrueHeadingDirection(world.state, 0.9, heading);
    expect(runtime.horizontalMotionBridge.mode).toBe('captive-tow');
    expect(runtime.horizontalMotionBridge.towVelocityWorldMps).toBe(
      towIdentity,
    );
    expect(towIdentity.x).toBeCloseTo(
      (heading.x * Math.cos(0.2) + heading.z * Math.sin(0.2)) * 4,
    );
    expect(towIdentity.z).toBeCloseTo(
      (heading.z * Math.cos(0.2) - heading.x * Math.sin(0.2)) * 4,
    );
    expect(runtime.horizontalMotionBridge.towYawRad).toBeCloseTo(
      modelYawForVelocity(heading, vessel.yaw),
    );
  });

  it('advances diagnostic world motion before clearing the encounter view', () => {
    const fixture = createFixture({ production: false });
    fixture.runtime.encounterVelocity.x = 9;
    fixture.runtime.encounterVelocity.z = -8;
    let encounterDuringAdvance: { x: number; z: number } | undefined;
    const advance = vi
      .spyOn(fixture.world, 'advancePhysicsSeconds')
      .mockImplementation((physicsDeltaSeconds) => {
        encounterDuringAdvance = {
          x: fixture.runtime.encounterVelocity.x,
          z: fixture.runtime.encounterVelocity.z,
        };
        return {
          physicsDeltaSeconds,
          voyageDeltaSeconds: physicsDeltaSeconds,
          encounterDistanceM: 0,
          distanceTravelledM: 0,
        };
      });

    fixture.runtime.advanceWorldMotion(0.25);

    expect(advance).toHaveBeenCalledWith(0.25, 2.5);
    expect(encounterDuringAdvance).toEqual({ x: 9, z: -8 });
    expect(fixture.runtime.encounterVelocity).toEqual({ x: 0, z: 0 });
    expect(fixture.runtime.physicsContext.horizontalMotion).toBeUndefined();
  });

  it('samples the cue before integration and recomputes panel wind later', () => {
    const fixture = createFixture();
    const cueIdentity = fixture.runtime.presentationContext.apparentWindRender;
    fixture.runtime.encounterVelocity.x = 1;
    fixture.runtime.encounterVelocity.z = -2;

    fixture.runtime.updateFrameNavigationAndWind(0.5, {
      speedMps: 10,
      directionDeg: 40,
      gustiness: 0.3,
    });
    const cueSpeed = Math.hypot(cueIdentity.x, cueIdentity.z);
    expect(fixture.calls.slice(-5)).toEqual([
      'waves.heading',
      'world-wind.mean',
      'world-wind.advance',
      'wind.mean',
      'sails.heading',
    ]);
    const navigationIdentity = fixture.runtime.navigationTelemetry;

    fixture.runtime.encounterVelocity.x = 7;
    fixture.runtime.encounterVelocity.z = 5;
    const telemetry = fixture.runtime.buildWindTelemetry();
    expect(telemetry.apparentSpeedMps).not.toBeCloseTo(cueSpeed);
    fixture.runtime.updateFrameNavigationAndWind(0.25, {
      speedMps: 8,
      directionDeg: 70,
      gustiness: 0.1,
    });
    expect(fixture.runtime.presentationContext.apparentWindRender).toBe(
      cueIdentity,
    );
    expect(fixture.runtime.navigationTelemetry).toBe(navigationIdentity);
  });

  it('publishes cached vessel-axis endpoints through stable scratch objects', () => {
    const fixture = createFixture();
    fixture.group.position.set(10, 20, 30);
    // The composition root previously snapshotted these scalars once.
    fixture.vessel.waterlineLocalY = 100;
    fixture.vessel.halfLengthM = 200;
    fixture.calls.length = 0;

    fixture.runtime.prepareOceanMasks();

    expect(fixture.calls).toEqual([
      'ocean.lamp',
      'vessel.matrix',
      'ocean.occlusion',
      'ocean.cutout',
    ]);
    expect(fixture.occlusionEndpoints[0].sternValue.toArray()).toEqual([
      10, 22, 22,
    ]);
    expect(fixture.occlusionEndpoints[0].bowValue.toArray()).toEqual([
      10, 22, 38,
    ]);
    fixture.runtime.prepareOceanMasks();
    expect(fixture.occlusionEndpoints[1].stern).toBe(
      fixture.occlusionEndpoints[0].stern,
    );
    expect(fixture.occlusionEndpoints[1].bow).toBe(
      fixture.occlusionEndpoints[0].bow,
    );
  });

  /**
   * The legacy raft's occlusion capsule, exercised at last.
   *
   * `SHADOW_ROUND_HANDOVER` lists this as "wired for AO with `DECK_LENGTH/2`
   * and a waterline of local zero, but never actually run". The wiring is real
   * and it does run — `prepareOceanMasks` reads whichever vessel is active, so
   * `?debug=raft` gets the raft's own numbers every frame — but nothing had
   * ever checked that, and the failure it would hide is a quiet one: a raft
   * silently wearing the schooner's 15.5 m capsule would darken a slab of sea
   * four times its own length, and it would look like water, not like a bug.
   *
   * So: exercised rather than deleted, because `?debug=raft` and
   * `?debug=buoyancy` still build her. `Raft` itself cannot be constructed
   * under vitest — `OvertopSpray` reaches for a canvas — so the contract is
   * checked where it is declared and the arithmetic is driven through the real
   * runtime with the raft's real dimensions.
   */
  it('gives the legacy raft its own occlusion capsule, not the schooner\'s', () => {
    const raftSource = readFileSync('src/vessel/raft/Raft.ts', 'utf8');
    expect(raftSource).toContain('readonly halfLengthM = DECK_LENGTH / 2;');
    expect(raftSource).toContain('readonly halfBeamM = DECK_WIDTH / 2;');
    expect(raftSource).toContain('readonly waterlineLocalY = 0;');

    const fixture = createFixture({
      schooner: false,
      hull: {
        halfLengthM: DECK_LENGTH / 2,
        halfBeamM: DECK_WIDTH / 2,
        waterlineLocalY: 0,
      },
    });
    fixture.group.position.set(4, 1, -3);
    fixture.runtime.prepareOceanMasks();

    const { sternValue, bowValue } = fixture.occlusionEndpoints[0];
    // A capsule the length of the raft, lying in her own waterline plane.
    expect(bowValue.z - sternValue.z).toBeCloseTo(DECK_LENGTH, 10);
    expect(sternValue.y).toBeCloseTo(1, 10);
    expect(bowValue.y).toBeCloseTo(1, 10);
    expect(sternValue.x).toBeCloseTo(4, 10);

    // And emphatically not the schooner's, which is what "never run" risked.
    expect(DECK_LENGTH).toBeLessThan(HULL_LENGTH / 4);
    // The radius the composition root feeds alongside it is the raft's beam.
    expect(DECK_WIDTH / 2).toBeLessThan(2.5);
  });

  it('re-lofts once per exact trim change using stable state records', () => {
    const fixture = createFixture();
    fixture.runtime.refreshRigLoft();
    const baselineCount = fixture.rigStates.length;
    fixture.runtime.refreshRigLoft();
    expect(fixture.rigStates).toHaveLength(baselineCount);

    fixture.trimDegrees.mainsail += 1;
    fixture.hoists.foresail = 0.75;
    fixture.runtime.refreshRigLoft();
    fixture.runtime.refreshRigLoft();
    expect(fixture.rigStates).toHaveLength(baselineCount + 1);

    fixture.trimDegrees.jib -= 2;
    fixture.runtime.refreshRigLoft();
    expect(fixture.rigStates).toHaveLength(baselineCount + 2);
    expect(fixture.rigStates.at(-1)!.trims).toBe(
      fixture.rigStates.at(-2)!.trims,
    );
    expect(fixture.rigStates.at(-1)!.hoists).toBe(
      fixture.rigStates.at(-2)!.hoists,
    );
  });

  /**
   * M6 — THE WIRING.
   *
   * Everything else about the cloth is tested against `rigGeometry` directly,
   * which would stay green if the runtime never handed it a cloth state at
   * all. This block is the one that fails if the milestone is disconnected
   * from the ship: the rig round's "verification that silently covers less
   * than it claims" in its purest form.
   */
  describe('the M6 cloth state', () => {
    it('hands the loft the aero’s own per-sail verdict', () => {
      const fixture = createFixture();
      fixture.runtime.refreshRigLoft();
      const cloth = fixture.rigStates.at(-1)!.cloth;
      expect(cloth, 'no cloth state reached the loft').toBeTruthy();
      expect(cloth!.animate).toBe(true);
      for (const sail of SAILS) {
        const source = fixture.perSail.find((s) => s.name === sail.name)!;
        expect(cloth!.flow[sail.name].aoaDeg, sail.name).toBe(source.aoaDeg);
        expect(cloth!.flow[sail.name].apparentSpeedMps, sail.name).toBe(
          source.apparentSpeedMps,
        );
        expect(cloth!.flow[sail.name].blanketFactor, sail.name).toBe(
          source.blanketFactor,
        );
      }
    });

    it('reads the trimmer’s cannot-draw report', () => {
      const fixture = createFixture();
      fixture.runtime.refreshRigLoft();
      expect(fixture.rigStates.at(-1)!.cloth!.flow.foreTopsail.cannotDraw).toBe(false);
      fixture.cannotDraw.add('foreTopsail');
      fixture.runtime.refreshRigLoft();
      expect(fixture.rigStates.at(-1)!.cloth!.flow.foreTopsail.cannotDraw).toBe(true);
    });

    it('leaves a steady rig in a steady breeze costing nothing', () => {
      // S4's cheap-frames property, which naive exact-value comparison on a
      // quantity that moves every substep would have quietly destroyed.
      const fixture = createFixture();
      fixture.runtime.refreshRigLoft();
      const settled = fixture.rigStates.length;
      for (let i = 0; i < 5; i++) fixture.runtime.refreshRigLoft();
      expect(fixture.rigStates).toHaveLength(settled);

      // Under the threshold: still nothing.
      fixture.perSail[0].aoaDeg += 0.1;
      fixture.runtime.refreshRigLoft();
      expect(fixture.rigStates).toHaveLength(settled);

      // Over it: one re-loft, and only one.
      fixture.perSail[0].aoaDeg += 0.5;
      fixture.runtime.refreshRigLoft();
      fixture.runtime.refreshRigLoft();
      expect(fixture.rigStates).toHaveLength(settled + 1);
    });

    it('re-lofts every frame while a sail is actually shaking', () => {
      // The animation cannot be rationed — that was the S4 review's FAULT 2,
      // and a flogging sail that only redraws when the wind changes is a
      // still photograph of a flogging sail.
      const fixture = createFixture();
      fixture.runtime.refreshRigLoft();
      const settled = fixture.rigStates.length;
      fixture.perSail[0].luffing = true;
      fixture.runtime.present(0.016, 1.0);
      fixture.runtime.refreshRigLoft();
      fixture.runtime.present(0.016, 1.016);
      fixture.runtime.refreshRigLoft();
      expect(fixture.rigStates.length).toBe(settled + 2);
      expect(fixture.rigStates.at(-1)!.cloth!.elapsedSeconds).toBeCloseTo(1.016, 6);
      expect(fixture.rigStates.at(-2)!.cloth!.elapsedSeconds).toBeCloseTo(1.0, 6);
    });

    it('gives ?cloth=flat the presentation that shipped, and its quiet frames', () => {
      const fixture = createFixture({ sailClothMode: 'flat' });
      fixture.runtime.refreshRigLoft();
      expect(fixture.rigStates.at(-1)!.cloth).toBeUndefined();
      const settled = fixture.rigStates.length;
      fixture.perSail[0].aoaDeg -= 30;
      fixture.perSail[0].luffing = true;
      fixture.runtime.present(0.016, 2.0);
      fixture.runtime.refreshRigLoft();
      expect(fixture.rigStates).toHaveLength(settled);
    });

    it('reads the cloth arm back off the LOFT, not off the option', () => {
      // The A/B registry's one entry requirement, and the reason 2.6 could not
      // be given a sheet: a switch that reports the value it was handed cannot
      // detect an arm that did not take. These two fields are what the rig is
      // genuinely drawing from — `cloth` is absent only for `flat`, `animate`
      // is true only for `alive` — so the getter is a measurement of the built
      // rig rather than an echo of the request.
      const alive = createFixture();
      expect(alive.runtime.sailClothMode).toBe('alive');
      alive.runtime.refreshRigLoft();
      expect(alive.rigStates.at(-1)!.cloth?.animate).toBe(true);

      const still = createFixture({ sailClothMode: 'still' });
      expect(still.runtime.sailClothMode).toBe('still');

      const flat = createFixture({ sailClothMode: 'flat' });
      expect(flat.runtime.sailClothMode).toBe('flat');
      flat.runtime.refreshRigLoft();
      expect(flat.rigStates.at(-1)!.cloth).toBeUndefined();
    });

    it('gives ?cloth=still the M6 shape with the flogging clock stopped', () => {
      const fixture = createFixture({ sailClothMode: 'still' });
      fixture.runtime.refreshRigLoft();
      const cloth = fixture.rigStates.at(-1)!.cloth;
      expect(cloth, 'still mode still needs a cloth state').toBeTruthy();
      expect(cloth!.animate).toBe(false);
      const settled = fixture.rigStates.length;
      fixture.perSail[0].luffing = true;
      fixture.runtime.present(0.016, 3.0);
      fixture.runtime.refreshRigLoft();
      fixture.runtime.present(0.016, 3.016);
      fixture.runtime.refreshRigLoft();
      expect(fixture.rigStates).toHaveLength(settled);
    });
  });
});
