import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type LabMetricsCapability = SimCapability<'vessel' | 'waves'>;

/**
 * Numerical verification.
 *
 * The primary quantity is the signed normal distance at each contact station,
 *
 *     d_i = dot(W_i - S_i, N_i)
 *
 * with W_i the designed-waterline point at that station in world space, S_i the
 * water-surface point at the same horizontal position and the same simulation
 * time, and N_i the local water normal. Positive is a gap under the raft;
 * negative is immersion.
 *
 * Correlation is recorded because it was previously used as the pass condition,
 * and recording it is how the report shows what it does and does not prove. It
 * is never a pass condition here.
 */

export interface MetricRow {
  t: number;
  comY: number;
  /** World height of the raft's designed waterline at its centre. */
  waterlineY: number;
  /** Water surface height under the raft centre. */
  waterY: number;
  raftVelY: number;
  waterVelY: number;
  accelY: number;
  jerkY: number;
  pitchDeg: number;
  rollDeg: number;
  pitchRate: number;
  rollRate: number;
  dMean: number;
  dMin: number;
  dMax: number;
  dRms: number;
  immersed: number;
  minClearance: number;
  minClearanceName: string;
  deckClearance: number;
  sailClearance: number;
  solveResidual: number;
  overtopCount: number;
  parityMaxError: number;
}

export interface MetricSummary {
  preset: string;
  seconds: number;
  frames: number;
  renderHz: number;
  physicsHz: number;
  originX: number;
  originZ: number;
  dominantPeriod: number;

  dMeanAbs: number;
  dRms: number;
  dP95Abs: number;
  dMax: number;
  dMin: number;
  worstHoverTime: number;
  worstImmersionTime: number;

  centreMeanAbsError: number;
  centreP95AbsError: number;
  centreRmsError: number;

  maxPitchDeg: number;
  maxRollDeg: number;
  maxPitchTime: number;
  maxRollTime: number;
  maxAbsAccel: number;
  maxAbsJerk: number;
  maxJerkTime: number;

  minCriticalClearance: number;
  minCriticalName: string;
  minCriticalTime: number;
  criticalWetFrames: number;
  /** Minimum clearance reached by each named dry point over the run. */
  criticalMinima: Record<string, number>;

  fullAirGapFrames: number;
  longestFullAirGapSeconds: number;
  overtopFrames: number;

  sameFrameCorrelation: number;
  bestLagCorrelation: number;
  bestLagSeconds: number;
  bestLagPercentOfPeriod: number;

