# Cross-revision GPU benchmark

This harness compares archived revisions without checking them out in the
active worktree. It launches each revision through Vite, overlays the same
browser-side harness, and drives a real Chrome process with:

```text
--headless=new --enable-gpu --use-angle=metal --window-size=1600,1000
```

The 1600×1000 bootstrap window is intentional. Revisions before the explicit
`quality=desktop` query override choose their ocean tier while the module is
loading. A 1280×720 Chrome *outer* window has only about 633 CSS pixels of
content height and silently selects the mobile 160×160 ocean grid. After
bootstrap, the harness still pins the measured renderer to 1280×720 at DPR 2.
Every accepted run must report both the exact 2560×1440 backing store and at
least 100,000 ocean triangles (the expected desktop grid has 165,888).

The measurement contract follows
`docs/ocean/OCEAN_PERF_HANDOVER.md`:

- renderer size 1280×720 at DPR 2;
- verified 2560×1440 WebGL backing store;
- canonical world time paused at explicit day, sunset, and night instants;
- explicit sea-state and camera coordinates;
- warm cloud generations and shader programs before samples;
- presentation state frozen during samples;
- synchronous render batches bracketed by `readPixels` GPU fences;
- `PIXEL_PACK_BUFFER` explicitly unbound before each fence so newer async
  world-lighting readbacks cannot silently redirect the synchronous read;
- no use of `gl.finish()`;
- adjacent, alternating enabled/disabled pairs for ocean and vessel attribution.

Vessel attribution is recorded three ways: its net full-scene delta, its delta
with the ocean hidden, and a vessel-and-lights-only scene. The last removes both
ocean and sky occlusion and is the preferred direct vessel draw-time estimate.

The timings are GPU-fenced wall time. They intentionally include CPU render
submission, but the terminal `readPixels` prevents queued GPU work from being
mistaken for a fast frame. Ocean and vessel numbers are paired full-frame
deltas, not direct timer queries, because direct queries around small draws can
flush tile work on Apple GPUs and over-attribute the pass.

## Before the machine is clear

Validate the tooling and inspect the planned matrix without launching Chrome:

```bash
npm run perf:tooling:test
npm run perf:revisions -- 513fe5a HEAD --suite representative --dry-run
npm run perf:dashboard -- --check
```

Install dependencies once if this worktree has no `node_modules`:

```bash
npm ci
```

## GPU preflight

```bash
npm run perf:preflight
```

This is read-only. It lists likely browser, game, and Vite competitors and
returns exit status 2 when it finds any. It never kills processes. The actual
runner records the same inventory in every result. Add `--strict-preflight` to
refuse to start until the inventory is empty.

## Thermal telemetry

Every benchmark run automatically records a one-second timeline from macOS
`ProcessInfo.thermalState`. Each sample includes the public thermal-pressure
state (`nominal`, `fair`, `serious`, or `critical`), Low Power Mode, and the
active processor count. The dashboard shows the maximum state and warns when a
dataset reaches elevated pressure or uses Low Power Mode.

This public API does not expose a raw temperature or say that a particular GPU
frame was throttled. A `nominal` timeline is therefore useful evidence, but it
does not rule out clock, power, or workload changes. Large repeated-round drift
still invalidates an absolute comparison even when the public state stays
nominal.

For a cold-data campaign, make the runner preserve the first affected result
and stop before collecting more pressure-affected rounds:

```bash
npm run perf:revisions -- 38440b5 HEAD --suite smoke --rounds 4 \
  --require-nominal-thermal --settle-seconds 10
```

The policy refuses to start with an unavailable or elevated public state or
with Low Power Mode enabled. It also stops immediately after saving a run whose
one-second timeline first leaves `nominal`.
`--settle-seconds` adds a quiet interval before every preflight so terminal and
dashboard activity can subside; it does not claim that the chassis has reached
a particular physical temperature.

For a deeper macOS trace, pre-authorize sudo in your own terminal and opt in to
`powermetrics`:

```bash
sudo -v
npm run perf:revisions -- 38440b5 HEAD --suite smoke --rounds 2 --powermetrics
```

The runner itself remains unprivileged and uses `sudo -n` only for
`powermetrics`. It writes a timestamped text sidecar containing the supported
thermal-pressure, scheduling/frequency, CPU/GPU power, and power-limit data.
On the M2 MacBook Air used for this dashboard, the supported public samplers do
not include raw SMC temperature sensors. If sudo has not been pre-authorized,
the benchmark continues with the public timeline and records why the deeper
capture was unavailable.

