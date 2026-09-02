/**
 * Shared GLSL building blocks.
 *
 * The sky model here is evaluated by BOTH the sky dome and the water surface,
 * so reflections are guaranteed to agree with the sky they reflect. A CPU port
 * of the same model lives in `TimeOfDay.ts` and drives the scene lights.
 */

export const GLSL_COMMON = /* glsl */ `
#ifndef PI
#define PI 3.141592653589793
#endif

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return -1.0 + 2.0 * fract((p3.xx + p3.yz) * p3.zy);
}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

// Value noise, used for clouds.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/**
 * Value noise in 3D — eight corners of a cell, smoothstepped.
 *
 * A cloud needs a field that genuinely varies with ALTITUDE. A 2D field
 * translated as it rises is still one shape: a view march through it draws the
 * same silhouette several times over, offset a little each time, which reads
 * as a stack of flat cut-outs rather than as something with an inside. That is
 * a real artefact this codebase shipped for exactly one session.
 */
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = hash31(i + vec3(0.0, 0.0, 0.0));
  float b = hash31(i + vec3(1.0, 0.0, 0.0));
  float c = hash31(i + vec3(0.0, 1.0, 0.0));
  float d = hash31(i + vec3(1.0, 1.0, 0.0));
  float e = hash31(i + vec3(0.0, 0.0, 1.0));
  float g = hash31(i + vec3(1.0, 0.0, 1.0));
  float h = hash31(i + vec3(0.0, 1.0, 1.0));
  float k = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(a, b, u.x), mix(c, d, u.x), u.y),
    mix(mix(e, g, u.x), mix(h, k, u.x), u.y),
    u.z
  );
}

// Gradient noise with analytic derivatives -> returns (value, d/dx, d/dy).
// Used for water detail normals so we never need a normal map texture.
vec3 noised(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

  vec2 ga = hash22(i + vec2(0.0, 0.0));
  vec2 gb = hash22(i + vec2(1.0, 0.0));
  vec2 gc = hash22(i + vec2(0.0, 1.0));
  vec2 gd = hash22(i + vec2(1.0, 1.0));

  float va = dot(ga, f - vec2(0.0, 0.0));
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));

  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd);
  vec2 d = ga
    + u.x * (gb - ga)
    + u.y * (gc - ga)
    + u.x * u.y * (ga - gb - gc + gd)
    + du * (vec2(u.y, u.x) * (va - vb - vc + vd) + vec2(vb, vc) - va);

  return vec3(v, d);
}

float ggxSpecular(vec3 N, vec3 V, vec3 L, float rough) {
  vec3 H = normalize(V + L);
  float a = max(rough * rough, 1e-4);
  float a2 = a * a;
  float NdH = max(dot(N, H), 0.0);
  float den = NdH * NdH * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * den * den);
  float NdV = max(dot(N, V), 1e-3);
  float NdL = max(dot(N, L), 0.0);
  float k = a * 0.5;
  float G = (NdV / (NdV * (1.0 - k) + k)) * (NdL / (NdL * (1.0 - k) + k));
  return D * G / (4.0 * NdV);
}
`;

/**
 * Logarithmic-depth support for custom ShaderMaterials (TERR-112).
 *
 * Three defines USE_LOGARITHMIC_DEPTH_BUFFER on every program when the
 * renderer was built with `logarithmicDepthBuffer: true`, but only materials
 * whose GLSL includes the logdepthbuf chunks act on it. A custom material
 * that skips them keeps writing (or testing) conventional depth into a
 * buffer everyone else encodes logarithmically, so terrain silently stops
 * occluding the sea. These wrappers exist because the vertex chunk calls
 * `isPerspectiveMatrix()` from three's <common>, which ShaderMaterial does
 * not include — the one-line helper is cheaper than importing all of
 * <common> next to GLSL_COMMON above. Under every other depth mode the
 * define is absent and all four snippets compile to nothing.
 *
 * Placement contract: PARS at global scope; the vertex snippet immediately
 * after the final gl_Position assignment; the fragment snippet at the TOP of
 * main() so no early return can leave gl_FragDepth unwritten.
 */
export const GLSL_LOG_DEPTH_PARS_VERTEX = /* glsl */ `
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
bool isPerspectiveMatrix( mat4 m ) { return m[ 2 ][ 3 ] == - 1.0; }
#endif
#include <logdepthbuf_pars_vertex>
`;

export const GLSL_LOG_DEPTH_VERTEX = /* glsl */ `
#include <logdepthbuf_vertex>
`;

export const GLSL_LOG_DEPTH_PARS_FRAGMENT = /* glsl */ `
#include <logdepthbuf_pars_fragment>
`;

export const GLSL_LOG_DEPTH_FRAGMENT = /* glsl */ `
#include <logdepthbuf_fragment>
`;

/**
 * Direction mapping shared by the cloud bake, the displayed sky, and any
 * background light that must be occluded by the displayed cloud generation.
 *
 * The uniforms are deliberately declared by the consumer: GLSL_SKY already
 * owns them, while the star vertex shader needs only the two drift values.
 * Keeping the projection and advection here prevents a background pass from
 * sampling a cloud-shaped-but-differently-moving mask.
 */
/**
 * Equirectangular lookup into the sky radiance LUT.
 *
 * ONE definition, because there are two consumers on opposite sides of the
 * waterline. The sea mixes toward this texture and so does terrain haze
 * (TERR-133), in the same frame, from the same texel grid — and a divergence
 * of even a texel row puts a different sky on either side of the shore, which
 * reads as a moving seam rather than as a mis-set constant. It lived inline in
 * `Ocean.ts` with the terrain material carrying a hand-copied twin and a
 * comment asking the next reader to keep them equal.
 *
 * Azimuth wraps because the LUT's `wrapS` is `RepeatWrapping`; elevation is
 * clamped by `ClampToEdgeWrapping` at the poles. Terrain narrows the elevation
 * range on top of this rather than remapping it — see `terrainSkyLutUv`.
 */
export const GLSL_SKY_RADIANCE_LUT_UV = /* glsl */ `
vec2 skyRadianceLutUv(vec3 direction) {
  vec3 dir = normalize(direction);
  float azimuth = atan(dir.x, -dir.z);
  float elevation = asin(clamp(dir.y, -1.0, 1.0));
  return vec2(
    azimuth / 6.28318530718 + 0.5,
    elevation / 3.14159265359 + 0.5
  );
}
`;

export const GLSL_CLOUD_DOME_MAPPING = /* glsl */ `
const float CLOUD_DOME_ELEV_MIN = -0.06;
const float CLOUD_DOME_WARP = 0.6;
const float CLOUD_DOME_HALF_PI = 1.57079632679;

vec2 cloudDomeUv(vec3 dir) {
  float az = atan(dir.z, dir.x);
  float u = az * (0.5 / PI) + 0.5;
  float elev = asin(clamp(dir.y, -1.0, 1.0));
  float t = (elev - CLOUD_DOME_ELEV_MIN) / (CLOUD_DOME_HALF_PI - CLOUD_DOME_ELEV_MIN);
  return vec2(u, pow(clamp(t, 0.0, 1.0), CLOUD_DOME_WARP));
}

vec3 cloudDomeDir(vec2 uv) {
  float az = (uv.x - 0.5) * (2.0 * PI);
  float t = pow(clamp(uv.y, 0.0, 1.0), 1.0 / CLOUD_DOME_WARP);
  float elev = CLOUD_DOME_ELEV_MIN + t * (CLOUD_DOME_HALF_PI - CLOUD_DOME_ELEV_MIN);
  float c = cos(elev);
  return vec3(cos(az) * c, sin(elev), sin(az) * c);
}

/*
 * Sample-time advection. The cache stores a slow synchronized generation, but
 * the sample moves by the drift accumulated since that generation was baked.
 */
const float CLOUD_ADVECT_MAX = 400.0;

vec2 cloudAdvectDelta(vec2 live, vec2 baked) {
  vec2 d = live - baked;
  float m = length(d);
  return d * (min(m, CLOUD_ADVECT_MAX) / max(m, 1e-5));
}

vec2 cloudAdvectedUv(vec3 dir, float alt, vec2 delta) {
  float t = alt / max(dir.y, 0.016);
  vec2 p = dir.xz * t + delta;
  return cloudDomeUv(normalize(vec3(p.x, alt, p.y)));
}

/** Effective first-hit altitude of the front-to-back cumulus integral. */
const float CLOUD_ADVECT_ALT = 1350.0;

vec2 cloudCumulusUv(vec3 dir) {
  return cloudAdvectedUv(
    dir,
    CLOUD_ADVECT_ALT,
    cloudAdvectDelta(uCloudOffset, uCloudDriftBase)
  );
}
`;

/** Sparse-atlas address translation shared by the sky and star pass. */
export const GLSL_CLOUD_CACHE_LOOKUP = /* glsl */ `
uniform sampler2D uCloudPackA;
uniform sampler2D uCloudPackB;
uniform sampler2D uCloudPageTable;
uniform vec2 uCloudLogicalGrid;
uniform vec2 uCloudLogicalSize;
uniform vec2 uCloudAtlasSize;
uniform vec2 uCloudTileSize;
uniform vec2 uCloudSlotSize;
uniform float uCloudAtlasColumns;
uniform float uCloudTileGutter;

/**
 * Translate a direction-map UV through the tiny logical-tile page table.
 * The returned z is zero for an unallocated tile, which deliberately falls
 * back to bare sky. Elevation clamps exactly as the full texture did;
 * azimuth remains periodic.
 */
vec3 cloudCacheAddress(vec2 logicalUv) {
  vec2 cacheUv = vec2(
    fract(logicalUv.x),
    clamp(
      logicalUv.y,
      0.5 / uCloudLogicalSize.y,
      1.0 - 0.5 / uCloudLogicalSize.y
    )
  );
  vec2 tilePosition = cacheUv * uCloudLogicalGrid;
  vec2 tile = floor(min(
    tilePosition,
    uCloudLogicalGrid - vec2(0.00001)
  ));
  vec2 local = tilePosition - tile;
  float encodedSlot = floor(
    texture2D(
      uCloudPageTable,
      (tile + vec2(0.5)) / uCloudLogicalGrid
    ).r * 255.0 + 0.5
  );
  if (encodedSlot < 0.5) return vec3(0.0);

  float slot = encodedSlot - 1.0;
  vec2 slotCell = vec2(
    mod(slot, uCloudAtlasColumns),
    floor(slot / uCloudAtlasColumns)
  );
  vec2 physicalUv = (
    slotCell * uCloudSlotSize +
    vec2(uCloudTileGutter) +
    local * uCloudTileSize
  ) / uCloudAtlasSize;
  return vec3(physicalUv, 1.0);
}
`;

/**
 * Analytic single-scattering atmosphere.
 *
 * Radiance for a homogeneous scattering slab:
 *   L = (beta_s * phase / beta_e) * (1 - exp(-beta_e * d)) * T_sun * E
 * with `d` the view air mass and `T_sun` the transmittance along the sun ray.
 * Coefficients are real sea-level Rayleigh optical depths per air mass, so the
 * sunset reddening falls out of the model rather than being hand-painted.
 */
