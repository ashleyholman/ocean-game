import * as THREE from 'three';
import {
  LIGHT_CHANNELS,
  VERTEX_ROOM_NUDGE,
  interiorLightModel,
  lightRoomAt,
  lightRoomIndexOf,
  vertexLightResponse,
} from './interiorLight';
import { deckOverheadAt } from './deckSurface';

/**
 * Channels carried in the three `vec4` attributes. The rest ride
 * `aPortalChannel4`, one channel to its three components.
 *
 * A `vec4` holds four and there is no arithmetic to do here: this is the width
 * of the attribute, not a tuning. `world-pbr.test.ts` holds it against
 * `LIGHT_CHANNELS` and the shader's own array sizes.
 */
export const PACKED_CHANNELS = 4;

/**
 * The bake: `interiorLight.ts`'s per-vertex response written into vertex
 * attributes, once, at build time.
 *
 * A post-pass over finished `BufferGeometry` rather than a parameter threaded
 * through every builder, deliberately. The builders already record the two
 * facts the light model needs — where a vertex is and which way its surface
 * faces — and reading them back keeps the bake in one place instead of
 * spreading a lighting concern through three thousand lines of joinery.
 *
 * THE ATTRIBUTES
 * --------------
 *   aPortalDirect   vec4  form factor × transmittance to each channel's
 *                         own-room openings — the directional daylight
 *   aPortalBounce   vec4  doorway glow + the room's ambient bath, per channel
 *   aPortalChannel4 vec3  the fifth channel's (direct, bounce, gradient)
 *   aSkyVisibility  float how much open sky the vertex actually sees
 *
 * WHY THE FIFTH CHANNEL IS PACKED SIDEWAYS INSTEAD OF WIDENING THE OTHERS
 * ----------------------------------------------------------------------
 * Four channels fitted three `vec4`s exactly, which is why there were four.
 * The fore scuttle needed a fifth — see `CHANNEL_SCUTTLE` for why it could
 * share neither of the two that looked like they would do — and the obvious
 * shape, three `vec4`s plus three `float`s, costs three new attributes and
 * three new varyings to carry three numbers.
 *
 * One `vec3` carries all three instead: the same channel's direct, bounce and
 * bounce-gradient, side by side, because a channel's three terms are always
 * wanted together and never wanted per-channel-across-terms. One attribute,
 * one varying after the gradient mix collapses it to two components, 12 bytes
 * a vertex. A sixth channel would take the remaining component and a seventh
 * would want this decision made again.
 *
 * Every geometry drawn with a `portalLight` material must pass through one of
 * the two bakes below — WebGL's default for an unbound attribute is
 * `(0,0,0,1)`, which would quietly light a surface with the hold's channel.
 * `hasPortalLightAttributes` is the guard the tests and the vessel assert.
 */

export const PORTAL_DIRECT_ATTRIBUTE = 'aPortalDirect';
export const PORTAL_BOUNCE_ATTRIBUTE = 'aPortalBounce';
export const PORTAL_BOUNCE_GRADIENT_ATTRIBUTE = 'aPortalBounceGradient';
export const PORTAL_CHANNEL4_ATTRIBUTE = 'aPortalChannel4';
export const SKY_VISIBILITY_ATTRIBUTE = 'aSkyVisibility';
export const ROOM_INDEX_ATTRIBUTE = 'aRoomIndex';

export function hasPortalLightAttributes(geometry: THREE.BufferGeometry): boolean {
  return (
    geometry.getAttribute(PORTAL_DIRECT_ATTRIBUTE) !== undefined &&
    geometry.getAttribute(PORTAL_BOUNCE_ATTRIBUTE) !== undefined &&
    geometry.getAttribute(PORTAL_BOUNCE_GRADIENT_ATTRIBUTE) !== undefined &&
    geometry.getAttribute(PORTAL_CHANNEL4_ATTRIBUTE) !== undefined &&
    geometry.getAttribute(SKY_VISIBILITY_ATTRIBUTE) !== undefined &&
    geometry.getAttribute(ROOM_INDEX_ATTRIBUTE) !== undefined
  );
}

