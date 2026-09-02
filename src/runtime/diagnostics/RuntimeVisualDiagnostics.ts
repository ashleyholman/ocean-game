import * as THREE from 'three';

import { findSeaState, PRODUCTION_SEA_STATE } from '../../ocean/presets';
import {
  decodeDetailCategoryBuffer,
  formatDetailCategorySummary,
} from '../../render/OceanDetailCategoryProbe';
import {
  decodeResidualCategoryBuffers,
  formatResidualCategorySummary,
} from '../../render/OceanResidualCategoryProbe';
import { OCEAN_PROBE_WARMUP_FRAMES } from '../../render/OceanProfileProbe';
import type { OceanResidualLoopMode } from '../../scene/Ocean';
import type {
  OceanDetailContactSheet,
  OceanDetailContactSheetSet,
  OceanDetailContactSheetView,
} from './SimHandle';
import type {
  RuntimeDiagnostics,
  RuntimeDiagnosticsDependencies,
} from './RuntimeDiagnosticsContract';

export type RuntimeVisualDiagnostics = Pick<
  RuntimeDiagnostics,
  | 'runOceanDetailContactSheet'
  | 'runOceanViolenceEvidence'
  | 'runShapeLadder'
  | 'runFoamGainLadder'
  | 'runOceanCloudHazeContactSheet'
  | 'runWakeContactSheet'
  | 'runWakeWk2ContactSheet'
  | 'runOceanResidualDiff'
  | 'runOceanDetailCategoryProbe'
  | 'runOceanDetailCategoryMatrix'
  | 'runOceanResidualCategoryProbe'
  | 'runOceanResidualCategoryMatrix'
  | 'serviceFrameReadback'
  | 'captureIfRequested'
>;

