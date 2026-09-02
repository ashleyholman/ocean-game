export interface ResidualEvaluation {
  gradientX: number;
  gradientZ: number;
  lostVariance: number;
  individualCount: number;
  activeStart: number;
  activeEnd: number;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

function residualVisibility(k: number, footprint: number): number {
  const wavelength = (Math.PI * 2) / k;
  return 1 - smoothstep(wavelength * 0.25, wavelength * 0.5, footprint);
}

/** CPU port of the legacy canonical 48-slot fragment scan. */
export function evaluateResidualBrute(
  waveA: Float32Array,
  waveB: Float32Array,
  waveAmplitude: number,
  residualMaxK: number,
  pX: number,
  pZ: number,
  lodRadius: number,
  footprint: number,
): ResidualEvaluation {
  let gradientX = 0;
  let gradientZ = 0;
  let lostVariance = 0;
  let individualCount = 0;
  for (let i = 0; i < waveA.length / 4; i++) {
    const offset = i * 4;
    const k = waveA[offset + 3];
    const amp0 = waveA[offset + 2] * waveAmplitude;
    if (amp0 <= 0) continue;
    const missing = smoothstep(waveB[offset + 2], waveB[offset + 3], lodRadius);
    if (missing < 0.002) continue;
    individualCount++;

    const amp = amp0 * missing;
    let visible = residualVisibility(k, footprint);
    if (visible > 0.002 && k < residualMaxK) {
      const phase =
        k * (waveA[offset] * pX + waveA[offset + 1] * pZ) + waveB[offset + 1];
      const slope = amp * k * Math.cos(phase) * visible;
      gradientX += waveA[offset] * slope;
      gradientZ += waveA[offset + 1] * slope;
    } else {
      visible = 0;
    }
    const dropped = (1 - visible) * amp * k;
    lostVariance += 0.5 * dropped * dropped;
  }
  return {
    gradientX,
    gradientZ,
    lostVariance,
    individualCount,
    activeStart: 0,
    activeEnd: waveA.length / 4,
  };
}

/** Exact lower bounds used by the optimized GLSL path. */
export function residualActiveBounds(
  residualWaveA: Float32Array,
  residualWaveB: Float32Array,
  activeCount: number,
  residualMaxK: number,
  lodRadius: number,
  footprint: number,
): [number, number] {
  let startLo = 0;
  let startHi = activeCount;
  while (startLo < startHi) {
    const mid = Math.floor((startLo + startHi) / 2);
    const offset = mid * 4;
    const missing = smoothstep(
      residualWaveB[offset + 2],
      residualWaveB[offset + 3],
      lodRadius,
    );
    if (missing < 0.002) startLo = mid + 1;
    else startHi = mid;
  }
  const activeStart = startLo;

  let endLo = activeStart;
  let endHi = activeCount;
  while (endLo < endHi) {
    const mid = Math.floor((endLo + endHi) / 2);
    const offset = mid * 4;
    const k = residualWaveA[offset + 3];
    const missing = smoothstep(
      residualWaveB[offset + 2],
      residualWaveB[offset + 3],
      lodRadius,
    );
    const visible = residualVisibility(k, footprint);
    const fullyStatistical =
      missing >= 1 && !(visible > 0.002 && k < residualMaxK);
    if (fullyStatistical) endHi = mid;
    else endLo = mid + 1;
  }
  return [activeStart, endLo];
}

/** CPU reference for the wavelength-ordered active-window shader. */
export function evaluateResidualActive(
  residualWaveA: Float32Array,
  residualWaveB: Float32Array,
  activeCount: number,
  totalSlopeEnergy: number,
  waveAmplitude: number,
  residualMaxK: number,
  pX: number,
  pZ: number,
  lodRadius: number,
  footprint: number,
): ResidualEvaluation {
  const [activeStart, activeEnd] = residualActiveBounds(
    residualWaveA,
    residualWaveB,
    activeCount,
    residualMaxK,
    lodRadius,
    footprint,
  );
  let gradientX = 0;
  let gradientZ = 0;
  let lostVariance = 0;

  for (let i = activeStart; i < activeEnd; i++) {
    const offset = i * 4;
    const k = residualWaveA[offset + 3];
    const amp0 = residualWaveA[offset + 2] * waveAmplitude;
    if (amp0 <= 0) continue;
    const missing = smoothstep(
      residualWaveB[offset + 2],
      residualWaveB[offset + 3],
      lodRadius,
    );
    if (missing < 0.002) continue;
    const amp = amp0 * missing;
    let visible = residualVisibility(k, footprint);
    if (visible > 0.002 && k < residualMaxK) {
      const phase =
        k *
          (residualWaveA[offset] * pX + residualWaveA[offset + 1] * pZ) +
        residualWaveB[offset + 1];
      const slope = amp * k * Math.cos(phase) * visible;
      gradientX += residualWaveA[offset] * slope;
      gradientZ += residualWaveA[offset + 1] * slope;
    } else {
      visible = 0;
    }
    const dropped = (1 - visible) * amp * k;
    lostVariance += 0.5 * dropped * dropped;
  }

  if (activeEnd < activeCount) {
    const prefixBeforeTail = residualWaveB[activeEnd * 4];
    lostVariance +=
      Math.max(totalSlopeEnergy - prefixBeforeTail, 0) *
      waveAmplitude *
      waveAmplitude;
  }

  return {
    gradientX,
    gradientZ,
    lostVariance,
    individualCount: activeEnd - activeStart,
    activeStart,
    activeEnd,
  };
}
