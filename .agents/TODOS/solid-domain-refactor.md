# SOLID Domain Refactor TODO

Status: active during current refactor slice.

## Root coordination

- [ ] Commit archived TODO deletion and this work package as the baseline boundary.
- [ ] Keep domain workers from editing overlapping files.
- [ ] Sequence shared contract changes and regenerate generated artifacts when needed.
- [ ] Run integration review after Tauri, Angular, and Python worker output lands.
- [ ] Update this TODO and `.agents/SPECS/solid-domain-refactor.md` with final QA evidence.
- [ ] Create final refactor commit.

## Tauri domain

- [ ] Split `apps/exam-prep-desktop/src-tauri/src/lib.rs` into focused modules for app wiring, backend lifecycle, runtime installation, manifest/artifact verification, archive/download helpers, Windows process helpers, and Tauri commands.
- [ ] Add Rust doc comments for public structs/commands, process-tree cleanup, and manifest verification.
- [ ] Keep package QA/runtime install behavior intact or update all consumers in the same slice.
- [ ] Add or adjust Rust tests for backend config serialization, process-tree command args, manifest/artifact verification, and runtime install state transitions.

## Angular domain

- [ ] Split health snapshot loading, runtime job polling, runtime requirement derivation, chip/view-model mapping, and drawer presentation.
- [ ] Extract large inline template or repeated label/severity decisions into small presentational components or pure helpers.
- [ ] Add TSDoc for exported view-model types, non-obvious computed state, and polling lifecycle.
- [ ] Update component/store specs for partial health success, install/download polling, drawer/chip view models, and restart project selection where affected.

## Python domain

- [ ] Split source document repository read/write/progress/chunk mapping/classification responsibilities.
- [ ] Split runtime installation manager, installers, manifests, archive helpers, and process helpers.
- [ ] Split mock exam provider into Ollama transport/model health, deterministic parser, reasoning JSON parser/validator, dedupe/normalization.
- [ ] Add docstrings for public domain classes/functions, provider protocols, and non-trivial parsing/validation helpers.
- [ ] Update backend tests for document progress/chunk ordering, runtime requirements/installers, deterministic draft generation, and reasoning parser failure paths where affected.

## Non-goals

- [ ] Do not implement OCR health fixes, first chunk latency fixes, worker-count performance changes, or reasoning bakeoff feature work in this slice.
