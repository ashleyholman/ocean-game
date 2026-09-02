import { describe, expect, it } from 'vitest';
import { findSeaState } from '../src/ocean/presets';
import { cloneSeaState } from '../src/ocean/seaState';
import { RaftBuoyancy } from '../src/vessel/raft/RaftBuoyancy';
import {
  DECK_LENGTH,
  RAFT_SEED,
  buildRaftTimber,
  buildRaftTopsides,
  makeRandom,
} from '../src/vessel/raft/raftFlotation';
import { WaveField } from '../src/scene/Waves';

/**
 * Characterisation test for the raft's flotation.
 *
 * Written before `RaftBuoyancy` was generalised for the schooner, for one
 * reason: the raft had no automated guard on its dynamics — verification was
 * the interactive `?debug=buoyancy` harness — so a refactor of the physics had
 * nothing to prove itself against.
 *
 * **These numbers are recorded, not derived.** They are what the shipped raft
 * produced at commit 8d9f445, before any ship work. A diff here means behaviour
 * moved. If that is intended, re-record deliberately and say so in the commit
 * message; if it is not, the change is wrong.
 *
 * Tolerances are tight on purpose. The generalisation was expected to be
 * arithmetically identical rather than merely similar, and a loose tolerance
 * would hide exactly the drift this exists to catch.
 *
 * What this does NOT cover: that `Raft.ts` builds its meshes from these same
 * records. That cannot run headlessly — `OvertopSpray` needs a DOM canvas — and
 * is instead structural: `Raft` calls `buildRaftTimber` and builds its cylinders
 * from the returned records, so the picture and the physics cannot disagree
 * without the call itself being removed.
 */

/**
 * The exact sea these numbers were recorded on, pinned rather than looked up.
 *
 * It is `CURRENT_MODERATE` as it stood at 8d9f445, and the one thing that has
 * moved since is the wind direction: the production preset now blows square
 * across its own swell so the ship has a beam reach to open on
 * (`src/world/openingVoyage.ts`). That rotation re-aims the wind-sea partition
 * and so moves every number below — through the sea, not through the raft.
 *
 * A characterisation of the raft's dynamics must not also be a
 * characterisation of whatever the shipping ocean happens to be this month, or
 * every re-aim of the sea reads as a physics regression. So the direction is
 * restated here and the rest is read from the preset, which keeps the guard on
 * the arithmetic exactly as tight as it was.
 */
const RECORDED_WIND_DIRECTION_DEG = 68;

function recordedSea() {
  const sea = cloneSeaState(findSeaState('CURRENT_MODERATE'));
  (sea.generatingWind as { directionDeg: number }).directionDeg =
    RECORDED_WIND_DIRECTION_DEG;
  return sea;
}

function buildBody(): RaftBuoyancy {
  const timber = buildRaftTimber(makeRandom(RAFT_SEED));
  return new RaftBuoyancy({
    logs: timber.logs,
    beams: timber.beams,
    deckLength: DECK_LENGTH,
    topsides: buildRaftTopsides(),
  });
}

describe('raft flotation — characterisation', () => {
  it('builds the same timber from the seed', () => {
    const timber = buildRaftTimber(makeRandom(RAFT_SEED));

    expect(timber.logs).toHaveLength(9);
    expect(timber.beams).toHaveLength(2);
    expect(timber.logTilt).toHaveLength(9);
    expect(timber.beamYaw).toHaveLength(2);

    // The first and last log pin both ends of the LCG sequence: if the order of
    // draws changes, these move even when the count does not.
    const first = timber.logs[0];
    expect(first.radiusBow).toBeCloseTo(0.11479088230472473, 12);
    expect(first.radiusStern).toBeCloseTo(0.10698605031440052, 12);
    expect(first.length).toBeCloseTo(3.1687713843137026, 12);
    expect(first.x).toBeCloseTo(-0.9820293493827599, 12);
    expect(first.y).toBeCloseTo(0.12674424979137258, 12);
    expect(first.z).toBeCloseTo(0.0674248169362545, 12);

    const last = timber.logs[8];
    expect(last.radiusBow).toBeCloseTo(0.1133169565204945, 12);
    expect(last.radiusStern).toBeCloseTo(0.10502239152315132, 12);
    expect(last.length).toBeCloseTo(3.1144150661975143, 12);
    expect(last.x).toBeCloseTo(0.9769798099694568, 12);
  });

  it('solves the same equilibrium hydrostatics', () => {
    const body = buildBody();

    expect(body.stations).toHaveLength(24);
    expect(body.mass).toBeCloseTo(748.2095161136376, 9);
    expect(body.comX).toBeCloseTo(-0.027867479043565554, 12);
    expect(body.comY).toBeCloseTo(0.1913965781992746, 12);
    expect(body.comZ).toBeCloseTo(0.10167347389715946, 12);

    expect(body.designWaterlineY).toBeCloseTo(0.13811374216923583, 12);
    expect(body.displacedVolume).toBeCloseTo(0.7299605035255, 12);
    expect(body.waterplaneArea).toBeCloseTo(6.6363691261869855, 12);
    expect(body.outerCrownY).toBeCloseTo(0.24309007233137753, 12);
    expect(body.freeboard).toBeCloseTo(0.1049763301621417, 12);
  });

  it('derives the same inertias and damping', () => {
    const body = buildBody();

    expect(body.inertiaPitch).toBeCloseTo(1330.6312165468157, 9);
    expect(body.inertiaRoll).toBeCloseTo(621.0189900941754, 9);
    expect(body.heaveNaturalFrequency).toBeCloseTo(6.677825895526256, 10);
    expect(body.dampingRatio).toBe(0.6);
    expect(body.addedMassCoefficient).toBe(1);
  });

  it('settles onto a known sea identically', () => {
    const body = buildBody();
    const waves = new WaveField(recordedSea());

    body.snapToSurface(waves, 0, 0, 0);

    expect(body.pitch).toBeCloseTo(-0.01511252605041777, 12);
    expect(body.roll).toBeCloseTo(-0.040272444714753046, 12);
    expect(body.comWorldY).toBeCloseTo(0.14155971184259225, 12);
  });

  it('reaches the same state after ten seconds of integration', () => {
    const body = buildBody();
    const waves = new WaveField(recordedSea());

    body.snapToSurface(waves, 0, 0, 0);
    for (let i = 0; i < 600; i++) body.update(1 / 60, waves, 0, 0, 0);

    // 600 frames at 1/60 s, four 1/240 s substeps each: 2400 integration steps
    // of a non-linear system. Nothing here is stable against a change in the
    // arithmetic, which is the point.
    expect(waves.time).toBeCloseTo(10, 10);
    expect(body.comWorldY).toBeCloseTo(0.3375795000827555, 10);
    expect(body.pitch).toBeCloseTo(0.005627749477408219, 10);
    expect(body.roll).toBeCloseTo(0.014894401603350744, 10);
    expect(body.velocityY).toBeCloseTo(-0.16826122578955577, 10);
    expect(body.pitchRate).toBeCloseTo(0.030924315521616917, 10);
    expect(body.rollRate).toBeCloseTo(-0.1510175863656291, 10);
  });
});
