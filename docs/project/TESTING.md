# Test structure

The repository uses one Vitest project and keeps its tests under `tests/`.
The project has two execution layers:

1. The default suite is the everyday feedback loop. It contains every test
   that is not tagged `slow`.
2. The specialised suites contain long-running evidence builders, physical
   simulations and exhaustive geometry sweeps. They remain part of the full
   suite, but do not run through the default command.

This is a selection policy, not a difference in test quality. A specialised
test is still a required regression test.

## Commands

| Command | Selection | Intended use |
| --- | --- | --- |
| `npm test` | All tests except `slow` | Normal local and pull-request feedback |
| `npm run test:watch` | All tests except `slow`, in watch mode | Normal development loop |
| `npm run test:slow` | All `slow` tests | Run every specialised suite |
| `npm run test:slow:sailing` | `slow && sailing` | Sailing force, polar, steering and rudder simulations |
| `npm run test:slow:ship-physics` | `slow && ship-physics` | Hydrostatics, horizontal dynamics and wave-response simulations |
| `npm run test:slow:rig-geometry` | `slow && rig-geometry` | Rig-clearance and exhaustive deck-walkability sweeps |
| `npm run test:full` | Every test | Nightly, release and explicit full verification |
| `npm run test:watch:full` | Every test, in watch mode | Interactive work on a specialised test |

`tests/time-of-day.bench.ts` is a benchmark and is deliberately outside the
`tests/**/*.test.ts` include pattern. Run benchmarks with `vitest bench`; they
are not part of any test command above.

The `ship:*` and `wind:baseline` package scripts are evidence exporters. They
regenerate committed evidence artefacts and are not substitutes for the
specialised Vitest suites.

## Default-suite boundary

The default suite excludes individual slow tests rather than whole files. This
keeps cheap unit, contract and committed-evidence checks running even when they
share a file with a multi-minute simulation.

The initial boundary contains 24 runtime tests:

| File | Specialised tests | Domain |
| --- | ---: | --- |
| `ship-sailing-steering.test.ts` | 2 | `sailing` |
| `ship-sailing-aero.test.ts` | 2 | `sailing` |
| `ship-sailing-polar.test.ts` | 1 | `sailing` |
| `ship-sailing-rudder.test.ts` | 2 | `sailing` |
| `ship-hydrostatics.test.ts` | 4 | `ship-physics` |
| `ship-horizontal-dynamics.test.ts` | 3 | `ship-physics` |
| `ship-response.test.ts` | 3 | `ship-physics` |
| `ship-wind-cues.test.ts` | 6 | `rig-geometry` |
| `ship-deck.test.ts` | 1 | `rig-geometry` |

The source-level `tags` on tests are the authoritative inventory. Some
parameterised tests produce more than one runtime test, which is why counting
tag declarations is not sufficient.

## Why this boundary exists

A full-suite timing profile on 2026-08-06 ran 663 tests in 226 seconds. Only 24
tests took at least five seconds each, but together they consumed 724 of 816
summed test-worker seconds: 88.7% of the measured execution cost. They were
also a coherent set rather than arbitrary slow assertions:

- full sailing evidence and equilibrium solves;
- long-horizon hydrostatic, decay and wave-response integrations; and
- exhaustive wind-direction, collision and walkability sweeps.

The split therefore removes the main latency from the normal feedback loop
without dropping entire ship-related files. At the profiled revision, the
default selection retained 639 of 663 runtime tests. Unrelated tests can grow
that total without changing the 24-test specialised inventory above.

Timings vary with machine load. Five seconds was the measurement signal used
to review the initial candidates, not a rule that automatically makes any
future test specialised.

## Tag policy

Vitest's configured tags are:

- `slow`: excluded from the default suite;
- `sailing`: specialised sailing behaviour;
- `ship-physics`: specialised buoyancy and vessel-dynamics behaviour; and
- `rig-geometry`: specialised rig, collision and deck traversal behaviour.

Every `slow` test must also carry one domain tag. Domain tags currently mark
only specialised work; ordinary sailing or physics unit tests need no tag and
remain in the default suite.

Use `slow` when a test performs a full evidence build, a materially long
physical integration, or an exhaustive parameter/geometry sweep. Before
moving a test out of the default suite:

1. Measure it as part of a full run, not only in isolation.
2. Prefer retaining a cheap invariant, representative case or committed-data
   check in the default suite.
3. Confirm that the specialised suite has a clear trigger and owner domain.
4. Update the inventory above if the runtime-test count changes.

Do not use `slow` merely to hide an inefficient ordinary unit test. Profile or
fix that test instead.

## Suggested automation cadence

- Run `npm test` and `npm run typecheck` for every change.
- Run the relevant specialised suite when its domain changes.
- Run `npm run test:slow` or `npm run test:full` nightly.
- Run `npm run test:full` before a release or other integration milestone.

Shared vessel and ocean primitives can affect more than one domain. When in
doubt, run the full suite rather than relying on a narrow path filter.
