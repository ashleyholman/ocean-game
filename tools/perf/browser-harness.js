/**
 * Browser half of the cross-revision benchmark harness.
 *
 * This file is copied into an archived revision and imported through its Vite
 * dev server. It intentionally talks only to the long-lived `window.__drift`
 * diagnostic contract that already existed at the cloud-cache baseline.
 */

function finite(values) {
  return values.filter((value) => Number.isFinite(value));
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return undefined;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const blend = position - lower;
  return sorted[lower] * (1 - blend) + sorted[upper] * blend;
}

export function summarize(values) {
  const samples = finite(values);
  if (samples.length === 0) {
    return { count: 0, mean: undefined, median: undefined, sd: undefined, p95: undefined };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance =
    samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(samples.length - 1, 1);
  return {
    count: samples.length,
    mean,
    median: quantile(sorted, 0.5),
    sd: Math.sqrt(variance),
    p05: quantile(sorted, 0.05),
    p95: quantile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

function roundSummary(summary) {
  return Object.fromEntries(
    Object.entries(summary).map(([key, value]) => [key, round(value)]),
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDrift(timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (!window.__drift) {
    if (performance.now() > deadline) {
      throw new Error('window.__drift did not appear; the revision may not be running in Vite DEV mode');
    }
    await sleep(50);
  }
  return window.__drift;
}

function rendererIdentity(gl) {
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    vendor: gl.getParameter(gl.VENDOR),
    renderer: gl.getParameter(gl.RENDERER),
    unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : undefined,
    unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : undefined,
    version: gl.getParameter(gl.VERSION),
    shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    timerQueryAvailable: Boolean(gl.getExtension('EXT_disjoint_timer_query_webgl2')),
  };
}

function renderCounts(renderer) {
  const info = renderer.info.render;
  return {
    calls: info.calls,
    triangles: info.triangles,
    lines: info.lines,
    points: info.points,
  };
}

function geometryTelemetry(object) {
  const geometry = object?.geometry;
  if (!geometry) return undefined;
  const indexCount = geometry.index?.count;
  const positionCount = geometry.attributes?.position?.count;
  return {
    indexed: Number.isFinite(indexCount),
    indices: indexCount,
    vertices: positionCount,
    triangles: Number.isFinite(indexCount)
      ? indexCount / 3
      : Number.isFinite(positionCount)
        ? positionCount / 3
        : undefined,
  };
}

function cameraTelemetry(cameras) {
  if (typeof cameras.telemetry !== 'function') return undefined;
  const telemetry = cameras.telemetry();
  return Object.fromEntries(
    Object.entries(telemetry).filter(([, value]) =>
      typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean',
    ),
  );
}

function fenceFactory(gl, canvas, method) {
  const unbindPixelPackBuffer = () => {
    // Three's async render-target readback leaves its PIXEL_PACK_BUFFER bound
    // while awaiting a fence. A synchronous readPixels with an ArrayBufferView
    // is otherwise redirected into that PBO and returns immediately, silently
    // defeating this benchmark's GPU fence. WorldLighting.readSourceSync uses
    // the same unbind for the same reason.
    if (typeof gl.bindBuffer === 'function' && 'PIXEL_PACK_BUFFER' in gl) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
  };
  if (method === 'full-frame') {
    let pixels = new Uint8Array(canvas.width * canvas.height * 4);
    return () => {
      const required = canvas.width * canvas.height * 4;
      if (pixels.length !== required) pixels = new Uint8Array(required);
      unbindPixelPackBuffer();
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    };
  }
  const pixel = new Uint8Array(4);
  return () => {
    unbindPixelPackBuffer();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  };
}

function setVisible(target, visible) {
  if (!target) return;
  target.visible = visible;
}

function getVisible(target) {
  return target ? target.visible !== false : undefined;
}

function activeVesselTarget(drift) {
  const activeVessel = drift.vessel?.group;
  if (activeVessel && activeVessel.parent) return activeVessel;
  const schooner = typeof drift.scene?.getObjectByName === 'function'
    ? drift.scene.getObjectByName('schooner')
    : undefined;
  if (schooner) return schooner;
  const ship = typeof drift.scene?.getObjectByName === 'function'
    ? drift.scene.getObjectByName('ship')
    : undefined;
  if (ship) return ship;
  const raft = drift.raft?.group;
  if (raft && raft.parent) return raft;
  return undefined;
}

function warmRenders(sim, render, frames) {
  for (let index = 0; index < frames; index++) render();
}

function measureBatch(render, fence, frames) {
  fence();
  const started = performance.now();
  for (let frame = 0; frame < frames; frame++) render();
  fence();
  return (performance.now() - started) / frames;
}

function measureTotal(render, fence, measurement) {
  const samples = [];
  for (let batch = 0; batch < measurement.totalBatches; batch++) {
    samples.push(measureBatch(render, fence, measurement.framesPerBatch));
  }
  return {
    unit: 'ms/frame',
    method: `wall clock around synchronous render batches fenced by ${measurement.fence} readPixels`,
    framesPerBatch: measurement.framesPerBatch,
    samples: samples.map((value) => round(value)),
    summary: roundSummary(summarize(samples)),
  };
}

function measurePairedToggle({
  name,
  target,
  render,
  fence,
  measurement,
}) {
  if (!target) return { available: false, reason: `${name} visibility target unavailable` };
  const original = getVisible(target);
  const enabledSamples = [];
  const disabledSamples = [];
  const deltas = [];

  // Compile and populate both paths before the adjacent pairs begin.
  for (const visible of [true, false, true]) {
    setVisible(target, visible);
    warmRenders(null, render, Math.max(4, measurement.toggleWarmFrames));
    fence();
  }

  try {
    for (let pair = 0; pair < measurement.attributionPairs; pair++) {
      const order = pair % 2 === 0 ? [true, false] : [false, true];
      const pairValues = new Map();
      for (const visible of order) {
        setVisible(target, visible);
        warmRenders(null, render, measurement.toggleWarmFrames);
        const value = measureBatch(render, fence, measurement.attributionFrames);
        pairValues.set(visible, value);
        (visible ? enabledSamples : disabledSamples).push(value);
      }
      deltas.push(pairValues.get(true) - pairValues.get(false));
    }
  } finally {
    setVisible(target, original);
    warmRenders(null, render, measurement.toggleWarmFrames);
    fence();
  }

  return {
    available: true,
    unit: 'ms/frame',
    interpretation: 'paired enabled minus disabled full-frame cost; shared GPU drift cancels within each adjacent pair',
    framesPerState: measurement.attributionFrames,
    enabledSamples: enabledSamples.map((value) => round(value)),
    disabledSamples: disabledSamples.map((value) => round(value)),
    pairedDeltaSamples: deltas.map((value) => round(value)),
    enabled: roundSummary(summarize(enabledSamples)),
    disabled: roundSummary(summarize(disabledSamples)),
    pairedDelta: roundSummary(summarize(deltas)),
  };
}

function measureVesselIsolated({
  oceanTarget,
  vesselTarget,
  render,
  fence,
  measurement,
}) {
  if (!oceanTarget) {
    return { available: false, reason: 'ocean visibility target unavailable' };
  }
  const originalOcean = getVisible(oceanTarget);
  try {
    // With the ocean absent, hiding the vessel does not reveal expensive water
    // fragments. The paired delta therefore measures vessel/shadow draw work
    // rather than the net cost after the vessel's screen-space occlusion win.
    setVisible(oceanTarget, false);
    warmRenders(null, render, Math.max(4, measurement.toggleWarmFrames));
    fence();
    const result = measurePairedToggle({
      name: 'isolated vessel',
      target: vesselTarget,
      render,
      fence,
      measurement,
    });
    if (result.available) {
      result.interpretation =
        'paired vessel enabled minus disabled cost with ocean hidden; isolates vessel and its shadow work from ocean-pixel occlusion';
    }
    return result;
  } finally {
    setVisible(oceanTarget, originalOcean);
    warmRenders(null, render, measurement.toggleWarmFrames);
    fence();
  }
}

function measureVesselOnly({
  scene,
  vesselTarget,
  render,
  fence,
  measurement,
}) {
  if (!scene?.children || !vesselTarget) {
    return { available: false, reason: 'scene or vessel target unavailable' };
  }
  const visibility = scene.children.map((child) => [child, child.visible]);
  try {
    // Render only the vessel and lights. Unlike a sky/ocean-backed A/B, the
    // disabled state reveals only the clear buffer, so no expensive background
    // fragments can turn real vessel work into a misleading negative delta.
    for (const child of scene.children) {
      child.visible = child === vesselTarget || child.isLight === true;
    }
    warmRenders(null, render, Math.max(4, measurement.toggleWarmFrames));
    fence();
    const result = measurePairedToggle({
      name: 'vessel-only scene',
      target: vesselTarget,
      render,
      fence,
      measurement,
    });
    if (result.available) {
      result.interpretation =
        'paired vessel enabled minus disabled cost in a vessel-and-lights-only scene; direct vessel and shadow draw work';
    }
    return result;
  } finally {
    for (const [child, visible] of visibility) child.visible = visible;
    warmRenders(null, render, measurement.toggleWarmFrames);
    fence();
  }
}

async function setScenario(drift, presets, scenario, config) {
  const { sim, world, cameras, renderer, waves } = drift;
  const state = presets.findSeaState(scenario.seaState);

  world.setPaused(true);
  if (world.state) world.state.worldSecondsPerRealSecond = 0;
  if (typeof sim.resetSimulation === 'function') sim.resetSimulation(state, 0, 0);
  else if (typeof sim.setSeaState === 'function') sim.setSeaState(state, 0);

  world.setWorldInstantUtcSeconds(
    config.baseWorldUtcSeconds + scenario.timeOffsetHours * 3600,
  );
  world.setPaused(true);
  sim.refreshLighting();
  if (typeof sim.refreshWorldLighting === 'function') sim.refreshWorldLighting();

  if (typeof cameras.setDiagnosticMode === 'function') cameras.setDiagnosticMode('cinematic');
  else if (typeof cameras.setMode === 'function') cameras.setMode('cinematic');
  cameras.setDiagnosticView(scenario.camera.distanceM, scenario.camera.altitudeM);

  for (let frame = 0; frame < config.measurement.stateSettleFrames; frame++) {
    sim.stepSimulation(1 / 60);
    sim.renderFrame();
  }

  // Populate staged cloud generations and warm every shader while canonical
  // time remains paused. Presentation state is frozen after this stage.
  for (let frame = 0; frame < config.measurement.warmFrames; frame++) {
    sim.stepSimulation(1 / 60);
    sim.renderFrame();
  }

  world.setPaused(true);
  if (waves) waves.frozen = true;
  if (typeof sim.setFoamFrozen === 'function') sim.setFoamFrozen(true);
  sim.stepSimulation(0);
  sim.renderFrame();

  const gl = renderer.getContext();
  const solarElevationDeg = drift.lighting?.solarElevationRad === undefined
    ? undefined
    : drift.lighting.solarElevationRad * 180 / Math.PI;
  return {
    requested: scenario,
    actual: {
      worldInstantUtcSeconds: world.state?.worldInstantUtcSeconds,
      worldPaused: world.state?.paused,
      solarElevationDeg: round(solarElevationDeg),
      seaState: drift.sim.seaStates?.state?.name ?? drift.seaStates?.state?.name ?? scenario.seaState,
      camera: cameraTelemetry(cameras),
      drawingBuffer: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
      pixelRatio: renderer.getPixelRatio(),
    },
  };
}

export async function run(config) {
  const drift = await waitForDrift();
  // Quality selection happens during app bootstrap, before this harness sizes
  // the renderer to the exact measured surface. Preserve that initial viewport
  // so a revision cannot silently choose its mobile geometry tier.
  const bootstrapViewport = {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    devicePixelRatio: window.devicePixelRatio,
  };
  const presets = await import('/src/ocean/presets.ts');
  const { renderer, sim, world, cameras } = drift;
  renderer.setAnimationLoop(null);
  world.setPaused(true);

  const surface = config.renderSurface;
  renderer.setPixelRatio(surface.dpr);
  renderer.setSize(surface.cssWidth, surface.cssHeight, false);
  if (typeof cameras.setViewport === 'function') {
    cameras.setViewport(surface.cssWidth, surface.cssHeight);
  }
  const gl = renderer.getContext();
  if (
    gl.drawingBufferWidth !== surface.backingWidth ||
    gl.drawingBufferHeight !== surface.backingHeight
  ) {
    throw new Error(
      `drawing buffer is ${gl.drawingBufferWidth}×${gl.drawingBufferHeight}; ` +
      `expected ${surface.backingWidth}×${surface.backingHeight}`,
    );
  }

  const fence = fenceFactory(gl, renderer.domElement, config.measurement.fence);
  const render = () => sim.renderFrame();
  const scenarios = [];

  for (const scenario of config.scenarios) {
    const state = await setScenario(drift, presets, scenario, config);
    fence();
    renderer.info.reset();
    render();
    fence();
    const fullSceneCounts = renderCounts(renderer);
    const total = measureTotal(render, fence, config.measurement);
    const attribution = {};

    if (scenario.attribution) {
      const vesselTarget = activeVesselTarget(drift);
      attribution.vesselTarget = {
        available: Boolean(vesselTarget),
        name: vesselTarget?.name || 'raft',
        activeInScene: Boolean(vesselTarget?.parent),
      };
      attribution.ocean = measurePairedToggle({
        name: 'ocean',
        target: drift.ocean?.mesh,
        render,
        fence,
        measurement: config.measurement,
      });
      attribution.vessel = measurePairedToggle({
        name: 'vessel',
        target: vesselTarget,
        render,
        fence,
        measurement: config.measurement,
      });
      attribution.vesselIsolated = measureVesselIsolated({
        oceanTarget: drift.ocean?.mesh,
        vesselTarget,
        render,
        fence,
        measurement: config.measurement,
      });
      attribution.vesselOnly = measureVesselOnly({
        scene: drift.scene,
        vesselTarget,
        render,
        fence,
        measurement: config.measurement,
      });
    }

    scenarios.push({
      id: scenario.id,
      label: scenario.label,
      historicalReferenceMs: scenario.historicalReferenceMs,
      state,
      total,
      attribution,
      rendererInfo: { fullScene: fullSceneCounts },
    });
  }

  renderer.setAnimationLoop(null);
  world.setPaused(true);
  return {
    schemaVersion: 1,
    harnessVersion: '1.0.0',
    measuredAt: new Date().toISOString(),
    suite: config.suite,
    method: {
      gpuFence: `${config.measurement.fence} readPixels`,
      pixelPackBufferUnboundBeforeFence: true,
      glFinishUsed: false,
      canonicalWorldTimePaused: true,
      presentationFrozenDuringSamples: true,
      backingStoreVerified: true,
    },
    environment: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      documentHidden: document.hidden,
      renderer: rendererIdentity(gl),
      drawingBuffer: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
      pixelRatio: renderer.getPixelRatio(),
      bootstrapViewport,
      oceanGeometry: geometryTelemetry(drift.ocean?.mesh),
    },
    config,
    scenarios,
  };
}
