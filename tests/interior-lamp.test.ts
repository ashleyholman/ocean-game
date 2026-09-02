import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  EXPOSURE_REFERENCE,
  InteriorLamp,
  OFF_ABOVE_LUMINANCE,
  ON_BELOW_LUMINANCE,
  ROOM_REFERENCE_LUMINANCE,
  ROOM_ROLLOFF,
} from '../src/scene/InteriorLamp';
import {
  LANTERN_SHADOW_LAYER,
  buildLanternAssembly,
  lampSurfaceEmissionLevel,
} from '../src/scene/Lamp';
import {
  interiorLightModel,
  luminanceOf,
} from '../src/vessel/schooner/interiorLight';
import { belowDecksSpace, spaceDeckheadY } from '../src/vessel/schooner/deckInterior';
import { DECK_OPENINGS } from '../src/vessel/schooner/hullForm';
import { deckBeamHangPoint } from '../src/vessel/schooner/shipGeometry';
import {
  LAMP_HANGS,
  lampHangPoint,
} from '../src/vessel/schooner/lampPlacement';
import { Schooner } from '../src/vessel/schooner/Schooner';

/**
 * The cabin lantern: the same lantern assembly as the deck lamp, answering
 * to the ROOM instead of the sky. The design promises under test:
 *
 * - the latch and rolloff run on the room's own daylight luminance, so the
 *   lamp lights when the room fails — by dusk or by heading — and drowns
 *   when the room floods;
 * - the flame's own surfaces burn regardless of suppression (daylight does
 *   not dim a flame, it only drowns what the flame lights);
 * - the shadow A/B pays its six faces only while the flame contributes;
 * - the calibration constants sit where the measured cabin signal says the
 *   day actually fails, and break loudly if the transfer solve moves.
 */

/** Feed one update tick with a fixed signal, snapping past the 2 s ramp. */
function settle(
  lamp: InteriorLamp,
  signal: number,
  exposure = EXPOSURE_REFERENCE,
): void {
  lamp.update(0.016, 0, signal, exposure);
  lamp.snapLit();
  lamp.update(0.016, 0, signal, exposure);
}

describe('the room-driven latch', () => {
  it('caps visible flame surfaces without capping the lamp flux control', () => {
    expect(lampSurfaceEmissionLevel(0.4)).toBe(0.4);
    expect(lampSurfaceEmissionLevel(1.7)).toBe(1);
    expect(lampSurfaceEmissionLevel(-1)).toBe(0);
  });

  it('stays out in a bright room and lights when the room fails', () => {
    const lamp = new InteriorLamp();
    settle(lamp, ON_BELOW_LUMINANCE * 4);
    expect(lamp.isOn).toBe(false);
    settle(lamp, ON_BELOW_LUMINANCE * 0.9);
    expect(lamp.isOn).toBe(true);
  });

  it('holds through the hysteresis band and goes out above it', () => {
    const lamp = new InteriorLamp();
    settle(lamp, ON_BELOW_LUMINANCE * 0.9);
    expect(lamp.isOn).toBe(true);
    // Between the thresholds: a lit lamp stays lit.
    settle(lamp, (ON_BELOW_LUMINANCE + OFF_ABOVE_LUMINANCE) / 2);
    expect(lamp.isOn).toBe(true);
    // Above the off threshold: put out.
    settle(lamp, OFF_ABOVE_LUMINANCE * 1.2);
    expect(lamp.isOn).toBe(false);
    // And an unlit lamp in the band stays unlit — the band cannot chatter.
    settle(lamp, (ON_BELOW_LUMINANCE + OFF_ABOVE_LUMINANCE) / 2);
    expect(lamp.isOn).toBe(false);
  });

  it('mode on and off override the latch both ways', () => {
    const lamp = new InteriorLamp();
    lamp.mode = 'on';
    settle(lamp, OFF_ABOVE_LUMINANCE * 10);
    expect(lamp.isOn).toBe(true);
    lamp.mode = 'off';
    settle(lamp, 0);
    expect(lamp.isOn).toBe(false);
  });
});

