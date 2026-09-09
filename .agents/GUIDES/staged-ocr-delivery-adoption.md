# Capture Runtime Staged OCR Adoption

Cert Prep follows the producer repository's canonical
`staged-ocr-delivery-workflow` for design-first work, TDD, evidence, review,
commits, and release promotion. This document records the responsibilities
that belong to this consumer; it does not redefine the capture-runtime OCR
policy.

## Current Phase 2 checkpoint

Phase 1 is complete at the `local-probe` tier only. That evidence is not
published `capture-runtime` 0.4.2 evidence and does not prove installed formal
acceptance. The authoritative Phase 2 records are the [consumer specification](../SPECS/capture-runtime-consumer.md),
[decision](../DECISIONS/capture-runtime-consumer.md), and [consumer TODO](../TODOS/capture-runtime-consumer.md).
They define the first executable Nx `23.1.2` plus version-inventory slice,
which must be green before candidate staging.
CI repair is paused and has no authority over this checkpoint or its acceptance
record; a repair branch or CI result cannot establish publication, release, or
consumer-ownership status until the owning lane resumes.

Audio transcription/translation is a separate domain and acceptance lane. It is
not part of the OCR-only Phase 2 D4/D7 checklist.

## Phase 1: prove the consumer journey

Before implementation, write or update the local spec, decision, and task
breakdown. Review the design and its failure cases before writing feature code.
Split work into vertical slices with red tests, focused verification, and an
explicit rollback target. Close and commit each green slice with explicit paths;
do not accumulate unrelated changes in one worktree.

For the first real journey:

- Consume an immutable capture-runtime candidate and its generated contract,
  SDK, schema, and model identity. Frozen installs must reject sibling/local
  paths, direct URL metadata, and mixed runtime versions.
- Accept only the capture-runtime OCR projection for new imports. Persist the
  fixed OCR method (`windowsml_ocr`) and fail closed for new `embedded` or
  `mixed` extraction. Historical records may remain readable under their old
  method.
- Use the application journey and public capture contract, not a private OCR
  implementation or a test-only shortcut. Preserve page order, page status,
  text, confidence, boxes, failure evidence, and provenance.
- Run producer-owned real OCR acceptance only after the Capture Workbench app
  has passed. The required order is **Capture Workbench -> Cert Prep -> GX Law
  Prep**. Run
  model-enabled apps sequentially; after Capture Workbench, prove its owned
  processes/listeners and run-scoped residue are gone and model memory is
  released before starting Cert Prep.
- Use scanned PDF/JPEG truth fixtures with no text layer. Local package QA,
  fake OCR, snapshots, or a successful process exit are not real OCR proof.

The recorded Phase 1 result for Cert Prep is complete at `local-probe`: the
real local-package journey produced semantic OCR evidence with the tested
local candidate identity. This does not claim a published 0.4.2 artifact or
installed formal acceptance. Phase 2 begins with the version-first gate and
hardening slices below.

Consumer acceptance has two named events owned by each consumer. D4
`CandidateAccepted` runs the immutable candidate before publication; Cert
writes only its own candidate child ledger and hands it to the producer
publication lane. D7 `PublishedAccepted` repeats the same journey from D5/D6
published download-back bytes; Cert writes only its own published child ledger
and hands it to LAW. Cert never waits for LAW or aggregates consumer ledgers.
The producer alone aggregates all child ledgers and owns D8 stable-pointer
promotion. Cert never moves, mutates, or rolls back that producer pointer.

## Phase 2: consumer hardening

After Phase 1, adopt the producer's deep modules rather than growing local
policy:

- Keep the canonical OCR pipeline behind its small interface. Cert Prep owns
  durable source/domain persistence and presentation; it does not own runtime
  initialization, preprocessing, inference, OCR arbitration, or confidence
  semantics.
- Decode the exact generated producer `RuntimeReady`/`OcrComputePreflightV2`
  contract and display producer-owned notice truth. Retain/regenerate
  `libs/cert-prep-api/src/lib/cert-prep-api.generated.ts`; never hand-edit or
  delete that generated consumer view. Delete only host fallback DTOs,
  validators, mode/adapter/reason/notice matrices, and reason-to-copy mappings
  rather than copying producer GPU policy. Retain enough producer notice truth
  to tell the user when CPU fallback was selected because no dGPU/iGPU was
  usable.
- Use the producer-owned `OwnedRuntimeSession` seam for each active/candidate
  launch; it is not a current Cert symbol. Current Cert owners are
  `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/ocr_summary.py`
  (`build_ocr_summary`, `_map_provenance`),
  `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/mapping.py`
  (`_ocr_only_extraction_method`),
  `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/persistence.py`
  (`publish_capture_document`),
  `apps/cert-prep-backend/src/cert_prep_backend/domains/source_documents/operations.py`
  (`publish_success`, recovery),
  `apps/cert-prep-backend/src/cert_prep_backend/domains/mock_exams/draft_jobs.py`
  (job ordering), and desktop Rust
  `apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs`,
  `apps/cert-prep-desktop/src-tauri/src/manifests.rs`,
  `apps/cert-prep-desktop/src-tauri/src/capture_manifest.rs`, and
  `apps/cert-prep-desktop/src-tauri/src/process_owner.rs`.
  The producer engine `windowsml-ocr` maps to Cert's
  durable `windowsml_ocr`; embedded layers are ignored and new `embedded` or
  `mixed` writes are forbidden.
  A failed candidate cleanup must not destroy the active backend. Stop only
  app-owned runtime/model descendants; a baseline process that existed before
  launch must survive. Reconcile stale PID/listener/staging state safely at
  startup without broad process-name kills.
