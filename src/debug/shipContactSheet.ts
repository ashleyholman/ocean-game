import { findSeaState } from '../ocean/presets';
import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type ShipContactSheetCapability = SimCapability<
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

export type ShipAimCapability = SimCapability<'lighting'>;
import type { Schooner } from '../vessel/schooner/Schooner';
import { buildContactSheet, grab, post, settleSunElevation, toBlob } from './labCapture';
import type { SheetFrame } from './labCapture';

/**
 * The canonical ship contact sheet.
 *
 * A single screenshot is a claim about one angle in one light on one sea, and
 * every look decision in the M1 round was argued from exactly that. This is the
 * fix: one command, one image, a representative spread — so a reviewer can form
 * a judgement instead of being shown the frame that happened to be on screen.
 *
 * Deterministic by construction. Every shot drives `sim.stepSimulation` and
 * `sim.renderFrame` directly rather than waiting on `requestAnimationFrame`,
 * which a hidden tab throttles to about 1 Hz — the same reason `labCapture`
 * grabs synchronously. Two runs of the same shot list give the same sheet.
 *
 *   node tools/capture-server.mjs        # writes into evidence/
 *   open '…/?debug=schooner&sheet=1'     # captures, posts, done
 *
 * Or from the console at any time: `schoonerViewer.contactSheet()`.
 */

export interface ShipShot {
  label: string;
  /**
   * Which part of her faces the camera.
   *
   * Set by turning the *ship*, not the camera — see `aimShot`. Aspect and
   * lighting are independent axes and the first version of this sheet made them
   * fight over one variable, so half the shots silently came out back-lit.
   */
  aspect: 'broadside' | 'bow quarter' | 'stern quarter';
  /** Slant distance, metres. */
  distance: number;
  /** Target solar elevation, degrees. Negative for night. */
  sunElevationDeg: number;
  /**
   * Where the sun is relative to the camera.
   *
   * `front` puts it behind the viewer lighting the near side, `back` puts it
   * beyond the ship for a silhouette, `cross` puts it abeam so the hull is half
   * lit and half shadowed.
   *
   * The single most important axis in this whole set, and the one the first
   * version left to chance. A low sun *across* the hull leaves the side you are
   * looking at entirely in shadow — which is how three separate "she reads too
   * dark" verdicts got taken during M1 without anyone noticing where the sun
   * was. It is in every label now for exactly that reason.
   */
  sunSide: 'front' | 'cross' | 'back';
  seaState: string;
  /** Simulated seconds to settle before the frame is taken. */
  settleSeconds: number;
}

/**
 * The canonical set.
 *
 * Ten shots, chosen to span the axes that actually change the verdict: what
 * angle she is seen from, how far away, how high the sun is and which side of
 * her it is on, and what the sea is doing. Change this list deliberately — it is
 * the reference a future session will compare against.
 */
export const CANONICAL_SHIP_SHOTS: readonly ShipShot[] = [
  // One viewpoint, four lights. The sun is the only variable, so the comparison
  // is honest and the "is she too dark" question has an actual answer.
  { label: '26 m', aspect: 'broadside', distance: 26, sunElevationDeg: 55, sunSide: 'front', seaState: 'DEAD_CALM', settleSeconds: 8 },
  { label: '26 m', aspect: 'broadside', distance: 26, sunElevationDeg: 14, sunSide: 'front', seaState: 'DEAD_CALM', settleSeconds: 8 },
  { label: '26 m', aspect: 'broadside', distance: 26, sunElevationDeg: 30, sunSide: 'cross', seaState: 'DEAD_CALM', settleSeconds: 8 },
  { label: '26 m', aspect: 'broadside', distance: 26, sunElevationDeg: 14, sunSide: 'back', seaState: 'DEAD_CALM', settleSeconds: 8 },
  // Both ends, lit, so the bow and the transom can be judged rather than guessed.
  { label: '20 m', aspect: 'bow quarter', distance: 20, sunElevationDeg: 35, sunSide: 'front', seaState: 'GLASSY_LONG_SWELL', settleSeconds: 20 },
  { label: '20 m', aspect: 'stern quarter', distance: 20, sunElevationDeg: 35, sunSide: 'front', seaState: 'GLASSY_LONG_SWELL', settleSeconds: 20 },
  // Working weather.
  { label: '30 m · WIND_CHOP', aspect: 'broadside', distance: 30, sunElevationDeg: 30, sunSide: 'cross', seaState: 'WIND_CHOP', settleSeconds: 24 },
  { label: '30 m · MATURE_WIND_SEA', aspect: 'broadside', distance: 30, sunElevationDeg: 25, sunSide: 'front', seaState: 'MATURE_WIND_SEA', settleSeconds: 42 },
  // After the sun. `sunElevationDeg` has always documented "Negative for night"
  // and the canonical set never used it, so every verdict taken off this sheet
  // has been a daylight verdict — including the ones about a hull whose whole
  // material argument is that she reads through sheen rather than through
  // diffuse level. Sheen has nothing to reflect after sunset.
  //
  // These two are also the only guard on lamp/deck parity. The lantern's
  // irradiance on the water and the DirectionalLight that lights the planks are
  // tied together by a measured constant (`OCEAN_PER_DECK_IRRADIANCE` in
  // `Ocean.ts`); anything that rescales the sun re-derives that constant, and
  // without a night frame the drift is invisible until someone happens to sail
  // at night.
  //
  // Dusk is deliberately back-lit: the afterglow behind her is the hardest
  // legibility case in the whole set, and the one a dark hull is most likely to
  // fail. Night sits at −25°, which is where `Lamp.ts` measured its own
  // daylight rolloff anchor, so the two agree about what "dark" means.
  { label: 'dusk', aspect: 'broadside', distance: 26, sunElevationDeg: -4, sunSide: 'back', seaState: 'GLASSY_LONG_SWELL', settleSeconds: 20 },
  { label: 'night · lamp', aspect: 'bow quarter', distance: 20, sunElevationDeg: -25, sunSide: 'front', seaState: 'GLASSY_LONG_SWELL', settleSeconds: 20 },
];

