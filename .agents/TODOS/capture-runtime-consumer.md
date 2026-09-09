# Capture Runtime 0.4.2 Cert Prep consumer TODO

## Current checkpoint (2026-09-09)

Phase 1 is complete at the `local-probe` tier. Capture Workbench, Cert Prep,
and GX Law Prep each passed real local-package OCR, and Cert Prep's
local-package OCR evidence is accepted at that tier. This is not published or
release evidence: the formal `capture-runtime` 0.4.2 candidate/package remains
unbuilt and unpublished.

Capture Workbench PR #39 at `c6d2140`, Cert Prep PR #19 at
`d5af0f2a3939949bc10667a40252e96963ba64bb`, and their recorded heads are
release-freshness facts only; they do not reopen the completed Phase 1 status.
Older local OCR records remain historical and do not substitute for the
accepted local-probe result or for published/release evidence.

Phase 2 now owns hardening, the Nx 23.1.2 upgrade, lifecycle and performance
work, version inventory, deterministic candidate staging, and then sequential
formal/published-package regression across the consumers.

This TODO is the consumer delta only. Capture Runtime remains the sole OCR
projection owner. Cert Prep owns durable sources, review overrides, export,
and persistence. **Proposed** `DesktopRuntimeSupervisor` and **proposed**
`RuntimeAssetInstaller` are future adapter names only; the current owners are
the paths and symbols listed in the [consumer specification](../SPECS/capture-runtime-consumer.md).

Every item below is an independently reviewable slice. Each item names exact
owned paths/symbols, the red proof to write first, prerequisites, a stop
condition, a complete discovered Nx verification floor, rollback, and the
smallest commit boundary. No candidate staging is allowed before Slice 1 is
green.

## Slices

- [x] **Documentation status freeze (docs-only).** Replace stale claims with
      the 2026-09-09 local-probe checkpoint and link the canonical consumer
      spec/decision/TODO. Keep Phase 1 marked complete at `local-probe`, never
      published or installed formal acceptance.
  - Owned paths/symbols: `.agents/SPECS/capture-runtime-consumer.md`,
    `.agents/DECISIONS/capture-runtime-consumer.md`,
    `.agents/TODOS/capture-runtime-consumer.md`, and
    `.agents/TODOS/cert-prep-pdf-image-acceptance.md`; no product symbol.
  - Prerequisite: none; this slice is the current documentation checkpoint.
  - Red proof (write first): stale text could call local OCR published or
    omit the producer candidate blocker; a docs scan must fail until the
    checkpoint, OCR-only rule, and D4/D7 distinction are present.
  - Verification: `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`;
    `pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`;
    `git diff --check -- .agents/SPECS/capture-runtime-consumer.md .agents/DECISIONS/capture-runtime-consumer.md .agents/TODOS/capture-runtime-consumer.md .agents/TODOS/cert-prep-pdf-image-acceptance.md`.
    The current worker runs docs checks only; implementation targets are
    future gates.
  - Stop condition: any absolute machine path, nonexistent target, published
    claim, or legacy write permission remains.
  - Rollback: additive revert of the documentation commit only.
  - Commit boundary: `docs(phase2): define cert runtime consumer hardening`;
    record the exact SHA.

