/**
 * Derive BETA_R_PROJ — the sky's in-scatter colour — from spectral physics
 * instead of by eye.
 *
 *   node tools/derive-sky-projection.mjs
 *
 * WHY THIS EXISTS
 *
 * A three-band renderer has one honest way to get the sky's hue right and one
 * dishonest one. The dishonest one is to scatter with the physical Rayleigh
 * coefficients sampled at three wavelengths and then bolt a saturation constant
 * on the end when the result comes out too cyan. The honest one is to notice
 * that a display primary is not a wavelength: the sRGB red primary is excited
 * by a broad band of the spectrum, and Rayleigh-scattered skylight — which is
 * broad — excites it far more than its value at 610 nm suggests.
 *
 * So the scattering coefficient that belongs in the numerator of an RGB sky is
 * the PROJECTION of the spectral coefficient onto the display primaries through
 * the CIE colour-matching functions, and it is a different vector from the
 * band-sampled extinction coefficient that belongs in the exponent. That is the
 * whole content of BETA_R_PROJ, and it is derivable rather than tunable.
 *
 * METHOD
 *
 * For a grid of daytime (view elevation, sun elevation) pairs, integrate the
 * single-scattered Rayleigh radiance spectrally at 5 nm from 390 to 760 nm,
 * project through the CIE 1931 2-degree observer to XYZ, convert to linear
 * sRGB, and least-squares fit the three-band model's BETA_R_PROJ to reproduce
 * it. Conditions are weighted by their own luminance, so the fit serves the
 * bright sky you actually look at rather than averaging it against dim corners.
 *
 * Normalised so the green component equals the physical Rayleigh coefficient at
 * 550 nm: this fixes only the HUE, and leaves absolute brightness where it
 * belongs, under SKY_GAIN and the solar power.
 */

const LAMBDA_MIN = 390;
const LAMBDA_MAX = 760;
const LAMBDA_STEP = 5;

/** The renderer's three-band extinction, per air mass. Must match GLSL_SKY. */
const BETA_R_BANDS = [0.0403, 0.0977, 0.2334];
const BETA_M_TOTAL = { value: 0.057 + 0.0075 }; // Mie scatter + absorption
const BETA_E_BANDS = BETA_R_BANDS.map((b) => b + BETA_M_TOTAL.value);

/**
 * CIE 1931 2-degree colour-matching functions, multi-lobe Gaussian fit
 * (Wyman, Sloan & Shirley, JCGT 2013). Within ~1% of the tabulated data, which
 * is far inside the uncertainty of everything else here.
 */
function gaussian(x, mu, sigmaLow, sigmaHigh) {
  const s = x < mu ? sigmaLow : sigmaHigh;
  const t = (x - mu) / s;
  return Math.exp(-0.5 * t * t);
}
const xBar = (l) =>
  1.056 * gaussian(l, 599.8, 37.9, 31.0) +
  0.362 * gaussian(l, 442.0, 16.0, 26.7) -
  0.065 * gaussian(l, 501.1, 20.4, 26.2);
const yBar = (l) =>
  0.821 * gaussian(l, 568.8, 46.9, 40.5) +
  0.286 * gaussian(l, 530.9, 16.3, 31.1);
const zBar = (l) =>
  1.217 * gaussian(l, 437.0, 11.8, 36.0) +
  0.681 * gaussian(l, 459.0, 26.0, 13.8);

/** CIE XYZ (D65) to linear sRGB. */
function xyzToLinearSrgb(X, Y, Z) {
  return [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.204 * Y + 1.057 * Z,
  ];
}

/**
 * Rayleigh optical depth per air mass at wavelength l (nm), normalised to the
 * standard sea-level value 0.0973 at 550 nm. Exponent -4.05 rather than -4
 * absorbs the dispersion of air's refractive index and the King depolarisation
 * factor across the visible; the two together are a ~1% correction to the shape.
 */
const rayleigh = (l) => 0.0973 * Math.pow(550 / l, 4.05);

/**
 * Ozone, Chappuis band, per air mass for a 300 DU column. A real sky is
 * noticeably bluer than pure Rayleigh predicts and this is why: the Chappuis
 * band eats orange out of the long path near the horizon. Two Gaussians fitted
 * to the band's shape (peak near 602 nm, a shoulder toward 575), scaled so the
 * 550/600/450 nm values land on the renderer's existing three-band BETA_O3.
 */
