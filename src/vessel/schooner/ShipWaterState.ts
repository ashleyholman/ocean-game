import { PHYSICS_STEP, RHO_WATER } from '../BuoyantBody';
import type { ClosureName } from './closures';
import {
  SHIP_WATER_COMPARTMENT_GEOMETRY,
  SHIP_WATER_COMPARTMENT_NAMES,
  type ShipWaterCompartmentName,
  type ShipWaterPoint,
} from './shipWaterCompartments';
import {
  SHIP_WATER_OPENING_NAMES,
  SHIP_WATER_OPENINGS,
  shipWaterOpeningIsOpen,
  type ShipWaterOpeningName,
} from './shipWaterOpenings';

/** Water accounting advances on the same fixed clock as hull dynamics. */
export const SHIP_WATER_STEP_SECONDS = PHYSICS_STEP;

const compartmentIndex = new Map<ShipWaterCompartmentName, number>(
  SHIP_WATER_COMPARTMENT_NAMES.map((name, index) => [name, index]),
);
const openingIndex = new Map<ShipWaterOpeningName, number>(
  SHIP_WATER_OPENING_NAMES.map((name, index) => [name, index]),
);

export interface ShipWaterFlowRequest {
  readonly opening: ShipWaterOpeningName;
  /** Non-negative volume flux in the opening's declared direction. */
  readonly rateM3PerSecond: number;
}

export interface ShipWaterStepContext {
  /** Stable integer clock; independent of the caller's render/update rate. */
  readonly stepIndex: number;
  readonly timeSeconds: number;
  readonly stepSeconds: number;
  readonly water: ShipWaterState;
}

export type ShipWaterFlowResolver = (
  context: Readonly<ShipWaterStepContext>,
) => readonly ShipWaterFlowRequest[];

export interface ShipWaterCompartmentState {
  readonly name: ShipWaterCompartmentName;
  readonly volumeM3: number;
  readonly fillFraction: number;
  /** Zero for dry and geometrically full compartments. */
  readonly freeSurfaceAreaM2: number;
  readonly centroid: ShipWaterPoint;
}

export interface ShipWaterOpeningLedger {
  readonly requestedM3: number;
  readonly transferredM3: number;
  readonly rejectedM3: number;
}

export interface ShipWaterLedger {
  readonly requestedM3: number;
  readonly transferredM3: number;
  readonly rejectedM3: number;
  readonly externalIngressM3: number;
  readonly externalDischargeM3: number;
  /** Internal movement is counted once, not once at each endpoint. */
  readonly internalTransferM3: number;
  readonly onboardVolumeM3: number;
  readonly conservationResidualM3: number;
  readonly byOpening: Readonly<Record<ShipWaterOpeningName, ShipWaterOpeningLedger>>;
}

export interface ShipDynamicWaterLoad {
  readonly massKg: number;
  readonly centroid: ShipWaterPoint;
  readonly inertiaPitchKgM2: number;
  readonly inertiaRollKgM2: number;
  readonly inertiaYawKgM2: number;
  /** Free-surface second moment about the transverse (pitch) axis. */
  readonly freeSurfacePitchM4: number;
  /** Free-surface second moment about the longitudinal (roll) axis. */
  readonly freeSurfaceRollM4: number;
}

/**
 * Canonical dry seam. Callers may compare this by identity as well as value;
 * no `-0`, allocation, or arithmetic leaks into the dry case.
 */
export const ZERO_SHIP_DYNAMIC_WATER_LOAD: ShipDynamicWaterLoad = Object.freeze({
  massKg: 0,
  centroid: Object.freeze({ x: 0, y: 0, z: 0 }),
  inertiaPitchKgM2: 0,
  inertiaRollKgM2: 0,
  inertiaYawKgM2: 0,
  freeSurfacePitchM4: 0,
  freeSurfaceRollM4: 0,
});

export interface ShipWaterStateOptions {
  /** Uses the interaction model's canonical polarity: true means open. */
  readonly closureIsOpen?: (name: ClosureName) => boolean;
}