- [ ] **Slice 1: Nx 23.1.2 and canonical version inventory.** This is the
      first executable Phase 2 slice. Upgrade the workspace Nx packages and
      lockfile from the discovered `23.1.0` baseline to `23.1.2`, then make one
      read-only inventory/check reject stale and mixed 0.4.1/0.4.2 values before
      any candidate root, shared cache, active pointer, or acceptance staging.
  - Owned paths/symbols: `package.json`, `pnpm-lock.yaml`,
    `tools/capture-runtime-version.mts` (`CAPTURE_RUNTIME_VERSION`,
    `CAPTURE_RUNTIME_API_VERSION`, `CAPTURE_DOCUMENT_SCHEMA_VERSION`),
    `tools/capture-runtime-version-check.mts`
    (`assertCaptureRuntimeConsumerVersions`),
    `apps/cert-prep-desktop/scripts/package-qa/constants.mts`,
    `apps/cert-prep-desktop/src-tauri/src/capture_manifest.rs`
    (`capture_runtime_expected_version`, `capture_manifest_expectations`),
    `apps/cert-prep-desktop/src-tauri/src/manifests.rs`
    (`RuntimeManifest`, `RuntimeArtifact`, `verify_artifact`), and
    `apps/cert-prep-desktop/src-tauri/src/constants.rs`
    (`CAPTURE_RUNTIME_VERSION`, `CAPTURE_RUNTIME_API_VERSION`,
    `CAPTURE_DOCUMENT_SCHEMA_VERSION`) plus
    `apps/cert-prep-desktop/src-tauri/src/backend_process.rs`
    (`backend_launch_env`, capture-runtime environment identity fields), and
    `apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs`
    (`CaptureRuntimeConnection`).
  - Prerequisite: current Nx discovery found `cert-prep-desktop` and its
    `release-tool-test`, `typecheck-scripts`, and `package-qa-test` targets;
    no `version-check` target exists. Attach the inventory to an existing
    discovered target or add and rediscover a target in this slice; never write
    a guessed `pnpm nx run ...:version-check` command.
  - Red proof (write first): mutate one owner to a stale version, mix a
    0.4.1 lock with a 0.4.2 artifact, or omit one language/client value; the
    old subset checks must be shown green while the complete inventory must
    fail closed before installation. **Proposed** regression names are
    `test_version_inventory_rejects_stale_owner` and
    `test_version_inventory_rejects_mixed_lock_and_artifact`.
  - Verification: `pnpm nx run cert-prep-desktop:release-tool-test --skip-nx-cache`;
    `pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`;
    `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`.
    Also rerun `pnpm nx show projects --json` and
    `pnpm nx show project cert-prep-desktop --json` after any target change;
    these are discovery commands, not acceptance proof.
  - Stop condition: Nx is not `23.1.2`, any declared owner is missing from the
    inventory, a stale/mixed value passes, or a target has not been discovered.
    Do not create or install a candidate while stopped.
  - Rollback: additive revert of the Nx/inventory change; restore the reviewed
    0.4.1 expectation consistently and remove only slice-owned generated
    inventory output.
  - Commit boundary: `chore(phase2): upgrade Nx and add runtime version inventory`;
    record the inventory report and SHA.

- [ ] **Slice 2: exact OCR projection mapping and legacy-write deletion.** Keep
      `windowsml-ocr` as the producer engine and `windowsml_ocr` as the Cert
      durable discriminator. Ignore the embedded layer and reject every new
      `embedded`/`mixed` write; retain legacy rows only for read compatibility.
  - Owned paths/symbols: `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/ocr_summary.py`
    (`build_ocr_summary`, `CaptureOcrSummaryRead`, `_map_provenance`),
    `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/mapping.py`
    (`capture_document_to_pdf_extraction`, `_ocr_only_extraction_method`),
    `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/persistence.py`
    (`publish_capture_document`),
    `apps/cert-prep-backend/src/cert_prep_backend/domains/source_documents/operations.py`
    (`publish_success`, `create_and_attach_document`,
    `begin_capture_review_commit`, `finish_failed`), and
    `apps/cert-prep-backend/src/cert_prep_backend/domains/mock_exams/draft_jobs.py`
    (`enqueue_chunk_job`, `begin_commit`, `request_cancel`).
    Replace/update focused tests in
    `apps/cert-prep-backend/tests/integration/test_capture_workbench_host.py`
    (`test_capture_document_rejects_non_ocr_extraction_provenance`,
    `test_capture_document_persists_ocr_only_method_for_every_page`,
    `test_capture_document_mapping_uses_runtime_ocr_projection_text_and_device`)
    and `apps/cert-prep-backend/tests/integration/test_capture_workbench_pipeline.py`
    (`test_upload_delegates_to_capture_runtime_and_atomically_maps_existing_chunks`).
    **Proposed** replacement tests must include
    `test_capture_document_rejects_embedded_and_mixed_write_provenance`,
    `test_capture_document_rejects_noncanonical_engine_substring`, and
    `test_legacy_embedded_and_mixed_rows_remain_read_compatible`; no test may
    target a nonexistent ownership class. Preserve
    `test_upload_delegates_to_capture_runtime_and_atomically_maps_existing_chunks`
    as the old ownership-seam regression while the proposed mapper/publisher
    tests cross the current public seam.
  - Prerequisite: Slice 1 is green and the public schema-3 projection contract
    is available. Do not migrate existing legacy rows.
  - Red proof (write first): replace the marker/substrings fixture with exact
    producer `windowsml-ocr`; add delete/replace coverage that calls the public
    publication seam with `embedded` and `mixed` engine provenance and proves no
    new durable row is written. Also prove a noncanonical engine such as
    `windowsml-v2` cannot pass merely because it contains `windowsml`.
  - Verification: `pnpm nx run cert-prep-backend:test --skip-nx-cache`;
    `pnpm nx run cert-prep-backend:lint --skip-nx-cache`.
  - Stop condition: any new document/page/chunk can persist `embedded` or
    `mixed`, the embedded layer is read, a substring engine is accepted, or
    producer and durable strings are conflated. Stop before acceptance staging.
  - Rollback: additive revert of mapping/projection/persistence changes and
    replacement tests; preserve legacy rows and durable domain records.
  - Commit boundary: `fix(phase2): enforce exact OCR projection mapping`;
    record red/green test names and SHA.

