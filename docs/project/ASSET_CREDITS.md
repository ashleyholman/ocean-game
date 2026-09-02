# Asset, data, and dependency credits

## HYG bright-star catalogue

`src/astronomy/data/brightStars.generated.ts` is a transformed subset of the
[HYG Database v4.1](https://github.com/astronexus/HYG-Database), assembled by
David Nash / Astronexus.

- Source file: `hyg/CURRENT/hygdata_v41.csv`
- Source SHA-256:
  `d9f69fd86bbf90a4e4d52b4c5c53eacfa6dfc0bfdef85bfd94f095e0bebe4ebd`
- Filter: finite-distance records with visual magnitude ≤ 6.5
- Output: 8920 records
- Retained data: J2000 right ascension, J2000 declination, visual magnitude,
  B−V colour index, and display label (proper name or Bayer designation where
  the source has one)
- Licence: [Creative Commons Attribution-ShareAlike 4.0
  International](https://creativecommons.org/licenses/by-sa/4.0/)

The generated subset remains CC BY-SA 4.0. The full source database is not
bundled. `scripts/generate_bright_stars.py` verifies the source checksum before
regenerating the data. The adjacent
`src/astronomy/data/HYG-LICENSE.md` records the same notice with the data.

## Diffuse Milky Way map

`src/astronomy/data/milkyWay.generated.ts` is a downsampled, re-encoded
derivative of the diffuse galaxy layer of
[Deep Star Maps 2020](https://svs.gsfc.nasa.gov/4851) by the NASA/Goddard Space
Flight Center Scientific Visualization Studio.

- Credit: NASA/Goddard Space Flight Center Scientific Visualization Studio
  (Ernie Wright, Laurence Schuler, Ian Jones); built from Gaia DR2
- Source file: `Milkyway 2020 64k gal` (galactic coordinates, plate carrée),
  taken from the 3840 × 1920 render served by Wikimedia Commons rather than
  the 32768 × 16384 master
- Transform: area-average to 480 × 240 in linear light, split into a luminance
  plane stored as linear^(1/4) and a quarter-resolution flux-weighted
  chromaticity plane, base64 in a generated TypeScript module
- Licence: [Creative Commons Attribution
  4.0](https://creativecommons.org/licenses/by/4.0/)

The diffuse layer is used deliberately in preference to the combined star map:
the resolved stars are already drawn as points from the HYG catalogue above, so
compositing the diffuse layer adds the unresolved galaxy without counting them
twice. Regenerate with `scripts/generate_milky_way.py`.

## Runtime-generated presentation assets

No external textures, models, sounds, fonts, or environment maps are shipped.
The Milky Way map above is the one piece of external imagery in the project and
it is not shipped as an image either: it is baked into generated TypeScript and
decoded into a `DataTexture` at start-up, so the build still has no binary
asset pipeline and nothing loads asynchronously.

| Element | How it is produced |
|---|---|
| Ocean surface | Radial mesh built in `src/scene/Ocean.ts`, displaced by a Gerstner sum |
| Water detail normals | Analytic-derivative gradient noise; no normal map |
| Atmosphere, Sun, Moon | Analytic atmosphere plus Astronomy Engine directions |
| Stars | HYG catalogue points rendered by `src/scene/StarField.ts` |
| Milky Way | Baked SVS diffuse map, composited by `src/scene/MilkyWay.ts` |
| Clouds | Procedural value-noise fBm in `src/scene/shaders/lib.ts` |
| Raft, mast, rope, sail, figure | Procedural Three.js geometry |
| Sail detail | Procedural value noise in the sail shader |
| Ambience | Synthesised Web Audio noise and filters |
| Typeface | Viewer system UI/monospace font stacks |

## Software dependencies

| Package | Purpose | Licence |
|---|---|---|
| [three](https://github.com/mrdoob/three.js) | Local renderer | MIT |
| [geographiclib-geodesic 2.2.0](https://geographiclib.sourceforge.io/html/js/) | Karney WGS84 direct geodesics | MIT/X11 |
| [Astronomy Engine 2.1.19](https://github.com/cosinekitty/astronomy) | Ephemerides, precession/nutation, sidereal time, solar-hour search | MIT |
| [vite](https://github.com/vitejs/vite) | Build/dev server | MIT |
| [vitest](https://github.com/vitest-dev/vitest) | Numerical tests | MIT |
| [typescript](https://github.com/microsoft/TypeScript) | Type checking | Apache-2.0 |
| [@types/three](https://github.com/DefinitelyTyped/DefinitelyTyped) | Three.js declarations | MIT |

The geodesy and astronomy packages are isolated behind project-owned
radians/metres interfaces; their types do not define canonical state.

## Technique references

No code was copied from these references.

- EPSG method 9602 for geodetic/ECEF conversion.
- Charles F. F. Karney, “Algorithms for geodesics,” *Journal of Geodesy* 87
  (2013), for the algorithm implemented by GeographicLib.
- *GPU Gems* 1, chapter 1, for Gerstner wave displacement/normal techniques.
- Cox–Munk sea-surface slope statistics for specular roughness.
- Kasten–Young relative optical air mass, approximated in the sky model.
