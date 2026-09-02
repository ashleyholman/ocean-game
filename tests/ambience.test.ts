import { describe, expect, it } from 'vitest';

import { Ambience } from '../src/audio/Ambience';
import { SOUND_LAYERS } from '../src/audio/SoundMixer';
import type { SoundSamplerPorts } from '../src/audio/SoundSampler';
import { SEA_STATES } from '../src/ocean/presets';
import { whitecapCoverage } from '../src/ocean/spectrum';

/**
 * The degrade-to-silence gate.
 *
 * This whole file runs in node, where there is no `AudioContext` at all. That
 * is not a limitation being worked around — it is the same code path as a
 * browser before the first user gesture, and as a muted session, and the frame
 * loop must survive all three identically. Most of what follows is really one
 * assertion restated: audio never takes the frame down with it.
 */

const PLAYABLE = SEA_STATES.filter((state) => state.purpose === 'PLAYABLE');
const CALM = PLAYABLE.reduce((quietest, state) =>
  state.generatingWind.speedMps < quietest.generatingWind.speedMps ? state : quietest,
);
const BLOW = PLAYABLE.reduce((worst, state) =>
  state.generatingWind.speedMps > worst.generatingWind.speedMps ? state : worst,
);

describe('ambience without an AudioContext', () => {
  it('starts muted and toggles to unmuted', () => {
    const ambience = new Ambience();
    expect(ambience.isMuted).toBe(true);
    ambience.toggleMute();
    expect(ambience.isMuted).toBe(false);
  });

  it('never reports a running graph in node', () => {
    const ambience = new Ambience();
    ambience.start();
    expect(ambience.isRunning).toBe(false);
  });

  it('survives start, update, mute and dispose with no audio at all', () => {
    const ambience = new Ambience();
    expect(() => {
      ambience.start();
      // Twice: `start` must be idempotent even when it found nothing.
      ambience.start();
      // Weather may release a delayed cue before audio has ever been armed.
      ambience.triggerThunder(0.9, 780);
      ambience.update(CALM, whitecapCoverage(CALM.generatingWind.speedMps));
      ambience.toggleMute();
      ambience.update(BLOW, whitecapCoverage(BLOW.generatingWind.speedMps));
      ambience.setSolo('rigging');
      ambience.update(BLOW, whitecapCoverage(BLOW.generatingWind.speedMps));
      ambience.setSolo(null);
      ambience.dispose();
      ambience.dispose();
    }).not.toThrow();
  });

  it('still maps the world with no graph, so the dev panel has something to show', () => {
    const ambience = new Ambience();
    ambience.toggleMute();
    ambience.update(BLOW, whitecapCoverage(BLOW.generatingWind.speedMps));
    // No sampler is attached, so this is the fallback state: the sea's own
    // floor and nothing else. The mapping ran regardless.
    expect(ambience.voiceLevels.swell.gain).toBeGreaterThan(0);
    expect(ambience.voiceLevels.master).toBeGreaterThan(0);
  });

  it('exposes live trims for every named voice', () => {
    const ambience = new Ambience();
    for (const layer of SOUND_LAYERS) {
      expect(ambience.mixer.layers[layer]).toBe(1);
    }
  });

  it('updates before a world is attached', () => {
    const ambience = new Ambience();
    expect(() => ambience.update(CALM, 0)).not.toThrow();
    expect(ambience.worldState.room).toBeNull();
  });
});