- [ ] **Slice 3: immutable candidate/active roots and identity gate.** Define
      separate immutable candidate and active roots, a verified durable
      content-addressed cache, atomic active-pointer promotion, and rollback
      that leaves the prior active session usable.
  - Owned paths/symbols: `apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs`
    (`install_bundled_capture_runtime`, `installed_capture_runtime_paths`,
    `replace_runtime_directory`, `clean_stale_capture_runtime_staging`,
    `CaptureRuntimeState::launch_cancellable`), `manifests.rs`
    (`RuntimeManifest`, `RuntimeArtifact`, `verify_artifact`),
    `capture_manifest.rs` (`verify_capture_runtime`,
    `validate_capture_manifest_contract`), `process_owner.rs`
    (`RuntimeProcessOwner`, `terminate_once`), and
    `apps/cert-prep-desktop/scripts/acceptance-real-options.mts`
    (existing candidate identity helpers) plus
    `tools/capture-candidate-gate.mts` and its existing
    `tools/capture-candidate-gate.test.mts` tests. **Proposed** root labels
    `active`, `candidate`, and `active pointer`
    must be recorded as design labels, not assumed existing directories.
  - Prerequisite: Slice 1 inventory is green; the producer D3 candidate ledger
    identifies manifest, schema, core, worker/catalog, contract, and lock bytes.
  - Red proof (write first): a tampered candidate, sibling junction, local path,
    `direct_url`, URL/port-only match, mutable shared cache, or mixed lock must
    fail. Inject candidate-launch and pointer-swap failures; assert the old
    active pointer/root/session remains usable and the candidate is terminated.
  - Verification: `pnpm nx run cert-prep-desktop:capture-candidate-gate-test --skip-nx-cache`;
    `pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`;
    `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`.
  - Stop condition: active bytes are mutated in place, a failed swap damages
    active state, cache bytes are reused without verified digest/size, or the
    implementation invents a target/path without discovery. Do not run D4.
  - Rollback: additive revert of root/pointer/identity changes; retain the
    prior active root and durable cache, and remove only isolated candidate
    staging proven to be slice-owned.
  - Commit boundary: `test(phase2): harden immutable candidate promotion`;
    record candidate/archive/runtime-worker identities and rollback evidence.

- [ ] **Slice 4: candidate/active supervision adapter.** Expose only semantic
      readiness and terminal cleanup through a **proposed**
      `DesktopRuntimeSupervisor`; use one producer-owned `OwnedRuntimeSession`
      per active or candidate launch without exposing handles or PIDs.
  - Owned paths/symbols: `apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs`
    (`CaptureRuntimeState`, `CaptureRuntimeInner::terminate_child_process_tree`,
    `CaptureLaunchPolicy`),
    `apps/cert-prep-desktop/src-tauri/src/process_owner.rs`
    (`RuntimeProcessOwner`, `from_termination`, `terminate_once`,
    `owned_runtime_process!`),
    `apps/cert-prep-desktop/src-tauri/src/manifests.rs` (`verify_artifact`), and
    `apps/cert-prep-desktop/src-tauri/src/capture_manifest.rs`
    (`verify_capture_runtime`). The adapter name and its public methods are
    **proposed**; the producer's `OwnedRuntimeSession` is not a Cert symbol.
  - Prerequisite: Slice 3 identity/root failure proofs are green and the
    producer session contract is available.
  - Red proof (write first): candidate readiness failure must terminate/prove
    only the candidate; active readiness and capture remain usable. A successful
    swap must close/prove the retired active session before reporting active.
    A caller must not receive a native handle, bearer token, PID, or URL.
  - Verification: `pnpm nx run cert-prep-desktop:cargo-test --skip-nx-cache`;
    `pnpm nx run cert-prep-desktop:cargo-check --skip-nx-cache`;
    `pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`.
  - Stop condition: candidate failure tears down active, cleanup is reported
    before it is proved, or a proposed adapter becomes a second coordinator.
  - Rollback: additive revert of adapter wiring and focused tests; do not alter
    producer assets, durable source rows, or credentials.
  - Commit boundary: `feat(phase2): isolate cert runtime candidate sessions`;
    record terminate-and-prove evidence and SHA.

