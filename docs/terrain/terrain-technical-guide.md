---
title: Realistic Earth Land, Terrain, Coastline and Vegetation Pipeline
status: Research and implementation guide
last_verified: 2026-08-05
scope: Global background land for an ocean-sailing game, with authored ports and hero locations
---

# Realistic Earth Land, Terrain, Coastline and Vegetation Pipeline

## 1. Purpose

This document records the recommended datasets, architecture, processing pipeline, runtime strategy, limitations and implementation phases for adding geographically recognisable land to a globe-scale ocean game.

The intended result is not a survey-grade digital twin. The target is a visually convincing Earth seen primarily from a vessel or a cinematic camera over the ocean:

- continents, islands, mountain ranges, headlands and major bays should be geographically recognisable;
- land elevation and coastline shape should come from real Earth data;
- broad vegetation, rock, beach, wetland, snow and land-cover character should be data-informed;
- fine surface detail and individual vegetation should be synthesized procedurally;
- ports, settlements, reefs, harbour bathymetry and important story locations should be replaced or augmented with authored local patches.

The recommended model is therefore **real macro-geography plus procedural micro-detail**, with local authored overrides where scrutiny is highest.

> **Important scope boundary:** none of the recommended global products is suitable for marine navigation, exact harbour depths, legal boundaries or survey work.

## 2. Executive recommendation

### 2.1 Core production stack

Use the following as the initial production baseline:

1. **Copernicus DEM GLO-30, release 2024_1**, including its aligned Water Body Mask, as the canonical source for global elevation and the primary land/ocean boundary.
2. **ESA WorldCover 2021 v200** as the initial 10 m semantic land-cover layer.
3. **RESOLVE Ecoregions 2017** as the regional ecological palette selector, so nominally identical land-cover classes do not look the same everywhere.
4. **A sparse cube-sphere or equivalent globe quadtree** as the runtime tile hierarchy.
5. **Offline preprocessing** into immutable game-owned tiles. The game should not depend on third-party geospatial services at runtime.
6. **Authored local delta patches** for ports, settlements, important landfalls, reefs, low atolls and any location approached at close range.

### 2.2 Optional enrichment layers

Add these only after the basic terrain, coastline and LOD system is stable:

- **Copernicus CGLS-LC100 Collection 3** for fractional cover and richer coarse vegetation semantics;
- **ETH Global Canopy Height 2020** for regional canopy-height distributions and uncertainty;
- **GEBCO_2026** for broad continental shelves and deep-water seabed shape;
- **Copernicus LCFM global 10 m land cover for 2020** as an alternative or successor candidate to WorldCover, after side-by-side validation in representative regions.

### 2.3 Explicit non-recommendations

Do not use the following as the primary close-range global source:

- Natural Earth coastlines: excellent for a prototype or very distant cartographic LOD, but highly generalised;
- GSHHG: useful as a secondary global shoreline reference, but much of its source material is old and unsuitable for close mapping;
- OpenStreetMap coastline as the default canonical global database: detailed, but it introduces ODbL obligations and occasional topology/update complications;
- FABDEM under its standard licence for a potentially commercial game: technically attractive, but its default licence is non-commercial ShareAlike.

## 3. Normative terminology

This document uses the following terms:

- **MUST**: required for correctness, reproducibility or avoidance of a known failure mode.
- **SHOULD**: strongly recommended, but can be changed for a documented engineering reason.
- **MAY**: optional enhancement.
- **Canonical**: the one source whose interpretation wins when multiple datasets disagree.
- **Hero location**: a port, settlement, reef, landfall or story location that receives local authored data.
- **Delta patch**: a geographically anchored local replacement or modification layered over global data.

## 4. What quality is realistically achievable

The following distances are engineering targets, not guarantees. Results depend as much on atmospheric perspective, material synthesis, shoreline treatment and LOD stability as on raw source resolution.

| Viewing distance from land | Achievable result |
|---:|---|
| 20–300 km | Recognisable continental and island silhouettes, mountain chains, high peaks, major headlands and broad bays |
| 5–20 km | Convincing ridges, valleys, forest masses, exposed rock, broad beach or wetland zones and large drainage forms |
| 1–5 km | Plausible coastline and vegetation if procedural rocks, canopy, atmospheric haze and shoreline materials are strong |
| Below about 1 km | The 30 m elevation grid and global classification errors become apparent; exact cliffs, beaches, buildings, docks, caves, boulders and tree composition require local treatment |
| Inside ports and anchorages | Authored terrain, shoreline, structures, vegetation and bathymetry are appropriate |

For a sea-based game, distant land quality is dominated by:

1. silhouette;
2. ridge and valley structure;
3. correct vegetation massing;
4. plausible coast-to-water transition;
5. atmospheric perspective and lighting.

A high-quality implementation of those five elements can look convincing even without centimetre- or metre-scale source data.

## 5. Dataset decision matrix

| Layer | Recommended source | Nominal resolution | Primary use | Important limitations | Licence posture |
|---|---|---:|---|---|---|
| Elevation | Copernicus DEM GLO-30 2024_1 | 1 arc-second; nominally 30 m | Canonical global terrain | Digital surface model, not bare earth; forest and buildings can affect height | Free use under product-specific Copernicus terms and prescribed notices |
| Water classification | Copernicus DEM Water Body Mask | Aligned to DEM | Canonical ocean/lake/river classification and coastline derivation | Majority-resampled; small islands, reefs and intertidal detail can be lost | Same product terms as Copernicus DEM |
| Land cover | ESA WorldCover 2021 v200 | 10 m | Initial semantic material and vegetation class | Modern 2021 surface; classification errors; not species-level | CC BY 4.0 |
| Alternative land cover | Copernicus LCFM global LCM 2020 | 10 m | Candidate successor/alternative to WorldCover | Newer operational product; 2020 base year; should be validated before adoption | Copernicus/CLMS terms; preserve attribution and product metadata |
| Fractional cover and forest semantics | CGLS-LC100 Collection 3, 2019 | 100 m | Optional density, mixing and coarse forest information | Coarser than WorldCover; modern land use | Copernicus/CLMS terms |
| Ecological region | RESOLVE Ecoregions 2017 | Polygon regions | Regional visual palette and biome identity | Broad ecological context, not local land-cover boundaries | CC BY 4.0 |
| Canopy height | ETH Global Canopy Height 2020 | 10 m | Optional tree-height distribution and forest mass | Large additional dataset; model uncertainty; still modern | CC BY 4.0 |
| Bathymetry | GEBCO_2026 | 15 arc-seconds, roughly 450–500 m near the equator | Broad seabed, shelf tinting and distant underwater relief | Too coarse for reefs, ports and navigation | Open use with attribution/citation and disclaimer requirements |
| Very distant vector land | Natural Earth | 1:10m, 1:50m and 1:110m cartographic scales | Bootstrap globe or farthest cartographic LOD | “m” means million, not metres; intentionally generalised | Public domain |
| Secondary shoreline | GSHHG | Multiple cartographic resolutions | Optional cross-check or topology reference | Old source material in many areas; not close-range truth | LGPL distribution |
| Detailed collaborative coast | OpenStreetMap coastline | Variable | Optional local authoring reference | ODbL obligations; topology can temporarily break global processing | ODbL |
| Bare-earth corrected DEM | FABDEM v1.2 | 30 m | Potential technical alternative to DSM | Standard licence is non-commercial ShareAlike | CC BY-NC-SA 4.0 unless separately licensed |

