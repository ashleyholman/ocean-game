import {
  assertFiniteNumber,
  assertNonNegativeFinite,
  dotVec3,
  isFiniteVec3,
  lengthVec3,
  scaleVec3,
  setVec3,
  vec3,
  type Vec3d,
} from './math';
import {
  DEFAULT_VOYAGE_SECONDS_PER_REAL_SECOND,
  DEFAULT_WORLD_SECONDS_PER_REAL_SECOND,
  WorldClock,
} from './clock';
import {
  GeographicLibGeodesic,
  propagateGeodesicDistance,
  tangentFromCourse,
  type EllipsoidGeodesic,
} from './geodesic';
import type {
  CanonicalWorldSnapshotV1,
  CanonicalWorldState,
  SurfaceFrameEcef,
} from './types';
import {
  createSurfaceFrame,
  ecefToGeodetic,
  ellipsoidEquationResidual,
  frameMaximumResidual,
  geodeticToEcef,
  initialiseSurfaceFrame,
  surfaceNormalEcef,
  type GeodeticCoordinates,
} from './wgs84';

export interface PlanetaryWorldOptions {
  worldInstantUtcSeconds: number;
  latitudeRad: number;
  longitudeRad: number;
  initialCourseRad: number;
  initialSpeedMps: number;
  worldSecondsPerRealSecond?: number;
  paused?: boolean;
  /**
   * Compressed voyage seconds per real second; defaults to honest 1× travel.
   * Live control belongs to the voyage clock (`VoyageClockControl`), which may
   * retune it every frame — this option only sets the starting rate.
   */
  voyageSecondsPerRealSecond?: number;
  /** Physical e-folding time for target-speed control, in real seconds. */
  speedResponseSeconds?: number;
  geodesic?: EllipsoidGeodesic;
}

export interface PhysicsAdvanceResult {
  physicsDeltaSeconds: number;
  voyageDeltaSeconds: number;
  /** Unscaled distance the hull encounters through the local water frame. */
  encounterDistanceM: number;
  /** Distance applied to the global WGS84 voyage after time compression. */
  distanceTravelledM: number;
}

const DEFAULT_SPEED_RESPONSE_REAL_SECONDS = 12;

export class PlanetaryWorld {
  readonly state: CanonicalWorldState;
  private readonly clock: WorldClock;
  private readonly geodesic: EllipsoidGeodesic;
  private currentVoyageSecondsPerRealSecond: number;
  readonly speedResponseSeconds: number;
  /**
   * The voyage geometry this world was constructed with, kept so a restart has
   * a named place to return to. Position, transported frame and velocity only:
   * the clock is not part of it, see `restoreOpeningVoyage`.
   */
  private readonly openingVoyage: {
    positionEcefM: Vec3d;
    velocityEcefMps: Vec3d;
    surfaceFrameEcef: SurfaceFrameEcef;
  };