- [ ] **Slice 5: close, restart reconciliation, and durable handoff.** Cover
      normal/window close, readiness failure, runtime-root crash, host
      termination, and next-start identity reconciliation. Preserve durable
      runtime/model assets and an external Ollama baseline; remove only proven
      Cert-owned listeners, PIDs, run data, staging, and backups.
  - Owned paths/symbols: `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/persistence.py`
    (`publish_capture_document`),
    `apps/cert-prep-backend/src/cert_prep_backend/domains/source_documents/operations.py`
    (`recover_operations`, `finish_failed`, `acknowledge_cancellation`,
    `_reset_document_derived_state`),
    `apps/cert-prep-backend/src/cert_prep_backend/domains/mock_exams/draft_jobs.py`
    (`recover_runnable_jobs`, `request_cancel`, `begin_commit`),
    `apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs`
    (`CaptureRuntimeInner::terminate_child_process_tree`,
    `CaptureRuntimeState::terminate_child_process_tree`,
    `installed_capture_runtime_paths`, `clean_stale_capture_runtime_staging`),
    and `apps/cert-prep-desktop/src-tauri/src/process_owner.rs`
    (`RuntimeProcessOwner::from_termination`, `RuntimeProcessOwner::terminate_once`,
    `owned_runtime_process!`). Acceptance helpers are the existing
    `apps/cert-prep-desktop/scripts/packaged-flow-smoke/app-lifecycle.mts`
    (`closeAppAndCheckResidue`, `cleanupAfterRunWithTimeout`,
    `restartAndVerifyPersistence`) and
    `apps/cert-prep-desktop/scripts/process-residue-audit.mts`
    (`buildProcessResidueAuditReport`).
  - Prerequisite: Slices 2-4 are green; producer ordered JPEG then PDF page-1
    gate has a current cleanup proof before Cert starts.
  - Red proof (write first): inject leaked owned listener/PID/run directory,
    wrong-owner PID/path, stale reparse point, runtime-root crash, and a
    pre-existing Ollama PID. Prove owned residue is removed, unknown state and
    baseline survive, durable source/review/domain rows reload, and Cert never
    overlaps the LAW model slot.
  - Verification: `pnpm nx run cert-prep-backend:test --skip-nx-cache`;
    `pnpm nx run cert-prep-desktop:cargo-test --skip-nx-cache`;
    `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`;
    `pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`.
  - Stop condition: broad process-name kill, unknown residue deletion, durable
    asset deletion, nonterminal cleanup marked clean, or any Cert/Law overlap.
    Preserve failure evidence and do not hand off to LAW.
  - Rollback: additive revert of lifecycle/reconciliation changes; preserve
    durable assets and unproven residue for explicit manual recovery.
  - Commit boundary: `feat(phase2): prove cert runtime close handoff`;
    record cleanup/handoff evidence and SHA.

