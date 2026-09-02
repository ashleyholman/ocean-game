import { findSeaState } from '../ocean/presets';
import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type ShipPaletteSheetCapability = SimCapability<
  | 'cameras'
  | 'canvas'
  | 'lighting'
  | 'refreshLighting'
  | 'refreshWorldLighting'
  | 'renderFrame'
  | 'renderer'
  | 'setSeaState'
  | 'stepSimulation'
  | 'waves'
  | 'world'
  | 'worldLightingDiagnostics'
>;
import type { Schooner } from '../vessel/schooner/Schooner';
import { PALETTE_OPTIONS } from '../vessel/schooner/shipPalettes';
import { buildContactSheet, grab, post, settleSunElevation, toBlob } from './labCapture';
import type { SheetFrame } from './labCapture';

/**
 * The palette sheet: four candidate hulls, three lights, one image.
 *
 * WHY IT IS LAID OUT THIS WAY
 * ---------------------------
 * Palettes across, lighting down. A palette verdict is a comparison between
 * paints, so the paints have to be adjacent — put them on separate rows and the
 * eye is comparing each one against a different neighbour instead. Every cell
 * in a row shares one frozen world instant, one sea state and one camera, so
 * the ONLY thing that differs along a row is the paint.
 *
 * That control is the whole reason this exists. The last palette round was
 * argued from separate screenshots taken at different times under lighting that
 * was itself broken, and the paint took the blame for it. This sheet cannot
 * make that mistake: if two cells in a row differ, it is the paint.
 *
 * The three rows are chosen to span what actually decides a hull's readability:
 * a high front-lit sun (where albedo dominates and a dark hull is at its most
 * legible), a low cross sun (where the shadowed side is most of what you see,
 * and where every "she reads too dark" verdict has historically come from), and
 * a low back-lit sun (silhouette, where paint barely matters and sheen is
 * everything — the control case).
 */

interface PaletteShot {
  label: string;
  sunElevationDeg: number;
  sunSide: 'front' | 'cross' | 'back';
  seaState: string;
  settleSeconds: number;
  distance: number;
}

const PALETTE_SHOTS: readonly PaletteShot[] = [
  { label: 'sun 45° front', sunElevationDeg: 45, sunSide: 'front', seaState: 'GLASSY_LONG_SWELL', distance: 24, settleSeconds: 18 },
  { label: 'sun 20° cross', sunElevationDeg: 20, sunSide: 'cross', seaState: 'GLASSY_LONG_SWELL', distance: 24, settleSeconds: 18 },
  { label: 'sun 12° back', sunElevationDeg: 12, sunSide: 'back', seaState: 'GLASSY_LONG_SWELL', distance: 24, settleSeconds: 18 },
];

/** Bow quarter, so the topsides, the sheer and the transom all read. */
const ASPECT_YAW = (48 * Math.PI) / 180;

