import type { Offset } from './hullForm';

/**
 * A schooner station's cross-section and immersion under a sloping water plane.
 *
 * The shared body delegates section immersion to each vessel. A carvel hull
 * has no closed form, so this section is carried as a polygon and clipped.
 *
 * WHY THE WATER PLANE SLOPES
 * --------------------------
 * A five-metre section cannot resolve transverse effects with a coarse set of
 * independent point samples, and it does not have to.
 * Both effects are, to first order, a single linear slope of the water surface
 * across the section — the ship's own heel plus the wave's transverse gradient —
 * so the section is clipped against an *inclined* line instead of a level one
 * and integrated exactly. `BuoyantBody` computes that slope; see the derivation
 * on `waterSlopeAcrossBeam` there.
 *
 * This matters for more than accuracy. At heel, a ship's immersed area shifts
 * transversely, and that shift is precisely where form stability comes from. A
 * shaped hull has BM = I/V and a real roll
 * period. Returning the immersed *centroid* rather than assuming the section's
 * own centreline is what makes the righting moment emerge from the shape
 * instead of being asserted.
 */

/** Result of clipping a section against the water. Reused; never allocated. */
export interface SectionImmersion {
  /** Immersed cross-sectional area, m². */
  area: number;
  /** Local x of the immersed area's centroid — the roll moment arm. */
  centroidX: number;
  /** Local y of the immersed area's centroid. */
  centroidY: number;
  /** Waterline chord across the section, m. Contributes to waterplane area. */
  chord: number;
  /** Number of crossings represented by the starboard/port extremes below. */
  waterlineContactCount: number;
  waterlineStarboardX: number;
  waterlineStarboardY: number;
  waterlinePortX: number;
  waterlinePortY: number;
}

export function createSectionImmersion(): SectionImmersion {
  return {
    area: 0,
    centroidX: 0,
    centroidY: 0,
    chord: 0,
    waterlineContactCount: 0,
    waterlineStarboardX: 0,
    waterlineStarboardY: 0,
    waterlinePortX: 0,
    waterlinePortY: 0,
  };
}

/** Anything that can be clipped against the water at a station. */
export interface Section {
  /** Highest point — the edge water must cross to come aboard. */
  readonly crownY: number;
  /** Lowest point. Brackets the equilibrium waterline solve. */
  readonly floorY: number;
  immerse(waterLocalY: number, slope: number, out: SectionImmersion): void;
}

/** How close to the cut line a clipped vertex must be to count as on it. */
const ON_LINE = 1e-9;

export class HullSection implements Section {
  /** Closed section polygon, counter-clockwise, in local (x, y). */
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly count: number;

  // Clip scratch. A convex cut adds at most two vertices; the +4 is slack for
  // a section that is not convex through the turn of the bilge.
  private readonly cx: Float64Array;
  private readonly cy: Float64Array;

  /** Highest point of the section — the deck edge water must cross to board. */
  readonly crownY: number;
  /** Lowest point — the rise of floor. */
  readonly floorY: number;
  /** Maximum half-breadth anywhere in the section. */
  readonly maxHalfBeam: number;

  constructor(offsets: readonly Offset[]) {
    if (offsets.length < 2) throw new Error('a station needs at least two offsets');

    // Port side upward, across the deck, starboard side downward. The bottom
    // vertex is shared when the section closes to the keel, which is the normal
    // case; duplicating it there would put a zero-length edge in the fan.
    const n = offsets.length;
    const closesAtKeel = offsets[0].halfBreadth <= ON_LINE;
    const total = closesAtKeel ? 2 * n - 1 : 2 * n;

    this.px = new Float64Array(total);
    this.py = new Float64Array(total);
    this.count = total;

    let w = 0;
    for (let i = 0; i < n; i++) {
      this.px[w] = offsets[i].halfBreadth;
      this.py[w] = offsets[i].y;
      w++;
    }
    for (let i = n - 1; i >= (closesAtKeel ? 1 : 0); i--) {
      this.px[w] = -offsets[i].halfBreadth;
      this.py[w] = offsets[i].y;
      w++;
    }

    this.cx = new Float64Array(total + 4);
    this.cy = new Float64Array(total + 4);

    this.floorY = offsets[0].y;
    this.crownY = offsets[n - 1].y;
    let widest = 0;
    for (const o of offsets) widest = Math.max(widest, o.halfBreadth);
    this.maxHalfBeam = widest;
  }

  /** Area of the whole section, m². Used to normalise immersion ratios. */
  get fullArea(): number {
    return polygonArea(this.px, this.py, this.count);
  }

