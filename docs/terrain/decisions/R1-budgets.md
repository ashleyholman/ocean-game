---
title: R1 terrain budgets (TERR-006)
status: Baseline-backed — depth candidate charged 2026-08-07; re-base only if a §4 trigger fires
based_on: evidence/terrain/baseline/performance.json
depth_evidence: evidence/terrain/depth-candidates/performance.json
superseded_input: evidence/terrain/baseline/performance-contended-2026-08-05.json
last_updated: 2026-08-07
---

# R1 terrain budgets

## 1. Baseline the budgets stand on

Uncontended headless capture, 2026-08-06 (all competing renderers stopped):
Apple M2 via ANGLE Metal, 1600×913 buffer, DPR 1, OceanTemporalResolve off
(the production default — it is opt-in via `?oceanTaa=1`),
world/waves/foam/cloud-cache frozen during sampling. Presented cadence was a
locked 60 Hz (16.7 ms) in every view.

GPU frame medians (24 six-frame rotations per view):

| View | Frame median | σ | Ocean median |
|---|---:|---:|---:|
| Embodied forward · production · midday | 5.53 ms | 1.69 | 2.46 ms |
| Embodied toward low Sun · production | 6.27 ms | 2.05 | 3.39 ms |
| Default cinematic · production · midday | 6.59 ms | 1.90 | 4.10 ms |
| Default cinematic · rough · low Sun | 7.84 ms | 0.05 | 5.63 ms |
| Maximum cinematic · production · midday | 5.61 ms | 1.10 | 4.27 ms |
| Maximum cinematic · rough · low Sun | 8.21 ms | 0.03 | 6.20 ms |

Cross-checks that make this trustworthy: the default-cinematic midday median
replicated the earlier contended run to 0.02 ms (6.59 vs 6.57); the two
contended-run embodied rows (9.6 and 17.7 ms) collapsed to 5.5 and 6.3 ms
once the machine was quiet, confirming they were contention, not cost; and
the rough-sea rows hold frame σ of 0.03–0.05 ms. The ocean pass is the
dominant single consumer everywhere (2.5–6.2 ms), and the embodied views are
the *cheapest*, not the dearest — deck and sky fill pixels that would
otherwise be expensive water.

Known accounting limits: the freeze protocol skips the foam simulation pass
(0 ms in all rows), equally in every view; and the derived per-pass tails
show occasional single-rotation negative minima (to −8 ms in
`sceneAndStars`, which inherits the noise of two prefix queries) while all
medians stay positive — quote medians, not minima.

## 2. R1 budgets

Budgets are *increments over this baseline measured with the same harness*,
not absolute frame targets, so they survive the DPR difference between this
1600×913 DPR-1 capture and production retina output.

| Budget | Value |
|---|---|
| Ordinary views (embodied, default cinematic): terrain + far-ocean GPU increment | ≤ 1.0 ms median; ≤ 0.3 ms of that for far ocean hidden below the horizon |
| Maximum cinematic: terrain + far-ocean GPU increment | ≤ 3.0 ms median (this view exists to show terrain and far sea) |
| Presented cadence | No view drops below the 60 Hz vsync cadence the baseline holds |
| Terrain draw calls (R1 synthetic scene) | ≤ 150 visible tile draws |
| Terrain GPU memory (R1 synthetic scene) | ≤ 128 MB resident |
| Main-thread cost of terrain per frame | ≤ 1.0 ms at the R1 tile counts |

Rationale: frame medians are 5.5–8.2 ms against a 16.7 ms vsync interval, so
8.5–11 ms of GPU headroom exists at this buffer size on this quiet machine,
shared with whatever the deck/graphics rounds add and eroded on retina
buffers. Terrain takes a minority slice of it in ordinary views; the maximum
cinematic view gets a separately measured, larger allowance per design
§10.2.

## 3. Depth-strategy charge (2026-08-07)

The quiet-GPU R1 comparison selected reversed-Z for the supported desktop path.
In the paired default-cinematic 21 km peak stress case, its complete-frame
terrain increment was **0.572 ± 0.065 ms SE** (32 paired observations), inside
the ≤1.0 ms ordinary-view budget and effectively identical to conventional
depth's 0.594 ± 0.097 ms. The six-view open-water matrix found no systematic
reversed-Z tax and every run retained 60 Hz presented cadence. The provisional
budget therefore does not need rebasing for the selected desktop path.

Log depth remains the extension-free fallback, but its paired increment was
**1.223 ± 0.102 ms SE**, above the ordinary-view budget; its measured penalty
against reversed-Z was 0.651 ± 0.121 ms SE. That fallback must recover cost,
reduce the stress composition, or receive an explicit platform-tier decision.
It is not waved through by the reversed-Z result.

## 4. Revision triggers

- Any change to production DPR policy or buffer size in the harness.
- A mobile/low-power tier baseline (deferred to the R1 lower-power capture)
  coming in materially different from a naive scaling of these numbers.
- OceanTemporalResolve default flipping on.
- R1 discovering the depth solution costs measurable GPU (e.g. log depth
  disabling early-z for the ocean) — that cost is charged against the terrain
  increment budget, not waved through.
