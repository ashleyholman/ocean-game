import { describe, expect, it } from 'vitest';
import { sailingPlateSvg } from '../src/ui/sailingPlate';

/**
 * The manual's one teaching drawing.
 *
 * **What these can and cannot prove.** They cannot say the plate is beautiful,
 * or legible, or that the little ships read as ships — that is Ash's eye and
 * nothing here substitutes for it. What they can hold is the thing a drawing
 * about sailing must not get wrong: that its shaded quarter and its labelled
 * points agree with the ship the player is actually sailing, and that they stay
 * agreeing when somebody nudges a number.
 */
describe('the points-of-sail plate', () => {
  const svg = sailingPlateSvg();

  it('names every point once, on one hand of the ship', () => {
    for (const label of [
      'CLOSE HAULED',
      'CLOSE REACH',
      'BEAM REACH',
      'BROAD REACH',
      'RUNNING',
    ]) {
      // Once, not twice: the rose is drawn on both tacks and the labels are
      // not, because the same five words said twice is a plate nobody reads.
      expect(svg.split(label).length - 1, `${label} appears the wrong number of times`).toBe(1);
    }
  });

  it('says which way the wind is, and where she will not go', () => {
    expect(svg).toContain('THE WIND');
    expect(svg).toContain('NO ROAD');
    expect(svg).toContain('IN IRONS');
    expect(svg).toContain('plate-nogo');
  });

  it('keeps every mark inside the box the page gives it', () => {
    // The fault this replaces was visible and mundane: labels ran off the right
    // edge mid-word ("CLOSE REA…") and "THE WIND" sat above the top of the
    // viewBox. A viewBox is a promise about the extent of the drawing, and
    // nothing in SVG enforces it — content outside is simply clipped, silently.
    //
    // **Only root-frame marks are checked**, and the first cut of this test did
    // not know that. The little vessels are drawn inside a
    // `translate(...) rotate(...)` group in their own local coordinates, where a
    // boom at x = −7.2 is not out of the box at all; scanning every attribute
    // in the file failed on geometry that was perfectly placed. What escaped
    // was type and the wind's arrow, both of which are in the root frame — so
    // that is what this holds.
    const box = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    expect(box).not.toBeNull();
    const width = Number(box![1]);
    const height = Number(box![2]);

    // Every label, and a generous allowance for the type that hangs off its
    // own anchor: `text-anchor: start` at 15px with 0.16em of tracking runs
    // about 13 px a character, and the longest is "CLOSE HAULED".
    const LONGEST_LABEL_PX = 13 * 12;
    for (const [, xs, ys] of svg.matchAll(/<text[^>]*\sx="(-?[\d.]+)"\sy="(-?[\d.]+)"/g)) {
      const x = Number(xs);
      const y = Number(ys);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + LONGEST_LABEL_PX).toBeLessThanOrEqual(width);
      // A line of type sits above its own baseline, and "THE WIND" was clipped
      // by exactly that much.
      expect(y - 20).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(height);
    }

    // The wind's shaft and arrowhead, which are the topmost marks on the plate.
    const shaft = svg.match(/class="plate-wind"[^>]*y1="(-?[\d.]+)"/);
    expect(shaft).not.toBeNull();
    expect(Number(shaft![1])).toBeGreaterThanOrEqual(0);
  });

  it('draws no vessel inside its own no-go wedge', () => {
    // **The one that matters.** The plate's whole claim is "not here", and a
    // close-hauled ship drawn inside the shaded quarter contradicts it in the
    // same picture. The first cut put close-hauled at 45° against a 40° wedge —
    // technically outside, and twelve pixels of clearance at this radius, which
    // read as inside.
    //
    // Checked by geometry rather than by re-reading the constants: every vessel
    // is placed by a `rotate(...)` about the rose's centre, so the bearings are
    // in the markup and can be compared against the wedge the markup also
    // carries.
    const bearings = [...svg.matchAll(/rotate\((-?[\d.]+)\)/g)].map(([, v]) => Math.abs(Number(v)));
    expect(bearings.length).toBeGreaterThan(0);

    // The wedge's own half-angle, recovered from the arc endpoints the path
    // uses rather than from a constant this test also owns.
    const wedge = svg.match(/class="plate-nogo" d="M([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+)/);
    expect(wedge).not.toBeNull();
    const cx = Number(wedge![1]);
    const cy = Number(wedge![2]);
    const halfAngle = Math.abs(
      (Math.atan2(Number(wedge![3]) - cx, cy - Number(wedge![4])) * 180) / Math.PI,
    );
    expect(halfAngle).toBeGreaterThan(30);
    expect(halfAngle).toBeLessThan(45);

    for (const bearing of bearings) {
      // Clear of the wedge by a margin a reader can see, not by a rounding.
      expect(bearing, 'a vessel is drawn in the no-go wedge').toBeGreaterThan(halfAngle + 6);
    }
  });
});
