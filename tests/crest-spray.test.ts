import { describe, expect, it } from 'vitest';
import { findSeaState } from '../src/ocean/presets';
import {
  CREST_SPRAY_DESKTOP,
  CrestSpray,
  type SprayBurstSource,
} from '../src/scene/CrestSpray';
import { WaveField, createSeedSample, createSurfaceSample } from '../src/scene/Waves';

const SOUTHERN = 'SOUTHERN_OCEAN_ROUGH';
const CALM = 'GLASSY_LONG_SWELL';

function southernField(): WaveField {
  const waves = new WaveField(findSeaState(SOUTHERN));
  waves.setTime(97.5);
  return waves;
}

/**
 * Wind of the Southern preset, in render axes, as `main.ts` hands it over.
 * `WindSystem.direction` is (sin h, -cos h) for a heading the wind blows
 * towards.
 */
function southernWind(): { x: number; z: number; speed: number } {
  const state = findSeaState(SOUTHERN);
  const h = (state.generatingWind.directionDeg * Math.PI) / 180;
  return { x: Math.sin(h), z: -Math.cos(h), speed: state.generatingWind.speedMps };
}

describe('WaveField.sampleSeed', () => {
  it('places a parameter point exactly where evaluateSeed does', () => {
    const waves = southernField();
    const seed = createSeedSample();
    const forward = { x: 0, y: 0, z: 0 };

    for (const [px, pz] of [
      [0, 0],
      [13.5, -42.25],
      [-118, 76.5],
      [301.75, 259],
    ]) {
      waves.sampleSeed(px, pz, seed);
      waves.evaluateSeed(px, pz, forward);
      expect(seed.x).toBeCloseTo(forward.x, 12);
      expect(seed.height).toBeCloseTo(forward.y, 12);
      expect(seed.z).toBeCloseTo(forward.z, 12);
    }
  });

  /**
   * The property the whole system rests on: the forward evaluation and the
   * inverse solve describe the same surface. If they drift, sheets are torn off
   * water that is not the water the foam shader whitened, and no amount of
   * tuning finds that — it presents as spray that is subtly off its crests.
   */
  it('round-trips through the inverse solve', () => {
    const waves = southernField();
    const seed = createSeedSample();
    const visible = createSurfaceSample();

    for (const [px, pz] of [
      [0, 0],
      [13.5, -42.25],
      [-118, 76.5],
      [301.75, 259],
    ]) {
      waves.sampleSeed(px, pz, seed);
      // Ask the inverse solve what is visible where the forward map landed.
      waves.sample(seed.x, seed.z, visible);
      expect(visible.height).toBeCloseTo(seed.height, 6);
      expect(visible.compression).toBeCloseTo(seed.compression, 6);
      expect(visible.velocityX).toBeCloseTo(seed.velocityX, 6);
      expect(visible.velocityZ).toBeCloseTo(seed.velocityZ, 6);
    }
  });

  it('reports no water motion while the field is frozen', () => {
    const waves = southernField();
    const seed = createSeedSample();
    waves.frozen = true;
    waves.sampleSeed(21, -13, seed);
    // Closeness rather than identity: the multiply by zero carries the sign of
    // the velocity it silenced, and -0 is still a stopped particle.
    expect(seed.velocityX).toBeCloseTo(0, 12);
    expect(seed.velocityY).toBeCloseTo(0, 12);
    expect(seed.velocityZ).toBeCloseTo(0, 12);
  });
});

