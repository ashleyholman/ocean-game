# Visual reference notes — clear-sky atmosphere and ocean optics

Concise physical findings that drive the graphics round. These are
relationships, not art direction; the numbers cited are the ones the
implementation is calibrated against. Sources are standard, uncontroversial
references: Rayleigh/Mie scattering theory as presented in Preetham et al.
(1999) and Bruneton & Neyret (2008); Cox & Munk (1954) slope statistics;
Jerlov (1976) optical water types; Monahan & O'Muircheartaigh (1980) whitecap
coverage; Patat (2003) and Roach & Gordon (1973) for night-sky brightness;
Crumey (2014) for twilight limiting magnitude; Minnaert, *Light and Color in
the Outdoors* for qualitative phenomena.

## Clear-sky scattering

- Sea-level Rayleigh optical depths across one air mass are approximately
  0.059 (650 nm), 0.098 (550 nm), 0.23 (450 nm). Rayleigh alone produces a
  zenith-to-horizon gradient: the zenith is deep blue (small optical depth,
  single scattering dominates), the horizon whitens because the path
  saturates — multiple scattering fills every wavelength toward the
  illuminant colour.
- Maritime aerosol optical depth for *clear* ocean air is small: AOD ≈
  0.05–0.15 at 550 nm. Values above ~0.2 read as haze. The Mie phase
  function is strongly forward-peaked; a Henyey-Greenstein g of 0.76 puts
  half the scattered energy within ~25° of the sun. The circumsolar glow of
  a clear maritime sky is narrow and bright, not a 60°-wide white wash —
  a wide wash is the visual signature of turbid continental haze.
- Perceptually, a clear midday zenith has a luminance around 3–8 kcd/m²
  while the horizon sky is 2–4× brighter. The zenith-to-horizon *chroma*
  contrast (saturated blue up high, paler blue low) is what reads as
  "clear"; equalising luminance or chroma across the dome reads as overcast.
- The circumsolar region within a few degrees of the sun is effectively
  white at display brightness under any physically sane exposure — the art
  is keeping that white *local*.

## Twilight

- Civil (0 to −6°), nautical (−6 to −12°), astronomical (−12 to −18°)
  twilight. Zenith luminance falls roughly one decade per 5–6° of solar
  depression between 0° and −16°: about 10⁴ between sunset and the end of
  astronomical twilight. No real-time display can reproduce this range;
  a display-referred rendering keeps roughly 3–4 stops of it and lets
  exposure absorb the rest.
- Twilight sky colour is dominated by ozone Chappuis-band absorption
  (absorbs 500–700 nm): this is why the twilight zenith is blue rather than
  grey or brown. Any twilight model without an ozone-like term goes muddy.
- The bright segment stays on the sunward horizon and narrows as the sun
  descends; the anti-solar sky shows the Earth's shadow and the pink
  counter-glow (Belt of Venus) up to ~6° depression.

## Deep-ocean optics

- Pure/clear oceanic water (Jerlov type I) absorption: ~0.35 /m at 650 nm,
  ~0.05 /m at 550 nm, ~0.02 /m at 450 nm. Upwelling radiance from deep clear
  water is therefore strongly blue: the diffuse reflectance of Jerlov I
  water is ~2–5% in the blue, <0.5% in the red. Deep open-ocean water body
  colour at midday is cobalt/ultramarine, luminance a few percent of the
  sky's.
- The total albedo of the open sea at high sun is only ~6%: the ocean is
  *dark*. Most of what the eye receives from the sea surface at grazing
  angles is reflected sky (Fresnel: 2% at normal incidence, >30% beyond
  ~70°, →100% at grazing). At steep viewing angles the body colour
  dominates; the crossover is the visual structure of every open-ocean
  photograph: dark saturated blue below the camera, brightening and
  desaturating toward the horizon.
- Cox–Munk: mean-square sea-surface slope grows roughly linearly with wind,
  σ² ≈ 0.003 + 0.00512·U (U in m/s at 12.5 m). At 6 m/s σ² ≈ 0.034
  (σ ≈ 0.18). Sun-glitter width follows facet statistics: the glitter
  ellipse's angular half-width is a few σ. Glitter is *fragmented
  highlights*, not a filled band; its brightest facets clip to white while
  the water between stays blue.
