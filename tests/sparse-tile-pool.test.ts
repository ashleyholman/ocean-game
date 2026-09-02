import { describe, expect, it } from 'vitest';
import {
  SparseTilePool,
  createSparseAtlasLayout,
} from '../src/scene/SparseTilePool';

describe('sparse cloud tile pool', () => {
  it('keeps retained mappings stable and reuses evicted slots', () => {
    const pool = new SparseTilePool(12, 4);
    const first = pool.reconcile([3, 4, 5]);
    expect(first.allocated).toEqual([3, 4, 5]);
    expect(first.evicted).toEqual([]);
    const slot4 = pool.slotFor(4);
    const slot5 = pool.slotFor(5);

    const second = pool.reconcile([4, 5, 6, 7]);
    expect(second.evicted).toEqual([3]);
    expect(second.allocated).toEqual([6, 7]);
    expect(second.unmapped).toEqual([]);
    expect(pool.slotFor(4)).toBe(slot4);
    expect(pool.slotFor(5)).toBe(slot5);
    expect(pool.residentCount).toBe(4);
  });

  it('uses required order as overflow priority', () => {
    const pool = new SparseTilePool(10, 3);
    const delta = pool.reconcile([8, 2, 7, 1, 8]);
    expect(delta.allocated).toEqual([8, 2, 7]);
    expect(delta.unmapped).toEqual([1]);
    expect(pool.slotFor(8)).toBeGreaterThanOrEqual(0);
    expect(pool.slotFor(1)).toBe(-1);
  });

  it('evicts a resident guard tile when a new visible tile outranks it', () => {
    const pool = new SparseTilePool(10, 3);
    pool.reconcile([7, 1, 2]);

    const delta = pool.reconcile([8, 7, 1, 2]);

    expect(delta.evicted).toEqual([2]);
    expect(delta.allocated).toEqual([8]);
    expect(delta.unmapped).toEqual([2]);
    expect(pool.slotFor(8)).toBeGreaterThanOrEqual(0);
    expect(pool.slotFor(2)).toBe(-1);
  });

  it('drops tiles outside the new guard instead of retaining a hidden pool', () => {
    const pool = new SparseTilePool(20, 8);
    pool.reconcile([0, 1, 2, 3, 4, 5]);
    const delta = pool.reconcile([10, 11]);
    expect(delta.evicted).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pool.residentCount).toBe(2);
  });

  it('packs production pools below common texture-size limits', () => {
    const desktop = createSparseAtlasLayout(120, 256, 128);
    expect(desktop).toMatchObject({
      columns: 8,
      rows: 15,
      slotWidth: 258,
      slotHeight: 130,
      width: 2064,
      height: 1950,
    });

    const mobile = createSparseAtlasLayout(64, 256, 128);
    expect(mobile).toMatchObject({
      columns: 6,
      rows: 11,
      width: 1548,
      height: 1430,
    });
    expect(desktop.width).toBeLessThanOrEqual(4096);
    expect(desktop.height).toBeLessThanOrEqual(4096);
  });
});
