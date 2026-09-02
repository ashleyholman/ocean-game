# Drift documentation

The repository root contains only the project `README.md`. Detailed design,
planning, implementation reports, and handovers live here, grouped by subject.
Paths cited inside source comments and documents are repository-relative (for
example, `docs/ocean/OCEAN_SEA_STATE_SPEC.md`).

## Project

- [Developer guide — run, build, test, evidence exporters, developer shell, source map](project/DEVELOPER_GUIDE.md)
- [Current runtime architecture](project/RUNTIME_ARCHITECTURE.md)
- [Scene inspection ray runbook](project/SCENE_INSPECTION_RAYS.md)
- [Historical architecture problem inventory](project/ARCHITECTURE_CONSOLIDATION_PROBLEM.md)
- [Asset and dependency credits](project/ASSET_CREDITS.md)
- [Completed and deferred rounds](project/FUTURE_ROUNDS.md)
- [The review queue — what is waiting on Ash's eye](project/REVIEW_QUEUE.md)
- [Handover: the parallel session of 2026-08-16/17](project/SESSION_HANDOVER_2026-08-17.md)
- [Continuous follow-up progress](project/CONTINUOUS_SESSION_PROGRESS_2026-08-17.md)
- [Cross-revision GPU performance report](project/PERFORMANCE_REGRESSION_REPORT.md)
- [The cold-machine measurement pass](project/COLD_MACHINE_MEASUREMENTS.md)
- [Test structure](project/TESTING.md)

## World model

- [Planetary world model](world/WORLD_MODEL.md)
- [Planetary simulation report](world/REPORT.md)
- [Planetary-world ADR](adr/ADR-002-planetary-world-model.md)

## Camera

- [Camera system](camera/CAMERA_SYSTEM.md)
- [Camera round report](camera/CAMERA_ROUND_REPORT.md)
- [Camera checkpoint handover](camera/CAMERA_HANDOVER.md)

## Audio

- [Sound round handover](audio/SOUND_ROUND_HANDOVER.md)

## Clouds

- [Cloud roadmap](clouds/CLOUDS_ROADMAP.md)
- [Cloud structure handover](clouds/CLOUD_STRUCTURE_HANDOVER.md)
- [Cloud motion report](clouds/CLOUD_MOTION_REPORT.md)
- [Cloud cache design](clouds/CLOUD_TILE_CACHE_DESIGN.md)
- [Cloud cache report](clouds/CLOUD_CACHE_REPORT.md)
- [Cloud-shape findings](clouds/CLOUD_SHAPE_FINDINGS.md)
- [Horizon cloud-band report](clouds/HORIZON_CLOUD_BAND_REPORT.md)

## Graphics and lighting

- [Graphics TODO](graphics/GRAPHICS_TODO.md)
- [Graphics round handover](graphics/GRAPHICS_ROUND_HANDOVER.md)
- [Visual lighting specification](graphics/VISUAL_LIGHTING_SPEC.md)
- [Visual reference notes](graphics/VISUAL_REFERENCE_NOTES.md)
- [World lighting design](graphics/WORLD_LIGHTING_DESIGN.md)
- [Colour pipeline handover](graphics/COLOUR_PIPELINE_HANDOVER.md)
- [Night visibility specification](graphics/NIGHT_VISIBILITY_SPEC.md)
- [Night-sky report](graphics/NIGHT_SKY_ROUND_REPORT.md)
- [Shadow round handover](graphics/SHADOW_ROUND_HANDOVER.md)
- [Agent-facing inspection tooling](graphics/AGENT_INSPECTION.md)

## Ocean and water coupling

- [Original ocean prototype specification](ocean/OCEAN_PROTOTYPE_SPEC.md)
- [Ocean architecture audit](ocean/OCEAN_ARCHITECTURE_AUDIT.md)
- [Sea-state specification](ocean/OCEAN_SEA_STATE_SPEC.md)
- [Sea-state implementation report](ocean/OCEAN_SEA_STATE_REPORT.md)
- [Ocean performance handover](ocean/OCEAN_PERF_HANDOVER.md)
- [Residual-wave performance handover](ocean/OCEAN_RESIDUAL_WAVE_PERF_HANDOVER.md)
- [Ocean composition report](ocean/OCEAN_COMPOSITION_REPORT.md)
- [Ocean-look handover](ocean/OCEAN_LOOK_ROUND_HANDOVER.md)
- [Crest-spray report](ocean/OCEAN_CREST_SPRAY_REPORT.md)
- [Whitewater registration report](ocean/OCEAN_WHITEWATER_REGISTRATION_REPORT.md)
- [Ocean self-shadow specification](ocean/OCEAN_SELF_SHADOW_SPEC.md)
- [Ocean violence rendering handover](ocean/OCEAN_VIOLENCE_RENDERING_HANDOVER.md)
- [Raft/water coupling specification](ocean/RAFT_WATER_COUPLING_SPEC.md)
- [Raft/water coupling report](ocean/RAFT_WATER_COUPLING_REPORT.md)
- [Interior cutout handover](ocean/OCEAN_INTERIOR_CUTOUT_HANDOVER.md)

## Ship and sailing

- [Canonical ship specification](ship/SHIP_SPEC.md)
- [Ship build handover](ship/SHIP_ROUND_HANDOVER.md)
- [Rig handover](ship/SHIP_RIG_HANDOVER.md)
- [Deck handover](ship/SHIP_DECK_HANDOVER.md)
- [Motion-physics handover](ship/SHIP_MOTION_PHYSICS_HANDOVER.md)
- [Wind-cues handover](ship/SHIP_WIND_CUES_HANDOVER.md)
- [Below-decks plan](ship/SHIP_BELOW_DECKS_PLAN.md)
- [Interior handover](ship/SHIP_INTERIOR_HANDOVER.md)
- [Captain's quarters handover](ship/CAPTAINS_QUARTERS_HANDOVER.md)
- [Captain's desk handover](ship/CAPTAINS_DESK_HANDOVER.md)
- [Furniture rotation handover](ship/FURNITURE_ROTATION_HANDOVER.md)
- [Night lighting handover](ship/NIGHT_LIGHTING_HANDOVER.md)
- [Sailing model design](sailing/SAILING_MODEL_DESIGN.md)
- [Sailing project plan](sailing/SAILING_PROJECT_PLAN.md)
- [Sailing handover log](sailing/SAILING_ROUND_HANDOVER.md)
- [S5 human-crew handover](sailing/SAILING_S5_HUMAN_CREW_HANDOVER.md)
- [Heading-hold bias report](sailing/DEFAULT_HEADING_HOLD_BIAS_REPORT.md)

## Wake and water effects

- [Wake/water design](wake/WAKE_WATER_DESIGN.md)
- [Wake/water project plan](wake/WAKE_WATER_PROJECT_PLAN.md)
- [Wake/water handover](wake/WAKE_WATER_HANDOVER.md)
- [Ship survivability roadmap](survival/SURVIVABILITY_PROJECT_PLAN.md)

## Terrain

- [Terrain system design](terrain/terrain-system-design.md)
- [Terrain project plan](terrain/terrain-project-plan.md)
- [Terrain technical guide](terrain/terrain-technical-guide.md)
- [Synthetic-spike specification](terrain/terrain-r1-synthetic-spike-spec.md)
- [Terrain round handover](terrain/TERRAIN_ROUND_HANDOVER.md)
- [R1 budgets](terrain/decisions/R1-budgets.md)
- [Depth-candidate verdict](terrain/decisions/depth-candidates.md)

## Provisions, pay and the crew's comforts

Concept documents, none of them accepted — see the review queue.

- [Provisioning concept](provisioning/PROVISIONING_CONCEPT.md)
- [Crew comforts concept](provisioning/CREW_COMFORTS_CONCEPT.md)
- [Pay and money concept](provisioning/PAY_AND_MONEY_CONCEPT.md)

## Historical material and prompts

- `archived/` preserves the initial goal and prompt.
- `archived/upcoming-prompts/` holds a few round prompts kept as they were
  written; most rounds were driven from the design and handover documents above.
