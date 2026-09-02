import * as THREE from 'three';
import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type WorldLightingAuditCapability = SimCapability<
  | 'cameras'
  | 'refreshLighting'
  | 'refreshWorldLighting'
  | 'renderFrame'
  | 'renderer'
  | 'stepSimulation'
  | 'world'
  | 'worldLightingCoefficients'
  | 'worldLightingDiagnostics'
  | 'worldLightingSourceTarget'
>;
import {
  WORLD_SOURCE_HEIGHT,
  WORLD_SOURCE_WIDTH,
} from '../scene/WorldRadianceSource';

/**
 * The two checks the world lighting cannot make in a unit test.
 *
 * Everything about the diffuse path's arithmetic — the quadrature, the
 * normalisation, the SH reconstruction against a brute-force cosine integral,
 * the three shader-chunk anchors — runs in `tests/world-lighting.test.ts`, in
 * node, with no GPU. What is left over is the part that is a claim about a
 * render target rather than about maths, and that needs a live context.
 *
 * So this is deliberately small: two properties, both of which would be
 * invisible failures.
 *
 *   window.worldLightingAudit()
 */

export interface WorldLightingAuditReport {
  cameraInvariant: boolean;
  checksums: number[];
  maxShDrift: number;
  sourceNonZero: boolean;
  irradianceOrdered: boolean;
  up: number;
  side: number;
  down: number;
  notes: string[];
}

function checksum(sim: WorldLightingAuditCapability, buffer: Uint16Array): number {
  sim.renderer.readRenderTargetPixels(
    sim.worldLightingSourceTarget(),
    0,
    0,
    WORLD_SOURCE_WIDTH,
    WORLD_SOURCE_HEIGHT,
    buffer,
  );
  let h = 2166136261;
  for (let i = 0; i < buffer.length; i++) {
    h ^= buffer[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Freeze the world, move only the camera, and require the light not to move.
 *
 * This is the check that would have caught the defect that started this whole
 * design. The prototype it replaced sampled the sparse cloud cache, whose
 * resident pages are chosen by where the camera looks — so turning your head
 * changed the lighting on the hull. That is not a subtle artefact once you know
 * to look for it and it is nearly invisible if you do not, because a camera
 * turn changes the whole picture anyway.
 */
export function auditWorldLighting(sim: WorldLightingAuditCapability): WorldLightingAuditReport {
  const notes: string[] = [];
  const buffer = new Uint16Array(WORLD_SOURCE_WIDTH * WORLD_SOURCE_HEIGHT * 4);

  const clock = sim.world.state;
  const restoreRate = clock.worldSecondsPerRealSecond;
  const camera = sim.cameras.camera;
  const restorePosition = camera.position.clone();
  const restoreQuaternion = camera.quaternion.clone();

  clock.worldSecondsPerRealSecond = 0;
  sim.refreshLighting();
  for (let i = 0; i < 3; i++) sim.stepSimulation(1 / 60);
  sim.refreshWorldLighting();

  const base = checksum(sim, buffer);
  const baseSh = Array.from(sim.worldLightingCoefficients());

  const positions: Array<[number, number, number]> = [
    [30, 6, 0],
    [0, 6, 30],
    [-30, 6, 0],
    [0, 40, 1],
    [0, 2, -30],
  ];
  const checksums: number[] = [];
  for (const [x, y, z] of positions) {
    camera.position.set(x, y, z);
    camera.lookAt(0, 2, 0);
    camera.updateMatrixWorld();
    sim.renderFrame();
    sim.refreshWorldLighting();
    checksums.push(checksum(sim, buffer));
  }

  let maxShDrift = 0;
  const nowSh = sim.worldLightingCoefficients();
  for (let i = 0; i < nowSh.length; i++) {
    maxShDrift = Math.max(maxShDrift, Math.abs(nowSh[i] - baseSh[i]));
  }

  const cameraInvariant = checksums.every((c) => c === base) && maxShDrift === 0;
  notes.push(
    cameraInvariant
      ? 'Camera-invariant: five camera poses, one source map, zero SH drift.'
      : 'FAIL: the source map or the probe moved when only the camera moved.',
  );

  // A source map of all zeros publishes a black probe, and a black probe looks
  // exactly like a deliberately dark lighting decision. It cost this round a
  // full contact sheet before anyone noticed, so it is asserted here.
  let nonZero = false;
  for (let i = 0; i < buffer.length; i += 4) {
    if (buffer[i] !== 0 || buffer[i + 1] !== 0 || buffer[i + 2] !== 0) {
      nonZero = true;
      break;
    }
  }
  notes.push(nonZero ? 'Source map has signal.' : 'FAIL: source map is entirely zero.');

  const up = sim.worldLightingDiagnostics().up;
  const side = sim.worldLightingDiagnostics().side;
  const down = sim.worldLightingDiagnostics().down;
  // Not a tolerance, a direction: the lower hemisphere is dark water, so a face
  // that sees sky catches more than one that sees sea. If THIS inverts, the
  // equirect convention has flipped somewhere between the shader and the
  // projection.
  //
  // `up >= side` was in here too, and it is NOT an invariant. Measured hourly
  // across a simulated day it fails at three samples of twenty-four — all on
  // the morning limb, at solar elevations of 6, 18 and 30 degrees, where the
  // sun's azimuth lies toward +X and `side` is the +X normal. A vertical face
  // aimed at a low sun collects the circumsolar aureole at cos ~0.9 and the
  // bright horizon band at cos ~1, where a horizontal face gets the first at
  // cos 0.5 and the second at nearly nothing. Measured worst case: up 1.59
  // against side 2.06.
  //
  // That is the sky being shaped like a sky, and the assertion was calling it
  // "FAIL: check the equirect convention" — pointing a future session at a
  // convention bug that does not exist, on a third of the mornings. The ratio
  // is still reported, because it is genuinely interesting; it is just not a
  // pass condition.
  const irradianceOrdered = up >= down && side >= down;
  notes.push(
    irradianceOrdered
      ? `Sky above sea: up ${up.toFixed(3)} / side ${side.toFixed(3)} / down ${down.toFixed(3)}` +
        ` (side/up ${(side / Math.max(up, 1e-9)).toFixed(2)}; above 1 means a low sun on the +X side, not a fault).`
      : `FAIL: a downward face out-collects a sky-facing one (${up.toFixed(3)} / ${side.toFixed(3)} / ${down.toFixed(3)}) — check the equirect convention.`,
  );

  clock.worldSecondsPerRealSecond = restoreRate;
  camera.position.copy(restorePosition);
  camera.quaternion.copy(restoreQuaternion);
  camera.updateMatrixWorld();

  return {
    cameraInvariant,
    checksums,
    maxShDrift,
    sourceNonZero: nonZero,
    irradianceOrdered,
    up,
    side,
    down,
    notes,
  };
}

export function installWorldLightingAudit(sim: WorldLightingAuditCapability): void {
  (window as unknown as Record<string, unknown>).worldLightingAudit = () => {
    const report = auditWorldLighting(sim);
    for (const note of report.notes) console.log(note);
    return report;
  };
}

void THREE;
