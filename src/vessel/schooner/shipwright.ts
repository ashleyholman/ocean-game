import * as THREE from 'three';

/**
 * The schooner shipwright's geometry primitives.
 *
 * `docs/ship/SHIP_ROUND_HANDOVER.md` section 3.2: build a primitive layer, then author the
 * ship as data. This is the layer. It knows how to turn grids of points into
 * geometry and nothing whatever about schooners — the ship itself is
 * `shipGeometry.ts`, which reads the hull form and the backbone and says where
 * the points go.
 *
 * WHY NORMALS ARE PASSED IN RATHER THAN COMPUTED
 * ----------------------------------------------
 * The obvious approach is `computeVertexNormals()` on the finished geometry.
 * It cannot work here. The hull is split into paint regions — below-waterline,
 * boot-top, topsides, wales — and each region is a separate geometry with a
 * separate material. Topology-derived normals stop at a geometry boundary, so
 * every paint seam would light as a hard crease: a visible ridge running the
 * length of the ship exactly where the boot-top meets the topsides, on a hull
 * that is perfectly smooth there.
 *
 * So the caller supplies normals derived from the *surface*, not the mesh. The
 * hull is an analytic function; its normal at a point is a property of the
 * function and is identical either side of a paint boundary. The seams then
 * light as what they are — a change of colour on continuous planking.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

/** RGB in linear-ish sRGB space, matching how `THREE.Color` is authored here. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Accumulates triangles for one material region.
 *
 * One builder per paint region; `toGeometry` hands back a single indexed
 * `BufferGeometry`, which is one draw call. The budget in the handover's
 * section 5 is held by there being few regions, not by merging afterwards.
 */
