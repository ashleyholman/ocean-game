import * as THREE from 'three';
import {
  getBathGradientMix,
  getPortalLight,
  getPortalLightMix,
  getRoomLift,
  getRoomLiftMix,
  isPortalLightMaterial,
  sampleWorldShIrradiance,
} from '../../scene/WorldPbrMaterial';
import { applyToneCurve } from '../../scene/toneMapping';
import {
  LIGHT_CHANNELS,
  interiorLightModel,
  lightRoomAt,
  lightRoomIndexOf,
  vertexLightResponse,
  type LightRoomName,
} from '../../vessel/schooner/interiorLight';
import {
  PACKED_CHANNELS,
  PORTAL_BOUNCE_ATTRIBUTE,
  PORTAL_BOUNCE_GRADIENT_ATTRIBUTE,
  PORTAL_CHANNEL4_ATTRIBUTE,
  PORTAL_DIRECT_ATTRIBUTE,
  ROOM_INDEX_ATTRIBUTE,
  SKY_VISIBILITY_ATTRIBUTE,
} from '../../vessel/schooner/interiorLightBake';

/**
 * One vertex's room lift exactly as the vertex stage resolves it:
 * mix(1, uRoomLift[index], uRoomLiftMix). The probe interpolates these
 * per-corner values barycentrically, mirroring the varying.
 */
function roomLiftOfIndex(index: number): number {
  const mix = getRoomLiftMix();
  return 1 + (getRoomLift(Math.round(index)) - 1) * mix;
}

/**
 * The analytical half of the inspection harness: what is this surface, and
 * how is the lighting model lighting it, in numbers an agent can read.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every lighting fault this project has found was found by putting an eye
 * somewhere specific and asking which term owns what it sees. The term views
 * answer that qualitatively, on screen, for a human. This file answers it
 * quantitatively, over the wire, for an agent: cast a ray (or a grid of
 * them), and for each surface hit report its identity, its baked light
 * response, the live channel light, the sun's geometry and a CPU occlusion
 * ray, and the predicted display value through the real exposure and the
 * real tone curve. "The wall reads black" becomes "the wall's total
 * irradiance is 0.010 against a deck at 6.0, and the toe crushes it".
 *
 * TWO ANSWERS PER SURFACE, ON PURPOSE
 * -----------------------------------
 * A portal-lit vertex carries its response baked into attributes; this probe
 * reports that (`baked`, barycentrically interpolated from the actual
 * geometry) AND the model's fresh answer at the hit point (`model`,
 * recomputed through `vertexLightResponse`). They should agree to within
 * vertex interpolation. When they do not, the bake is stale or a vertex
 * resolved to the wrong room — which is exactly the class of fault (§15.5
 * item 1) that motivated this instrument.
 *
 * WHAT THE SUN TERM IS AND IS NOT
 * -------------------------------
 * `sun.blocked` is a CPU ray against the ship's own geometry — the truth the
 * GPU shadow map approximates. It does not know about shadow-map bias or
 * resolution, so a surface the map lights through acne will still report
 * blocked here. Disagreement between this field and the picture is a shadow
 * fault, and that is a feature.
 */

export interface ProbeVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ProbeRgb {
  readonly rgb: readonly [number, number, number];
  readonly lum: number;
}