  constructor(options: PlanetaryWorldOptions) {
    const initialWorldSecondsPerRealSecond =
      options.worldSecondsPerRealSecond ??
      DEFAULT_WORLD_SECONDS_PER_REAL_SECOND;
    const voyageSecondsPerRealSecond =
      options.voyageSecondsPerRealSecond ??
      DEFAULT_VOYAGE_SECONDS_PER_REAL_SECOND;
    assertFiniteNumber(
      options.worldInstantUtcSeconds,
      'worldInstantUtcSeconds',
    );
    assertNonNegativeFinite(options.initialSpeedMps, 'initialSpeedMps');
    assertNonNegativeFinite(
      options.speedResponseSeconds ?? DEFAULT_SPEED_RESPONSE_REAL_SECONDS,
      'speedResponseSeconds',
    );
    assertNonNegativeFinite(
      voyageSecondsPerRealSecond,
      'voyageSecondsPerRealSecond',
    );

    const positionEcefM = vec3();
    geodeticToEcef(
      options.latitudeRad,
      options.longitudeRad,
      0,
      positionEcefM,
    );
    const surfaceFrameEcef = createSurfaceFrame();
    initialiseSurfaceFrame(
      options.latitudeRad,
      options.longitudeRad,
      surfaceFrameEcef,
    );
    tangentFromCourse(
      options.latitudeRad,
      options.longitudeRad,
      options.initialCourseRad,
      TANGENT,
    );

    this.state = {
      worldInstantUtcSeconds: options.worldInstantUtcSeconds,
      worldSecondsPerRealSecond: initialWorldSecondsPerRealSecond,
      paused: options.paused ?? false,
      positionEcefM,
      velocityEcefMps: scaleVec3(
        vec3(),
        TANGENT,
        options.initialSpeedMps,
      ),
      surfaceFrameEcef,
    };
    this.clock = new WorldClock(this.state);
    this.geodesic = options.geodesic ?? new GeographicLibGeodesic();
    this.currentVoyageSecondsPerRealSecond = voyageSecondsPerRealSecond;
    this.speedResponseSeconds =
      options.speedResponseSeconds ?? DEFAULT_SPEED_RESPONSE_REAL_SECONDS;
    this.assertInvariants();
    this.openingVoyage = {
      positionEcefM: vec3(positionEcefM.x, positionEcefM.y, positionEcefM.z),
      velocityEcefMps: vec3(
        this.state.velocityEcefMps.x,
        this.state.velocityEcefMps.y,
        this.state.velocityEcefMps.z,
      ),
      surfaceFrameEcef: {
        right: vec3(
          surfaceFrameEcef.right.x,
          surfaceFrameEcef.right.y,
          surfaceFrameEcef.right.z,
        ),
        forward: vec3(
          surfaceFrameEcef.forward.x,
          surfaceFrameEcef.forward.y,
          surfaceFrameEcef.forward.z,
        ),
        up: vec3(
          surfaceFrameEcef.up.x,
          surfaceFrameEcef.up.y,
          surfaceFrameEcef.up.z,
        ),
      },
    };
  }

  /**
   * Put the vessel back on the position, transported frame and velocity it was
   * created with — the opening voyage — without touching the clock.
   *
   * WHY THE CLOCK IS EXCLUDED. `restoreSnapshot` restores the instant, the
   * calendar rate and the pause flag as well, which is right for a save file
   * and wrong for a restart: the diagnostic caller has usually just pinned all
   * three deliberately (the capture host pauses, sets the rate to zero and
   * then searches for a solar elevation), and a restart that undid that would
   * be fighting its own caller. What a restart owns is where the hull is and
   * how fast it is going.
   *
   * WHY THIS IS NEEDED AT ALL. `advanceTangentMotionStep` moves the vessel
   * along its geodesic on every physics substep and is completely independent
   * of the astronomical clock — pausing the world does not stop the ship. So a
   * harness that stages a scene, settles forty frames and stages it again
   * starts the second staging under way, on a different patch of ocean, with
   * an inherited velocity feeding straight back into the sail forces. Nothing
   * in `resetSimulation` restored it, and no amount of resetting the *hull*
   * could: the canonical voyage is where that state actually lives.
   */
  restoreOpeningVoyage(): void {
    copyInto(this.state.positionEcefM, this.openingVoyage.positionEcefM);
    copyInto(this.state.velocityEcefMps, this.openingVoyage.velocityEcefMps);
    copyInto(
      this.state.surfaceFrameEcef.right,
      this.openingVoyage.surfaceFrameEcef.right,
    );
    copyInto(
      this.state.surfaceFrameEcef.forward,
      this.openingVoyage.surfaceFrameEcef.forward,
    );
    copyInto(
      this.state.surfaceFrameEcef.up,
      this.openingVoyage.surfaceFrameEcef.up,
    );
    this.assertInvariants();
  }

  get voyageSecondsPerRealSecond(): number {
    return this.currentVoyageSecondsPerRealSecond;
  }