export async function captureShipPaletteSheet(
  sim: ShipPaletteSheetCapability,
  ship: Schooner,
  options: { name?: string; publish?: boolean; exposureScale?: number } = {},
): Promise<HTMLCanvasElement> {
  const cinematic = sim.cameras.cinematic;
  const renderWidth = 1280;
  const renderHeight = 720;

  const restorePixelRatio = sim.renderer.getPixelRatio();
  const restoreWidth = sim.renderer.domElement.width / restorePixelRatio;
  const restoreHeight = sim.renderer.domElement.height / restorePixelRatio;

  const pinSize = (): void => {
    sim.renderer.setPixelRatio(1);
    sim.renderer.setSize(renderWidth, renderHeight, false);
    const aspect = renderWidth / renderHeight;
    sim.cameras.camera.aspect = aspect;
    sim.cameras.camera.updateProjectionMatrix();
    cinematic.setViewport(aspect);
  };
  pinSize();

  const clock = sim.world.state;
  const restoreRate = clock.worldSecondsPerRealSecond;
  const restoreInstant = clock.worldInstantUtcSeconds;
  clock.worldSecondsPerRealSecond = 0;

  const frames: SheetFrame[] = [];
  const notes: string[] = [];

  for (const shot of PALETTE_SHOTS) {
    sim.setSeaState(findSeaState(shot.seaState), 0);
    const elevationDeg = settleSunElevation(sim, shot.sunElevationDeg);

    const sun = sim.lighting.sunDirection;
    const horizontal = Math.hypot(sun.x, sun.z) || 1e-6;
    const sx = sun.x / horizontal;
    const sz = sun.z / horizontal;
    const frontAzimuth = Math.atan2(sx, -sz);
    const azimuth =
      shot.sunSide === 'front'
        ? frontAzimuth
        : shot.sunSide === 'back'
          ? frontAzimuth + Math.PI
          : frontAzimuth + Math.PI / 2;
    ship.yaw = Math.PI / 2 - azimuth + ASPECT_YAW;

    cinematic.setDistance(shot.distance);
    ship.body.reset();
    ship.snapToSurface(sim.waves, 0, 0);

    // Settle ONCE per row, then photograph every palette from that identical
    // sea. Re-settling per palette would put each candidate on a different
    // wave, and a hull half a metre lower in the water is a different picture
    // for reasons that have nothing to do with its paint.
    const steps = Math.max(1, Math.round(shot.settleSeconds * 60));
    for (let i = 0; i < steps; i++) {
      cinematic.setAzimuth(azimuth);
      sim.stepSimulation(1 / 60);
    }
    sim.refreshWorldLighting();

    for (const option of PALETTE_OPTIONS) {
      ship.applyPalette(option);
      pinSize();
      // Applied here rather than through the world panel's bias because nothing
      // steps the simulation between the settle and the grab, so the renderer's
      // exposure is not about to be recomputed underneath us. `stepSimulation`
      // would reset it.
      if (options.exposureScale !== undefined) {
        sim.renderer.toneMappingExposure *= options.exposureScale;
      }
      sim.renderFrame();
      frames.push({
        image: grab(sim.canvas, 0.5),
        label: `${option.label} · ${shot.label.replace('°', '°')}`,
      });
    }

    const d = sim.worldLightingDiagnostics();
    notes.push(
      `${shot.label} | measured sun ${elevationDeg.toFixed(1)}deg | probe up ${d.up.toFixed(3)} side ${d.side.toFixed(3)} down ${d.down.toFixed(3)} | sunI ${d.sun.toFixed(3)} exposure ${d.exposure.toFixed(3)}`,
    );
  }

  // Leave her as we found her: this is a comparison tool, not a paint job.
  ship.applyPalette(PALETTE_OPTIONS[0]);

  clock.worldSecondsPerRealSecond = restoreRate;
  clock.worldInstantUtcSeconds = restoreInstant;
  sim.refreshLighting();
  sim.renderer.setPixelRatio(restorePixelRatio);
  sim.renderer.setSize(Math.max(restoreWidth, 1), Math.max(restoreHeight, 1), false);

  const sheet = buildContactSheet(frames, {
    columns: PALETTE_OPTIONS.length,
    cellWidth: 420,
    // No exposure number in the title. It used to read "exposure plateau
    // 0.335", which stopped being true the day the colour pipeline replaced
    // ACES and let one adaptation curve run all day — and a caption that states
    // a number the renderer is not using is worse than no caption, because it
    // is the kind of thing a later reader trusts.
    title:
      options.exposureScale !== undefined && options.exposureScale !== 1
        ? `Hull palette — world lighting, exposure ×${options.exposureScale.toFixed(2)}`
        : 'Hull palette — under world lighting',
    subtitle:
      'Palettes across, light down. One instant and one sea per row: along a row, only the paint changes.',
  });

  if (options.publish !== false) {
    const name = options.name ?? 'ship-palette-sheet';
    const ok = await post(`${name}.png`, await toBlob(sheet, 'image/png'));
    if (!ok) {
      const link = document.createElement('a');
      link.href = sheet.toDataURL('image/png');
      link.download = `${name}.png`;
      link.click();
    }
    await post(`${name}.txt`, new Blob([notes.join('\n')], { type: 'text/plain' }));
  }

  return sheet;
}
