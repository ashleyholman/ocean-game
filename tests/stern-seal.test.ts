import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildShipGeometry } from '../src/vessel/schooner/shipGeometry';

/** Frozen vessel-local rays copied from the scene inspector's stern report. */
const MARKED_STERN_RAYS = [
  {
    number: 1,
    origin: [0.24485850961474395, 4.07, -6.657971927430226],
    direction: [0.42830457681270134, 0.23422827841986005, -0.8727498513719503],
    shouldSeal: true,
  },
  {
    number: 2,
    origin: [0.2540469461293135, 4.070000000000001, -6.669520725904973],
    direction: [-0.596751571582152, 0.20663199082912947, -0.7753649348405064],
    shouldSeal: true,
  },
  {
    number: 3,
    origin: [0.3059309348145449, 4.07, -6.6640267404303835],
    direction: [-0.07666821593942964, 0.32556697052081546, -0.9424055031516761],
    shouldSeal: true,
  },
  {
    number: 4,
    origin: [0.33771754316196945, 4.07, -6.661665314495757],
    direction: [0.5671268856570391, 0.3218635304077271, -0.7581365070740376],
    shouldSeal: true,
  },
  {
    // The warned-about stray mark passes through a real stern light.
    number: 5,
    origin: [0.3829894995244744, 4.07, -6.660872903259112],
    direction: [-0.6360875360961021, -0.045435480289193114, -0.7702780430169878],
    shouldSeal: false,
  },
  {
    number: 6,
    origin: [0.47595166292374813, 4.07, -6.648745438921415],
    direction: [-0.8010904710511982, 0.23031482025531402, -0.552457365560214],
    shouldSeal: true,
  },
  {
    number: 7,
    origin: [0.5019491602422178, 4.07, -6.651581762534998],
    direction: [-0.7099610858516592, -0.03619764945413874, -0.7033100217900556],
    shouldSeal: true,
  },
  {
    number: 8,
    origin: [0.6113558159587488, 4.07, -6.65143290698957],
    direction: [-0.4865951515190823, -0.7095426169839015, -0.509680716921641],
    shouldSeal: true,
  },
] as const;

describe('the stern lining seal', () => {
  const lining = new THREE.Mesh(
    buildShipGeometry().geometries.get('interiorLining')!,
    new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
  );

  it('stops every marked gap ray while preserving the marked stern window', () => {
    for (const marked of MARKED_STERN_RAYS) {
      const ray = new THREE.Raycaster(
        new THREE.Vector3(...marked.origin),
        new THREE.Vector3(...marked.direction).normalize(),
        0,
        10,
      );
      const hit = ray.intersectObject(lining, false)[0];
      if (marked.shouldSeal) {
        expect(hit, `ray ${marked.number} escaped the stern lining`).toBeDefined();
        expect(
          hit.distance,
          `ray ${marked.number} hit beyond the stern at ${hit.point.toArray().join(', ')}`,
        ).toBeLessThan(3);
      } else {
        expect(hit, `ray ${marked.number} no longer passes through its stern light`).toBeUndefined();
      }
    }
  });
});