export function createRuntimeVisualDiagnostics(
  dependencies: RuntimeDiagnosticsDependencies,
): RuntimeVisualDiagnostics {
  const {
    execution,
    renderer,
    canvas,
    ocean,
    waves,
    seaStates,
    cameras,
    lighting,
    quality,
    waitPresentedFrames,
    getSimHandle,
    capturePort,
  } = dependencies;
  let pendingFrameReadback: ((pixels: Uint8Array) => void) | null = null;

  /** Freeze one scene and capture like-for-like detail implementations. */
  async function runOceanDetailContactSheet(
    set: OceanDetailContactSheetSet,
    view: OceanDetailContactSheetView,
    onProgress: (report: string) => void,
  ): Promise<OceanDetailContactSheet> {
    if (execution.active) throw new Error('Ocean component probe is already running');
    const originalSettings = { ...ocean.profileSettings };
    const originalCameraMode = cameras.modeName;
    const originalEmbodiedLook = cameras.look;
    const candidateRows =
      set === 'previous-round'
        ? [
            {
              label: 'E1 · faithful analytic cache · 1024²',
              detailRepresentation: 'cached-1024' as const,
            },
            {
              label: 'E2 · faithful analytic cache · 2048²',
              detailRepresentation: 'cached-2048' as const,
            },
            {
              label: 'F · analytic octaves 0–2 + filtered micro 3–4',
              detailRepresentation: 'hybrid' as const,
            },
          ]
        : [
            {
              label: 'E0.75 · faithful analytic cache · 768²',
              detailRepresentation: 'cached-768' as const,
            },
            {
              label: 'E0.5 · faithful analytic cache · 512²',
              detailRepresentation: 'cached-512' as const,
            },
            {
              label: 'E0.25 · faithful analytic cache · 256²',
              detailRepresentation: 'cached-256' as const,
            },
          ];
    const rows = [
      {
        label: 'A · analytic 5-octave baseline',
        detailRepresentation: 'analytic' as const,
      },
      ...candidateRows,
    ].map((row) => ({
      ...row,
      detailOctaves: quality.detailOctaves,
      detailTextureStyle: 'spectral' as const,
    }));
    const captures: OceanDetailContactSheet['captures'] = [];
    execution.active = true;
    try {
      if (view === 'embodied-down') {
        cameras.setDiagnosticMode('embodied');
        // A literal straight-down look photographs the raft's logs. Turn across
        // the gunwale and keep a steep downward pitch so the frame is dominated
        // by the water within a few metres of the embodied eye instead.
        cameras.look = { yaw: Math.PI / 2, pitch: (-35 * Math.PI) / 180 };
      }
      // Let any outstanding cache work settle at one frozen instant before the
      // first image. Every subsequent shader warm-up also advances with dt=0.
      await waitPresentedFrames(OCEAN_PROBE_WARMUP_FRAMES);
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        onProgress(`contact sheet ${index + 1}/${rows.length}: ${row.label}`);
        ocean.setProfileSettings({
          ...originalSettings,
          detailOctaves: row.detailOctaves,
          detailRepresentation: row.detailRepresentation,
          detailTextureStyle: row.detailTextureStyle,
        });
        await waitPresentedFrames(8);
        captures.push({
          label: row.label,
          dataUrl: canvas.toDataURL('image/jpeg', 0.94),
        });
      }
      const telemetry = cameras.telemetry();
      const cameraDescription =
        telemetry.mode === 'embodied'
          ? `camera embodied / pitch ${telemetry.lookPitchDeg.toFixed(0)}°`
          : `camera ${telemetry.distance.toFixed(0)} m / ${telemetry.altitude.toFixed(1)} m`;
      return {
        title: 'Ocean detail',
        condition:
          `${seaStates.state.name.replaceAll('_', ' ')} · ` +
          `sun ${((lighting.solarElevationRad * 180) / Math.PI).toFixed(1)}° · ` +
          cameraDescription,
        captures,
      };
    } finally {
      ocean.setProfileSettings(originalSettings);
      cameras.look = originalEmbodiedLook;
      cameras.setDiagnosticMode(originalCameraMode);
      await waitPresentedFrames(8);
      execution.active = false;
    }
  }

  /** Photograph and measure the ocean-violence matrix. */
  async function runOceanViolenceEvidence(
    name: string,
    onProgress: (report: string) => void,
  ): Promise<OceanDetailContactSheet> {
    if (execution.active) throw new Error('Ocean component probe is already running');
    execution.active = true;
    try {
      const { captureOceanViolenceEvidence } = await import('../../debug/oceanViolenceContactSheet');
      return await captureOceanViolenceEvidence(getSimHandle(), { name, onProgress });
    } finally {
      execution.active = false;
    }
  }

  /** Photograph the ocean shape ladder for a visual decision. */
  async function runShapeLadder(
    onProgress: (report: string) => void,
  ): Promise<OceanDetailContactSheet> {
    if (execution.active) throw new Error('Ocean component probe is already running');
    execution.active = true;
    try {
      const { captureShapeLadder } = await import('../../debug/oceanViolenceContactSheet');
      return await captureShapeLadder(getSimHandle(), { onProgress });
    } finally {
      execution.active = false;
    }
  }

  /** Photograph the foam coverage gain ladder for a visual decision. */
  async function runFoamGainLadder(
    onProgress: (report: string) => void,
  ): Promise<OceanDetailContactSheet> {
    if (execution.active) throw new Error('Ocean component probe is already running');
    execution.active = true;
    try {
      const { captureFoamGainLadder } = await import('../../debug/oceanViolenceContactSheet');
      return await captureFoamGainLadder(getSimHandle(), { onProgress });
    } finally {
      execution.active = false;
    }
  }

  /** Capture the legacy cloud-in-haze shader beside the stable shipping shader. */
  async function runOceanCloudHazeContactSheet(
    onProgress: (report: string) => void,
  ): Promise<OceanDetailContactSheet> {
    if (execution.active) throw new Error('Ocean component probe is already running');
    execution.active = true;
    try {
      const { captureOceanCloudHazeContactSheet } = await import(
        '../../debug/oceanCloudHazeContactSheet'
      );
      return await captureOceanCloudHazeContactSheet(getSimHandle(), { onProgress });
    } finally {
      execution.active = false;
    }
  }

  /** Capture WK1's reference seas with master/component A/B variants. */
  async function runWakeContactSheet(
    onProgress: (report: string) => void,
  ): Promise<OceanDetailContactSheet> {
    if (execution.active) throw new Error('Ocean component probe is already running');
    execution.active = true;
    try {
      const { captureWakeContactSheet } = await import('../../debug/wakeContactSheet');
      return await captureWakeContactSheet(getSimHandle(), { onProgress });
    } finally {
      execution.active = false;
    }
  }

  /** Deterministic WK2 bow-collar / wet-shell component sheet. */
  async function runWakeWk2ContactSheet(
    onProgress: (report: string) => void,
  ): Promise<OceanDetailContactSheet> {
    if (execution.active) throw new Error('Ocean component probe is already running');
    execution.active = true;
    try {
      const { captureWakeWk2ContactSheet } = await import(
        '../../debug/wakeContactSheet'
      );
      return await captureWakeWk2ContactSheet(getSimHandle(), { onProgress });
    } finally {
      execution.active = false;
    }
  }

  /**
   * Prove the structural residual-loop variants draw the same image as the
   * shipping loop. Freezes the view exactly like the component probe, renders
   * each variant, and reads the frame back. A second shipping capture at the end
   * brackets the run: if anything else in the frame moved between the first
   * capture and the last — a cloud tile swap, a resize — the control row shows
   * a nonzero diff and the variant rows cannot be trusted.
   */
  async function runOceanResidualDiff(
    onProgress: (report: string) => void,
  ): Promise<string> {
    if (execution.active) {
      throw new Error('Ocean component probe is already running');
    }
    const originalSettings = { ...ocean.profileSettings };
    execution.active = true;
    try {
      const rows: { label: string; mode: OceanResidualLoopMode }[] = [
        { label: 'shipping (reference)', mode: 'shipping' },
        { label: 'wavelength active window', mode: 'active' },
        { label: 'branchless selects', mode: 'branchless' },
        { label: 'texelFetch parameters', mode: 'texture' },
        { label: 'dynamic loop bound', mode: 'rolled' },
        { label: 'shipping again (control)', mode: 'shipping' },
      ];
      const captures: {
        label: string;
        width: number;
        height: number;
        pixels: Uint8Array;
      }[] = [];
      for (const row of rows) {
        ocean.setProfileSettings({
          ...originalSettings,
          residualLoopMode: row.mode,
        });
        onProgress(`rendering ${row.label}…`);
        await waitPresentedFrames(4);
        const pixels = await new Promise<Uint8Array>((resolve) => {
          pendingFrameReadback = resolve;
        });
        captures.push({
          label: row.label,
          width: canvas.width,
          height: canvas.height,
          pixels,
        });
      }

      const reference = captures[0];
      const lines = [
        'residual loop structural variants · frozen-frame diff vs shipping',
        `buffer ${reference.width}×${reference.height}`,
        '',
      ];
      let controlChangedPixels = 0;
      for (const capture of captures.slice(1)) {
        if (
          capture.width !== reference.width ||
          capture.height !== reference.height
        ) {
          throw new Error('Frame size changed mid-diff; rerun with fixedDpr');
        }
        const a = reference.pixels;
        const b = capture.pixels;
        const pixelCount = reference.width * reference.height;
        let maxDiff = 0;
        let sumDiff = 0;
        let over0 = 0;
        let over1 = 0;
        let over2 = 0;
        for (let p = 0; p < pixelCount; p++) {
          const o = p * 4;
          // RGB only: alpha is constant and would dilute the mean.
          const dr = Math.abs(a[o] - b[o]);
          const dg = Math.abs(a[o + 1] - b[o + 1]);
          const db = Math.abs(a[o + 2] - b[o + 2]);
          const d = Math.max(dr, dg, db);
          sumDiff += dr + dg + db;
          if (d > maxDiff) maxDiff = d;
          if (d > 0) over0++;
          if (d > 1) over1++;
          if (d > 2) over2++;
        }
        const pct = (count: number) => ((count / pixelCount) * 100).toFixed(4);
        if (capture === captures[captures.length - 1]) {
          controlChangedPixels = over0;
        }
        lines.push(
          capture.label,
          maxDiff === 0
            ? '  identical — every pixel matches the shipping frame exactly'
            : `  mean ${(sumDiff / (pixelCount * 3)).toFixed(5)} LSB · max ${maxDiff}` +
                ` · >0 LSB ${pct(over0)}% (${over0.toLocaleString()} px)` +
                ` · >1 ${pct(over1)}% · >2 ${pct(over2)}%`,
        );
        onProgress(lines.join('\n'));
      }
      lines.push(
        '',
        controlChangedPixels === 0
          ? 'integrity: final shipping control is identical'
          : `integrity: INVALID — final shipping control changed ${controlChangedPixels.toLocaleString()} pixels`,
      );
      return lines.join('\n');
    } finally {
      ocean.setProfileSettings(originalSettings);
      execution.active = false;
    }
  }

  async function readOceanResidualCategoryPass(
    mode: 'a' | 'b',
  ): Promise<Uint8Array> {
    ocean.setResidualCategoryMode(mode);
    // Four presented frames compile the variant and settle Three's program swap.
    await waitPresentedFrames(4);

    const width = canvas.width;
    const height = canvas.height;
    const target = new THREE.WebGLRenderTarget(width, height, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    const diagnosticScene = new THREE.Scene();
    const diagnosticMesh = new THREE.Mesh(ocean.mesh.geometry, ocean.material);
    diagnosticMesh.position.copy(ocean.mesh.position);
    diagnosticMesh.quaternion.copy(ocean.mesh.quaternion);
    diagnosticMesh.scale.copy(ocean.mesh.scale);
    diagnosticMesh.frustumCulled = false;
    diagnosticScene.add(diagnosticMesh);

    const previousTarget = renderer.getRenderTarget();
    const previousClear = renderer.getClearColor(new THREE.Color()).clone();
    const previousClearAlpha = renderer.getClearAlpha();
    const pixels = new Uint8Array(width * height * 4);
    try {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.render(diagnosticScene, cameras.camera);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(previousClear, previousClearAlpha);
      target.dispose();
    }
    return pixels;
  }

  async function readOceanDetailCategoryPass(): Promise<Uint8Array> {
    ocean.setDetailCategoryMode('categories');
    await waitPresentedFrames(4);

    const width = canvas.width;
    const height = canvas.height;
    const target = new THREE.WebGLRenderTarget(width, height, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    const diagnosticScene = new THREE.Scene();
    const diagnosticMesh = new THREE.Mesh(ocean.mesh.geometry, ocean.material);
    diagnosticMesh.position.copy(ocean.mesh.position);
    diagnosticMesh.quaternion.copy(ocean.mesh.quaternion);
    diagnosticMesh.scale.copy(ocean.mesh.scale);
    diagnosticMesh.frustumCulled = false;
    diagnosticScene.add(diagnosticMesh);

    const previousTarget = renderer.getRenderTarget();
    const previousClear = renderer.getClearColor(new THREE.Color()).clone();
    const previousClearAlpha = renderer.getClearAlpha();
    const pixels = new Uint8Array(width * height * 4);
    try {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.render(diagnosticScene, cameras.camera);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(previousClear, previousClearAlpha);
      target.dispose();
    }
    return pixels;
  }

  async function runOceanDetailCategoryProbe(
    onProgress: (report: string) => void,
  ): Promise<string> {
    if (execution.active) throw new Error('Ocean component probe is already running');
    const originalMode = ocean.detailCategoryMode;
    execution.active = true;
    try {
      onProgress('rendering detail octave categories…');
      const pixels = await readOceanDetailCategoryPass();
      const summary = decodeDetailCategoryBuffer(
        pixels,
        canvas.width,
        canvas.height,
        ocean.profileSettings.detailOctaves,
      );
      const report = formatDetailCategorySummary(summary);
      onProgress(report);
      return report;
    } finally {
      ocean.setDetailCategoryMode(originalMode);
      await waitPresentedFrames(4);
      execution.active = false;
    }
  }

  /**
   * Detail work is selected by footprint, not lighting. Measure the complete
   * sea/camera matrix once; daylight/cloud/sunset remain a separate visual matrix.
   */
  async function runOceanDetailCategoryMatrix(
    onProgress: (report: string) => void,
  ): Promise<string> {
    if (execution.active) throw new Error('Ocean component probe is already running');
    const originalMode = ocean.detailCategoryMode;
    const originalSettings = { ...ocean.profileSettings };
    const originalState = seaStates.state;
    const originalCameraMode = cameras.modeName;
    const originalCamera = cameras.telemetry();
    const camerasToMeasure = [
      { label: 'close horizon', distance: 9, altitude: 0.9 },
      { label: 'production medium', distance: 34, altitude: 11 },
      { label: 'maximum high', distance: 1400, altitude: 267 },
    ];
    const seas = [
      { label: 'dead calm', name: 'DEAD_CALM' },
      { label: 'production', name: PRODUCTION_SEA_STATE },
      { label: 'Southern rough', name: 'SOUTHERN_OCEAN_ROUGH' },
    ];
    const scenarios = seas.flatMap((sea) =>
      camerasToMeasure.map((camera) => ({
        seaLabel: sea.label,
        seaName: sea.name,
        cameraLabel: camera.label,
        distance: camera.distance,
        altitude: camera.altitude,
      })),
    );
    const results: Array<{
      label: string;
      summary: ReturnType<typeof decodeDetailCategoryBuffer>;
    }> = [];

    const applyState = (name: string): void => {
      seaStates.set(findSeaState(name), 0);
      waves.applySeaState(seaStates.state, true);
      waves.frozen = seaStates.state.frozen === true;
      ocean.refresh();
    };

    execution.active = true;
    try {
      ocean.setProfileSettings({
        ...originalSettings,
        residualLoopMode: 'active',
        detailOctaves: quality.detailOctaves,
      });
      cameras.setMode('cinematic');
      for (let index = 0; index < scenarios.length; index++) {
        const scenario = scenarios[index];
        applyState(scenario.seaName);
        cameras.setDiagnosticView(scenario.distance, scenario.altitude);
        await waitPresentedFrames(8);
        onProgress(
          `detail category matrix ${index + 1}/${scenarios.length}: ${scenario.seaLabel} · ${scenario.cameraLabel}`,
        );
        const pixels = await readOceanDetailCategoryPass();
        results.push({
          label: `${scenario.seaLabel} · ${scenario.cameraLabel}`,
          summary: decodeDetailCategoryBuffer(
            pixels,
            canvas.width,
            canvas.height,
            quality.detailOctaves,
          ),
        });
      }

      const lines = [
        'detail octave category matrix',
        `buffer ${canvas.width}×${canvas.height} · configured ${quality.detailOctaves}`,
        'mean analytic evaluations · p50 · p95 · max · distribution 0..N',
        '',
        ...results.map(({ label, summary }) =>
          `${label}: ${summary.meanIndividuallyEvaluated.toFixed(2)} · ${summary.individualP50} · ${summary.individualP95} · ${summary.individualMaximum}` +
          ` · ${summary.individualHistogram.join('/')}` +
          ` (ocean ${(summary.oceanCoverage * 100).toFixed(1)}%)`,
        ),
        '',
        results.every(({ summary }) => summary.invalidPixels === 0)
          ? `integrity: every decoded ocean pixel sums to ${quality.detailOctaves} octaves`
          : 'integrity: invalid detail-category pixels detected',
        'lighting note: sun/cloud state changes appearance, not this footprint-driven work count',
      ];
      const report = lines.join('\n');
      onProgress(report);
      return report;
    } finally {
      seaStates.set(originalState, 0);
      waves.applySeaState(seaStates.state, true);
      waves.frozen = seaStates.state.frozen === true;
      ocean.refresh();
      cameras.setMode('cinematic');
      cameras.setDiagnosticView(originalCamera.distance, originalCamera.altitude);
      if (originalCameraMode !== 'cinematic') cameras.setMode(originalCameraMode);
      ocean.setDetailCategoryMode(originalMode);
      ocean.setProfileSettings(originalSettings);
      await waitPresentedFrames(8);
      execution.active = false;
    }
  }

  /**
   * Measure the exact per-fragment category distribution that bounds an ideal
   * residual active window. The ocean is rendered alone into two lossless RGBA8
   * targets, so sky, raft, post-processing and canvas compositing cannot pollute
   * the counts.
   */
  async function runOceanResidualCategoryProbe(
    onProgress: (report: string) => void,
  ): Promise<string> {
    if (execution.active) {
      throw new Error('Ocean component probe is already running');
    }
    const originalMode = ocean.residualCategoryMode;
    execution.active = true;
    try {
      onProgress('rendering residual category pass 1/2…');
      const passA = await readOceanResidualCategoryPass('a');
      onProgress('rendering residual category pass 2/2…');
      const passB = await readOceanResidualCategoryPass('b');
      const summary = decodeResidualCategoryBuffers(
        passA,
        passB,
        canvas.width,
        canvas.height,
      );
      const report = formatResidualCategorySummary(summary);
      onProgress(report);
      return report;
    } finally {
      ocean.setResidualCategoryMode(originalMode);
      await waitPresentedFrames(4);
      execution.active = false;
    }
  }

  /**
   * The handover's required category matrix: horizon-heavy close water, the
   * production composition, and the maximum downward-looking camera, across
   * calm/default/strong seas. State and camera are restored in finally.
   */
  async function runOceanResidualCategoryMatrix(
    onProgress: (report: string) => void,
  ): Promise<string> {
    if (execution.active) {
      throw new Error('Ocean component probe is already running');
    }
    const originalMode = ocean.residualCategoryMode;
    const originalState = seaStates.state;
    const originalCameraMode = cameras.modeName;
    const originalCamera = cameras.telemetry();
    const scenarios = [
      { label: 'dead calm · close horizon', sea: 'DEAD_CALM', distance: 9, altitude: 0.9 },
      { label: 'production · medium', sea: PRODUCTION_SEA_STATE, distance: 34, altitude: 11 },
      { label: 'production · maximum high', sea: PRODUCTION_SEA_STATE, distance: 1400, altitude: 267 },
      { label: 'Southern rough · close horizon', sea: 'SOUTHERN_OCEAN_ROUGH', distance: 9, altitude: 0.9 },
      { label: 'Southern rough · medium', sea: 'SOUTHERN_OCEAN_ROUGH', distance: 34, altitude: 11 },
      { label: 'Southern rough · maximum high', sea: 'SOUTHERN_OCEAN_ROUGH', distance: 1400, altitude: 267 },
    ];
    const results: Array<{
      label: string;
      summary: ReturnType<typeof decodeResidualCategoryBuffers>;
    }> = [];

    const applyState = (name: string): void => {
      seaStates.set(findSeaState(name), 0);
      waves.applySeaState(seaStates.state, true);
      waves.frozen = seaStates.state.frozen === true;
      ocean.refresh();
    };

    execution.active = true;
    try {
      cameras.setMode('cinematic');
      for (let index = 0; index < scenarios.length; index++) {
        const scenario = scenarios[index];
        applyState(scenario.sea);
        cameras.setDiagnosticView(scenario.distance, scenario.altitude);
        await waitPresentedFrames(8);
        onProgress(`category matrix ${index + 1}/${scenarios.length}: ${scenario.label}\npass 1/2…`);
        const passA = await readOceanResidualCategoryPass('a');
        onProgress(`category matrix ${index + 1}/${scenarios.length}: ${scenario.label}\npass 2/2…`);
        const passB = await readOceanResidualCategoryPass('b');
        results.push({
          label: scenario.label,
          summary: decodeResidualCategoryBuffers(passA, passB, canvas.width, canvas.height),
        });
      }

      const lines = [
        'residual category matrix',
        `buffer ${canvas.width}×${canvas.height}`,
        'mean individual slots · p95 · max · theoretical scan reduction',
        '',
        ...results.map(({ label, summary }) =>
          `${label}: ${summary.means.individuallyEvaluated.toFixed(2)} · ${summary.individualP95} · ${summary.individualMaximum}` +
          ` · ${(summary.theoreticalScanReduction * 100).toFixed(1)}%` +
          ` (ocean ${(summary.oceanCoverage * 100).toFixed(1)}%)`,
        ),
        '',
        results.every(({ summary }) => summary.invalidPixels === 0)
          ? 'integrity: every decoded ocean pixel sums to 48 slots'
          : 'integrity: invalid category pixels detected',
      ];
      const report = lines.join('\n');
      onProgress(report);
      return report;
    } finally {
      seaStates.set(originalState, 0);
      waves.applySeaState(seaStates.state, true);
      waves.frozen = seaStates.state.frozen === true;
      ocean.refresh();
      cameras.setMode('cinematic');
      cameras.setDiagnosticView(originalCamera.distance, originalCamera.altitude);
      if (originalCameraMode !== 'cinematic') cameras.setMode(originalCameraMode);
      ocean.setResidualCategoryMode(originalMode);
      await waitPresentedFrames(8);
      execution.active = false;
    }
  }

  /**
   * Read the frame just rendered, in the same task, before the browser
   * composites it away. RGBA8 from the default framebuffer — the same display
   * levels the earlier cache-vs-live diffs were quoted in.
   */
  function serviceFrameReadback(): void {
    if (!pendingFrameReadback) return;
    const resolve = pendingFrameReadback;
    pendingFrameReadback = null;
    const gl = renderer.getContext();
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(
      0,
      0,
      canvas.width,
      canvas.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    resolve(pixels);
  }

  function captureIfRequested(): void {
    // The frame driver also guards this call. Keeping the guard at the owner
    // lets Vite erase the browser-capture body even though the diagnostics
    // facade escapes its factory and cannot be property-tree-shaken.
    if (!import.meta.env.DEV) return;
    const w = window as unknown as {
      __captureName?: string;
      __capturePromise?: Promise<unknown>;
    };
    const pending = w.__captureName;
    if (!pending) return;
    w.__captureName = undefined;
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    out.getContext('2d')?.drawImage(canvas, 0, 0, out.width, out.height);
    w.__capturePromise = new Promise<void>((resolve) => {
      out.toBlob(
        (blob) => {
          if (!blob) return resolve();
          void fetch(`http://127.0.0.1:${capturePort}/shot?name=${pending}`, {
            method: 'POST',
            body: blob,
          }).then(
            () => resolve(),
            () => resolve(),
          );
        },
        'image/jpeg',
        0.92,
      );
    });
  }

  return {
    runOceanDetailContactSheet,
    runOceanViolenceEvidence,
    runShapeLadder,
    runFoamGainLadder,
    runOceanCloudHazeContactSheet,
    runWakeContactSheet,
    runWakeWk2ContactSheet,
    runOceanResidualDiff,
    runOceanDetailCategoryProbe,
    runOceanDetailCategoryMatrix,
    runOceanResidualCategoryProbe,
    runOceanResidualCategoryMatrix,
    serviceFrameReadback,
    captureIfRequested,
  };
}