describe('ambience reading a world', () => {
  /**
   * A hand-built set of ports.
   *
   * Worth noting how little this needs: a camera, an anchor, a bow point and
   * seven numbers. That is the measure of the sampler boundary doing its job —
   * the audio system can be driven end to end with no renderer, no vessel and
   * no simulation.
   */
  function ports(
    overrides: {
      apparentWindMps?: number;
      shakingClothAreaM2?: number;
      speedThroughWaterMps?: number;
      cameraDistance?: number;
      facing?: { x: number; z: number };
    } = {},
  ): SoundSamplerPorts {
    const facing = overrides.facing ?? { x: 0, z: -1 };
    const camera = {
      position: { x: 0, y: overrides.cameraDistance ?? 2, z: 0 },
      quaternion: {},
      getWorldDirection: (out: { x: number; y: number; z: number }) => {
        out.x = facing.x;
        out.y = 0;
        out.z = facing.z;
        return out;
      },
    };
    return {
      cameras: { camera, modeName: 'embodied' },
      vessel: {
        cameraAnchor: { matrixWorld: {}, x: 0, z: 0, waterlineY: 0 },
        bowWorld: { x: 0, y: 0, z: -7 },
        readAcoustics: () => ({
          apparentWindMps: overrides.apparentWindMps ?? 0,
          setClothAreaM2: 120,
          shakingClothAreaM2: overrides.shakingClothAreaM2 ?? 0,
          hullWorkRateRadPerS: 0,
          speedThroughWaterMps: overrides.speedThroughWaterMps ?? 0,
        }),
      },
      waves: { significantHeight: 1.2, dominantPeriod: 7 },
      // The raft arm: no interior, so the room lookup is skipped entirely.
      hasInterior: false,
    } as unknown as SoundSamplerPorts;
  }

  it('drives the rigging from apparent wind rather than a sail boolean', () => {
    const quiet = new Ambience();
    quiet.toggleMute();
    quiet.attachWorld(ports({ apparentWindMps: 1 }));
    quiet.update(CALM, 0);

    const loud = new Ambience();
    loud.toggleMute();
    loud.attachWorld(ports({ apparentWindMps: 22 }));
    loud.update(CALM, 0);

    expect(loud.voiceLevels.rigging.gain).toBeGreaterThan(
      quiet.voiceLevels.rigging.gain,
    );
    expect(quiet.voiceLevels.rigging.gain).toBeLessThan(0.05);
  });

  it('reads the sea instant and coverage the caller resolved', () => {
    const ambience = new Ambience();
    ambience.toggleMute();
    ambience.attachWorld(ports());
    const coverage = whitecapCoverage(BLOW.generatingWind.speedMps);
    ambience.update(BLOW, coverage);
    expect(ambience.worldState.whitecapCoverage).toBe(coverage);
    expect(ambience.worldState.whitewaterGeneration).toBe(
      BLOW.whitewater.generation,
    );
    expect(ambience.worldState.significantHeightM).toBe(1.2);
  });

  it('drops the ship voices when the camera pulls away, and keeps the sea', () => {
    const near = new Ambience();
    near.toggleMute();
    near.attachWorld(ports({ speedThroughWaterMps: 4, cameraDistance: 3 }));
    near.update(CALM, 0);

    const far = new Ambience();
    far.toggleMute();
    far.attachWorld(ports({ speedThroughWaterMps: 4, cameraDistance: 1400 }));
    far.update(CALM, 0);

    expect(near.voiceLevels.bow.gain).toBeGreaterThan(0.5);
    expect(far.voiceLevels.bow.gain).toBe(0);
    expect(far.voiceLevels.swell.gain).toBe(near.voiceLevels.swell.gain);
  });

  it('places the bow to the left when the listener faces along the beam', () => {
    const ambience = new Ambience();
    ambience.toggleMute();
    // Facing +x; the bow lies at −z, which is off the left hand.
    ambience.attachWorld(
      ports({ speedThroughWaterMps: 4, facing: { x: 1, z: 0 } }),
    );
    ambience.update(CALM, 0);
    expect(ambience.voiceLevels.bow.pan).toBeLessThan(-0.5);
  });

  it('centres the bow when the listener is looking straight at it', () => {
    const ambience = new Ambience();
    ambience.toggleMute();
    ambience.attachWorld(
      ports({ speedThroughWaterMps: 4, facing: { x: 0, z: -1 } }),
    );
    ambience.update(CALM, 0);
    expect(Math.abs(ambience.voiceLevels.bow.pan)).toBeLessThan(1e-9);
  });
});
