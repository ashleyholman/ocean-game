import { describe, expect, it } from 'vitest';
import type { OvertopEvent } from '../src/vessel/BuoyantBody';
import {
  OvertopSpray,
  RAFT_OVERTOP_SPRAY,
  type OvertopSprayOptions,
} from '../src/scene/OvertopSpray';
import {
  GRAVITY_MPS2,
  overtopEventStrength,
  overtopReferencesFromFreeboard,
} from '../src/scene/wakePolicy';
import { buildSchoonerBuoyancy } from '../src/vessel/schooner/SchoonerBuoyancy';

/** The schooner's port, as `Schooner` builds it. */
function schoonerOptions(freeboardM: number): Partial<OvertopSprayOptions> {
  return {
    ...overtopReferencesFromFreeboard(freeboardM),
    siteSpacingM: 3.9,
    cooldownSeconds: 0.35,
    capacity: 36,
    puffScaleM: 2.6,
    inboardBias: 0.7,
    seed: 0x51a37c9,
  };
}

function event(overrides: Partial<OvertopEvent> = {}): OvertopEvent {
  return {
    x: 0,
    y: 4,
    z: 0,
    speed: 1,
    depth: 0.5,
    durationSeconds: 1 / 240,
    contactWidthM: 0.5,
    tributaryAreaM2: 0.25,
    stationIndex: 0,
    batchStepIndex: 0,
    stationLocalZ: 0,
    boardingSide: 'starboard',
    flowX: 1,
    flowZ: 0,
    ...overrides,
  };
}

function livePuffs(spray: OvertopSpray): Array<{
  x: number;
  y: number;
  z: number;
}> {
  return spray.group.children
    .filter((child) => child.visible)
    .map((child) => ({
      x: child.position.x,
      y: child.position.y,
      z: child.position.z,
    }));
}

