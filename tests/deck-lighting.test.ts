import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  lowerHemisphereDiffuseWeight,
  updateDeckLocalBounceIrradiance,
} from '../src/vessel/schooner/deckLighting';

describe('weather-deck local diffuse bounce', () => {
  it('integrates a lower hemisphere as zero upward, half sideways and full underneath', () => {
    expect(lowerHemisphereDiffuseWeight(1)).toBe(0);
    expect(lowerHemisphereDiffuseWeight(0)).toBe(0.5);
    expect(lowerHemisphereDiffuseWeight(-1)).toBe(1);
    expect(lowerHemisphereDiffuseWeight(4)).toBe(0);
    expect(lowerHemisphereDiffuseWeight(-4)).toBe(1);
  });

  it('returns reflected sky irradiance in linear RGB without allocating an output', () => {
    const out = new THREE.Vector3();
    const reflectance = new THREE.Color().setRGB(
      0.2,
      0.3,
      0.4,
      THREE.LinearSRGBColorSpace,
    );
    const returned = updateDeckLocalBounceIrradiance(
      out,
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(1, 2, 3),
      new THREE.Vector3(1, 0, 0),
      new THREE.Color(1, 1, 1),
      0,
      reflectance,
      0.5,
    );

    expect(returned).toBe(out);
    expect(out.x).toBeCloseTo(Math.PI * 1 * 0.2 * 0.5, 12);
    expect(out.y).toBeCloseTo(Math.PI * 2 * 0.3 * 0.5, 12);
    expect(out.z).toBeCloseTo(Math.PI * 3 * 0.4 * 0.5, 12);
  });

  it('projects the live direct beam onto the moving deck axis and rejects a Sun below it', () => {
    const out = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const sun = new THREE.Vector3(0.8, 0.6, 0);
    const sunColor = new THREE.Color().setRGB(
      0.5,
      0.75,
      1,
      THREE.LinearSRGBColorSpace,
    );
    const reflectance = new THREE.Color().setRGB(
      0.2,
      0.4,
      0.6,
      THREE.LinearSRGBColorSpace,
    );

    updateDeckLocalBounceIrradiance(
      out,
      up,
      new THREE.Vector3(),
      sun,
      sunColor,
      4,
      reflectance,
      0.25,
    );
    const direct = 4 * 0.6;
    expect(out.x).toBeCloseTo(0.2 * 0.5 * direct * 0.25, 12);
    expect(out.y).toBeCloseTo(0.4 * 0.75 * direct * 0.25, 12);
    expect(out.z).toBeCloseTo(0.6 * 1 * direct * 0.25, 12);

    updateDeckLocalBounceIrradiance(
      out,
      up,
      new THREE.Vector3(),
      new THREE.Vector3(0, -1, 0),
      sunColor,
      4,
      reflectance,
      0.25,
    );
    expect(out.toArray()).toEqual([0, 0, 0]);
  });
});