/**
 * Bake an enclosed geometry: everything below decks.
 *
 * Sky visibility is zero across the board — an interior surface's daylight
 * arrives through the openings or not at all, and that includes the surfaces
 * inside the two shafts, whose large form factors to their own portal are the
 * honest version of the sky they see. Surfaces in sealed voids (the bread
 * room, the cable tier, under the sole) resolve to no room and stay dark.
 */
export function bakeEnclosedPortalLight(geometry: THREE.BufferGeometry): void {
  bake(geometry, () => 0);
}

/**
 * Bake a spar geometry: the masts are the one timber that runs from the bilge
 * to the sky through every room in the ship.
 *
 * Above the weather deck a spar vertex keeps full sky; below it, it takes its
 * room's portal light like any other interior surface, with a short ramp
 * across the partners so the transition never draws a hard line on the tube.
 * Booms, gaffs, topmasts and the bowsprit never test below and are untouched.
 */
export function bakeSparPortalLight(geometry: THREE.BufferGeometry): void {
  bake(geometry, (x, y, z) => {
    const deck = deckOverheadAt(x, z);
    if (!deck) return 1;
    // The ramp lives entirely ABOVE the planking. Its old form started 5 cm
    // below (deck.y − 0.05), and with spar rows every 0.3 m the interpolation
    // band reached a full row into the room — §15.5's "tip of the mast is
    // lit" glowing at the forecastle deckhead. The interior side of the
    // partners is exactly zero now; the sky fades in across the first 25 cm
    // of mast that actually stands in it.
    return smoothstep(deck.y + 0.05, deck.y + 0.3, y);
  });
}

/**
 * Bake a deck-fitting geometry: timber bolted to the weather deck that may
 * reach below it.
 *
 * §15.5 item 5: the mast partners, the windlass and the grating are drawn
 * with an exterior material, so their undersides below the planking rendered
 * with the full sky constant — "plank-looking things in the ceiling lit up
 * like daylight" over the forecastle, and a grating underside glowing in the
 * hatchway shaft. The rule here is binary where the spars' is a ramp,
 * deliberately: a spar is one continuous tube whose crossing wants blending
 * rows, but a fitting's feet stand ON the planking — a windlass base given
 * the spar ramp would lose half its sky for its first 30 cm, which reads as
 * dirt. Below the walking surface by more than a plank's tolerance means
 * enclosed; everything else keeps its sky. Fragments across the deck line
 * interpolate over one vertex gap, which lands exactly where a real shadow
 * line would sit.
 */
export function bakeFittingPortalLight(geometry: THREE.BufferGeometry): void {
  bake(geometry, (x, y, z) => {
    const deck = deckOverheadAt(x, z);
    if (!deck) return 1;
    return y < deck.y - 0.02 ? 0 : 1;
  });
}

function smoothstep(lo: number, hi: number, v: number): number {
  const t = Math.min(Math.max((v - lo) / (hi - lo), 0), 1);
  return t * t * (3 - 2 * t);
}

