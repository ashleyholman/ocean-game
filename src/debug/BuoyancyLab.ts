import type { SimCapability } from '../runtime/diagnostics/SimHandle';
import { SEA_STATES, findSeaState } from '../ocean/presets';
import type { SeaState } from '../ocean/seaState';
import { LabCameras, LAB_CAMERA_NAMES } from './labCameras';
import type { LabCameraName, LabCamerasCapability } from './labCameras';
import { LabOverlay } from './labOverlay';
import type { LabOverlayCapability, OverlayLayer } from './labOverlay';
import { MetricRecorder, plotRun } from './labMetrics';
import type { LabMetricsCapability, MetricSummary } from './labMetrics';
import { ParityProbe } from './labParity';
import type { LabParityCapability } from './labParity';
import { buildContactSheet, grab, post, postText, toBlob, VideoRecorder } from './labCapture';
import type { SheetFrame } from './labCapture';

export type BuoyancyLabCapability = SimCapability<
  | 'cameras'
  | 'canvas'
  | 'ocean'
  | 'originX'
  | 'originZ'
  | 'refreshLighting'
  | 'renderer'
  | 'resetSimulation'
  | 'scene'
  | 'setExposureBias'
  | 'stepSimulation'
  | 'vessel'
  | 'waves'
  | 'world'
> &
  LabCamerasCapability &
  LabOverlayCapability &
  LabMetricsCapability &
  LabParityCapability;

/**
 * The buoyancy diagnostic harness — `?debug=buoyancy` only.
 *
 * This module is dynamically imported, so it is code-split out of the
 * production entry chunk and cannot appear without the query parameter.
 *
 * The harness drives the simulation itself rather than riding
 * `requestAnimationFrame`: every step is a fixed, known number of seconds, and
 * every rendered frame happens synchronously at an exact simulation time. That
 * is what makes a capture reproducible, and it is why a throttled background
 * tab cannot change the answer.
 *
 * It is meant to outlive this round. Future wave systems will need somewhere to
 * prove that the raft still belongs to the water.
 */

type WaterMode = 'normal' | 'wireframe' | 'transparent';

/**
 * Frozen instant for every harness capture: roughly 09:00 local apparent solar
 * time at the prototype's starting longitude, in southern summer. A sun that
 * high lights the deck and the waterline instead of silhouetting them.
 */
const LAB_UTC_SECONDS = Date.parse('2026-01-14T23:45:00.000Z') / 1000;

interface RunOptions {
  preset: string;
  seconds?: number;
  settle?: number;
  renderHz?: number;
  physicsHz?: number;
  /** Presentation origin of the wave field for this run. */
  originX?: number;
  originZ?: number;
  /** Irregular render timing: dt is jittered while physics keeps its substep. */
  jitter?: boolean;
  /** Sample the GPU parity probe every N frames (0 = never). */
  parityEvery?: number;
  /** Override the preset's own frozen flag — TEST C runs the frozen wave moving. */
  frozen?: boolean;
}

const STYLE = `
.blab{position:fixed;top:8px;left:8px;z-index:40;width:310px;max-height:calc(100vh - 16px);
 overflow:auto;background:rgba(8,12,18,.9);color:#dfe9f4;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;
 border:1px solid #26374a;border-radius:6px;padding:9px 10px;backdrop-filter:blur(6px)}
.blab h2{margin:0 0 7px;font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:#7fd4ff}
.blab .row{display:flex;gap:5px;align-items:center;margin:4px 0;flex-wrap:wrap}
.blab button{background:#16222f;color:#dfe9f4;border:1px solid #2d4257;border-radius:4px;
 padding:3px 7px;font:inherit;cursor:pointer}
.blab button:hover{background:#1e3141}
.blab select,.blab input[type=number]{background:#16222f;color:#dfe9f4;border:1px solid #2d4257;
 border-radius:4px;padding:2px 4px;font:inherit;flex:1;min-width:80px}
.blab input[type=range]{flex:1}
.blab label.chk{display:inline-flex;gap:4px;align-items:center;margin-right:7px;cursor:pointer}
.blab pre{margin:6px 0 0;white-space:pre-wrap;color:#a8c4dd;font-size:11px;line-height:1.4}
.blab .sec{margin-top:7px;padding-top:6px;border-top:1px solid #1e2b3a;color:#6f8aa4;font-size:10px;
 letter-spacing:.08em;text-transform:uppercase}
`;