  /**
   * Retune voyage-time compression without touching the astronomical clock.
   *
   * Takes effect from the next physics advance; already-covered distance is
   * never replayed. The voyage clock's governor calls this every frame, so it
   * must stay cheap and side-effect free.
   */
  setVoyageSecondsPerRealSecond(voyageSecondsPerRealSecond: number): void {
    assertNonNegativeFinite(
      voyageSecondsPerRealSecond,
      'voyageSecondsPerRealSecond',
    );
    this.currentVoyageSecondsPerRealSecond = voyageSecondsPerRealSecond;
  }

  /**
   * Advance only the astronomical calendar/clock from real elapsed time.
   *
   * This deliberately cannot move the vessel or change its velocity. The
   * world's clock may run at 30x, stop for a lighting inspection, or jump to a
   * new date without replaying thirty voyages or freezing the water physics.
   */
  advanceClockRealSeconds(realDeltaSeconds: number): number {
    const worldDeltaSeconds =
      this.clock.worldDeltaForRealSeconds(realDeltaSeconds);
    this.clock.commitWorldDelta(worldDeltaSeconds);
    return worldDeltaSeconds;
  }

  /**
   * Advance only vessel physics and geodesic travel.
   *
   * `physicsDeltaSeconds` is ordinary elapsed physical time. Speed response and
   * local water encounter use it directly. Global geodesic position uses the
   * separately held voyage-time compression (honest 1× by default; the voyage
   * clock may raise it), so a compressed passage covers more global metres per
   * real second without encountering waves any faster. Astronomical rate/pause
   * controls cannot alter either.
   */
  advancePhysicsSeconds(
    physicsDeltaSeconds: number,
    targetSpeedMps?: number,
  ): PhysicsAdvanceResult {
    assertNonNegativeFinite(physicsDeltaSeconds, 'physicsDeltaSeconds');
    if (targetSpeedMps !== undefined) {
      assertNonNegativeFinite(targetSpeedMps, 'targetSpeedMps');
    }
    if (physicsDeltaSeconds === 0) {
      return {
        physicsDeltaSeconds: 0,
        voyageDeltaSeconds: 0,
        encounterDistanceM: 0,
        distanceTravelledM: 0,
      };
    }

    const startSpeedMps = lengthVec3(this.state.velocityEcefMps);
    let endSpeedMps = startSpeedMps;
    let encounterDistanceM = startSpeedMps * physicsDeltaSeconds;

    if (targetSpeedMps !== undefined) {
      const tau = this.speedResponseSeconds;
      if (tau === 0) {
        endSpeedMps = targetSpeedMps;
        encounterDistanceM = targetSpeedMps * physicsDeltaSeconds;
      } else {
        const decay = Math.exp(-physicsDeltaSeconds / tau);
        endSpeedMps =
          targetSpeedMps + (startSpeedMps - targetSpeedMps) * decay;
        encounterDistanceM =
          targetSpeedMps * physicsDeltaSeconds +
          (startSpeedMps - targetSpeedMps) * tau * (1 - decay);
      }
    }

    if (startSpeedMps === 0 && encounterDistanceM > 0) {
      // A zero vector has no direction. The transported forward axis is the
      // deterministic acceleration direction until an explicit course is set.
      scaleVec3(
        this.state.velocityEcefMps,
        this.state.surfaceFrameEcef.forward,
        Math.max(endSpeedMps, Number.MIN_VALUE),
      );
    }
    const voyageDeltaSeconds =
      physicsDeltaSeconds * this.voyageSecondsPerRealSecond;
    const distanceTravelledM =
      encounterDistanceM * this.voyageSecondsPerRealSecond;
    propagateGeodesicDistance(
      this.state,
      distanceTravelledM,
      this.geodesic,
    );
    this.setSpeedPreservingDirection(endSpeedMps);
    this.assertInvariants();

    return {
      physicsDeltaSeconds,
      voyageDeltaSeconds,
      encounterDistanceM,
      distanceTravelledM,
    };
  }