/**
 * Authoritative water-volume ledger, deliberately not yet a hull force.
 *
 * The graph supplies endpoints; rate resolvers supply only flux. Every caller
 * rate is reduced to the same 240 Hz integer clock before requests are applied.
 * Source shortage and destination capacity are shared proportionally among
 * simultaneous requests, so iteration order cannot manufacture or destroy
 * water.
 */
export class ShipWaterState {
  private readonly volumes = new Float64Array(SHIP_WATER_COMPARTMENT_NAMES.length);
  private readonly requestedByOpening = new Float64Array(SHIP_WATER_OPENING_NAMES.length);
  private readonly transferredByOpening = new Float64Array(SHIP_WATER_OPENING_NAMES.length);
  private readonly closureIsOpen?: (name: ClosureName) => boolean;
  private accumulatorSeconds = 0;
  private requestedM3 = 0;
  private transferredM3 = 0;
  private externalIngressM3 = 0;
  private externalDischargeM3 = 0;
  private internalTransferM3 = 0;
  private step = 0;

  constructor(options: ShipWaterStateOptions = {}) {
    this.closureIsOpen = options.closureIsOpen;
  }

  get stepIndex(): number {
    return this.step;
  }

  get timeSeconds(): number {
    return this.step * SHIP_WATER_STEP_SECONDS;
  }

  get onboardVolumeM3(): number {
    let total = 0;
    for (const volume of this.volumes) total += volume;
    return total;
  }

  /** Exact authoritative volume without allocating a derived compartment record. */
  volumeM3(name: ShipWaterCompartmentName): number {
    return this.volumes[compartmentIndex.get(name)!];
  }

  /** Return the live record derived from authoritative volume plus fixed geometry. */
  compartment(name: ShipWaterCompartmentName): ShipWaterCompartmentState {
    const geometry = SHIP_WATER_COMPARTMENT_GEOMETRY[name];
    const volumeM3 = this.volumes[compartmentIndex.get(name)!];
    if (volumeM3 === 0) {
      return {
        name,
        volumeM3: 0,
        fillFraction: 0,
        freeSurfaceAreaM2: 0,
        centroid: geometry.floorCentroid,
      };
    }
    const fillFraction = volumeM3 / geometry.maximumCapacityM3;
    return {
      name,
      volumeM3,
      fillFraction,
      freeSurfaceAreaM2:
        volumeM3 < geometry.maximumCapacityM3 ? geometry.freeSurfacePlanAreaM2 : 0,
      centroid: {
        x:
          geometry.floorCentroid.x +
          (geometry.fullCentroid.x - geometry.floorCentroid.x) * fillFraction,
        y:
          geometry.floorCentroid.y +
          (geometry.fullCentroid.y - geometry.floorCentroid.y) * fillFraction,
        z:
          geometry.floorCentroid.z +
          (geometry.fullCentroid.z - geometry.floorCentroid.z) * fillFraction,
      },
    };
  }

  /**
   * Advance any positive finite caller interval. No substeps are dropped: a
   * slow caller performs the same ordered integer steps as a fast one.
   */
  advance(elapsedSeconds: number, resolve: ShipWaterFlowResolver): void {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
      throw new RangeError('ship-water elapsed time must be finite and non-negative');
    }
    if (elapsedSeconds === 0) return;

    this.accumulatorSeconds += elapsedSeconds;
    const epsilon = SHIP_WATER_STEP_SECONDS * 1e-9;
    const count = Math.floor(
      (this.accumulatorSeconds + epsilon) / SHIP_WATER_STEP_SECONDS,
    );
    if (count === 0) return;
    this.accumulatorSeconds -= count * SHIP_WATER_STEP_SECONDS;
    if (Math.abs(this.accumulatorSeconds) <= epsilon) this.accumulatorSeconds = 0;