export const GLSL_SKY = /* glsl */ `
uniform vec3  uSunDir;
uniform vec3  uMoonDir;
uniform vec3  uSunTint;
uniform vec3  uMoonTint;
uniform float uSunPower;
uniform float uMoonPower;
/** Clear-sky moon aureole gain, phase-scaled on the CPU. Weather can raise it. */
uniform float uMoonHalo;
uniform float uNight;
uniform float uTime;
uniform float uCloudCover;
uniform float uCloudOpacity;
/**
 * The cloud/weather clock, in two numbers. Both are integrated on the CPU from
 * bounded presentation seconds. Astronomical rate, pause and time scrubbing
 * have no route into them; see SkySystem.advanceCloudPresentation.
 *
 * uCloudOffset is the deck's advection, in metres.
 *
 * uCloudEvolve is travel along the noise field's THIRD axis, also in metres,
 * which is what makes a cloud grow, deform and dissolve rather than merely
 * slide. Metres rather than a phase so that the field converts it with its own
 * spatial scale and evolves at a rate proportional to its own frequency —
 * small tufts boil, the sky's overall organisation drifts.
 */
uniform vec2  uCloudOffset;
uniform float uCloudEvolve;
/**
 * Advection baseline of the synchronized displayed cloud generation. The
 * staging target is never sampled while its tiles are being filled; its
 * texture and this baseline are published together at the 60-frame generation
 * boundary.
 */
uniform vec2 uCloudDriftBase;

const vec3  BETA_R     = vec3(0.0403, 0.0977, 0.2334); // Rayleigh scattering / air mass
// Spectral projection of Rayleigh-scattered light onto the display primaries.
// BETA_R stays the extinction authority (band-integrated optical depths — the
// sunset's reddening), but the COLOUR of in-scattered skylight is a different
// projection: the sky's broad blue spectrum still excites the red display
// primary through the colour-matching overlap, which a three-band model has no
// way to know from a wavelength sample.
//
// DERIVED, not tuned: tools/derive-sky-projection.mjs integrates the
// single-scattered Rayleigh radiance at 5 nm against the CIE 1931 observer and
// least-squares fits this vector to reproduce it, normalised so green equals
// the physical 550 nm coefficient. It puts the clear zenith at CIE x 0.246,
// y 0.253 — the published value for a clear zenith sky is about 0.25, 0.25.
//
// A UNIFORM only so the graphics panel can A/B it against the pre-round
// hand-fitted value live. It is a constant of the world; when the A/B switch
// goes, this goes back to a const and the compiler folds it again.
uniform vec3 uSkyProj;
const float BETA_M     = 0.0570;                        // Mie extinction (transmittance authority)
// Mie IN-SCATTER, deliberately split from Mie extinction. Extinction is what
// reddens the low sun and must stay at the full aerosol burden; in-scatter is
// what paints the circumsolar glow, and crediting it with the whole extinction
// coefficient at a wide lobe (the old 0.057 @ g=0.76) buried the blue sky
// under a 60-degree white veil. Clear maritime air scatters less and more
// forward: a modest coefficient at a tight lobe keeps the aureole and returns
// the zenith to blue. A future weather system raises these for haze.
const float BETA_M_SCAT = 0.0100;                       // Mie in-scatter
const float BETA_M_ABS = 0.0075;                        // Mie absorption
const float SUN_BELOW  = 150.0;                         // extra air mass per unit of negative sun height
// Multiple scattering fills the sky with the illuminant's colour, which at
// noon is white: it is the main reason the low sky went chalky. Pairs with
// the 1.7 spectral exponent below, which shifts the term's colour towards
// blue-white.
const float MULTI      = 0.175;                          // multiple-scattering strength
// Effective air-mass ceiling for the VIEW path of the in-scatter integral
// only — transmittance is untouched. With the raw Kasten-Young air mass
// (~38 at the horizon) the view-path saturation (1-exp(-betaE*am)) reaches 1
// in every channel a dozen degrees up, which painted the wide white band. A
// real spherical-shell atmosphere never behaves like the flat slab there:
// most of a grazing path crosses thin high air. Compressing the effective
// path keeps red unsaturated until the last few degrees, where the
// photographs put the pale band.
const float AM_VIEW_CAP = 13.0;
// Spectral weight exponent of the multiply-scattered field. A photon that
// reaches the eye from the low sky has undergone two or more scattering
// events, each Rayleigh-biased towards blue; weighting by (BETA_R/betaE)^1.7
// rather than ^1 is what keeps the horizon band blue-white instead of chalk.
const float MULTI_SPECTRAL_POW = 1.7;
// How hard a low sun holds the warm recolouring on for the low sky in its own
// azimuth, regardless of how much warm flux is left. Once the disc is on the
// horizon there is no unreddened source left to fill that part of the sky: it
// has all crossed the long, low, reddened path. The flux ratio alone does not
// say so — it falls as the warm single-scatter term dies and hands the band
// back to the cool ozone-blue multi-scatter illuminant, which is the sky
// turning BLUE again with the disc still on the water. Measured at 2 deg
// elevation in the sun's azimuth, linear blue rose 0.18 -> 0.22 -> 0.30 across
// sun +1 -> 0 -> -1 while red fell.
const float SUNSET_HOLD = 0.75;
// Ozone, Chappuis band. It absorbs orange far more than blue, and it sits at
// 20-30 km — exactly the altitude a twilight sun ray grazes through.
const vec3  BETA_O3    = vec3(0.0220, 0.0350, 0.0040);
// Rec.709 luminance weights. Used wherever a recolouring must preserve
// brightness rather than move it.
const vec3  LUMA       = vec3(0.2126, 0.7152, 0.0722);

#ifndef CLOUD_OCTAVES
#define CLOUD_OCTAVES 4
#endif

// Steps of the TRAVERSE through the cloud slab, from the ray's entry at the
// base to its exit at the top. This is the dial between a cloud that has an
// inside and a cloud that is a decal, and the number it wants is far larger
// than the old per-column march needed: the segment is kilometres long at
// useful elevations, so a low count leaves the step spacing coarser than the
// cloud detail and the layer combs into visible shells. The prior attempt at
// this traverse recorded banding as obvious at 28 and gone by 64.
//
// Most steps of most pixels exit on the gradient or threshold reject inside
// cloudDensity() before touching the erosion octave or the sun march, so the
// cost is well below CLOUD_MARCH times the worst-case step.
#ifndef CLOUD_MARCH
#define CLOUD_MARCH 96
#endif

// Octaves of the 3D shape field — the silhouette authority. One more than the
// weather map gets, because this field has to supply everything from a cloud's
// outline down to the bulges on its shoulder, where the weather map only has to
// supply organisation.
#ifndef CLOUD_SHAPE_OCTAVES
#define CLOUD_SHAPE_OCTAVES 5
#endif

// Samples up the sun ray, per marched sample that contains cloud. The single
// most expensive thing in the shader and the reason the clouds have form.
#ifndef CLOUD_SUN_STEPS
#define CLOUD_SUN_STEPS 5
#endif

// Rayleigh scale height and Earth radius, in metres. The sky model is a slab
// everywhere except where the slab is a lie about the sunset; see
// scatterPathScale/sunAirMassAt.
const float ATMO_H  = 8400.0;
const float EARTH_R = 6371000.0;

/** Soft ceiling on single-scatter sample placement, metres. See viewPathInscatter. */
const float SAMPLE_REACH_MAX = 400000.0;

/**
 * Reach of the multiply-scattered source region, in metres, as a soft ceiling.
 *
 * The multiply-scattered field remembers where the sun is because the part of
 * the atmosphere feeding it is displaced toward or away from the sunset point;
 * that displacement is what draws the twilight arch and the Earth's shadow.
 * But it must NOT be the single-scatter path scale, which blows up
 * hyperbolically as the view ray flattens — 8 km at the zenith, 327 km at the
 * horizon. Fed that directly, the local sun elevation swung nearly 5 degrees
 * across the last 5 degrees of sky, and since the twilight illuminant is
 * falling off a cliff at exactly that moment the result was a hard bright
 * strip laid along the horizon on the sunset side and a hard dark strip
 * opposite it (Ash: "this glowing white band... it doesn't match the ocean or
 * the sky", "literally this dark band between the ocean and the sky").
 *
 * The physical answer is that the multiply-scattered field is not a pencil
 * ray. Its source is a broad diffuse volume hundreds of kilometres across, and
 * averaging the sun's elevation over such a volume saturates: past a few
 * hundred kilometres, looking further gets you no further from the terminator
 * in any meaningful sense. So the reach approaches this ceiling smoothly
 * instead of running away, which keeps the arch and removes the strip.
 */
const float MULTI_REACH_MAX = 240000.0;


// Kasten-Young-like relative air mass; 1.0 at the zenith, ~40 at the horizon.
float airMass(float cosZenith) {
  float c = max(cosZenith, 0.0);
  return 1.0 / (c + 0.025 * exp(-11.0 * c));
}

vec3 betaExtinction() {
  return BETA_R + vec3(BETA_M + BETA_M_ABS);
}

/**
 * Distance along a view ray leaving sea level at elevation sin(t) = dirY at
 * which the ray reaches one scale height, accounting for the Earth falling
 * away beneath it. Solves s*dirY + s^2/(2R) = H.
 *
 * This is the length scale of the whole in-scatter integral: 8.4 km looking
 * up, 327 km looking at the horizon. The two numbers differ by a factor of
 * forty, which is the entire reason a horizon ray needs its own sun geometry.
 */
float scatterPathScale(float dirY) {
  float s = max(dirY, 0.0);
  return EARTH_R * (sqrt(s * s + 2.0 * ATMO_H / EARTH_R) - s);
}

float multiReach(float dirY) {
  float s = scatterPathScale(dirY);
  return MULTI_REACH_MAX * s / (s + MULTI_REACH_MAX);
}

/**
 * Air mass along a sun ray leaving altitude z, where the sun stands at
 * sin(elevation) = eps relative to that point's OWN local horizontal.
 *
 * Two corrections over the sea-level formula, both of which are the sunset:
 *  - density: the column above z is thinner by exp(-z/H), and for a ray that
 *    dips before climbing out, by exp(-zTan/H) at its tangent point;
 *  - occlusion: an observer at altitude z sees over the horizon by the dip
 *    angle sqrt(2z/R), so the Earth only starts blocking the sun that much
 *    below local horizontal.
 *
 * Reduces exactly to airMass(eps) + max(-eps,0)*SUN_BELOW at z = 0, so
 * lightTransmittance() is the z = 0 case of this function.
 */
float sunAirMassAt(float z, float eps) {
  float dip = sqrt(2.0 * max(z, 0.0) / EARTH_R);
  float down = min(eps, 0.0);
  float zTan = max(z - 0.5 * EARTH_R * down * down, 0.0);
  return airMass(max(eps, 0.0)) * exp(-zTan / ATMO_H)
       + max(-(eps + dip), 0.0) * SUN_BELOW;
}

// Transmittance of a light ray arriving from lightDir at ground level.
vec3 lightTransmittance(vec3 lightDir) {
  float am = airMass(lightDir.y) + max(-lightDir.y, 0.0) * SUN_BELOW;
  return exp(-betaExtinction() * am);
}

/**
 * The in-scatter integral along a view ray, with each scattering event charged
 * the sun transmittance AT ITS OWN POSITION. Returns the bracketed factor of
 *
 *   L = scat * INTEGRAL[0..A] exp(-betaE * a) * Tsun(a) da
 *
 * so callers multiply by scat alone; the (1 - Tview) saturation is already
 * inside it.
 *
 * This is the fix for a sunset that arrived early and left before the sun did.
 * The old model charged every scattering event the transmittance measured AT
 * THE OBSERVER, at sea level. For a ray toward the horizon that is wrong by
 * orders of magnitude: the air that lights up is 50-300 km away and kilometres
 * up, it sees the sun a degree or two higher through the Earth's curvature, and
 * its sunlight has grazed thin high air rather than forty sea-level air masses.
 * Charging it the observer's transmittance collapses the warm single-scatter
 * term ~25x between sun +5 deg and sun 0 deg, at which point the surviving blue
 * multi-scatter term wins and the sky turns BACK to daylight blue with the disc
 * still on the water. Measured, before this change: the sky just above the
 * horizon toward the sun went 248,238,215 at sun +6 deg to 155,196,238 at sun 0.
 *
 * Two segments, split at half the view path's air mass. Each segment's weight
 * is the exact attenuated mass it carries, exp(-betaE*a0) - exp(-betaE*a1),
 * which is PER CHANNEL and is the second half of the saturation story: blue is
 * extinguished fastest on the way back, so blue's scattering is weighted toward
 * the near, low, deeply reddened part of the path while red keeps its share of
 * the bright far end. Each segment is sampled at the density-weighted median of
 * its own half — u = 0.23 and 0.90 of the scale length, the Gaussian quadrature
 * for the curvature-dominated grazing ray, which is the case that matters.
 *
 * Reduces exactly to (1 - Tview) * Tsun when both samples see the same sun,
 * which is every high-sun case: midday is untouched by construction.
 *
 * Three further things fall out of the geometry that the old model faked or
 * lacked: the glow persisting after sundown, its concentration over the sunset
 * point, and the Earth's shadow darkening the anti-solar horizon first.
 */
vec3 viewPathInscatter(vec3 dir, vec3 lightDir, float amView, vec3 Tview) {
  // Soft ceiling on where the samples are PLACED — the air mass they carry is
  // untouched. Without it the far sample races outward as the ray flattens
  // (294 km at the horizon, 270 km a quarter-degree up), and since that sample
  // is crossing the Earth's shadow boundary at dusk the difference showed up as
  // a hard gradient in the last half-degree of sky. Real in-scatter along a
  // grazing ray is not concentrated at a point: it is smeared over hundreds of
  // kilometres, so a single sample racing away is the artefact, not the physics.
  float s1 = SAMPLE_REACH_MAX * scatterPathScale(dir.y)
           / (scatterPathScale(dir.y) + SAMPLE_REACH_MAX);
  float azProj = dot(dir.xz, lightDir.xz) / EARTH_R;
  float up = max(dir.y, 0.0);
  vec3 be = betaExtinction();

  float sa = s1 * 0.23;
  float za = sa * up + sa * sa / (2.0 * EARTH_R);
  vec3 ta = exp(-be * sunAirMassAt(za, lightDir.y + sa * azProj));

  float sb = s1 * 0.90;
  float zb = sb * up + sb * sb / (2.0 * EARTH_R);
  vec3 tb = exp(-be * sunAirMassAt(zb, lightDir.y + sb * azProj));

  vec3 half1 = exp(-be * (amView * 0.5));
  return (1.0 - half1) * ta + (half1 - Tview) * tb;
}

/**
 * Illuminant for the multiply-scattered sky.
 *
 * Sky-filling light at twilight has not crossed forty air masses at sea level;
 * it grazed the thin upper atmosphere, where ozone is dense and air is not.
 * Ozone eats orange, which is the actual reason a twilight sky goes blue
 * instead of brown. Driving this term from the ground-level solar
 * transmittance instead — as a naive model does — turns the whole dome
 * mud-coloured the moment the sun touches the horizon.
 */
vec3 multiIlluminant(float eps) {
  float below = max(-eps, 0.0);
  float amAir = min(airMass(eps), 11.0);
  float amOzone = amAir + below * 90.0;
  float dim = exp(-0.085 * amAir) * exp(-below * 26.0);
  return vec3(dim) * exp(-BETA_O3 * amOzone);
}


vec3 inscatter(vec3 dir, vec3 lightDir, vec3 tint, float power) {
  if (power <= 0.0) return vec3(0.0);

  float mu = clamp(dot(dir, lightDir), -1.0, 1.0);
  vec3 betaE = betaExtinction();

  // Soft-saturating view-path compression; see AM_VIEW_CAP.
  float amView = airMass(dir.y);
  amView = amView / (1.0 + amView / AM_VIEW_CAP);
  vec3 Tview = exp(-betaE * amView);
  // Already carries the (1 - Tview) view-path saturation, per channel.
  vec3 pathInscatter = viewPathInscatter(dir, lightDir, amView, Tview);

  float phaseR = 0.0596831 * (1.0 + mu * mu);
  // Clear maritime aerosol is strongly forward-scattering. 0.94 confines the
  // circumsolar glow to single digits of degrees at HIGH sun; the old 0.85
  // lobe spread a 30-degree white plateau around the afternoon sun — the
  // "ugly haze ring". But the golden hour needs the opposite: a low sun's
  // light grazes far more aerosol, and the broad gold wash filling the west
  // while the disc is still up IS that wide glow. Without widening the lobe
  // as the sun drops, the sky stays blue until the disc touches the sea and
  // the whole sunset arrives minutes late.
  float lowSun = smoothstep(0.25, 0.03, lightDir.y);
  float g = mix(0.94, 0.80, lowSun);
  float g2 = g * g;
  float phaseM = (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
  // The in-scatter boost that used to ride this lobe (x2.2 at low sun) is
  // gone: it was a workaround for the sunset arriving late, and the real
  // cause of that was the observer-transmittance bug now fixed in
  // viewPathInscatter. Left in it double-counts, and aerosol scattering is
  // spectrally GREY — an oversized Mie term paints the golden hour white
  // instead of gold, because a grey addition lifts the small blue channel
  // proportionally far more than the large red one. The lobe still broadens
  // (a low sun's light does graze far more aerosol); only the magnitude goes.
  float mieScat = BETA_M_SCAT;

  vec3 scat = (uSkyProj * phaseR + vec3(mieScat) * phaseM) / betaE;
  vec3 single = scat * pathInscatter;

  // Multiple scattering. Light stripped out of the direct beam does not
  // disappear, it fills the sky — which is why the zenith stays blue at sunset
  // and why twilight is blue at all. Single scattering alone turns the whole
  // dome orange, the classic failure of analytic sky models near the horizon.
  // This term keeps the physical BETA_R weights: it paints the pale horizon
  // band, whose slight cyan-white is what the photographs show. Only the
  // single-scatter colour takes the display projection.
  // Azimuthal memory for twilight, from the same geometry as the single term
  // rather than a hand-fitted azimuthal weight. The multiply-scattered field
  // is fed by the part of the atmosphere the sun still reaches, which after
  // sundown is the sector above the sunset point: a bright arch there, the
  // Earth's dark shadow segment rising opposite. The source region for a low
  // view ray is hundreds of kilometres out, where the sun stands up to ~3 deg
  // away from where the observer sees it — so the arch and the shadow fall
  // out of the curvature term instead of being painted on. Mean-one over the
  // dome by construction: the displacement projects to +/-1 either side.
  float epsMulti = lightDir.y + (multiReach(dir.y) / EARTH_R) * dot(dir.xz, lightDir.xz);

  // Recycled first-order light. Where the sky is full of reddened single-
  // scattered sunlight, the SECOND-order field it feeds is reddened too: the
  // light bouncing around over a sunset is orange, not blue. The ozone-blue
  // upper-air illuminant is right for the twilight zenith and wrong for the
  // band over the sunset point, where it lays a cyan floor under the warm
  // single-scatter term. Measured: with the multi term suppressed the sunset
  // horizon renders 248,231,23 — the colour the model owes — and with it,
  // 238,217,183, a pale cream.
  //
  // Only the ILLUMINANT is recoloured, never the (BETA_R/betaE)^p scattering
  // weight: that weight is how the second scattering event tints whatever it
  // is given, and it is blue at every sun elevation. Recolouring it instead
  // strips the blue out of the daytime sky (measured: midday zenith 103,151,220
  // -> 132,151,212, warm and pale — the exact defect this round already fixed).
  //
  // The blend weight is the first-order share of the local radiance, which is
  // the honest statement of how much of the recycled light started out warm.
  // It needs no elevation or sun-angle fudge: ~0.8 in the sunset band, ~0.3 on
  // the anti-solar horizon (a pale warm grey — which is what the sky opposite a
  // low sun really is), ~0.2 at 25 deg elevation, and near-neutral in effect at
  // midday because a high sun's beam has almost no hue to lend. Luminance-
  // matched, so it changes the sky's colour and not its brightness.
  vec3 illum = multiIlluminant(epsMulti);
  // Hue of the light the low path actually delivered here. Taken from the
  // weighted in-scatter rather than a bare transmittance, so it carries the
  // same per-channel path weighting the single term does.
  float beamMax = max(pathInscatter.r, max(pathInscatter.g, pathInscatter.b));
  vec3 beamHue = pathInscatter / max(beamMax, 1e-6);
  vec3 warmIllum = beamHue * (dot(illum, LUMA) / max(dot(beamHue, LUMA), 1e-5));

  vec3 multiWeight = pow(BETA_R / betaE, vec3(MULTI_SPECTRAL_POW)) * (1.0 - Tview) * MULTI;
  //
  // The ratio alone is not enough on its own once the sun is at the horizon:
  // it falls as the warm term dies, handing the band back to blue below about
  // +2 deg — the same reversal in miniature. But the HUE of recycled light does
  // not depend on how much of it there is. After sundown the low sky is still
  // being filled by the reddened beam scattered in the far, still-sunlit
  // atmosphere; it is fainter, not bluer. So a low sun holds the recolouring on
  // for the low sky regardless of flux, tapering with view elevation so the
  // twilight zenith keeps its blue.
  float warmFlux = dot(single, LUMA);
  float fluxShare = warmFlux / (warmFlux + dot(multiWeight * illum, LUMA) + 1e-7);
  // Held below 1 on purpose: at full strength the band goes monochromatic
  // orange, which bands and is not what a real deep-twilight strip looks
  // like — there is always some blue left in it. And weighted toward the sun,
  // because that is where the warm light to recycle actually is: without the
  // mu term the hold warms the ANTI-solar horizon too, which puts the whole
  // dome back under one orange wash — the defect this round exists to remove.
  float sunsetHold = SUNSET_HOLD
                   * smoothstep(0.16, -0.02, lightDir.y)
                   * smoothstep(0.25, 0.02, dir.y)
                   * smoothstep(-0.15, 0.55, mu);
  // Summed, not max()'d: the two cross over between sun +3 and +1, and a
  // hard maximum there puts a 10% dip in the reddening exactly where the
  // sky should be deepening fastest.
  float recycled = min(fluxShare + sunsetHold, 0.95);
  vec3 multi = multiWeight * mix(illum, warmIllum, recycled);

  return (single + multi) * tint * power;
}

/**
 * How much of the authored airglow the night sky actually gets.
 *
 * A floor, not a light: this term exists so a moonless sky is not pure black,
 * and at 1.0 it was doing far more than that. Measured against it, a FULL MOON
 * changed the ambient by 1.21x — reality is 100-300x — because the floor sat
 * above everything that is supposed to light a night. The lantern had the same
 * problem from the other end: it could not become the dominant local light
 * however bright it was made, because the sea it stood on never got dark.
 *
 * The world spans 6.5 stops noon-to-night where the real one spans about
 * eighteen, and almost all of that compression is here. A quarter buys 2 stops
 * of it back: the sky reads about 1.5 stops darker on screen (the exposure
 * meter takes the rest), the lamp rises 1.44x in the picture as the meter
 * opens, and the moon's contribution goes from 1.21x to 1.8x. Still not
 * physical — the moon wants its own pass — but it is the right direction and
 * the floor is no longer the brightest thing in a moonless night.
 *
 * Mirrored in TimeOfDay.skyRadiance; the dome, the water's reflection, the
 * ambient fill and the exposure meter all read this same function, so they
 * cannot disagree.
 */
const float NIGHT_BASE_GAIN = 0.25;

// Airglow / integrated starlight. Only present once the sun is down.
vec3 nightBase(vec3 dir) {
  float h = clamp(dir.y, 0.0, 1.0);
  return mix(vec3(0.0102, 0.0163, 0.0318), vec3(0.0027, 0.0046, 0.0111), pow(h, 0.55))
       * NIGHT_BASE_GAIN;
}

// Overall dome radiance gain.
const float SKY_GAIN = 0.79;
/**
 * The sky's radiance, and the single source of truth for it.
 *
 * There is no chroma trim here any more. The old one existed to claw back what
 * the ACES shoulder took out of a saturated blue; with a hue-preserving display
 * transform there is nothing to claw back, and a saturation constant sitting on
 * top of a scattering model is a second, invisible opinion about colour that
 * fights the first one. The hue is set where hue belongs — in uSkyProj, the
 * spectral projection of the scattering coefficient onto the display primaries.
 */
// Sky chroma trim, 1.25 by default. A uniform for the same reason as uSkyProj:
// so the A/B switch can turn it off live. 1.0 means absent.
uniform float uSkySaturation;
/**
 * Live trim on the sky's radiance. 1 is the model's own answer.
 *
 * This is the SINGLE source of sky colour, so the trim reaches both the drawn
 * dome and the ocean's reflection of it — they are the same photons and the
 * uniform object is shared. Dimming only the dome would be a different and
 * larger job: the ocean would then mirror a sky that is not the one overhead.
 */
uniform float uSkyGainTrim;
vec3 skyRadiance(vec3 dir) {
  vec3 c = inscatter(dir, uSunDir, uSunTint, uSunPower);
  c += inscatter(dir, uMoonDir, uMoonTint, uMoonPower);
  c += nightBase(dir) * uNight;
  // The 0.6 trim buys display headroom for the separate daylight exposure
  // lift. It was never meant to take 0.74 stop from airglow and moonlight too.
  // uNight is already the continuous -1 to -9 degree astronomical ramp, so
  // this is identical through daylight/sunset and restores the model at night
  // without adding another time-of-day threshold.
  float effectiveSkyGainTrim = mix(uSkyGainTrim, 1.0, uNight);
  c *= SKY_GAIN * effectiveSkyGainTrim;

  if (uSkySaturation == 1.0) return c;
  // Legacy chroma stretch, on each channel's ratio to the luminance so it
  // preserves brightness. Present only under ?legacyColour=1.
  float lum = dot(c, LUMA);
  vec3 ratio = pow(max(c / max(lum, 1e-6), vec3(1e-4)), vec3(uSkySaturation));
  return ratio * (lum / max(dot(ratio, LUMA), 1e-6));
}

/**
 * Mean and deviation gain of the weather-map fbm.
 *
 * The basis moved from 2D value noise to 3D so the field can EVOLVE — see
 * cloudFbm — and trilinear interpolation averages eight lattice values where
 * bilinear averages four. Measured over 400k samples the mean is unchanged
 * (0.4688 against 0.4684) and the standard deviation falls 14 % (0.1067
 * against 0.1236), because more averaging means less excursion.
 *
 * That matters far more than it looks. The whole layer is built on how far
 * this field passes a threshold: coverage, the soft edge, the column height,
 * the region swing. A 14 % narrower distribution shortens every tower and
 * flattens the sky, and it would do it silently. Rescaling the DEVIATION here
 * restores the distribution the downstream constants were tuned against —
 * measured p05/p50/p95 land within 0.0003 of the old basis at every quantile.
 */
const float CLOUD_FBM_MEAN = 0.469;
const float CLOUD_FBM_GAIN = 1.158;

/**
 * The weather-map fbm, with time as a third noise axis.
 *
 * w is a coordinate, not a phase: the field is a genuine 3D volume and the
 * cloud pattern is a slice through it, so advancing w slides the slice and the
 * contours it draws are continuously born, deformed and killed. That is what a
 * cumulus field actually does, and it is the thing no amount of translating a
 * 2D field can imitate — translation moves clouds past the camera without ever
 * changing one.
 *
 * w DOUBLES with each octave, alongside the domain. So the base octave — the
 * sky's overall organisation, where the clumps and lanes are — changes eight
 * times slower than the finest one, which is the observed behaviour of real
 * convection (eddy turnover time scales with eddy size) and is also what stops
 * the evolution reading as a uniform boil.
 */
float cloudFbm(vec2 p, float w) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.62, 1.18, -1.18, 1.62);
  for (int i = 0; i < CLOUD_OCTAVES; i++) {
    v += a * vnoise3(vec3(p, w));
    p = m * p;
    w *= 2.0;
    a *= 0.5;
  }
  return CLOUD_FBM_MEAN + (v - CLOUD_FBM_MEAN) * CLOUD_FBM_GAIN;
}

/**
 * Cloud layer geometry. A slab with an inside: the base, top and midline are
 * real altitudes, the density varies with height between them, and the view
 * ray is marched through it rather than sampled once at the midline. A future
 * weather system changes these numbers — and eventually promotes them to
 * uniforms, which is the only edit the light transport below would need — to
 * move from fair-weather cumulus to stratus decks and storm towers.
 */
const float CLOUD_BASE   = 1100.0;
const float CLOUD_TOP    = 3300.0;
const float CLOUD_MID    = 0.5 * (CLOUD_BASE + CLOUD_TOP);
const float CLOUD_THICK  = CLOUD_TOP - CLOUD_BASE;
/**
 * Horizontal metres per unit of the noise domain, per axis — 1299 m and 1010 m.
 *
 * These set the cloud field's ASPECT RATIO, which was the last thing making
 * the layer read as a layer rather than as weather. A cloud spans a couple of
 * noise cells, so at the old 2083 x 1613 m a cumulus was 4-6 km across a slab
 * 2.1 km thick: about 4:1, where a fair-weather cumulus is nearer 1:1. Cloud
 * base also came down (1500 -> 1100 m, which is where trade cumulus actually
 * condense) and the slab is slightly deeper.
 *
 * CLOUD_MID moves 2550 -> 2200 m as a consequence, and everything keyed to it
 * is insensitive to that: the sun-ray air mass at altitude changes by 4 %, the
 * sunset dip by a tenth of a degree, and the sky's own colour not at all — the
 * gas atmosphere does not read these constants.
 *
 * The cost is screen-space frequency: the field now moves 1.6x faster per
 * pixel, so the Nyquist fades retire drawn cloud rather closer to the horizon.
 * That is the safe direction to be wrong in.
 */
const vec2  CLOUD_SCALE  = vec2(0.00077, 0.00099);
/**
 * Mean horizontal metres per noise cell, and the column-heights a sun ray
 * climbs per cell it crosses.
 *
 * The self-shadow march below reads the field as a height map and compares
 * neighbour tops against the ray's rise, with distances measured in CELLS and
 * heights in COLUMN FRACTIONS — so it needs the conversion between them. It
 * used to omit it, on the coincidence that a cell was 2083 m and the slab
 * 2100 m thick, making the factor 0.99. Changing either number breaks that
 * silently, in a term nobody would think to check, so it is explicit now.
 */
const float CLOUD_CELL_M = 0.5 * (1.0 / 0.00077 + 1.0 / 0.00099);
const float CLOUD_SHADOW_RISE = CLOUD_CELL_M / (3300.0 - 1100.0);
/**
 * Noise units per metre along the field's THIRD (evolution) axis.
 *
 * The two horizontal axes are scaled differently — that anisotropy is the
 * layer's aspect ratio — but the evolution axis is one number, so it takes the
 * mean cell. Callers that read the field at a scaled domain must scale their
 * evolution coordinate by the same factor, which is what makes a feature's
 * lifetime proportional to its size.
 */
const float CLOUD_EVO_SCALE = 1.0 / CLOUD_CELL_M;
/**
 * Convective boil: how the 3D lump field moves through a cloud that is itself
 * being advected, in metres of lump-domain travel per metre of evolution.
 *
 * Mostly upward, because that is what a cumulus interior does — bubbles rise
 * through the body and pile against the inversion at the top. The horizontal
 * components exist only so the motion is not a pure vertical scroll, which
 * reads as texture crawling over a fixed shape rather than as convection.
 */
const vec3 CLOUD_BOIL = vec3(0.35, 1.90, -0.55);
/**
 * Volume extinction, per METRE of path through unit density.
 *
 * A real number with a real unit, which the constant it replaces was not. The
 * old CLOUD_TAU was the optical depth of a whole COLUMN, and per-step depth was
 * normalised by the step count — it had to be, because the march walked a fixed
 * column at a fixed distance and its geometric length was a fiction. This march
 * is a genuine traverse through a genuine volume, so optical depth is the
 * honest line integral: dens * CLOUD_EXTINCT * dt, with dt in metres.
 *
 * 0.0062 puts about 6 optical depths through a kilometre of solid core, which
 * is opaque, and lets a 200 m wisp pass most of the light. That relation — thin
 * things thin, thick things black — is what the normalised form could never
 * express, because it made every column cost the same regardless of how much
 * cloud the ray actually crossed.
 */
const float CLOUD_EXTINCT = 0.0062;
/** In-scatter gain on sunlight. Calibrated against the pre-march diffuse level. */
const float CLOUD_SUN_GAIN = 1.95;
/**
 * Wind shear across the slab, in metres of horizontal offset between base and
 * top. Real cumulus lean downwind as they rise, and the lean is what lets a
 * view ray see a cloud's FLANK rather than its plan view. It matters less than
 * it did — the field is genuinely three-dimensional now, so it is no longer the
 * only thing stopping every tower being a vertical cylinder — but a leaning
 * cumulus is still what the sky over a windy sea does.
 */
const vec2  CLOUD_SHEAR  = vec2(700.0, 420.0);
/**
 * Cloud streets and clear lanes.
 *
 * A single field thresholded at one level gives every cloud in the sky the same
 * size and the same depth, which is the "they all look the same" read. Real
 * skies clump: regions of crowded deep convection, lanes of thin scattered
 * tufts, and open holes. A very low-frequency 2D field modulating the THRESHOLD
 * produces all three.
 *
 * It survives the move to a 3D field because organisation genuinely IS a 2D
 * phenomenon — convection is organised by the surface below it, and cloud
 * streets are lines on a map, not shapes in a volume. What did not survive is
 * the 2D field being the SILHOUETTE; that is the whole of this round.
 *
 * Scale is in shape cells, so ~5 cells is a region about 6 km across.
 */
const float CLOUD_REGION_SCALE = 0.20;
const float CLOUD_REGION_SWING = 0.50;
/**
 * THE SHAPE FIELD — the reason clouds have height now.
 *
 * Frequency per metre, per axis, of the genuinely three-dimensional field the
 * coverage threshold is applied to. This is the round's whole architectural
 * change, and it is worth being explicit about what it replaces and why, since
 * the thing it replaces was reverted once already.
 *
 * The old density was cov(x, z) * profile(h): a 2D field extruded up a height
 * curve. That is column-shaped BY CONSTRUCTION, and no amount of marching it
 * honestly produces a cloud with a top — an honest traverse of it drew exactly
 * what it is, a field of tapering stalactites hanging off a ceiling. See
 * docs/clouds/CLOUD_SHAPE_FINDINGS.md, which recorded that failure and named this as the
 * fix.
 *
 * Here the threshold is applied to shape3(p) * gradient(h). Because shape3
 * varies as the ray climbs, the isosurface is a genuine 3D surface: it closes
 * over lumpily rather than tapering smoothly, it undercuts, it overhangs, and
 * a cloud has a near side and a far side. Those are the things "puffy" means.
 *
 * The vertical frequency is HIGHER than the horizontal (1050 m cells across,
 * 620 m up) because the slab is only 2200 m thick and an isotropic field would
 * give it barely two cells of vertical structure — one bulge per cloud, which
 * is a mound and not a cauliflower.
 */
const vec3 CLOUD_SHAPE_FREQ = vec3(0.00095, 0.00161, 0.00095);
/**
 * The height gradient the shape field is multiplied by before thresholding.
 *
 * BASE is where condensation starts — sharp, because it is a phase boundary and
 * every base in a fair-weather sky lines up at it, which is most of what tells
 * the eye these are objects at a known distance. TOP_KNEE is where the gradient
 * begins falling and TOP_END where it reaches zero; the long taper between them
 * is what lets a strong region of the shape field push a tower far above the
 * height a weak one reaches. That difference IS the size variety, and it now
 * comes out of the field rather than out of a per-column height lookup.
 */
/*
 * The numbers matter more than they look, and getting them wrong reproduced
 * the very pancake this round exists to kill. The threshold is crossed where
 * shape > threshold/gradient, and the shape field spans about 0.25 to 0.75 —
 * a usable ratio of three. So a gradient that decays hard puts threshold/grad
 * beyond the field's own maximum a short way above the base, and NOTHING can
 * exist higher: at KNEE 0.26 / END 1.05 the entire layer was confined to a
 * 385 m band and came out as flat plates with nice detail on them.
 *
 * The gradient therefore has to stay near 1 through most of the slab and let
 * the SHAPE FIELD decide where each cloud stops. That is the whole point of a
 * 3D field: the top of a cloud is where the field falls below threshold as the
 * ray climbs, which is lumpy, undercut and different for every cloud, instead
 * of a height curve every column shares.
 */
const float CLOUD_GRAD_BASE = 0.060;
const float CLOUD_GRAD_KNEE = 0.180;
const float CLOUD_GRAD_END  = 1.600;
/**
 * Ceiling on the traverse's length, metres.
 *
 * The geometric segment is CLOUD_THICK/dir.y: 3.1 km at 45 degrees of
 * elevation, 12.6 km at ten, 38 km at five. Unbounded, a fixed step budget
 * spread over the low sky lands on unrelated clouds at every step and averages
 * them into mush that boils as the field drifts — measured and recorded by the
 * attempt that first built this traverse. Bounded, a grazing ray stops short of
 * the slab's top, in sky the distance haze has already taken most of.
 */
const float CLOUD_REACH = 17000.0;
/**
 * The sun march: first step in metres, and the ratio between successive steps.
 *
 * Five geometric steps from 105 m cover 1.4 km, which is a cumulus's own width,
 * and they spend their resolution where occlusion is decided — the first
 * hundred metres of cloud between a sample and the sun matter more than the
 * last five hundred. A uniform march would need four times the samples for the
 * same shadow.
 */
const float CLOUD_STEP_MAX = 150.0;
const float CLOUD_SUN_STEP = 105.0;
const float CLOUD_SUN_GROWTH = 1.72;
/** Width of the density ramp past the threshold. Narrow: clouds have edges. */
const float CLOUD_EDGE = 0.075;
/** Peak density of a fully-formed core, before erosion. */
const float CLOUD_DENSITY = 1.35;
/**
 * Spatial frequency of the billow field, per metre — a ~700 m lobe. Chosen
 * against the march's step spacing rather than by eye: a column marched in
 * CLOUD_MARCH steps has to take at least a couple of samples per lobe or the
 * lobes are noise between steps rather than shapes.
 */
const vec3 CLOUD_LUMP_FREQ = vec3(0.00222);
/**
 * Domain-warp distance for the billow field, in its own noise units (one unit
 * is a lobe). Kills the concentric ringing that the abs() fold produces; see
 * cloudLumps.
 */
const float CLOUD_WARP = 0.85;
/** How hard the billow bites, at the flat base and at the boiling top. */
const float CLOUD_ERODE_BASE = 0.45;
const float CLOUD_ERODE_TOP = 1.70;
/**
 * How far, in slab thicknesses, sunlight travels sideways through a column
 * when the sun is too low to escape upward through the top. Bounds the low-sun
 * optical depth to something a cloud's own width can actually supply.
 */
const float CLOUD_ESCAPE = 0.95;

/** Henyey-Greenstein phase function. */
float hg(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}

/**
 * The coverage threshold at a point, including the regional modulation above.
 * uCloudCover is therefore the sky's MEAN threshold, not its only one.
 */
float cloudCoverAt(vec2 q0, float evo) {
  return uCloudCover
    + (cloudFbm(q0 * CLOUD_REGION_SCALE + vec2(53.1, 17.9), evo * CLOUD_REGION_SCALE) - 0.47)
      * CLOUD_REGION_SWING;
}

/**
 * The lump field: the cauliflower.
 *
 * A warped fbm in 3D, used to erode bites out of the profiled shape so that
 * what is left reads as a heap of bulges rather than a smooth mound.
 *
 * IT IS NOT A BILLOW BASIS, AND THAT IS DELIBERATE. Musgrave's billow —
 * abs(2v - 1) — is the textbook way to get convex lobes meeting in sharp
 * creases, and it was tried here first. It has a fatal artefact at this
 * contrast: abs() folds the field about its mean, laying a crease along every
 * v = 0.5 contour with matched ridges either side, which is closed rings
 * around every hill and valley. That is the recipe for procedural marble, and
 * it looked like it — Ash reported "concentric swirls", then thin dark seams
 * through every cloud once a domain warp had sheared the rings apart. The
 * seams are the fold itself: where v crosses its mean the field is exactly
 * zero, so erosion peaks along a curve, and no amount of warping removes a
 * zero. Plain fbm has no fold, so no creases and no rings; the lobes come
 * from its own rounded maxima, softer than Worley's but honest.
 *
 * The domain warp survived the change. It costs one evaluation and it breaks
 * up the grid-aligned blobbiness value noise is prone to.
 *
 * oct2 fades the second octave out by the MARCH's own sampling rate: it has
 * roughly half the period, so a coarse march through a tall column cannot
 * resolve it, and unresolved vertical detail is noise between steps.
 */
float cloudLumps(vec3 p, float oct2) {
  float w = vnoise3(p * 0.53 + vec3(4.7, 9.1, 2.3)) - 0.5;
  p += vec3(w, w * -0.72, w * 0.41) * CLOUD_WARP;
  float v = vnoise3(p);
  if (oct2 > 0.01) {
    v += oct2 * 0.5 * vnoise3(p * 2.03 + vec3(17.3, 5.1, 11.7));
  }
  v /= 1.0 + 0.5 * oct2;
  // Normalised against the field's MEASURED spread, not its theoretical range.
  // Sampled 200k times the warped fbm runs p05 0.19-0.27 to p95 0.73-0.81
  // depending on how much of the second octave survives, so these bounds are
  // the midpoint of that. Getting this wrong once already cost an hour: used
  // raw, a field that clusters around its mean subtracts a near-CONSTANT from
  // the density and looks completely inert while quietly thinning every cloud.
  return clamp((v - 0.23) * 1.85, 0.0, 1.0);
}

/**
 * The 3D shape field: an fbm in three real dimensions, with a fourth axis for
 * evolution folded into the hash the same way the weather map does it.
 *
 * This is the field the coverage threshold is applied to, and that sentence is
 * the whole round. Its lowest octave is the cloud, its higher ones the bulges
 * on the cloud, and because every one of them varies with HEIGHT as well as
 * position, the surface where it crosses the threshold is a surface in space
 * rather than a curve on a map extruded upward.
 *
 * The evolution axis rides the y coordinate offset rather than a fifth
 * dimension: a 4D value noise is eight more hashes per octave, and displacing
 * the vertical domain achieves the same thing here because the gradient already
 * breaks the vertical symmetry — a cloud does not read as "the same cloud
 * shifted down", it reads as a different cloud.
 */
float cloudShape(vec3 p, float evo) {
  vec3 q = p + vec3(0.0, evo, 0.0);
  float v = 0.0;
  float a = 0.5;
  // Rotate between octaves as well as scaling. Without it the lobes of every
  // octave stack on the same axes and the field grids up — the same reason the
  // 2D weather map carries a rotation matrix.
  mat3 m = mat3(0.00, 1.60, 1.20, -1.60, 0.72, -0.96, -1.20, -0.96, 1.28);
  for (int i = 0; i < CLOUD_SHAPE_OCTAVES; i++) {
    v += a * vnoise3(q);
    q = m * q;
    a *= 0.5;
  }
  // Normalised by the amplitude SUM, so the field's statistics do not move when
  // the octave count changes with quality — measured mean 0.500, sd 0.114 over
  // 300k samples at both four and five octaves. Everything that consumes this
  // reads a threshold against it, so a field whose spread depended on the
  // device would hand a phone a different sky rather than a cheaper one.
  return v / (1.0 - a * 2.0);
}

/**
 * The height gradient. Flat base, long taper to the top.
 *
 * It MULTIPLIES the shape field before the threshold rather than multiplying
 * the density after it, and that ordering is the difference between a cloud
 * and a pancake. Multiply after and every column is the same silhouette faded
 * out with height. Multiply before and the threshold crossing MOVES with
 * height: where the shape field is strong the surface survives the gradient's
 * decay and pushes a tower up, where it is weak the surface closes over a few
 * hundred metres above the base. Same field, same threshold, clouds of every
 * size — and the closing is lumpy because the field is.
 */
float cloudGradient(float h) {
  return smoothstep(0.0, CLOUD_GRAD_BASE, h)
       * (1.0 - smoothstep(CLOUD_GRAD_KNEE, CLOUD_GRAD_END, h));
}

/**
 * Density at one point in the slab, in the volume's own units.
 *
 * wp is world position in metres with y measured from the slab base, h its
 * normalised height, threshold the local coverage threshold — 2D, because
 * organisation is genuinely a 2D phenomenon — and detail how much of the
 * erosion octave survives this pixel's sampling rate.
 *
 * Erosion is applied as a fraction of how far INSIDE the surface the sample is,
 * so it shreds the fringe into wisps and leaves the core alone. That asymmetry
 * is what a cumulus edge actually looks like, and it is also the practical
 * lesson from two earlier rounds: an erosion term commensurate with the whole
 * density either does nothing to the cores or annihilates the soft outer band
 * and leaves a hard matte.
 */
float cloudDensity(vec3 wp, float h, float threshold, float detail) {
  float grad = cloudGradient(h);
  if (grad <= 0.0) return 0.0;
  vec3 sp = (wp + vec3(CLOUD_SHEAR.x, 0.0, CLOUD_SHEAR.y) * (h - 0.5)) * CLOUD_SHAPE_FREQ;
  float d = cloudShape(sp, uCloudEvolve * CLOUD_SHAPE_FREQ.y) * grad - threshold;
  if (d <= 0.0) return 0.0;
  d = min(d * (1.0 / CLOUD_EDGE), 1.0);
  if (detail > 0.01) {
    vec3 q = (wp + vec3(CLOUD_SHEAR.x, 0.0, CLOUD_SHEAR.y) * (h - 0.5)) * CLOUD_LUMP_FREQ
           + CLOUD_BOIL * (uCloudEvolve * CLOUD_LUMP_FREQ.y);
    float bite = (1.0 - cloudLumps(q, detail)) * detail;
    // (1 - d) weights the carve toward the surface: full strength on the
    // fringe, nothing in a solid core.
    d = max(d - bite * mix(CLOUD_ERODE_BASE, CLOUD_ERODE_TOP, h) * (1.0 - d), 0.0);
  }
  return d * CLOUD_DENSITY;
}

/**
 * The pieces of the deck's light transport that BOTH evaluation sites share.
 *
 * There are two consumers of this math now: the live march (cumulusDeck /
 * cumulusDeck below, the reference implementation) and the cached-dome pair
 * (cloudBake / cloudLayerCached further down), which split the same integral
 * into a baked geometric part and a live lighting part. Everything either
 * side computes about sunlight, phases and ambience lives HERE, once —
 * a constant that existed in two copies would drift, and a drifted copy is
 * a cache that quietly disagrees with its reference.
 */

// Multiple-scattering octaves: decay rates and gains of the three-term
// similarity expansion. Index order is (single-scatter, second, isotropic);
// the phase weights in cloudMsPhases follow the same order.
const vec3 CLOUD_MS_DECAY = vec3(1.0, 0.42, 0.16);
const vec3 CLOUD_MS_GAIN  = vec3(1.0, 0.55, 0.90);

/**
 * Per-cloud local sun elevation — the terminator walk. Walking toward the
 * sunset chases the terminator, so a cloud down the sun's azimuth sees the
 * sun higher than the observer does and one the other way lost it earlier.
 */
float deckSunY(vec3 dir, float t) {
  vec2 sunAz = normalize(uSunDir.xz + vec2(1e-6, 0.0));
  return uSunDir.y + dot(dir.xz, sunAz) * (t / EARTH_R);
}

/**
 * Sunlight arriving at a deck at the given altitude and local sun elevation,
 * with the horizon dip that altitude buys. Hue from transmittance, brightness
 * compressed by pow 0.42, gated by the terminator.
 */
vec3 deckSunLight(float altitude, float yLocal, float dip) {
  vec3 sunT = exp(-betaExtinction() * sunAirMassAt(altitude, yLocal));
  float sunUp = smoothstep(-0.012, 0.004, yLocal + dip);
  float mT = max(sunT.r, max(sunT.g, sunT.b));
  return uSunTint * (sunT / max(mT, 1e-5)) * uSunPower * pow(mT, 0.42) * sunUp;
}

/** The three phase weights, in CLOUD_MS_DECAY's octave order. */
vec3 cloudMsPhases(float mu) {
  float iso = 0.25 / PI;
  return vec3(
    mix(iso, hg(mu, 0.80), 0.80),
    mix(iso, hg(mu, 0.42), 0.45),
    iso
  );
}

/**
 * The cumulus deck's ambient palette from the sky behind it: the lit colour
 * a fully sky-open sample sees, and the grey a buried one keeps. See the
 * skyOcc discussion in cumulusDeck for why the mix between them is what
 * stops an overcast reading bluer than a broken sky.
 */
void cloudAmbientPalette(vec3 skyHere, out vec3 lit, out vec3 grey) {
  float skyLum = dot(skyHere, LUMA);
  vec3 skyLit = vec3(skyLum) * 1.30 + skyHere * 0.16;
  lit = skyLit + uMoonTint * uMoonPower * 0.9;
  grey = vec3(dot(lit, LUMA));
}

/**
 * Shadow depth toward the sun from one marched sample, in optical depths.
 *
 * Five samples up the sun ray with a growing step, which is where a
 * volumetric cloud gets its FORM: the lit shoulder, the shadowed flank
 * below it, the dark underside. The steps grow because occlusion is
 * dominated by what is nearest: the first 90 m matter more than the last
 * 700, and a geometric series covers a cloud's own width in five samples
 * instead of twenty. Detail is off along the sun ray: erosion barely moves
 * an integrated optical depth, and it doubles the cost of the inner loop.
 */
float cloudSunTau(vec3 sp, float threshold, float sunClimb) {
  float tauSun = 0.0;
  float ss = CLOUD_SUN_STEP;
  vec3 sunP = sp;
  for (int j = 0; j < CLOUD_SUN_STEPS; j++) {
    sunP += uSunDir * ss;
    float sh = sunP.y * (1.0 / CLOUD_THICK);
    if (sh > 1.0) break;
    tauSun += cloudDensity(sunP, sh, threshold, 0.0) * ss;
    ss *= CLOUD_SUN_GROWTH;
  }
  return tauSun * CLOUD_EXTINCT * sunClimb;
}

// The low deck: volumetric cumulus, TRAVERSED. Returns PREMULTIPLIED radiance
// in rgb and the layer's opacity in a, so a caller composites with
// sky * (1 - a) + rgb.
//
// The projection and its screen derivative are computed by cloudLayer() below
// and passed in, because implicit derivatives are undefined after divergent
// control flow and this function starts branching immediately. The parameter t
// remains the
// distance to the slab's MIDLINE and is still the right number for the haze and
// for the per-cloud sun geometry; it is no longer where the samples are taken.
vec4 cumulusDeck(
  vec3 dir, vec3 skyHere, float t, vec2 p, vec2 q0, float cellsPerPixel
) {
  float cloudRes = 1.0 - smoothstep(0.25, 0.75, cellsPerPixel);
  if (uCloudOpacity <= 0.001 || dir.y < 0.004 || cloudRes <= 0.001) return vec4(0.0);
  float horizonFade = smoothstep(0.006, 0.030, dir.y);
  if (horizonFade <= 0.001) return vec4(0.0);

  // === the traverse ======================================================
  //
  // THIS is the round. The ray enters the slab at its base and leaves at its
  // top, and every sample is taken at its own world position and its own
  // height. What that buys, and what nothing else could buy: a near cloud's
  // shoulder occludes the sky above a far cloud's top. Screen-vertical is no
  // longer a synonym for distance.
  //
  // The march it replaces put the whole column at ONE distance — t = mid/dir.y
  // — and walked height at that distance, nudging sideways by at most a noise
  // cell. Under that projection no cloud can show its own vertical extent at
  // any step count with any density field, which is why three rounds of shape
  // work were invisible and why the layer read as a ceiling of pancakes.
  float invY = 1.0 / max(dir.y, 0.016);
  float tEnter = CLOUD_BASE * invY;
  // Capped, because the geometric segment runs to 38 km at five degrees of
  // elevation and a fixed step budget spread over that lands on unrelated
  // clouds and averages them into mush that boils as the field drifts. Past
  // the cap the ray simply stops short of the slab's top, in sky the distance
  // haze has already taken most of.
  float seg = min(CLOUD_THICK * invY, CLOUD_REACH);
  // Step length is capped as well as divided, so the low sky is not sampled
  // coarser than the high sky. Dividing alone gives 65 m steps at forty-five
  // degrees of elevation and 350 m at fourteen — and 350 m is longer than the
  // erosion lobes the step is meant to resolve, so the whole horizon came out
  // grainy while the zenith was clean. Where the cap binds, the traverse covers
  // less than the full segment; the transmittance break and the distance haze
  // have taken almost every such ray long before its far end.
  //
  // Those step lengths are the low-count world the cap was introduced for. At
  // the shipped CLOUD_MARCH of 192 it does not bind anywhere: seg tops out at
  // CLOUD_REACH, so the longest step any ray can take is 17000/192 = 88.5 m,
  // comfortably under 150. It goes live again below about 114 steps, which
  // ?cloudMarch= can still ask for — which is why the min() stays.
  float dt = min(seg / float(CLOUD_MARCH), CLOUD_STEP_MAX);
  // NO march-start dither, and CLOUD_MARCH is set high enough not to need one.
  //
  // There used to be a per-pixel interleaved-gradient offset here to break the
  // sample shells into grain instead of banded ridges. It worked while the
  // march ran per screen pixel. It stopped working when the deck moved into
  // the direction cache: the offset is then baked per cache TEXEL, and the
  // cache carries about 17 texels per degree of azimuth against a screen that
  // resolves 30 or more, so every dither cell was magnified across roughly two
  // pixels and bilinearly smeared. IGN is an ordered sequence whose iso-value
  // lines run near-vertically with a period of about 1.8 samples, so what had
  // been invisible grain became a woven comb lying across every cloud — worse
  // on mobile (2.6 texels per pixel) than on desktop.
  //
  // Measured against a 256-step reference, the dither was also barely earning
  // its keep by then: at 96 steps it improved rms error by 5% while more than
  // doubling horizontal high-frequency energy. Steps fix the banding honestly;
  // a dither can only redistribute it, and this cache cannot hide where it
  // puts it. If TAA ever lands, a TEMPORAL jitter would be the thing to add —
  // not this.

  // How much of the erosion octave this pixel can resolve. Measured against
  // the SHAPE field's cell rather than the old weather map's, and widened for
  // the erosion's own higher frequency.
  float detailRes = 1.0 - smoothstep(0.25, 0.75, cellsPerPixel * 3.4);
  float detail = detailRes * (0.35 + 0.65 * exp(-t * 0.000022));

  // === the local threshold ===============================================
  //
  // Organisation stays two-dimensional, because it genuinely is: convection is
  // organised by the surface under it, and a cloud street is a line on a map.
  // Only the SILHOUETTE moved into three dimensions.
  //
  // Sampled at the segment's two ends and interpolated along the ray rather
  // than evaluated per step. The field's cells are 6.5 km against a segment
  // that is under 4 km above thirty degrees of elevation, so a linear fit
  // across it is very nearly exact — and it costs two evaluations instead of
  // CLOUD_MARCH of them.
  float evo = uCloudEvolve * CLOUD_EVO_SCALE;
  vec2 qNear = (dir.xz * tEnter + uCloudOffset) * CLOUD_SCALE;
  vec2 qFar  = (dir.xz * (tEnter + seg) + uCloudOffset) * CLOUD_SCALE;
  float coverNear = cloudCoverAt(qNear, evo);
  float coverFar  = cloudCoverAt(qFar, evo);

  // === per-cloud sun geometry ============================================
  //
  // Every cloud keeps its own sunset — see deckSunY. From 2.2 km up the
  // whole layer sees the sun for another 1.6 deg after the sea has lost it.
  float yLocal = deckSunY(dir, t);
  float cloudDip = sqrt(2.0 * CLOUD_MID / EARTH_R);
  vec3 sunLight = deckSunLight(CLOUD_MID, yLocal, cloudDip);

  // === scattering geometry ===============================================
  float mu = clamp(dot(dir, uSunDir), -1.0, 1.0);
  vec3 msPhase = cloudMsPhases(mu);

  vec3 ambientLit;
  vec3 ambientGrey;
  cloudAmbientPalette(skyHere, ambientLit, ambientGrey);

  // A sun ray that has to climb out of the deck sideways crosses more of it.
  // Bounded, because at a low sun the geometric secant runs to twenty and the
  // shadow march would need a step budget nobody can afford.
  float sunClimb = clamp(1.0 / max(yLocal + cloudDip, 0.12), 1.0, 6.0);

  // === the march =========================================================
  float transmit = 1.0;
  vec3 scatter = vec3(0.0);
  for (int i = 0; i < CLOUD_MARCH; i++) {
    float s = (float(i) + 0.5) * dt;
    vec3 wp = dir * (tEnter + s);
    wp.x += uCloudOffset.x;
    wp.z += uCloudOffset.y;
    float h = (wp.y - CLOUD_BASE) * (1.0 / CLOUD_THICK);
    float threshold = mix(coverNear, coverFar, s / max(seg, 1.0));
    vec3 sp = vec3(wp.x, wp.y - CLOUD_BASE, wp.z);
    float dens = cloudDensity(sp, h, threshold, detail);
    if (dens <= 0.002) continue;

    // === self-shadowing, marched toward the sun ==========================
    //
    // Where a volumetric cloud gets its FORM: the lit shoulder, the shadowed
    // flank below it, the dark underside. The old deck could only fake this
    // from a column height because it had no volume to march through. This
    // is the most expensive thing in the shader and it is the thing worth
    // paying for — see cloudSunTau for the step geometry.
    float tauSun = cloudSunTau(sp, threshold, sunClimb);

    // Multiple scattering as three octaves. Each successive order has travelled
    // further, so it is attenuated less than Beer's law says and its phase
    // function has been washed toward isotropic by the scatterings that made
    // it. The similarity relation is what sets the decay rates: diffuse light
    // through a deck behaves like optical depth tau*(1-g), and at g = 0.85
    // that is about a sixth of the geometric figure.
    //
    // THE RATES WERE RECALIBRATED WITH THE TRAVERSE and it mattered more than
    // it sounds. The old march's tauSun was not an optical depth — it was a
    // column fraction times a normalised constant, and it topped out near 4.
    // The traverse computes a real line integral that reaches 10 to 30 through
    // a cumulus core, so decay rates fitted to the old number left the
    // isotropic octave almost undimmed at any depth: a shadowed face came out
    // within a stop and a half of a lit one and every cloud in the sky was a
    // flat white cut-out with cauliflower edges. Measured over the sky, the
    // range from lit to deeply shadowed went from 3.7:1 to 9:1 on this change
    // alone.
    float ms = dot(CLOUD_MS_GAIN * msPhase, exp(-CLOUD_MS_DECAY * tauSun));
    // Powder: the darkening just inside a LIT edge, where light has entered
    // but has not yet scattered its way back out. Without it thin sunward
    // cloud reads as flat paint.
    float powder = 1.0 - 0.32 * exp(-tauSun * 3.0) * (1.0 - exp(-dens * 2.4));

    // Sky light arrives from the whole dome, so a base is dim rather than dark,
    // and what decides how much of the dome a sample can still see is the cloud
    // ABOVE it — not its height. That distinction is not cosmetic: a height-only
    // proxy makes a heavy overcast come out BLUER than a broken sky, because the
    // only light left under a thick deck is the tinted term and a proxy that
    // does not know the deck is thick never takes it away. There is a test for
    // exactly that inversion in graphics.test.ts and it caught this.
    //
    // Estimated rather than marched: the local density carried to the top of the
    // slab. A second march straight up would cost as much again as the sun march
    // to refine a term that is already a diffuse average over a hemisphere.
    float tauUp = dens * max(1.0 - h, 0.0) * CLOUD_THICK * CLOUD_EXTINCT;
    float skyOcc = mix(0.18, 1.0, exp(-tauUp * 0.35));
    // And it loses its hue FASTER than its brightness, which is why the tint
    // is retained on skyOcc squared and the brightness on skyOcc itself. The
    // chromatic part of skylight is the part that reached the sample without
    // hitting cloud; the achromatic part is what bounced. The straight-through
    // fraction falls off the faster of the two, so a deep sample keeps some
    // brightness long after it has lost all of its blue.
    //
    // Under-neutralising here is a measured failure, not a theoretical one: at
    // the linear form a heavy overcast came out BLUER than a broken sky, which
    // graphics.test.ts asserts against because it is backwards about the most
    // recognisable thing an overcast sky does.
    vec3 ambient = mix(ambientGrey, ambientLit, skyOcc * skyOcc) * skyOcc;

    vec3 radiance = sunLight * ms * CLOUD_SUN_GAIN * powder + ambient;

    // Optical depth as an honest line integral: density times extinction times
    // the metres actually crossed. The march it replaces normalised by step
    // COUNT, because its geometric length was a fiction — and that is exactly
    // why nothing in it could be thin.
    float aStep = 1.0 - exp(-dens * CLOUD_EXTINCT * dt);
    scatter += transmit * aStep * radiance;
    transmit *= 1.0 - aStep;
    if (transmit < 0.010) break;
  }
  if (transmit >= 0.999) return vec4(0.0);

  float haze = exp(-t * 0.000042);
  float fade = clamp(uCloudOpacity * haze * horizonFade * cloudRes, 0.0, 1.0);
  return vec4(scatter * fade, (1.0 - transmit) * fade);
}

/**
 * The cumulus deck.
 *
 * Every screen derivative in the layer is taken here, at the top, before any
 * branch: implicit derivatives are undefined in divergent control flow, and the
 * deck early-outs on view direction within the first few lines. The Nyquist
 * fades these feed are what stop the field being point-sampled into per-pixel
 * static, which cost a whole round to diagnose once already.
 */
vec4 cloudLayer(vec3 dir, vec3 skyHere) {
  float tLow = CLOUD_MID / max(dir.y, 0.016);
  vec2 pLow = dir.xz * tLow + uCloudOffset;
  vec2 q0 = pLow * CLOUD_SCALE;
  // Measured at the midline and widened to the slab's TOP, whose projection
  // moves CLOUD_TOP/CLOUD_MID faster than the midline's: the march's last step
  // is the one most likely to outrun a pixel, so the fade must be sized for it.
  float cellsLow = max(fwidth(q0.x), fwidth(q0.y)) * (CLOUD_TOP / CLOUD_MID);

  return cumulusDeck(dir, skyHere, tLow, pLow, q0, cellsLow);
}

vec3 skyWithClouds(vec3 dir) {
  vec3 base = skyRadiance(dir);
  vec4 cl = cloudLayer(dir, base);
  return base * (1.0 - cl.a) + cl.rgb;
}

/*
 * === the cached dome =====================================================
 *
 * cloudLayer() is a function of view DIRECTION alone — the dome rides the
 * camera, the slab is kilometres up, and nothing in the march reads the
 * camera's position. A function on directions can be baked into a texture
 * and sampled, and that observation is most of a 4x frame: the march was
 * ~75% of the whole game, re-integrating a slow sky at screen rate.
 *
 * But it is NOT baked as colour. The march's sum factors exactly:
 *
 *   scatter = sunLight * GAIN * dot(GAIN_k * phase_k(mu), S_k)
 *           + ambientGrey * W1 + ambientLit * W2
 *
 * where S_k = sum(w_i * powder_i * exp(-decay_k * tauSun_i)) and
 * W1/W2 = sum(w_i * (skyOcc_i - skyOcc_i^3)) / sum(w_i * skyOcc_i^3), with
 * w_i the march's own transmittance-weighted step opacity. Every factor
 * OUTSIDE those sums — the sun's colour and terminator, the phases, the
 * ambient palette — is constant along a ray and cheap, so it is applied
 * LIVE, per frame, by cloudLayerCached(). What cloudBake() stores is the
 * colourless part: how much cloud, how shadowed, how buried. The visible
 * consequence: a sunset recolours every cloud face at full frame rate off a
 * cache that refreshes every second; the only thing that ticks
 * at bake cadence is shadow GEOMETRY (tauSun and sunClimb are baked at the
 * bake instant's sun), and a bake period's worth of sun motion moves a
 * shadow boundary by less than an erosion lobe.
 *
 * Channel map, one RGBA16F target and one RG16F:
 *   packA = (S0, S1, S2, cumulusAlpha)
 *   packB = (W1, W2)
 * Everything is baked WITHOUT uCloudOpacity; the live composite multiplies
 * it back, so the lab's kill-switch keeps working between bakes.
 *
 * The mapping is an equirect over the hemisphere with an elevation warp:
 * v = t^CLOUD_DOME_WARP spends its rows near the horizon, where the deck
 * compresses into the fine receding tufts that a uniform mapping — and the
 * screen-space buffer this design replaced — blurred away first. fwidth()
 * inside the bake sees the warped raster, so every Nyquist fade retires
 * detail against the cache's OWN local density, exactly as it retired
 * against the screen's before.
 */

${GLSL_CLOUD_DOME_MAPPING}

/**
 * The march, emitting the factored accumulators instead of radiance. Mirrors
 * cumulusDeck step for step — the gates, the traverse, the fades — through the
 * same helpers (cloudDensity, cloudSunTau, the CLOUD_MS_* constants), so the
 * two sites cannot disagree about the field. What it deliberately does not
 * read: any colour, any phase, the moon, uCloudOpacity. Those are the live
 * side's whole job.
 */
void cloudBake(
  vec3 dir,
  out vec4 packA,
  out vec2 packB
) {
  packA = vec4(0.0);
  packB = vec2(0.0);

  // Derivatives before any branch, cloudLayer's own law.
  float tLow = CLOUD_MID / max(dir.y, 0.016);
  vec2 pLow = dir.xz * tLow + uCloudOffset;
  vec2 q0 = pLow * CLOUD_SCALE;
  float cellsLow = max(fwidth(q0.x), fwidth(q0.y)) * (CLOUD_TOP / CLOUD_MID);

  float cloudRes = 1.0 - smoothstep(0.25, 0.75, cellsLow);
  float horizonFade = smoothstep(0.006, 0.030, dir.y);
  if (dir.y >= 0.004 && cloudRes > 0.001 && horizonFade > 0.001) {
    float invY = 1.0 / max(dir.y, 0.016);
    float tEnter = CLOUD_BASE * invY;
    float seg = min(CLOUD_THICK * invY, CLOUD_REACH);
    float dt = min(seg / float(CLOUD_MARCH), CLOUD_STEP_MAX);

    float detailRes = 1.0 - smoothstep(0.25, 0.75, cellsLow * 3.4);
    float detail = detailRes * (0.35 + 0.65 * exp(-tLow * 0.000022));

    float evo = uCloudEvolve * CLOUD_EVO_SCALE;
    vec2 qNear = (dir.xz * tEnter + uCloudOffset) * CLOUD_SCALE;
    vec2 qFar  = (dir.xz * (tEnter + seg) + uCloudOffset) * CLOUD_SCALE;
    float coverNear = cloudCoverAt(qNear, evo);
    float coverFar  = cloudCoverAt(qFar, evo);

    float yLocal = deckSunY(dir, tLow);
    float cloudDip = sqrt(2.0 * CLOUD_MID / EARTH_R);
    float sunClimb = clamp(1.0 / max(yLocal + cloudDip, 0.12), 1.0, 6.0);

    float transmit = 1.0;
    vec3 S = vec3(0.0);
    float W1 = 0.0;
    float W2 = 0.0;
    for (int i = 0; i < CLOUD_MARCH; i++) {
      float s = (float(i) + 0.5) * dt;
      vec3 wp = dir * (tEnter + s);
      wp.x += uCloudOffset.x;
      wp.z += uCloudOffset.y;
      float h = (wp.y - CLOUD_BASE) * (1.0 / CLOUD_THICK);
      float threshold = mix(coverNear, coverFar, s / max(seg, 1.0));
      vec3 sp = vec3(wp.x, wp.y - CLOUD_BASE, wp.z);
      float dens = cloudDensity(sp, h, threshold, detail);
      if (dens <= 0.002) continue;

      float tauSun = cloudSunTau(sp, threshold, sunClimb);
      float powder = 1.0 - 0.32 * exp(-tauSun * 3.0) * (1.0 - exp(-dens * 2.4));
      float tauUp = dens * max(1.0 - h, 0.0) * CLOUD_THICK * CLOUD_EXTINCT;
      float skyOcc = mix(0.18, 1.0, exp(-tauUp * 0.35));
      float s3 = skyOcc * skyOcc * skyOcc;

      float aStep = 1.0 - exp(-dens * CLOUD_EXTINCT * dt);
      float w = transmit * aStep;
      S += w * powder * exp(-CLOUD_MS_DECAY * tauSun);
      W1 += w * (skyOcc - s3);
      W2 += w * s3;
      transmit *= 1.0 - aStep;
      if (transmit < 0.010) break;
    }
    if (transmit < 0.999) {
      float haze = exp(-tLow * 0.000042);
      float fade = clamp(haze * horizonFade * cloudRes, 0.0, 1.0);
      packA = vec4(S, 1.0 - transmit) * fade;
      packB = vec2(W1, W2) * fade;
    }
  }
}

/**
 * The live half of the factorization: reconstruct the deck's radiance from the
 * baked packs, with THIS frame's sun, moon and sky. Term for term this is
 * cumulusDeck's radiance line with the baked sums standing in for its
 * integrals; uCloudOpacity multiplies at the end exactly as the deck's own
 * fade line did, clamp bounds and all — see the fade discussion in cumulusDeck
 * for why that commutes.
 */
vec4 cloudLayerCached(vec3 dir, vec3 skyHere, vec4 packA, vec2 packB) {
  float tLow = CLOUD_MID / max(dir.y, 0.016);
  float yLocal = deckSunY(dir, tLow);
  float cloudDip = sqrt(2.0 * CLOUD_MID / EARTH_R);
  vec3 sunLight = deckSunLight(CLOUD_MID, yLocal, cloudDip);
  float mu = clamp(dot(dir, uSunDir), -1.0, 1.0);
  vec3 msPhase = cloudMsPhases(mu);
  vec3 ambientLit;
  vec3 ambientGrey;
  cloudAmbientPalette(skyHere, ambientLit, ambientGrey);
  vec3 rgb = sunLight * CLOUD_SUN_GAIN * dot(CLOUD_MS_GAIN * msPhase, packA.rgb)
           + ambientGrey * packB.x + ambientLit * packB.y;
  return vec4(rgb, packA.a) * uCloudOpacity;
}
`;