export class SurfaceBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colours: number[] = [];
  private readonly indices: number[] = [];

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get isEmpty(): boolean {
    return this.indices.length === 0;
  }

  /**
   * Empty the builder while keeping the arrays it has already grown.
   *
   * For the rig's per-frame re-loft: a build that runs 60 times a second
   * cannot afford to allocate its backing store 60 times a second, and after
   * the first build these arrays are already exactly the size the next one
   * needs.
   */
  reset(): void {
    this.positions.length = 0;
    this.normals.length = 0;
    this.colours.length = 0;
    this.indices.length = 0;
  }

  /**
   * Overwrite an existing geometry's buffers in place, if it is the same
   * shape. Returns false — having changed nothing — when it is not, which is
   * the caller's signal to take a fresh `toGeometry()` instead.
   *
   * The rig's live half only changes vertex count when a sail crosses
   * furled, so the ordinary frame writes into the buffers that are already
   * on the GPU and the whole rebuild allocates nothing at all.
   */
  writeInto(geometry: THREE.BufferGeometry): boolean {
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    if (!position || !index) return false;
    if (position.count * 3 !== this.positions.length) return false;
    if (index.count !== this.indices.length) return false;
    const write = (name: string, source: number[]): void => {
      const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
      const array = attribute.array as Float32Array;
      for (let i = 0; i < source.length; i++) array[i] = source[i];
      attribute.needsUpdate = true;
    };
    write('position', this.positions);
    write('normal', this.normals);
    write('color', this.colours);
    const indices = index.array as Uint16Array | Uint32Array;
    for (let i = 0; i < this.indices.length; i++) indices[i] = this.indices[i];
    index.needsUpdate = true;
    geometry.computeBoundingSphere();
    return true;
  }

  private push(p: Vec3, n: Vec3, c: Rgb): number {
    const index = this.positions.length / 3;
    this.positions.push(p.x, p.y, p.z);
    this.normals.push(n.x, n.y, n.z);
    this.colours.push(c.r, c.g, c.b);
    return index;
  }

  /**
   * Append one triangle unless its three positions collapse to a line or point.
   *
   * Collapsed paint bands are useful to callers because they keep row identity
   * stable at the ends of a loft. They are not useful to the GPU or to topology:
   * indexing them creates zero-area faces whose edges can masquerade as cracks
   * in a manifold audit. Keep the vertices (neighbouring faces may use them),
   * but never turn a collapsed cell into a triangle.
   */
  private triangle(a: number, b: number, c: number): void {
    const ax = this.positions[a * 3];
    const ay = this.positions[a * 3 + 1];
    const az = this.positions[a * 3 + 2];
    const ux = this.positions[b * 3] - ax;
    const uy = this.positions[b * 3 + 1] - ay;
    const uz = this.positions[b * 3 + 2] - az;
    const vx = this.positions[c * 3] - ax;
    const vy = this.positions[c * 3 + 1] - ay;
    const vz = this.positions[c * 3 + 2] - az;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz <= 1e-20) return;
    this.indices.push(a, b, c);
  }

  /**
   * A quad-grid patch: `points[i][j]` with matching normals and colours.
   *
   * Rows may differ in length only if the caller keeps them rectangular; they
   * are indexed as a regular grid. `flip` reverses the winding, which is how the
   * starboard side and the inboard faces of the bulwarks are emitted from the same
   * code that emits the port side and the outboard faces.
   */
  addGrid(
    points: readonly (readonly Vec3[])[],
    normals: readonly (readonly Vec3[])[],
    colours: readonly (readonly Rgb[])[],
    flip = false,
  ): void {
    const rows = points.length;
    if (rows < 2) return;
    const cols = points[0].length;
    if (cols < 2) return;

    const base = this.positions.length / 3;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        this.push(points[i][j], normals[i][j], colours[i][j]);
      }
    }

    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = base + i * cols + j;
        const b = base + (i + 1) * cols + j;
        const c = base + (i + 1) * cols + j + 1;
        const d = base + i * cols + j + 1;
        if (flip) {
          this.triangle(a, d, c);
          this.triangle(a, c, b);
        } else {
          this.triangle(a, b, c);
          this.triangle(a, c, d);
        }
      }
    }
  }

  /**
   * The same quad grid, from flat `rows × cols × 3` buffers — the form a
   * caller uses when the patch is rebuilt every frame.
   *
   * `addGrid`'s nested `Vec3[][]` is fine for a rig built once, and was
   * costing 585 short-lived objects *per sail* once S4 started re-lofting
   * under a moving hoist. Same vertices, same winding, same triangles; no
   * garbage. Buffers may be longer than `rows * cols * 3` — only the used
   * prefix is read, so callers can keep one scratch buffer at its largest
   * size.
   */
  addGridFlat(
    rows: number,
    cols: number,
    positions: Float64Array,
    normals: Float64Array,
    colours: Float64Array,
    flip = false,
  ): void {
    if (rows < 2 || cols < 2) return;
    const base = this.positions.length / 3;
    const used = rows * cols * 3;
    for (let k = 0; k < used; k += 3) {
      this.positions.push(positions[k], positions[k + 1], positions[k + 2]);
      this.normals.push(normals[k], normals[k + 1], normals[k + 2]);
      this.colours.push(colours[k], colours[k + 1], colours[k + 2]);
    }
    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = base + i * cols + j;
        const b = base + (i + 1) * cols + j;
        const c = base + (i + 1) * cols + j + 1;
        const d = base + i * cols + j + 1;
        if (flip) {
          this.triangle(a, d, c);
          this.triangle(a, c, b);
        } else {
          this.triangle(a, b, c);
          this.triangle(a, c, d);
        }
      }
    }
  }

  /** A flat polygon, as a triangle fan about its first vertex. */
  addPolygon(points: readonly Vec3[], normal: Vec3, colour: Rgb, flip = false): void {
    if (points.length < 3) return;
    const base = this.positions.length / 3;
    for (const p of points) this.push(p, normal, colour);
    for (let i = 1; i < points.length - 1; i++) {
      if (flip) {
        this.triangle(base, base + i + 1, base + i);
      } else {
        this.triangle(base, base + i, base + i + 1);
      }
    }
  }

  /** A single quad, wound a -> b -> c -> d. */
  addQuad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, normal: Vec3, colour: Rgb, flip = false): void {
    this.addPolygon([a, b, c, d], normal, colour, flip);
  }

  toGeometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colours, 3));
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