export interface SurfaceLightSample {
  /** NDC coordinates of the cast, [-1, 1] with +y up. */
  readonly ndc: readonly [number, number];
  readonly object: string;
  readonly material: string;
  readonly roughness: number | null;
  readonly metalness: number | null;
  readonly distanceM: number;
  readonly world: { readonly point: ProbeVec3; readonly normal: ProbeVec3 };
  readonly vessel: { readonly point: ProbeVec3; readonly normal: ProbeVec3 };
  /** The light room the surface resolves to, nudged off its face. */
  readonly room: LightRoomName | 'exterior' | 'none';
  /** Whether this material sums the portal channels at all. */
  readonly portalMaterial: boolean;
  /** Baked attributes, barycentrically interpolated at the hit. */
  readonly baked: {
    readonly skyVisibility: number;
    readonly direct: readonly number[];
    readonly bounce: readonly number[];
    readonly bounceGradient: readonly number[];
    /**
     * The room-lift factor the fragment actually renders under — corner
     * lifts resolved then interpolated, exactly as `vWorldRoomLift` is.
     * 1 whenever the mode holds the lift mix at 0.
     */
    readonly roomLift: number;
  } | null;
  /** The model's fresh answer at the hit point, for staleness comparison. */
  readonly model: {
    readonly room: LightRoomName | null;
    readonly direct: readonly number[];
    readonly bounce: readonly number[];
    readonly bounceGradient: readonly number[];
  } | null;
  /** Irradiance terms, linear RGB in world light units. */
  readonly terms: {
    readonly portalDirect: ProbeRgb | null;
    readonly portalBounce: ProbeRgb | null;
    readonly sky: ProbeRgb;
    readonly sun: {
      readonly unoccluded: ProbeRgb;
      readonly cosine: number;
      /** CPU occlusion ray against the ship. Null when the sun is down. */
      readonly blocked: boolean | null;
    };
    readonly total: ProbeRgb;
  };
  /** Linear albedo: material colour × interpolated vertex colour. */
  readonly albedo: ProbeRgb;
  /** Diffuse outgoing radiance, total × albedo / π. */
  readonly radiance: ProbeRgb;
  readonly display: {
    readonly exposure: number;
    readonly linear: ProbeRgb;
    /** Through the real CPU mirror of the shipping tone curve. */
    readonly tonemapped: ProbeRgb;
  };
}

/** One row of the grid report: enough to scan a frame, not to drill it. */
export interface GridCell {
  readonly ndc: readonly [number, number];
  readonly object: string | null;
  readonly material: string | null;
  readonly room: string | null;
  readonly distanceM: number | null;
  readonly totalIrradianceLum: number | null;
  readonly displayLum: number | null;
  readonly sunBlocked: boolean | null;
}

export interface ProbeConditions {
  readonly portalMix: number;
  readonly exposure: number;
  readonly sunIntensity: number;
  readonly sunDirWorld: ProbeVec3;
  readonly sunDirVessel: ProbeVec3;
  readonly channels: ReadonlyArray<{
    readonly irradiance: ProbeRgb;
    readonly bounce: ProbeRgb;
  }>;
}

export interface SurfaceLightProbeDependencies {
  readonly camera: () => THREE.Camera;
  /** The object graph rays are cast against — the vessel, exterior included. */
  readonly target: () => THREE.Object3D;
  /** The vessel's own group, whose frame the light model lives in. */
  readonly vesselGroup: () => THREE.Object3D;
  readonly sun: () => {
    directionWorld: THREE.Vector3;
    color: THREE.Color;
    intensity: number;
  };
  readonly exposure: () => number;
}

const lum = (r: number, g: number, b: number): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

const rgbOf = (r: number, g: number, b: number): ProbeRgb => ({
  rgb: [round6(r), round6(g), round6(b)],
  lum: round6(lum(r, g, b)),
});