/**
 * Gerstner wave evaluation. `NUM_WAVES` is injected as a define by Ocean.ts.
 * The identical arithmetic is implemented on the CPU in `Waves.ts`, so raft
 * buoyancy and the rendered surface can never disagree.
 *
 * uWaveA[i] = (dirX, dirZ, amplitude, k)
 * uWaveB[i] = (Q, phase, lodFadeStart, lodFadeEnd)
 *
 * Every caller passes a *parameter position* measured from the local render
 * origin — the same space `WaveField.sample()` takes. The ocean disc is drawn
 * at a non-zero local position, so it adds its own centre via `uWaveOrigin`.
 * See the header of `Waves.ts` for the contract.
 */
export const GLSL_WAVES = /* glsl */ `
uniform vec4 uWaveA[NUM_WAVES];
uniform vec4 uWaveB[NUM_WAVES];
uniform float uWaveAmp;
uniform vec2 uWaveOrigin;
/**
 * Wavenumber above which a component is left to the statistical roughness
 * rather than evaluated per pixel by the residual term. Uniform across the
 * draw, so the branch below never diverges within a warp.
 */
uniform float uResidualMaxK;

struct WaveResult {
  vec3 displacement;
  vec3 normal;
  /**
   * Height gradient with respect to the *undisplaced parameter* position,
   * d(h)/d(p). Not a world-space slope: converting it to one requires the
   * inverse Jacobian below, and doing that conversion once, after every
   * contribution has been summed, is the whole point of carrying it separately.
   */
  vec2 gradient;
  /** Inverse of the symmetric horizontal Jacobian, as (a, b, c) = [[a,b],[b,c]]. */
  vec3 invJacobian;
  /** Determinant of the horizontal Jacobian. 1 is undisturbed, <1 compressed. */
  float jacobian;
  /**
   * Trace of the Jacobian perturbation, sum(Q A k sin phi).
   *
   * This is the breaking indicator, and it is not a proxy: the downward
   * acceleration of a deep-water crest in units of g is exactly sum(A k sin
   * phi), so this is that acceleration scaled by the Gerstner Q. A wave breaks
   * when its crest particles fall faster than gravity holds them.
   *
   * Deliberately *not* the determinant. The two agree to first order, but the
   * determinant carries a second-order term that grows with the sea state, so
   * thresholding it makes rough seas break less readily than calm ones — the
   * opposite of the truth, and it is what the Gaussian calibration in
   * spectrum.ts is derived for. The determinant stays for what it is actually
   * about, which is folding.
   */
  float compression;
};

/**
 * Convert a parameter-space height gradient into a world-space surface slope.
 *
 * The surface is X(p) = p + D(p), Y(p) = h(p). The chain rule gives
 * dY/dX = (dh/dp) (dX/dp)^-1, so a gradient measured in parameter space must be
 * pushed through the inverse horizontal Jacobian before it is a slope. Adding
 * parameter-space gradients straight onto a world slope is exact only for a
 * height field with no horizontal displacement — which is precisely what a
 * Gerstner surface is not, and the error is largest at compressed crests, where
 * the foam and the specular detail live.
 */
vec2 slopeFromGradient(vec2 gradient, vec3 invJ) {
  return vec2(invJ.x * gradient.x + invJ.y * gradient.y,
              invJ.y * gradient.x + invJ.z * gradient.y);
}

WaveResult evaluateWaves(vec2 p, float lodRadius) {
  WaveResult r;
  r.displacement = vec3(0.0);
  r.gradient = vec2(0.0);
  float jxx = 0.0;
  float jzz = 0.0;
  float jxz = 0.0;

#ifndef NUM_VERTEX_WAVES
#define NUM_VERTEX_WAVES NUM_WAVES
#endif
  for (int i = 0; i < NUM_VERTEX_WAVES; i++) {
    vec2 d = uWaveA[i].xy;
    float k = uWaveA[i].w;
    float Q = uWaveB[i].x;
    float lod = 1.0 - smoothstep(uWaveB[i].z, uWaveB[i].w, lodRadius);
    float A = uWaveA[i].z * uWaveAmp * lod;
    if (A <= 0.0) continue;

    float ph = k * dot(d, p) + uWaveB[i].y;
    float s = sin(ph);
    float c = cos(ph);
    float ak = A * k;
    float qak = Q * ak;

    r.displacement.xz += Q * A * d * c;
    r.displacement.y  += A * s;

    r.gradient += d * (ak * c);

    jxx += qak * d.x * d.x * s;
    jzz += qak * d.y * d.y * s;
    jxz += qak * d.x * d.y * s;
  }

  float a = 1.0 - jxx;
  float b = -jxz;
  float cc = 1.0 - jzz;
  float det = a * cc - b * b;
  r.jacobian = det;
  r.compression = jxx + jzz;

  // Clamp before inverting. Where the surface is close to folding the true
  // inverse is unbounded, and an unbounded slope is a white pixel of NaN rather
  // than a steep wave. The clamp bounds the crest sharpening; it does not
  // change the geometry, which the vertex position has already committed to.
  float safeDet = max(det, 0.10);
  r.invJacobian = vec3(cc, -b, a) / safeDet;

  // Exact parametric-surface normal: the cross product of the two tangents,
  // which for this surface reduces to the inverse Jacobian applied to the
  // parameter-space gradient.
  vec2 slope = slopeFromGradient(r.gradient, r.invJacobian);
  r.normal = normalize(vec3(-slope.x, 1.0, -slope.y));
  return r;
}

/**
 * Parameter-space height gradient of the components the mesh was too coarse to
 * displace.
 *
 * Without this the sea flattens into a mirror plate wherever the geometry LOD
 * has faded the swell out, and the components that survive longest stack into
 * parallel ridges — corduroy. Displacement is what aliases, not shading, so the
 * dropped components are handed to the fragment stage and evaluated per pixel
 * from the same definition, band-limited by the pixel footprint rather than by
 * the vertex spacing. Geometry -> normal -> roughness, with each level taking
 * over exactly where the last one gives up.
 *
 * Two things this returns that the caller must respect. It is a gradient in
 * *parameter* space, to be summed with the vertex stage's gradient and pushed
 * through the inverse Jacobian once at the end. And it must be evaluated at the
 * *undisplaced* parameter position — the same p the vertex phase used. Using
 * the displaced position instead misregisters every ripple by the horizontal
 * displacement, which is tens of centimetres in a moderate sea and a raft
 * length in a steep one.
 */
#ifdef OCEAN_PROFILE_RESIDUAL_TEXTURE
/**
 * Structural probe: the same 48 vec4 pairs as uWaveA/uWaveB, but fetched from
 * RGBA32F textures instead of the default uniform block. The textures share
 * the exact Float32Arrays the uniforms upload from, so every fetched bit is
 * identical — the only thing this variant changes is the access path, to test
 * whether ANGLE's uniform-array translation is what makes the scan expensive.
 */
uniform highp sampler2D uWaveTexA;
uniform highp sampler2D uWaveTexB;
#endif
#ifdef OCEAN_PROFILE_RESIDUAL_ROLLED
/**
 * Structural probe: the loop bound as a uniform the compiler cannot see
 * through, so the 48 iterations cannot be unrolled. Tests whether unrolling —
 * instruction-cache pressure, register allocation across 48 inlined bodies —
 * is what makes the scan expensive.
 */
uniform int uResidualSlotCount;
#endif
#ifdef OCEAN_PROFILE_RESIDUAL_ACTIVE
/**
 * Fragment-only wavelength-ordered view. uResidualWaveB.x is the cumulative
 * base slope energy before a slot, allowing a fully statistical suffix to be
 * represented by one subtraction instead of one classification per wave.
 */
uniform vec4 uResidualWaveA[NUM_WAVES];
uniform vec4 uResidualWaveB[NUM_WAVES];
uniform int uResidualActiveCount;
uniform float uResidualTotalSlopeEnergy;
#endif

/**
 * Diagnostic classification of the shipping residual loop's 48 slots.
 *
 * The six buckets are deliberately exclusive and sum to NUM_RESIDUAL_WAVES.
 * That makes the third value in categoryB the exact number of components an
 * ideal wavelength-ordered active window would still have to evaluate
 * individually at this fragment:
 *
 *   categoryA = (unused, geometry-resolved, geometry transition,
 *                fully residual-visible)
 *   categoryB = (residual/roughness transition, fully statistical,
 *                individually evaluated)
 *
 * A component in the geometry transition stays in that bucket even if its
 * pixel-footprint fade is also partial. It cannot be aggregated in either
 * case, so this exclusive ordering answers the optimization question without
 * double-counting it.
 */
void residualWaveCategories(
  float lodRadius,
  float footprint,
  out vec4 categoryA,
  out vec3 categoryB
) {
  categoryA = vec4(0.0);
  categoryB = vec3(0.0);

#ifndef NUM_RESIDUAL_WAVES
#define NUM_RESIDUAL_WAVES NUM_WAVES
#endif

  for (int i = 0; i < NUM_RESIDUAL_WAVES; i++) {
    float k = uWaveA[i].w;
    float amp0 = uWaveA[i].z * uWaveAmp;
    if (amp0 <= 0.0) {
      categoryA.x += 1.0;
      continue;
    }

    float missing = smoothstep(uWaveB[i].z, uWaveB[i].w, lodRadius);
    if (missing < 0.002) {
      categoryA.y += 1.0;
      continue;
    }
    if (missing < 1.0) {
      categoryA.z += 1.0;
      categoryB.z += 1.0;
      continue;
    }

    float wavelength = 6.2831853 / k;
    float visible = 1.0 - smoothstep(
      wavelength * 0.25,
      wavelength * 0.50,
      footprint
    );
    if (visible > 0.002 && k < uResidualMaxK) {
      if (visible < 1.0) categoryB.x += 1.0;
      else categoryA.w += 1.0;
      categoryB.z += 1.0;
    } else {
      categoryB.y += 1.0;
    }
  }
}

vec2 residualWaveGradient(vec2 p, float lodRadius, float footprint, out float lostVariance) {
  vec2 gradient = vec2(0.0);
  lostVariance = 0.0;

#ifndef NUM_RESIDUAL_WAVES
#define NUM_RESIDUAL_WAVES NUM_WAVES
#endif

#if defined(OCEAN_PROFILE_RESIDUAL_ACTIVE)
  // The ordered table makes both predicates monotonic along k: geometry fades
  // out toward the short-wave end, and pixel visibility does the same. Two
  // six-step lower-bound searches therefore replace the 48 independent
  // classifications while preserving the original formulas at every partial
  // boundary component.
  int startLo = 0;
  int startHi = uResidualActiveCount;
  for (int searchStep = 0; searchStep < 6; searchStep++) {
    if (startLo >= startHi) break;
    int mid = (startLo + startHi) / 2;
    float missing = smoothstep(
      uResidualWaveB[mid].z,
      uResidualWaveB[mid].w,
      lodRadius
    );
    if (missing < 0.002) startLo = mid + 1;
    else startHi = mid;
  }
  int activeStart = startLo;

  int endLo = activeStart;
  int endHi = uResidualActiveCount;
  for (int searchStep = 0; searchStep < 6; searchStep++) {
    if (endLo >= endHi) break;
    int mid = (endLo + endHi) / 2;
    float k = uResidualWaveA[mid].w;
    float missing = smoothstep(
      uResidualWaveB[mid].z,
      uResidualWaveB[mid].w,
      lodRadius
    );
    float wavelength = 6.2831853 / k;
    float visible = 1.0 - smoothstep(
      wavelength * 0.25,
      wavelength * 0.50,
      footprint
    );
    bool fullyStatistical =
      missing >= 1.0 && !(visible > 0.002 && k < uResidualMaxK);
    if (fullyStatistical) endHi = mid;
    else endLo = mid + 1;
  }
  int activeEnd = endLo;

  for (int i = activeStart; i < activeEnd; i++) {
    float k = uResidualWaveA[i].w;
    float amp0 = uResidualWaveA[i].z * uWaveAmp;
    if (amp0 <= 0.0) continue;

    float missing = smoothstep(
      uResidualWaveB[i].z,
      uResidualWaveB[i].w,
      lodRadius
    );
    if (missing < 0.002) continue;

    float wavelength = 6.2831853 / k;
    float amp = amp0 * missing;
    float visible = 1.0 - smoothstep(
      wavelength * 0.25,
      wavelength * 0.50,
      footprint
    );
    if (visible > 0.002 && k < uResidualMaxK) {
#ifndef OCEAN_PROFILE_DISABLE_RESIDUAL_PHASE
      vec2 d = uResidualWaveA[i].xy;
      float ph = k * dot(d, p) + uResidualWaveB[i].y;
      gradient += d * (amp * k * cos(ph)) * visible;
#endif
    } else {
      visible = 0.0;
    }
    float dropped = (1.0 - visible) * amp * k;
    lostVariance += dropped * dropped * 0.5;
  }

  if (activeEnd < uResidualActiveCount) {
    float tailEnergy = max(
      uResidualTotalSlopeEnergy - uResidualWaveB[activeEnd].x,
      0.0
    );
    lostVariance += tailEnergy * uWaveAmp * uWaveAmp;
  }
#elif defined(OCEAN_PROFILE_RESIDUAL_BRANCHLESS)
  // Structural probe: identical arithmetic, zero control flow. Every early
  // continue and the phase branch below are per-pixel divergent in the
  // shipping loop (lodRadius and footprint vary per fragment), so this variant
  // evaluates every slot unconditionally and discards inactive contributions
  // through selects. Selects, not mask multiplies: a dead slot's smoothstep
  // can be NaN (degenerate fade edges), and NaN survives a multiply by zero
  // but not a select. Live slots run the exact shipping expressions in the
  // exact shipping order, so the output is bit-identical where it matters.
  for (int i = 0; i < NUM_RESIDUAL_WAVES; i++) {
    float k = uWaveA[i].w;
    float amp0 = uWaveA[i].z * uWaveAmp;
    float missing = smoothstep(uWaveB[i].z, uWaveB[i].w, lodRadius);
    bool slotLive = amp0 > 0.0 && missing >= 0.002;
    // max() guards the division for k == 0 slots; any live slot's k is far
    // above the epsilon, so the guard returns it bit-exactly.
    float wavelength = 6.2831853 / max(k, 1e-6);
    float amp = amp0 * missing;
    float visible = 1.0 - smoothstep(wavelength * 0.25, wavelength * 0.50, footprint);
    bool phaseLive = visible > 0.002 && k < uResidualMaxK;
    vec2 d = uWaveA[i].xy;
    float ph = k * dot(d, p) + uWaveB[i].y;
    gradient += (slotLive && phaseLive)
      ? d * (amp * k * cos(ph)) * visible
      : vec2(0.0);
    float visSel = phaseLive ? visible : 0.0;
    float dropped = (1.0 - visSel) * amp * k;
    lostVariance += slotLive ? dropped * dropped * 0.5 : 0.0;
  }
#elif defined(OCEAN_PROFILE_RESIDUAL_TEXTURE)
  // Structural probe: shipping control flow, texture-fetched parameters. See
  // the sampler declaration above.
  for (int i = 0; i < NUM_RESIDUAL_WAVES; i++) {
    vec4 wa = texelFetch(uWaveTexA, ivec2(i, 0), 0);
    float k = wa.w;
    float amp0 = wa.z * uWaveAmp;
    if (amp0 <= 0.0) continue;

    vec4 wb = texelFetch(uWaveTexB, ivec2(i, 0), 0);
    float missing = smoothstep(wb.z, wb.w, lodRadius);
    if (missing < 0.002) continue;

    float wavelength = 6.2831853 / k;
    float amp = amp0 * missing;
    float visible = 1.0 - smoothstep(wavelength * 0.25, wavelength * 0.50, footprint);
    if (visible > 0.002 && k < uResidualMaxK) {
#ifndef OCEAN_PROFILE_DISABLE_RESIDUAL_PHASE
      vec2 d = wa.xy;
      float ph = k * dot(d, p) + wb.y;
      gradient += d * (amp * k * cos(ph)) * visible;
#endif
    } else {
      visible = 0.0;
    }
    float dropped = (1.0 - visible) * amp * k;
    lostVariance += dropped * dropped * 0.5;
  }
#elif defined(OCEAN_PROFILE_RESIDUAL_ROLLED)
  // Structural probe: shipping body, dynamic loop bound. See the uniform
  // declaration above.
  for (int i = 0; i < uResidualSlotCount; i++) {
    float k = uWaveA[i].w;
    float amp0 = uWaveA[i].z * uWaveAmp;
    if (amp0 <= 0.0) continue;

    float missing = smoothstep(uWaveB[i].z, uWaveB[i].w, lodRadius);
    if (missing < 0.002) continue;

    float wavelength = 6.2831853 / k;
    float amp = amp0 * missing;
    float visible = 1.0 - smoothstep(wavelength * 0.25, wavelength * 0.50, footprint);
    if (visible > 0.002 && k < uResidualMaxK) {
#ifndef OCEAN_PROFILE_DISABLE_RESIDUAL_PHASE
      vec2 d = uWaveA[i].xy;
      float ph = k * dot(d, p) + uWaveB[i].y;
      gradient += d * (amp * k * cos(ph)) * visible;
#endif
    } else {
      visible = 0.0;
    }
    float dropped = (1.0 - visible) * amp * k;
    lostVariance += dropped * dropped * 0.5;
  }
#else
  for (int i = 0; i < NUM_RESIDUAL_WAVES; i++) {
    float k = uWaveA[i].w;
    float amp0 = uWaveA[i].z * uWaveAmp;
    if (amp0 <= 0.0) continue;

    float missing = smoothstep(uWaveB[i].z, uWaveB[i].w, lodRadius);
    if (missing < 0.002) continue;

    float wavelength = 6.2831853 / k;
    float amp = amp0 * missing;
    // Band-limit at Nyquist, not past it.
    //
    // This fade used to run out to 0.75 wavelengths of footprint, which is
    // 1.33 samples per wavelength — the far side of Nyquist, where a sinusoid
    // does not disappear but reappears as a low-frequency beat. Summed over the
    // several dozen components a sea state carries, that beat is the parallel
    // ridging that shows up in any view from altitude: corduroy, which is a
    // sampling artefact wearing the swell's clothes.
    //
    // Half a wavelength is exactly two samples, and starting at a quarter gives
    // the roughness term a full octave to take the energy over in. Nothing is
    // discarded — what the fade removes, lostVariance adds back as slope
    // variance below, which is the honest answer for structure the pixel cannot
    // resolve.
    float visible = 1.0 - smoothstep(wavelength * 0.25, wavelength * 0.50, footprint);

    // Only the long components are worth a sine per pixel. A short component
    // the geometry has dropped is one the pixel footprint has dropped too, so
    // its honest contribution is variance, not shape. Only the k comparison is
    // on a uniform: "visible" depends on the per-pixel footprint, so this
    // branch CAN diverge within a warp, as can the two continues above
    // (lodRadius is per-pixel too). The BRANCHLESS probe variant exists to
    // price that divergence.
    if (visible > 0.002 && k < uResidualMaxK) {
#ifndef OCEAN_PROFILE_DISABLE_RESIDUAL_PHASE
      vec2 d = uWaveA[i].xy;
      float ph = k * dot(d, p) + uWaveB[i].y;
      gradient += d * (amp * k * cos(ph)) * visible;
#endif
    } else {
      visible = 0.0;
    }
    float dropped = (1.0 - visible) * amp * k;
    lostVariance += dropped * dropped * 0.5;
  }
#endif
  return gradient;
}
`;