  /**
   * Commit one force-integrated tangent-plane motion step.
   *
   * The horizontal integrator works in the transported vessel-centred frame,
   * where +right is Three.js +X and +forward is Three.js -Z. It supplies the
   * ordinary-water displacement integrated over this fixed step and the final
   * tangent velocity. This method applies voyage compression to displacement
   * only, transports the canonical frame along that geodesic, and writes the
   * final velocity into the transported frame. No local position is retained.
   */
  advanceTangentMotionStep(
    physicsDeltaSeconds: number,
    encounterRightDisplacementM: number,
    encounterForwardDisplacementM: number,
    endRightMps: number,
    endForwardMps: number,
  ): PhysicsAdvanceResult {
    assertNonNegativeFinite(physicsDeltaSeconds, 'physicsDeltaSeconds');
    assertFiniteNumber(
      encounterRightDisplacementM,
      'encounterRightDisplacementM',
    );
    assertFiniteNumber(
      encounterForwardDisplacementM,
      'encounterForwardDisplacementM',
    );
    assertFiniteNumber(endRightMps, 'endRightMps');
    assertFiniteNumber(endForwardMps, 'endForwardMps');
    if (
      physicsDeltaSeconds === 0 &&
      Math.hypot(
        encounterRightDisplacementM,
        encounterForwardDisplacementM,
      ) > 0
    ) {
      throw new RangeError('a zero-duration motion step cannot displace the vessel');
    }

    const encounterDistanceM = Math.hypot(
      encounterRightDisplacementM,
      encounterForwardDisplacementM,
    );
    const voyageDeltaSeconds =
      physicsDeltaSeconds * this.voyageSecondsPerRealSecond;
    const distanceTravelledM =
      encounterDistanceM * this.voyageSecondsPerRealSecond;

    if (distanceTravelledM > 0) {
      // `propagateGeodesicDistance` follows canonical velocity. Point that
      // temporary tangent along the integrated displacement, then overwrite
      // its magnitude/components with the actual end velocity below.
      this.setTangentVelocityMps(
        encounterRightDisplacementM,
        encounterForwardDisplacementM,
      );
      propagateGeodesicDistance(
        this.state,
        distanceTravelledM,
        this.geodesic,
      );
    }
    this.setTangentVelocityMps(endRightMps, endForwardMps);
    this.assertInvariants();

    return {
      physicsDeltaSeconds,
      voyageDeltaSeconds,
      encounterDistanceM,
      distanceTravelledM,
    };
  }

  /** Set canonical horizontal velocity in the current transported frame. */
  setTangentVelocityMps(rightMps: number, forwardMps: number): void {
    assertFiniteNumber(rightMps, 'rightMps');
    assertFiniteNumber(forwardMps, 'forwardMps');
    const frame = this.state.surfaceFrameEcef;
    this.state.velocityEcefMps.x =
      frame.right.x * rightMps + frame.forward.x * forwardMps;
    this.state.velocityEcefMps.y =
      frame.right.y * rightMps + frame.forward.y * forwardMps;
    this.state.velocityEcefMps.z =
      frame.right.z * rightMps + frame.forward.z * forwardMps;
  }

  setSpeedPreservingDirection(speedMps: number): void {
    assertNonNegativeFinite(speedMps, 'speedMps');
    const currentSpeedMps = lengthVec3(this.state.velocityEcefMps);
    if (speedMps === 0) {
      setVec3(this.state.velocityEcefMps, 0, 0, 0);
      return;
    }
    if (currentSpeedMps === 0) {
      scaleVec3(
        this.state.velocityEcefMps,
        this.state.surfaceFrameEcef.forward,
        speedMps,
      );
      return;
    }
    scaleVec3(
      this.state.velocityEcefMps,
      this.state.velocityEcefMps,
      speedMps / currentSpeedMps,
    );
  }