## 6. Detailed dataset findings

### 6.1 Copernicus DEM GLO-30

**Recommended role:** canonical global elevation and canonical shoreline partner.

The Copernicus DEM is a digital surface model derived principally from TanDEM-X observations. It represents the upper reflective surface, so vegetation canopies and buildings may contribute to the recorded height. GLO-30 is the global nominal 30 m instance; GLO-90 is the coarser 90 m instance. The official product page currently lists release **2024_1** as the latest GLO-30/GLO-90 release.

Relevant technical properties:

- horizontal reference: WGS 84;
- vertical reference: EGM2008 orthometric height;
- GLO-30 sampling: one arc-second at lower latitudes, with latitude-dependent longitudinal spacing at higher latitudes;
- tile distribution: 1° × 1° products in GeoTIFF or DTED-oriented packaging;
- official quality layers include editing, filling, height error, water body, source and accuracy information;
- official specification includes absolute vertical accuracy below 4 m at 90% linear error and absolute horizontal accuracy below 6 m at 90% circular error, while local errors can still be materially larger.

The aligned Water Body Mask uses categorical values equivalent to:

| Value | Meaning |
|---:|---|
| 0 | Non-water |
| 1 | Ocean |
| 2 | Lake |
| 3 | River |

The decisive advantage is that elevation and water classification belong to the same product family and grid. This avoids many artefacts caused by combining an unrelated vector coastline with a raster elevation model.

**Known weaknesses:**

- It is a DSM, not a bare-earth DTM.
- Low atolls and narrow islets may be lost or distorted.
- The represented shoreline is not a tidal datum or immutable legal line.
- Large urban areas can contain surface-height bias from buildings.
- Forested terrain can be approximately one canopy height above the underlying ground.

**Official sources:**

