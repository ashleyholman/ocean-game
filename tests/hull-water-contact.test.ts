import { describe, expect, it } from 'vitest';
import type { SurfaceSample, WaveField } from '../src/scene/Waves';
import { buildSchoonerBuoyancy } from '../src/vessel/schooner/SchoonerBuoyancy';

function uniformSurface(options: {
  height?: number;
  normal?: { x: number; y: number; z: number };
  velocity?: { x: number; y: number; z: number };
} = {}): WaveField {
  const height = options.height ?? 0;
  const normal = options.normal ?? { x: 0, y: 1, z: 0 };
  const velocity = options.velocity ?? { x: 0, y: 0, z: 0 };
  return {
    advance: () => undefined,
    sampleHeight: () => height,
    sample: (_x: number, _z: number, out: SurfaceSample) => {
      out.height = height;
      out.normalX = normal.x;
      out.normalY = normal.y;
      out.normalZ = normal.z;
      out.velocityX = velocity.x;
      out.velocityY = velocity.y;
      out.velocityZ = velocity.z;
      out.jacobian = 1;
      out.compression = 0;
    },
  } as unknown as WaveField;
}

function settledContactBody(waves: WaveField) {
  const body = buildSchoonerBuoyancy();
  body.snapToSurface(waves, 0, 0, 0);
  body.update(0, waves, 0, 0, 0);
  return body;
}