// --- swept solids ------------------------------------------------------------

/**
 * An orthonormal frame with `w` as its third axis.
 *
 * Used to sweep a circle around an axis. The seed axis is chosen away from `w` so
 * the cross product never collapses — a mast is vertical and a windlass barrel is
 * horizontal, and one fixed seed cannot serve both.
 */
export function frameFor(w: Vec3): { u: Vec3; v: Vec3 } {
  const seed = Math.abs(w.y) > 0.9 ? v3(0, 0, 1) : v3(0, 1, 0);
  const u = normalise(
    v3(
      seed.y * w.z - seed.z * w.y,
      seed.z * w.x - seed.x * w.z,
      seed.x * w.y - seed.y * w.x,
    ),
  );
  const v = v3(
    w.y * u.z - w.z * u.y,
    w.z * u.x - w.x * u.z,
    w.x * u.y - w.y * u.x,
  );
  return { u, v };
}

/**
 * A tapered round tube from `a` to `b` — every spar and rope aboard, and the
 * round ironwork on deck.
 *
 * Normals are the true surface normals of the cone, not the mesh's: the same
 * reason this file takes normals rather than computing them. A tapered tube's
 * normal tilts along the taper, and a mast lit with cylinder normals has a
 * visible false edge where it meets its own cap.
 *
 * `flip` is passed through to `addGrid` rather than assumed. Every caller in
 * `rigGeometry.ts` wants it, because its grids run along the thing in rows and
 * around it in columns, which is the opposite of what the winding wants — see
 * the WINDING note at the head of that file.
 *
 * THE ENDS ARE CLOSED, AND WERE NOT
 * ---------------------------------
 * This drew the wall and nothing else, so every round object on the ship was an
 * open pipe. With front-face culling that does not read as a hole — it reads as
 * *transparency*: the near wall is drawn, the far wall's inside is discarded,
 * and you look through the end of a solid baulk of oak into the sky behind it.
 * Ash found it on the bowsprit, the tiller, the pump, the pump's brake and the
 * mast partners in one pass, which is what a fault in a primitive looks like
 * from the deck.
 *
 * A rope is exempt by default (`capped`): a 17 mm line ends inside a block or a
 * coil, its caps are never visible, and there are enough of them for the
 * triangles to be worth not spending.
 */
