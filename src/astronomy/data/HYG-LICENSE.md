# HYG bright-star data licence

The generated `brightStars.generated.ts` file is a transformed subset of:

- HYG Database v4.1 by David Nash / Astronexus
- Source: <https://github.com/astronexus/HYG-Database>
- Source file: `hyg/CURRENT/hygdata_v41.csv`
- Source SHA-256:
  `d9f69fd86bbf90a4e4d52b4c5c53eacfa6dfc0bfdef85bfd94f095e0bebe4ebd`
- Filter: finite-distance records with visual magnitude ≤ 6.5
- Retained fields: J2000 right ascension, J2000 declination, visual magnitude,
  B−V colour index, and a display label (proper name or Bayer designation
  where the source has one, empty otherwise)

The HYG Database and this derived catalogue are licensed under the
[Creative Commons Attribution-ShareAlike 4.0 International
License](https://creativecommons.org/licenses/by-sa/4.0/).

The TypeScript loader and renderer are project code; this notice applies to the
generated catalogue data.
