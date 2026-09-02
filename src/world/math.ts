export interface Vec3d {
  x: number;
  y: number;
  z: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3d {
  return { x, y, z };
}

export function setVec3(out: Vec3d, x: number, y: number, z: number): Vec3d {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copyVec3(out: Vec3d, value: Readonly<Vec3d>): Vec3d {
  out.x = value.x;
  out.y = value.y;
  out.z = value.z;
  return out;
}

export function addScaledVec3(
  out: Vec3d,
  a: Readonly<Vec3d>,
  b: Readonly<Vec3d>,
  scale: number,
): Vec3d {
  out.x = a.x + b.x * scale;
  out.y = a.y + b.y * scale;
  out.z = a.z + b.z * scale;
  return out;
}

export function scaleVec3(out: Vec3d, value: Readonly<Vec3d>, scale: number): Vec3d {
  out.x = value.x * scale;
  out.y = value.y * scale;
  out.z = value.z * scale;
  return out;
}

export function subtractVec3(out: Vec3d, a: Readonly<Vec3d>, b: Readonly<Vec3d>): Vec3d {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export function dotVec3(a: Readonly<Vec3d>, b: Readonly<Vec3d>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function crossVec3(out: Vec3d, a: Readonly<Vec3d>, b: Readonly<Vec3d>): Vec3d {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function lengthVec3(value: Readonly<Vec3d>): number {
  return Math.hypot(value.x, value.y, value.z);
}

export function normalizeVec3(out: Vec3d, value: Readonly<Vec3d>, label = 'vector'): Vec3d {
  const length = lengthVec3(value);
  if (!Number.isFinite(length) || length <= 0) {
    throw new RangeError(`${label} must have finite non-zero length`);
  }
  return scaleVec3(out, value, 1 / length);
}

export function isFiniteVec3(value: Readonly<Vec3d>): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

export function distanceVec3(a: Readonly<Vec3d>, b: Readonly<Vec3d>): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
}

export function assertNonNegativeFinite(value: number, label: string): void {
  assertFiniteNumber(value, label);
  if (value < 0) {
    throw new RangeError(`${label} must be non-negative`);
  }
}