describe("the player's hand", () => {
  it('douses a night lamp and the morning release expires the override', () => {
    const lamp = new InteriorLamp();
    settle(lamp, 0);
    expect(lamp.isWantedLit).toBe(true);
    lamp.toggleManual();
    settle(lamp, 0);
    expect(lamp.isOn).toBe(false); // stays doused through the night
    // Morning: the latch releases; the override expires with it (both agree).
    settle(lamp, OFF_ABOVE_LUMINANCE * 2);
    expect(lamp.isWantedLit).toBe(false);
    // Next evening's strike belongs to the routine again.
    settle(lamp, ON_BELOW_LUMINANCE * 0.5);
    expect(lamp.isOn).toBe(true);
  });

  it('lights a day lamp and the evening strike takes the watch back', () => {
    const lamp = new InteriorLamp();
    settle(lamp, OFF_ABOVE_LUMINANCE * 3);
    expect(lamp.isOn).toBe(false);
    lamp.toggleManual();
    settle(lamp, OFF_ABOVE_LUMINANCE * 3);
    expect(lamp.isOn).toBe(true); // burning into daylight, however dimly
    settle(lamp, ON_BELOW_LUMINANCE * 0.5);
    expect(lamp.isOn).toBe(true); // strike clears the override; both agree
    expect(lamp.isWantedLit).toBe(true);
  });
});

describe('the swing', () => {
  it('leans the chain toward apparent down as the ship rolls under it', () => {
    const lamp = new InteriorLamp();
    const down = new THREE.Vector3(0.15, -1, 0).normalize();
    for (let i = 0; i < 400; i++) {
      lamp.update(0.016, i * 0.016, 0, EXPOSURE_REFERENCE, down);
    }
    // The flame has moved off the plumb line, toward the tilt.
    expect(lamp.flameWorld.x).toBeGreaterThan(0.02);
    // And snapping for a capture parks it exactly at the lean, not mid-swing.
    lamp.snapLit();
    lamp.update(0.016, 0, 0, EXPOSURE_REFERENCE, down);
    const parked = lamp.flameWorld.x;
    lamp.update(0.016, 0.5, 0, EXPOSURE_REFERENCE, down);
    expect(lamp.flameWorld.x).toBeCloseTo(parked, 3);
  });
});

describe('the shadow fill', () => {
  it('moves a share of the flame to the unshadowed fill only while shadowed', () => {
    const lamp = new InteriorLamp();
    lamp.mode = 'on';
    lamp.setShadowEnabled(false); // shadows ship on; hold them off first
    settle(lamp, 0);
    // Shadow off: everything in the key, nothing in the fill.
    expect(lamp.fillLight.intensity).toBe(0);
    const unshadowedKey = lamp.light.intensity;
    lamp.setShadowEnabled(true);
    settle(lamp, 0);
    expect(lamp.shadowActive).toBe(true);
    const total = lamp.light.intensity + lamp.fillLight.intensity;
    // The split conserves the flame's flux and gives the fill a quarter.
    expect(total).toBeCloseTo(unshadowedKey, 3);
    expect(lamp.fillLight.intensity / total).toBeCloseTo(0.25, 3);
    // A cold lamp fills nothing — the fill rides renderEmission.
    lamp.mode = 'off';
    settle(lamp, 0);
    expect(lamp.fillLight.intensity).toBe(0);
  });
});

describe('the room-daylight rolloff', () => {
  it('gives the flame full strength at and below the reference', () => {
    const lamp = new InteriorLamp();
    lamp.mode = 'on';
    settle(lamp, ROOM_REFERENCE_LUMINANCE * 0.5);
    expect(lamp.renderEmission).toBeCloseTo(lamp.emission, 5);
  });

  it('never amplifies the flame in a room darker than the reference', () => {
    const lamp = new InteriorLamp();
    lamp.mode = 'on';
    settle(lamp, 0);
    expect(lamp.renderEmission).toBeLessThanOrEqual(lamp.emission + 1e-9);
  });

  it('drowns the flame with the square of the ratio as the room floods', () => {
    const lamp = new InteriorLamp();
    lamp.mode = 'on';
    const signal = ROOM_REFERENCE_LUMINANCE * 4;
    settle(lamp, signal);
    const expected = Math.pow(4, -ROOM_ROLLOFF);
    expect(lamp.renderEmission / lamp.emission).toBeCloseTo(expected, 5);
  });

  it('divides the night exposure back out past the dusk reference', () => {
    const lamp = new InteriorLamp();
    lamp.mode = 'on';
    // At the calibration exposure the term is a no-op...
    settle(lamp, 0, EXPOSURE_REFERENCE);
    const atDusk = lamp.renderEmission / lamp.emission;
    expect(atDusk).toBeCloseTo(1, 5);
    // ...at the deep-night exposure the flame gives the curve's rise back.
    settle(lamp, 0, EXPOSURE_REFERENCE * 4);
    expect(lamp.renderEmission / lamp.emission).toBeCloseTo(0.25, 5);
    // Daylight exposures below the reference must not amplify.
    settle(lamp, 0, EXPOSURE_REFERENCE * 0.5);
    expect(lamp.renderEmission / lamp.emission).toBeCloseTo(1, 5);
  });

  it('keeps the flame surfaces burning while the illumination drowns', () => {
    const lamp = new InteriorLamp();
    lamp.mode = 'on';
    // A morning-bright room: illumination is orders of magnitude down...
    settle(lamp, 0.16);
    expect(lamp.renderEmission).toBeLessThan(0.01);
    // ...but the wick and the globe still read as burning.
    expect(lamp.light.intensity).toBeLessThan(0.02);
    expect(lamp.emission).toBeGreaterThan(0.9);
  });
});