describe('transient hull-water contact results', () => {
  it('allocates one stable result graph and overwrites it in place', () => {
    const waves = uniformSurface();
    const body = settledContactBody(waves);
    const contacts = body.contacts;
    const first = contacts[0];
    const firstNormal = first.surfaceNormalWorld;
    const firstRelativeVelocity = first.relativeWaterVelocityWorldMps;
    const firstPortContact = first.portWaterline;

    expect(contacts).toHaveLength(39);
    body.update(1 / 240, waves, 0, 0, 0, 1 / 240, 2, -1);

    expect(body.contacts).toBe(contacts);
    expect(body.contacts[0]).toBe(first);
    expect(body.contacts[0].surfaceNormalWorld).toBe(firstNormal);
    expect(body.contacts[0].relativeWaterVelocityWorldMps).toBe(firstRelativeVelocity);
    expect(body.contacts[0].portWaterline).toBe(firstPortContact);
  });

  it('keeps station metadata fixed and exposes genuine starboard/port cuts', () => {
    const body = settledContactBody(uniformSurface());
    const regions = new Set(body.contacts.map((contact) => contact.longitudinalRegion));
    const amidships = body.contacts.reduce((best, contact) =>
      Math.abs(contact.stationReferenceLocal.z) < Math.abs(best.stationReferenceLocal.z)
        ? contact
        : best,
    );

    expect(regions).toEqual(new Set(['stern', 'midships', 'bow']));
    expect(amidships.transverseRegion).toBe('centre');
    expect(amidships.portWaterline.active).toBe(true);
    expect(amidships.starboardWaterline.active).toBe(true);
    expect(amidships.portWaterline.side).toBe('port');
    expect(amidships.starboardWaterline.side).toBe('starboard');
    expect(amidships.portWaterline.localPoint.x).toBeGreaterThan(0);
    expect(amidships.starboardWaterline.localPoint.x).toBeLessThan(0);
    expect(amidships.portWaterline.localPoint.y).toBeCloseTo(
      body.designWaterlineY,
      10,
    );
    expect(amidships.starboardWaterline.localPoint.y).toBeCloseTo(
      body.designWaterlineY,
      10,
    );
    expect(amidships.portWaterline.worldPoint.y).toBeCloseTo(0, 10);
    expect(amidships.starboardWaterline.worldPoint.y).toBeCloseTo(0, 10);
  });

  it('transforms the fixed station frame coherently through yaw', () => {
    const waves = uniformSurface();
    const body = settledContactBody(waves);
    const index = body.contacts.length - 2;
    const atZero = body.contacts[index].stationReferenceWorld;
    const x0 = atZero.x;
    const z0 = atZero.z;

    body.update(0, waves, 0, 0, Math.PI / 2);
    const atQuarterTurn = body.contacts[index].stationReferenceWorld;

    expect(atQuarterTurn.x).toBeCloseTo(z0, 11);
    expect(atQuarterTurn.z).toBeCloseTo(-x0, 11);
    expect(body.contacts[index].longitudinalRegion).toBe('bow');
  });

  it('reports full water-relative flow and zeroes it for co-moving water', () => {
    const velocity = { x: 3, y: 1.25, z: -2 };
    const invSqrt2 = 1 / Math.sqrt(2);
    const waves = uniformSurface({
      normal: { x: invSqrt2, y: invSqrt2, z: 0 },
      velocity,
    });
    const body = buildSchoonerBuoyancy();
    body.snapToSurface(waves, 0, 0, 0);
    body.velocityY = velocity.y;
    body.update(0, waves, 0, 0, 0, 1 / 240, velocity.x, velocity.z);

    for (const contact of body.contacts) {
      expect(contact.waterVelocityWorldMps).toEqual(velocity);
      expect(contact.hullPointVelocityWorldMps.x).toBeCloseTo(velocity.x, 12);
      expect(contact.hullPointVelocityWorldMps.y).toBeCloseTo(velocity.y, 12);
      expect(contact.hullPointVelocityWorldMps.z).toBeCloseTo(velocity.z, 12);
      expect(contact.relativeWaterVelocityWorldMps.x).toBeCloseTo(0, 12);
      expect(contact.relativeWaterVelocityWorldMps.y).toBeCloseTo(0, 12);
      expect(contact.relativeWaterVelocityWorldMps.z).toBeCloseTo(0, 12);
      expect(contact.normalEntrySpeedMps).toBeCloseTo(0, 12);
    }
  });

  it('projects encounter motion onto the water normal with an explicit sign', () => {
    const invSqrt2 = 1 / Math.sqrt(2);
    const waves = uniformSurface({
      normal: { x: invSqrt2, y: invSqrt2, z: 0 },
    });
    const body = buildSchoonerBuoyancy();
    body.snapToSurface(waves, 0, 0, 0);
    body.update(0, waves, 0, 0, 0, 1 / 240, -2, 0);
    const amidships = body.contacts[Math.floor(body.contacts.length / 2)];

    expect(amidships.relativeWaterVelocityWorldMps.x).toBeCloseTo(2, 12);
    expect(amidships.relativeWaterVelocityWorldMps.y).toBeCloseTo(0, 12);
    expect(amidships.normalEntrySpeedMps).toBeCloseTo(Math.sqrt(2), 12);

    body.update(0, waves, 0, 0, 0, 1 / 240, 2, 0);
    expect(amidships.normalEntrySpeedMps).toBe(0);
  });

  it('includes pitch and roll velocity at each immersed-force point', () => {
    const waves = uniformSurface();
    const body = buildSchoonerBuoyancy();
    body.snapToSurface(waves, 0, 0, 0);
    body.velocityY = 0.3;
    body.pitchRate = 0.4;
    body.rollRate = -0.7;
    const encounterX = 1.2;
    const encounterZ = -0.8;
    body.update(0, waves, 0, 0, Math.PI / 2, 1 / 240, encounterX, encounterZ);

    const contact = body.contacts[Math.floor(body.contacts.length / 2)];
    const rx = contact.forcePointLocal.x - body.comX;
    const ry = contact.forcePointLocal.y - body.comY;
    const rz = contact.forcePointLocal.z - body.comZ;
    const rotationFrameX = -body.rollRate * ry;
    const rotationY = body.rollRate * rx - body.pitchRate * rz;
    const rotationFrameZ = body.pitchRate * ry;

    // A +90 degree yaw maps frame +z to world +x and frame +x to world -z.
    expect(contact.hullPointVelocityWorldMps.x).toBeCloseTo(
      encounterX + rotationFrameZ,
      12,
    );
    expect(contact.hullPointVelocityWorldMps.y).toBeCloseTo(
      body.velocityY + rotationY,
      12,
    );
    expect(contact.hullPointVelocityWorldMps.z).toBeCloseTo(
      encounterZ - rotationFrameX,
      12,
    );
  });

  it('enters the water continuously from a dry station', () => {
    const waves = uniformSurface();
    const body = buildSchoonerBuoyancy();
    body.snapToSurface(waves, 0, 0, 0);
    const index = Math.floor(body.stations.length / 2);
    const station = body.stations[index];
    const contact = body.contacts[index];
    const volumes: number[] = [];

    for (const depth of [0, 0.0001, 0.0002, 0.0003]) {
      body.comWorldY = body.comY - (station.section.floorY + depth);
      body.update(0, waves, 0, 0, 0);
      volumes.push(contact.immersedVolumeM3);
    }

    expect(volumes[0]).toBe(0);
    expect(volumes[1]).toBeGreaterThan(0);
    expect(volumes[2]).toBeGreaterThan(volumes[1]);
    expect(volumes[3]).toBeGreaterThan(volumes[2]);
    expect(volumes[3]).toBeLessThan(0.001);
    expect(contact.designImmersionRatio).toBeGreaterThan(0);
  });
});