- [ ] **Slice 6: performance baseline before optimization.** Measure model-ready
      time, per-page and first-page latency, total elapsed time, process/Job
      memory, GPU memory, and cleanup duration by producer-reported compute
      mode. Do not change OCR behavior or persist private content.
  - Owned paths/symbols:
    `apps/cert-prep-desktop/scripts/packaged-flow-smoke/resource-sampling.mts`
    (`startResourceSampling`, `finalizeResourceSamplingArtifacts`),
    `apps/cert-prep-desktop/scripts/packaged-flow-smoke/resource-sampling-gpu-routing.mts`,
    `apps/cert-prep-desktop/scripts/packaged-flow-smoke/resource-sampling-finalize.mts`,
    `apps/cert-prep-desktop/scripts/packaged-flow-smoke/resource-sampling-summary.mts`,
    `apps/cert-prep-desktop/scripts/packaged-flow-smoke/streaming-baseline-report.mts`,
    `apps/cert-prep-desktop/scripts/acceptance-real-options.mts`
    (`isCompletePersistedOcrExecutionProof`),
    `apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs`
    (`CaptureRuntimeState::launch_cancellable`,
    `CaptureRuntimeState::terminate_child_process_tree`), and
    `apps/cert-prep-desktop/src-tauri/src/process_owner.rs`
    (`RuntimeProcessOwner::terminate_once`). Any new metric name is
    **proposed** until its privacy contract is reviewed.
  - Prerequisite: Slices 1-5 are green and the sequential private JPEG/PDF
    page-1 fixtures are available in the producer-assigned slot.
  - Red proof (write first): an evidence fixture that lacks a reproducible
    baseline or includes raw OCR/truth text, tokens, local paths, host names,
    or environment dumps must fail validation.
  - Verification: `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`;
    `pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`;
    `pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`.
  - Stop condition: measurement alters production behavior, includes unbounded
    diagnostics, or compares averages that hide a failed fixture/anchor.
  - Rollback: additive revert of measurement-only code and evidence schema;
    production capture behavior and durable records remain unchanged.
  - Commit boundary: `test(phase2): record cert OCR performance baseline`;
    record only privacy-safe baseline identities and metrics.

- [ ] **Slice 7: D4 pre-publication immutable-candidate acceptance.** Use the
      exact producer D3 bytes in Cert's installed real journey: JPEG first,
      cleanup/model-memory release, PDF page 1, restart persistence,
      review/export, and cleanup. Require producer `windowsml-ocr` provenance,
      Cert `windowsml_ocr`, JPEG CER <= 3%, PDF page-1 CER <= 1%, and zero
      missing critical anchors. D4 never moves the stable pointer.
  - Owned paths/symbols: `apps/cert-prep-desktop/scripts/acceptance-real.mts`
    (`acceptancePassed`, `writeAcceptanceManifest`),
    `apps/cert-prep-desktop/scripts/acceptance-real-options.mts`
    (`createAcceptanceSmokeOptions`, `loadPhase1FinalCandidate`,
    `strictRuntimeIdentity`),
    `apps/cert-prep-desktop/scripts/ocr-truth-contract.mts`
    (`parseOcrTruthManifest`, `evaluateOcrTruth`),
    `apps/cert-prep-desktop/scripts/ocr-page-record-evidence.mts`
    (`assertOcrPageRecordEvidenceIntegrity`),
    `apps/cert-prep-desktop/scripts/phase1-acceptance-evidence.mts`
    (`buildPhase1AcceptanceEvidence`),
    `apps/cert-prep-desktop/scripts/phase1-final-identity.mts`
    (`loadPhase1FinalEvidence`),
    `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/mapping.py`
    (`capture_document_to_pdf_extraction`, `_ocr_only_extraction_method`), and
    `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/persistence.py`
    (`publish_capture_document`).
  - Prerequisite: Slices 1-6 green, producer D3 candidate ledger complete,
    candidate root verified, and producer Capture JPEG -> PDF page-1 gate
    green with cleanup before Cert starts.
  - Red proof (write first): local URL-only transport, a supplied old
    executable, protocol fake, candidate with mismatched worker/contract,
    CER over threshold, missing anchor, or incomplete cleanup must fail before
    a passing D4 manifest. Prove D4 evidence is labeled pre-publication and no
    stable pointer is changed.
  - Verification: `pnpm nx run cert-prep-desktop:capture-candidate-gate-test --skip-nx-cache`;
    `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`;
    `pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`.
  - Stop condition: candidate identity is incomplete, semantic/cleanup proof
    is partial, manifest contains raw text/token/path, or D4 is reported as
    published acceptance. Preserve the failed artifact and do not start LAW.
  - Rollback: restore the last reviewed 0.4.1 pins/assets/locks consistently;
    preserve candidate evidence and keep the previous active root/pointer.
  - Commit boundary: `test(phase2): accept immutable cert candidate`;
    record candidate hashes, D4 manifest SHA, and cleanup proof.