export function addTube(
  builder: SurfaceBuilder,
  a: Vec3,
  b: Vec3,
  radiusA: number,
  radiusB: number,
  sides: number,
  segments: number,
  colour: Rgb,
  bend?: (t: number) => Vec3,
  capped = true,
): void {
  const axis = v3(b.x - a.x, b.y - a.y, b.z - a.z);
  const length = Math.hypot(axis.x, axis.y, axis.z);
  if (length < 1e-6) return;
  const w = v3(axis.x / length, axis.y / length, axis.z / length);
  const { u, v } = frameFor(w);

  // The taper's contribution to the normal: a cone's surface normal leans back
  // along the axis by (rA - rB) / length.
  const slope = (radiusA - radiusB) / length;

  const points: Vec3[][] = [];
  const normals: Vec3[][] = [];
  const colours: Rgb[][] = [];

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const r = radiusA + (radiusB - radiusA) * t;
    const sag = bend ? bend(t) : v3(0, 0, 0);
    const cx = a.x + axis.x * t + sag.x;
    const cy = a.y + axis.y * t + sag.y;
    const cz = a.z + axis.z * t + sag.z;

    const ring: Vec3[] = [];
    const ringN: Vec3[] = [];
    const ringC: Rgb[] = [];
    for (let j = 0; j <= sides; j++) {
      const th = (j / sides) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const rx = u.x * c + v.x * s;
      const ry = u.y * c + v.y * s;
      const rz = u.z * c + v.z * s;
      ring.push(v3(cx + rx * r, cy + ry * r, cz + rz * r));
      ringN.push(normalise(v3(rx + w.x * slope, ry + w.y * slope, rz + w.z * slope)));
      ringC.push(colour);
    }
    points.push(ring);
    normals.push(ringN);
    colours.push(ringC);
  }

  builder.addGrid(points, normals, colours, true);

  if (!capped) return;
  // The end discs, from the rings the wall already used — so a cap can never
  // sit a millimetre off the timber it closes, however the taper or the sag
  // moved that ring. The last vertex of each ring repeats the first (the wall
  // needs the seam), so it is dropped here.
  //
  // Winding: the two caps take opposite `flip`, because one is seen from each
  // end of the same ring order. Which one takes which is *measured* and not
  // reasoned about — reasoning it out from the ring's handedness gave both of
  // them backwards, and `ship-rig.test.ts` said "spar: 488 inverted" on the
  // first run. That is the third time on this ship that a quantity depending on
  // local ordering has come out reversed from an argument that sounded right,
  // and the second time this exact test has been the thing that caught it.
  const first = points[0].slice(0, sides);
  const last = points[points.length - 1].slice(0, sides);
  const inward = v3(-w.x, -w.y, -w.z);
  if (radiusA > 1e-6) builder.addPolygon(first, inward, colour, true);
  if (radiusB > 1e-6) builder.addPolygon(last, w, colour, false);
}

/**
 * A rectangular box. Crosstrees, chain plates, mast caps, bitts — and, turned by
 * `yaw`, a piece of furniture standing along a wall that is not square with the
 * ship.
 *
 * **The yaw is about the vertical and about the box's own centre**, which is the
 * only rotation anything aboard has ever wanted: a chest, a desk or a cot stands
 * on the sole and turns on the sole. Roll and pitch are the *ship's* and are
 * applied to the whole hull by the scene, so a fitting that carried its own
 * would be tilted twice.
 *
 * Written as one basis rather than as a `THREE.Matrix4` because the faces need
 * their *normals* turned as well as their corners, and a basis gives both in the
 * same two lines: the box's own +x becomes `u`, its own +z becomes `w`, and its
 * +y is untouched. `u × w = -ŷ` exactly as `x̂ × ẑ = -ŷ` does, so the winding
 * every quad below was measured with is unchanged — which is worth stating,
 * because a reversed basis is the fault `addTube`'s cap comment records this
 * file finding the hard way three times.
 */
export function addBox(
  builder: SurfaceBuilder,
  centre: Vec3,
  half: Vec3,
  colour: Rgb,
  yaw = 0,
): void {
  const { x, y, z } = centre;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const u = v3(cos, 0, -sin);
  const w = v3(sin, 0, cos);
  /** A corner, from its signs in the box's own axes. */
  const at = (sx: number, sy: number, sz: number): Vec3 =>
    v3(
      x + sx * half.x * u.x + sz * half.z * w.x,
      y + sy * half.y,
      z + sx * half.x * u.z + sz * half.z * w.z,
    );
  const c = [
    at(-1, -1, -1),
    at(+1, -1, -1),
    at(+1, -1, +1),
    at(-1, -1, +1),
    at(-1, +1, -1),
    at(+1, +1, -1),
    at(+1, +1, +1),
    at(-1, +1, +1),
  ];
  const back = v3(-w.x, -w.y, -w.z);
  const inboard = v3(-u.x, -u.y, -u.z);
  builder.addQuad(c[4], c[5], c[6], c[7], v3(0, 1, 0), colour, true);
  builder.addQuad(c[3], c[2], c[1], c[0], v3(0, -1, 0), colour, true);
  builder.addQuad(c[7], c[6], c[2], c[3], w, colour, true);
  builder.addQuad(c[5], c[4], c[0], c[1], back, colour, true);
  builder.addQuad(c[6], c[5], c[1], c[2], u, colour, true);
  builder.addQuad(c[4], c[7], c[3], c[0], inboard, colour, true);
}

