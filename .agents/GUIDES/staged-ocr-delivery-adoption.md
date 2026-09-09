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
producer supplies a mutable `ProducerChildScopeV1` at
`CAPTURE_ACCEPTANCE_SCOPE_PATH` and passes Cert only its read-only invocation
input. Cert never overwrites, returns, or treats that scope as consumer output;
it writes exactly one `ConsumerSemanticResultV1` at the distinct
`CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`. D7 `PublishedAccepted` repeats the
same journey from D5/D6 published download-back bytes and writes the same
write-once semantic result at that result path. The producer validates the
result, proves its own cleanup, and later writes immutable
`AcceptanceChildWireV1` at `CAPTURE_ACCEPTANCE_WIRE_PATH`. Cert never receives
or writes the scope/wire output, waits for LAW, or aggregates consumer ledgers.
The producer alone aggregates all child wires and owns D8 stable-pointer
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
   `CandidateReady -> NewActiveCommitted -> PriorRetiredDraining ->
   RetiredProved` when a prior active exists. The **proposed**
   `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs` module's
   `RuntimePromotionStore` and `RuntimePromotionReceiptV1` are the sole Cert
   owner of the local installed-runtime pointer/receipt; they are distinct from
   the producer session journal and D8 stable pointer. The receipt carries
   separate nullable `candidateReconcileRef` and `priorReconcileRef` slots and
   only the `proofSha256` returned by the addressed producer reconcile result;
   it has no independent proof-reference field. Persist the candidate ref
   before activation. Verify the immutable candidate/root, flush
   `CandidateReady`, flush `commitIntent` with the expected prior pointer,
   lock/CAS and atomically replace/flush plus reread, then flush irreversible
   `NewActiveCommitted`. For first install (`prior = null`), advance directly
   to `RetiredProved` with `retirement.status = not_applicable`, leave
   degraded/block-next-promotion false, and do not await or invent predecessor
   proof. When a prior exists, persist `PriorRetiredDraining` before cleanup,
   obtain prior proof, then flush `RetiredProved` before optional exact
   prior-root deletion. Before commit, candidate cleanup uses only
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
   Intent plus prior pointer means no commit; intent plus candidate pointer
   advances; an unexpected pointer is `InstallAmbiguous`; missing refs remain
   independently recoverable and block only the applicable later cleanup path;
   temporary, root, backup, or cache deletion uses exact receipt refs only. The
   current one-shot `RuntimeProcessOwner` `FnOnce` seam in `process_owner.rs`
   must be replaced by a retryable proof-bearing seam so a second cleanup call
   cannot be a false success. `capture_runtime.rs` verifies/stages/launches,
   `backend.rs` callers request promotion, `lib.rs` wires startup
   reconciliation, and the Python
   `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/manager.py`
   (`RuntimeInstallationManager`, `RuntimeInstaller`) plus
   `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/installers.py`
   (`LLMModelInstaller`) remain a separate provider/model installer.
- Measure real model memory and latency before optimizing. Keep the ordered,
  sequential acceptance lane because the available memory is constrained.
- Keep evidence privacy-safe: `ConsumerSemanticResultV1` contains only bounded
  hashes, CER/anchor measurements, outcomes, projection digests, invocation/
  tier binding, and privacy booleans. It never contains cleanup flags, process
  identities, paths, raw OCR/truth text, tokens, or machine data; producer
  cleanup belongs to the later `AcceptanceChildWireV1`. Screenshots mask the
  complete privacy-sensitive card before capture.

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
producer's mutable `ProducerChildScopeV1` at
`CAPTURE_ACCEPTANCE_SCOPE_PATH` is a read-only invocation input to Cert. Cert
must not overwrite, return, or write that scope. A new D4/D7 run writes exactly
one write-once `ConsumerSemanticResultV1` at the distinct
`CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`; the producer validates it, proves
cleanup, and later writes immutable `AcceptanceChildWireV1` at
`CAPTURE_ACCEPTANCE_WIRE_PATH`. Cert never receives or writes the wire path or
defines a competing child wire.

The semantic result is bound to the invocation's parent gate/tier and closed
D4 -> D3 or D7 -> D6 ledger identity. Its mandatory `fixtureResults[]` has
the Cert private JPEG and scanned PDF page-1 observations, each with actual
normalized-output digest (`actualNormalizedOutputSha256`), CER, anchor
omissions (`anchorOmissions`), outcome, and projection digest
(`projectionSha256`). The result contains only bounded identities/digests and
privacy booleans: no cleanup flags, process/native identity, paths, raw OCR/truth,
media, tokens, or host diagnostics. Producer cleanup, invocation digest, full
ledger binding, and the canonical wire digest remain producer-owned. The
generated view
`libs/cert-prep-api/src/lib/cert-prep-api.generated.ts` is retained/regenerated;
never hand-edit or delete it.

Formal D4/D7 requires a full private normalized reference plus critical anchors.
Delete/prohibit `anchorOnly` and `parseOcrAnchorExpectation` in
`apps/cert-prep-desktop/scripts/ocr-truth-contract.mts`, including the
`acceptance-real-options.mts` import/call. A garbage-around-anchors RED fixture
must not receive CER 0. Synthetic anchor-only expectations may remain in
unit-only tests but are barred from formal acceptance. Missing scope/result,
duplicate identity, false binding, or a second/partial result write fails
closed.

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