class BuoyancyLab {
  private readonly cameras: LabCameras;
  private readonly overlay: LabOverlay;
  private readonly metrics: MetricRecorder;
  private readonly parity: ParityProbe;

  private cameraName: LabCameraName = 'PORT_WATERLINE';
  private presetName = 'CURRENT_MODERATE';
  private playing = false;
  private rate = 1;
  private renderHz = 60;
  private physicsHz = 240;
  private waterMode: WaterMode = 'normal';
  private simTime = 0;
  private rafHandle = 0;
  private lastWall = 0;
  private carry = 0;
  private lastParity = 0;

  private readonly root: HTMLDivElement;
  private readonly readout: HTMLPreElement;
  private readonly timeLabel: HTMLSpanElement;

  constructor(private readonly sim: BuoyancyLabCapability) {
    this.cameras = new LabCameras(sim);
    this.overlay = new LabOverlay(sim);
    this.metrics = new MetricRecorder(sim);
    this.parity = new ParityProbe(sim);
    sim.scene.add(this.overlay.group);

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'blab';
    this.readout = document.createElement('pre');
    this.timeLabel = document.createElement('span');
    this.buildUi();
    document.body.appendChild(this.root);

    // Freeze canonical time. At the accelerated world-clock rate a diagnostic
    // run would otherwise move the sun substantially, which changes nothing
    // about the physics but makes two captures of the same instant look
    // different.
    sim.world.setPaused(true);
    // The shipping scene is a backlit sunset: gorgeous, and a near-silhouette
    // of the raft. Contact evidence needs to show where water meets timber, so
    // the harness moves the canonical instant to a mid-morning sun — high
    // enough to light the timber rather than rim it — and lifts the exposure.
    // Production regression captures put both back.
    sim.world.setWorldInstantUtcSeconds(LAB_UTC_SECONDS);
    sim.refreshLighting();
    sim.setExposureBias(1.35);

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));

    this.resize();
    this.reset();
    this.renderOnce();
  }

  // --- lifecycle -----------------------------------------------------------

  private resize(): void {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    this.sim.renderer.setSize(width, height, false);
    this.sim.cameras.setViewport(width, height);
    this.cameras.setViewport(width, height);
  }

  reset(preset = this.presetName, originX = 0, originZ = 0): void {
    this.presetName = preset;
    const spec = findSeaState(preset);
    this.sim.vessel.physicsStep = 1 / this.physicsHz;
    this.sim.resetSimulation(spec, originX, originZ);
    this.cameras.reset();
    this.simTime = 0;
    this.carry = 0;
    this.metrics.reset();
    this.applyWaterMode();
  }

  /** Advance exactly one render frame. */
  step(dt = 1 / this.renderHz): void {
    this.sim.vessel.physicsStep = 1 / this.physicsHz;
    this.sim.stepSimulation(dt);
    this.simTime += dt;
  }

  advance(seconds: number, record = false): void {
    const dt = 1 / this.renderHz;
    const frames = Math.max(0, Math.round(seconds / dt));
    for (let i = 0; i < frames; i++) {
      this.step(dt);
      if (record) this.metrics.record(this.simTime);
    }
  }

  /** Deterministic jump: re-run from t = 0 at the same fixed step. */
  seek(t: number): void {
    const x = this.sim.originX();
    const z = this.sim.originZ();
    this.reset(this.presetName, x, z);
    this.advance(t);
    this.renderOnce();
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.lastWall = performance.now();
    const tick = () => {
      if (!this.playing) return;
      const now = performance.now();
      const wall = Math.min((now - this.lastWall) / 1000, 0.25);
      this.lastWall = now;
      this.carry += wall * this.rate;
      const dt = 1 / this.renderHz;
      let guard = 0;
      while (this.carry >= dt && guard++ < 8) {
        this.step(dt);
        this.carry -= dt;
      }
      this.renderOnce();
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  // --- rendering -----------------------------------------------------------

  private applyWaterMode(): void {
    const material = this.sim.ocean.material;
    material.wireframe = this.waterMode === 'wireframe';
    const transparent = this.waterMode === 'transparent';
    material.transparent = transparent;
    material.depthWrite = !transparent;
    material.uniforms.uOpacity.value = transparent ? 0.34 : 1;
    material.needsUpdate = true;
  }

  renderOnce(): void {
    this.overlay.update();
    this.sim.renderer.render(this.sim.scene, this.cameras.camera(this.cameraName));
    this.updateReadout();
  }

  /** Render with no harness overlay — the clean visual version. */
  renderClean(): void {
    const state = this.overlay.layerState();
    this.overlay.setAll(false);
    this.sim.renderer.render(this.sim.scene, this.cameras.camera(this.cameraName));
    for (const key of Object.keys(state) as OverlayLayer[]) this.overlay.setLayer(key, state[key]);
  }

  // --- measurement ---------------------------------------------------------

  measureParity(span = 3): ReturnType<ParityProbe['measure']> {
    const result = this.parity.measure(span);
    this.lastParity = result.maxError;
    return result;
  }

  /**
   * A deterministic measurement run. Renders nothing, so sixty simulated
   * seconds take about a second of wall time and the numbers carry no display
   * dependency at all.
   */
  run(options: RunOptions): MetricSummary {
    const seconds = options.seconds ?? 60;
    const settle = options.settle ?? 10;
    this.renderHz = options.renderHz ?? 60;
    this.physicsHz = options.physicsHz ?? 240;
    this.reset(options.preset, options.originX ?? 0, options.originZ ?? 0);
    if (options.frozen !== undefined) this.sim.waves.frozen = options.frozen;

    const baseDt = 1 / this.renderHz;
    const frames = Math.round(seconds / baseDt);
    const settleFrames = Math.round(settle / baseDt);

    // A deterministic but irregular render schedule, to show that the fixed
    // physics substep is what decides the motion.
    let jitterState = 12345;
    const nextDt = () => {
      if (!options.jitter) return baseDt;
      jitterState = (jitterState * 1664525 + 1013904223) >>> 0;
      return baseDt * (0.35 + 1.6 * (jitterState / 4294967296));
    };

    for (let i = 0; i < settleFrames; i++) this.step(nextDt());

    for (let i = 0; i < frames; i++) {
      this.step(nextDt());
      const parityError =
        options.parityEvery && i % options.parityEvery === 0 ? this.measureParity(3).maxError : this.lastParity;
      this.metrics.record(this.simTime, parityError);
    }

    return this.metrics.summarise({
      preset: options.preset,
      renderHz: this.renderHz,
      physicsHz: this.physicsHz,
      originX: options.originX ?? 0,
      originZ: options.originZ ?? 0,
      dominantPeriod: this.sim.waves.dominantPeriod,
    });
  }

  // --- capture -------------------------------------------------------------

  async shot(name: string): Promise<boolean> {
    this.renderOnce();
    return post(name, await toBlob(grab(this.sim.canvas)));
  }

  async shotClean(name: string): Promise<boolean> {
    this.renderClean();
    return post(name, await toBlob(grab(this.sim.canvas)));
  }

  /**
   * A time-coded contact sheet: fixed camera, fixed simulation increments,
   * timestamp under every frame, spanning at least two dominant wave periods.
   */
  async contactSheet(options: {
    name: string;
    preset: string;
    camera: LabCameraName;
    frames?: number;
    interval?: number;
    settle?: number;
    overlay?: boolean;
    worldX?: number;
    worldZ?: number;
    columns?: number;
    title?: string;
  }): Promise<boolean> {
    const count = options.frames ?? 20;
    this.cameraName = options.camera;
    this.reset(options.preset, options.worldX ?? 0, options.worldZ ?? 0);
    const period = this.sim.waves.dominantPeriod || 4;
    const interval = options.interval ?? (period * 2.2) / count;

    this.advance(options.settle ?? 12);

    const wantOverlay = options.overlay ?? false;
    this.overlay.setAll(wantOverlay);

    const frames: SheetFrame[] = [];
    for (let i = 0; i < count; i++) {
      if (i > 0) this.advance(interval);
      this.overlay.update();
      this.sim.renderer.render(this.sim.scene, this.cameras.camera(this.cameraName));
      frames.push({ image: grab(this.sim.canvas, 0.5), label: `t = ${this.simTime.toFixed(2)} s` });
    }

    const sheet = buildContactSheet(frames, {
      columns: options.columns ?? 5,
      title: options.title ?? `${options.preset} · ${options.camera}${wantOverlay ? ' · overlay' : ''}`,
      subtitle:
        `interval ${interval.toFixed(3)} s · dominant period ${period.toFixed(2)} s · ` +
        `render ${this.renderHz} Hz · physics ${this.physicsHz} Hz · ` +
        `world (${(options.worldX ?? 0).toFixed(0)}, ${(options.worldZ ?? 0).toFixed(0)})`,
    });
    return post(options.name, await toBlob(sheet, 'image/jpeg', 0.9));
  }

  /** Deterministic stepped WebM capture. */
  async video(options: {
    name: string;
    preset: string;
    camera: LabCameraName;
    seconds?: number;
    fps?: number;
    settle?: number;
    overlay?: boolean;
  }): Promise<boolean> {
    const fps = options.fps ?? 30;
    const seconds = options.seconds ?? 20;
    this.cameraName = options.camera;
    this.reset(options.preset, 0, 0);
    this.overlay.setAll(options.overlay ?? false);
    this.advance(options.settle ?? 10);

    const recorder = new VideoRecorder(this.sim.canvas);
    if (!recorder.start()) return false;

    const dt = 1 / fps;
    const total = Math.round(seconds * fps);
    for (let i = 0; i < total; i++) {
      this.step(dt);
      this.overlay.update();
      this.sim.renderer.render(this.sim.scene, this.cameras.camera(this.cameraName));
      recorder.frame();
      // Give the encoder a turn; without this the whole capture lands in one
      // task and MediaRecorder drops nearly every frame.
      await new Promise((r) => setTimeout(r, 0));
    }
    return post(options.name, await recorder.stop());
  }

  /**
   * Capture a numbered frame sequence for offline encoding.
   *
   * `MediaRecorder` needs the event loop to turn between frames, and a browser
   * that is not the foreground tab throttles timers to roughly 1 Hz — which
   * makes a twenty-second capture take ten minutes and drop most of its frames.
   * Stepping and posting frames explicitly is immune to that, is exactly
   * reproducible, and hands the encoding to ffmpeg where it belongs.
   *
   * Call repeatedly with increasing `startFrame` to capture a long sequence in
   * chunks without any single call running long.
   */
  async frameSequence(options: {
    name: string;
    preset: string;
    camera: LabCameraName;
    fps: number;
    startFrame: number;
    count: number;
    settle?: number;
    overlay?: boolean;
    scale?: number;
    worldX?: number;
    worldZ?: number;
  }): Promise<number> {
    const dt = 1 / options.fps;
    this.cameraName = options.camera;
    if (options.startFrame === 0 || this.sequenceName !== options.name) {
      this.reset(options.preset, options.worldX ?? 0, options.worldZ ?? 0);
      this.advance(options.settle ?? 12);
      this.sequenceName = options.name;
      this.sequenceFrame = 0;
    }
    this.overlay.setAll(options.overlay ?? false);

    // Encode and upload in overlapping batches. One await per frame serialises
    // a fetch round-trip into the capture loop and drops the rate to about one
    // frame a second; batching keeps the simulation stepping while the previous
    // batch is in flight, without holding hundreds of full-size canvases.
    const BATCH = 16;
    let written = 0;
    let pending: Promise<boolean>[] = [];
    for (let i = 0; i < options.count; i++) {
      this.step(dt);
      this.overlay.update();
      this.sim.renderer.render(this.sim.scene, this.cameras.camera(this.cameraName));
      const index = String(this.sequenceFrame).padStart(5, '0');
      const frame = grab(this.sim.canvas, options.scale ?? 0.5);
      pending.push(
        toBlob(frame, 'image/jpeg', 0.86).then((blob) => post(`${options.name}/frame-${index}.jpg`, blob)),
      );
      this.sequenceFrame++;
      if (pending.length >= BATCH) {
        written += (await Promise.all(pending)).filter(Boolean).length;
        pending = [];
      }
    }
    written += (await Promise.all(pending)).filter(Boolean).length;
    return written;
  }

  private sequenceName = '';
  private sequenceFrame = 0;

  /** Capture one exact instant from the four revealing directions. */
  async captureMoment(options: {
    prefix: string;
    preset: string;
    time: number;
    worldX?: number;
    worldZ?: number;
    overlay?: boolean;
  }): Promise<string[]> {
    const written: string[] = [];
    const views: LabCameraName[] = [
      'PORT_WATERLINE',
      'BOW_WATERLINE',
      'STERN_WATERLINE',
      'HIGH_THREE_QUARTER',
    ];
    // Simulate to the instant once, then render every view from that one state.
    // Re-simulating per camera would be four times the work for an identical
    // result — and would invite the four views to drift apart.
    this.reset(options.preset, options.worldX ?? 0, options.worldZ ?? 0);
    this.advance(options.time);
    this.overlay.setAll(options.overlay ?? true);
    this.overlay.update();
    for (const view of views) {
      this.cameraName = view;
      this.sim.renderer.render(this.sim.scene, this.cameras.camera(view));
      const name = `${options.prefix}-${view.toLowerCase()}.jpg`;
      if (await post(name, await toBlob(grab(this.sim.canvas)))) written.push(name);
    }
    return written;
  }

  async exportRun(name: string, summary: MetricSummary): Promise<void> {
    await postText(`${name}.csv`, this.metrics.toCsv(), 'text/csv');
    await postText(`${name}.json`, JSON.stringify(summary, null, 2), 'application/json');
    const plot = plotRun(
      this.metrics.rows,
      `${summary.preset} · render ${summary.renderHz} Hz · physics ${summary.physicsHz} Hz · wave origin (${summary.originX.toFixed(0)}, ${summary.originZ.toFixed(0)})`,
    );
    await post(`${name}-plot.png`, await toBlob(plot, 'image/png'));
  }

  // --- interface -----------------------------------------------------------

  private buildUi(): void {
    const title = document.createElement('h2');
    title.textContent = 'Buoyancy diagnostics';
    this.root.appendChild(title);

    const mkRow = () => {
      const row = document.createElement('div');
      row.className = 'row';
      this.root.appendChild(row);
      return row;
    };
    const mkSection = (text: string) => {
      const s = document.createElement('div');
      s.className = 'sec';
      s.textContent = text;
      this.root.appendChild(s);
    };

    mkSection('wave preset');
    const presetSelect = document.createElement('select');
    for (const preset of SEA_STATES) {
      const option = document.createElement('option');
      option.value = preset.name;
      option.textContent = preset.label;
      presetSelect.appendChild(option);
    }
    presetSelect.value = this.presetName;
    presetSelect.addEventListener('change', () => {
      this.reset(presetSelect.value);
      this.renderOnce();
    });
    mkRow().appendChild(presetSelect);

    mkSection('camera');
    const cameraSelect = document.createElement('select');
    for (const name of LAB_CAMERA_NAMES) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      cameraSelect.appendChild(option);
    }
    cameraSelect.value = this.cameraName;
    cameraSelect.addEventListener('change', () => {
      this.cameraName = cameraSelect.value as LabCameraName;
      this.renderOnce();
    });
    mkRow().appendChild(cameraSelect);

    mkSection('transport');
    const transport = mkRow();
    const button = (label: string, tip: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = tip;
      b.addEventListener('click', onClick);
      transport.appendChild(b);
      return b;
    };
    let playButton: HTMLButtonElement;
    button('⟲', 'Reset to t = 0  (R)', () => {
      this.pause();
      playButton.textContent = '▶';
      this.reset();
      this.renderOnce();
    });
    playButton = button('▶', 'Play / pause  (Space)', () => {
      if (this.playing) {
        this.pause();
        playButton.textContent = '▶';
        this.renderOnce();
      } else {
        this.play();
        playButton.textContent = '❚❚';
      }
    });
    button('▸|', 'Single frame  (.)', () => {
      this.pause();
      playButton.textContent = '▶';
      this.step();
      this.renderOnce();
    });
    button('−1s', 'Back one second  ([)', () => {
      this.pause();
      playButton.textContent = '▶';
      this.seek(Math.max(0, this.simTime - 1));
    });
    button('+1s', 'Forward one second  (])', () => {
      this.pause();
      playButton.textContent = '▶';
      this.advance(1);
      this.renderOnce();
    });

    const timeRow = mkRow();
    this.timeLabel.textContent = 't = 0.000 s';
    timeRow.appendChild(this.timeLabel);
    const seekInput = document.createElement('input');
    seekInput.type = 'number';
    seekInput.step = '0.1';
    seekInput.min = '0';
    seekInput.placeholder = 'jump to t';
    seekInput.addEventListener('change', () => {
      this.pause();
      playButton.textContent = '▶';
      this.seek(Math.max(0, Number(seekInput.value) || 0));
    });
    timeRow.appendChild(seekInput);

    mkSection('rates');
    const rateRow = mkRow();
    const rateLabel = document.createElement('span');
    rateLabel.textContent = '1.00×';
    const rateInput = document.createElement('input');
    rateInput.type = 'range';
    rateInput.min = '0.05';
    rateInput.max = '1';
    rateInput.step = '0.05';
    rateInput.value = '1';
    rateInput.title = 'Slow motion';
    rateInput.addEventListener('input', () => {
      this.rate = Number(rateInput.value);
      rateLabel.textContent = `${this.rate.toFixed(2)}×`;
    });
    rateRow.append(rateLabel, rateInput);

    const hzRow = mkRow();
    const renderSelect = document.createElement('select');
    for (const hz of [30, 60, 120, 144]) {
      const o = document.createElement('option');
      o.value = String(hz);
      o.textContent = `render ${hz} Hz`;
      renderSelect.appendChild(o);
    }
    renderSelect.value = '60';
    renderSelect.addEventListener('change', () => {
      this.renderHz = Number(renderSelect.value);
    });
    const physicsSelect = document.createElement('select');
    for (const hz of [60, 120, 240, 480]) {
      const o = document.createElement('option');
      o.value = String(hz);
      o.textContent = `physics ${hz} Hz`;
      physicsSelect.appendChild(o);
    }
    physicsSelect.value = '240';
    physicsSelect.addEventListener('change', () => {
      this.physicsHz = Number(physicsSelect.value);
      this.sim.vessel.physicsStep = 1 / this.physicsHz;
    });
    hzRow.append(renderSelect, physicsSelect);

    mkSection('water');
    const waterSelect = document.createElement('select');
    for (const mode of ['normal', 'transparent', 'wireframe'] as WaterMode[]) {
      const o = document.createElement('option');
      o.value = mode;
      o.textContent = `water: ${mode}`;
      waterSelect.appendChild(o);
    }
    waterSelect.addEventListener('change', () => {
      this.waterMode = waterSelect.value as WaterMode;
      this.applyWaterMode();
      this.renderOnce();
    });
    mkRow().appendChild(waterSelect);

    mkSection('overlays');
    const overlayRow = mkRow();
    const state = this.overlay.layerState();
    for (const layer of Object.keys(state) as OverlayLayer[]) {
      const label = document.createElement('label');
      label.className = 'chk';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state[layer];
      box.addEventListener('change', () => {
        this.overlay.setLayer(layer, box.checked);
        this.renderOnce();
      });
      label.append(box, document.createTextNode(layer));
      overlayRow.appendChild(label);
    }

    mkSection('wave origin');
    const worldRow = mkRow();
    const offsetButton = (label: string, x: number, z: number) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => {
        this.reset(this.presetName, x, z);
        this.renderOnce();
      });
      worldRow.appendChild(b);
    };
    offsetButton('origin', 0, 0);
    offsetButton('+6 km', 6000, 6000);
    offsetButton('−6 km', -6000, -6000);
    offsetButton('+60 km', 60000, 60000);

    mkSection('contact readout');
    this.root.appendChild(this.readout);
  }

  private onKey(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    switch (event.key) {
      case ' ':
        event.preventDefault();
        if (this.playing) {
          this.pause();
          this.renderOnce();
        } else this.play();
        break;
      case '.':
        this.pause();
        this.step();
        this.renderOnce();
        break;
      case '[':
        this.pause();
        this.seek(Math.max(0, this.simTime - 1));
        break;
      case ']':
        this.pause();
        this.advance(1);
        this.renderOnce();
        break;
      case 'r':
      case 'R':
        this.pause();
        this.reset();
        this.renderOnce();
        break;
      default:
        break;
    }
  }

  private updateReadout(): void {
    const body = this.sim.vessel.body;
    const waves = this.sim.waves;
    this.timeLabel.textContent = `t = ${this.simTime.toFixed(3)} s`;

    let dMin = Infinity;
    let dMax = -Infinity;
    let dSum = 0;
    for (const contact of body.contacts) {
      dSum += contact.waterlineClearanceM;
      dMin = Math.min(dMin, contact.waterlineClearanceM);
      dMax = Math.max(dMax, contact.waterlineClearanceM);
    }
    const dMean = dSum / body.stations.length;

    const critical = body.critical
      .map((c) => `  ${c.name.padEnd(13)}${c.clearance >= 0 ? ' ' : ''}${c.clearance.toFixed(3)} m${c.clearance < 0 ? '  WET' : ''}`)
      .join('\n');

    this.readout.textContent =
      `sim t        ${this.simTime.toFixed(3)} s   wave t ${waves.time.toFixed(3)} s\n` +
      `sea state    ${waves.state.name}${waves.frozen ? ' (frozen)' : ''}\n` +
      `wave origin  ${this.sim.originX().toFixed(1)}, ${this.sim.originZ().toFixed(1)}\n` +
      `\n` +
      `waterline y  ${body.designWaterlineY.toFixed(4)} m raft-local\n` +
      `freeboard    ${body.freeboard.toFixed(4)} m\n` +
      `mass         ${body.mass.toFixed(1)} kg   V ${body.displacedVolume.toFixed(4)} m3\n` +
      `Awp          ${body.waterplaneArea.toFixed(3)} m2\n` +
      `wn heave     ${body.heaveNaturalFrequency.toFixed(3)} rad/s  T ${(6.2832 / body.heaveNaturalFrequency).toFixed(3)} s\n` +
      `zeta ${body.dampingRatio.toFixed(2)}   Ca ${body.addedMassCoefficient.toFixed(2)}   stations ${body.stations.length}\n` +
      `\n` +
      `d mean       ${dMean >= 0 ? ' ' : ''}${dMean.toFixed(4)} m\n` +
      `d min / max  ${dMin.toFixed(4)} / ${dMax.toFixed(4)} m\n` +
      `immersed     ${body.immersedCount} / ${body.stations.length}\n` +
      `heave        ${body.comWorldY.toFixed(4)} m   v ${body.velocityY.toFixed(4)} m/s\n` +
      `pitch / roll ${((body.pitch * 180) / Math.PI).toFixed(3)}° / ${((body.roll * 180) / Math.PI).toFixed(3)}°\n` +
      `water @ raft ${body.centreWaterY.toFixed(4)} m\n` +
      `substeps     ${body.lastSubsteps} @ ${this.physicsHz} Hz\n` +
      `solve resid  ${waves.lastSolveResidual.toExponential(2)} m\n` +
      `parity max   ${this.lastParity.toExponential(2)} m\n` +
      `overtopping  ${body.overtopEvents.length}  spray ${this.sim.vessel.activeOvertopSprayCount()}\n` +
      `\ncritical dry points\n${critical}\n`;
  }

  // --- automation surface --------------------------------------------------

  api(): Record<string, unknown> {
    return {
      reset: (preset?: string, x?: number, z?: number) => {
        this.reset(preset ?? this.presetName, x ?? 0, z ?? 0);
        this.renderOnce();
      },
      play: () => this.play(),
      pause: () => this.pause(),
      step: (n = 1) => {
        for (let i = 0; i < n; i++) this.step();
        this.renderOnce();
      },
      advance: (s: number) => {
        this.advance(s);
        this.renderOnce();
      },
      seek: (t: number) => this.seek(t),
      setPreset: (name: string) => {
        this.reset(name);
        this.renderOnce();
      },
      setCamera: (name: LabCameraName) => {
        this.cameraName = name;
        this.renderOnce();
      },
      setOverlay: (layer: OverlayLayer, on: boolean) => {
        this.overlay.setLayer(layer, on);
        this.renderOnce();
      },
      setAllOverlays: (on: boolean) => {
        this.overlay.setAll(on);
        this.renderOnce();
      },
      setWater: (mode: WaterMode) => {
        this.waterMode = mode;
        this.applyWaterMode();
        this.renderOnce();
      },
      setRenderHz: (hz: number) => {
        this.renderHz = hz;
      },
      setPhysicsHz: (hz: number) => {
        this.physicsHz = hz;
        this.sim.vessel.physicsStep = 1 / hz;
      },
      setFrozen: (on: boolean) => {
        this.sim.waves.frozen = on;
      },
      /**
       * Diagnostic lighting. The shipping scene runs accelerated real
       * astronomy, so a capture has to pin the canonical instant or two shots
       * of the same simulation time will not match. A low sun also renders the
       * raft as a near-silhouette — beautiful, and useless for judging where
       * the water meets the timber — so the harness picks a higher one and
       * lifts the exposure. Production regression shots restore the shipping
       * values.
       */
      setWorldInstant: (utcSeconds: number, exposureBias?: number) => {
        this.sim.world.setWorldInstantUtcSeconds(utcSeconds);
        if (exposureBias !== undefined) this.sim.setExposureBias(exposureBias);
        this.sim.refreshLighting();
        this.renderOnce();
      },
      /** Resume or re-freeze the canonical clock (frozen while the lab runs). */
      setPaused: (paused: boolean) => {
        this.sim.world.setPaused(paused);
      },
      /**
       * Move the wave field's phase anchor while the raft stays at the render
       * origin. Production never does this; it is here so the field can be
       * exercised far from zero, where the seed solve and the phase wrap are
       * most likely to misbehave.
       */
      setWaveOrigin: (x: number, z: number) => {
        this.reset(this.presetName, x, z);
        this.renderOnce();
      },
      run: (options: RunOptions) => this.run(options),
      rowCount: () => this.metrics.rows.length,
      rows: () => this.metrics.rows,
      /** Percentile of any recorded column, for shaping the report's numbers. */
      column: (key: string, percentiles: number[] = [50, 95, 99, 100]) => {
        const values = this.metrics.rows
          .map((r) => Math.abs((r as unknown as Record<string, number>)[key]))
          .sort((a, b) => a - b);
        if (!values.length) return {};
        return Object.fromEntries(
          percentiles.map((p) => [`p${p}`, values[Math.min(values.length - 1, Math.round((p / 100) * (values.length - 1)))]]),
        );
      },
      exportRun: (name: string, summary: MetricSummary) => this.exportRun(name, summary),
      measureParity: (span?: number) => this.measureParity(span),
      shot: (name: string) => this.shot(name),
      shotClean: (name: string) => this.shotClean(name),
      contactSheet: (o: Parameters<BuoyancyLab['contactSheet']>[0]) => this.contactSheet(o),
      video: (o: Parameters<BuoyancyLab['video']>[0]) => this.video(o),
      frameSequence: (o: Parameters<BuoyancyLab['frameSequence']>[0]) => this.frameSequence(o),
      captureMoment: (o: Parameters<BuoyancyLab['captureMoment']>[0]) => this.captureMoment(o),
      presets: () => SEA_STATES.map((p: SeaState) => p.name),
      cameras: () => LAB_CAMERA_NAMES,
      state: () => ({
        t: this.simTime,
        waveT: this.sim.waves.time,
        preset: this.presetName,
        camera: this.cameraName,
        renderHz: this.renderHz,
        physicsHz: this.physicsHz,
        waveOrigin: [this.sim.originX(), this.sim.originZ()],
        worldInstantUtcSeconds: this.sim.world.state.worldInstantUtcSeconds,
        body: this.bodySnapshot(),
      }),
      hideUi: (hidden: boolean) => {
        this.root.style.display = hidden ? 'none' : '';
      },
    };
  }

  bodySnapshot(): Record<string, unknown> {
    const body = this.sim.vessel.body;
    return {
      designWaterlineY: body.designWaterlineY,
      freeboard: body.freeboard,
      outerCrownY: body.outerCrownY,
      mass: body.mass,
      displacedVolume: body.displacedVolume,
      waterplaneArea: body.waterplaneArea,
      com: [body.comX, body.comY, body.comZ],
      inertiaPitch: body.inertiaPitch,
      inertiaRoll: body.inertiaRoll,
      naturalFrequency: body.heaveNaturalFrequency,
      dampingRatio: body.dampingRatio,
      addedMass: body.addedMassCoefficient,
      stations: body.stations.length,
      comWorldY: body.comWorldY,
      pitchDeg: (body.pitch * 180) / Math.PI,
      rollDeg: (body.roll * 180) / Math.PI,
      velocityY: body.velocityY,
      immersed: body.immersedCount,
      waterlineErrors: body.contacts.map((contact) => contact.waterlineClearanceM),
      critical: Object.fromEntries(body.critical.map((c) => [c.name, c.clearance])),
    };
  }
}

export function startBuoyancyLab(sim: BuoyancyLabCapability): void {
  const lab = new BuoyancyLab(sim);
  (window as unknown as Record<string, unknown>).__lab = lab.api();
  console.info('[buoyancy] diagnostic harness active — window.__lab');
}
