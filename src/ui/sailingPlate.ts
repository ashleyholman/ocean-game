/**
 * The points-of-sail plate: the one drawing in the manual that teaches anything.
 *
 * WHAT IT SHOWS, AND WHAT IT DELIBERATELY DOES NOT
 * ------------------------------------------------
 * The wind comes from the top. A shaded wedge over the bow is where she will not
 * go. Round the rest of the circle, the vessel is drawn at each point with her
 * booms where the trim schedule would actually set them, and the length of each
 * ray says how she goes there — long for a reach, short for a beat.
 *
 * **No figures.** That was Ash's call and it is the right one twice over. A
 * plate with knots on it is a plate that can go stale — the polar baseline this
 * would have to read is a heavy offline run and is currently out of date — and a
 * number printed in a period manual is a promise the model has to keep for as
 * long as the drawing exists. A shape cannot go stale in the same way: the wedge
 * is where she will not point, a reach is faster than a beat, and both of those
 * remain true whatever the coefficient round does to the speeds.
 *
 * It is also simply the better drawing. The thing a player needs from this is
 * *the shape of where you can go*, and a ring of numbers is a table pretending
 * to be a diagram.
 *
 * WHERE THE ANGLES COME FROM
 * --------------------------
 * `SailingPolarEvidence.ts` sweeps 0–180° off the bow in 15° steps, and its own
 * note records that with the trim schedule's 20° sheeting floor "the sector
 * opens ≈35–40°". The wedge here is drawn to 40° either side, which is the
 * outside of that range — a manual that promises more pointing than the ship has
 * is a manual that gets a player caught in irons.
 *
 * The ray lengths are the *shape* of that same sweep: nothing off the wind at
 * 45°, best on a broad reach, falling away again dead before the wind where a
 * fore-and-aft rig blankets its own headsails. They are proportions, not
 * measurements, and the module says so rather than implying otherwise by being
 * precise.
 *
 * WHY IT IS DRAWN IN SVG AND NOT IN THE WORLD
 * -------------------------------------------
 * Because it is a page, and a page has type on it. A plate on a texture at a
 * seated player's viewing angle is a plate you cannot read the labels of, and
 * every technique for fixing that is a technique for approximating what a
 * vector drawing already is.
 */

/** One point of sail, as the plate draws it. */
interface Point {
  /** Degrees off the true wind, 0 = dead into it. */
  readonly off: number;
  readonly label: string;
  /**
   * How far out from the centre the ray reaches, 0–1.
   *
   * A proportion and never a speed. See the module note.
   */
  readonly reach: number;
  /**
   * How far the boom is off the centreline, degrees.
   *
   * The trim schedule's own shape: sheeted hard on the wind — but never flatter
   * than 20°, which is this rig's pointing limit and the reason the wedge is as
   * wide as it is — and squared right off before the wind.
   */
  readonly boom: number;
}

const POINTS: readonly Point[] = [
  /**
   * **50° and not the 45° this was drawn at first**, for two reasons that point
   * the same way.
   *
   * The drawing one: with the wedge at 40° a close-hauled vessel at 45° sits
   * five degrees off its own shaded edge, which at this radius is twelve pixels
   * — so the plate showed two little ships apparently sailing *inside* the
   * quarter it had just told you not to sail in.
   *
   * The truthful one, which is why the fix went here rather than into the
   * wedge: 45° is sloop pointing. A gaff schooner tacks through 100–110°, and
   * `SailingPolarEvidence`'s own note records what happened when this model let
   * her do better — "modern-sloop pointing from a gaff schooner, and the S3
   * no-go gate blew". The gap the plate now shows between the wedge and the
   * close-hauled ships is real: she *can* be pointed to 40°, and she will not
   * go anywhere useful until 50.
   */
  { off: 50, label: 'CLOSE HAULED', reach: 0.56, boom: 20 },
  { off: 70, label: 'CLOSE REACH', reach: 0.80, boom: 34 },
  { off: 90, label: 'BEAM REACH', reach: 0.94, boom: 50 },
  { off: 135, label: 'BROAD REACH', reach: 1.0, boom: 70 },
  { off: 180, label: 'RUNNING', reach: 0.72, boom: 85 },
];