describe('CrestSpray', () => {
  function run(seaName: string, seconds = 2.0): CrestSpray {
    const waves = new WaveField(findSeaState(seaName));
    const state = findSeaState(seaName);
    const h = (state.generatingWind.directionDeg * Math.PI) / 180;
    const spray = new CrestSpray(CREST_SPRAY_DESKTOP);
    const dt = 1 / 60;
    for (let step = 0; step * dt < seconds; step++) {
      waves.setTime(step * dt);
      spray.update(
        dt,
        waves,
        Math.sin(h),
        -Math.cos(h),
        state.generatingWind.speedMps,
        state.whitewater.sprayIntensity,
        state.generatingWind.gustiness,
        step * dt,
      );
    }
    return spray;
  }

  it('tears spray off a gale', () => {
    const spray = run(SOUTHERN);
    // A tear sheds continuously for the best part of a second, so anything
    // alive at all means whole ridges were found, not stray probes.
    expect(spray.activeCount).toBeGreaterThan(200);
  });

  it('leaves a calm sea alone', () => {
    // GLASSY_LONG_SWELL is below the wind gate however big its swell is: a
    // crest that is not being torn apart sheds nothing, and this is the guard
    // that keeps storm loading out of the quiet presets.
    const spray = run(CALM);
    expect(spray.activeCount).toBe(0);
    expect(spray.activity).toBe(0);
  });

  it('is deterministic, so a capture replays exactly', () => {
    const a = run(SOUTHERN, 1.0);
    const b = run(SOUTHERN, 1.0);
    expect(a.activeCount).toBe(b.activeCount);
    expect(a.activity).toBeCloseTo(b.activity, 12);
  });

  it('emits nothing at all once switched off', () => {
    const waves = southernField();
    const wind = southernWind();
    const spray = new CrestSpray(CREST_SPRAY_DESKTOP);
    spray.enabled = false;
    for (let step = 0; step < 120; step++) {
      waves.setTime(step / 60);
      spray.update(1 / 60, waves, wind.x, wind.z, wind.speed, 1.8, 0.7, step / 60);
    }
    expect(spray.activeCount).toBe(0);
  });

  /**
   * The defect this system was rebuilt around.
   *
   * The first version integrated free fall, which threw every droplet on a short
   * ballistic arc and read as a wave crashing over forwards rather than as water
   * being ripped away sideways. Spray is 80 µm to 2 mm; a 100 µm droplet settles
   * at about half a metre a second, so in a gale it is carried, not dropped.
   *
   * Measured on velocity rather than on position, deliberately. Droplets are
   * born at crest height and the crest swings through ±5 m, so absolute height
   * says nothing about whether a droplet is falling — the first version of this
   * test measured that confound and failed for the wrong reason.
   */
  it('carries droplets on the wind instead of dropping them', () => {
    const spray = run(SOUTHERN, 3.0);
    const g = spray.points.geometry;
    const vel = g.getAttribute('iVelocity').array as Float32Array;
    const life = g.getAttribute('iLife').array as Float32Array;

    let n = 0;
    let sumVy = 0;
    let sumSpeed = 0;
    let fastestFall = 0;
    for (let i = 0; i < life.length / 2; i++) {
      // Only droplets that have been in the air long enough to have reached
      // their own steady state have a trajectory worth measuring.
      if (life[i * 2 + 1] <= 0 || life[i * 2] < 0.8) continue;
      n++;
      const vy = vel[i * 3 + 1];
      sumVy += vy;
      sumSpeed += Math.hypot(vel[i * 3], vel[i * 3 + 2]);
      fastestFall = Math.min(fastestFall, vy);
    }

    expect(n).toBeGreaterThan(50);
    // Free fall for 0.8 s is already -7.8 m/s and accelerating. Nothing here may
    // approach that: the largest droplet modelled settles at 6.8 m/s and the
    // overwhelming majority are under one.
    expect(fastestFall).toBeGreaterThan(-7.0);
    // Bounded against the failure rather than fitted to the current mix: the
    // population mean sits near -1.9 m/s and moves with the droplet-size draw,
    // so a tight bound here fails on density changes that are not defects.
    expect(sumVy / n).toBeGreaterThan(-3.0);
    // And they are genuinely being carried: an 18 m/s wind, and the settled
    // population should be doing most of it.
    expect(sumSpeed / n).toBeGreaterThan(10);
  });

  it('gives fine droplets a longer life than coarse ones', () => {
    const spray = run(SOUTHERN, 2.0);
    const g = spray.points.geometry;
    const size = g.getAttribute('iSize').array as Float32Array;
    const life = g.getAttribute('iLife').array as Float32Array;
    let fineLife = 0;
    let fineN = 0;
    let coarseLife = 0;
    let coarseN = 0;
    for (let i = 0; i < life.length / 2; i++) {
      if (life[i * 2 + 1] <= 0) continue;
      // Radius runs backwards from droplet size: a fine droplet is an
      // unresolvable mist drawn as a large soft parcel, a coarse one is a
      // visible individual drop drawn small and tight.
      if (size[i * 3] > 0.6) { fineLife += life[i * 2 + 1]; fineN++; }
      else if (size[i * 3] < 0.25) { coarseLife += life[i * 2 + 1]; coarseN++; }
    }
    expect(fineN).toBeGreaterThan(20);
    expect(coarseN).toBeGreaterThan(0);
    expect(fineLife / fineN).toBeGreaterThan(coarseLife / coarseN);
  });

  /**
   * Emission must not be quantised to the frame clock.
   *
   * The shedding pass runs once a frame, so without a sub-frame birth instant
   * every droplet in the sea is born on a frame boundary. Each frame's cohort is
   * then a curtain launched simultaneously, and the wind carries the previous
   * one 26 cm downwind before the next appears — the sea grows evenly spaced
   * bands of spray, read as vertical stripes when viewed across the wind.
   *
   * It survives because the drag time constant is vt/g, about 0.03 s for the
   * fine fraction: the launch-velocity spread that would otherwise blur the
   * curtains away is erased almost immediately. Better aerodynamics preserve
   * birth-time structure more faithfully, which is why this needs a guard rather
   * than trusting the spread to hide it.
   *
   * Measured before the fix: 4,711 droplets sharing 134 distinct ages.
   */
  it('does not quantise droplet birth to the frame clock', () => {
    const spray = run(SOUTHERN, 4.0);
    const life = spray.points.geometry.getAttribute('iLife').array as Float32Array;
    const dt = 1 / 60;

    let live = 0;
    const ages = new Set<number>();
    let maxResidual = 0;
    for (let i = 0; i < life.length / 2; i++) {
      if (life[i * 2 + 1] <= 0) continue;
      live++;
      const frames = life[i * 2] / dt;
      ages.add(Math.round(frames * 1000) / 1000);
      maxResidual = Math.max(maxResidual, Math.abs(frames - Math.round(frames)));
    }

    expect(live).toBeGreaterThan(500);
    // Ages should be almost all distinct. Frame-quantised emission puts
    // thousands of droplets onto a couple of hundred values.
    expect(ages.size / live).toBeGreaterThan(0.8);
    // And they should fill the frame interval, not sit on its edges.
    expect(maxResidual).toBeGreaterThan(0.4);
  });

  it('opens tears that persist rather than firing one-shot bursts', () => {
    const spray = run(SOUTHERN, 2.0);
    expect(spray.tearCount).toBeGreaterThan(0);
  });

  /**
   * Salt loading is driven by this, so a value that never settles would make the
   * haze breathe. It should rise to a plateau and stay on it.
   */
  it('reports a settled activity for a steady gale', () => {
    const spray = run(SOUTHERN, 20);
    expect(spray.activity).toBeGreaterThan(0.5);
    expect(spray.activity).toBeLessThanOrEqual(1);
  });
});