const vec3Of = (v: THREE.Vector3): ProbeVec3 => ({
  x: round4(v.x),
  y: round4(v.y),
  z: round4(v.z),
});

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export class SurfaceLightProbe {
  private readonly raycaster = new THREE.Raycaster();
  private readonly shadowRaycaster = new THREE.Raycaster();

  constructor(private readonly deps: SurfaceLightProbeDependencies) {}

  /** The frame-wide facts every sample shares. */
  conditions(): ProbeConditions {
    const sun = this.deps.sun();
    const toVessel = new THREE.Quaternion();
    this.deps.vesselGroup().getWorldQuaternion(toVessel).invert();
    const sunVessel = sun.directionWorld.clone().applyQuaternion(toVessel);
    const channels = [];
    for (let p = 0; p < LIGHT_CHANNELS; p++) {
      const { irradiance, bounce } = getPortalLight(p);
      channels.push({
        irradiance: rgbOf(irradiance.x, irradiance.y, irradiance.z),
        bounce: rgbOf(bounce.x, bounce.y, bounce.z),
      });
    }
    return {
      portalMix: getPortalLightMix(),
      exposure: round6(this.deps.exposure()),
      sunIntensity: round6(sun.intensity),
      sunDirWorld: vec3Of(sun.directionWorld),
      sunDirVessel: vec3Of(sunVessel),
      channels,
    };
  }

  /** Full decomposition of the first ship surface under an NDC coordinate. */
  probeNdc(ndcX: number, ndcY: number): SurfaceLightSample | null {
    this.raycaster.setFromCamera(
      new THREE.Vector2(ndcX, ndcY),
      this.deps.camera(),
    );
    const hit = this.firstMeshHit(this.raycaster);
    if (!hit) return null;
    return this.describeHit(hit, [round4(ndcX), round4(ndcY)]);
  }

  /**
   * Full decomposition at an arbitrary vessel-local surface point — the
   * "what is lighting this wall" question without needing a camera that can
   * see the wall.
   */
  probePoint(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
  ): SurfaceLightSample {
    const vesselGroup = this.deps.vesselGroup();
    const worldPoint = new THREE.Vector3(x, y, z).applyMatrix4(
      vesselGroup.matrixWorld,
    );
    const rotation = new THREE.Quaternion();
    vesselGroup.getWorldQuaternion(rotation);
    const worldNormal = new THREE.Vector3(nx, ny, nz)
      .applyQuaternion(rotation)
      .normalize();
    return this.describePoint(
      worldPoint,
      worldNormal,
      new THREE.Vector3(x, y, z),
      new THREE.Vector3(nx, ny, nz).normalize(),
      {
        ndc: [0, 0],
        object: '(point probe)',
        material: '(point probe)',
        roughness: null,
        metalness: null,
        distanceM: 0,
        portalMaterial: true,
        baked: null,
        albedo: rgbOf(1, 1, 1),
      },
    );
  }

  /**
   * The semantic screenshot: a grid of rays over the frustum, summarised.
   * Row-major, top-left first, matching how a human reads the picture.
   */
  probeGrid(columns: number, rows: number): GridCell[] {
    const cells: GridCell[] = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) {
        const ndcX = ((i + 0.5) / columns) * 2 - 1;
        const ndcY = 1 - ((j + 0.5) / rows) * 2;
        const sample = this.probeNdc(ndcX, ndcY);
        cells.push(
          sample
            ? {
                ndc: sample.ndc,
                object: sample.object,
                material: sample.material,
                room: sample.room,
                distanceM: round4(sample.distanceM),
                totalIrradianceLum: sample.terms.total.lum,
                displayLum: sample.display.tonemapped.lum,
                sunBlocked: sample.terms.sun.blocked,
              }
            : {
                ndc: [round4(ndcX), round4(ndcY)],
                object: null,
                material: null,
                room: null,
                distanceM: null,
                totalIrradianceLum: null,
                displayLum: null,
                sunBlocked: null,
              },
        );
      }
    }
    return cells;
  }

  // --- internals ----------------------------------------------------------

  private firstMeshHit(
    raycaster: THREE.Raycaster,
  ): THREE.Intersection<THREE.Mesh> | null {
    const intersections = raycaster.intersectObject(this.deps.target(), true);
    for (const intersection of intersections) {
      const mesh = intersection.object as THREE.Mesh;
      if (!mesh.isMesh || !intersection.face) continue;
      // Skip glazing: the pixel shows what is beyond a transparent surface,
      // so a probe that stopped at the pane would report the glass's dark
      // diffuse response for a cell the screenshot shows as bright sea.
      const material = this.materialOf(mesh, intersection.face);
      if (material && material.transparent && material.opacity < 0.9) continue;
      return intersection as THREE.Intersection<THREE.Mesh>;
    }
    return null;
  }

  private describeHit(
    hit: THREE.Intersection<THREE.Mesh>,
    ndc: readonly [number, number],
  ): SurfaceLightSample {
    const mesh = hit.object;
    const face = hit.face!;
    const vesselGroup = this.deps.vesselGroup();

    // World-space facts of the hit.
    const worldPoint = hit.point.clone();
    const worldNormal = face.normal
      .clone()
      .transformDirection(mesh.matrixWorld)
      .normalize();

    // The same facts in the vessel's frame, where the light model lives.
    const toVessel = vesselGroup.matrixWorld.clone().invert();
    const vesselPoint = worldPoint.clone().applyMatrix4(toVessel);
    const vesselRotation = new THREE.Quaternion();
    vesselGroup.getWorldQuaternion(vesselRotation);
    const vesselNormal = worldNormal
      .clone()
      .applyQuaternion(vesselRotation.clone().invert())
      .normalize();

    const material = this.materialOf(mesh, face);
    const standard =
      material instanceof THREE.MeshStandardMaterial ? material : null;

    // Barycentric weights of the hit inside its triangle, for attribute reads.
    const weights = this.barycentricWeights(mesh, face, worldPoint);
    const baked = this.sampleBakedAttributes(mesh, face, weights);

    // Albedo: material colour times interpolated vertex colour.
    const albedo = new THREE.Color(1, 1, 1);
    if (standard) albedo.copy(standard.color);
    const vertexColor = this.sampleVertexColor(mesh, face, weights);
    if (vertexColor && standard?.vertexColors) albedo.multiply(vertexColor);

    return this.describePoint(worldPoint, worldNormal, vesselPoint, vesselNormal, {
      ndc,
      object: mesh.name || '(unnamed mesh)',
      material: material?.name || '(unnamed material)',
      roughness: standard ? round4(standard.roughness) : null,
      metalness: standard ? round4(standard.metalness) : null,
      distanceM: hit.distance,
      portalMaterial: material ? isPortalLightMaterial(material) : false,
      baked,
      albedo: rgbOf(albedo.r, albedo.g, albedo.b),
    });
  }

  private describePoint(
    worldPoint: THREE.Vector3,
    worldNormal: THREE.Vector3,
    vesselPoint: THREE.Vector3,
    vesselNormal: THREE.Vector3,
    identity: {
      ndc: readonly [number, number];
      object: string;
      material: string;
      roughness: number | null;
      metalness: number | null;
      distanceM: number;
      portalMaterial: boolean;
      baked: SurfaceLightSample['baked'];
      albedo: ProbeRgb;
    },
  ): SurfaceLightSample {
    const model = interiorLightModel();
    const room = lightRoomAt(
      vesselPoint.x + vesselNormal.x * 0.04,
      vesselPoint.y + vesselNormal.y * 0.04,
      vesselPoint.z + vesselNormal.z * 0.04,
    );

    // The model's fresh answer, for staleness comparison against the bake.
    const response = vertexLightResponse(
      model,
      vesselPoint.x,
      vesselPoint.y,
      vesselPoint.z,
      vesselNormal.x,
      vesselNormal.y,
      vesselNormal.z,
    );
    const modelReport = {
      room,
      direct: response.direct.map(round6),
      bounce: response.bounce.map(round6),
      bounceGradient: response.bounceGradient.map(round6),
    };

    // Which response the pixel actually uses: the baked attributes when the
    // surface has them, else the fresh model (point probes, unbaked meshes),
    // with the flat and gradient baths mixed exactly as the vertex stage
    // mixes them.
    const gradientMix = getBathGradientMix();
    const direct = identity.baked ? identity.baked.direct : response.direct;
    const flatBounce = identity.baked ? identity.baked.bounce : response.bounce;
    const gradientBounce = identity.baked
      ? identity.baked.bounceGradient
      : response.bounceGradient;
    const bounce = flatBounce.map(
      (value, p) => value + (gradientBounce[p] - value) * gradientMix,
    );
    const skyVisibility = identity.baked
      ? identity.baked.skyVisibility
      : room
        ? 0
        : 1;

    // Portal terms against the live channel uniforms, times the room lift the
    // fragment renders under — baked when the surface carries the attribute,
    // else resolved from the fresh room lookup (point probes, unbaked meshes).
    const roomLift = identity.baked
      ? identity.baked.roomLift
      : roomLiftOfIndex(lightRoomIndexOf(room));
    const portalDirect = new THREE.Vector3();
    const portalBounce = new THREE.Vector3();
    if (identity.portalMaterial) {
      for (let p = 0; p < LIGHT_CHANNELS; p++) {
        const light = getPortalLight(p);
        portalDirect.addScaledVector(light.irradiance, direct[p] * roomLift);
        portalBounce.addScaledVector(light.bounce, bounce[p] * roomLift);
      }
    }

    // The sky term the shader adds: visibility-scaled SH at the world normal.
    const sky = new THREE.Vector3();
    sampleWorldShIrradiance(worldNormal, sky);
    sky.multiplyScalar(skyVisibility);

    // The sun: geometric cosine, then the CPU occlusion truth.
    const sun = this.deps.sun();
    const cosine = Math.max(worldNormal.dot(sun.directionWorld), 0);
    const sunUp = sun.directionWorld.y > -0.035;
    const unoccluded = new THREE.Vector3(
      sun.color.r,
      sun.color.g,
      sun.color.b,
    ).multiplyScalar(sun.intensity * cosine);
    let blocked: boolean | null = null;
    if (sunUp && cosine > 0) {
      this.shadowRaycaster.set(
        worldPoint
          .clone()
          .addScaledVector(worldNormal, 0.02)
          .addScaledVector(sun.directionWorld, 0.03),
        sun.directionWorld,
      );
      this.shadowRaycaster.far = 200;
      blocked = this.firstMeshHit(this.shadowRaycaster) !== null;
    }

    const total = new THREE.Vector3()
      .add(portalDirect)
      .add(portalBounce)
      .add(sky);
    if (blocked === false) total.add(unoccluded);

    const albedoRgb = identity.albedo.rgb;
    const radiance = new THREE.Vector3(
      (total.x * albedoRgb[0]) / Math.PI,
      (total.y * albedoRgb[1]) / Math.PI,
      (total.z * albedoRgb[2]) / Math.PI,
    );
    const exposure = this.deps.exposure();
    const tonemapped = applyToneCurve(
      [radiance.x, radiance.y, radiance.z],
      exposure,
    );

    return {
      ndc: identity.ndc,
      object: identity.object,
      material: identity.material,
      roughness: identity.roughness,
      metalness: identity.metalness,
      distanceM: round4(identity.distanceM),
      world: { point: vec3Of(worldPoint), normal: vec3Of(worldNormal) },
      vessel: { point: vec3Of(vesselPoint), normal: vec3Of(vesselNormal) },
      room: room ?? (skyVisibility > 0.5 ? 'exterior' : 'none'),
      portalMaterial: identity.portalMaterial,
      baked: identity.baked,
      model: modelReport,
      terms: {
        portalDirect: identity.portalMaterial
          ? rgbOf(portalDirect.x, portalDirect.y, portalDirect.z)
          : null,
        portalBounce: identity.portalMaterial
          ? rgbOf(portalBounce.x, portalBounce.y, portalBounce.z)
          : null,
        sky: rgbOf(sky.x, sky.y, sky.z),
        sun: {
          unoccluded: rgbOf(unoccluded.x, unoccluded.y, unoccluded.z),
          cosine: round6(cosine),
          blocked,
        },
        total: rgbOf(total.x, total.y, total.z),
      },
      albedo: identity.albedo,
      radiance: rgbOf(radiance.x, radiance.y, radiance.z),
      display: {
        exposure: round6(exposure),
        linear: rgbOf(
          radiance.x * exposure,
          radiance.y * exposure,
          radiance.z * exposure,
        ),
        tonemapped: rgbOf(tonemapped[0], tonemapped[1], tonemapped[2]),
      },
    };
  }

  private materialOf(
    mesh: THREE.Mesh,
    face: THREE.Face,
  ): THREE.Material | null {
    if (Array.isArray(mesh.material)) {
      return mesh.material[face.materialIndex ?? 0] ?? mesh.material[0] ?? null;
    }
    return mesh.material ?? null;
  }

  private barycentricWeights(
    mesh: THREE.Mesh,
    face: THREE.Face,
    worldPoint: THREE.Vector3,
  ): [number, number, number] {
    const position = mesh.geometry.getAttribute('position');
    const a = new THREE.Vector3()
      .fromBufferAttribute(position, face.a)
      .applyMatrix4(mesh.matrixWorld);
    const b = new THREE.Vector3()
      .fromBufferAttribute(position, face.b)
      .applyMatrix4(mesh.matrixWorld);
    const c = new THREE.Vector3()
      .fromBufferAttribute(position, face.c)
      .applyMatrix4(mesh.matrixWorld);
    const bary = new THREE.Vector3();
    THREE.Triangle.getBarycoord(worldPoint, a, b, c, bary);
    return [bary.x, bary.y, bary.z];
  }

  private sampleBakedAttributes(
    mesh: THREE.Mesh,
    face: THREE.Face,
    weights: [number, number, number],
  ): SurfaceLightSample['baked'] {
    const geometry = mesh.geometry;
    const direct = geometry.getAttribute(PORTAL_DIRECT_ATTRIBUTE);
    const bounce = geometry.getAttribute(PORTAL_BOUNCE_ATTRIBUTE);
    const bounceGradient = geometry.getAttribute(PORTAL_BOUNCE_GRADIENT_ATTRIBUTE);
    const channel4 = geometry.getAttribute(PORTAL_CHANNEL4_ATTRIBUTE);
    const sky = geometry.getAttribute(SKY_VISIBILITY_ATTRIBUTE);
    const roomIndex = geometry.getAttribute(ROOM_INDEX_ATTRIBUTE);
    if (!direct || !bounce || !bounceGradient || !channel4 || !sky || !roomIndex) return null;

    const lerp = (
      attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
      components: number,
    ): number[] => {
      const out = new Array<number>(components).fill(0);
      const indices = [face.a, face.b, face.c];
      for (let v = 0; v < 3; v++) {
        for (let p = 0; p < components; p++) {
          out[p] += attribute.getComponent(indices[v], p) * weights[v];
        }
      }
      return out;
    };
    // The three `vec4`s carry channels 0..3; `aPortalChannel4` carries the
    // fifth channel's three terms in one vertex. Unpacked back into the
    // per-term arrays here so everything downstream — the report, the tests,
    // the staleness comparison against the fresh model — sees one flat list of
    // `LIGHT_CHANNELS` numbers and never has to know how the bake packed them.
    const packed = lerp(channel4, 3);
    const unpack = (
      attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
      term: number,
    ): number[] =>
      [...lerp(attribute, PACKED_CHANNELS), ...[packed[term]]].map(round6);
    const skyVisibility =
      sky.getX(face.a) * weights[0] +
      sky.getX(face.b) * weights[1] +
      sky.getX(face.c) * weights[2];
    const roomLift =
      roomLiftOfIndex(roomIndex.getX(face.a)) * weights[0] +
      roomLiftOfIndex(roomIndex.getX(face.b)) * weights[1] +
      roomLiftOfIndex(roomIndex.getX(face.c)) * weights[2];
    return {
      skyVisibility: round6(skyVisibility),
      direct: unpack(direct, 0),
      bounce: unpack(bounce, 1),
      bounceGradient: unpack(bounceGradient, 2),
      roomLift: round6(roomLift),
    };
  }

  private sampleVertexColor(
    mesh: THREE.Mesh,
    face: THREE.Face,
    weights: [number, number, number],
  ): THREE.Color | null {
    const color = mesh.geometry.getAttribute('color');
    if (!color) return null;
    const out = new THREE.Color(0, 0, 0);
    const indices = [face.a, face.b, face.c];
    for (let v = 0; v < 3; v++) {
      out.r += color.getComponent(indices[v], 0) * weights[v];
      out.g += color.getComponent(indices[v], 1) * weights[v];
      out.b += color.getComponent(indices[v], 2) * weights[v];
    }
    return out;
  }
}
