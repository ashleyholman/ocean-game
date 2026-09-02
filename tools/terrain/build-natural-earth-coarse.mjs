#!/usr/bin/env node

/**
 * Build Drift's tiny Natural Earth coarse-runtime input.
 *
 * Usage:
 *   node tools/terrain/build-natural-earth-coarse.mjs \
 *     path/to/ne_110m_land.shp \
 *     path/to/ne_110m_geography_regions_elevation_points.dbf \
 *     src/terrain/data/natural-earth-110m-coarse.json
 *
 * The source archives and extracted shapefiles remain outside Git. This tool
 * intentionally understands only the two simple source shapes used here:
 * polygon records for land and DBF rows for the elevation-point catalogue.
 * Any source schema change therefore fails loudly instead of being silently
 * interpreted as the old product.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [, , landPathRaw, elevationDbfPathRaw, outputPathRaw] = process.argv;
if (!landPathRaw || !elevationDbfPathRaw || !outputPathRaw) {
  throw new Error(
    'usage: build-natural-earth-coarse.mjs <land.shp> <elevation.dbf> <output.json>',
  );
}

const QUANTIZATION_PER_DEGREE = 10_000;
const landShapes = readPolygonShapefile(resolve(landPathRaw));
const elevationPoints = readElevationDbf(resolve(elevationDbfPathRaw));
const outputPath = resolve(outputPathRaw);
const output = {
  schemaVersion: 1,
  coordinateQuantizationPerDegree: QUANTIZATION_PER_DEGREE,
  landShapes,
  elevationPoints,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output)}\n`, 'utf8');

console.info(
  `[terrain] wrote ${landShapes.length} land shapes and ` +
    `${elevationPoints.length} elevation points to ${outputPath}`,
);

function readPolygonShapefile(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 100 || bytes.readInt32BE(0) !== 9994) {
    throw new Error(`${path}: not an ESRI shapefile`);
  }
  if (bytes.readInt32LE(32) !== 5) {
    throw new Error(`${path}: expected polygon shape type 5`);
  }

  const shapes = [];
  let offset = 100;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw new Error(`${path}: truncated record header at ${offset}`);
    }
    const contentBytes = bytes.readInt32BE(offset + 4) * 2;
    const contentOffset = offset + 8;
    const nextOffset = contentOffset + contentBytes;
    if (nextOffset > bytes.length) {
      throw new Error(`${path}: truncated record body at ${offset}`);
    }

    const shapeType = bytes.readInt32LE(contentOffset);
    if (shapeType === 0) {
      offset = nextOffset;
      continue;
    }
    if (shapeType !== 5) {
      throw new Error(`${path}: unexpected record shape type ${shapeType}`);
    }

    const partCount = bytes.readInt32LE(contentOffset + 36);
    const pointCount = bytes.readInt32LE(contentOffset + 40);
    const partsOffset = contentOffset + 44;
    const pointsOffset = partsOffset + partCount * 4;
    if (pointsOffset + pointCount * 16 > nextOffset) {
      throw new Error(`${path}: invalid polygon record lengths`);
    }

    const starts = Array.from({ length: partCount }, (_, index) =>
      bytes.readInt32LE(partsOffset + index * 4),
    );
    const rings = starts.map((start, partIndex) => {
      const end = starts[partIndex + 1] ?? pointCount;
      if (start < 0 || end <= start || end > pointCount) {
        throw new Error(`${path}: invalid part range ${start}..${end}`);
      }
      const coordinates = [];
      for (let pointIndex = start; pointIndex < end; pointIndex++) {
        const pointOffset = pointsOffset + pointIndex * 16;
        coordinates.push(
          quantize(bytes.readDoubleLE(pointOffset)),
          quantize(bytes.readDoubleLE(pointOffset + 8)),
        );
      }
      return coordinates;
    });
    shapes.push({ rings });
    offset = nextOffset;
  }

  if (offset !== bytes.length || shapes.length === 0) {
    throw new Error(`${path}: invalid record boundary or empty polygon set`);
  }
  return shapes;
}

function readElevationDbf(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 33) throw new Error(`${path}: truncated DBF header`);
  const recordCount = bytes.readUInt32LE(4);
  const headerBytes = bytes.readUInt16LE(8);
  const recordBytes = bytes.readUInt16LE(10);

  const fields = [];
  let descriptorOffset = 32;
  let valueOffset = 1;
  while (descriptorOffset < headerBytes && bytes[descriptorOffset] !== 0x0d) {
    const rawName = bytes.subarray(descriptorOffset, descriptorOffset + 11);
    const nul = rawName.indexOf(0);
    const name = rawName
      .subarray(0, nul < 0 ? rawName.length : nul)
      .toString('ascii');
    const length = bytes[descriptorOffset + 16];
    fields.push({ name, offset: valueOffset, length });
    valueOffset += length;
    descriptorOffset += 32;
  }
  if (valueOffset !== recordBytes) {
    throw new Error(`${path}: DBF field lengths do not match record length`);
  }

  for (const required of ['name', 'elevation', 'lat_y', 'long_x']) {
    if (!fields.some((field) => field.name === required)) {
      throw new Error(`${path}: missing required DBF field ${required}`);
    }
  }

  const rows = [];
  for (let index = 0; index < recordCount; index++) {
    const recordOffset = headerBytes + index * recordBytes;
    const record = bytes.subarray(recordOffset, recordOffset + recordBytes);
    if (record.length !== recordBytes) {
      throw new Error(`${path}: truncated DBF record ${index}`);
    }
    if (record[0] === 0x2a) continue;
    const values = Object.fromEntries(
      fields.map((field) => [
        field.name,
        record
          .subarray(field.offset, field.offset + field.length)
          .toString('latin1')
          .trim(),
      ]),
    );
    const latitudeDeg = Number(values.lat_y);
    const longitudeDeg = Number(values.long_x);
    const elevationM = Number(values.elevation);
    if (
      !Number.isFinite(latitudeDeg) ||
      !Number.isFinite(longitudeDeg) ||
      !Number.isFinite(elevationM)
    ) {
      throw new Error(`${path}: non-numeric elevation row ${index}`);
    }
    rows.push({
      name: values.name,
      latitudeQ: quantize(latitudeDeg),
      longitudeQ: quantize(longitudeDeg),
      elevationM,
    });
  }
  return rows;
}

function quantize(degrees) {
  if (!Number.isFinite(degrees)) {
    throw new Error(`cannot quantize non-finite coordinate ${degrees}`);
  }
  return Math.round(degrees * QUANTIZATION_PER_DEGREE);
}
