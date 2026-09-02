/**
 * Camera-round evidence harness.
 *
 * Development-only, and deliberately *not* part of the application bundle: it
 * is loaded from the browser console against a running `npm run dev`, drives
 * the same `SimHandle` the buoyancy and ocean labs use, and POSTs finished
 * frames to `tools/capture-server.mjs`.
 *
 *   node tools/capture-server.mjs evidence/camera 5201
 *   # then, in the console at http://127.0.0.1:5173/?capturePort=5201
 *   const cam = await import('/tools/camera-evidence.js');
 *   await cam.install();
 *   await cam.captureMatrix();
 *
 * Every frame is stepped and rendered synchronously in one task, so nothing
 * depends on requestAnimationFrame pacing and a capture cannot silently return
 * the compositor's previous frame.
 */

const RAD = Math.PI / 180;

export async function install() {
  const drift = window.__drift;
  if (!drift) throw new Error('__drift missing — run the dev server, not a production build');
  const presets = await import('/src/ocean/presets.ts');

  const port =
    new URLSearchParams(location.search).get('capturePort') ?? '5199';

  const harness = {
    drift,
    presets,
    port,

    /** The active camera, whichever mode owns it. */
    get camera() {
      return drift.cameras ? drift.cameras.camera : drift.rig.camera;
    },

    /** Pause canonical time so a capture is a still, not a race. */
    freeze() {
      drift.world.setPaused(true);
    },

    setSolar(hours) {
      drift.astronomy.setLocalApparentSolarTime(drift.world, hours);
      drift.sim.refreshLighting();
    },

    setDayOfYear(day) {
      drift.astronomy.setDayOfYearPreservingLocalApparentSolarTime(drift.world, day);
      drift.sim.refreshLighting();
    },

    setSea(name) {
      drift.sim.setSeaState(presets.findSeaState(name), 0);
    },

    /** Advance presentation time in fixed steps. */
    settle(seconds = 5, dt = 1 / 60) {
      const n = Math.max(1, Math.round(seconds / dt));
      for (let i = 0; i < n; i++) drift.sim.stepSimulation(dt);
    },

    /** Restart from a known state, then hold the requested sky. */
    reset({ sea = 'CURRENT_MODERATE', solar = 18.85, settle = 6 } = {}) {
      this.freeze();
      this.setSea(sea);
      this.setSolar(solar);
      drift.sim.resetSimulation(drift.sim.seaStates.state, 0, 0);
      this.setSolar(solar);
      this.settle(settle);
      return this.report();
    },

    /** Measured camera geometry, not assumed. */
    report() {
      const c = this.camera;
      const forward = new (Object.getPrototypeOf(c.position).constructor)();
      c.getWorldDirection(forward);
      const pitch = Math.asin(Math.max(-1, Math.min(1, -forward.y))) / RAD;
      const tanHalf = Math.tan((c.fov * RAD) / 2);
      const horizontal = Math.hypot(c.position.x, c.position.z);
      const info = drift.renderer.info.render;
      return {
        mode: drift.cameras ? drift.cameras.modeName : 'legacy-orbit',
        scale: drift.cameras ? +drift.cameras.cinematicScale.toFixed(4) : null,
        fovV: +c.fov.toFixed(2),
        aspect: +c.aspect.toFixed(3),
        near: c.near,
        far: c.far,
        pos: c.position.toArray().map((v) => +v.toFixed(2)),
        slant: +c.position.length().toFixed(2),
        horizontal: +horizontal.toFixed(2),
        altitude: +c.position.y.toFixed(2),
        elevationDeg: +((Math.atan2(c.position.y, horizontal) / RAD) || 0).toFixed(2),
        opticalPitchDeg: +pitch.toFixed(2),
        horizonFromTop: +(0.5 * (1 - Math.tan(pitch * RAD) / tanHalf)).toFixed(3),
        raftFromTop: this.raftFromTop(),
        raftPixels: this.raftPixelWidth(),
        sea: drift.sim.seaStates.state.name,
        Hs: +drift.waves.significantHeight.toFixed(2),
        crest: +drift.waves.amplitudeSum.toFixed(2),
        dpr: drift.renderer.getPixelRatio(),
        canvas: [drift.renderer.domElement.width, drift.renderer.domElement.height],
        calls: info.calls,
        tris: info.triangles,
      };
    },

    /**
     * Where the raft actually lands, as a fraction of frame height from the
     * top. Measured by projection rather than derived from the composition
     * equations, so a camera that has failed to follow the swell shows up here
     * as the number wandering while `horizonFromTop` sits still.
     */
    raftFromTop() {
      const THREE = drift.THREE;
      if (!THREE) return null;
      const p = new THREE.Vector3(0, 0, 0)
        .applyMatrix4(drift.raft.group.matrixWorld)
        .project(this.camera);
      return +(0.5 * (1 - p.y)).toFixed(3);
    },

    /**
     * The raft's vertical excursion in frame over a span of presentation time:
     * `{ min, max, span }` as fractions of frame height. The regression this
     * exists for is the raft leaving the picture in a high sea, which is
     * invisible in any single still.
     */
    raftSweep(seconds = 30, dt = 1 / 60) {
      const n = Math.max(1, Math.round(seconds / dt));
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < n; i++) {
        drift.sim.stepSimulation(dt);
        const f = this.raftFromTop();
        if (f === null) return null;
        min = Math.min(min, f);
        max = Math.max(max, f);
      }
      return { min: +min.toFixed(3), max: +max.toFixed(3), span: +(max - min).toFixed(3) };
    },

    /** Screen-space width of the raft deck, in device pixels. */
    raftPixelWidth() {
      const THREE = drift.THREE;
      if (!THREE) return null;
      const c = this.camera;
      const a = new THREE.Vector3(-1.1, 0.25, 0).applyMatrix4(drift.raft.group.matrixWorld).project(c);
      const b = new THREE.Vector3(1.1, 0.25, 0).applyMatrix4(drift.raft.group.matrixWorld).project(c);
      return +(Math.abs(a.x - b.x) * 0.5 * drift.renderer.domElement.width).toFixed(1);
    },

    /** Render now and POST the drawing buffer. Same task, so never stale. */
    async shot(name) {
      drift.sim.renderFrame();
      const src = drift.renderer.domElement;
      const out = document.createElement('canvas');
      out.width = src.width;
      out.height = src.height;
      out.getContext('2d').drawImage(src, 0, 0);
      const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.92));
      const response = await fetch(
        `http://127.0.0.1:${this.port}/shot?name=${encodeURIComponent(name)}`,
        { method: 'POST', body: blob },
      );
      return { name, size: `${src.width}x${src.height}`, ok: response.ok };
    },

    /** Frame-rate probe: N stepped renders, wall-clock milliseconds per frame. */
    profile(frames = 90, dt = 1 / 60) {
      // Warm the pipeline so the first compile is not counted.
      for (let i = 0; i < 8; i++) {
        drift.sim.stepSimulation(dt);
        drift.sim.renderFrame();
      }
      const gl = drift.renderer.getContext();
      gl.finish();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        drift.sim.stepSimulation(dt);
        drift.sim.renderFrame();
      }
      gl.finish();
      const ms = (performance.now() - t0) / frames;
      return { msPerFrame: +ms.toFixed(2), fps: +(1000 / ms).toFixed(1), frames };
    },
  };

  window.__cam = harness;
  return harness;
}
