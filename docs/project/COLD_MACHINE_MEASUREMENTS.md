# The cold-machine measurement pass

Every number this project has promised itself and never taken, collected so
they can be taken in one sitting instead of ten.

**Why they are all here and not in their own rounds.** Nine separate handovers
each end with a sentence like "unmeasured, and this session could not measure
it". They could not measure it for the same reason every time: the machine was
busy. A laptop running several agents is thermally throttled, and a throttled
GPU measures its own heat, not the code. So these numbers cannot be taken
opportunistically at the end of a round — they need a machine doing nothing
else, from cold.

## The method, which is not optional

Established by the shadow round and recorded at
`docs/graphics/SHADOW_ROUND_HANDOVER.md:222`:

- **Headless Chrome**, `--enable-gpu --use-angle=metal`. A visible window costs
  about 3× and invalidates the comparison. Never mix a visible and a headless
  run in one bracket.
- **Paired, adjacent, alternating A/B blocks** — never two long runs. The
  machine drifts; alternation is what makes the difference survive the drift.
- **Real GPU timing from `src/render/GpuProfiler.ts`** (`EXT_disjoint_timer_query_webgl2`,
  disjoint honoured). Do not use `gl.finish()` — it does not do what it claims
  in the browser pane, and several existing "measurements" that relied on it
  should be treated as unverified.
- **1280×720 at DPR 2, with the 2560×1440 backing store asserted.** The
  browser pane is 854 px wide, which trips `isSmallScreen` → the mobile quality
  tier (3 detail octaves rather than the desktop 5). A number read off a pane
  screenshot is from a different renderer than the one being judged.
- Report the spread, not just the mean. Several existing brackets are quoted
  with bounds wider than the effect they claim to have found.

`tools/perf/README.md` has the harness; `npm run perf:preflight` checks the
machine is fit to measure before you start.

## The list

| # | The number | Where it was promised | Notes |
|---|---|---|---|
| 1 | Night below decks with lamp shadows on versus off | `docs/ship/SHIP_INTERIOR_HANDOVER.md` §20.8 | Worst case is five lit lamps × six cube faces = **30 shadow passes**, each redrawing the vessel's own geometry at 256×256. Scenarios, all at 22:00 production sea: cabin stand looking aft; wardroom stand with two lamps in frame; forecastle stand; plus one exterior deck frame as the control. **The harness cannot ask this question yet** — `tools/perf/suites.mjs` defines all three cameras as exterior orbital rigs, so a stand-based camera and a `lampsShadow` scenario option have to be added first. The URL passthrough already exists (`lamps`, `lampsShadow`). Shadows currently ship **on**, on an unmeasured cost. |
| 2 | The star field and Milky Way | `docs/graphics/NIGHT_SKY_ROUND_REPORT.md:241` | |
| 3 | Deleting the ocean's 83k-vertex sun depth pass | `docs/graphics/SHADOW_ROUND_HANDOVER.md:279` | The claim that it is worth deleting is structural and unproven. `runDirectShadowBenchmark` already exists. |
| 4 | Re-run every shadow bracket | `docs/graphics/SHADOW_ROUND_HANDOVER.md:276` | Current bounds are non-resolvable: AO −0.146 ± 1.692 ms, soft shadows −0.903 ± 2.183 ms. Nothing firmer should be quoted until this is redone. |
| 5 | `detailOctaves: 5` on desktop | `docs/graphics/GRAPHICS_TODO.md:283` | Six octaves is the next step if five is cheap. |
| 6 | WK-R13 foam inject and advect | `docs/wake/WAKE_WATER_HANDOVER.md` | Texels went 98k → 344k, a 3.5× rise, explicitly never benchmarked. Suggested form: `npm run perf:revisions -- 3374a13 HEAD --suite representative --rounds 2 --strict-preflight`. |
| 7 | The cloud motion and cirrus round | `docs/clouds/CLOUD_MOTION_REPORT.md:191` | Only hash-count arithmetic exists (~2× on the weather map). |
| 8 | The colour pipeline's "the GPU draw is unchanged" | `docs/graphics/COLOUR_PIPELINE_HANDOVER.md:174` | Rests on the broken `gl.finish()` timing. Ash's ~40 ms frames remain unexplained; this is the thread to pull. |
| 9 | The scotopic night post pass | this session's night-visibility round | A full-screen pass costs a render target and a pass. Budget and switch are named in that round's handover. |
| 10 | The M6 sail cloth re-loft | this session's M6 round | The whole-rig re-loft measured 2.1 ms before the cloth; that is the figure the round moves. |
| 11 | **The open regression** | `docs/project/PERFORMANCE_REGRESSION_REPORT.md` | Master was +2.994 ms (+21.4%) against `38440b5`, attributed to the ocean-look shader (+1.178), the wake repair (+0.619) and camera composition (+0.350). The report's own data stops at 2026-08-09 and master has moved many merges since. The live 30 → 20 FPS drop is still unexplained, and items 8 and 11 are probably the same investigation. |

## One structural note

Item 1 is not blocked on a quiet machine — it is blocked on the harness, which
has no below-decks camera and no lamp switch in its scenario shape. That gap
can be closed at any time, on any machine, and should be, so the cold pass is
spent measuring rather than building.
