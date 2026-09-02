# Wake-water GPU performance · 2026-08-07

Status: **WK0 baseline captured; strengthened WK1 and incremental WK2 budget
gates passed.** Accepted measurements use real GPU timer queries in headless
Chrome, not the in-app browser or CPU submission time.

## Method

- Apple M2 through `ANGLE Metal`; Google Chrome `151.0.7922.76`.
- Chrome flags: `--headless=new --enable-gpu --use-angle=metal`.
- Window `2560×1527`, which the report verified as a **2560×1440** drawing
  buffer at DPR 1.00. An initial 1280×633 viewport attempt was rejected and
  overwritten before any number was accepted.
- Every report records the GPU, buffer, DPR and paired design in its body.
- WK0 ran from a detached temporary worktree at exact commit `80a1c2f`.
- WK1 effect content was commit `c54c573`; the only additional source present
  was the unattended benchmark route recorded with these results.
- Final wake code is `6e2fc19`, after merging master at `af2b7bd`. WK1 holds
  every WK2 toggle off; WK2 keeps the master and WK1 on and toggles only its
  collar, wet hull and mound.

The absolute baseline route is the repository's existing interleaved hull-AO
bracket. Its master-off arm is used only as a complete-frame reference; its AO
delta is unrelated to the wake project.

## Results

| Run | Complete GPU frame | Interpretation |
|---|---:|---|
| WK0 `80a1c2f`, pre-effects | 37.60 ± 5.63 ms | Exact-commit absolute baseline, Southern rough close view, n=128 off samples. |
| WK1 `c54c573`, wake master default-off | 38.07 ± 5.05 ms | Same absolute-baseline route. The +0.47 ms cross-run difference is not paired and must not be attributed to WK1. |
| WK1 moderate polar reach, 28 s trail | paired mean +1.750 ± 1.198 ms SE; median +0.507 ms | 24 adjacent off/on pairs. Mean is below 2 SE from zero and pair range is −7.347…+24.282 ms: the 0.6 ms gate is **not resolved**. |
| WK1 strengthened rerun, WK2 held off | paired mean +0.031 ± 0.005 ms SE; median +0.030 ms | 24 pairs × 16 rotations; 95% upper 0.042 ms. **PASS ≤0.6 ms.** |
| WK2 bounded repeat, WK1 retained | paired mean +0.128 ± 0.024 ms SE; median +0.101 ms | 24 pairs × 16 rotations; 95% upper 0.176 ms. **PASS ≤0.2 ms.** |

The wake run's derived ocean-prefix result was +2.313 ± 1.104 ms SE, median
+1.313 ms. It is a cautionary cross-check, not a substitute for the whole-frame
query: repository profiling notes already establish that adjacent prefix
subtraction is noisier on the tile renderer. The foam prefix read exactly zero
and is likewise not independently interpretable; the full-frame query remains
the acceptance instrument.

The original WK1 run does **not** retrospectively become a pass: its correct
verdict remains inconclusive. The strengthened rerun resolves the gate with
four times as many raw rotations per leg and explicitly holds WK2 off, yielding
a complete-frame 95% upper estimate of 0.042 ms.

The committed benchmark now collects 16 raw six-frame rotations per leg
instead of the first run's 4. It also calls pass/fail only when the two-standard-
error interval lies wholly below or above the budget; otherwise it reports
inconclusive.

WK2's first two post-merge runs were likewise reported as inconclusive rather
than rescued by their ~0.06 ms medians: isolated slow legs widened the
two-standard-error interval across the 0.2 ms boundary. They prompted spatial
bounds around the collar loop and mound exponential. The first bounded run was
still inconclusive after one 1.628 ms leg; the unchanged bounded repeat passed
without trimming or excluding a sample. All four reports are retained below.

The `?perf=wake-trail` and `?perf=wake-bow` routes remain for reproducible
measurement only. Normal gameplay now enables the combined wake by default;
the Debug Tools “Wake effects master” checkbox is the off switch.

## Raw artefacts

- `wk0-80a1c2f/vessel-ao-cost-dpr-1p00.txt`
  SHA-256 `d79ebe3a215cdfbad21569c2e9b6c61d8a7ed1102745de5e3260ad344ec00f3a`
- `wk1-c54c573/vessel-ao-cost-dpr-1p00.txt`
  SHA-256 `23ee847c4606c26e9ae5a3eeecaa2303249660b5211974882af583b4aae63b5b`
- `wk1-c54c573/wake-trail-cost-2560x1440.txt`
  SHA-256 `25f11a70318c91ad6753f78f37d5146c2f3a9a0f2d27443754b0336725458bcf`
- `wk2-af2b7bd-prebounds/wake-bow-cost-run1-2560x1440.txt`
  SHA-256 `dcfa2c037e08750af8590d402625236a0a6a13dfae3345361c8c202d78fab402`
- `wk2-af2b7bd-prebounds/wake-bow-cost-run2-2560x1440.txt`
  SHA-256 `4e17cb16698476c6c035f4ce98031b51d8886a34972a037f517a6448419b2fc6`
- `wk2-6e2fc19/wake-bow-cost-run1-inconclusive-2560x1440.txt`
  SHA-256 `8f197d6433872f6b45d793ccd05269e3e42aebdba65afdab6f490d13e7d9d354`
- `wk2-6e2fc19/wake-bow-cost-2560x1440.txt`
  SHA-256 `3f82adb33851827fe5f1ea2972987c8c1ed1885bf359ef1d79b1f7304c0e3bb8`
- `wk2-6e2fc19/wake-trail-cost-2560x1440.txt`
  SHA-256 `c6c66d89137a00efd78ccb4572ae26d875b3ed1a3d788b7cfa78ac41fb465ca2`