  heaveRangeRatio: number;
  maxSolveResidual: number;
  maxParityError: number;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

function correlation(a: number[], b: number[], shift: number): number {
  const n = Math.min(a.length, b.length) - Math.abs(shift);
  if (n < 8) return 0;
  const ai = shift >= 0 ? shift : 0;
  const bi = shift >= 0 ? 0 : -shift;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[ai + i];
    sb += b[bi + i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[ai + i] - ma;
    const y = b[bi + i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

export class MetricRecorder {
  readonly rows: MetricRow[] = [];
  private previousAccel = 0;

  constructor(private readonly sim: LabMetricsCapability) {}

  reset(): void {
    this.rows.length = 0;
    this.previousAccel = 0;
    for (const key of Object.keys(this.criticalMinima)) delete this.criticalMinima[key];
  }

  /** Minimum clearance reached by each dry point, tracked live. */
  readonly criticalMinima: Record<string, number> = {};

  record(t: number, parityMaxError = 0): void {
    const body = this.sim.vessel.body;
    const contacts = body.contacts;
    for (const c of body.critical) {
      const previous = this.criticalMinima[c.name];
      if (previous === undefined || c.clearance < previous) this.criticalMinima[c.name] = c.clearance;
    }

    let sum = 0;
    let sumSq = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const contact of contacts) {
      const d = contact.waterlineClearanceM;
      sum += d;
      sumSq += d * d;
      if (d < min) min = d;
      if (d > max) max = d;
    }

    let minClearance = Infinity;
    let minClearanceName = '';
    let deckClearance = Infinity;
    let sailClearance = Infinity;
    for (const c of body.critical) {
      if (c.clearance < minClearance) {
        minClearance = c.clearance;
        minClearanceName = c.name;
      }
      if (c.name.startsWith('DECK')) deckClearance = Math.min(deckClearance, c.clearance);
      if (c.name === 'FOLDED_SAIL') sailClearance = c.clearance;
    }

    const accel = body.accelerationY;
    const previous = this.rows[this.rows.length - 1];
    const dt = previous ? Math.max(t - previous.t, 1e-6) : 1;
    const jerk = previous ? (accel - this.previousAccel) / dt : 0;
    this.previousAccel = accel;

    this.rows.push({
      t,
      comY: body.comWorldY,
      waterlineY: body.designWaterlineWorldY(),
      waterY: body.centreWaterY,
      raftVelY: body.velocityY,
      waterVelY: contacts.length
        ? contacts[Math.floor(contacts.length / 2)].waterVelocityWorldMps.y
        : 0,
      accelY: accel,
      jerkY: jerk,
      pitchDeg: (body.pitch * 180) / Math.PI,
      rollDeg: (body.roll * 180) / Math.PI,
      pitchRate: body.pitchRate,
      rollRate: body.rollRate,
      dMean: sum / contacts.length,
      dMin: min,
      dMax: max,
      dRms: Math.sqrt(sumSq / contacts.length),
      immersed: body.immersedCount,
      minClearance,
      minClearanceName,
      deckClearance,
      sailClearance,
      solveResidual: this.sim.waves.lastSolveResidual,
      overtopCount: body.overtopEvents.length,
      parityMaxError,
    });
  }

  summarise(meta: {
    preset: string;
    renderHz: number;
    physicsHz: number;
    originX: number;
    originZ: number;
    dominantPeriod: number;
  }): MetricSummary {
    const rows = this.rows;
    const n = rows.length;
    const allD: number[] = [];
    for (const r of rows) allD.push(r.dMean);

    const absD: number[] = [];
    let sumSq = 0;
    let dMax = -Infinity;
    let dMin = Infinity;
    let worstHoverTime = 0;
    let worstImmersionTime = 0;
    for (const r of rows) {
      absD.push(Math.abs(r.dMean));
      sumSq += r.dMean * r.dMean;
      if (r.dMax > dMax) {
        dMax = r.dMax;
        worstHoverTime = r.t;
      }
      if (r.dMin < dMin) {
        dMin = r.dMin;
        worstImmersionTime = r.t;
      }
    }
    absD.sort((a, b) => a - b);

    // Centre error: the raft's own waterline against the water beneath it.
    const centreErrors = rows.map((r) => Math.abs(r.waterlineY - r.waterY));
    const centreSorted = [...centreErrors].sort((a, b) => a - b);

    let maxPitch = 0;
    let maxRoll = 0;
    let maxPitchTime = 0;
    let maxRollTime = 0;
    let maxAccel = 0;
    let maxJerk = 0;
    let maxJerkTime = 0;
    let minCritical = Infinity;
    let minCriticalName = '';
    let minCriticalTime = 0;
    let criticalWetFrames = 0;
    let overtopFrames = 0;
    let maxResidual = 0;
    let maxParity = 0;
    for (const r of rows) {
      if (Math.abs(r.pitchDeg) > maxPitch) {
        maxPitch = Math.abs(r.pitchDeg);
        maxPitchTime = r.t;
      }
      if (Math.abs(r.rollDeg) > maxRoll) {
        maxRoll = Math.abs(r.rollDeg);
        maxRollTime = r.t;
      }
      maxAccel = Math.max(maxAccel, Math.abs(r.accelY));
      if (Math.abs(r.jerkY) > maxJerk) {
        maxJerk = Math.abs(r.jerkY);
        maxJerkTime = r.t;
      }
      if (r.minClearance < minCritical) {
        minCritical = r.minClearance;
        minCriticalName = r.minClearanceName;
        minCriticalTime = r.t;
      }
      if (r.minClearance < 0) criticalWetFrames++;
      if (r.overtopCount > 0) overtopFrames++;
      maxResidual = Math.max(maxResidual, r.solveResidual);
      maxParity = Math.max(maxParity, r.parityMaxError);
    }

    // A full air gap is every station clear of the water at once.
    let fullAirGapFrames = 0;
    let longestRun = 0;
    let run = 0;
    for (const r of rows) {
      if (r.immersed === 0) {
        fullAirGapFrames++;
        run++;
        longestRun = Math.max(longestRun, run);
      } else run = 0;
    }
    const dt = n > 1 ? rows[1].t - rows[0].t : 1 / meta.renderHz;

    const raftSeries = rows.map((r) => r.waterlineY);
    const waterSeries = rows.map((r) => r.waterY);
    const sameFrame = correlation(raftSeries, waterSeries, 0);
    let bestLagCorrelation = sameFrame;
    let bestShift = 0;
    const maxShift = Math.min(Math.floor(n / 4), Math.ceil(2 / Math.max(dt, 1e-6)));
    for (let s = -maxShift; s <= maxShift; s++) {
      const c = correlation(waterSeries, raftSeries, s);
      if (c > bestLagCorrelation) {
        bestLagCorrelation = c;
        bestShift = s;
      }
    }

    const range = (v: number[]) => (v.length ? Math.max(...v) - Math.min(...v) : 0);

    return {
      preset: meta.preset,
      seconds: n ? rows[n - 1].t - rows[0].t : 0,
      frames: n,
      renderHz: meta.renderHz,
      physicsHz: meta.physicsHz,
      originX: meta.originX,
      originZ: meta.originZ,
      dominantPeriod: meta.dominantPeriod,

      dMeanAbs: absD.reduce((a, b) => a + b, 0) / Math.max(n, 1),
      dRms: Math.sqrt(sumSq / Math.max(n, 1)),
      dP95Abs: percentile(absD, 95),
      dMax,
      dMin,
      worstHoverTime,
      worstImmersionTime,

      centreMeanAbsError: centreErrors.reduce((a, b) => a + b, 0) / Math.max(n, 1),
      centreP95AbsError: percentile(centreSorted, 95),
      centreRmsError: Math.sqrt(centreErrors.reduce((a, b) => a + b * b, 0) / Math.max(n, 1)),

      maxPitchDeg: maxPitch,
      maxRollDeg: maxRoll,
      maxPitchTime,
      maxRollTime,
      maxAbsAccel: maxAccel,
      maxAbsJerk: maxJerk,
      maxJerkTime,

      minCriticalClearance: minCritical,
      minCriticalName,
      minCriticalTime,
      criticalWetFrames,
      criticalMinima: { ...this.criticalMinima },

      fullAirGapFrames,
      longestFullAirGapSeconds: longestRun * dt,
      overtopFrames,

      sameFrameCorrelation: sameFrame,
      bestLagCorrelation,
      bestLagSeconds: bestShift * dt,
      bestLagPercentOfPeriod: meta.dominantPeriod > 0 ? (100 * bestShift * dt) / meta.dominantPeriod : 0,

      heaveRangeRatio: range(waterSeries) > 0 ? range(raftSeries) / range(waterSeries) : 0,
      maxSolveResidual: maxResidual,
      maxParityError: maxParity,
    };
  }

  toCsv(): string {
    if (!this.rows.length) return '';
    const keys = Object.keys(this.rows[0]) as (keyof MetricRow)[];
    const head = keys.join(',');
    const body = this.rows
      .map((r) => keys.map((k) => (typeof r[k] === 'number' ? (r[k] as number).toFixed(6) : String(r[k]))).join(','))
      .join('\n');
    return `${head}\n${body}\n`;
  }
}

/**
 * Time-series plots, drawn to a canvas so they can be posted alongside the
 * frames. Deliberately plain: the point is to read values off, not to decorate.
 */
export function plotRun(rows: MetricRow[], title: string): HTMLCanvasElement {
  const width = 1400;
  const paneHeight = 190;
  const panes = 4;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = paneHeight * panes + 54;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0d1218';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '15px ui-monospace, monospace';
  ctx.fillStyle = '#e8eef5';
  ctx.fillText(title, 14, 24);

  if (!rows.length) return canvas;
  const t0 = rows[0].t;
  const t1 = rows[rows.length - 1].t;
  const xOf = (t: number) => 60 + ((t - t0) / Math.max(t1 - t0, 1e-6)) * (width - 90);

  const drawPane = (
    index: number,
    label: string,
    series: Array<{ key: (r: MetricRow) => number; color: string; name: string }>,
    zeroLine = true,
  ) => {
    const top = 44 + index * paneHeight;
    const bottom = top + paneHeight - 34;
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) {
      for (const r of rows) {
        const v = s.key(r);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!isFinite(lo)) return;
    const pad = Math.max((hi - lo) * 0.12, 1e-4);
    lo -= pad;
    hi += pad;
    const yOf = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);

    ctx.strokeStyle = '#243040';
    ctx.lineWidth = 1;
    ctx.strokeRect(60, top, width - 90, bottom - top);
    if (zeroLine && lo < 0 && hi > 0) {
      ctx.strokeStyle = '#3a4a5e';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(60, yOf(0));
      ctx.lineTo(width - 30, yOf(0));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = '#8fa4bb';
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText(hi.toFixed(3), 6, top + 10);
    ctx.fillText(lo.toFixed(3), 6, bottom);
    ctx.fillStyle = '#c8d6e5';
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText(label, 64, top - 6);

    let legendX = 300;
    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < rows.length; i++) {
        const x = xOf(rows[i].t);
        const y = yOf(s.key(rows[i]));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.fillStyle = s.color;
      ctx.fillRect(legendX, top - 15, 16, 3);
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText(s.name, legendX + 22, top - 9);
      legendX += 26 + ctx.measureText(s.name).width;
    }
  };

  drawPane(0, 'height (m)', [
    { key: (r) => r.waterY, color: '#39d9ff', name: 'water under raft' },
    { key: (r) => r.waterlineY, color: '#ffd23a', name: 'raft designed waterline' },
  ], false);
  drawPane(1, 'waterline error d (m)  + = hover, − = immersion', [
    { key: (r) => r.dMean, color: '#ffffff', name: 'mean' },
    { key: (r) => r.dMax, color: '#ff5a5a', name: 'max' },
    { key: (r) => r.dMin, color: '#5aa2ff', name: 'min' },
  ]);
  drawPane(2, 'attitude (deg)', [
    { key: (r) => r.pitchDeg, color: '#4dff5a', name: 'pitch' },
    { key: (r) => r.rollDeg, color: '#ff9f40', name: 'roll' },
  ]);
  drawPane(3, 'vertical velocity (m/s) and clearances (m)', [
    { key: (r) => r.raftVelY, color: '#ffd23a', name: 'raft' },
    { key: (r) => r.waterVelY, color: '#39d9ff', name: 'water' },
    { key: (r) => r.deckClearance, color: '#4dff5a', name: 'deck clearance' },
  ]);

  return canvas;
}
