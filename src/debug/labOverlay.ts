import * as THREE from 'three';
import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type LabOverlayCapability = SimCapability<'vessel' | 'waves'>;

/**
 * Development-only markers for the raft/water contact.
 *
 * Everything here is drawn in local render space — the same space
 * `WaveField.sample()` is evaluated in — so a marker that does not sit on the
 * rendered water is, by itself, proof of a parity failure. That is the point:
 * the probe grid is the visual half of the CPU/GPU parity test.
 *
 * LEGEND
 *   cyan loop         designed waterline, on the raft
 *   magenta cube      centre of mass
 *   sphere per station  blue = fully immersed, red = clear of the water
 *   small white dot   water surface directly under each station
 *   white line        water surface normal
 *   green line        buoyancy force
 *   orange line       damping force
 *   yellow line       station vertical velocity
 *   cyan line         local water vertical velocity
 *   green/red octahedron  critical dry point (red = wet)
 *   grey point grid   CPU-sampled water surface
 */

export type OverlayLayer = 'waterline' | 'stations' | 'forces' | 'critical' | 'probes' | 'com';

const PROBE_SPAN = 9;
const PROBE_STEPS = 25;
const FORCE_SCALE = 1 / 4000;
const VELOCITY_SCALE = 0.22;

function lineMaterial(color: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
}

export class LabOverlay {
  readonly group = new THREE.Group();

  private readonly waterlineLoop: THREE.LineLoop;
  private readonly comMarker: THREE.Mesh;
  private readonly stationMeshes: THREE.Mesh[] = [];
  private readonly surfaceMeshes: THREE.Mesh[] = [];
  private readonly criticalMeshes: THREE.Mesh[] = [];
  private readonly probePoints: THREE.Points;
  private readonly probePositions: Float32Array;

  private readonly normalLines: THREE.LineSegments;
  private readonly buoyancyLines: THREE.LineSegments;
  private readonly dampingLines: THREE.LineSegments;
  private readonly pointVelLines: THREE.LineSegments;
  private readonly waterVelLines: THREE.LineSegments;

  private readonly layers: Record<OverlayLayer, THREE.Object3D[]> = {
    waterline: [],
    stations: [],
    forces: [],
    critical: [],
    probes: [],
    com: [],
  };

  private readonly enabled: Record<OverlayLayer, boolean> = {
    waterline: true,
    stations: true,
    forces: true,
    critical: true,
    probes: false,
    com: true,
  };