function bake(
  geometry: THREE.BufferGeometry,
  skyVisibilityAt: (x: number, y: number, z: number) => number,
): void {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  if (!position || !normal) {
    throw new Error('interiorLightBake: geometry has no position/normal to bake from.');
  }

  const count = position.count;
  const direct = new Float32Array(count * 4);
  const bounce = new Float32Array(count * 4);
  const bounceGradient = new Float32Array(count * 4);
  const channel4 = new Float32Array(count * 3);
  const skyVis = new Float32Array(count);
  const roomIndex = new Float32Array(count);
  const model = interiorLightModel();

  for (let i = 0; i < count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const nx = normal.getX(i);
    const ny = normal.getY(i);
    const nz = normal.getZ(i);

    const sky = skyVisibilityAt(x, y, z);
    skyVis[i] = sky;
    if (sky >= 1) continue;

    // The same nudged lookup `vertexLightResponse` resolves its room with, so
    // a vertex can never carry one room's light and another room's lift. A
    // vertex partway up a spar ramp keeps its room index at full strength —
    // the ramp already weights the attributes the lift multiplies, and a
    // second fade here would square it.
    roomIndex[i] = lightRoomIndexOf(
      lightRoomAt(
        x + nx * VERTEX_ROOM_NUDGE,
        y + ny * VERTEX_ROOM_NUDGE,
        z + nz * VERTEX_ROOM_NUDGE,
      ),
    );

    const response = vertexLightResponse(model, x, y, z, nx, ny, nz);
    // A vertex fading out of the sky (a mast crossing its partners) fades
    // into its room's light by the same ramp, so the two models always sum
    // to one whole illumination model rather than overlapping.
    const w = 1 - sky;
    // The first four go in the `vec4`s; the fifth goes in its own `vec3`.
    // Written as one loop over `LIGHT_CHANNELS` with the split at the end
    // rather than two hand-unrolled blocks, so raising the count fails loudly
    // in one place instead of silently dropping a channel here.
    for (let p = 0; p < PACKED_CHANNELS; p++) {
      direct[i * 4 + p] = response.direct[p] * w;
      bounce[i * 4 + p] = response.bounce[p] * w;
      bounceGradient[i * 4 + p] = response.bounceGradient[p] * w;
    }
    for (let p = PACKED_CHANNELS; p < LIGHT_CHANNELS; p++) {
      const o = (p - PACKED_CHANNELS) * 3;
      channel4[i * 3 + o + 0] = response.direct[p] * w;
      channel4[i * 3 + o + 1] = response.bounce[p] * w;
      channel4[i * 3 + o + 2] = response.bounceGradient[p] * w;
    }
  }

  geometry.setAttribute(PORTAL_DIRECT_ATTRIBUTE, new THREE.BufferAttribute(direct, 4));
  geometry.setAttribute(PORTAL_BOUNCE_ATTRIBUTE, new THREE.BufferAttribute(bounce, 4));
  geometry.setAttribute(
    PORTAL_BOUNCE_GRADIENT_ATTRIBUTE,
    new THREE.BufferAttribute(bounceGradient, 4),
  );
  geometry.setAttribute(PORTAL_CHANNEL4_ATTRIBUTE, new THREE.BufferAttribute(channel4, 3));
  geometry.setAttribute(SKY_VISIBILITY_ATTRIBUTE, new THREE.BufferAttribute(skyVis, 1));
  geometry.setAttribute(ROOM_INDEX_ATTRIBUTE, new THREE.BufferAttribute(roomIndex, 1));
}

/**
 * The mean baked response of a geometry, for the tests: which channels light
 * it at all, and how strongly on average. Cheap and deterministic.
 */
export function bakedChannelMeans(geometry: THREE.BufferGeometry): {
  direct: number[];
  bounce: number[];
  skyVisibility: number;
} {
  const direct = geometry.getAttribute(PORTAL_DIRECT_ATTRIBUTE);
  const bounce = geometry.getAttribute(PORTAL_BOUNCE_ATTRIBUTE);
  const sky = geometry.getAttribute(SKY_VISIBILITY_ATTRIBUTE);
  if (!direct || !bounce || !sky) {
    throw new Error('interiorLightBake: geometry carries no baked attributes.');
  }
  const d = [0, 0, 0, 0];
  const b = [0, 0, 0, 0];
  let s = 0;
  for (let i = 0; i < direct.count; i++) {
    for (let p = 0; p < 4; p++) {
      d[p] += direct.getComponent(i, p);
      b[p] += bounce.getComponent(i, p);
    }
    s += sky.getX(i);
  }
  const n = Math.max(direct.count, 1);
  return {
    direct: d.map((v) => v / n),
    bounce: b.map((v) => v / n),
    skyVisibility: s / n,
  };
}

/**
 * Re-exported for the vessel: whether a point is in any lit room. Used to
 * gate which fittings opt in, not by the bake itself.
 */
export { lightRoomAt };
