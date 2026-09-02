import type { ShipRegion } from './shipGeometry';
import { SHIP_PALETTE } from './shipGeometry';

/**
 * The schooner hull paint options, for judging by eye under the world lighting.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS TEMPORARY
 * -------------------------------------------
 * The canonical paint lives in `shipGeometry.ts` and `docs/ship/SHIP_SPEC.md`, and stays
 * there. These are candidates, rendered side by side on one sheet so a palette
 * verdict can be a comparison instead of a memory of yesterday's screenshot.
 * When one is chosen, its values move into the canonical palette and this file
 * goes away.
 *
 * THE ARGUMENT THIS SETTLES
 * -------------------------
 * The current topsides are ~3% linear reflectance, which is darker than
 * charcoal — genuinely what tar is. `shipGeometry.ts` argues, correctly for its
 * time, that the darkness was blamed on the paint when the real culprit was a
 * hull with no sky to reflect, and warns: "Do not lighten them to fix a
 * darkness problem without first checking the probe is alive."
 *
 * The probe is alive now, and it is a real cosine convolution of a real sky
 * rather than a hand-authored gradient at a third strength. So the warning has
 * been honoured and the question it protected can finally be asked properly:
 * with correct lighting, is 3% the look we want? No lighting system renders 3%
 * tar as anything but near-black on a shaded face — that is not a bug to fix,
 * it is what tar is — so if the answer is no, the paint is the lever.
 *
 * Roughness matters as much as colour here and is part of each option. A dark
 * surface that is glossy reads through its sheen; a dark surface that is matte
 * reads not at all.
 *
 * THE ROUGHNESSES BELOW CARRY +0.30, AND IT IS A CORRECTION TO THE INSTRUMENT
 * ---------------------------------------------------------------------------
 * They were fitted in the same round as the colours, against the same
 * hand-authored sky probe at `ENV_INTENSITY = 0.3`. `dba7041` then re-derived
 * the SHIPPING finish against the scene-wide probe at full strength — measuring
 * the 95th percentile of topsides luminance across a roughness sweep, finding
 * the knee at +0.30 — and deliberately left this file alone, on the grounds
 * that these are "a comparison set that was judged as it stands".
 *
 * That reasoning has an expiry date and it has passed. The shipping hull now
 * renders at 0.78-0.92 and the candidates at 0.38-0.58, so the sheet these
 * options exist to draw compares a candidate paint against the shipping paint
 * with FOUR TENTHS of roughness between them as well. Whatever such a sheet
 * shows, none of it is attributable to the colour, which is the only variable
 * the sheet claims to hold. The same delta is applied here, so the
 * relationships each option authored are preserved — tar glossier than
 * topsides, boot top duller than both — and the one variable left along a row
 * is the paint.
 *
 * This is a fix to a measuring instrument, not a look change to the game: no
 * option here is on any code path a player reaches. It is recorded loudly
 * because it does change what a palette sheet looks like, and the next person
 * to render one should know why it moved.
 */

export interface PaletteOption {
  key: string;
  label: string;
  /** Region colours that differ from the canonical palette. */
  colours: Partial<Record<ShipRegion, number>>;
  /** Region roughness overrides. */
  roughness: Partial<Record<ShipRegion, number>>;
}

export const PALETTE_OPTIONS: readonly PaletteOption[] = [
  {
    // The canonical palette, so this option applies no overrides at all.
    key: 'current',
    label: 'Current — tarred (~3%)',
    colours: {},
    roughness: {},
  },
  {
    key: 'A',
    label: 'A — oiled larch (~16%)',
    // The Colin Archer / Norwegian rescue-boat finish: oiled timber topsides
    // that read as warm golden-brown, near-black tarred wales holding the
    // graphic line, a pale boot top anchoring the waterline. At ~16% the
    // topsides sit near photographic mid-grey, so diffuse light finally carries
    // form — about +2.4 stops over the current paint.
    colours: {
      topsides: 0x8a6a46,
      transom: 0x7d5f3e,
      wales: 0x332720,
      bootTop: 0xd8d2c3,
    },
    roughness: {
      topsides: 0.72,
      transom: 0.75,
      // Tar stays dark but glossy, so it reads through sheen exactly as real
      // tar does rather than through diffuse level.
      wales: 0.68,
      bootTop: 0.85,
    },
  },
  {
    key: 'B',
    label: 'B — weathered tar (~7%)',
    // The honest middle. Keeps the moody dark-ship identity at about +1.2
    // stops, for if A reads too yacht-pretty for an expedition vessel.
    colours: {
      topsides: 0x5a473a,
      transom: 0x51402f,
      wales: 0x2b221c,
      bootTop: 0xb9b2a1,
    },
    roughness: {
      topsides: 0.75,
      transom: 0.77,
      wales: 0.7,
      bootTop: 0.88,
    },
  },
  {
    key: 'C',
    label: 'C — painted topsides (~62%)',
    // The polar-expedition tradition: ivory above a dark sheer strake. Maximum
    // legibility against a dark sea and a completely different character —
    // included because the palette question is partly about what she IS, not
    // only how bright she is.
    colours: {
      topsides: 0xcfc9b8,
      transom: 0xc4beac,
      wales: 0x2b221c,
      bootTop: 0x6b2f28,
    },
    roughness: {
      topsides: 0.68,
      transom: 0.7,
      wales: 0.68,
      bootTop: 0.8,
    },
  },
];

/** Resolve an option's colour for a region, falling back to canonical. */
export function paletteColour(option: PaletteOption, region: ShipRegion): number {
  return option.colours[region] ?? SHIP_PALETTE.base[region];
}