  /** Explicit steering/debug command. It is never reapplied every frame. */
  setTrueCourseRad(courseRad: number): void {
    assertFiniteNumber(courseRad, 'courseRad');
    const speedMps = lengthVec3(this.state.velocityEcefMps);
    ecefToGeodetic(this.state.positionEcefM, GEODETIC);
    tangentFromCourse(
      GEODETIC.latitudeRad,
      GEODETIC.longitudeRad,
      courseRad,
      TANGENT,
    );
    scaleVec3(this.state.velocityEcefMps, TANGENT, speedMps);
    this.assertInvariants();
  }

  /**
   * Replaces canonical position/frame. Velocity components relative to the
   * carried frame are preserved, so no separate renderer direction is reset.
   */
  teleportGeodeticRadians(latitudeRad: number, longitudeRad: number): void {
    const rightMps = dotVec3(
      this.state.velocityEcefMps,
      this.state.surfaceFrameEcef.right,
    );
    const forwardMps = dotVec3(
      this.state.velocityEcefMps,
      this.state.surfaceFrameEcef.forward,
    );
    geodeticToEcef(
      latitudeRad,
      longitudeRad,
      0,
      this.state.positionEcefM,
    );
    initialiseSurfaceFrame(
      latitudeRad,
      longitudeRad,
      this.state.surfaceFrameEcef,
    );
    this.state.velocityEcefMps.x =
      this.state.surfaceFrameEcef.right.x * rightMps +
      this.state.surfaceFrameEcef.forward.x * forwardMps;
    this.state.velocityEcefMps.y =
      this.state.surfaceFrameEcef.right.y * rightMps +
      this.state.surfaceFrameEcef.forward.y * forwardMps;
    this.state.velocityEcefMps.z =
      this.state.surfaceFrameEcef.right.z * rightMps +
      this.state.surfaceFrameEcef.forward.z * forwardMps;
    this.assertInvariants();
  }

  setWorldInstantUtcSeconds(worldInstantUtcSeconds: number): void {
    this.clock.setCurrentUtcSeconds(worldInstantUtcSeconds);
  }

  setWorldSecondsPerRealSecond(multiplier: number): void {
    this.clock.setWorldSecondsPerRealSecond(multiplier);
  }

  setPaused(paused: boolean): void {
    this.clock.setPaused(paused);
  }

  createSnapshot(): CanonicalWorldSnapshotV1 {
    const state = this.state;
    return {
      version: 1,
      worldInstantUtcSeconds: state.worldInstantUtcSeconds,
      worldSecondsPerRealSecond: state.worldSecondsPerRealSecond,
      paused: state.paused,
      positionEcefM: [
        state.positionEcefM.x,
        state.positionEcefM.y,
        state.positionEcefM.z,
      ],
      velocityEcefMps: [
        state.velocityEcefMps.x,
        state.velocityEcefMps.y,
        state.velocityEcefMps.z,
      ],
      surfaceFrameEcef: {
        right: [
          state.surfaceFrameEcef.right.x,
          state.surfaceFrameEcef.right.y,
          state.surfaceFrameEcef.right.z,
        ],
        forward: [
          state.surfaceFrameEcef.forward.x,
          state.surfaceFrameEcef.forward.y,
          state.surfaceFrameEcef.forward.z,
        ],
        up: [
          state.surfaceFrameEcef.up.x,
          state.surfaceFrameEcef.up.y,
          state.surfaceFrameEcef.up.z,
        ],
      },
    };
  }