/**
 * WK3 feeds hull-entry water into this same pool, and the thing that has to
 * hold is that it cannot disturb the sea's own spray. The off/on pair is this
 * project's A/B instrument as well as its regression guard, so a burst emitter
 * that advanced the sea's random stream would make every A/B across the switch
 * meaningless without anything failing.
 */
describe('CrestSpray burst sources', () => {
  function burst(overrides: Partial<SprayBurstSource> = {}): SprayBurstSource {
    return {
      originX: 0,
      originY: 0.4,
      originZ: 7,
      spreadX: 0.8,
      spreadY: 0,
      spreadZ: 0,
      alongX: 0,
      alongY: 0,
      alongZ: 1,
      liftX: 0,
      liftY: 1,
      liftZ: 0,
      throwSpeedMps: 2,
      liftSpeedMps: 1.7,
      outboardSpeedMps: 1.3,
      dropletCount: 120,
      coarseness: 0.75,
      opacity: 1,
      ...overrides,
    };
  }

  /** Every live droplet's position and velocity, for exact comparison. */
  function trace(spray: CrestSpray): number[] {
    const geometry = spray.points.geometry;
    const position = geometry.getAttribute('iPosition').array as Float32Array;
    const velocity = geometry.getAttribute('iVelocity').array as Float32Array;
    const life = geometry.getAttribute('iLife').array as Float32Array;
    return [...position, ...velocity, ...life];
  }

  function steppedGale(seconds: number): CrestSpray {
    const waves = southernField();
    const wind = southernWind();
    const spray = new CrestSpray(CREST_SPRAY_DESKTOP);
    for (let step = 0; step * (1 / 60) < seconds; step++) {
      waves.setTime(step / 60);
      spray.update(1 / 60, waves, wind.x, wind.z, wind.speed, 1.8, 0.7, step / 60);
    }
    return spray;
  }

  it('leaves the sea bit-identical when the source is switched off', () => {
    const seconds = 0.6;
    const reference = steppedGale(seconds);

    const waves = southernField();
    const wind = southernWind();
    const withDisabledBurst = new CrestSpray(CREST_SPRAY_DESKTOP);
    withDisabledBurst.enabled = true;
    for (let step = 0; step * (1 / 60) < seconds; step++) {
      waves.setTime(step / 60);
      withDisabledBurst.update(
        1 / 60,
        waves,
        wind.x,
        wind.z,
        wind.speed,
        1.8,
        0.7,
        step / 60,
      );
      // A source asking for nothing must cost nothing: no ring cursor, no draw
      // from either stream.
      expect(
        withDisabledBurst.emitBurst(
          burst({ dropletCount: 0 }),
          1 / 60,
          wind.speed,
          step / 60,
        ),
      ).toBe(0);
    }

    expect(trace(withDisabledBurst)).toEqual(trace(reference));
    expect(withDisabledBurst.burstDropletCount).toBe(0);
  });

  it('sheds what it was asked for, along the source line', () => {
    const spray = new CrestSpray(CREST_SPRAY_DESKTOP);
    const source = burst();
    expect(spray.emitBurst(source, 1 / 60, 8, 0)).toBe(120);
    expect(spray.burstDropletCount).toBe(120);

    const position = spray.points.geometry.getAttribute('iPosition')
      .array as Float32Array;
    const life = spray.points.geometry.getAttribute('iLife')
      .array as Float32Array;
    let live = 0;
    for (let i = 0; i < CREST_SPRAY_DESKTOP.capacity; i++) {
      if (life[i * 2 + 1] <= 0) continue;
      live++;
      // Spread ±0.8 in x about the origin, plus at most one frame of flight.
      expect(Math.abs(position[i * 3] - source.originX)).toBeLessThan(1.0);
      expect(Math.abs(position[i * 3 + 2] - source.originZ)).toBeLessThan(1.0);
    }
    expect(live).toBe(120);
  });

  it('throws the two sides of the stem apart, not into each other', () => {
    // The outboard term scales linearly with the position along the spread, so
    // droplets on the +spread half must carry +x velocity and the others -x.
    const spray = new CrestSpray(CREST_SPRAY_DESKTOP);
    spray.emitBurst(
      burst({ throwSpeedMps: 0, liftSpeedMps: 0, outboardSpeedMps: 4 }),
      1 / 600,
      0,
      0,
    );
    const position = spray.points.geometry.getAttribute('iPosition')
      .array as Float32Array;
    const velocity = spray.points.geometry.getAttribute('iVelocity')
      .array as Float32Array;
    const life = spray.points.geometry.getAttribute('iLife')
      .array as Float32Array;

    let agreeing = 0;
    let total = 0;
    for (let i = 0; i < CREST_SPRAY_DESKTOP.capacity; i++) {
      if (life[i * 2 + 1] <= 0) continue;
      const across = position[i * 3];
      if (Math.abs(across) < 0.2) continue;
      total++;
      if (Math.sign(across) === Math.sign(velocity[i * 3])) agreeing++;
    }
    expect(total).toBeGreaterThan(40);
    // Gaussian scatter is added on top, so this is a strong majority rather
    // than a law. Without the sign relation it would sit near half.
    expect(agreeing / total).toBeGreaterThan(0.85);
  });

  /**
   * The single number that decides whether the cue reads as bow spray or fog.
   *
   * A droplet's drag time constant is vt/g, so the size draw is what sets how
   * long the throw survives. Sea spume is drawn from a cubed variate and
   * forgets its launch in three frames; a bow burst has to keep it.
   */
  it('draws heavier droplets than the sea does when asked to', () => {
    const meanSpeedAfter = (coarseness: number): number => {
      const spray = new CrestSpray(CREST_SPRAY_DESKTOP);
      spray.emitBurst(burst({ coarseness }), 1 / 600, 0, 0);
      // No wind at all, so the only thing that can change a droplet's velocity
      // is its own relaxation toward its own settling speed.
      const waves = new WaveField(findSeaState(CALM));
      for (let step = 0; step < 12; step++) {
        spray.update(1 / 60, waves, 1, 0, 0, 0, 0, step / 60);
      }
      const velocity = spray.points.geometry.getAttribute('iVelocity')
        .array as Float32Array;
      const life = spray.points.geometry.getAttribute('iLife')
        .array as Float32Array;
      let sum = 0;
      let live = 0;
      for (let i = 0; i < CREST_SPRAY_DESKTOP.capacity; i++) {
        if (life[i * 2 + 1] <= 0) continue;
        sum += Math.abs(velocity[i * 3 + 2]);
        live++;
      }
      return live > 0 ? sum / live : 0;
    };

    // Coarse droplets hold the +z throw; fine ones have already surrendered it.
    expect(meanSpeedAfter(1)).toBeGreaterThan(meanSpeedAfter(0) * 1.5);
  });

  it('reproduces a burst exactly from a fresh pool', () => {
    const a = new CrestSpray(CREST_SPRAY_DESKTOP);
    const b = new CrestSpray(CREST_SPRAY_DESKTOP);
    a.emitBurst(burst(), 1 / 60, 9, 3.5);
    b.emitBurst(burst(), 1 / 60, 9, 3.5);
    expect(trace(a)).toEqual(trace(b));
  });

  it('gives every droplet its own birth instant inside the frame', () => {
    // The curtain lesson, which better aerodynamics preserve rather than blur.
    const spray = new CrestSpray(CREST_SPRAY_DESKTOP);
    const dt = 1 / 60;
    spray.emitBurst(burst({ dropletCount: 200 }), dt, 9, 0);
    const life = spray.points.geometry.getAttribute('iLife')
      .array as Float32Array;
    const ages = new Set<number>();
    let live = 0;
    for (let i = 0; i < CREST_SPRAY_DESKTOP.capacity; i++) {
      if (life[i * 2 + 1] <= 0) continue;
      live++;
      ages.add(life[i * 2]);
      expect(life[i * 2]).toBeLessThan(dt);
    }
    expect(live).toBeGreaterThan(150);
    expect(ages.size / live).toBeGreaterThan(0.9);
  });

  it('refuses to serve a request that would recycle live water', () => {
    const spray = new CrestSpray(CREST_SPRAY_DESKTOP);
    const shed = spray.emitBurst(
      burst({ dropletCount: CREST_SPRAY_DESKTOP.capacity * 4 }),
      1 / 60,
      9,
      0,
    );
    expect(shed).toBeLessThanOrEqual(CREST_SPRAY_DESKTOP.capacity / 4);
  });
});