/** Half-angle of the wedge she will not sail in. See the module note. */
const NO_GO_DEG = 40;

/**
 * The rose, and the room the page has to leave round it.
 *
 * **The margins are set by the type, not by the circle**, which is what the
 * first cut got wrong in both axes at once: the labels ran off the right-hand
 * edge mid-word ("CLOSE REA…") and "THE WIND" sat above the top of the box
 * entirely. A plate is a rose plus the widest word beside it plus the wind
 * stack over it, and the viewBox has to be sized to that sum rather than to the
 * drawing everyone pictures when they think about it.
 *
 * 760 × 660 leaves ~180 px to the right of the label anchors (which is
 * "CLOSE HAULED" set at 15 px with 0.16em of tracking) and 120 px over the rim
 * for the arrow, its shaft and its caption.
 */
const RADIUS = 210;
const CENTRE_X = 306;
const CENTRE_Y = 336;
const HUB = 46;

const RAD = Math.PI / 180;

/** A point on the rose. Bearing 0 is straight up, into the wind. */
function polar(bearingDeg: number, distance: number): [number, number] {
  return [
    CENTRE_X + Math.sin(bearingDeg * RAD) * distance,
    CENTRE_Y - Math.cos(bearingDeg * RAD) * distance,
  ];
}

function fmt(n: number): string {
  return n.toFixed(1);
}

/**
 * A little fore-and-aft vessel, seen from above, drawn heading straight up her
 * own ray with her booms `boom` degrees off the centreline.
 *
 * She carries no heading of her own: the caller has already rotated the frame
 * to the point of sail, so a heading here would be applied twice.
 *
 * Drawn rather than iconified: the whole content of this plate is *what the
 * sails are doing*, and a dot with a line through it does not say it.
 */
function vessel(boom: number, scale: number): string {
  // Hull: a pointed oval, bow toward the heading. Drawn in its own frame and
  // rotated, so the sail geometry below is written the way a rig is — off the
  // centreline — rather than in screen angles.
  const hull =
    `M0 ${fmt(-16 * scale)}` +
    `C ${fmt(7 * scale)} ${fmt(-7 * scale)} ${fmt(7 * scale)} ${fmt(9 * scale)} ${fmt(4 * scale)} ${fmt(16 * scale)}` +
    `L ${fmt(-4 * scale)} ${fmt(16 * scale)}` +
    `C ${fmt(-7 * scale)} ${fmt(9 * scale)} ${fmt(-7 * scale)} ${fmt(-7 * scale)} 0 ${fmt(-16 * scale)} Z`;
  // Two booms, main and fore, both to leeward — which for a wind from the top
  // and a vessel heading away to starboard is the port side of her centreline.
  const mainX = Math.sin(boom * RAD) * 21 * scale;
  const mainY = Math.cos(boom * RAD) * 21 * scale;
  const foreX = Math.sin(boom * RAD) * 15 * scale;
  const foreY = Math.cos(boom * RAD) * 15 * scale;
  return (
    `<g class="plate-vessel">` +
    `<path class="plate-hull" d="${hull}"/>` +
    `<line class="plate-boom" x1="0" y1="${fmt(4 * scale)}" x2="${fmt(-mainX)}" y2="${fmt(4 * scale + mainY)}"/>` +
    `<line class="plate-boom" x1="0" y1="${fmt(-9 * scale)}" x2="${fmt(-foreX)}" y2="${fmt(-9 * scale + foreY)}"/>` +
    `</g>`
  );
}

/**
 * The plate, as a standalone SVG string.
 *
 * Both hands of the ship are drawn — the same five points mirrored — because
 * the first thing a plate like this has to say is that the picture is
 * symmetrical and you may take either tack. A single-sided rose reads as a
 * statement that one of them is different.
 */