const ozone = (l) =>
  0.0323 * gaussian(l, 602, 70, 82) + 0.0088 * gaussian(l, 545, 45, 40);

/** Top-of-atmosphere solar spectrum: 5778 K blackbody, arbitrary scale. */
function solar(l) {
  const lm = l * 1e-9;
  const c1 = 3.7418e-16;
  const c2 = 1.4388e-2;
  return c1 / (Math.pow(lm, 5) * (Math.exp(c2 / (lm * 5778)) - 1));
}

/** Kasten-Young-like relative air mass, matching airMass() in GLSL_SKY. */
function airMass(cosZenith) {
  const c = Math.max(cosZenith, 0);
  return 1 / (c + 0.025 * Math.exp(-11 * c));
}

/** Effective view-path air mass, matching AM_VIEW_CAP in GLSL_SKY. */
const AM_VIEW_CAP = 13.0;
function viewAirMass(sinElev) {
  const am = airMass(sinElev);
  return am / (1 + am / AM_VIEW_CAP);
}

const lambdas = [];
for (let l = LAMBDA_MIN; l <= LAMBDA_MAX; l += LAMBDA_STEP) lambdas.push(l);

// Normalise the CMF integral so a flat spectrum renders neutral, which keeps
// the derived numbers in the same units as the band-sampled ones.
const yNorm = lambdas.reduce((a, l) => a + yBar(l), 0) * LAMBDA_STEP;

/**
 * Spectral single-scattered radiance for one geometry, in linear sRGB.
 *
 * Mirrors the three-band model term for term — same air-mass functions, same
 * (1 - Tview) * Tsun saturation structure — so that the only thing the fit is
 * absorbing is the spectral projection itself, not a difference in geometry.
 */
function spectralSky(viewSinElev, sunSinElev) {
  const amView = viewAirMass(viewSinElev);
  const amSun = airMass(sunSinElev);
  let X = 0;
  let Y = 0;
  let Z = 0;
  for (const l of lambdas) {
    const betaR = rayleigh(l);
    const betaE = betaR + BETA_M_TOTAL.value + ozone(l);
    const tView = Math.exp(-betaE * amView);
    const tSun = Math.exp(-betaE * amSun - ozone(l) * amSun);
    // scat/betaE * (1 - Tview) * Tsun — the model's own bracket, spectrally.
    const radiance = ((betaR / betaE) * (1 - tView) * tSun) * solar(l);
    X += radiance * xBar(l);
    Y += radiance * yBar(l);
    Z += radiance * zBar(l);
  }
  const k = LAMBDA_STEP / yNorm;
  return xyzToLinearSrgb(X * k, Y * k, Z * k);
}

/** The three-band model's per-channel bracket, with BETA_R_PROJ factored out. */
function bandBracket(viewSinElev, sunSinElev) {
  const amView = viewAirMass(viewSinElev);
  const amSun = airMass(sunSinElev);
  return BETA_E_BANDS.map((be) => {
    const tView = Math.exp(-be * amView);
    const tSun = Math.exp(-be * amSun);
    return ((1 - tView) * tSun) / be;
  });
}

// --- fit -------------------------------------------------------------------

const num = [0, 0, 0];
const den = [0, 0, 0];
const rows = [];

for (let viewDeg = 2; viewDeg <= 90; viewDeg += 2) {
  for (let sunDeg = 10; sunDeg <= 80; sunDeg += 5) {
    const vs = Math.sin((viewDeg * Math.PI) / 180);
    const ss = Math.sin((sunDeg * Math.PI) / 180);
    const truth = spectralSky(vs, ss);
    const bracket = bandBracket(vs, ss);
    const lum = 0.2126 * truth[0] + 0.7152 * truth[1] + 0.0722 * truth[2];
    if (lum <= 0) continue;
    // Luminance weighting: fit the sky you look at, not the dim corners.
    const w = lum;
    for (let c = 0; c < 3; c++) {
      num[c] += w * bracket[c] * truth[c];
      den[c] += w * bracket[c] * bracket[c];
    }
    if (sunDeg === 60 && viewDeg % 20 === 2) rows.push({ viewDeg, sunDeg, truth });
  }
}

