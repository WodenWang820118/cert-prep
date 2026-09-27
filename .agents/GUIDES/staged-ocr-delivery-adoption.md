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

The acceptance seam consumes the future producer bundle/package
`@capture-runtime/acceptance-contract` (proposed
`packages/capture-acceptance-contract/`) and the exact D3/D6-bound
`contractSha256`; that package is the sole authority for version, schema, codec,
manifest, and hash. Its package/target are absent at this checkpoint, so
package/target creation is a producer discovery/creation stop. Cert does not
redefine or extend any producer record. The runtime contract-set identity
(`contractSetSha256`) used by `RuntimeReady`/typed OCR remains separate from
the acceptance bundle hash. The producer's canonical Phase 2 specification is
the sole schema and validation authority.

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
  fixed OCR method (`windowsml_ocr`) and fail closed for new `direct_pdf`,
  `embedded`, or `mixed` extraction. Historical records may remain readable
  under their old method.
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
`CandidateAccepted` runs the immutable candidate before publication. The
producer owns a mutable scope at `CAPTURE_ACCEPTANCE_SCOPE_PATH`, publishes a
separate frozen, read-only invocation at
`CAPTURE_ACCEPTANCE_INVOCATION_PATH` (or its canonical read-only handle/pipe),
and supplies the future `@capture-runtime/acceptance-contract` bundle/package
with the exact D3/D6-bound `contractSha256`. That package is the sole schema,
codec, manifest, and hash authority and is absent at this checkpoint; package/
target creation is a producer discovery/creation stop. Cert consumes only the
invocation, verifies its frozen canonical bytes and `invocationSha256`, and
atomically create-new exactly one complete package-defined
`ConsumerSemanticResultV1` at the distinct
`CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`. D7 `PublishedAccepted` repeats the
same journey from D5/D6 published download-back bytes with a fresh invocation
and writes the same exact package-defined result type. The proposed private
`FixtureCapabilityResolver` adapter supplies ordered JPEG and scanned PDF
page-1 capabilities and full truth to the package codec; no Cert-local result
schema is restated. The runtime contract-set identity (`contractSetSha256`) is
separate from the acceptance bundle hash. The producer validates the result,
proves its own cleanup, adds cleanup/privacy fields to the canonical wire, and
later writes immutable `AcceptanceChildWireV1` at
`CAPTURE_ACCEPTANCE_WIRE_PATH`. Cert never consumes/overwrites/returns/writes the
scope, receives or writes the wire, waits for LAW, or aggregates consumer
ledgers. The producer alone aggregates all child wires and owns D8 stable-pointer
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
  durable `windowsml_ocr`; embedded layers are ignored and new `direct_pdf`,
  `embedded`, or `mixed` writes are forbidden.
  A failed candidate cleanup must not destroy the active backend. Stop only
  app-owned runtime/model descendants; a baseline process that existed before
  launch must survive. Reconcile stale PID/listener/staging state safely at
  startup without broad process-name kills.
