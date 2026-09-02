import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  clampOceanTemporalStability,
  decodeOceanMotionPixel,
  encodeOceanMotionPixel,
  halton,
  OCEAN_TEMPORAL_DEFAULT_STABILITY,
  OCEAN_TEMPORAL_JITTER_PERIOD,
  OCEAN_TEMPORAL_MOTION_RANGE_PX,
  oceanTemporalHistoryWeight,
  oceanTemporalJitter,
} from '../src/render/oceanTemporalMath';

describe('ocean detail temporal sampling', () => {
  it('uses a centred, bounded Halton pattern with an exact period', () => {
    expect(oceanTemporalJitter(0)[0]).toBeCloseTo(0, 12);
    expect(oceanTemporalJitter(0)[1]).toBeCloseTo(-1 / 6, 12);
    expect(oceanTemporalJitter(1)[0]).toBeCloseTo(-0.25, 12);
    expect(oceanTemporalJitter(1)[1]).toBeCloseTo(1 / 6, 12);

    for (let frame = 0; frame < OCEAN_TEMPORAL_JITTER_PERIOD; frame++) {
      const [x, y] = oceanTemporalJitter(frame);
      expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.5);
      expect(oceanTemporalJitter(frame + OCEAN_TEMPORAL_JITTER_PERIOD)).toEqual([x, y]);
    }
  });

  it('rejects malformed sequence coordinates', () => {
    expect(() => halton(-1, 2)).toThrow(RangeError);
    expect(() => halton(1.5, 2)).toThrow(RangeError);
    expect(() => halton(1, 1)).toThrow(RangeError);
    expect(() => oceanTemporalJitter(-1)).toThrow(RangeError);
  });

  it('round-trips signed pixel motion through the RGBA8 encoding', () => {
    const quantisationStep =
      (2 * OCEAN_TEMPORAL_MOTION_RANGE_PX) / 255;
    for (const motion of [-32, -19.25, -1, 0, 7.75, 31.9, 32]) {
      const encoded = encodeOceanMotionPixel(motion);
      const rgba8 = Math.round(encoded * 255) / 255;
      const decoded = decodeOceanMotionPixel(rgba8);
      expect(Math.abs(decoded - motion)).toBeLessThanOrEqual(
        quantisationStep * 0.5 + 1e-9,
      );
    }
  });

  it('maps the friendly stability dial nonlinearly around the tuned default', () => {
    expect(OCEAN_TEMPORAL_DEFAULT_STABILITY).toBe(50);
    expect(oceanTemporalHistoryWeight(0)).toBeCloseTo(0, 12);
    expect(oceanTemporalHistoryWeight(50)).toBeCloseTo(0.86, 12);
    expect(oceanTemporalHistoryWeight(100)).toBeCloseTo(0.9804, 4);

    // The same 50 dial points have much finer raw-weight resolution near 1.
    expect(oceanTemporalHistoryWeight(50) - oceanTemporalHistoryWeight(0))
      .toBeGreaterThan(
        oceanTemporalHistoryWeight(100) - oceanTemporalHistoryWeight(50),
      );
    expect(clampOceanTemporalStability(-20)).toBe(0);
    expect(clampOceanTemporalStability(120)).toBe(100);
    expect(clampOceanTemporalStability(Number.NaN)).toBe(50);
  });

  it('jitter touches only the procedural normal-detail coordinate', () => {
    const ocean = readFileSync('src/scene/Ocean.ts', 'utf8');
    expect(ocean).toContain('vec2 detailSample = vDetail');
    expect(ocean).toContain('dFdx(vDetail) * uTemporalDetailJitter.x');
    expect(ocean).toContain('vec2 base = mod(detailSample, uDetailWrap) * uDetailFreq');

    // Foam breakup and its diagnostics deliberately remain on the exact
    // unjittered parameter coordinate.
    expect(ocean).toContain(
      'noisedPeriodic(mod(vDetail, uDetailWrap) * (2.0 * uDetailFreq))',
    );
    expect(ocean).toContain(
      'vec3 nd = noisedPeriodic(mod(vDetail, uDetailWrap) * (2.0 * uDetailFreq))',
    );
  });

  it('reprojects deforming water and copies every non-detail pixel current', () => {
    const temporal = readFileSync('src/render/OceanTemporalResolve.ts', 'utf8');
    expect(temporal).toContain('uPreviousWaveA');
    expect(temporal).toContain('uPreviousWaveB');
    expect(temporal).toContain('uPreviousViewProjection');
    expect(temporal).toContain(
      'float previousLodRadius = length(parameterPosition - uPreviousWaveOrigin)',
    );
    expect(temporal).toContain(
      'if (uHistoryValid < 0.5 || detailStrength <= 0.001)',
    );
    expect(temporal).toContain('gl_FragColor = vec4(current.rgb, oceanVisible)');
    expect(temporal).toContain('this.renderer.setRenderTarget(this.currentColorTarget)');
    expect(temporal).not.toContain('isXRRenderTarget');
    expect(temporal).toContain('scene.overrideMaterial = this.occluderMaterial');
    expect(temporal).toContain('this.ocean.mesh.visible = false');
    expect(temporal).toContain(
      'gl_FragColor = vec4(texture2D(uResolvedColor, vUv).rgb, 1.0)',
    );
    expect(temporal).toContain('THREE.HalfFloatType');
    expect(temporal).toContain('#include <tonemapping_fragment>');
    expect(temporal).toContain('#include <colorspace_fragment>');
    expect(temporal).not.toContain('setViewOffset');
  });

  it('supports a live graphics-panel A/B and invalidates history when switched', () => {
    const temporal = readFileSync('src/render/OceanTemporalResolve.ts', 'utf8');
    const main = readFileSync('src/main.ts', 'utf8');
    const runtimeOptions = readFileSync(
      'src/runtime/RuntimeOptions.ts',
      'utf8',
    );
    const diagnostics = readFileSync(
      'src/runtime/diagnostics/SimHandle.ts',
      'utf8',
    );
    const simHandleFactory = readFileSync(
      'src/runtime/diagnostics/createSimHandle.ts',
      'utf8',
    );
    const runtimeRenderer = readFileSync(
      'src/runtime/createRenderer.ts',
      'utf8',
    );
    const panel = readFileSync('src/debug/GraphicsPanel.ts', 'utf8');

    expect(temporal).toContain('setEnabled(enabled: boolean): void');
    expect(temporal).toContain('if (enabled === this.temporalEnabled) return');
    expect(temporal).toContain('this.temporalEnabled = enabled');
    expect(temporal).toContain('this.invalidate()');
    expect(temporal).toContain('!this.temporalEnabled ||');

    expect(diagnostics).toContain(
      'setOceanTemporalEnabled(enabled: boolean): void',
    );
    expect(runtimeOptions).toContain("params.get('oceanTaa') === '1'");
    expect(main).toContain('let oceanTemporal: OceanTemporalResolve | undefined');
    expect(simHandleFactory).toContain(
      'presentation.oceanTemporal = new OceanTemporalResolve(',
    );
    expect(simHandleFactory).toContain(
      'presentation.oceanTemporal?.dispose()',
    );
    expect(simHandleFactory).toContain(
      'presentation.oceanTemporal = undefined',
    );
    expect(simHandleFactory).toContain(
      'oceanTemporalEnabled: () => presentation.oceanTemporal !== undefined',
    );
    expect(main).toContain('renderer.render(scene, cameras.camera)');
    expect(runtimeRenderer).toContain(
      'preserveDrawingBuffer: options.preserveDrawingBuffer',
    );
    // The invariant is "only capture harnesses retain the default framebuffer,
    // so ocean TAA's disabled path keeps the fast canvas". The list of capture
    // harnesses gained `?capture=1`, which is one — see `debug/captureHost.ts`,
    // where the black-frame diagnosis is written down. Production still false.
    expect(main).toContain(
      'buoyancyLabEnabled || schoonerViewerEnabled || captureHostEnabled',
    );
    expect(panel).toContain("'Ocean detail TAA'");
    expect(panel).toContain('(checked) => sim.setOceanTemporalEnabled(checked)');
    expect(panel).toContain('() => sim.oceanTemporalEnabled()');
    expect(panel).toContain("label: 'Ocean stability'");
    expect(panel).toContain(
      'onChange: (v) => sim.setOceanTemporalStability(v)',
    );
  });
});