// --- validation ------------------------------------------------------------
//
// The check that matters: a clear zenith sky has a published CIE chromaticity
// close to x 0.25, y 0.25. If the derived projection does not land there, the
// derivation is wrong and no amount of downstream tuning will rescue the hue.
function chromaticity(rgb) {
  const [r, g, b] = rgb;
  const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const s = X + Y + Z;
  return [X / s, Y / s];
}

const raw = num.map((n, c) => n / den[c]);
// Normalise to the physical Rayleigh coefficient at 550 nm, so this vector
// carries hue only and brightness stays under SKY_GAIN / uSunPower.
const scale = BETA_R_BANDS[1] / raw[1];
const proj = raw.map((v) => v * scale);

const CURRENT = [0.076, 0.0977, 0.42];
const fmt = (v) => v.map((x) => x.toFixed(4)).join(', ');
const ratios = (v) => v.map((x) => (x / v[2]).toFixed(3)).join(' : ');

const zen = chromaticity(spectralSky(1, Math.sin((60 * Math.PI) / 180)));
console.log('Validation: derived zenith CIE chromaticity  x %s  y %s', zen[0].toFixed(3), zen[1].toFixed(3));
console.log('            published clear zenith sky       x ~0.25  y ~0.25');
console.log('');
console.log('BETA_R_PROJ');
console.log('  physical band samples : ' + fmt(BETA_R_BANDS) + '   ratios ' + ratios(BETA_R_BANDS));
console.log('  hand-tuned (current)  : ' + fmt(CURRENT) + '   ratios ' + ratios(CURRENT) + '   -> ' + chromaticity(CURRENT).map((v) => v.toFixed(3)).join(', '));
console.log('  spectrally derived    : ' + fmt(proj) + '   ratios ' + ratios(proj));
console.log('');
console.log('Spectral truth, sun 60 deg (linear sRGB, chromaticity only):');
for (const r of rows) {
  const m = Math.max(...r.truth);
  console.log(
    `  view ${String(r.viewDeg).padStart(2)} deg  ` +
      r.truth.map((x) => (x / m).toFixed(3)).join('  '),
  );
}

// --- horizon profile --------------------------------------------------------
//
// How a real sky brightens and pales toward the horizon, against what the
// renderer's compressed view path does. The renderer caps the view-path air
// mass (AM_VIEW_CAP) because the flat-slab air mass runs to ~38 at the horizon
// and would paint the whole lower sky white. The question this answers is
// whether the cap is set where the real curve is, or well above it.
console.log('');
console.log('Horizon profile at sun 45 deg — luminance relative to zenith, and saturation');
console.log('  elev    TRUE(am uncapped)      MODEL(am capped at ' + AM_VIEW_CAP + ')');
console.log('          lum/zen   sat          lum/zen   sat');

function profile(sinElev, capped) {
  const amView = capped ? viewAirMass(sinElev) : airMass(sinElev);
  const amSun = airMass(Math.sin((45 * Math.PI) / 180));
  let X = 0, Y = 0, Z = 0;
  for (const l of lambdas) {
    const betaR = rayleigh(l);
    const betaE = betaR + BETA_M_TOTAL.value + ozone(l);
    const rad = (betaR / betaE) * (1 - Math.exp(-betaE * amView))
              * Math.exp(-betaE * amSun - ozone(l) * amSun) * solar(l);
    X += rad * xBar(l); Y += rad * yBar(l); Z += rad * zBar(l);
  }
  const k = LAMBDA_STEP / yNorm;
  const rgb = xyzToLinearSrgb(X * k, Y * k, Z * k);
  const mx = Math.max(...rgb), mn = Math.min(...rgb);
  return { lum: Y * k, sat: (mx - mn) / mx };
}

const zenTrue = profile(1, false);
const zenModel = profile(1, true);
for (const e of [1, 2, 4, 7, 10, 15, 20, 30, 45, 70, 90]) {
  const s = Math.sin((e * Math.PI) / 180);
  const t = profile(s, false);
  const m = profile(s, true);
  console.log(
    `  ${String(e).padStart(3)}deg   ${(t.lum / zenTrue.lum).toFixed(2).padStart(5)}   ${t.sat.toFixed(3)}` +
    `        ${(m.lum / zenModel.lum).toFixed(2).padStart(5)}   ${m.sat.toFixed(3)}`,
  );
}