- Candidate/active promotion is the transaction
  `CandidateReady -> NewActiveCommitted -> PriorRetiredDraining ->
  RetiredProved`. The **proposed**
  `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs` module's
  `RuntimePromotionStore` and `RuntimePromotionReceiptV1` are the sole Cert
  owner of the local installed-runtime pointer/receipt; they are distinct from
  the producer session journal and D8 stable pointer. Verify the immutable
  candidate/root, flush `CandidateReady`, flush `commitIntent` with the
  expected prior pointer, lock/CAS and atomically replace/flush plus reread, flush
  irreversible `NewActiveCommitted`, persist `PriorRetiredDraining` before
  cleanup, obtain producer proof, then flush `RetiredProved` before optional
  exact prior-root deletion. Before commit, failure preserves active; after
  commit, never roll back: the new active remains selected/degraded and blocks
  the next promotion until proof. Intent plus prior pointer means no commit;
  intent plus candidate pointer advances; an unexpected pointer is
  `InstallAmbiguous`; missing producer refs stay blocked; and temporary,
  root, backup, or cache deletion uses exact receipt refs only. The current
  one-shot `RuntimeProcessOwner` `FnOnce` seam in `process_owner.rs` must be
  replaced by a retryable proof-bearing seam so a second cleanup call cannot
  be a false success. `capture_runtime.rs` verifies/stages/launches,
  `backend.rs` callers request promotion, `lib.rs` wires startup
  reconciliation, and the Python
  `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/manager.py`
  (`RuntimeInstallationManager`, `RuntimeInstaller`) plus
  `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/installers.py`
  (`LLMModelInstaller`) remain a separate provider/model installer.
- Measure real model memory and latency before optimizing. Keep the ordered,
  sequential acceptance lane because the available memory is constrained.
- Keep evidence privacy-safe: manifests contain hashes, CER/anchor counts,
  provenance, and cleanup flags, never raw OCR/truth text, tokens, or machine
  paths. Screenshots mask the complete privacy-sensitive card before capture.

The acceptance manifest writer is
`apps/cert-prep-desktop/scripts/acceptance-artifacts.mts::writeAcceptanceManifest`
with coverage in `apps/cert-prep-desktop/scripts/acceptance-artifacts.test.mts`.
`acceptance-real.mts::acceptancePassed` is the caller's verdict only; it is not
the manifest writer.

## Local reviews, evidence, and promotion

Every slice receives two independent reviews: a standards review for repository
conventions, security, tests, generated files, and CI; and a specification
review for contract compatibility, failure behavior, lifecycle ownership, and
the stated phase gate. Use `grill-me` one finding at a time. Approval is bound
to the exact HEAD and must be repeated after any commit or rebase.

Label evidence as fast/local, local-real, or published. A Cert Prep PR must
name the exact candidate or published artifact hashes, the tested producer
HEAD, evidence tier, deferred gates, and the 0.4.1 compatibility baseline.
Any future published 0.4.2 bytes are immutable. Cert's D4/D7 child-ledger
handoffs are consumer-local; only the producer may aggregate them and move its
stable pointer after its own promotion gate.

## Identity policy by evidence tier

Phase 1 local-package E2E evidence is labeled `local-probe` and hard-gates API
`2.0`, typed projection schema `3`, the exact producer contract hash, the packaged archive boundary (no
sibling junction or source-tree import), and loaded runtime-executable plus
OCR-worker SHAs matching the local probe. It records, but does not hard-fail
solely on, package semver, the full all-asset byte/size inventory, an app/desktop
hash after a legitimate rebuild, local `direct_url`, and registry/frozen-lock
purity. A source change invalidates the affected component's evidence, not
automatically unrelated component evidence. SHA equality is sufficient identity
proof for the same bytes; do not add a redundant local byte-by-byte comparison.
Fake OCR, snapshots, successful exits, source-tree imports, and archive-boundary
substitution remain fake-green and cannot prove the journey.

Release/published acceptance restores exact version, all artifact hashes and
manifest entries, frozen locks, and download-back byte identity, and rejects
local paths and `direct_url`. The full inventory, legitimate app/desktop hashes,
and registry purity are release gates. Keep the evidence label and tier explicit
when reporting a local-probe result.

This repository has its own focused commits, PR, and CI, but CI repair is
paused and has no authority over this checkpoint. Root coordinates and
reviews; the Luna worker implements, verifies, and commits the owned slice. A
failure stops the ordered promotion and is repaired by the owning slice; it is
never hidden by mixing runtime versions or restoring removed private OCR.

## Sol xhigh escalation

For one named blocking condition, count only consecutive Luna implementation
failures. After more than three failures, Luna reports each attempt and its
evidence to Root. Root may activate a standby Sol xhigh worker for read-only
diagnosis, options, and proposed tests. Sol xhigh never edits, commits, pushes,
publishes, or takes ownership; the original Luna implements the accepted fix.
Different findings keep separate counters and do not combine to trigger
escalation.
