/**
 * A sampled ship-local interior volume for the ocean fragment shader.
 *
 * The table stores the hull's half-breadth over placed longitudinal position
 * and height. It deliberately contains geometry only: the ocean owns the GPU
 * texture and the vessel owns the shape that populates it.
 */
export interface InteriorCutoutVolume {
  readonly width: number;
  readonly height: number;
  readonly zMin: number;
  readonly zMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly margin: number;
  /**
   * RGBA float texels. R is a conservative half-breadth for that whole cell;
   * the other channels are unused.
   */
  readonly data: Float32Array;
}

/** CPU mirror of the shader's conservative cell lookup, used by geometry tests. */
export function sampleInteriorCutoutHalfBreadth(
  volume: InteriorCutoutVolume,
  z: number,
  y: number,
): number {
  if (z < volume.zMin || z > volume.zMax || y < volume.yMin || y > volume.yMax) {
    return 0;
  }

  const column = Math.min(
    Math.max(
      Math.floor(((z - volume.zMin) / (volume.zMax - volume.zMin)) * volume.width),
      0,
    ),
    volume.width - 1,
  );
  const row = Math.min(
    Math.max(
      Math.floor(((y - volume.yMin) / (volume.yMax - volume.yMin)) * volume.height),
      0,
    ),
    volume.height - 1,
  );
  return volume.data[(row * volume.width + column) * 4];
}
