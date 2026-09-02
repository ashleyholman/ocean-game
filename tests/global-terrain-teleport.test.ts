import { describe, expect, it, vi } from 'vitest';
import { globalTerrainSource } from '../src/terrain/GlobalTerrainSource';
import {
  resolveGlobalTerrainTeleport,
} from '../src/terrain/globalTerrainTeleportRuntime';

const DEG = Math.PI / 180;

describe('explicit-global globe teleport policy', () => {
  it('keeps a qualified open-ocean click bit-identical', () => {
    const selected = {
      latitudeRad: -15.5 * DEG,
      longitudeRad: 152.5 * DEG,
    };
    const decision = resolveGlobalTerrainTeleport(selected);

    expect(decision.status).toBe('accepted');
    if (decision.status !== 'accepted') {
      throw new Error('expected accepted Coral Sea teleport');
    }
    expect(Object.is(decision.target.latitudeRad, selected.latitudeRad)).toBe(
      true,
    );
    expect(Object.is(decision.target.longitudeRad, selected.longitudeRad)).toBe(
      true,
    );
    expect(decision.resolution.resolvedClearanceM).toBeGreaterThanOrEqual(
      decision.resolution.profile.minimumClearanceM,
    );
  });

  it('moves a coastal-city land click to deterministic qualified water', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const selected = {
      latitudeRad: -33.8688 * DEG,
      longitudeRad: 151.2093 * DEG,
    };
    const first = resolveGlobalTerrainTeleport(selected);
    const second = resolveGlobalTerrainTeleport(selected);

    expect(first).toEqual(second);
    expect(first.status).toBe('relocated');
    if (first.status !== 'relocated') {
      throw new Error('expected relocated land teleport');
    }
    expect(
      globalTerrainSource.sample(
        first.target.latitudeRad,
        first.target.longitudeRad,
      ).surface,
    ).toBe('ocean');
    expect(first.resolution.resolvedClearanceM).toBeGreaterThanOrEqual(5_000);
    expect(first.resolution.displacementM).toBeLessThanOrEqual(100_000);
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[0]?.[0]).toMatch(
      /^\[terrain\] global teleport relocated/,
    );
    info.mockRestore();
  });

  it('rejects a continental-interior click without moving it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const decision = resolveGlobalTerrainTeleport({
      latitudeRad: -23.698 * DEG,
      longitudeRad: 133.88 * DEG,
    });

    expect(decision.status).toBe('rejected');
    expect(decision.target).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /^\[terrain\] global teleport rejected/,
    );
    warn.mockRestore();
  });
});