  constructor(private readonly sim: LabOverlayCapability) {
    const body = sim.vessel.body;
    this.group.renderOrder = 10;

    // --- designed waterline, parented to the raft --------------------------
    const half = 1.62;
    const beam = 1.1;
    const pts: THREE.Vector3[] = [];
    const y = body.designWaterlineY;
    const ring = 28;
    for (let i = 0; i < ring; i++) {
      const t = (i / ring) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.sin(t) * beam, y, Math.cos(t) * half));
    }
    const loopGeo = new THREE.BufferGeometry().setFromPoints(pts);
    this.waterlineLoop = new THREE.LineLoop(loopGeo, lineMaterial(0x2ee6ff));
    this.waterlineLoop.renderOrder = 12;
    sim.vessel.group.add(this.waterlineLoop);
    this.layers.waterline.push(this.waterlineLoop);

    this.comMarker = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.09, 0.09),
      new THREE.MeshBasicMaterial({ color: 0xff3fd0, depthTest: false }),
    );
    this.comMarker.position.set(body.comX, body.comY, body.comZ);
    this.comMarker.renderOrder = 12;
    sim.vessel.group.add(this.comMarker);
    this.layers.com.push(this.comMarker);

    // --- per-station markers, placed in world every frame -------------------
    const stationGeo = new THREE.SphereGeometry(0.032, 10, 8);
    const surfaceGeo = new THREE.SphereGeometry(0.017, 8, 6);
    for (let i = 0; i < body.stations.length; i++) {
      const m = new THREE.Mesh(stationGeo, new THREE.MeshBasicMaterial({ color: 0x3f7fff, depthTest: false }));
      m.renderOrder = 12;
      this.group.add(m);
      this.stationMeshes.push(m);
      this.layers.stations.push(m);

      const s = new THREE.Mesh(surfaceGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
      s.renderOrder = 12;
      this.group.add(s);
      this.surfaceMeshes.push(s);
      this.layers.stations.push(s);
    }

    const criticalGeo = new THREE.OctahedronGeometry(0.036);
    for (let i = 0; i < body.critical.length; i++) {
      const m = new THREE.Mesh(criticalGeo, new THREE.MeshBasicMaterial({ color: 0x39ff88, depthTest: false }));
      m.renderOrder = 12;
      this.group.add(m);
      this.criticalMeshes.push(m);
      this.layers.critical.push(m);
    }

    // --- vector layers ------------------------------------------------------
    const n = body.stations.length;
    this.normalLines = this.makeLines(n, 0xf2f2f2, this.layers.stations);
    this.buoyancyLines = this.makeLines(n, 0x4dff5a, this.layers.forces);
    this.dampingLines = this.makeLines(n, 0xffa23a, this.layers.forces);
    this.pointVelLines = this.makeLines(n, 0xffe94d, this.layers.forces);
    this.waterVelLines = this.makeLines(n, 0x39d9ff, this.layers.forces);

    // --- CPU-sampled surface probe grid ------------------------------------
    this.probePositions = new Float32Array(PROBE_STEPS * PROBE_STEPS * 3);
    const probeGeo = new THREE.BufferGeometry();
    probeGeo.setAttribute('position', new THREE.BufferAttribute(this.probePositions, 3));
    this.probePoints = new THREE.Points(
      probeGeo,
      new THREE.PointsMaterial({ color: 0xff2d55, size: 4, sizeAttenuation: false, depthTest: true }),
    );
    this.probePoints.frustumCulled = false;
    this.probePoints.renderOrder = 11;
    this.group.add(this.probePoints);
    this.layers.probes.push(this.probePoints);

    this.applyVisibility();
  }

  private makeLines(count: number, color: number, layer: THREE.Object3D[]): THREE.LineSegments {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 6), 3));
    const lines = new THREE.LineSegments(geo, lineMaterial(color));
    lines.frustumCulled = false;
    lines.renderOrder = 12;
    this.group.add(lines);
    layer.push(lines);
    return lines;
  }

  setLayer(layer: OverlayLayer, on: boolean): void {
    this.enabled[layer] = on;
    this.applyVisibility();
  }

  layerState(): Record<OverlayLayer, boolean> {
    return { ...this.enabled };
  }

  setAll(on: boolean): void {
    for (const key of Object.keys(this.enabled) as OverlayLayer[]) this.enabled[key] = on;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    for (const key of Object.keys(this.layers) as OverlayLayer[]) {
      for (const object of this.layers[key]) object.visible = this.enabled[key];
    }
  }

  update(): void {
    const { sim } = this;
    const body = sim.vessel.body;
    // The renderer is raft-centred; the raft's nominal local position is (0, 0).
    const raftX = 0;
    const raftZ = 0;

    for (let i = 0; i < body.stations.length; i++) {
      const contact = body.contacts[i];
      const station = contact.stationReferenceWorld;
      const surface = contact.waterSurfaceWorld;
      const wetness = Math.min(contact.designImmersionRatio, 1);
      this.stationMeshes[i].position.set(station.x, station.y, station.z);
      const mat = this.stationMeshes[i].material as THREE.MeshBasicMaterial;
      // Blue when fully immersed through red when clear of the water.
      mat.color.setRGB(1 - wetness, 0.35 * wetness, wetness);
      this.surfaceMeshes[i].position.set(surface.x, surface.y, surface.z);

      this.setSegment(this.normalLines, i, surface.x, surface.y, surface.z,
        surface.x + contact.surfaceNormalWorld.x * 0.4,
        surface.y + contact.surfaceNormalWorld.y * 0.4,
        surface.z + contact.surfaceNormalWorld.z * 0.4);
      this.setSegment(this.buoyancyLines, i, station.x, station.y, station.z,
        station.x, station.y + contact.buoyancyForceN * FORCE_SCALE, station.z);
      this.setSegment(this.dampingLines, i, station.x, station.y, station.z,
        station.x, station.y + contact.dampingForceN * FORCE_SCALE, station.z);
      this.setSegment(this.pointVelLines, i, station.x, station.y, station.z,
        station.x,
        station.y + contact.hullPointVelocityWorldMps.y * VELOCITY_SCALE,
        station.z);
      this.setSegment(this.waterVelLines, i, surface.x, surface.y, surface.z,
        surface.x,
        surface.y + contact.waterVelocityWorldMps.y * VELOCITY_SCALE,
        surface.z);
    }
    this.flush(this.normalLines);
    this.flush(this.buoyancyLines);
    this.flush(this.dampingLines);
    this.flush(this.pointVelLines);
    this.flush(this.waterVelLines);

    for (let i = 0; i < body.critical.length; i++) {
      const point = body.critical[i];
      this.criticalMeshes[i].position.set(point.worldX, point.worldY, point.worldZ);
      const mat = this.criticalMeshes[i].material as THREE.MeshBasicMaterial;
      if (point.clearance < 0) mat.color.setHex(0xff2020);
      else if (point.clearance < 0.03) mat.color.setHex(0xffc020);
      else mat.color.setHex(0x39ff88);
    }

    if (this.enabled.probes) {
      let v = 0;
      const step = PROBE_SPAN / (PROBE_STEPS - 1);
      for (let i = 0; i < PROBE_STEPS; i++) {
        for (let j = 0; j < PROBE_STEPS; j++) {
          const x = raftX - PROBE_SPAN / 2 + i * step;
          const z = raftZ - PROBE_SPAN / 2 + j * step;
          this.probePositions[v++] = x;
          this.probePositions[v++] = sim.waves.sampleHeight(x, z);
          this.probePositions[v++] = z;
        }
      }
      this.probePoints.geometry.attributes.position.needsUpdate = true;
    }
  }

  private setSegment(
    lines: THREE.LineSegments,
    index: number,
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
  ): void {
    const array = (lines.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
    const o = index * 6;
    array[o] = x0; array[o + 1] = y0; array[o + 2] = z0;
    array[o + 3] = x1; array[o + 4] = y1; array[o + 5] = z1;
  }

  private flush(lines: THREE.LineSegments): void {
    lines.geometry.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
      }
    });
    this.waterlineLoop.geometry.dispose();
    this.comMarker.geometry.dispose();
    this.waterlineLoop.removeFromParent();
    this.comMarker.removeFromParent();
  }
}