describe('overtop cue sizing', () => {
  /**
   * The raft's cue must not have moved.
   *
   * WK3 re-expressed `min(1, speed·0.55 + depth·2.2)` as a pair of references,
   * which is a refactor only if it really is one. This mirrors the old
   * arithmetic rather than quoting the new constants at themselves.
   */
  it('reproduces the pre-WK3 raft curve exactly from the raft references', () => {
    for (const depth of [0, 0.02, 0.05, 0.12, 0.3, 0.45, 0.9]) {
      for (const speed of [0, 0.2, 0.5, 1, 1.8, 3]) {
        const legacy = Math.min(1, speed * 0.55 + depth * 2.2);
        expect(
          overtopEventStrength(
            depth,
            speed,
            RAFT_OVERTOP_SPRAY.depthReferenceM,
            RAFT_OVERTOP_SPRAY.speedReferenceMps,
          ),
        ).toBeCloseTo(legacy, 12);
      }
    }
  });

  it('derives the schooner references from her own freeboard', () => {
    const freeboard = buildSchoonerBuoyancy().freeboard;
    // Mean outer crown 3.9969 less the 2.3000 design waterline. If the hull is
    // reloftt this moves, and every number below moves with it — which is the
    // point of deriving rather than writing 1.697 down.
    expect(freeboard).toBeCloseTo(1.6969, 3);

    const references = overtopReferencesFromFreeboard(freeboard);
    expect(references.depthReferenceM).toBeCloseTo(freeboard, 12);
    expect(references.speedReferenceMps).toBeCloseTo(
      Math.sqrt(2 * GRAVITY_MPS2 * freeboard),
      12,
    );
  });

  /**
   * The bug the reference change exists to fix — and it is scale, not silence.
   *
   * Three real measurements, spanning what actually happens to her. Under the
   * raft curve the whole span collapses: a 0.15 m lick and a 1.89 m burying are
   * both a full green-water wash, because the curve saturates at a fifth of her
   * freeboard. Under her own freeboard the span is preserved, which is what the
   * cue is for — she should look different when she is buried than when she is
   * licked, and under the old curve she could not.
   */
  it('recovers the range the raft curve had collapsed', () => {
    const freeboard = buildSchoonerBuoyancy().freeboard;
    const { depthReferenceM, speedReferenceMps } =
      overtopReferencesFromFreeboard(freeboard);
    const raftCurve = (depth: number, speed: number): number =>
      overtopEventStrength(
        depth,
        speed,
        RAFT_OVERTOP_SPRAY.depthReferenceM,
        RAFT_OVERTOP_SPRAY.speedReferenceMps,
      );
    const hers = (depth: number, speed: number): number =>
      overtopEventStrength(depth, speed, depthReferenceM, speedReferenceMps);

    // This branch's beam-reach peak: 9 frames in 5 400, the sea just reaching
    // her deck edge. The raft curve draws two thirds of a wash; hers draws
    // nothing, and nothing is right.
    expect(raftCurve(0.0764, 0.859)).toBeCloseTo(0.6405, 3);
    expect(hers(0.0764, 0.859)).toBeCloseTo(0.1939, 3);
    expect(hers(0.0764, 0.859)).toBeLessThan(0.3);

    // WK-R-F1's recorded peak, 0.151 m at 1.329 m/s. The raft curve clamps this
    // to a full wash (2.2·0.151 + 0.55·1.329 = 1.063). Hers puts it just over
    // the gate — the smallest cue there is, three small puffs, which is the
    // honest picture of 15 cm of water crossing a rail at walking pace.
    expect(raftCurve(0.151, 1.329)).toBe(1);
    expect(hers(0.151, 1.329)).toBeCloseTo(0.3193, 3);
    expect(hers(0.151, 1.329)).toBeGreaterThan(0.3);
    expect(hers(0.151, 1.329)).toBeLessThan(0.4);

    // The running sizing case, which genuinely does bury her. Both curves say
    // "wash" — but only hers has anywhere left to go between the three.
    expect(hers(0.398, 1.0)).toBeGreaterThan(0.3);
    expect(hers(1.8927, 8.096)).toBe(1);
    expect(hers(1.8927, 8.096) - hers(0.151, 1.329)).toBeGreaterThan(0.6);
    expect(raftCurve(1.8927, 8.096) - raftCurve(0.151, 1.329)).toBe(0);
  });

  it('never returns a strength outside 0..1 for any physical event', () => {
    const { depthReferenceM, speedReferenceMps } =
      overtopReferencesFromFreeboard(1.6969);
    for (const depth of [0, 0.001, 1, 5, 50]) {
      for (const speed of [0, 0.5, 8, 40]) {
        const value = overtopEventStrength(
          depth,
          speed,
          depthReferenceM,
          speedReferenceMps,
        );
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('overtop cue emission', () => {
  const freeboard = 1.6969;

  it('is bounded by its pool however many events arrive in one frame', () => {
    // Her heaviest measured frame carries 118 simultaneous events, and a cue
    // that tried to serve them all would recycle water still in the air.
    const spray = new OvertopSpray(schoonerOptions(freeboard));
    const events = Array.from({ length: 200 }, (_, index) =>
      event({ x: index * 5, z: index * 5, depth: 1.5, speed: 4 }),
    );
    for (let frame = 0; frame < 120; frame++) {
      spray.update(1 / 60, events);
      expect(spray.activeCount).toBeLessThanOrEqual(spray.capacity);
    }
  });

  it('draws nothing for events below the cue gate', () => {
    const spray = new OvertopSpray(schoonerOptions(freeboard));
    const marginal = [event({ depth: 0.0764, speed: 0.859 })];
    for (let frame = 0; frame < 60; frame++) spray.update(1 / 60, marginal);
    expect(spray.activeCount).toBe(0);
  });

  it('reproduces its trace from its seed', () => {
    const events = [event({ depth: 1.2, speed: 3 })];
    const run = (): Array<{ x: number; y: number; z: number }> => {
      const spray = new OvertopSpray(schoonerOptions(freeboard));
      for (let frame = 0; frame < 30; frame++) spray.update(1 / 60, events);
      return livePuffs(spray);
    };
    const first = run();
    expect(first.length).toBeGreaterThan(0);
    expect(run()).toEqual(first);
  });

  it('restores its stream on clear, so a reset ship replays', () => {
    const events = [event({ depth: 1.2, speed: 3 })];
    const spray = new OvertopSpray(schoonerOptions(freeboard));
    for (let frame = 0; frame < 30; frame++) spray.update(1 / 60, events);
    const first = livePuffs(spray);

    spray.clear();
    expect(spray.activeCount).toBe(0);
    for (let frame = 0; frame < 30; frame++) spray.update(1 / 60, events);
    expect(livePuffs(spray)).toEqual(first);
  });

  /**
   * Sign set by test, not by reasoning.
   *
   * With the hull heading along +z (yaw 0) the lateral axis is x, so a wash
   * boarding to starboard of the centreline must be thrown back toward it —
   * whatever the water's own flow says. Before the fold, a roll could aim the
   * cue squarely overboard.
   */
  it('folds the throw inboard, from the site rather than from an assumption', () => {
    const events = [event({ x: 6, z: 0, depth: 1.4, speed: 3, flowX: 1, flowZ: 0 })];
    const frame = { originX: 0, originZ: 0, yaw: 0 };

    const inboard = new OvertopSpray(schoonerOptions(freeboard));
    inboard.update(1 / 60, events, frame);
    const withFold = livePuffs(inboard);

    const plain = new OvertopSpray({ ...schoonerOptions(freeboard), inboardBias: 0 });
    plain.update(1 / 60, events, frame);
    const withoutFold = livePuffs(plain);

    // Both spawn at the site; the difference is where they are going. Step them
    // and compare how far each has travelled from the centreline.
    for (let step = 0; step < 12; step++) {
      inboard.update(1 / 60, events, frame);
      plain.update(1 / 60, events, frame);
    }
    const meanX = (puffs: Array<{ x: number }>): number =>
      puffs.reduce((sum, puff) => sum + puff.x, 0) / puffs.length;

    expect(withFold.length).toBeGreaterThan(0);
    expect(withoutFold.length).toBeGreaterThan(0);
    // The unfolded cue follows +x flow, straight over the side. The folded one
    // must end up nearer the centreline than that.
    expect(meanX(livePuffs(inboard))).toBeLessThan(meanX(livePuffs(plain)));

    // And a site to port folds the other way, from the same code.
    const portEvents = [
      event({ x: -6, z: 0, depth: 1.4, speed: 3, flowX: -1, flowZ: 0 }),
    ];
    const portInboard = new OvertopSpray(schoonerOptions(freeboard));
    const portPlain = new OvertopSpray({
      ...schoonerOptions(freeboard),
      inboardBias: 0,
    });
    for (let step = 0; step < 13; step++) {
      portInboard.update(1 / 60, portEvents, frame);
      portPlain.update(1 / 60, portEvents, frame);
    }
    expect(meanX(livePuffs(portInboard))).toBeGreaterThan(
      meanX(livePuffs(portPlain)),
    );
  });

  /**
   * Water that comes over a rail has somewhere to arrive.
   *
   * The crown the event crossed is the deck edge on both vessels, so a puff
   * that falls back to it has landed and must stop there rather than sinking
   * through the ship and fading in mid-air below her.
   */
  it('lands a puff on the crown it came over, and holds it there', () => {
    const crownY = 4;
    const events = [event({ y: crownY, depth: 1.4, speed: 3 })];
    const spray = new OvertopSpray(schoonerOptions(freeboard));
    spray.update(1 / 60, events);

    let minimum = Infinity;
    // Long enough for the throw to rise, fall back and settle, but inside the
    // puff lifetime so they are still alive to be checked.
    for (let step = 0; step < 45; step++) {
      spray.update(1 / 60, []);
      for (const puff of livePuffs(spray)) minimum = Math.min(minimum, puff.y);
    }
    expect(minimum).toBeGreaterThanOrEqual(crownY - 1e-9);
  });

  it('is silent while switched off, and stays constructible without a canvas', () => {
    // The whole file runs in node with no DOM. That is itself the assertion:
    // before WK3 an eager canvas here made four unrelated schooner tests fail.
    const spray = new OvertopSpray(schoonerOptions(freeboard));
    spray.enabled = false;
    const events = [event({ depth: 1.6, speed: 5 })];
    for (let frame = 0; frame < 60; frame++) spray.update(1 / 60, events);
    expect(spray.activeCount).toBe(0);
  });
});