- Candidate/active promotion is the transaction
  `CandidatePrepared -> CandidateReady -> NewActiveCommitted -> RetiredProved`
  for first install (`prior = null`) and
  `CandidatePrepared -> CandidateReady -> NewActiveCommitted ->
  PriorRetiredDraining -> RetiredProved` when a prior active exists. The
  **proposed** `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs`
  module's `RuntimePromotionStore` and `RuntimePromotionReceiptV1` are the sole
  Cert owner of the local installed-runtime pointer/receipt; they are distinct
  from the producer session journal and D8 stable pointer. Every pointer
  observation uses the closed union `absent | present{generation,sha256}` in the
  receipt, `commitIntent`, logical CAS, locked reread, and startup crash matrix.
  The receipt carries separate nullable `candidateReconcileRef` and
  `priorReconcileRef` slots and only the `proofSha256` returned by the addressed
  producer reconcile result; it has no `ProofRef` type or independent
  proof-reference field. R3 is whole-group: producer
  `prepare_group(immutable_plan, &dyn ReconcileRefSink)` returns the candidate
  group ref/generation, the sink persists/verifies the complete group and
  returns its activation receipt digest plus producer-supplied
  `ActivationPermitV1`. Cert flushes those fields as `CandidatePrepared`, then
  calls producer `activate_group(prepared, permit)`, waits for loaded-worker and
  readiness identity, and only then flushes `CandidateReady`. Candidate and
  prior group refs remain distinct. Verify the immutable candidate/root, flush
  `commitIntent` with the expected prior and intended candidate pointer
  observations, lock/CAS and atomically replace/flush plus reread, then flush
  irreversible `NewActiveCommitted`. First install (`prior = null`, prior
  observation `absent`) uses compare-and-create-if-absent; an unexpected
  `present{generation,sha256}` is a conflict/`InstallAmbiguous`, never an
  overwrite. Advance directly to `RetiredProved` with
  `retirement.status = not_applicable`, leave degraded/block-next-promotion
  false, and do not await or invent predecessor proof. When a prior exists,
  persist `PriorRetiredDraining` before cleanup, obtain prior proof, then flush
  `RetiredProved` before optional exact prior-root deletion. Before commit,
  candidate cleanup uses only
  `RuntimeSessionJournal::reconcile(candidateReconcileRef)` and preserves the
  active on failure; after commit, prior retirement uses only
  `RuntimeSessionJournal::reconcile(priorReconcileRef)`, never rolls back, and
  keeps the new active selected/degraded until proof. The producer API is
  addressable and observe-only after restart: `ReconcileRef` is opaque, not a
  local/native handle, PID, path, port, or takeover lease. Complete
  absence/listener/staging proof may terminalize; present, reused, unqueryable,
  or ambiguous observations remain `reconcile-required` and touch nothing.
  The producer seam is the addressable
  `RuntimeSessionJournal::reconcile(ReconcileRef) -> ReconcileResult` API.
  Intent plus exact prior observation means no commit; intent plus exact
  candidate observation advances; an unexpected observation is
  `InstallAmbiguous`; missing refs remain independently recoverable and block
  only the applicable later cleanup path; temporary, root, backup, or cache
  deletion uses exact receipt refs only. Before auto-launch, observe the
  existing `app_data_dir/runtimes/capture-runtime` with proposed
  `RuntimePromotionStore::observe_legacy_root`, using
  `capture_runtime.rs::installed_capture_runtime_paths`,
  `capture_manifest.rs::verify_capture_runtime` and
  `capture_runtime_expected_version`, `manifests.rs::load_runtime_manifest` and
  `verify_artifact`, plus identity-scoped `process_owner.rs` proof. Verify
  manifest/content hashes, byte count, known version, and quiescence (no owned
  listener/process/producer session and no unqueryable session). A present
  live, unverifiable, path-inaccessible, reparse, mismatched, unknown, empty,
  or ambiguous legacy root is `InstallAmbiguous` and is not true empty; touch
  nothing and do not launch, migrate, delete, overwrite, or promote it. A
  valid known/quiescent root with pointer observation `absent` may use proposed
  `RuntimePromotionStore::adopt_verified_legacy_root`: flush
  `LegacyAdoptionPrepared`, recheck the exact identity, atomically move to
  immutable `active/<legacyId>`, create pointer
  `present{generation,sha256}`, and flush `LegacyAdopted` with
  `activeSessionRef = null`/`sessionState = not-running`. Adoption is not
  `CandidateReady`; a later launch runs whole-group prepare/activate/readiness
  and records a new session ref. A crash before the move leaves the legacy
  root unchanged; after an exact move before pointer creation, only the exact
  prepared identity may complete, while mismatch remains `InstallAmbiguous`
  with no rollback or byte touch. The current one-shot `RuntimeProcessOwner`
  `FnOnce` seam in `process_owner.rs` must be replaced by a retryable
  proof-bearing seam so a second cleanup call cannot be a false success.
  `capture_runtime.rs` verifies/stages/launches, `backend.rs` callers request
  promotion, `lib.rs` wires startup reconciliation, and the Python
  `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/manager.py`
  (`RuntimeInstallationManager`, `RuntimeInstaller`) plus
  `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/installers.py`
  (`LLMModelInstaller`) remain a separate provider/model installer.
- Measure real model memory and latency before optimizing. Keep the ordered,
  sequential acceptance lane because the available memory is constrained.
- Keep evidence privacy-safe: `ConsumerSemanticResultV1` is the exact
  package-defined producer result and contains no Cert-local extension,
  cleanup/privacy block, process identity, path, raw OCR/truth text, token, or
  machine data. The package-defined ordered fixture assignments are supplied
  through the private `FixtureCapabilityResolver` adapter for the private JPEG
  and scanned PDF page 1; the package codec writes the exact ordered result and
  only canonical measurements. Producer cleanup/privacy belongs to the later
  `AcceptanceChildWireV1`; screenshots mask the complete privacy-sensitive card
  before capture.