Convert a text sidecar, or just one ISO-timestamped interval from it, into a
machine-readable summary:

```bash
node tools/perf/summarize-powermetrics.mjs perf-results/<capture>.txt
node tools/perf/summarize-powermetrics.mjs perf-results/<capture>.txt \
  --from 2026-08-10T01:17:00Z --to 2026-08-10T01:21:30Z --samples
```

## Endpoint run

Start the dashboard in one terminal:

```bash
npm run perf:dashboard
```

Then run the cloud-cache baseline and current revision:

```bash
npm run perf:revisions -- 513fe5a HEAD --suite representative --rounds 2 --strict-preflight
```

Ad-hoc runs receive a unique timestamped dashboard dataset. Give a comparison a
stable name when it should be easy to reopen:

```bash
npm run perf:revisions -- 293e66f ee69193 --suite smoke --rounds 4 --dataset bracket-ocean-look
```

The second round reverses revision order, reducing the chance that a thermal
trend is misread as a commit regression. Results appear in `perf-results/` and
the dashboard at `http://127.0.0.1:4180/` polls for new files every two seconds.

To share the dashboard on the local network, bind it explicitly:

```bash
npm run perf:dashboard -- --host 0.0.0.0 --port 4180
```

Then open `http://<machine-lan-ip>:4180/`. The server does not provide
authentication, so use this only on a trusted LAN.

## Filling the history

Run every ancestry-path commit only after the endpoints establish the scale:

```bash
npm run perf:revisions -- --range 513fe5a..HEAD --suite historical --rounds 2 --strict-preflight
```

For faster bisection, pass any selected hashes as positional arguments. Useful
suites are:

- `smoke`: one day/production/medium scenario with attribution;
- `historical`: day, sunset, and night at production sea and medium camera;
- `representative`: historical plus calm, rough, close, and maximum-high views;
- `full`: all 27 time × sea × camera combinations.

## Named unattended campaigns

Long, repeatable matrices live in `campaigns.mjs`, so collection is one command
rather than an error-prone list of hashes. The Southern Ocean afternoon history
runs 28 feature boundaries twice in alternating order:

```bash
npm run perf:campaign:southern-afternoon
```

It fixes canonical local time at mid-afternoon on the canonical summer date,
uses `SOUTHERN_OCEAN_ROUGH` and the medium camera, and writes each completed
revision directly to the dashboard's normal `perf-results/` feed.

The default one-pixel readback matches the documented working method. A more
expensive whole-buffer fence is available as a consistency check:

```bash
npm run perf:revisions -- 513fe5a HEAD --suite smoke --fence full-frame
```

Use the same fence method for all numbers in one comparison. The dashboard
warns if results mix GPU identity, backing-store size, or fence method.

## Refreshing current master

The last historical dashboard ended at `38440b5`. Once the GPU is clear,
first re-run the two old anchors and current master across all representative
scenes:

```bash
npm run perf:campaign:rebaseline -- --strict-preflight
```

If the old anchors reproduce within normal run-to-run variance, fill every
first-parent master commit since that endpoint with the smoke scenario:

```bash
npm run perf:campaign:master-history -- --strict-preflight
```

This deliberately follows the first-parent masterline. If a merge boundary is
the regression, run the implicated merge's feature-branch commits separately
with positional revisions or `--range` to localise the exact internal change.

The 2026-08-09 55-revision campaign demonstrated severe time-dependent host
drift: the same old endpoint rose from 14.05 ms at the start to 20.31 ms at the
end of one uninterrupted 22-minute sweep. Thermal or power management was a
plausible cause, not a directly measured fact in that dataset. Treat a long
sweep as a candidate finder, watch the dashboard's repeated-round-spread and
thermal warnings, and establish causality with cooled short alternating A/B
brackets. For publishable full history, split the range into cooled chunks with
overlapping anchor revisions.

## Retaining and labelling raw results

Raw results remain local under `perf-results/`, which is ignored entirely:
each file records the capturing machine's hostname and a process listing. The
summaries a report depends on are copied to `evidence/performance/` instead.
To label recovered files that predate runner dataset metadata:

```bash
node tools/perf/label-results.mjs --dataset recovered-run \
  --from 2026-08-09T13-33 --before 2026-08-09T13-37
```

The bounds compare lexically against the ISO-timestamped filenames. Labelling
rewrites only `runner.dataset`; it does not alter measurements.