/** Extra yaw applied on top of beam-on, per aspect. */
const ASPECT_YAW: Record<ShipShot['aspect'], number> = {
  broadside: 0,
  'bow quarter': (52 * Math.PI) / 180,
  'stern quarter': (-52 * Math.PI) / 180,
};

/**
 * Place the camera for the lighting and turn the ship for the aspect.
 *
 * The camera orbits to wherever the requested `sunSide` puts it relative to the
 * sun's actual bearing; the ship then yaws so the requested part of her still
 * faces that camera. Two independent controls for two independent things, which
 * is what makes "the same view in three lights" and "both ends, lit" both
 * expressible in one shot list.
 */
export function aimShot(
  sim: ShipAimCapability,
  ship: Schooner,
  shot: ShipShot,
): { azimuth: number; onCameraSide: number; bowToCamera: number } {
  const sun = sim.lighting.sunDirection;
  const horizontal = Math.hypot(sun.x, sun.z) || 1e-6;
  const sx = sun.x / horizontal;
  const sz = sun.z / horizontal;

  // Camera sits in direction (sin az, -cos az) from the ship. Solving that
  // against the sun's bearing puts the sun squarely behind the viewer.
  const frontAzimuth = Math.atan2(sx, -sz);
  const azimuth =
    shot.sunSide === 'front'
      ? frontAzimuth
      : shot.sunSide === 'back'
        ? frontAzimuth + Math.PI
        : frontAzimuth + Math.PI / 2;

  // Beam-on to that camera, plus the aspect's own offset.
  ship.yaw = Math.PI / 2 - azimuth + ASPECT_YAW[shot.aspect];

  const toCamX = Math.sin(azimuth);
  const toCamZ = -Math.cos(azimuth);
  const onCameraSide = sx * toCamX + sz * toCamZ;
  // Her bow in world, for a label that cannot quietly show the wrong end.
  const bowX = Math.sin(ship.yaw);
  const bowZ = Math.cos(ship.yaw);
  const bowToCamera = bowX * toCamX + bowZ * toCamZ;

  return { azimuth, onCameraSide, bowToCamera };
}

export interface ContactSheetOptions {
  shots?: readonly ShipShot[];
  /**
   * Render size for each frame, in pixels.
   *
   * Explicit, and not the window's. A hidden or backgrounded tab collapses the
   * canvas — the first working version of this sheet captured eight frames at
   * **2x2 pixels**, which composes into eight tidy rectangles of flat colour
   * with correct labels underneath. A capture harness that inherits the
   * viewport is a capture harness that silently depends on someone watching it.
   */
  renderWidth?: number;
  renderHeight?: number;
  /** Fraction of the canvas each cell is downsampled to before tiling. */
  frameScale?: number;
  cellWidth?: number;
  columns?: number;
  /** POST the finished sheet to `tools/capture-server.mjs`. */
  publish?: boolean;
  name?: string;
}