- [Copernicus DEM collection description](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM)
- [Copernicus DEM DOI](https://doi.org/10.5270/ESA-c5d3d65)

### 6.2 ESA WorldCover 2021 v200

**Recommended role:** initial global semantic land-cover layer.

WorldCover 2021 v200 is a global 10 m classification product in EPSG:4326. It is distributed as 3° × 3° cloud-optimised GeoTIFF tiles. The complete compressed map layer is approximately 117 GB, so it should be treated as an offline build input rather than bundled or queried directly at runtime.

The principal classes are:

| Code | Class |
|---:|---|
| 10 | Tree cover |
| 20 | Shrubland |
| 30 | Grassland |
| 40 | Cropland |
| 50 | Built-up |
| 60 | Bare or sparse vegetation |
| 70 | Snow and ice |
| 80 | Permanent water bodies |
| 90 | Herbaceous wetland |
| 95 | Mangroves |
| 100 | Moss and lichen |

The reported global overall validation accuracy for the 2021 product is 76.7%. That number is useful as a warning against treating every 10 m pixel as ground truth. The nominal pixel size is finer than the DEM, but classification noise and mixed pixels remain visible when interpreted too literally.

WorldCover is released under CC BY 4.0.

A public no-credential AWS acquisition route is documented by ESA. A typical command is:

```bash
aws s3 sync s3://esa-worldcover/v200/2021/map ./sources/worldcover-2021-v200/ --no-sign-request
```

**Official sources:**

- [WorldCover data access and product information](https://esa-worldcover.org/en/data-access)
- [WorldCover 2021 DOI](https://doi.org/10.5281/zenodo.7254221)

### 6.3 Copernicus LCFM global 10 m land cover for 2020

**Recommended role:** evaluate as an alternative or future successor to WorldCover.

The Copernicus Land Cover and Forest Monitoring service now publishes a global annual land-cover product at 10 m, with 2020 as the available base year on the current product page. It is a newer operational Copernicus product than WorldCover and is strategically attractive if a continuing Copernicus time series becomes important.

It should not be combined blindly with WorldCover. Two classifiers can disagree at boundaries, and mixing them pixel-by-pixel can create more instability rather than more truth. Run the same candidate areas through both products and choose one canonical layer for each build version.

Recommended evaluation criteria:

- coastline-adjacent class stability;
- forest versus shrub classification in the intended voyage regions;
- treatment of wetlands, mangroves and bare volcanic terrain;
- rate of modern built-up and cropland artefacts after periodisation;
- ease of reproducible bulk acquisition;
- update cadence and product maturity.

**Official sources:**

- [CLMS global land cover 2020, 10 m](https://land.copernicus.eu/en/products/global-dynamic-land-cover/land-cover-2020-raster-10-m-global-annual)
- [Copernicus Data Space technical documentation](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/clms/land-cover-and-land-use-mapping/global-dynamic-land-cover/lcm_global_10m_yearly_v1.html)
- [Product DOI](https://doi.org/10.2909/602507b2-96c7-47bb-b79d-7ba25e97d0a9)

### 6.4 CGLS-LC100 Collection 3

**Recommended role:** optional semantic enrichment after the core system works.

CGLS-LC100 Collection 3 provides annual global land-cover products for 2015–2019 at 100 m. Its main value is not coastline geometry or fine material placement; it is the richer description of vegetation and continuous cover fractions. Those fractions can drive forest density, shrub mixing, grass cover and bare-ground exposure more gracefully than a single discrete class.

The reported thematic accuracy is approximately 80.3%, although this is not directly comparable to WorldCover’s figure because classes, methods and validation differ.

Use it to modulate procedural distributions rather than to override the finer canonical land-cover raster at every pixel.

**Official sources:**

- [CGLS-LC100 Collection 3 product page](https://land.copernicus.eu/en/products/global-dynamic-land-cover/copernicus-global-land-service-land-cover-100m-collection-3-epoch-2015-2019-globe)
- [Product DOI](https://doi.org/10.2909/c6377c6e-76cc-4d03-8330-628a03693042)

### 6.5 RESOLVE Ecoregions 2017

**Recommended role:** regional ecological identity.

A global land-cover class such as “tree cover” is not sufficient to select believable assets. Tropical moist forest in Tahiti, eucalyptus-dominated woodland in Australia, temperate forest in New Zealand and boreal forest in Siberia require different silhouettes, colours, densities and height distributions.

RESOLVE’s terrestrial ecoregion polygons supply broad ecological and biogeographic context. Rasterise an ecoregion identifier into the build hierarchy and map that identifier to a curated regional procedural palette.

The ecoregion layer should select:

- vegetation archetype families;
- broadleaf versus needleleaf weighting;
- evergreen versus deciduous weighting;
- canopy-height distributions;
- understorey and shrub character;
- rock, soil and dry-season colour tendencies;
- acceptable snowline or alpine treatment ranges.

It should not be interpreted as a fine boundary for individual trees.

**Official source:**

- [RESOLVE Ecoregions 2017 download site](https://ecoregions.appspot.com/)

### 6.6 ETH Global Canopy Height 2020

**Recommended role:** optional canopy-height and uncertainty input.

The ETH product estimates global canopy top height at 10 m for 2020 by combining GEDI observations with Sentinel-2 imagery. An uncertainty layer is also available. It can improve the vertical massing of procedural forests and prevent all tree-covered areas from using the same height distribution.

Use it statistically rather than literally:

- sample median and spread over a procedural vegetation cell;
- derive a regional height distribution;
- avoid placing one tree for every source pixel;
- reduce confidence or fall back to biome defaults where uncertainty is high.

This layer is not required for the first playable implementation. It adds storage and preprocessing complexity, and the visual gain is secondary to correct terrain silhouettes and stable coastlines.

**Official/project sources:**

- [Global Canopy Height 2020 project page](https://langnico.github.io/globalcanopyheight/)
- [Canopy-height dataset DOI](https://doi.org/10.3929/ethz-b-000609802)
- [Research publication](https://doi.org/10.1038/s41559-023-02206-6)

### 6.7 GEBCO_2026

**Recommended role:** broad bathymetry only.

GEBCO_2026 is a global terrain model of ocean and land at 15 arc-seconds. Near the equator this is roughly 450–500 m spacing. It is suitable for:

- continental shelves at broad scale;
- deep-ocean basin shape;
- coarse underwater terrain visible from elevated cameras;
- shallow/deep water colour transitions at regional scale;
- avoiding a perfectly spherical seabed.

It is not suitable for:

- harbour depth;
- reef passages;
- shoals and sandbars;
- nearshore collision or grounding logic;
- navigation.

Important ports and reefs need local bathymetry or authored geometry. In generic coastlines where no local data exists, a visually plausible procedural shelf is safer than presenting GEBCO as exact.

**Official sources:**

- [GEBCO_2026 grid](https://www.gebco.net/data-products/gridded-bathymetry-data/gebco2026-grid)
- [GEBCO gridded data overview](https://www.gebco.net/data-products/gridded-bathymetry-data)
- [GEBCO_2026 DOI](https://doi.org/10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa)

### 6.8 Natural Earth

**Recommended role:** prototype, map UI or farthest globe LOD.

Natural Earth is public-domain cartographic data at scales labelled 1:10m, 1:50m and 1:110m. Here “m” means million, not metres. The coastlines are intentionally generalised for small-scale maps.

It is ideal for proving the globe rendering and land/ocean masking pipeline quickly, but it should not control a shoreline that the vessel can approach.

**Official sources:**

- [Natural Earth](https://www.naturalearthdata.com/)
- [Natural Earth terms of use](https://www.naturalearthdata.com/about/terms-of-use/)

### 6.9 GSHHG

**Recommended role:** optional secondary global shoreline reference.

GSHHG provides hierarchical shoreline polygons at multiple resolutions and is integrated with the Generic Mapping Tools ecosystem. It can help with broad topology checks and global map products. Its own documentation warns that source age and accuracy make it unsuitable for very large-scale mapping in many areas.

Do not use it to force the Copernicus terrain to match a different shoreline at close range.

**Official sources:**

- [GSHHG repository](https://github.com/GenericMappingTools/gshhg-gmt)
- [GMT GSHHG documentation](https://docs.generic-mapping-tools.org/latest/datasets/gshhg.html)

### 6.10 OpenStreetMap coastline

**Recommended role:** optional reference for selected authored locations, subject to licence review.

OpenStreetMap’s coastline can be highly detailed and current, but its global processing depends on topologically valid contributor data. Broken or incomplete coastline relations can delay generated updates. More importantly, the database is distributed under the ODbL, which creates attribution and database-distribution obligations that should be assessed deliberately.

Avoid making the complete global terrain package depend on OSM merely to obtain a more detailed shoreline. It can still be valuable when authoring a port or modern reference area, provided the project’s legal and attribution strategy is explicit.

**Official sources:**

- [OSM processed coastline data](https://osmdata.openstreetmap.de/data/coastlines.html)
- [OSM coastline processing notes](https://osmdata.openstreetmap.de/processing/coastline.html)

### 6.11 FABDEM

**Recommended role:** excluded by default; reconsider only with a suitable commercial licence.

FABDEM modifies Copernicus GLO-30 to reduce forest and building height bias, making it attractive as a global bare-earth approximation. This directly addresses one of the main weaknesses of the Copernicus DSM.

However, the standard FABDEM v1.2 licence is CC BY-NC-SA 4.0. That is unsuitable for a game that may be commercial unless a separate commercial licence is obtained. The technical benefit does not justify accidentally contaminating the project’s distribution terms.

**Official source:**

- [FABDEM v1.2 dataset page](https://data.bris.ac.uk/data/dataset/s5hqmjcdj8yo2ibzi9b4ew3sn)

## 7. Canonical data policy

The build MUST have one authoritative answer for each semantic layer.

Recommended policy:

| Question | Canonical answer |
|---|---|
| Is this sample ocean, lake, river or land? | Copernicus DEM Water Body Mask, plus explicit local overrides |
| What is its base elevation? | Copernicus GLO-30, plus local terrain replacement or delta |
| What broad modern surface class is present? | One pinned 10 m product: initially WorldCover 2021 v200 |
| Which regional ecological palette applies? | RESOLVE ecoregion, with authored palette overrides |
| How dense or mixed is vegetation? | Procedural rules, optionally modulated by CGLS fractions |
| How tall is the canopy? | Procedural biome distribution, optionally modulated by ETH canopy height |
| What is the broad seabed shape? | GEBCO or a procedural shelf, never treated as navigational truth |
| What happens in a hero location? | The local delta patch wins over every global layer |

Do not average categorical datasets together. If two land-cover products disagree, choose one for the build or resolve the disagreement in a deterministic rule with explicit provenance.

## 8. Coordinate systems and vertical datum

### 8.1 Horizontal coordinates

Most source products are distributed in geographic WGS 84 coordinates. The runtime globe may use ECEF, a cube-sphere, local tangent frames, a floating origin or another globe representation. The conversion should be centralized in one tested geodesy module.

For geodetic latitude \(\varphi\), longitude \(\lambda\), ellipsoidal height \(h\), WGS 84 semi-major axis \(a\) and eccentricity squared \(e^2\):

\[
N(\varphi) = \frac{a}{\sqrt{1-e^2\sin^2\varphi}}
\]

\[
x = (N+h)\cos\varphi\cos\lambda
\]

\[
y = (N+h)\cos\varphi\sin\lambda
\]

\[
z = (N(1-e^2)+h)\sin\varphi
\]

Terrain displacement should follow the **geodetic surface normal**, not merely the radial vector from the Earth’s centre. At a known latitude and longitude, the geodetic normal direction is:

\[
\mathbf{n} = (\cos\varphi\cos\lambda,\;\cos\varphi\sin\lambda,\;\sin\varphi)
\]

### 8.2 Orthometric versus ellipsoidal height

Copernicus DEM elevations are orthometric heights \(H\) relative to EGM2008. ECEF conversion conventionally expects ellipsoidal height \(h\). The exact relation is:

\[
h = H + N_g
\]

where \(N_g\) is geoid undulation.

For this game, the recommended visual approximation is:

- define game mean sea level as zero;
- use Copernicus orthometric height as the terrain displacement above the WGS 84 reference surface;
- document that this is not a survey-grade ECEF altitude;
- introduce an EGM2008 geoid sampler only if exact vertical alignment later becomes materially necessary.

This preserves local terrain relief and the intended relationship between coastline and sea level without requiring a global geoid implementation.

## 9. Globe tiling strategy

### 9.1 Preferred hierarchy

If the existing globe already has a stable tile hierarchy, floating origin and pole/antimeridian handling, preserve that architecture. Otherwise, a **cube-sphere quadtree** is recommended because it:

- avoids singular polar tiles;
- distributes angular distortion more evenly than latitude-longitude tiles;
- gives each face a regular quadtree;
- works naturally with view-dependent refinement;
- provides stable neighbour relationships for crack fixing and streaming.

A conventional geographic quadtree remains viable, but tile dimensions become highly anisotropic near the poles and antimeridian logic is more error-prone.

### 9.2 Sampling workflow

For every output tile:

```text
for each output sample:
    cube face + tile UV
        -> unit globe direction
        -> WGS 84 geodetic latitude/longitude
        -> sample continuous and categorical source layers
        -> compute WGS 84 ellipsoid surface point
        -> displace along geodetic normal by game height
        -> transform to current local/floating-origin rendering frame
```

Source rasters do not need to be permanently reprojected into a single enormous cube map. The build can sample each output tile directly from the source datasets using GDAL/PROJ or equivalent geospatial libraries.

### 9.3 Tile sample dimensions

A grid with \(2^n + 1\) samples per edge, such as 129 × 129 or 257 × 257, simplifies shared boundaries and parent-child relationships. The correct choice depends on runtime draw-call budget, mesh generation cost and target GPU.

The tile system SHOULD support:

- shared or exactly reproducible edge samples;
- skirts or edge stitching as a secondary defence;
- parent-to-child geomorphing;
- neighbour LOD constraints;
- per-tile geometric error;
- conservative height bounds;
- horizon and frustum culling;
- floating-origin rendering.

## 10. Offline build pipeline

### 10.1 Stage A — source acquisition and provenance

The build MUST record, for every source:

- product name;
- exact release/version and epoch;
- official source URL and DOI;
- source tile identifiers;
- download timestamp;
- SHA-256 checksum;
- licence or terms snapshot;
- required attribution instructions;
- coordinate reference system;
- vertical datum;
- no-data convention;
- preprocessing tool versions;
- transformation parameters.

Do not commit hundreds of gigabytes of source rasters to Git. Commit manifests, scripts, checksums and small test fixtures. Keep source data in a versioned object store or reproducible build cache.

### 10.2 Stage B — normalisation

Normalize source behaviour without destroying source provenance:

- convert no-data values into explicit masks;
- standardize longitude wrapping;
- verify axis order;
- verify vertical units are metres;
- preserve source categorical codes;
- rasterise vector ecoregions deterministically;
- establish a build-wide rule for cells exactly on polygon boundaries;
- add a sufficient border around each processing tile for filters and distance transforms.

### 10.3 Stage C — canonical land and water mask

Start from the Copernicus Water Body Mask.

Recommended interpretation:

- `ocean`: WBM class 1;
- `lake`: WBM class 2;
- `river`: WBM class 3;
- `land`: WBM class 0;
- local override: highest priority.

Do not collapse all water into one bit during preprocessing. Even if the first renderer only needs ocean, retaining lake and river classes avoids rebuilding the global source hierarchy later.

A global ocean-connectivity pass MAY be used as a consistency check, but it should not silently erase inland water classes from the source product.

### 10.4 Stage D — connected-component and feature preservation

Before downsampling, build a catalogue of connected land components and important narrow water channels. Record at least:

- component identifier;
- area;
- bounding box;
- maximum elevation;
- distance to the nearest larger landmass;
- whether the component intersects a local override;
- minimum LOD at which it must remain represented.

This catalogue is essential for tiny islands and atolls. A naïve majority filter can make an island disappear from a parent tile even though it is an important visual or navigational landmark.

Possible preservation mechanisms:

- store fractional land coverage in coarse pixels;
- retain a minimum-height proxy mesh for important islands;
- inject a small-island occupancy bit into parent tiles;
- force refinement when a parent contains a protected component;
- maintain a separate point/island silhouette layer at the coarsest LODs.

### 10.5 Stage E — resampling rules

Different data types require different resampling:

| Data type | Recommended treatment |
|---|---|
| Elevation | Continuous interpolation when sampling source; error-aware and extrema-aware reduction for LOD generation |
| Ocean/lake/river classes | Nearest-neighbour or area-majority categorical sampling; never bilinear |
| Land-cover class | Nearest-neighbour or area-majority; preserve minority fractions where useful |
| Fractional cover | Area-weighted average |
| Ecoregion ID | Point-in-polygon or majority by area; deterministic tie break |
| Canopy height | Robust average/median with uncertainty propagation |
| Signed coast distance | Recompute in metric space for each relevant level or derive conservatively; do not interpolate category IDs into a fake distance |

For terrain LODs, simple averaging is visually destructive. It lowers sharp ridges and erases small peaks that control the distant silhouette. Use a reduction method that balances mean surface shape with maximum error and local extrema preservation.

### 10.6 Stage F — derived terrain fields

Derive and store or reconstruct:

- slope;
- aspect;
- curvature or convexity;
- local relief;
- signed distance to ocean coastline;
- distance to inland water, if needed;
- land fraction;
- elevation range;
- terrain roughness;
- coastal exposure or openness, optional;
- broad shallow-water depth, optional.

The signed coast distance should be measured in metres, not degrees. On a cube-sphere this can be computed in overlapping local projected windows, or with a surface-distance method that respects the changing metric. Clamp it to the maximum range required by shaders, for example a few kilometres, rather than storing unbounded global distances.

### 10.7 Stage G — semantic synthesis

Convert source classes into a compact game semantic model. A useful intermediate representation is not “one asset per source class,” but a set of weights:

```text
rock
soil
sand
wet_ground
short_grass
long_grass
shrub
forest_canopy
snow_or_ice
built_or_cleared
mangrove_or_wetland
```

Those weights should be modified by:

- slope and curvature;
- elevation;
- coast distance;
- ecoregion palette;
- source land-cover class;
- optional fractional-cover layers;
- optional canopy height;
- historical periodisation rules;
- local authored masks.

### 10.8 Stage H — tile packaging

A practical binary terrain tile can contain:

| Field | Suggested representation |
|---|---|
| Height | 16-bit quantised values plus per-tile minimum and scale |
| Water class | 2–3 packed bits per sample or a small categorical texture |
| Land-cover class | 8-bit class ID |
| Material weights | Packed channels at an appropriate lower resolution |
| Ecoregion | One dominant ID plus optional edge mask, or a low-resolution categorical field |
| Signed coast distance | Quantised signed field, clamped to shader range |
| Terrain derivatives | Precomputed packed normal/slope/curvature, or reconstructed at runtime |
| Canopy statistics | Optional mean, spread and confidence per vegetation cell |
| Metadata | Min/max height, geometric error, bounds, child mask, checksums and schema version |

The runtime format should be independent of the source products. That allows the project to replace WorldCover with LCFM, or upgrade the DEM, without changing rendering code.

### 10.9 Stage I — immutable publication

Publish tiles under a versioned namespace, for example:

```text
world-terrain/v1/<face>/<level>/<x>/<y>.terrain
```

A saved game or reproducible screenshot should be able to name the terrain dataset version it used. Do not overwrite an existing world build in place.

## 11. Suggested source manifest

A source manifest can be expressed in YAML or JSON. Example:

```yaml
schema_version: 1
build_id: earth-terrain-2026-08-a

sources:
  elevation:
    product: Copernicus DEM GLO-30
    release: "2024_1"
    instance: GLO-30-DGED
    horizontal_crs: EPSG:4326
    vertical_crs: EGM2008
    doi: https://doi.org/10.5270/ESA-c5d3d65
    checksums_file: manifests/copernicus-dem-2024_1.sha256

  water:
    product: Copernicus DEM Water Body Mask
    release: "2024_1"
    classes:
      0: land
      1: ocean
      2: lake
      3: river

  land_cover:
    product: ESA WorldCover
    release: 2021-v200
    doi: https://doi.org/10.5281/zenodo.7254221

  ecoregions:
    product: RESOLVE Ecoregions 2017

  bathymetry:
    product: GEBCO_2026
    enabled: false
    doi: https://doi.org/10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa

build:
  globe_tiling: cube-sphere-quadtree
  tile_samples: 257
  canonical_coastline: copernicus_water_body_mask
  height_encoding: quantized_u16
  deterministic_seed_version: 1
  vertical_policy: orthometric_height_used_as_visual_ellipsoid_displacement
```

The values above are a starting specification, not a rigid requirement. In particular, tile size and finest LOD must be chosen after measuring the existing renderer.

## 12. Coastline construction

### 12.1 One canonical shoreline

The shoreline MUST be derived from the same aligned product family as the terrain wherever possible. Using Copernicus elevation with an unrelated vector coastline commonly creates:

- water climbing a terrain slope;
- exposed vertical seams at the coast;
- islands with a polygon but no elevation;
- elevated terrain classified as ocean;
- gaps between the ocean mesh and terrain;
- unstable foam and wet-sand bands.

Use the Water Body Mask to classify land and ocean, then derive a shoreline edge or signed distance field from that classification.

### 12.2 A shoreline is not one immutable physical line

Global products represent a particular observation and processing convention. The real coast varies with:

- tide;
- waves and run-up;
- seasonal water levels;
- sediment movement;
- storms;
- reclamation and erosion;
- vegetation and mangrove boundaries;
- source acquisition date.

The global coastline should therefore be treated as a visual reference shoreline. If the game later simulates tides, important intertidal zones need local authored profiles or a purpose-built coastal dataset.

### 12.3 Coast signed-distance field

A signed-distance field is one of the most valuable derived layers. It can drive:

- ocean clipping;
- shoreline foam intensity;
- wet sand or wet rock;
- beach and mudflat transition width;
- vegetation exclusion near salt water;
- mangrove or marsh zones;
- shallow-water colour;
- nearshore normal blending;
- placement of driftwood, rocks and debris;
- LOD prioritisation near coastlines.

Do not use one globally fixed beach width. Combine distance with slope, curvature, land-cover class, ecoregion and local overrides.

### 12.4 Beaches versus cliffs

A first-pass classifier can use:

```text
low coastal slope
+ low local relief
+ suitable land-cover or substrate
+ positive land distance near coast
    -> beach, mudflat or vegetated shore candidate

high coastal slope
+ high relief or convex curvature
    -> exposed rock, cliff or steep vegetated bank candidate
```

This is visually plausible but not geologically exact. Important beaches and cliffs should be authored.

## 13. Terrain–ocean integration

### 13.1 Continue terrain below sea level

Do not terminate land geometry exactly at the shoreline and expose a vertical wall. Terrain should continue underwater through a coastal band.

Possible sources for the underwater continuation, in descending order of confidence:

1. local authored bathymetry in ports and reefs;
2. regional high-quality bathymetry acquired under a suitable licence;
3. GEBCO for broad seabed shape;
4. a procedural shelf generated from coast distance, exposure and regional defaults.

The transition must be smooth across data-source boundaries.

### 13.2 Mean sea surface

For the first implementation, use a game mean-sea-level surface at zero orthometric height. Dynamic waves can move above and below this reference, but coastline classification and terrain masks should remain tied to the mean surface.

Foam and wetness should respond to both:

- static mean-waterline distance; and
- dynamic wave contact or water-depth estimates.

### 13.3 Shallow-water rendering

Broad shallow-water colour can be based on approximate depth, but it must not imply navigational accuracy. A useful shader input is:

```text
visual_depth = ocean_surface_height - seabed_height
```

Then combine depth with water clarity, seabed material and sun angle. Reefs and lagoon passes require local data or authored masks.

## 14. LOD and streaming

### 14.1 Horizon geometry

For a spherical approximation with radius \(R\) and camera height \(h\), geometric horizon distance is:

\[
d = \sqrt{2Rh+h^2}
\]

Using Earth radius approximately 6,371 km:

- a camera 500 m above mean sea level has a sea-level horizon near **79.8 km**;
- a 3,000 m summit has its own horizon distance near **195.5 km**;
- that summit can therefore be visible from the 500 m camera at a combined separation near **275 km**, neglecting refraction and intervening terrain.

Consequently, a rigid “load terrain only to the sea horizon” rule will make high mountains appear too late.

### 14.2 Use screen-space geometric error

LOD selection SHOULD be based on projected geometric error, not fixed distance rings alone. It should consider:

- camera distance;
- camera field of view and output resolution;
- tile geometric error;
- terrain maximum elevation;
- silhouette importance;
- whether the tile contains coastline or a protected small island;
- motion speed and predicted route;
- available CPU, GPU and IO budget.

### 14.3 Suggested starting hierarchy

These values are initial design targets to test, not immutable specifications:

| Runtime role | Approximate source spacing | Typical purpose |
|---|---:|---|
| Whole-world / developer globe | 2–4 km | Continents, major islands and mountain masses |
| Far active terrain | 250–500 m | High land visible hundreds of kilometres away |
| Regional visible land | 90–120 m | Major land within roughly 150–250 km |
| Near coastal terrain | 30 m | Coast and terrain within roughly 50–100 km, refined by screen error |
| Hero location | 1–5 m or authored mesh | Ports, anchorages, settlements and close landfalls |

### 14.4 LOD transitions

The renderer SHOULD implement:

- parent-to-child height morphing;
- stable material transitions;
- common edge samples or crack stitching;
- skirts only as a backup, not as the sole correctness mechanism;
- hysteresis to prevent rapid LOD oscillation;
- prefetch based on vessel route and camera motion;
- separate terrain and vegetation LOD decisions;
- silhouette-preserving coarse meshes.

### 14.5 Preserve peaks and islands

Averaging heights into coarser levels lowers peaks and changes the skyline. Majority filtering removes small islands. The build should therefore retain:

- per-parent maximum and minimum elevations;
- geometric approximation error;
- protected peak points or extrema constraints;
- fractional land coverage;
- small-island persistence metadata;
- narrow-channel preservation metadata where gameplay requires it.

## 15. Storage reality and deployment profiles

A uniform global 30 m runtime dataset is much larger than the phrase “30 m DEM” may suggest.

Using Earth land area of roughly 149 million km² as an order-of-magnitude calculation:

| Uniform spacing over land | Approximate land samples | One 16-bit height channel before compression |
|---:|---:|---:|
| 30 m | 166 billion | 331 GB |
| 120 m | 10.3 billion | 20.7 GB |
| 480 m | 647 million | 1.3 GB |

A 30 m grid over the entire planetary surface, including oceans, would exceed 1.1 TB for height alone before tile metadata, material classes or compression. Actual geographic grids differ from this simplified equal-area calculation, but the conclusion is unchanged: do not package uniform full-resolution Earth data naïvely.

### 15.1 Recommended multi-tier deployment

Use a sparse hierarchy:

1. **Global base:** coarse terrain everywhere for silhouettes and globe views.
2. **Regional land:** medium resolution over all land, or all land reachable within the game’s intended routes.
3. **High-resolution coastal corridor:** 30 m terrain over ocean-facing land within a configurable inland distance, plus all protected islands.
4. **High peaks beyond the corridor:** retain enough detail or peak constraints for mountains visible over long distances.
5. **Hero packs:** local high-resolution patches for ports and story locations.
6. **Procedural runtime detail:** vegetation, rocks and small-scale normal variation generated from compact semantic masks rather than stored object-by-object.

A coastal corridor of roughly 80–150 km inland is a reasonable test range because it captures most terrain scrutinised from the sea while avoiding uniform 30 m coverage of entire continental interiors. This should be adjusted after profiling actual voyage routes and camera altitudes.

### 15.2 Online versus offline distribution

Two viable deployment profiles are:

**Streaming profile**

- host immutable terrain tiles in project-controlled object storage/CDN;
- prefetch along planned routes;
- maintain an on-disk cache;
- ship a coarse global fallback;
- keep external data vendors out of the runtime dependency chain.

**Fully offline profile**

- ship a coarser global hierarchy;
- include high-resolution route or region packs;
- include hero areas at authored resolution;
- permit optional downloadable geography packs later.

The decision should be made early because it controls build size, tile granularity and cache design.

## 16. Procedural surface materials

The renderer should not display the raw categorical raster as a coloured map. Use it as a semantic constraint on physically plausible materials.

A material synthesis rule can combine:

```text
base land-cover class
+ ecoregion palette
+ elevation
+ slope
+ aspect
+ curvature
+ coast distance
+ wetness/exposure proxy
+ seasonal state
+ deterministic low-frequency variation
+ local override
```

Example interpretations:

| Conditions | Likely material response |
|---|---|
| Bare class + steep slope | Exposed rock and talus |
| Grass class + gentle slope | Grass/soil blend |
| Tree class + steep mountain | Forest canopy with rock breaks and reduced density |
| Low coast distance + gentle slope | Sand, gravel, mudflat or vegetated shore according to region |
| Wetland class + low relief | Marsh, reeds, dark wet soil and shallow water |
| Mangrove class | Dense low coastal canopy, roots/impostors near water, restricted wave beach |
| Snow/ice class or high seasonal snowline | Snow and ice blend, reduced vegetation |
| Built-up/cropland in historical mode | Periodisation replacement rather than modern urban texture |

Procedural noise must not move coastlines, ridge lines or large ecological boundaries. Use it to enrich detail within the constraints supplied by real data.

## 17. Procedural vegetation

### 17.1 Semantic chain

Use the following hierarchy:

```text
WorldCover or chosen 10 m land cover
    -> broad surface/vegetation class

CGLS fractional cover, optional
    -> density and mixture

RESOLVE ecoregion
    -> regional asset palette and ecological character

ETH canopy height, optional
    -> height distribution and forest mass

Elevation, slope, aspect and coast distance
    -> local exclusions and modifiers

Historical periodisation and authored masks
    -> final authority
```

A “tree cover” pixel should not map directly to one tree. It should create a probability field from which deterministic vegetation clusters are generated.

### 17.2 Regional archetype library

A modest high-quality archetype library is preferable to thousands of nominal species. Initial families could include:

- tropical moist broadleaf forest;
- tropical dry forest and woodland;
- mangrove;
- savanna and open woodland;
- Mediterranean scrub and woodland;
- temperate broadleaf forest;
- temperate evergreen forest;
- boreal conifer forest;
- grassland and steppe;
- alpine shrub and meadow;
- wetland and reedbed;
- arid shrub and sparse vegetation.

The ecoregion palette varies asset proportions, form, hue, canopy height, density and understorey so the same archetype system does not look globally repeated.

### 17.3 Deterministic placement

Vegetation placement SHOULD be stateless and reproducible from:

```text
world build version
+ tile coordinate
+ vegetation-cell coordinate
+ palette ID
+ placement seed version
```

Use clustered blue-noise or another non-grid distribution. Preserve cluster identity across LOD transitions. Do not bake every tree as source data.

### 17.4 Distance hierarchy

| Distance | Recommended vegetation representation |
|---:|---|
| Beyond 15–20 km | Terrain albedo, normal variation and broad canopy mass only |
| About 4–20 km | Cluster impostors, canopy cards or low-complexity vegetation volumes |
| About 1–5 km | GPU-instanced trees and shrubs with aggressive LOD |
| Hero locations | Authored vegetation, landmarks and distinctive species |

Exact thresholds depend on camera lens, output resolution and art style.

### 17.5 Copernicus DSM double-counting problem

If full-height procedural trees are placed on top of a forest canopy already represented in the DEM, forests can become approximately one canopy height too tall.

Three implementation levels are possible:

1. **First pass:** accept the DSM and render distant forest mainly as canopy texture or low canopy geometry.
2. **Refined global pass:** estimate ground in forest areas by subtracting a fraction of canopy height and applying terrain-aware smoothing, while preserving genuine ridges.
3. **Hero locations:** replace the global DSM with authored bare-earth terrain.

Do not apply a naïve canopy subtraction everywhere. Canopy-height estimates have uncertainty, and subtraction can carve false pits into steep terrain.

## 18. Historical periodisation

If the game’s target period remains the late eighteenth century, modern land-cover data cannot be used literally. It contains:

- metropolitan areas;
- contemporary agriculture and plantations;
- reservoirs;
- reclaimed shoreline;
- roads and industrial clearings;
- recent deforestation or regrowth.

A global periodisation pass SHOULD:

1. suppress the built-up class except where an authored historical settlement exists;
2. replace most modern cropland with plausible potential natural vegetation inferred from ecoregion, nearby natural classes, elevation and climate proxies;
3. smooth obvious urban DSM artefacts where practical;
4. flag reservoirs and reclaimed coasts near important routes for local review;
5. author historical clearings, towns, fortifications and port works deliberately;
6. preserve broad naturally open grasslands where ecologically plausible rather than turning every cleared pixel into forest.

The output should be described as **period-plausible**, not an exact reconstruction of vegetation in a particular year. Exact historical land cover is a research and authoring task at each important location.

## 19. Local authored delta patches

Hero locations should not be separate flat scenes disconnected from the planet. They should be geodetically anchored patches blended into the global hierarchy.

A patch may replace or modify:

- elevation;
- coastline and water classification;
- nearshore bathymetry;
- beach, cliff and substrate masks;
- vegetation density and species palette;
- exclusion volumes;
- buildings, docks and landmarks;
- collision and walkable surfaces;
- navigation or grounding data;
- historical settlement state.

Recommended patch schema:

```text
patch ID
anchor latitude/longitude/height
local ENU or tangent-frame definition
horizontal extent
priority
blend width
terrain replacement or delta
water-mask replacement
bathymetry replacement
authoring masks
vegetation exclusions and additions
structure references
source provenance
historical epoch
```

Patch priority should be deterministic. A patch should blend into the global terrain over a controlled ring rather than creating a visible seam.

## 20. Difficult cases and mitigations

| Case | Why global automation struggles | Recommended mitigation |
|---|---|---|
| Low coral atolls | Elevation may be only a few metres; downsampling and DEM error can erase land | Protected component catalogue, local coastline override, authored reef/lagoon bathymetry |
| Tiny rocky islets | Majority filters remove sub-pixel features | Persistence flags, fractional land cover and proxy silhouette geometry |
| Sea cliffs and overhangs | A heightfield cannot represent caves or overhangs | Procedural cliff façade meshes or authored geometry |
| Mangrove deltas | Shoreline is diffuse and seasonal; channels are narrower than global products | Use wetland/mangrove classes for broad mass, author important channels |
| Harbour reclamation | Modern datasets contain contemporary shore engineering | Historical local replacement |
| Dense cities | DSM includes buildings and land-cover marks built-up areas | Suppress modern class, smooth broad artefacts, author historical settlement |
| Glaciers and seasonal snow | Static land-cover epoch does not reproduce seasonality | Procedural seasonal snowline; local glacier authoring where important |
| Narrow straits | Coarse LOD can close a passage | Channel-preservation metadata and forced local refinement |
| Antimeridian | Geographic tiles wrap and vector polygons can split | Normalize longitude and test cross-face/cross-meridian topology |
| Poles | Latitude-longitude grids degenerate | Cube-sphere or explicit polar handling |
| Tropical volcanic islands | Sharp peaks are damaged by averaging | Extrema-aware LOD and silhouette validation |
| Broad flat coasts | Small height error can move the apparent shore far inland | Water mask remains canonical; avoid deriving shore solely from zero-elevation contour |

## 21. Prototype regions

The first proof of concept should deliberately include terrain types that expose different failure modes.

| Region | What it tests |
|---|---|
| Tahiti | High volcanic island, dramatic skyline, tropical forest and deep coastal relief |
| A Tuamotu atoll | Extremely low islands, lagoon topology, tiny-component preservation and reef limitation |
| Fiordland, New Zealand | Steep mountainous coast, cliffs, forested relief and long-range peak visibility |
| Botany Bay or another eastern Australian coast | Low-relief beaches, broad hinterland, modern built-up removal and historical override needs |
| Kangaroo Island and the Fleurieu Peninsula | South Australian cliffs, beaches, heath/woodland and a locally familiar visual benchmark |
| A dateline or polar test area | Cross-face, antimeridian or high-latitude sampling and seam correctness |

For every region, capture a canonical render matrix at approximately:

- 1 km;
- 5 km;
- 20 km;
- 80 km;
- the maximum camera altitude;
- morning, midday and low-angle evening light;
- clear and hazy atmospheres;
- calm and rough sea states.

## 22. Phased implementation plan

### Phase 0 — legal, provenance and area-of-interest spike

**Work:**

- pin exact source releases;
- archive licence/terms snapshots;
- download small representative areas;
- compare WorldCover and LCFM in prototype regions;
- verify CRS, datum and no-data conventions;
- decide online streaming versus fully offline distribution.

**Exit criteria:**

- every selected source has a recorded licence posture and attribution plan;
- the four core terrain archetypes can be built reproducibly from a clean machine;
- one canonical land-cover product is selected for build v1.

### Phase 1 — terrain-only globe proof of concept

**Work:**

- ingest Copernicus GLO-30 and WBM;
- generate at least three terrain LODs;
- integrate with ECEF/floating-origin rendering;
- implement crack-free edges and geomorphing;
- continue terrain underwater through a coastal band;
- preserve identified small islands.

**Exit criteria:**

- no visible tile cracks;
- no exposed vertical shoreline wall;
- no gross land/ocean mismatch;
- Tahiti, Fiordland and a low coast have recognisable silhouettes;
- LOD transitions remain stable under cinematic camera motion.

### Phase 2 — shoreline and surface-material pass

**Work:**

- derive coast signed-distance fields;
- add slope, aspect and curvature;
- add WorldCover semantic classification;
- synthesize rock, soil, grass, beach, wetland and snow materials;
- implement static foam/wetness inputs.

**Exit criteria:**

- coast type varies plausibly rather than forming a uniform sand ring;
- water clipping and shoreline effects remain stable under waves;
- categorical classes do not shimmer or interpolate incorrectly across LODs.

### Phase 3 — global hierarchy, storage and streaming

**Work:**

- establish sparse global tiers;
- add route-based prefetch and disk cache if streaming;
- quantify region-pack/install sizes if offline;
- implement protected peak and island metadata;
- build deterministic versioned tile publication.

**Exit criteria:**

- global base world loads without external providers;
- high mountains appear before they cross the sea-level horizon;
- route traversal does not reveal missing or late terrain;
- cached tiles are content/version safe.

### Phase 4 — vegetation and regional identity

**Work:**

- rasterise ecoregions;
- build regional archetype palettes;
- add deterministic clustered vegetation;
- add far canopy mass and near instancing;
- optionally test CGLS fractions and ETH canopy height.

**Exit criteria:**

- tropical, temperate, Mediterranean, boreal and arid land have distinct visual identities;
- forest density and tree height vary naturally;
- vegetation does not visibly pop, crawl or change seed across LODs;
- no obvious full-height tree double-counting on DSM canopy.

### Phase 5 — local override system

**Work:**

- implement geodetically anchored delta patches;
- author one complete port and one atoll/reef case;
- support terrain, water-mask, bathymetry, vegetation and structure overrides;
- implement blending and priority rules.

**Exit criteria:**

- the vessel can approach the authored port without a seam between local and global geography;
- the authored atoll retains land and navigable visual channels correctly;
- local data cleanly wins over global tiles.

### Phase 6 — historical periodisation

**Work:**

- suppress modern built-up classes;
- replace modern agriculture with plausible regional vegetation;
- create review flags for reservoirs and reclaimed coasts;
- author historical settlement footprints for story locations.

**Exit criteria:**

- no conspicuous modern city or farmland pattern appears on intended routes unless deliberately retained;
- historical ports read as authored places rather than modern land-cover remnants.

### Phase 7 — world build and regression programme

**Work:**

- generate the complete selected deployment profile;
- validate checksums and source manifests;
- run automated seam, occupancy and parent-child tests;
- produce canonical image comparisons;
- profile CPU, GPU, memory, IO and network use;
- freeze the first immutable terrain build.

**Exit criteria:**

- build is reproducible;
- licence notices are complete;
- protected islands and channels pass regression tests;
- render and streaming budgets meet target hardware;
- saved games identify the terrain build version.

## 23. Automated validation

The build system SHOULD fail on:

- missing source tiles;
- unexpected CRS or datum;
- checksum mismatch;
- unhandled no-data values;
- parent tile marked ocean while a protected child contains land;
- neighbouring edge-sample mismatch;
- invalid min/max elevation metadata;
- non-deterministic tile output;
- a local patch with unresolved priority overlap;
- categorical resampling through a continuous filter;
- unlicensed or unrecorded source inclusion.

Useful automated tests include:

```text
edge samples are bit-identical across same-LOD neighbours
parent bounds contain all child bounds
quantized height error remains below tile tolerance
all protected islands appear at or before required LOD
all ocean-facing land has a valid coastal band
all tiles decode under current and previous supported schema
same input manifest produces identical output checksums
vegetation seeds are stable across runs
```

## 24. Visual QA criteria

A terrain build should be reviewed for more than geographic outline. Inspect:

- long-range skyline accuracy;
- peak suppression at coarse LOD;
- coast placement on flat terrain;
- repetitive procedural texture scale;
- forest canopy floating above or sinking into terrain;
- beaches appearing on impossible cliff faces;
- vegetation reaching into salt water;
- water showing through land at tile edges;
- LOD morphing during slow cinematic pans;
- island disappearance during zoom-out;
- atmospheric haze hiding or exaggerating errors;
- historical plausibility of clearings and urban areas;
- repeated vegetation archetypes across different ecoregions.

The canonical render matrix should be stored in the repository so later terrain-source or shader changes can be compared directly.

## 25. Suggested repository layout

```text
docs/
  world-terrain/
    REALISTIC_EARTH_TERRAIN_IMPLEMENTATION_GUIDE.md
    THIRD_PARTY_DATA_NOTICES.md
    DATA_DECISIONS.md

data/
  manifests/
    earth-terrain-build-v1.yaml
    checksums/
  overrides/
    ports/
    islands/
    reefs/
  fixtures/
    tahiti/
    tuamotu/
    fiordland/
    south-australia/

source-data/                 # not committed; local/object-store cache
  copernicus-dem/
  worldcover/
  ecoregions/
  optional/

tools/
  earth-build/
    acquire/
    normalize/
    tile/
    derive/
    validate/
    publish/

runtime/
  terrain/
  vegetation/
  local-patches/

generated/                   # not committed, or published as versioned assets
  world-terrain/
```

## 26. Licensing and attribution checklist

This section is an engineering checklist, not legal advice.

- [ ] Store the exact current licence or terms file for every imported release.
- [ ] Record the source URL, DOI, release and download date.
- [ ] Put required notices in a dedicated `THIRD_PARTY_DATA_NOTICES.md` or equivalent shipped notice.
- [ ] Use the exact current Copernicus DEM notice specified for modified/adapted products; do not paraphrase it from memory.
- [ ] Attribute WorldCover, RESOLVE and ETH canopy data under CC BY 4.0.
- [ ] Preserve GEBCO attribution, citation and non-navigation disclaimer.
- [ ] Review current CLMS terms for LCFM and CGLS before distribution.
- [ ] Treat Natural Earth as public domain, while still recording provenance.
- [ ] Do not introduce OSM data without an explicit ODbL distribution decision.
- [ ] Do not include FABDEM in a commercial-capable build under the standard non-commercial licence.
- [ ] Keep generated tile provenance traceable to source releases.
- [ ] Re-check terms when upgrading a source version rather than assuming the old terms remain unchanged.

## 27. Key design decisions still to make

The implementation should explicitly decide:

1. Is the complete game expected to work offline, or can high-resolution geography stream from project-controlled storage?
2. What is the maximum acceptable base install size and cache size?
3. Can the camera or player travel inland, or is detailed terrain only required from the sea?
4. What is the exact historical epoch, and how much period accuracy is expected outside story locations?
5. Are tides simulated, and do any ports require accurate intertidal zones?
6. Is bathymetry merely visual, or will grounding/navigation depend on it?
7. Are lakes and rivers visible only, or traversable?
8. Which islands and channels are gameplay-critical and therefore protected at all LODs?
9. What target hardware defines terrain, vegetation and IO budgets?
10. Will geography be delivered as one global build, route packs or optional regional downloads?

None of these decisions blocks the Phase 1 terrain prototype, but they materially affect the production tile hierarchy.

## 28. Recommended immediate implementation ticket

A practical first ticket is:

> Build a reproducible area-of-interest pipeline that ingests Copernicus GLO-30 2024_1, its Water Body Mask and WorldCover 2021 v200; emits three crack-free globe terrain LODs with quantised heights, categorical water, land-cover class, slope and signed coast distance; and renders Tahiti, one Tuamotu atoll, Fiordland and Kangaroo Island at 1 km, 5 km, 20 km and 80 km viewing distances.

Acceptance criteria:

- all source releases and checksums are pinned;
- terrain is correctly anchored to the globe;
- coastlines do not expose vertical walls;
- the selected atoll remains visible at required LODs;
- coarse peaks preserve recognisable silhouettes;
- water categories use categorical sampling;
- LOD transitions have no visible cracks;
- output is byte-for-byte deterministic from the same inputs;
- the render matrix is committed as a regression baseline.

## 29. Final recommendation

The project can achieve convincing, recognisable Earth land everywhere the ship can see without hand-modelling the planet.

The highest-value sequence is:

1. get Copernicus elevation, water classification and globe LOD correct;
2. make the terrain–ocean boundary stable;
3. add semantic materials from one pinned 10 m land-cover product;
4. regionalise vegetation with ecoregions;
5. add deterministic procedural canopy and trees;
6. use local delta patches for every place approached closely;
7. apply a historical periodisation layer rather than displaying modern land use literally.

The principal risk is not a lack of public data. It is attempting to ship too much raw resolution, mixing disagreeing sources without a canonical policy, or expecting global products to solve close ports, reefs and historical reconstruction. A sparse, versioned, data-driven hierarchy avoids those problems and aligns well with an ocean-first game.

## 30. Primary references

All source pages below were checked on **5 August 2026**.

1. [Copernicus DEM collection description](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM)
2. [Copernicus DEM DOI](https://doi.org/10.5270/ESA-c5d3d65)
3. [ESA WorldCover data access](https://esa-worldcover.org/en/data-access)
4. [WorldCover 2021 DOI](https://doi.org/10.5281/zenodo.7254221)
5. [Copernicus global land cover 2020 at 10 m](https://land.copernicus.eu/en/products/global-dynamic-land-cover/land-cover-2020-raster-10-m-global-annual)
6. [LCFM technical documentation](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/clms/land-cover-and-land-use-mapping/global-dynamic-land-cover/lcm_global_10m_yearly_v1.html)
7. [CGLS-LC100 Collection 3](https://land.copernicus.eu/en/products/global-dynamic-land-cover/copernicus-global-land-service-land-cover-100m-collection-3-epoch-2015-2019-globe)
8. [RESOLVE Ecoregions 2017](https://ecoregions.appspot.com/)
9. [ETH Global Canopy Height 2020](https://langnico.github.io/globalcanopyheight/) and [dataset DOI](https://doi.org/10.3929/ethz-b-000609802)
10. [GEBCO_2026 grid](https://www.gebco.net/data-products/gridded-bathymetry-data/gebco2026-grid)
11. [Natural Earth](https://www.naturalearthdata.com/)
12. [GSHHG](https://github.com/GenericMappingTools/gshhg-gmt)
13. [OpenStreetMap processed coastlines](https://osmdata.openstreetmap.de/data/coastlines.html)
14. [FABDEM v1.2](https://data.bris.ac.uk/data/dataset/s5hqmjcdj8yo2ibzi9b4ew3sn)