- [ ] **Slice 8: D7 published download-back acceptance and D8 promotion.**
      After D5 publishes the exact D3 bytes and D6 verifies download-back
      hashes, rerun the same Cert journey from downloaded bytes only. D7 is
      formal published acceptance. Move the stable pointer only after Capture
      Workbench, Cert Prep, and GX Law Prep each have green D7 ledgers for the
      same bytes; one consumer or D4 never promotes it.
  - Owned paths/symbols: `tools/capture-runtime-version.mts`
    (`CAPTURE_RUNTIME_RELEASE_BASE_URL`, `CAPTURE_RUNTIME_PACKAGE_NAME`,
    `CAPTURE_RUNTIME_CLIENT_PACKAGE_NAME`),
    `tools/capture-runtime-version-check.mts`
    (`assertCaptureRuntimeConsumerVersions`),
    `apps/cert-prep-desktop/scripts/acceptance-real.mts`
    (`acceptancePassed`, `writeAcceptanceManifest`),
    `apps/cert-prep-desktop/scripts/acceptance-real-options.mts`
    (`loadRuntimeCandidate`, `strictRuntimeIdentity`),
    `apps/cert-prep-desktop/scripts/phase1-final-identity.mts`
    (`loadPhase1FinalEvidence`),
    `apps/cert-prep-desktop/scripts/package-qa.mts` (`main`),
    `apps/cert-prep-desktop/src-tauri/src/capture_manifest.rs`
    (`verify_capture_runtime`, `validate_capture_manifest_contract`), and
    `apps/cert-prep-desktop/src-tauri/src/manifests.rs` (`verify_artifact`). A
    shared stable-pointer writer is **proposed** and has no current Cert
    symbol.
  - Prerequisite: Slices 1-7 green; producer D5 publication and D6
    download-back ledger prove byte identity; all three consumers are assigned
    the same immutable bytes and no local path/direct URL.
  - Red proof (write first): local candidate, mutable URL, URL/port-only match,
    stale 0.4.1 lock, mixed dependency, old executable, or download-back byte
    mismatch must fail. Inject a one-consumer D7 failure and prove the stable
    pointer does not move; only all-three D7 success permits D8.
  - Verification: `pnpm nx run cert-prep-desktop:release-tool-test --skip-nx-cache`;
    `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`;
    `pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`.
    The three-repository D7 ledger is an external coordination prerequisite,
    not something inferred from a local target result.
  - Stop condition: any artifact/lock/manifest/hash mismatch, local provenance,
    CER/anchor/cleanup failure, missing consumer ledger, or attempted pointer
    move before all D7 results is terminal. Do not publish a failed candidate
    or start LAW.
  - Rollback: restore the last reviewed 0.4.1 pins/assets/locks consistently;
    atomically restore the prior stable pointer if promotion had begun, retain
    old active bytes and failure evidence, and never mix versions.
  - Commit boundary: `release(phase2): accept published capture-runtime bytes`;
    record exact published/download-back hashes, lockfile, manifests, all
    three D7 ledgers, and the stable-pointer decision.

## Cross-slice rules

- New imports are OCR-only: producer `windowsml-ocr` maps to Cert durable
  `windowsml_ocr`; embedded PDF layers are ignored, and `embedded`/`mixed` are
  legacy read-only values only.
- The UI presents producer `OcrComputePreflightV2` and notice only. It never
  ranks adapters. The canonical order is dGPU, iGPU, then noticed CPU; a
  DirectML failure never receives a host CPU retry.
- Real model runs are sequential: Capture Workbench JPEG then PDF page 1,
  Cert Prep, then GX Law Prep. Each owner proves cleanup before handoff.
- Phase 1 is complete at `local-probe` only; it is not published or installed
  formal acceptance. D4 is pre-publication candidate acceptance; D7 is
  download-back published acceptance; D8 stable-pointer movement waits for all
  three D7 ledgers.
- Image-flow changes require design and both review axes before code; TDD red
  tests cross the public seam; staging is isolated before installed evidence.
- The historical [lazy-install decision](../DECISIONS/lazy-capture-runtime-installation.md)
  and [packaged-smoke spec](../SPECS/packaged-capture-workbench-smoke.md) remain
  for traceability. No lazy/package TODO files exist; do not invent or revive
  those references as active work.