  /**
   * Clip the section against the water and report the immersed area, its
   * centroid, and the waterline chord.
   *
   * The water surface is the line `y = waterLocalY + slope * x` in section
   * coordinates: `waterLocalY` is its height on the section's centreline and
   * `slope` its gradient across the beam. Everything below it is immersed.
   */
  immerse(waterLocalY: number, slope: number, out: SectionImmersion): void {
    const { px, py, count, cx, cy } = this;

    // Sutherland-Hodgman against the single half-plane f <= 0, where
    // f(p) = p.y - slope * p.x - waterLocalY.
    let w = 0;
    let ax = px[count - 1];
    let ay = py[count - 1];
    let fa = ay - slope * ax - waterLocalY;

    for (let i = 0; i < count; i++) {
      const bx = px[i];
      const by = py[i];
      const fb = by - slope * bx - waterLocalY;

      if (fa <= 0) {
        cx[w] = ax;
        cy[w] = ay;
        w++;
      }
      if (fa <= 0 !== fb <= 0) {
        const t = fa / (fa - fb);
        cx[w] = ax + (bx - ax) * t;
        cy[w] = ay + (by - ay) * t;
        w++;
      }
      ax = bx;
      ay = by;
      fa = fb;
    }

    if (w < 3) {
      out.area = 0;
      out.centroidX = 0;
      out.centroidY = 0;
      out.chord = 0;
      out.waterlineContactCount = 0;
      return;
    }

    // Shoelace area and centroid in one pass.
    let twiceArea = 0;
    let cxAcc = 0;
    let cyAcc = 0;
    for (let i = 0; i < w; i++) {
      const j = i + 1 === w ? 0 : i + 1;
      const cross = cx[i] * cy[j] - cx[j] * cy[i];
      twiceArea += cross;
      cxAcc += (cx[i] + cx[j]) * cross;
      cyAcc += (cy[i] + cy[j]) * cross;
    }

    const area = twiceArea * 0.5;
    if (Math.abs(area) < 1e-12) {
      out.area = 0;
      out.centroidX = 0;
      out.centroidY = 0;
      out.chord = 0;
      out.waterlineContactCount = 0;
      return;
    }

    out.area = Math.abs(area);
    out.centroidX = cxAcc / (3 * twiceArea);
    out.centroidY = cyAcc / (3 * twiceArea);

    // The chord is whatever edges of the clipped polygon lie *on* the cut line.
    // Sutherland-Hodgman emits the two intersection points consecutively, so a
    // convex section gives exactly one such edge; summing handles the rest.
    let chord = 0;
    let contactCount = 0;
    let starboardX = Infinity;
    let starboardY = 0;
    let portX = -Infinity;
    let portY = 0;
    for (let i = 0; i < w; i++) {
      const j = i + 1 === w ? 0 : i + 1;
      const fi = cy[i] - slope * cx[i] - waterLocalY;
      const fj = cy[j] - slope * cx[j] - waterLocalY;
      if (Math.abs(fi) < 1e-7 && Math.abs(fj) < 1e-7) {
        chord += Math.hypot(cx[j] - cx[i], cy[j] - cy[i]);
        if (cx[i] < starboardX) {
          starboardX = cx[i];
          starboardY = cy[i];
        }
        if (cx[j] < starboardX) {
          starboardX = cx[j];
          starboardY = cy[j];
        }
        if (cx[i] > portX) {
          portX = cx[i];
          portY = cy[i];
        }
        if (cx[j] > portX) {
          portX = cx[j];
          portY = cy[j];
        }
        contactCount = 2;
      }
    }
    out.chord = chord;
    out.waterlineContactCount = contactCount;
    if (contactCount > 0) {
      out.waterlineStarboardX = starboardX;
      out.waterlineStarboardY = starboardY;
      out.waterlinePortX = portX;
      out.waterlinePortY = portY;
    }
  }
}

/**
 * Several sections at one station, immersed as one body.
 *
 * A station of the schooner is not a single polygon: below the moulded body's
 * rabbet lie the backbone and, aft, the rudder. They are disjoint slabs of
 * different widths, so they are clipped separately and summed here — once,
 * rather than at each of the four places that integrate a station.
 *
 * The centroid is area-weighted, which is what makes the righting moment come
 * out right: the appendages sit on the centreline and contribute area with no
 * transverse arm, so they correctly dilute the form stability the moulded
 * sections generate rather than adding to it.
 */
export class CompositeSection implements Section {
  readonly crownY: number;
  readonly floorY: number;

  private readonly scratch: SectionImmersion = createSectionImmersion();

  constructor(private readonly parts: readonly Section[]) {
    if (parts.length === 0) throw new Error('a composite station needs a section');
    let crown = -Infinity;
    let floor = Infinity;
    for (const p of parts) {
      crown = Math.max(crown, p.crownY);
      floor = Math.min(floor, p.floorY);
    }
    this.crownY = crown;
    this.floorY = floor;
  }

  immerse(waterLocalY: number, slope: number, out: SectionImmersion): void {
    let area = 0;
    let momentX = 0;
    let momentY = 0;
    let chord = 0;
    let contactCount = 0;
    let starboardX = Infinity;
    let starboardY = 0;
    let portX = -Infinity;
    let portY = 0;

    for (const part of this.parts) {
      part.immerse(waterLocalY, slope, this.scratch);
      area += this.scratch.area;
      momentX += this.scratch.area * this.scratch.centroidX;
      momentY += this.scratch.area * this.scratch.centroidY;
      chord += this.scratch.chord;
      if (this.scratch.waterlineContactCount > 0) {
        contactCount += this.scratch.waterlineContactCount;
        if (this.scratch.waterlineStarboardX < starboardX) {
          starboardX = this.scratch.waterlineStarboardX;
          starboardY = this.scratch.waterlineStarboardY;
        }
        if (this.scratch.waterlinePortX > portX) {
          portX = this.scratch.waterlinePortX;
          portY = this.scratch.waterlinePortY;
        }
      }
    }

    out.area = area;
    out.centroidX = area > 0 ? momentX / area : 0;
    out.centroidY = area > 0 ? momentY / area : 0;
    out.chord = chord;
    out.waterlineContactCount = contactCount;
    if (contactCount > 0) {
      out.waterlineStarboardX = starboardX;
      out.waterlineStarboardY = starboardY;
      out.waterlinePortX = portX;
      out.waterlinePortY = portY;
    }
  }
}

function polygonArea(px: Float64Array, py: Float64Array, count: number): number {
  let twice = 0;
  for (let i = 0; i < count; i++) {
    const j = i + 1 === count ? 0 : i + 1;
    twice += px[i] * py[j] - px[j] * py[i];
  }
  return Math.abs(twice) * 0.5;
}