describe('the shadow lifecycle', () => {
  it('pays the six faces only while the flame contributes', () => {
    const lamp = new InteriorLamp();
    lamp.setShadowEnabled(true);
    // Requested but cold: no shadow.
    settle(lamp, 1.0);
    expect(lamp.shadowActive).toBe(false);
    // Lit in a dark room: shadow on.
    settle(lamp, 0);
    lamp.mode = 'on';
    settle(lamp, 0);
    expect(lamp.shadowActive).toBe(true);
    // Switched off at the dial: shadow off, lit or not.
    lamp.setShadowEnabled(false);
    expect(lamp.shadowActive).toBe(false);
  });

  it('lets the cap and crown shade their own flame', () => {
    // The deck lamp's rule is that lantern meshes never cast — nothing hangs
    // above a davit but sky. Under a deckhead the cap is what stops the
    // flame painting a bullseye on the planks, so those two meshes opt in.
    const parent = new THREE.Group();
    const assembly = buildLanternAssembly(parent, 0, 0.6);
    expect(assembly.metalTop).toHaveLength(2);
    expect(assembly.coreMaterial).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(assembly.coreMaterial.toneMapped).toBe(true);
    const lamp = new InteriorLamp();
    const casters: THREE.Mesh[] = [];
    lamp.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.castShadow) casters.push(o);
    });
    expect(casters).toHaveLength(2);
    for (const mesh of casters) {
      expect(mesh.layers.isEnabled(LANTERN_SHADOW_LAYER)).toBe(true);
    }
  });
});

describe('snapLit', () => {
  it('jumps the presentation ramp to the latched target', () => {
    const lamp = new InteriorLamp();
    // Latch decides on; ramp has barely started.
    lamp.update(0.016, 0, 0, EXPOSURE_REFERENCE);
    expect(lamp.litLevel).toBeLessThan(0.05);
    lamp.snapLit();
    expect(lamp.litLevel).toBe(1);
  });
});

describe('the calibration, pinned to the model it was measured against', () => {
  /**
   * The channel luminances from the baseline sheet (evidence/inspect/
   * lamp-baseline-*, 2026-08-14, default heading): E+S per channel, which the
   * digest prints as `bounce` divided by the unit-luminance tint. If the
   * transfer solve or the room list moves and these thresholds stop meaning
   * "the lamp lights between 17:00 and 18:00", this is the test that says so.
   */
  const HOURS: ReadonlyArray<{ hour: string; channels: number[]; lit: boolean }> = [
    { hour: '07:00', channels: [4.297442, 4.297442, 3.878305, 0], lit: false },
    { hour: '14:00', channels: [9.896405, 9.896405, 0.681754, 0], lit: false },
    { hour: '17:00', channels: [4.51292, 4.51292, 0.554096, 0], lit: true },
    { hour: '18:00', channels: [2.127546, 2.127546, 0.415243, 0], lit: true },
    { hour: '19:00', channels: [0.256987, 0.256987, 0.11182, 0], lit: true },
    { hour: '22:00', channels: [0.003698, 0.003698, 0.002371, 0], lit: true },
  ];
  const CABIN_LIFT = 14;

  it('lights by 17:00 and is long out by morning (Ash, 2026-08-14)', () => {
    const model = interiorLightModel();
    const cabin = model.transfer.get('cabin');
    expect(cabin).toBeDefined();
    if (!cabin) return;
    const tint = luminanceOf(model.bounceTint as [number, number, number]);
    for (const { hour, channels, lit } of HOURS) {
      let j = 0;
      for (let p = 0; p < channels.length; p++) j += cabin[p] * (channels[p] / tint);
      const signal = j * CABIN_LIFT;
      const lamp = new InteriorLamp();
      // Approach from the day side, as the clock does.
      lamp.update(0.016, 0, OFF_ABOVE_LUMINANCE * 2, EXPOSURE_REFERENCE);
      lamp.update(0.016, 0, signal, EXPOSURE_REFERENCE);
      lamp.snapLit();
      lamp.update(0.016, 0, signal, EXPOSURE_REFERENCE);
      expect(lamp.isOn, `${hour} signal ${signal.toFixed(4)}`).toBe(lit);
    }
  });
});