    for (let i = 0; i < count; i++) {
      const requests = resolve({
        stepIndex: this.step,
        timeSeconds: this.timeSeconds,
        stepSeconds: SHIP_WATER_STEP_SECONDS,
        water: this,
      });
      this.applyStep(requests);
      this.step++;
    }
  }

  /** Restore a bit-exact dry ledger and integer clock. */
  reset(): void {
    this.volumes.fill(0);
    this.requestedByOpening.fill(0);
    this.transferredByOpening.fill(0);
    this.accumulatorSeconds = 0;
    this.requestedM3 = 0;
    this.transferredM3 = 0;
    this.externalIngressM3 = 0;
    this.externalDischargeM3 = 0;
    this.internalTransferM3 = 0;
    this.step = 0;
  }

  ledger(): ShipWaterLedger {
    const onboardVolumeM3 = this.onboardVolumeM3;
    const byOpening = Object.fromEntries(
      SHIP_WATER_OPENING_NAMES.map((name, index) => {
        const requestedM3 = this.requestedByOpening[index];
        const transferredM3 = this.transferredByOpening[index];
        return [
          name,
          {
            requestedM3,
            transferredM3,
            rejectedM3: requestedM3 - transferredM3,
          },
        ];
      }),
    ) as Record<ShipWaterOpeningName, ShipWaterOpeningLedger>;
    return {
      requestedM3: this.requestedM3,
      transferredM3: this.transferredM3,
      rejectedM3: this.requestedM3 - this.transferredM3,
      externalIngressM3: this.externalIngressM3,
      externalDischargeM3: this.externalDischargeM3,
      internalTransferM3: this.internalTransferM3,
      onboardVolumeM3,
      conservationResidualM3:
        this.externalIngressM3 - this.externalDischargeM3 - onboardVolumeM3,
      byOpening,
    };
  }

  /** Publish the mass-property seam without applying it to production motion. */
  dynamicLoad(): ShipDynamicWaterLoad {
    const onboardVolumeM3 = this.onboardVolumeM3;
    if (onboardVolumeM3 === 0) return ZERO_SHIP_DYNAMIC_WATER_LOAD;

    const massKg = onboardVolumeM3 * RHO_WATER;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    const live = SHIP_WATER_COMPARTMENT_NAMES.map((name) => this.compartment(name));
    for (const record of live) {
      const mass = record.volumeM3 * RHO_WATER;
      cx += record.centroid.x * mass;
      cy += record.centroid.y * mass;
      cz += record.centroid.z * mass;
    }
    cx /= massKg;
    cy /= massKg;
    cz /= massKg;

    let inertiaPitchKgM2 = 0;
    let inertiaRollKgM2 = 0;
    let inertiaYawKgM2 = 0;
    let freeSurfacePitchM4 = 0;
    let freeSurfaceRollM4 = 0;
    for (const record of live) {
      if (record.volumeM3 === 0) continue;
      const geometry = SHIP_WATER_COMPARTMENT_GEOMETRY[record.name];
      const mass = record.volumeM3 * RHO_WATER;
      const length = geometry.effectiveSurfaceLengthM;
      const breadth = geometry.effectiveSurfaceBreadthM;
      const depth = record.volumeM3 / geometry.freeSurfacePlanAreaM2;
      const dx = record.centroid.x - cx;
      const dy = record.centroid.y - cy;
      const dz = record.centroid.z - cz;
      inertiaPitchKgM2 += mass * (depth * depth + length * length) / 12;
      inertiaPitchKgM2 += mass * (dy * dy + dz * dz);
      inertiaRollKgM2 += mass * (breadth * breadth + depth * depth) / 12;
      inertiaRollKgM2 += mass * (dx * dx + dy * dy);
      inertiaYawKgM2 += mass * (breadth * breadth + length * length) / 12;
      inertiaYawKgM2 += mass * (dx * dx + dz * dz);
      if (record.freeSurfaceAreaM2 > 0) {
        freeSurfacePitchM4 += breadth * length ** 3 / 12;
        freeSurfaceRollM4 += length * breadth ** 3 / 12;
      }
    }

    return {
      massKg,
      centroid: { x: cx, y: cy, z: cz },
      inertiaPitchKgM2,
      inertiaRollKgM2,
      inertiaYawKgM2,
      freeSurfacePitchM4,
      freeSurfaceRollM4,
    };
  }

  private applyStep(requests: readonly ShipWaterFlowRequest[]): void {
    // Production SURV1 advances this clock even through long dry intervals.
    // Preserve the exact-zero path without allocating six scratch ledgers at
    // 240 Hz when there is no opening request to account for.
    if (requests.length === 0) return;
    const requested = new Float64Array(SHIP_WATER_OPENING_NAMES.length);
    for (const request of requests) {
      if (!Number.isFinite(request.rateM3PerSecond) || request.rateM3PerSecond < 0) {
        throw new RangeError(`ship-water rate for ${request.opening} must be finite and non-negative`);
      }
      const index = openingIndex.get(request.opening);
      if (index === undefined) throw new RangeError(`unknown ship-water opening: ${request.opening}`);
      requested[index] += request.rateM3PerSecond * SHIP_WATER_STEP_SECONDS;
    }

    const available = new Float64Array(this.volumes);
    const openingAvailable = new Uint8Array(requested.length);
    const outgoing = new Float64Array(this.volumes.length);
    for (let i = 0; i < requested.length; i++) {
      const amount = requested[i];
      if (amount === 0) continue;
      this.requestedM3 += amount;
      this.requestedByOpening[i] += amount;
      const opening = SHIP_WATER_OPENINGS[SHIP_WATER_OPENING_NAMES[i]];
      if (!shipWaterOpeningIsOpen(opening, this.closureIsOpen)) continue;
      openingAvailable[i] = 1;
      if (opening.from !== 'sea') outgoing[compartmentIndex.get(opening.from)!] += amount;
    }

    const afterSource = new Float64Array(requested.length);
    for (let i = 0; i < requested.length; i++) {
      const amount = requested[i];
      if (amount === 0 || openingAvailable[i] === 0) continue;
      const opening = SHIP_WATER_OPENINGS[SHIP_WATER_OPENING_NAMES[i]];
      let accepted = amount;
      if (opening.from !== 'sea') {
        const source = compartmentIndex.get(opening.from)!;
        const totalOutgoing = outgoing[source];
        if (totalOutgoing > available[source]) accepted *= available[source] / totalOutgoing;
      }
      afterSource[i] = accepted;
    }

    const incoming = new Float64Array(this.volumes.length);
    for (let i = 0; i < afterSource.length; i++) {
      const opening = SHIP_WATER_OPENINGS[SHIP_WATER_OPENING_NAMES[i]];
      if (opening.to !== 'sea') incoming[compartmentIndex.get(opening.to)!] += afterSource[i];
    }

    const added = new Float64Array(this.volumes.length);
    const removed = new Float64Array(this.volumes.length);
    for (let i = 0; i < afterSource.length; i++) {
      let amount = afterSource[i];
      if (amount === 0) continue;
      const name = SHIP_WATER_OPENING_NAMES[i];
      const opening = SHIP_WATER_OPENINGS[name];
      if (opening.to !== 'sea') {
        const target = compartmentIndex.get(opening.to)!;
        const capacity = SHIP_WATER_COMPARTMENT_GEOMETRY[opening.to].maximumCapacityM3;
        // Do not count simultaneous outflow as room. This intentionally gives
        // a full tank one fixed-step of hysteresis instead of permitting an
        // order-dependent pass-through chain that could overfill downstream.
        const room = capacity - available[target];
        if (incoming[target] > room) amount *= Math.max(0, room) / incoming[target];
        added[target] += amount;
      }

      if (opening.from !== 'sea') removed[compartmentIndex.get(opening.from)!] += amount;

      this.transferredM3 += amount;
      this.transferredByOpening[i] += amount;
      if (opening.from === 'sea') this.externalIngressM3 += amount;
      else if (opening.to === 'sea') this.externalDischargeM3 += amount;
      else this.internalTransferM3 += amount;
    }

    for (let i = 0; i < this.volumes.length; i++) {
      if (removed[i] === 0 && added[i] === 0) continue;
      this.volumes[i] = available[i] - removed[i] + added[i];
    }
  }
}