- The reflected-sky term of a rough surface is *not* the horizon sky in
  every direction: the mean reflected ray still mirrors the geometric
  reflection direction; roughness widens the lobe (which mixes in sky from
  a cone around it) but the lobe centre moves with view and normal. Forcing
  the mean toward the horizon bleaches steep-view water with the bright
  horizon sky — the classic "metal sheet" failure.
- Whitecap albedo is high but not unity: fresh foam ~0.5–0.6 effective,
  decaying with age; foam is Lambertian-ish and slightly warm-neutral under
  direct sun. In daylight foam is clearly *brighter* than the surrounding
  water except inside the specular glitter path itself.
- Monahan whitecap coverage: W ≈ 3.84e-6 · U^3.41 (fraction). ~0.1% at
  6 m/s, ~1% at 12 m/s, ~4% at 20 m/s.

## Star visibility and twilight

- Naked-eye limiting magnitude under a dark clear sky is ~6.0–6.5. During
  twilight the limit falls with sky brightness; Crumey's fits give
  approximately: sun at −6° → limit ≈ 1–2 (only the brightest stars and
  planets); −9° → ≈ 3; −12° → ≈ 4.5; −15° → ≈ 5.5; −18° → full dark limit.
  The progression is continuous and monotonic in sky luminance, not in
  minutes-after-sunset.
- Atmospheric extinction near the horizon: ~0.2–0.3 mag/air-mass for a
  clear maritime site; a star at 5° altitude loses ~1.5–2 magnitudes and
  reddens. Stars should dim, never brighten, toward the horizon.
- Stars are true point sources: any perceived disc is instrument/eye
  diffraction. Rendered stars read "astronomical" when the core is at most
  ~1–2 device pixels with brightness carried by intensity, not by sprite
  diameter; magnitude → size growth must be strongly sublinear.

## Night sky and moonlight

- Moonless clear night sky (airglow + starlight + zodiacal light) is
  ~2–5×10⁻⁴ cd/m² — about seven decades below midday. Airglow makes the
  night sky slightly brighter 10–20° above the horizon than at the zenith.
- Full-moon illuminance is ~0.05–0.25 lx (sun: ~10⁵ lx): about 19 stops
  below sunlight. A moonlit scene rendered "visible" is a deliberate
  day-for-night exposure lie; the honest rendering keeps the moonlit scene
  2.5–4 stops above the moonless floor, never approaching twilight levels.
- Moonlight colour: the moon's spectrum is slightly redder than sunlight
  (albedo rises toward red), but *perceived* moonlight is blue-ish due to
  scotopic vision (Purkinje shift). Renderings read "moonlit" with a cool,
  slightly blue cast — a perceptual convention worth keeping restrained.
- Lunar phase: disc-integrated brightness is strongly non-linear in phase
  angle (opposition surge); a quarter moon is ~1/10 the brightness of full,
  not 1/2. Illuminated fraction from the astronomy library plus a steep
  brightness curve is a sufficient approximation.
- A clear-sky moon shows at most a narrow aureole (a few moon diameters)
  from aerosol forward scatter. The 22° halo belongs to cirrus ice crystals
  — a weather phenomenon, not a clear-sky default.

## Sunset light on objects

- Direct sunlight colour at the horizon after ~38 air masses of Rayleigh +
  aerosol extinction lands around colour temperature 1800–2500 K — deep
  orange to red, with intensity down ~3 stops from noon. Sun-facing
  surfaces at sunset are unmistakably warm; the shadowed sides fall to the
  cool ambient of the remaining blue sky. This warm/cool opposition — not a
  global orange grade — is the entire look of golden hour.
- Cloth transmission: thin woven cloth backlit by a low sun transmits a
  warm glow strongest where the weave is thin; the effect is bounded by the
  transmitted beam's own colour and never exceeds the direct-lit side.

## Exposure

- Human vision spans the day-night range through adaptation; film/display
  renderings conventionally hold midday at a fixed exposure and let
  twilight fall 2–4 stops before night settles at a floor 4–6 stops below
  midday, preserving shadow legibility rather than absolute ratios.
- Exposure must never create light: star visibility, lamp reach and moon
  glitter are source-side quantities; exposure only chooses which part of
  the scene's range the display window shows.
