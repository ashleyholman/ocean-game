import { describe, expect, it } from 'vitest';
import { serializeInspectionRaySet } from '../src/debug/InspectionPanel';
import type { RecordedInspectionRay } from '../src/runtime/diagnostics/InspectionRayRecorder';

describe('the inspection ray clipboard record', () => {
  it('copies a self-identifying lossless ray set', () => {
    const ray: RecordedInspectionRay = {
      frame: 42,
      client: [101.25, 202.5],
      canvas: [91.25, 182.5],
      ndc: [-0.5, 0.25],
      worldOrigin: [1, 2, 3],
      worldDirection: [0, 0, -1],
      vesselOrigin: [0.1, 0.2, 0.3],
      vesselDirection: [0.4, 0.5, -0.6],
      hit: null,
    };

    expect(JSON.parse(serializeInspectionRaySet([ray]))).toEqual({
      kind: 'drift-inspection-ray-set',
      version: 1,
      rays: [ray],
    });
  });
});