/** Capture the sheet. Returns the composed canvas. */
export async function captureShipContactSheet(
  sim: ShipContactSheetCapability,
  ship: Schooner,
  options: ContactSheetOptions = {},
): Promise<HTMLCanvasElement> {
  const shots = options.shots ?? CANONICAL_SHIP_SHOTS;
  const frameScale = options.frameScale ?? 0.5;
  const cinematic = sim.cameras.cinematic;
  const renderWidth = options.renderWidth ?? 1280;
  const renderHeight = options.renderHeight ?? 720;

  // Read the size off the canvas rather than `renderer.getSize`, which wants a
  // Vector2 to write into and this module has no reason to import three for.
  const restorePixelRatio = sim.renderer.getPixelRatio();
  const restoreWidth = sim.renderer.domElement.width / restorePixelRatio;
  const restoreHeight = sim.renderer.domElement.height / restorePixelRatio;

  // Pin the framebuffer for the whole capture. Re-asserted before every frame
  // because the app's own resize handler is still live and will happily put it
  // back if the window changes underneath us.
  const pinSize = (): void => {
    sim.renderer.setPixelRatio(1);
    sim.renderer.setSize(renderWidth, renderHeight, false);
    const aspect = renderWidth / renderHeight;
    sim.cameras.camera.aspect = aspect;
    sim.cameras.camera.updateProjectionMatrix();
    cinematic.setViewport(aspect);
  };
  pinSize();

  // Hold the world still: a contact sheet is a set of controlled comparisons
  // or it is a set of coincidences.
  const clock = sim.world.state;
  const restoreRate = clock.worldSecondsPerRealSecond;
  const restoreInstant = clock.worldInstantUtcSeconds;
  clock.worldSecondsPerRealSecond = 0;

  const frames: SheetFrame[] = [];
  const notes: string[] = [];

  for (const shot of shots) {
    sim.setSeaState(findSeaState(shot.seaState), 0);
    const elevationDeg = settleSunElevation(sim, shot.sunElevationDeg);
    const aim = aimShot(sim, ship, shot);

    cinematic.setDistance(shot.distance);
    ship.body.reset();
    ship.snapToSurface(sim.waves, 0, 0);

    const steps = Math.max(1, Math.round(shot.settleSeconds * 60));
    for (let i = 0; i < steps; i++) {
      // Re-assert the exact diagnostic bearing during the settle.
      cinematic.setAzimuth(aim.azimuth);
      sim.stepSimulation(1 / 60);
    }

    // Rebuild the world probe for THIS shot's sun before drawing it.
    //
    // Not optional, and not merely an optimisation. The whole capture runs as
    // one unbroken synchronous task, so the probe's normal asynchronous readback
    // cannot complete until the sheet is already finished — every shot would be
    // lit by whatever generation was current when the capture began. Ten sun
    // elevations wearing one light, each frame individually believable, and the
    // sheet quietly answering a question nobody asked.
    sim.refreshWorldLighting();

    // Render and grab in the same task, so the pixels belong to this frame.
    pinSize();
    sim.renderFrame();
    frames.push({
      image: grab(sim.canvas, frameScale),
      // The *measured* sun, not the requested one: the search lands on real
      // astronomy and may miss by a degree, and a label that reports the wish
      // rather than the result is how a contact sheet starts lying.
      label: `${shot.aspect} · ${shot.label} · sun ${elevationDeg.toFixed(0)}\u00b0 ${shot.sunSide}`,
    });
    // The lighting the frame was actually taken under, not the lighting we
    // believe it was taken under. Every "she reads too dark" verdict in this
    // project's history was an impression about a picture; these six numbers
    // are what turn the next one into a diagnosis.
    const d = sim.worldLightingDiagnostics();
    notes.push(
      `${shot.aspect} | ${shot.label} | sun ${elevationDeg.toFixed(1)}deg ${shot.sunSide} side ${aim.onCameraSide.toFixed(2)} bow ${aim.bowToCamera.toFixed(2)} | roll ${((ship.body.roll * 180) / Math.PI).toFixed(1)}deg` +
        ` | gen ${d.generation} probe up ${d.up.toFixed(4)} side ${d.side.toFixed(4)} down ${d.down.toFixed(4)}` +
        ` | sunI ${d.sun.toFixed(3)} exposure ${d.exposure.toFixed(3)}`,
    );
  }

  clock.worldSecondsPerRealSecond = restoreRate;
  clock.worldInstantUtcSeconds = restoreInstant;
  sim.refreshLighting();
  sim.renderer.setPixelRatio(restorePixelRatio);
  sim.renderer.setSize(Math.max(restoreWidth, 1), Math.max(restoreHeight, 1), false);

  const sheet = buildContactSheet(frames, {
    columns: options.columns ?? 4,
    cellWidth: options.cellWidth ?? 420,
    title: 'Expedition schooner — canonical set',
    subtitle: `${shots.length} shots · ${ship.stats.drawCalls} draw calls · ${ship.stats.triangles.toLocaleString()} triangles`,
  });

  if (options.publish !== false) {
    const name = options.name ?? 'ship-contact-sheet';
    const ok = await post(`${name}.png`, await toBlob(sheet, 'image/png'));
    if (!ok) {
      // No capture server listening. Fall back to a download so the sheet is
      // never simply lost.
      const url = sheet.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = url;
      link.download = `${name}.png`;
      link.click();
    }
    await post(`${name}.txt`, new Blob([notes.join('\n')], { type: 'text/plain' }));
  }

  return sheet;
}
