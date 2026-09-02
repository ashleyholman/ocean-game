/**
 * Cloud-evidence harness.
 *
 * Development-only, and deliberately *not* part of the application bundle: it
 * is loaded from the browser console against a running `npm run dev`, drives
 * the same `SimHandle` the other labs use, and POSTs finished frames to
 * `tools/capture-server.mjs`.
 *
 *   node tools/capture-server.mjs evidence/clouds 5202
 *   # then, in the console at http://127.0.0.1:<devport>/?capturePort=5202
 *   const cl = await import('/tools/cloud-evidence.js');
 *   await cl.install();
 *   await cl.matrix('before');
 *
 * WHY IT AIMS RELATIVE TO THE SUN. Cloud volume is a lighting phenomenon:
 * a cumulus field is a silhouette toward the sun, a lit relief across it, and
 * a wall of bright faces away from it. A capture matrix pinned to compass
 * directions compares different clouds under different light every run; one
 * pinned to the sun's azimuth compares the same three lighting geometries at
 * every hour, which is the only way an A/B of the FIELD means anything.
 *
 * The cloud drift offset is zeroed and canonical time frozen before every
 * shot, so "before" and "after" look at the same clouds — the field is a pure
 * function of position, and the offset is the only thing that moves it.
 */

const RAD = Math.PI / 180;

/** Elevation of the view centre, and the vertical field of view, per view. */
const VIEWS = [
  { name: 'sunward', az: 0, el: 18, fov: 46 },
  { name: 'cross', az: 90, el: 22, fov: 46 },
  { name: 'anti', az: 180, el: 20, fov: 46 },
  { name: 'zenith', az: 45, el: 52, fov: 60 },
];

/** Solar hours worth a picture, and what each is for. */
const HOURS = [
  { name: 'midday', solar: 12.0 },
  { name: 'afternoon', solar: 15.5 },
  { name: 'golden', solar: 18.2 },
  { name: 'sunset', solar: 18.85 },
];