/** Normal of the triangle a-b-c, normalised. Zero-area gives +y. */
export function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return v3(0, 1, 0);
  return v3(nx / len, ny / len, nz / len);
}

export function normalise(n: Vec3): Vec3 {
  const len = Math.hypot(n.x, n.y, n.z);
  if (len < 1e-12) return v3(0, 1, 0);
  return v3(n.x / len, n.y / len, n.z / len);
}

/** Mirror a point or normal about the centreline. */
export function mirrorX(p: Vec3): Vec3 {
  return v3(-p.x, p.y, p.z);
}

/**
 * The deterministic pseudo-random source used for plank colour variation.
 *
 * This generator is private to the schooner so its timber cannot shift when
 * another vessel changes its seed usage. Determinism is not decoration here: `docs/project/ASSET_CREDITS.md`
 * has everything generated at runtime, so "the ship looks like this" is only a
 * meaningful statement if she is built identically on every load.
 */
export interface SeededRandom {
  (): number;
  /**
   * The generator's whole state, readable and writable.
   *
   * The rig's partial re-lofts need it: they rebuild only the parts a live
   * trim can move, which means skipping builders that sit *between* them in
   * the draw order. Rewinding the stream to the exact point each rebuilt
   * builder started at is what keeps every spar, rope and cloth panel the
   * colour it was on the first build — the alternative, a separate generator
   * per builder, would repaint the ship.
   */
  state: number;
}

export function makeRandom(seed: number): SeededRandom {
  let a = seed >>> 0;
  const random = (() => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as SeededRandom;
  Object.defineProperty(random, 'state', {
    get: () => a,
    set: (value: number) => {
      a = value >>> 0;
    },
  });
  return random;
}

/**
 * Jitter a base colour multiplicatively.
 *
 * Multiplicative rather than additive so a dark timber and a pale one vary by
 * the same *proportion*: an additive ±0.03 is invisible on the deck and lurid
 * on near-black topsides.
 */
export function jitter(base: Rgb, random: () => number, amount: number): Rgb {
  const k = 1 + (random() * 2 - 1) * amount;
  return { r: base.r * k, g: base.g * k, b: base.b * k };
}

export function rgbOf(hex: number): Rgb {
  const c = new THREE.Color(hex);
  return { r: c.r, g: c.g, b: c.b };
}

/**
 * Add a quad with winding chosen from its requested outward normal.
 *
 * Here rather than in `shipGeometry.ts`, which is where it lived and where its
 * fifty-odd callers still are, because the cabin's joinery needs it too and
 * cannot import it from there: the loft imports the joinery, so the joinery
 * importing the loft is a cycle. It belongs beside `addBox` and `addTube`
 * anyway — it is a primitive, and the winding rule it encodes is the one this
 * ship has got wrong in five separate surfaces.
 */
export function addQuadFacing(
  builder: SurfaceBuilder,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  d: Vec3,
  normal: Vec3,
  colour: Rgb,
): void {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  const wx = d.x - a.x;
  const wy = d.y - a.y;
  const wz = d.z - a.z;
  // Sum both fan triangles. End profiles legitimately collapse one edge to the
  // stem/forefoot; looking only at a-b-c then sees a zero vector and cannot pick
  // the winding of the surviving a-c-d triangle.
  const nx = (uy * vz - uz * vy) + (vy * wz - vz * wy);
  const ny = (uz * vx - ux * vz) + (vz * wx - vx * wz);
  const nz = (ux * vy - uy * vx) + (vx * wy - vy * wx);
  const dot =
    nx * normal.x +
    ny * normal.y +
    nz * normal.z;
  builder.addQuad(a, b, c, d, normal, colour, dot < 0);
}