export function sailingPlateSvg(): string {
  const parts: string[] = [];

  // The wedge, first, so everything else draws over it.
  const [wx1, wy1] = polar(-NO_GO_DEG, RADIUS);
  const [wx2, wy2] = polar(NO_GO_DEG, RADIUS);
  parts.push(
    `<path class="plate-nogo" d="M${CENTRE_X} ${CENTRE_Y} L${fmt(wx1)} ${fmt(wy1)} ` +
      `A${RADIUS} ${RADIUS} 0 0 1 ${fmt(wx2)} ${fmt(wy2)} Z"/>`,
  );
  parts.push(
    `<text class="plate-nogo-label" x="${CENTRE_X}" y="${CENTRE_Y - RADIUS * 0.55}">` +
      `NO ROAD<tspan x="${CENTRE_X}" dy="19">THIS WAY</tspan></text>`,
  );

  // The rim.
  parts.push(
    `<circle class="plate-rim" cx="${CENTRE_X}" cy="${CENTRE_Y}" r="${RADIUS}"/>`,
  );

  for (const side of [1, -1] as const) {
    for (const point of POINTS) {
      // 180° is dead astern and is on neither tack; drawn once.
      if (point.off === 180 && side === -1) continue;
      const bearing = side * point.off;
      const end = HUB + (RADIUS - HUB) * point.reach;
      const [rx, ry] = polar(bearing, end);
      const [hx, hy] = polar(bearing, HUB);
      parts.push(
        `<line class="plate-ray" x1="${fmt(hx)}" y1="${fmt(hy)}" x2="${fmt(rx)}" y2="${fmt(ry)}"/>`,
      );

      // The vessel sits at the end of her ray, heading outward along it, with
      // her booms to leeward — which flips with the tack, hence the mirror.
      const scale = 1;
      parts.push(
        `<g transform="translate(${fmt(rx)} ${fmt(ry)}) rotate(${fmt(bearing)}) scale(${side} 1)">` +
          vessel(point.boom, scale) +
          `</g>`,
      );

      // Labels on the starboard side only. Twice round the rose is the same
      // five words said twice, and a plate crowded with repeated type is one
      // nobody reads.
      if (side === 1) {
        const [lx, ly] = polar(bearing, RADIUS + 30);
        const anchor = point.off === 180 ? 'middle' : 'start';
        parts.push(
          `<text class="plate-point" x="${fmt(lx)}" y="${fmt(ly)}" text-anchor="${anchor}">` +
            `${point.label}</text>`,
        );
      }
    }
  }

  // The wind, over the top, with its arrow coming down into the rose. This is
  // the one thing on the plate that must not be ambiguous: every angle here is
  // measured from it.
  parts.push(
    `<line class="plate-wind" x1="${CENTRE_X}" y1="${CENTRE_Y - RADIUS - 74}" ` +
      `x2="${CENTRE_X}" y2="${CENTRE_Y - RADIUS - 14}"/>`,
    `<path class="plate-wind-head" d="M${CENTRE_X - 8} ${CENTRE_Y - RADIUS - 26} ` +
      `L${CENTRE_X} ${CENTRE_Y - RADIUS - 10} L${CENTRE_X + 8} ${CENTRE_Y - RADIUS - 26} Z"/>`,
    `<text class="plate-wind-label" x="${CENTRE_X}" y="${CENTRE_Y - RADIUS - 84}">THE WIND</text>`,
  );

  // The hub: her own vessel, head to wind, dead in the water. The joke and the
  // lesson in one mark — this is the middle of the wedge.
  parts.push(
    `<circle class="plate-hub" cx="${CENTRE_X}" cy="${CENTRE_Y}" r="${HUB}"/>`,
    `<g transform="translate(${CENTRE_X} ${CENTRE_Y})">` +
      `<path class="plate-hull" d="M0 -20 C 9 -9 9 11 5 20 L -5 20 C -9 11 -9 -9 0 -20 Z"/>` +
      `<line class="plate-boom" x1="0" y1="5" x2="0" y2="27"/>` +
      `</g>`,
    `<text class="plate-irons" x="${CENTRE_X}" y="${CENTRE_Y + HUB + 24}">IN IRONS</text>`,
  );

  return (
    `<svg class="plate" viewBox="0 0 760 660" role="img" ` +
    `aria-label="Points of sail: the wind from the top, a shaded wedge over the bow ` +
    `where she will not sail, and the vessel drawn at five points either side with ` +
    `her booms set for each.">${parts.join('')}</svg>`
  );
}