export async function install() {
  const drift = window.__drift;
  if (!drift) throw new Error('__drift missing — run the dev server, not a production build');
  const THREE = drift.THREE;
  const port = new URLSearchParams(location.search).get('capturePort') ?? '5199';

  const camera = new THREE.PerspectiveCamera(46, 1.6, 0.1, 25000);

  const harness = {
    drift,
    port,
    camera,

    freeze() {
      drift.world.setPaused(true);
    },

    /**
     * Stop the render loop so the canvas holds whatever `show()` last drew.
     * Without this the production camera repaints over the sky view before
     * anyone can look at it, and every inspection screenshots the game.
     */
    hold() {
      drift.renderer.setAnimationLoop(null);
      this.freeze();
      return this;
    },

    /** Aim, render, and leave it on screen. Pairs with `hold()`. */
    show(azFromSun, el, fov = 46) {
      this.pinClouds();
      this.aim(azFromSun, el, fov);
      drift.renderer.render(drift.scene, camera);
      return { sunElevationDeg: this.sunElevationDeg(), azFromSun, el, fov };
    },

    setSolar(hours) {
      drift.astronomy.setLocalApparentSolarTime(drift.world, hours);
      drift.sim.refreshLighting();
    },

    /** Sun azimuth in radians, measured the same way the camera yaw is. */
    sunAzimuth() {
      const s = drift.lighting.sunDirection;
      return Math.atan2(s.x, s.z);
    },

    sunElevationDeg() {
      return +(drift.lighting.solarElevationRad / RAD).toFixed(2);
    },

    /**
     * Aim at `az` degrees from the sun's azimuth (0 = into the sun) and `el`
     * degrees above the horizon. Eye height is the production camera's, so the
     * horizon sits where the game puts it.
     */
    aim(azFromSun, el, fov) {
      const yaw = this.sunAzimuth() + azFromSun * RAD;
      const pitch = el * RAD;
      const eye = drift.cameras.camera.position;
      camera.position.copy(eye);
      camera.fov = fov;
      camera.aspect = drift.renderer.domElement.width / drift.renderer.domElement.height;
      camera.updateProjectionMatrix();
      camera.up.set(0, 1, 0);
      camera.lookAt(
        eye.x + Math.sin(yaw) * Math.cos(pitch),
        eye.y + Math.sin(pitch),
        eye.z + Math.cos(yaw) * Math.cos(pitch),
      );
      return this;
    },

    /**
     * Hold the cloud field still: same clouds in every run of the matrix.
     *
     * The whole clock, not only the drift — the field evolves as well as
     * slides, so zeroing the offset alone pins half of it and an A/B taken
     * that way compares different weather.
     */
    pinClouds() {
      const u = drift.sky.uniforms;
      u.uCloudOffset.value.set(0, 0);
      u.uCloudEvolve.value = 0;
      const field = drift.sky.cloudField;
      field.offsetX = 0;
      field.offsetZ = 0;
      field.evolve = 0;
      drift.lighting.setCloudState(
        u.uCloudCover.value,
        u.uCloudOpacity.value,
        field,
      );
    },

    settle(seconds = 4, dt = 1 / 60) {
      const n = Math.max(1, Math.round(seconds / dt));
      for (let i = 0; i < n; i++) drift.sim.stepSimulation(dt);
    },

    /** Render through the sky camera and POST the drawing buffer. */
    async shot(name) {
      this.pinClouds();
      drift.renderer.render(drift.scene, camera);
      const src = drift.renderer.domElement;
      const out = document.createElement('canvas');
      out.width = src.width;
      out.height = src.height;
      out.getContext('2d').drawImage(src, 0, 0);
      const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.94));
      const response = await fetch(
        `http://127.0.0.1:${this.port}/shot?name=${encodeURIComponent(name)}`,
        { method: 'POST', body: blob },
      );
      return { name, size: `${src.width}x${src.height}`, ok: response.ok };
    },

    /**
     * The full matrix: every view at every hour, written under `<tag>/`.
     * Returns the sun elevation each hour resolved to, so a later run can be
     * checked to be comparing like with like.
     */
    async matrix(tag, { views = VIEWS, hours = HOURS } = {}) {
      this.freeze();
      const report = [];
      for (const hour of hours) {
        this.setSolar(hour.solar);
        this.settle(2);
        for (const view of views) {
          this.aim(view.az, view.el, view.fov);
          await this.shot(`${tag}/${hour.name}-${view.name}.jpg`);
        }
        report.push({ hour: hour.name, sunElevationDeg: this.sunElevationDeg() });
      }
      return report;
    },

    /**
     * Temporal stability of the layer, in display levels.
     *
     * Advances ONLY the cloud drift offset by one frame's worth of wind and
     * measures the rms change per pixel. A layer that is properly band-limited
     * moves smoothly and scores a fraction of a level; one that is being
     * point-sampled past Nyquist scores several, because each pixel is
     * resampling unrelated parts of the noise rather than tracking a shape.
     * This is the measurement the aliasing hunt left behind, put to the cloud
     * field specifically — a march multiplies the samples per pixel, so it is
     * exactly the change that could have brought the static back.
     */
    stability(metresPerFrame = 4.5 / 60) {
      const gl = drift.renderer.getContext();
      const w = drift.renderer.domElement.width;
      const hgt = drift.renderer.domElement.height;
      const u = drift.sky.uniforms;
      const grab = () => {
        drift.renderer.render(drift.scene, camera);
        const buf = new Uint8Array(w * hgt * 4);
        gl.readPixels(0, 0, w, hgt, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        return buf;
      };
      // The default is the LEGACY drift rate, not the game's, deliberately:
      // this number's whole value is that it can be compared against the ones
      // recorded during the aliasing hunt, and the game now drifts thirty-five
      // times faster. Pass the real per-frame figure to ask the other question
      // — how much the picture changes when the sky is actually moving — and
      // read the answer as motion rather than as static.
      this.pinClouds();
      const a = grab();
      u.uCloudOffset.value.set(metresPerFrame, metresPerFrame * 0.6);
      const b = grab();
      this.pinClouds();
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < a.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const d = a[i + c] - b[i + c];
          sum += d * d;
          peak = Math.max(peak, Math.abs(d));
        }
      }
      return {
        rms: +Math.sqrt(sum / ((a.length / 4) * 3)).toFixed(3),
        peak,
        pixels: a.length / 4,
      };
    },

    /**
     * Pixel profile across cloud edges along one screen row.
     *
     * Ash's report is that the edges read like a cut-out pasted onto another
     * photograph. That is a compositing complaint, and compositing complaints
     * have two distinct causes which look identical to the eye and completely
     * different in the numbers: a transition that is too NARROW (a hard matte,
     * a handful of pixels from sky to cloud), or a transition that overshoots
     * in COLOUR (a fringe that is brighter and less saturated than either the
     * cloud or the sky it lies between — a matte line). This prints enough to
     * tell them apart: for each run of rising luminance it reports how many
     * pixels the ramp takes and what happens to saturation across it.
     */
    edgeProfile(row = 0.42, step = 2) {
      const gl = drift.renderer.getContext();
      const w = drift.renderer.domElement.width;
      const hgt = drift.renderer.domElement.height;
      drift.renderer.render(drift.scene, camera);
      const y = Math.floor(hgt * (1 - row));
      const buf = new Uint8Array(w * 4);
      gl.readPixels(0, y, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);

      const px = [];
      for (let x = 0; x < w; x += step) {
        const r = buf[x * 4], g = buf[x * 4 + 1], b = buf[x * 4 + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        px.push({ x, r, g, b, lum: 0.2126 * r + 0.7152 * g + 0.0722 * b, sat: mx === 0 ? 0 : (mx - mn) / mx });
      }
      // Walk the row and pick out monotonic luminance climbs of any size: each
      // is one sky-to-cloud transition.
      const edges = [];
      for (let i = 1; i < px.length - 1; i++) {
        if (px[i].lum - px[i - 1].lum <= 0.4) continue;
        let j = i;
        while (j < px.length - 1 && px[j + 1].lum > px[j].lum) j++;
        const rise = px[j].lum - px[i - 1].lum;
        if (rise > 22) {
          const a = px[i - 1], b2 = px[j];
          let peakSat = 0, minSat = 1;
          for (let k = i - 1; k <= j; k++) {
            peakSat = Math.max(peakSat, px[k].sat);
            minSat = Math.min(minSat, px[k].sat);
          }
          edges.push({
            atX: a.x,
            rampPx: (j - i + 2) * step,
            skyLum: +a.lum.toFixed(1),
            cloudLum: +b2.lum.toFixed(1),
            skySat: +a.sat.toFixed(3),
            cloudSat: +b2.sat.toFixed(3),
            minSatInRamp: +minSat.toFixed(3),
          });
        }
        i = j;
      }
      return { row, width: w, edges: edges.slice(0, 10) };
    },

    /** Frame cost through the sky camera: the dome is what a march makes dearer. */
    profile(frames = 90) {
      for (let i = 0; i < 8; i++) drift.renderer.render(drift.scene, camera);
      const gl = drift.renderer.getContext();
      gl.finish();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) drift.renderer.render(drift.scene, camera);
      gl.finish();
      const ms = (performance.now() - t0) / frames;
      return { msPerFrame: +ms.toFixed(2), fps: +(1000 / ms).toFixed(1), frames };
    },
  };

  window.__cloud = harness;
  return harness;
}
