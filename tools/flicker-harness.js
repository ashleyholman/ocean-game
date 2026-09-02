/**
 * Ocean shading-aliasing harness.
 *
 * Load in the dev browser with:
 *   fetch('/tools/flicker-harness.js').then(r => r.text()).then(s => (0,eval)(s))
 *
 * It answers one question numerically: how much of what the ocean draws is
 * structure the pixel cannot resolve? Two metres:
 *
 *   speckle — mean |I - box3(I)| over a water region of ONE frame. Shading
 *             finer than a pixel shows up here; smooth shading does not.
 *   flicker — the same high-pass, applied to the DIFFERENCE of two frames a
 *             frame apart with the camera pinned. Coherent motion cancels;
 *             only the incoherent part survives. This is the number that
 *             corresponds to what the eye calls "flickering noise".
 *
 * Both are in display levels (0-255).
 */
(() => {
  const d = window.__drift;
  if (!d) return 'no __drift — is this a dev build?';
  const sim = d.sim;
  const H = (window.H = {});
  H.d = d;
  H.sim = sim;

  // --- staging -------------------------------------------------------------

  H.sunElevation = () => {
    sim.refreshLighting();
    return (Math.asin(Math.max(-1, Math.min(1, d.lighting.sunDirection.y))) * 180) / Math.PI;
  };

  /** Binary-search the canonical instant for a target sun elevation. */
  H.setSunElevation = (targetDeg, descending = true) => {
    const t0 = d.world.state.worldInstantUtcSeconds;
    let bracket = null;
    for (let s = 0; s < 86400; s += 120) {
      d.world.setWorldInstantUtcSeconds(t0 + s);
      const e = H.sunElevation();
      d.world.setWorldInstantUtcSeconds(t0 + s + 120);
      const e2 = H.sunElevation();
      if ((e2 < e) !== descending) continue;
      if ((e - targetDeg) * (e2 - targetDeg) <= 0) { bracket = [t0 + s, t0 + s + 120]; break; }
    }
    if (!bracket) return null;
    let [lo, hi] = bracket;
    for (let i = 0; i < 40; i++) {
      const mid = 0.5 * (lo + hi);
      d.world.setWorldInstantUtcSeconds(mid);
      if ((H.sunElevation() > targetDeg) === descending) lo = mid; else hi = mid;
    }
    d.world.setWorldInstantUtcSeconds(0.5 * (lo + hi));
    sim.stepSimulation(0);
    sim.refreshLighting();
    return H.sunElevation();
  };

  const cam = () => d.cameras.camera;
  H.saveCam = () => ({ p: cam().position.clone(), q: cam().quaternion.clone() });
  H.loadCam = (s) => { cam().position.copy(s.p); cam().quaternion.copy(s.q); cam().updateMatrixWorld(true); };

  H.step = (dt, n = 1) => { for (let i = 0; i < n; i++) sim.stepSimulation(dt); };

  /** Deterministic instant: same wave phase, same foam, same camera, every trial. */
  H.WAVE_TIME = 120;
  H.stage = () => {
    sim.setFoamFrozen(true);
    d.waves.setTime(H.WAVE_TIME);
    const s = H.saveCam();
    sim.stepSimulation(0);
    H.loadCam(s);
  };

  /** Full scene setup: sea state, sun, settled camera. */
  H.setup = async (seaName = 'SOUTHERN_OCEAN_ROUGH', sunDeg = 3.0) => {
    const P = window.__P || (window.__P = await import('/src/ocean/presets.ts'));
    d.world.setPaused(true);
    sim.setSeaState(JSON.parse(JSON.stringify(P.findSeaState(seaName))), 0);
    sim.warmFoam();
    const el = H.setSunElevation(sunDeg, true);
    for (let i = 0; i < 150; i++) sim.stepSimulation(1 / 60);
    H.stage();
    return { sea: seaName, sunElevation: el, canvas: [sim.canvas.width, sim.canvas.height] };
  };

  // --- capture and metrics -------------------------------------------------

  const scratch = document.createElement('canvas');
  const ctx = scratch.getContext('2d', { willReadFrequently: true });

  H.grab = () => {
    sim.renderFrame();
    const c = sim.canvas;
    scratch.width = c.width;
    scratch.height = c.height;
    ctx.drawImage(c, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height);
  };

  /** Fractions of the canvas: [x0, y0, x1, y1]. Clear of the raft and the panels. */
  H.REGION = {
    water: [0.02, 0.60, 0.45, 0.97],
    mid: [0.02, 0.45, 0.55, 0.60],
    all: [0.02, 0.40, 0.55, 0.97],
  };

  const luma = (img, i) => 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];

  H.highFreq = (img, region, img2) => {
    const [fx0, fy0, fx1, fy1] = region;
    const W = img.width, Hh = img.height;
    const x0 = Math.max(1, Math.floor(fx0 * W)), x1 = Math.min(W - 2, Math.floor(fx1 * W));
    const y0 = Math.max(1, Math.floor(fy0 * Hh)), y1 = Math.min(Hh - 2, Math.floor(fy1 * Hh));
    const val = (x, y) => {
      const i = (y * W + x) * 4;
      return img2 ? luma(img2, i) - luma(img, i) : luma(img, i);
    };
    let sum = 0, sumSq = 0, n = 0, peak = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m += val(x + dx, y + dy);
        const r = val(x, y) - m / 9;
        const a = Math.abs(r);
        sum += a; sumSq += r * r; n++;
        if (a > peak) peak = a;
      }
    }
    return { mean: +(sum / n).toFixed(4), rms: +Math.sqrt(sumSq / n).toFixed(4), peak: +peak.toFixed(2), n };
  };

  H.measure = (region = H.REGION.water, dt = 1 / 60) => {
    const a = H.grab();
    const spec = H.highFreq(a, region);
    const s = H.saveCam();
    H.step(dt);
    H.loadCam(s);
    const b = H.grab();
    const flick = H.highFreq(a, region, b);
    return {
      speckle: spec.mean, speckleRms: spec.rms,
      flicker: flick.mean, flickerRms: flick.rms, flickerPeak: flick.peak,
    };
  };

  /** Run a labelled ablation and put every uniform back afterwards. */
  H.trial = (label, apply, restore) => {
    H.stage();
    if (apply) apply();
    const m = H.measure();
    if (restore) restore();
    return Object.assign({ label }, m);
  };

  // --- ocean material ------------------------------------------------------
  H.mat = () => d.ocean.material;
  H.u = () => d.ocean.material.uniforms;
  H.define = (name, on) => {
    const m = H.mat();
    if (on) m.defines[name] = ''; else delete m.defines[name];
    m.needsUpdate = true;
  };

  // --- evidence ------------------------------------------------------------
  H.PORT = 5205;
  H.shot = async (name, crop) => {
    sim.renderFrame();
    const c = sim.canvas;
    const [fx0, fy0, fx1, fy1] = crop ?? [0, 0, 1, 1];
    const x0 = Math.floor(fx0 * c.width), y0 = Math.floor(fy0 * c.height);
    const w = Math.floor((fx1 - fx0) * c.width), h = Math.floor((fy1 - fy0) * c.height);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    out.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, w, h);
    const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
    await fetch(`http://127.0.0.1:${H.PORT}/shot?name=${name}`, { method: 'POST', body: blob });
    return `${name} ${w}x${h}`;
  };

  console.info('[flicker-harness] ready');
  return 'ok';
})()
