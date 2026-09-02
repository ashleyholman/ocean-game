import { describe, expect, it } from 'vitest';
import { sampleInteriorCutoutHalfBreadth } from '../src/scene/interiorCutoutVolume';
import {
  BELOW_DECKS_SPACES,
  spaceDeckheadY,
  spaceSideHalfWidthAt,
} from '../src/vessel/schooner/deckInterior';
import {
  CABIN_SOLE_Y,
  COMPANION_AFT_Z,
  COMPANION_FORWARD_Z,
  COMPANION_HALF_BREADTH,
  QUARTERDECK_FORWARD_Z,
} from '../src/vessel/schooner/hullForm';
import { deckStandAt } from '../src/vessel/schooner/deckSurface';
import {
  createSchoonerInteriorCutoutVolume,
  roomCutHalfBreadthAt,
  schoonerInteriorHalfBreadthAt,
} from '../src/vessel/schooner/interiorCutoutVolume';

describe('schooner ocean interior cutout volume', () => {
  const volume = createSchoonerInteriorCutoutVolume();

  it('keeps the sampled discard inside what the field asks for', () => {
    // Probe between every stored station/height, including the sharp floor and
    // deck boundaries. The margin has to absorb sampling error everywhere or the
    // exterior can acquire a visible notch at the waterline.
    //
    // **The bound is the field, not the shell, and the two stopped being the
    // same thing when the rooms arrived.** The table is a per-cell minimum read
    // with a nearest lookup, so where a sole sits close to the turn of the hull
    // the shell's own minimum is eroded narrower than the room it is meant to
    // hide — 0.16 m at the cabin's after end, which is sea on the floor in the
    // corner where the stern windows are. `roomCutHalfBreadthAt` is the second
    // term that fixes it, and this checks the discard against both.
    //
    // Against the field's largest value **anywhere in the probe's own cell**,
    // which is the honest guarantee a nearest lookup can offer: one texel serves
    // a whole cell, so a cell straddling a boundary is as generous as its most
    // generous point. Compared instead against the field at the probe itself,
    // this can never pass at the quarterdeck break — see the next test, which is
    // where that artefact is pinned by size rather than waved away.
    const cellZ = (volume.zMax - volume.zMin) / volume.width;
    const cellY = (volume.yMax - volume.yMin) / volume.height;
    // **Memoised per cell, because the answer is per cell.** The probe grid is
    // 961 x 241 and the field it is checking is 105 x 49, so every texel gets
    // probed about 45 times — and this recomputed the same 25-point maximum over
    // the same cell each time. 11.6 million calls into the hull to establish
    // 5,145 distinct numbers, which is the whole of the minute this test used to
    // take, and it flaked against the 60 s timeout whenever the machine was
    // busy. Nothing about the coverage changes: the value is constant within a
    // cell by construction, which is the reason the cell is what gets asked.
    const cache = new Map<number, number>();
    const askedOverCell = (z: number, y: number): number => {
      const column = Math.floor((z - volume.zMin) / cellZ);
      const row = Math.floor((y - volume.yMin) / cellY);
      const key = row * (volume.width + 2) + column;
      const seen = cache.get(key);
      if (seen !== undefined) return seen;
      let most = 0;
      for (let sy = 0; sy <= 4; sy++) {
        const cy = volume.yMin + (row + sy / 4) * cellY;
        for (let sz = 0; sz <= 4; sz++) {
          const cz = volume.zMin + (column + sz / 4) * cellZ;
          most = Math.max(
            most,
            schoonerInteriorHalfBreadthAt(cz, cy),
            roomCutHalfBreadthAt(cz, cy),
          );
        }
      }
      cache.set(key, most);
      return most;
    };

    let worst = { excess: -Infinity, z: 0, y: 0, sampled: 0, asked: 0 };
    for (let yi = 0; yi <= 240; yi++) {
      const y = volume.yMin + ((volume.yMax - volume.yMin) * yi) / 240;
      for (let zi = 0; zi <= 960; zi++) {
        const z = volume.zMin + ((volume.zMax - volume.zMin) * zi) / 960;
        const asked = askedOverCell(z, y);
        const sampled = sampleInteriorCutoutHalfBreadth(volume, z, y);
        const discardedHalfWidth = Math.max(sampled - volume.margin, 0);
        const excess = discardedHalfWidth - asked;
        if (excess > worst.excess) worst = { excess, z, y, sampled, asked };
      }
    }
    expect(worst.excess, JSON.stringify(worst)).toBeLessThanOrEqual(1e-3);
  });

  it('over-cuts outside the shell only where a room forces it, and by how much', () => {
    // **The price of covering the rooms, pinned so it cannot grow quietly.**
    // A cell that straddles the quarterdeck break carries the landing's ceiling,
    // 0.55 m higher than the waist's, across the whole beam — so water washing
    // along the waist deck vanishes in a 0.155 m strip at the break. It is green
    // water 1.4–2.0 m above the design waterline, over the one place on deck that
    // already has a riser and a ladder breaking the surface up, and it is the
    // deliberate side of the trade: the alternative leaves sea on the landing's
    // sole. `interiorCutoutVolume.ts` carries the argument.
    let worst = { excess: -Infinity, z: 0, y: 0 };
    for (let yi = 0; yi <= 240; yi++) {
      const y = volume.yMin + ((volume.yMax - volume.yMin) * yi) / 240;
      for (let zi = 0; zi <= 960; zi++) {
        const z = volume.zMin + ((volume.zMax - volume.zMin) * zi) / 960;
        const sampled = sampleInteriorCutoutHalfBreadth(volume, z, y);
        const excess =
          Math.max(sampled - volume.margin, 0) - schoonerInteriorHalfBreadthAt(z, y);
        if (excess > worst.excess) worst = { excess, z, y };
      }
    }
    expect(worst.excess, JSON.stringify(worst)).toBeLessThan(2.0);
    // And it is at the break, not spread over the ship.
    expect(Math.abs(worst.z - QUARTERDECK_FORWARD_Z)).toBeLessThan(0.2);
  });

  it('covers every room, at every height in it', () => {
    // The guarantee the whole mechanism exists for, stated as itself rather than
    // as a property of the cabin. It was the cabin's alone until M4's furnishing
    // slice put floors over the hold and in the bow.
    let worst = { shortfall: -Infinity, space: '', z: 0, y: 0 };
    for (const space of BELOW_DECKS_SPACES) {
      for (let i = 0; i <= 200; i++) {
        const z = space.zAft + ((space.zForward - space.zAft) * i) / 200;
        const head = spaceDeckheadY(space, 0, z);
        if (head === null) continue;
        for (let y = space.soleY; y <= head; y += 0.03) {
          const cut = Math.max(
            sampleInteriorCutoutHalfBreadth(volume, z, y) - volume.margin,
            0,
          );
          const shortfall = spaceSideHalfWidthAt(space, z, y, false) - cut;
          if (shortfall > worst.shortfall) {
            worst = { shortfall, space: space.name, z, y };
          }
        }
      }
    }
    // Float32, because the table is what the GPU reads and the room width is
    // computed in double. A micrometre is the whole of the disagreement.
    expect(worst.shortfall, JSON.stringify(worst)).toBeLessThanOrEqual(1e-6);
  });

  it('clears the companionway column up to the weather deck', () => {
    for (let zi = 0; zi <= 24; zi++) {
      const z =
        COMPANION_AFT_Z +
        ((COMPANION_FORWARD_Z - COMPANION_AFT_Z) * zi) / 24;
      const deck = deckStandAt(0, z);
      expect(deck).not.toBeNull();
      // Stop one conservative vertical cell below the deck boundary. That last
      // sub-cell is behind the deck timber; every visible room height must clear
      // the full hatch width.
      const cellY = (volume.yMax - volume.yMin) / volume.height;
      for (let y = CABIN_SOLE_Y; y <= deck!.y - cellY; y += 0.04) {
        const cut = Math.max(
          sampleInteriorCutoutHalfBreadth(volume, z, y) - volume.margin,
          0,
        );
        expect(cut).toBeGreaterThan(COMPANION_HALF_BREADTH);
      }
    }
  });

  it('stores a finite compact RGBA field', () => {
    expect(volume.data.length).toBe(volume.width * volume.height * 4);
    expect(volume.data.byteLength).toBeLessThan(96 * 1024);
    expect(Array.from(volume.data).every(Number.isFinite)).toBe(true);
  });
});