  restoreSnapshot(snapshot: CanonicalWorldSnapshotV1): void {
    if (snapshot.version !== 1) {
      throw new RangeError(`Unsupported world snapshot version: ${String(snapshot.version)}`);
    }
    const candidate: CanonicalWorldState = {
      worldInstantUtcSeconds: snapshot.worldInstantUtcSeconds,
      worldSecondsPerRealSecond: snapshot.worldSecondsPerRealSecond,
      paused: snapshot.paused,
      positionEcefM: fromTuple(vec3(), snapshot.positionEcefM),
      velocityEcefMps: fromTuple(vec3(), snapshot.velocityEcefMps),
      surfaceFrameEcef: {
        right: fromTuple(vec3(), snapshot.surfaceFrameEcef.right),
        forward: fromTuple(vec3(), snapshot.surfaceFrameEcef.forward),
        up: fromTuple(vec3(), snapshot.surfaceFrameEcef.up),
      },
    };
    assertCanonicalStateInvariants(candidate);

    this.state.worldInstantUtcSeconds = candidate.worldInstantUtcSeconds;
    this.state.worldSecondsPerRealSecond =
      candidate.worldSecondsPerRealSecond;
    this.state.paused = candidate.paused;
    copyInto(this.state.positionEcefM, candidate.positionEcefM);
    copyInto(this.state.velocityEcefMps, candidate.velocityEcefMps);
    copyInto(
      this.state.surfaceFrameEcef.right,
      candidate.surfaceFrameEcef.right,
    );
    copyInto(
      this.state.surfaceFrameEcef.forward,
      candidate.surfaceFrameEcef.forward,
    );
    copyInto(
      this.state.surfaceFrameEcef.up,
      candidate.surfaceFrameEcef.up,
    );
  }

  assertInvariants(): void {
    assertCanonicalStateInvariants(this.state);
  }
}

function assertCanonicalStateInvariants(
  state: Readonly<CanonicalWorldState>,
): void {
  assertFiniteNumber(
    state.worldInstantUtcSeconds,
    'worldInstantUtcSeconds',
  );
  assertNonNegativeFinite(
    state.worldSecondsPerRealSecond,
    'worldSecondsPerRealSecond',
  );
  if (
    !isFiniteVec3(state.positionEcefM) ||
    !isFiniteVec3(state.velocityEcefMps)
  ) {
    throw new RangeError(
      'Canonical ECEF position and velocity must be finite',
    );
  }
  if (Math.abs(ellipsoidEquationResidual(state.positionEcefM)) > 2e-12) {
    throw new RangeError(
      'Canonical ECEF position is not on WGS84 height zero',
    );
  }
  if (frameMaximumResidual(state.surfaceFrameEcef) > 2e-10) {
    throw new RangeError(
      'Canonical surface frame is not orthonormal/right-handed',
    );
  }
  surfaceNormalEcef(state.positionEcefM, NORMAL);
  if (
    Math.hypot(
      NORMAL.x - state.surfaceFrameEcef.up.x,
      NORMAL.y - state.surfaceFrameEcef.up.y,
      NORMAL.z - state.surfaceFrameEcef.up.z,
    ) > 2e-10
  ) {
    throw new RangeError(
      'Canonical up axis does not match WGS84 normal',
    );
  }
  const speedMps = lengthVec3(state.velocityEcefMps);
  if (
    Math.abs(dotVec3(NORMAL, state.velocityEcefMps)) >
    Math.max(1e-12, speedMps * 5e-11)
  ) {
    throw new RangeError(
      'Canonical ECEF velocity is not surface tangent',
    );
  }
  if (typeof state.paused !== 'boolean') {
    throw new RangeError('Canonical paused state must be boolean');
  }
}

function fromTuple(
  out: { x: number; y: number; z: number },
  tuple: readonly [number, number, number],
): { x: number; y: number; z: number } {
  out.x = tuple[0];
  out.y = tuple[1];
  out.z = tuple[2];
  return out;
}

function copyInto(
  out: { x: number; y: number; z: number },
  value: Readonly<{ x: number; y: number; z: number }>,
): void {
  out.x = value.x;
  out.y = value.y;
  out.z = value.z;
}

const TANGENT = vec3();
const NORMAL = vec3();
const GEODETIC: GeodeticCoordinates = {
  latitudeRad: 0,
  longitudeRad: 0,
  heightM: 0,
};

export function cloneSurfaceFrame(
  frame: Readonly<SurfaceFrameEcef>,
): SurfaceFrameEcef {
  return {
    right: { ...frame.right },
    forward: { ...frame.forward },
    up: { ...frame.up },
  };
}
