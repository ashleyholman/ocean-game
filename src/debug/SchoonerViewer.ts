import type { Schooner } from '../vessel/schooner/Schooner';
import { captureShipContactSheet } from './shipContactSheet';
import type {
  ContactSheetOptions,
  ShipContactSheetCapability,
} from './shipContactSheet';
import { captureHullSealAudit } from './hullSealAudit';
import type { HullSealAuditCapability } from './hullSealAudit';
import { captureShipPaletteSheet } from './shipPaletteSheet';
import type { ShipPaletteSheetCapability } from './shipPaletteSheet';
import { captureRigLayout } from './rigLayoutSheet';
import type { RigLayoutCapability, RigLayoutOptions } from './rigLayoutSheet';
import { installWorldLightingAudit } from './worldLightingAudit';
import type { WorldLightingAuditCapability } from './worldLightingAudit';
import {
  captureWorldLightingSheet,
  captureWorldTermSheet,
} from './worldLightingSheet';
import type {
  WorldLightingSheetCapability,
  WorldLightingSheetOptions,
  WorldTermSheetOptions,
} from './worldLightingSheet';
import type { HullSealAuditOptions } from './hullSealAudit';
import { captureDirectLightOcclusionEvidence } from './directLightOcclusionEvidence';
import type {
  DirectLightOcclusionEvidenceCapability,
  DirectLightOcclusionEvidenceOptions,
} from './directLightOcclusionEvidence';

export type SchoonerViewerCapability =
  ShipContactSheetCapability
  & HullSealAuditCapability
  & ShipPaletteSheetCapability
  & RigLayoutCapability
  & WorldLightingAuditCapability
  & WorldLightingSheetCapability
  & DirectLightOcclusionEvidenceCapability;

/**
 * The thin schooner viewer.
 *
 * This remains deliberately small: it uses the active schooner already built
 * by the scene and drives the canonical contact sheet. Everything else — ocean, sky,
 * lighting, camera, sea states — is the production shell, unchanged, which is
 * the whole reason to host her here. The composition ladder she has to read
 * against is the real one or it is worth nothing.
 *
 *   ?debug=schooner            point the camera at her
 *   ?debug=schooner&sheet=1    …then capture the canonical set and exit-ish
 *
 * The lab gets generalised at M3, when there is something worth stepping
 * through frame by frame.
 */

export interface SchoonerViewerHandle {
  schooner: Schooner;
  /** Capture the canonical contact sheet. Also on `window.schoonerViewer`. */
  contactSheet(options?: ContactSheetOptions): Promise<HTMLCanvasElement>;
  /** Capture the isolated, white-background watertightness audit. */
  sealAudit(options?: HullSealAuditOptions): Promise<HTMLCanvasElement>;
  /** Capture the hull palette comparison under the world lighting. */
  paletteSheet(options?: { name?: string; publish?: boolean }): Promise<HTMLCanvasElement>;
  /** One frozen instant: ship-yaw sweep, camera orbit, sun ladder, with references. */
  lightingSheet(options?: WorldLightingSheetOptions): Promise<HTMLCanvasElement>;
  /** One pose, every per-term debug output. */
  termSheet(options?: WorldTermSheetOptions): Promise<HTMLCanvasElement>;
  /** Capture hull, swell and lantern direct-shadow A/B evidence. */
  occlusionEvidence(
    options?: DirectLightOcclusionEvidenceOptions,
  ): Promise<HTMLCanvasElement>;
  /** Capture the orthographic, unlit sail-plan drawing. */
  rigLayout(options?: RigLayoutOptions): Promise<HTMLCanvasElement>;
  dispose(): void;
}

/**
 * Attach the capture harness to the schooner the game already built.
 *
 * She used to be constructed here, because she was a debug object hosted in the
 * production shell. She is the vessel now — `main.ts` builds her, adds her to
 * the scene and steps her — so this takes her rather than making a second one.
 * Two schooners on one wave field is not a viewer, it is a bug that looks like
 * a rendering artefact.
 */
export function startSchoonerViewer(
  sim: SchoonerViewerCapability,
  schooner: Schooner,
): SchoonerViewerHandle {
  const handle: SchoonerViewerHandle = {
    schooner,
    contactSheet: (options) => captureShipContactSheet(sim, schooner, options),
    sealAudit: (options) => captureHullSealAudit(sim, schooner, options),
    paletteSheet: (options) => captureShipPaletteSheet(sim, schooner, options),
    lightingSheet: (options) => captureWorldLightingSheet(sim, schooner, options),
    termSheet: (options) => captureWorldTermSheet(sim, schooner, options),
    occlusionEvidence: (options) =>
      captureDirectLightOcclusionEvidence(sim, schooner, options),
    rigLayout: (options) => captureRigLayout(sim, schooner, options),
    // The viewer does not own her, so it does not dispose her.
    dispose() {},
  };

  installWorldLightingAudit(sim);

  // Exposed for the console and for capture scripts, as the labs do.
  (window as unknown as Record<string, unknown>).schoonerViewer = {
    schooner,
    stats: schooner.stats,
    contactSheet: handle.contactSheet,
    sealAudit: handle.sealAudit,
    paletteSheet: handle.paletteSheet,
    lightingSheet: handle.lightingSheet,
    termSheet: handle.termSheet,
    occlusionEvidence: handle.occlusionEvidence,
    rigLayout: handle.rigLayout,
    dispose: handle.dispose,
  };

  return handle;
}