describe('the beam hang point', () => {
  /**
   * A beam crossing a hatchway is interrupted at the carlings, not deleted —
   * outboard of the gap it is solid timber a hook can be screwed to. The
   * first cut rejected the whole beam, which pushed the wardroom's forward
   * lamp a full bay aft of the spot Ash had marked ON that beam.
   */
  it('offers a beam over an opening outboard of its carlings, not inboard', () => {
    const wardroom = belowDecksSpace('wardroom');
    const hatch = DECK_OPENINGS.find((opening) => opening.name === 'cargoHatch');
    expect(hatch).toBeDefined();
    if (!hatch) return;
    const acrossHatchZ = (hatch.zAft + hatch.zForward) / 2;

    // Outboard: the beam at that station is available, so the nearest hang
    // to a mark there stays there rather than fleeing to the next bay.
    const outboard = deckBeamHangPoint(wardroom, 1.05, acrossHatchZ);
    expect(outboard).not.toBeNull();
    if (outboard) expect(Math.abs(outboard.z - acrossHatchZ)).toBeLessThan(0.3);

    // On the centreline the same station is the hole itself: the nearest
    // real timber is a bay away, and the helper must say so.
    const inboard = deckBeamHangPoint(wardroom, 0, acrossHatchZ);
    expect(inboard).not.toBeNull();
    if (inboard) expect(Math.abs(inboard.z - acrossHatchZ)).toBeGreaterThan(0.3);
  });
});

describe('the schooner wiring', () => {
  it('hangs every lamp on beam timber in its room, off the centreline', () => {
    const ship = new Schooner({ advancesWaveField: false });
    try {
      for (const { id, room } of LAMP_HANGS) {
        const lamp = ship.interiorLampOf(id);
        expect(lamp, id).not.toBeNull();
        if (!lamp) continue;
        const p = lamp.group.position;
        const hang = lampHangPoint(id);
        expect(p.x, id).toBe(hang.x);
        expect(p.y, id).toBe(hang.y);
        expect(p.z, id).toBe(hang.z);
        const space = belowDecksSpace(room);
        // Inside the room, hung not standing, and off the walking line.
        expect(p.z, id).toBeGreaterThan(space.zAft);
        expect(p.z, id).toBeLessThan(space.zForward);
        expect(p.y, id).toBeGreaterThan(space.soleY + 1.0);
        expect(Math.abs(p.x), id).toBeGreaterThan(0.2);
        // And seated at beam-soffit height. `spaceDeckheadY` samples the
        // walker's inset roof station while the hang uses the drawn beam's
        // own z, so the sheer allows a few centimetres between them — the
        // band still catches a hook floating mid-air or up at the planking.
        const beamSoffit = spaceDeckheadY(space, p.x, p.z);
        expect(beamSoffit, id).not.toBeNull();
        if (beamSoffit !== null) {
          expect(Math.abs(p.y - beamSoffit), id).toBeLessThan(0.05);
        }
      }
    } finally {
      ship.dispose();
    }
  });

  it('reports every lamp and its room signal through lampsDebug', () => {
    const ship = new Schooner({ advancesWaveField: false });
    try {
      const debug = ship.lampsDebug();
      for (const { id, room } of LAMP_HANGS) {
        expect(debug[id], id).toBeDefined();
        expect(debug[id].room).toBe(room);
        expect(debug[id].mode).toBe('auto');
        expect(debug[id].litLevel).toBe(0);
        expect(typeof debug[id].roomDaylightLuminance).toBe('number');
        // Requested on by default, but never ACTIVE while the flame is cold.
        expect(debug[id].shadow).toBe(false);
      }
      // The wardroom carries two, each its own lamp on the shared signal.
      expect(debug['wardroom-aft'].room).toBe('wardroom');
      expect(debug['wardroom-fore'].room).toBe('wardroom');
    } finally {
      ship.dispose();
    }
  });

  it('exposes the Space action handlers per room', () => {
    const ship = new Schooner({ advancesWaveField: false });
    try {
      expect(ship.isLampWantedLit('cabin')).toBe(false);
      ship.toggleLamp('cabin');
      expect(ship.isLampWantedLit('cabin')).toBe(true);
      expect(ship.isLampWantedLit('wardroom-aft')).toBe(false);
      expect(ship.isLampWantedLit('wardroom-fore')).toBe(false);
    } finally {
      ship.dispose();
    }
  });
});