The schema-1 compatibility writer is
`apps/cert-prep-desktop/scripts/acceptance-artifacts.mts::writeAcceptanceManifest`
with coverage in `apps/cert-prep-desktop/scripts/acceptance-artifacts.test.mts`.
Preserve it for legacy `acceptance-manifest.json` input/readback; it is not the
canonical child-wire writer. `acceptance-real.mts::acceptancePassed` is the
caller's verdict only; it is not a second evidence writer. The semantic/page
owners remain `ocr-semantic-evidence.mts::serializePrivacySafeOcrSemanticEvidence`
(`OCR_NORMALIZATION_VERSION`),
`phase1-acceptance-evidence.mts::buildPhase1AcceptanceEvidence`, and
`ocr-page-record-evidence.mts::assertOcrPageRecordEvidenceIntegrity`.

The acceptance migration has an explicit producer-compatible protocol. The
producer's mutable scope at `CAPTURE_ACCEPTANCE_SCOPE_PATH` is never a Cert
input. Cert consumes only the separate frozen/read-only invocation at
`CAPTURE_ACCEPTANCE_INVOCATION_PATH`, verifies its canonical bytes,
`invocationSha256`, and exact `@capture-runtime/acceptance-contract` bundle/hash,
then atomically create-new exactly one write-once package-defined
`ConsumerSemanticResultV1` at the distinct
`CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`. The future package is absent at this
checkpoint, so package/target creation is a producer discovery/creation stop.
The proposed private `FixtureCapabilityResolver` supplies ordered fixture
capabilities and full truth to the package codec; no Cert-local result schema is
restated. The producer validates it, proves cleanup, adds cleanup/privacy
fields, and later writes immutable `AcceptanceChildWireV1` at
`CAPTURE_ACCEPTANCE_WIRE_PATH`. Cert never receives or writes the wire path or
defines a competing child wire.

The semantic result is bound to the invocation's parent gate/tier and closed
D4 -> D3 or D7 -> D6 ledger identity. It is the exact package-defined
`ConsumerSemanticResultV1`, imported through the future package at its version
and exact producer `contractSha256`, not a Cert-local redefinition. The
package-defined ordered assignments and results must have equal cardinality and
order; the private JPEG and scanned PDF page-1 observations are supplied by
`FixtureCapabilityResolver`, which supports both ordered fixtures and the
complete full-truth oracle. It has no Cert-local privacy or cleanup fields;
producer cleanup/privacy, invocation digest, full ledger binding, and the
canonical wire digest remain producer-owned. The runtime contract-set hash
(`contractSetSha256`) remains a separate `RuntimeReady`/typed-OCR identity and
is never substituted for the acceptance `contractSha256`. The generated view
`libs/cert-prep-api/src/lib/cert-prep-api.generated.ts` is retained/regenerated;
never hand-edit or delete it.

Formal D4/D7 requires a full private normalized reference plus critical anchors.
Delete/prohibit `anchorOnly` and `parseOcrAnchorExpectation` in
`apps/cert-prep-desktop/scripts/ocr-truth-contract.mts`, including the
`acceptance-real-options.mts` import/call. A garbage-around-anchors RED fixture
must not receive CER 0. Synthetic anchor-only expectations may remain in
unit-only tests but are barred from formal acceptance. Missing or writable
invocation, canonical-digest mismatch, missing result, duplicate identity,
false binding, or a second/partial result write fails closed.

The CPU notice is a projection of producer truth only; Cert does not recalculate
the producer's compute mode, reason, or notice.

## Local reviews, evidence, and promotion

Every slice receives two independent reviews: a standards review for repository
conventions, security, tests, generated files, and CI; and a specification
review for contract compatibility, failure behavior, lifecycle ownership, and
the stated phase gate. Use `grill-me` one finding at a time. Approval is bound
to the exact HEAD and must be repeated after any commit or rebase.

Label evidence as fast/local, local-real, or published. A Cert Prep PR must
name the exact candidate or published artifact hashes, the tested producer
HEAD, evidence tier, deferred gates, and the 0.4.1 compatibility baseline.
Any future published 0.4.2 bytes are immutable. Cert's D4/D7 semantic-result
handoffs are consumer-local; the producer validates them and emits the child
wires, and only the producer may aggregate those wires and move its stable
pointer after its own promotion gate.

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
