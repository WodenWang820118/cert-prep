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

CI repair is paused and has no authority over this checkpoint or the Phase 2
acceptance record. Do not treat a repair branch or CI result as release,
publication, or consumer-ownership authority until the owning lane resumes.

Phase 2 now owns hardening, the Nx 23.1.2 upgrade, lifecycle and performance
work, version inventory, deterministic candidate staging, and then sequential
formal/published-package regression across the consumers.

Audio transcription/translation is a separate domain and acceptance lane; it
is not part of this OCR-only Phase 2 TODO.

## Continuation checkpoint (2026-09-21)

`CERT_PREP_CHECKOUT` resolves to this repository, clean before this documentation
edit on `docs/capture-runtime-042-phase2` at
`948f875a91ac032b3e7dfda0e0d9bc3de9a63b07`. Earlier checkpoints and test counts
below remain historical; no Cert Prep tests were rerun for this checkpoint.

- Exact schema-3 OCR mapping/provenance (`ocr_summary.py`, `mapping.py`),
  candidate inventory/preflight (`tools/capture-runtime-version-check.mts`,
  `tools/capture-candidate-gate.mts`), and producer-notice foundations are
  present. Nx is `23.1.2`, but active npm, Python SDK, and Rust launcher pins
  remain `0.4.1`; these foundations do not establish migration readiness.
- Per the continuation handoff, producer HEAD
  `12fe94c60970876413628d619b732c59fae67585` contains the private strict
  RequestRef metadata codec, not a delivered public authenticated RequestRef
  `start_or_get`/`get`/`cancel`/`delete` operation or SDK. Public R3
  activate/observe/close repairs now pass three complete uncached standard Nx
  runs at four threads (322 library, 7 API, 12 lifecycle tests per run), plus
  33 fixture tests and desktop compile/53 tests. Two fresh producer reviews,
  each lasting over 30 minutes, found no blockers in that bounded repair.
  These are local source checks, not a delivered SDK or candidate;
  see the [producer closeout record](../../../capture-workbench/.agents/TODOS/capture-runtime-042-r3-closeout.md).
- Host compute-policy deletion and lifecycle/promotion wiring remain gated by
  the delivered public `0.4.2` SDK and verified immutable producer-D3
  candidate/ledger. No candidate has been created or installed in this
  continuation. Private foundations and code-only fixtures cannot replace
  that handoff; do not create substitute APIs or close migration/release boxes.

The [consumer specification](../SPECS/capture-runtime-consumer.md) remains the
ownership and rollback authority; this addition records readiness only.

## Current implementation status (2026-09-13)

The 2026-09-09 checkpoint above remains the historical Phase 1 baseline. This
status note records reviewed implementation evidence only; it does not change
any unchecked Phase 2 slice.

- Cert Prep is clean at `df9175a2deffe9f6297abf327ec824fb6c0386c4` and contains
  the reviewed candidate artifact receipt/preflight binding, exact OCR
  projection mapping, and producer-notice presentation foundations. These are
  consumer guards and presentation seams; no candidate SDK was installed or
  loaded and no promotion was performed.
- Capture Workbench's current committed head is `fa5ed29e0b55dd5fc02f400634f3803fb3f56dc4`,
  following `ca9500b`, `5d92374`, `4c36ce1`, and `6127eca`. The private R3
  Running/Closing/native and staging-cleanup/Terminal foundations are committed
  there. The producer public SDK and the required `GroupLease`, restart,
  recovery, and `RequestRef` seams, together with a verified D3 candidate,
  remain pending dependencies for Cert.
- Capture evidence is reported as `231` main plus `14` fixture tests passing,
  with a known startup flake. This is test evidence only: it does not establish
  an installed package, publication, or real JPEG/PDF OCR acceptance. The
  existing `0.4.1` source pins remain active, and synthetic `0.4.2` fixtures do
  not prove a delivered and loaded `0.4.2` schema-3 SDK.
- Slice 1 migration readiness and the later candidate/promotion/D4/D7 slices
  therefore stay unchecked. Cert must wait for the producer public API and an
  immutable, verified D3 candidate/ledger; it must not create substitute
  interfaces or claim readiness from the private producer commits.

Rollback boundaries for the next slices remain local: a public-API adapter
change is reverted additively without changing the active `0.4.1` source; a
failed candidate preflight discards only proven isolated candidate staging and
leaves the active pointer/session unchanged; after a pointer commit, retain the
selected candidate with its reconcile refs/proofs and recover it independently
rather than restoring the prior active root. D4/D7 evidence changes are
reverted by their own evidence/adapter commit while durable source and domain
rows remain preserved; no publication or producer stable-pointer rollback is
implied.

This TODO is the consumer delta only. Capture Runtime remains the sole OCR
projection owner. Cert Prep owns durable sources, review overrides, export,
and persistence. **Proposed** `DesktopRuntimeSupervisor` and **proposed**
`RuntimeAssetInstaller` are future adapter names only. The proposed
`apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs` is the sole Cert
owner for the local installed-runtime pointer and `RuntimePromotionReceiptV1`;
it is not the producer session journal or D8 stable-pointer owner. Its receipt
  must carry candidate/prior content identities, pointer generation/hash,
  revision/CAS, the candidate complete producer group/root binding and verified
  sink receipt, flushed activation and `commitIntent` states,
  degraded/block-next-promotion flags, separate nullable candidate/prior
  group/ref slots, and only the `proofSha256` returned by each addressed
  producer reconcile result; there is no independent proof-reference field and
  no `PreparedGroup`, `GroupLease`, or permit field. Candidate preparation uses
  the exact producer `prepare_group(plan, sink) -> PreparedGroup` contract and
  sink `persist`/`read_back`/`verify` calls; Cert flushes the complete binding
  and verified receipt as `CandidatePrepared` before calling
  `activate_group(prepared)`. The producer-private `PreparedGroup` is opaque,
  move-only, live-only, and nonserializable; all-root loaded-worker/readiness
  identity must be proved before Cert flushes `CandidateReady`. Candidate and
  prior group refs are distinct. For `prior = null`, the prior ref is null and
  retirement is `not_applicable`; after candidate/session conditions, first
  install advances directly from `NewActiveCommitted` to `RetiredProved`
  without degrading or blocking forever. For later promotions with a prior session, candidate
  pre-commit cleanup and prior post-commit retirement remain independently
  recoverable. On any Cert restart, old prepared/ready receipts are
  observation-only: Cert never reuses a private permit or resumes their group.
  Only a still-running original producer with verified live ownership may
  continue an existing live lease semantically; after producer restart/lost
  handle, old refs reconcile observe-only until terminal/no-resource proof, then
  any launch uses fresh refs/prepare. The producer exposes
  `RuntimeSessionJournal::reconcile(ReconcileRef) -> ReconcileResult` as an
  opaque, addressable observe-only semantic API; Cert never assumes a local Job
  handle, process handle, PID, path, port, or takeover lease. Only complete
  absence/listener/staging proof may advance a ref; present, reused,
  unqueryable, or ambiguous observations remain `reconcile-required` and
  degraded where a prior retirement exists. Current owners and symbols remain
  the paths listed in the [consumer specification](../SPECS/capture-runtime-consumer.md).
The Python backend's `RuntimeInstallationManager`/`RuntimeInstaller` in
`apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/`
continue to own provider/model installation jobs only; they do not write the
desktop pointer or receipt.

The acceptance seam consumes only the future producer package/bundle
`@capture-runtime/acceptance-contract` (proposed at
`packages/capture-acceptance-contract/`) and its literal D3/D6-bound
`contractSha256`. That package/bundle is the only acceptance schema/codec/hash
authority and is absent at this checkpoint, so package/target creation is a
producer discovery/creation stop. Cert does not define, extend, or restate
`ProducerChildScopeV1`, `ProducerChildInvocationV1`,
`ConsumerSemanticResultV1`, or `AcceptanceChildWireV1`. The authenticated
runtime contract-set for `RuntimeReady` and OCR projection is separate
(`contractSetVersion`/`contractSetSha256`); the two hashes are never compared
or substituted.
Every local pointer observation is the closed union
`absent | present{generation,sha256}` in the receipt, intent, logical CAS,
reread, and crash matrix. First install uses pointer observation `absent` with
content identity `prior = null`; an unexpected present pointer is a conflict/
`InstallAmbiguous`.

Every item below is an independently reviewable slice. Each item names exact
owned paths/symbols, the red proof to write first, prerequisites, a stop
condition, a complete discovered Nx verification floor, rollback, and the
smallest commit boundary. No candidate staging is allowed before Slice 1 is
green. The listed verification is the green proof; an unavailable package
manager or undiscovered target is a discovery-stop, never a green claim.

## Slices

- [x] **Documentation status freeze (docs-only).** Replace stale claims with
      the 2026-09-09 local-probe checkpoint and link the canonical consumer
      spec/decision/TODO. Keep Phase 1 marked complete at `local-probe`, never
      published or installed formal acceptance.
  - Owned paths/symbols: `.agents/SPECS/capture-runtime-consumer.md`,
    `.agents/DECISIONS/capture-runtime-consumer.md`,
    `.agents/TODOS/capture-runtime-consumer.md`, and
    `.agents/TODOS/cert-prep-pdf-image-acceptance.md`,
    `.agents/GUIDES/staged-ocr-delivery-adoption.md`, and the two historical
    TODO banners `.agents/TODOS/capture-workbench-ocr-review.md` and
    `.agents/TODOS/capture-workbench-cert-prep-pdf.md`; no product symbol.
  - Prerequisite: none; this slice is the current documentation checkpoint.
  - Red proof (write first): stale text could call local OCR published or
    omit the producer candidate blocker; a docs scan must fail until the
    checkpoint, OCR-only rule, and D4/D7 distinction are present.
  - Verification: docs link/anchor/fence scan; `corepack pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`;
    `corepack pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`;
    `git diff --check -- .agents/SPECS/capture-runtime-consumer.md .agents/DECISIONS/capture-runtime-consumer.md .agents/TODOS/capture-runtime-consumer.md .agents/TODOS/cert-prep-pdf-image-acceptance.md .agents/GUIDES/staged-ocr-delivery-adoption.md .agents/TODOS/capture-workbench-ocr-review.md .agents/TODOS/capture-workbench-cert-prep-pdf.md`.
    The current worker runs docs checks only; implementation targets are
    future gates.
  - Stop condition: any absolute machine path, nonexistent target, published
    claim, or legacy write permission remains.
  - Rollback: additive revert of the documentation commit only.
  - Commit boundary: `docs(phase2): define cert runtime consumer hardening`;
    record the exact SHA.

- [ ] **Slice 1: Nx 23.1.2 and canonical version inventory.** This is the
      first executable Phase 2 slice. Keep `pnpm@12.0.0`, upgrade the workspace
      Nx packages and lockfile from the discovered `23.1.0` baseline to
      `23.1.2`, then make one read-only version/projection inventory/check
      reject stale and mixed 0.4.1/0.4.2 values before any candidate root,
      shared cache, active pointer, or acceptance staging. The inventory
      hard-gates API `2.0`, typed projection schema `3`, and the exact
      producer-generated contract SHA-256; no digest is invented in advance.
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
    (`CaptureRuntimeConnection`); `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/runtime_provenance.py`
    (`capture_runtime_attestation`, `_validate_candidate`); and the loaded
    producer SDK public `RuntimeReady`/`OcrComputePreflightV2` model and exact
    contract hash from the candidate ledger. Retain/regenerate the generated
    consumer view `libs/cert-prep-api/src/lib/cert-prep-api.generated.ts`
    (`RuntimeReady`, `OcrComputePreflightV2`); inspect it, but never hand-edit
    or delete it.
  - Prerequisite: current Nx discovery found `cert-prep-desktop` and its
    `release-tool-test`, `typecheck-scripts`, and `package-qa-test` targets;
    no `version-check` target exists. Attach the inventory to an existing
    discovered target or add and rediscover a target in this slice; never write
    a guessed `corepack pnpm nx run ...:version-check` command.
  - Red proof (write first): mutate one owner to a stale version, mix a
    0.4.1 lock with a 0.4.2 artifact, omit the schema-3 projection or exact
    contract hash, or omit one language/client value; the old subset checks
    must be shown green while the complete inventory must fail closed before
    installation. **Proposed** regression names are
    `test_version_inventory_rejects_stale_owner`,
    `test_version_inventory_rejects_missing_projection_contract_hash`, and
    `test_version_inventory_rejects_mixed_lock_and_artifact`.
  - Verification:
    `corepack pnpm nx run cert-prep-desktop:capture-runtime-consumer-test --skip-nx-cache`;
    `corepack pnpm nx run cert-prep-desktop:release-tool-test --skip-nx-cache`;
    `corepack pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`;
    `corepack pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`.
    Also rerun `corepack pnpm nx show projects --json` and
    `corepack pnpm nx show project cert-prep-desktop --json` after any target change;
    these are discovery commands, not acceptance proof.
  - Stop condition: Nx is not `23.1.2`, any declared owner is missing from the
    inventory, a stale/mixed value passes, or a target has not been discovered.
    Do not create or install a candidate while stopped.
  - Rollback: additive revert of the Nx/inventory change; restore the reviewed
    0.4.1 expectation consistently and remove only slice-owned generated
    inventory output.
  - Commit boundary: `chore(phase2): upgrade Nx and add runtime version inventory`;
    record the inventory report and SHA.

  - **Evidence audit (2026-09-11; this slice remains unchecked).** The current
    checkout is on Nx `23.1.2` with pnpm `12.0.0`; discovery resolves the named
    `capture-runtime-consumer-test`, `release-tool-test`, `typecheck-scripts`,
    and `package-qa-test` targets. The consumer inventory, 23-file source
    snapshot, producer-contract byte digest, required `RuntimeReady`,
    `OcrComputePreflightV2`, and `CaptureOcrProjectionV3` identities, and
    stale/mixed/missing-owner regressions establish a fail-closed consumer
    guard. No-cache verification passed: consumer `29/29`, release tools
    `47` Node tests plus `16` Python tests, package QA `277` passed with `1`
    platform-unavailable skip, and script typecheck passed.

    This guard does not establish 0.4.2 migration readiness. The package and
    lock inputs, `CAPTURE_RUNTIME_VERSION`, Python SDK pin, and sidecar Cargo
    inputs remain `0.4.1`; the generated TypeScript view and host fallback do
    not prove that a verified candidate 0.4.2 SDK is loaded. The passing
    0.4.2 values come from synthetic producer-contract fixtures. The
    canonical producer source contract exists, but a real producer D3
    candidate, immutable ledger, and verified candidate-delivered/loaded
    0.4.2 schema-3 contract remain unavailable, so the checkbox and candidate
    staging stay blocked pending that evidence.

- [ ] **Slice 2: exact OCR projection mapping and legacy-write deletion.** Keep
      `windowsml-ocr` as the producer engine and `windowsml_ocr` as the Cert
      durable discriminator. Ignore the embedded layer and reject every new
      `direct_pdf`/`embedded`/`mixed` write; retain legacy rows only for read
      compatibility.
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
     `test_capture_document_rejects_direct_pdf_embedded_and_mixed_write_provenance`,
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
    publication seam with `direct_pdf`, `embedded`, and `mixed` provenance and proves no
    new durable row is written. Also prove a noncanonical engine such as
    `windowsml-v2` cannot pass merely because it contains `windowsml`.
  - Verification: `corepack pnpm nx run cert-prep-backend:test --skip-nx-cache`;
    `corepack pnpm nx run cert-prep-backend:lint --skip-nx-cache`.
  - Stop condition: any new document/page/chunk can persist `direct_pdf`,
     `embedded`, or `mixed`, the embedded layer is read, a substring engine is accepted, or
    producer and durable strings are conflated. Stop before acceptance staging.
  - Rollback: additive revert of mapping/projection/persistence changes and
    replacement tests; preserve legacy rows and durable domain records.
  - Commit boundary: `fix(phase2): enforce exact OCR projection mapping`;
    record red/green test names and SHA.

- [ ] **Slice 3: delete-first host compute-policy inventory and pass-through contract.**
      Once the producer's generated public readiness contract is available,
      remove host policy duplication rather than adding another adapter layer.
      Hosts decode the exact public `RuntimeReady`/
      `OcrComputePreflightV2` model and display producer-owned notice truth;
      they do not recalculate mode, adapter, reason, or notice. Retain the
      producer fields needed to tell the user CPU fallback when no dGPU/iGPU is
      usable.
  - Owned paths/symbols: delete the fallback import/class and
    `_validate_decision` in
    `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/host_models.py`;
    delete `CertPrepCaptureCoordinator._assert_ocr_compute_preflight` and its
    `begin_capture` call in
    `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/coordinator.py`;
    delete `_install_candidate_runtime_ready_decoder` in
    `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/client.py`;
     retain and regenerate the producer public generated model view
     `libs/cert-prep-api/src/lib/cert-prep-api.generated.ts`
     (`RuntimeReady`, `OcrComputePreflightV2`) without hand-editing or deleting
     it; delete only
    `mapOcrCompute` in
    `apps/cert-prep/src/app/pages/capture-workbench-trial/cert-prep-capture-client.ts`;
    delete duplicate `OcrComputeMode`, `OcrAdapterClass`,
    `OcrComputeReasonCode`, `OcrComputeNoticeCode`, and
    `OcrComputePreflight` in
    `apps/cert-prep/src/app/pages/capture-workbench-trial/contracts/capture-workbench-trial.contracts.ts`;
    and delete `GPU_ACCELERATION_MESSAGE`, `CPU_FALLBACK_MESSAGE`,
    `gpuAccelerationMessage`, and `cpuFallbackNotice` from
    `apps/cert-prep/src/app/stores/capture-runtime/capture-runtime-preflight.store.ts`.
  - Prerequisite: Slice 1 is green and the producer public generated contract
    exposes the projection schema `3`, exact contract hash, compute decision,
    and user-notice truth. Do not replace the deleted policy with a new local
    enum or reason-to-copy map.
  - Red proof (write first): the existing matrix/validator tests must expose
    the duplication before deletion: backend
    `apps/cert-prep-backend/tests/integration/test_capture_workbench_host.py`
    (`test_capture_coordinator_accepts_only_the_runtime_ocr_compute_decision`,
    `test_capture_coordinator_fails_closed_before_pdf_upload_without_valid_preflight`),
    and `apps/cert-prep-backend/tests/unit/test_capture_runtime_v2_contract.py`
    (`test_runtime_ready_accepts_the_generated_ocr_compute_preflight`
    [keep/rework at the public seam],
    `test_runtime_ready_rejects_a_preflight_that_silently_changes_compute_policy`);
    frontend `apps/cert-prep/src/app/pages/capture-workbench-trial/cert-prep-capture-client.spec.ts`
    (`maps the runtime-owned %s %s OCR compute decision`,
    `rejects a malformed GPU-DML preflight instead of creating a CPU fallback state`),
    and `apps/cert-prep/src/app/stores/capture-runtime/capture-runtime-preflight.store.spec.ts`
    (`keeps GPU acceleration visible without a CPU fallback notice`,
    `exposes the CPU fallback notice for %s`).
    Replace them with proposed pass-through tests in the same files:
    `test_capture_coordinator_forwards_generated_runtime_notice_without_policy_recalculation`
    in `apps/cert-prep-backend/tests/integration/test_capture_workbench_host.py`,
    `it('decodes the generated producer preflight without a host matrix')` in
    `apps/cert-prep/src/app/pages/capture-workbench-trial/cert-prep-capture-client.spec.ts`,
    and `it('displays the producer CPU fallback notice when no GPU is usable')`
    in `apps/cert-prep/src/app/stores/capture-runtime/capture-runtime-preflight.store.spec.ts`.
    A test must fail if the host drops producer notice truth, derives a reason,
    or accepts a host-only mode.
  - Verification: `corepack pnpm nx run cert-prep-backend:test --skip-nx-cache`;
    `corepack pnpm nx run cert-prep-backend:lint --skip-nx-cache`;
    `corepack pnpm nx run cert-prep-backend:generate-openapi-client --skip-nx-cache`;
    `corepack pnpm nx run cert-prep:test --skip-nx-cache`;
    `corepack pnpm nx run cert-prep:lint --skip-nx-cache`;
    `corepack pnpm nx run cert-prep:build --skip-nx-cache`;
    `corepack pnpm nx run cert-prep-api:vite:test --skip-nx-cache`; and
    `corepack pnpm nx run cert-prep-api:lint --skip-nx-cache`. Rerun
    `corepack pnpm nx show projects --json` and
    `corepack pnpm nx show project cert-prep-backend --json`,
    `corepack pnpm nx show project cert-prep --json`, and
    `corepack pnpm nx show project cert-prep-api --json` after target changes; these are
    discovery evidence, not acceptance proof.
  - Stop condition: any host fallback DTO, local preflight validator,
     mode/adapter/reason/notice matrix, generated-contract shim, dropped
     producer notice field, host GPU enumeration/ranking, or CPU retry remains;
     the generated public contract is unavailable; the generated consumer view
     was hand-edited or deleted; or a target is not discovered. Do not stage a
     candidate or call D4 while stopped.
  - Rollback: additive revert of the deletion/pass-through change and focused
    tests only; do not restore a second policy owner or alter producer bytes,
    stable-pointer state, durable source rows, or acceptance ledgers.
  - Commit boundary: `fix(phase2): remove cert compute policy duplication`;
    record the delete-first inventory, red/green names, generated contract
    identity, and exact SHA.

- [ ] **Slice 4: immutable candidate/active roots, legacy observation, and
       identity gate.** Define separate immutable candidate and active roots, a
       verified durable content-addressed cache, an atomic active-pointer
       promotion boundary, safe adoption of the existing legacy root, and
       next-start reconciliation. Replace the impossible all-or-nothing rollback
       contract with
       `CandidatePrepared -> CandidateReady -> NewActiveCommitted ->
       RetiredProved` for first install (`prior = null`) or the proven no-session legacy prior, and
       `CandidatePrepared -> CandidateReady -> NewActiveCommitted ->
       PriorRetiredDraining -> RetiredProved` when a prior session exists (excluding the proven no-session legacy prior below).
  - Owned paths/symbols: **proposed**
    `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs`
    (`RuntimePromotionStore`, `RuntimePromotionReceiptV1`) as the sole Cert
    local installed-runtime pointer/receipt owner; `apps/cert-prep-desktop/src-tauri/src/lib.rs`
    (`run`) for module wiring/startup reconciliation; `apps/cert-prep-desktop/src-tauri/src/backend.rs`
    (`install_capture_runtime`, `start_capture_runtime`,
    `restart_owned_backend_with_capture_runtime`) as callers;
     `apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs`
     (`install_bundled_capture_runtime`, `installed_capture_runtime_paths`,
     `replace_runtime_directory`, `clean_stale_capture_runtime_staging`,
     `CaptureRuntimeState::launch_cancellable`), `manifests.rs`
     (`RuntimeManifest`, `RuntimeArtifact`, `verify_artifact`),
     `capture_manifest.rs` (`verify_capture_runtime`,
     `validate_capture_manifest_contract`,
     `capture_runtime_expected_version`), and `process_owner.rs`
     (`RuntimeProcessOwner`, `from_termination`, `terminate_once`,
     `owned_runtime_process!`). The proposed legacy-observation methods are
     `RuntimePromotionStore::observe_legacy_root` and
     `RuntimePromotionStore::adopt_verified_legacy_root`; their path-free
     `LegacyAdoptionPrepared`/`LegacyAdopted` receipt states are not current
     symbols. The Python
    `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/manager.py`
    (`RuntimeInstallationManager`, `RuntimeInstaller`) and
    `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/installers.py`
    (`LLMModelInstaller`) remain a separate provider/model-installation scope;
      they do not write this pointer or receipt. The store is distinct from the
      producer session journal and producer D8 stable pointer. The receipt must
      expose separate nullable `candidateReconcileRef` and `priorReconcileRef`
      slots and retain only the `proofSha256` returned by the addressed producer
      reconcile result; it must not invent a `ProofRef` type or independent
      proof-reference field. R3 uses the exact producer whole-group contract
      `prepare_group(plan, sink) -> PreparedGroup` and sink
      `persist`/`read_back`/`verify` calls. The complete path-free candidate
      group/root binding and verified sink receipt are flushed in
      `CandidatePrepared` before activation. `PreparedGroup` is producer-private,
      opaque, move-only, live-only, and nonserializable; no permit is persisted
      or passed as a public parameter. The producer consumes it through
      `activate_group(prepared) -> GroupLease`, activates every root, and Cert
      verifies all-root readiness before `CandidateReady`. Persist the complete
      group/root binding before activation. For `prior = null`, the prior
      ref is null and first install advances directly from `NewActiveCommitted`
      to `RetiredProved` with `retirement.status = not_applicable`, without a
      degraded or permanently blocked state. The producer proof seam is
     `RuntimeSessionJournal::reconcile(ReconcileRef)`;
     `ReconcileRef` is an opaque journal index/address, not a local Job/process
      handle, PID, path, port, or takeover lease. The existing
      `apps/cert-prep-desktop/scripts/acceptance-real-options.mts`
      candidate identity helpers, `tools/capture-candidate-gate.mts`, and its
      `tools/capture-candidate-gate.test.mts` tests remain acceptance adapters.
      The producer lifecycle owner and exact contract are referenced portably
      as `capture-workbench/.agents/SPECS/capture-runtime-042-p2-hardening.md`:
      `OwnedRuntimeSession::prepare_group(plan, sink) -> PreparedGroup`,
      `ReconcileRefSink::persist`/`read_back`/`verify`, and
      `OwnedRuntimeSession::activate_group(PreparedGroup) -> GroupLease`.
      They are producer-owned symbols; this Cert slice must not recreate or
      modify them.
      The legacy observation is the existing
     `app_data_dir/runtimes/capture-runtime` root, classified before auto-launch
     by the proposed `RuntimePromotionStore::observe_legacy_root` and adopted
     only by `RuntimePromotionStore::adopt_verified_legacy_root` after manifest,
     content, known-version, and no-owned-listener/session proof.
     **Proposed** root labels
     `active`, `candidate`, `active pointer`, `CandidatePrepared`,
     `CandidateReady`, `NewActiveCommitted`, `PriorRetiredDraining`,
     `RetiredProved`, `LegacyAdoptionPrepared`, and `LegacyAdopted` must be
     recorded as design labels, not assumed existing directories. The current
    `RuntimeProcessOwner` stores a one-shot `FnOnce` and returns false success
    on a second `terminate_once` call; replacement with a retryable,
    proof-bearing producer-session seam is part of this slice, not a second
     cleanup policy. The proposed store persists distinct candidate/prior
     reconcile refs and only returned `proofSha256` values; it never persists
     raw paths, tokens, PIDs, process handles, or OCR. Complete
     absence/listener/staging proof may terminalize the addressed ref; present,
     reused, unqueryable, or ambiguous observations remain
      `reconcile-required` and touch nothing. On Cert restart, old prepared or
      ready receipts are never replayed: only the still-running original
      producer with verified live ownership may continue an existing lease
      semantically. A producer restart or lost handle requires observe-only
      reconciliation of the old ref until terminal/no-resource proof; any later
      launch uses fresh refs and a fresh prepare/sink binding.
  - Prerequisite: Slice 1 inventory is green; the producer D3 candidate ledger
    identifies manifest, schema, core, worker/catalog, contract, and lock bytes.
   - Red proof (write first): a tampered candidate, sibling junction, local path,
       `direct_url`, URL/port-only match, mutable shared cache, or mixed lock must
       fail. Prove that `CandidatePrepared` persists the complete candidate
       group/root binding and verified sink receipt from producer
       `prepare_group(plan, sink)`/`persist`/`read_back`/`verify` before
       `activate_group(prepared)`; no `PreparedGroup`, `GroupLease`, or private
       permit may be serialized into the Cert receipt. A partial activation,
       incomplete all-root readiness, loaded-worker mismatch, readiness mismatch,
       or timeout must not flush `CandidateReady`, `commitIntent`, or the pointer.
       Inject failures before and after the atomic pointer boundary. For `prior =
       null`, assert first install reaches `NewActiveCommitted -> RetiredProved`
       with `retirement.status = not_applicable`, no prior ref, and no degraded or
       permanently blocked state. For a later promotion with a prior session, assert the new active
       remains selected/degraded after prior-retirement failure, the next
       promotion is blocked, and the exact distinct candidate/prior group refs
       plus returned `proofSha256` values are retained. A candidate pre-commit
       cleanup failure must be independently retryable without touching active;
       a prior post-commit retirement failure must be independently retryable
       while the new active remains selected/degraded. Cleanup retries until
       `RetiredProved`; a second cleanup call must not pass as a no-op success. A
       file-install restore is `Restored` only with re-proofs of the prior
       manifest, byte count, content hash, and session; otherwise it is
       `InstallAmbiguous`. On Cert restart, a live original producer with
       verified ownership may continue an existing lease semantically, but a
       producer restart/lost handle must reconcile old refs observe-only and use
       fresh refs/prepare after terminal/no-resource proof.
   - Proven no-session legacy prior RED proof (write first; conceptual only,
     no test has been run in this docs slice): adopt a verified quiescent root,
     never launch it, promote a ready candidate, and recover a crash after the
     pointer replace. Both paths must reach `RetiredProved`/`not_applicable`
     with present prior content identity, null prior group/ref, no fabricated
     producer proof hash, and no degraded/block flag. Content presence alone
     must not demand a live-session reconcile ref or a pointless prior launch.
     Require durable completed adoption identity and uninterrupted no-launch
     history, serialized with durable launch intent before prepare; reverify
     exact content/layout/pointer and unambiguous quiescent listener/process
     ownership, and persist/revalidate path-free identity, history revision
     interval, and bounded ownership evidence. RED countercases remove history
     or completed adoption evidence, inject launch intent before a ref exists,
     add a historical group/ref, change content/pointer, or make ownership
     ambiguous/unqueryable: each must stay `InstallAmbiguous`/
     `reconcile-required`; post-commit new active remains selected/degraded
     and the next promotion blocked. Actual prior sessions still need their
     distinct producer ref/proof. Optional content deletion requires exact
     cleanup-reference and fresh identity/pointer checks.
     Exact planned test owner: proposed
     `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs` tests module,
     exercised by `cert-prep-desktop:cargo-test`:
     `adopted_never_launched_prior_retires_not_applicable`,
     `no_session_prior_commit_crash_revalidates_evidence`,
     `no_session_prior_missing_adoption_or_history_stays_ambiguous`,
     `no_session_prior_launch_intent_or_historical_ref_stays_blocked`,
     `no_session_prior_changed_content_or_ownership_stays_ambiguous`, and
     `no_session_prior_retirement_never_fabricates_ref_or_launches`.
     These tests cross the store's public seam with ownership/launch adapter
     fixtures; the canonical
     [no-session branch](../SPECS/capture-runtime-consumer.md#proven-no-session-legacy-prior-retirement)
     qualifies all prior-session clauses and crash rows in this TODO.
   - Legacy red proof (write first): with the existing
       `app_data_dir/runtimes/capture-runtime` present, a valid known-version
       manifest/content but live owned listener/session, an unreadable or
       reparse/path failure, an unknown/mismatched version, an empty legacy root,
       or an ambiguous pointer must return `InstallAmbiguous`, touch no runtime
       root/pointer/session, and perform no promotion. Before the move, the
       `LegacyAdoptionPrepared` receipt must contain exact source, destination,
       content, layout, pointer-intent, and move-phase fields as the spec's
       closed populated variants (`none` only outside adoption). Exercise the
       spec's phase-aware matrix: receipt lag after move/pointer creation is
       recoverable only at its exact crash edge; a phase ahead of observed
       operations is ambiguous. Exercise the
       exact recovery cases: source exact/destination absent/pointer absent
       continues the recorded move; source absent/destination exact/pointer
       absent completes only the recorded pointer; source absent/destination
       exact/pointer exact flushes `LegacyAdopted`. Both roots, unexpected or
       any content/layout/pointer-intent/move-phase mismatch, reparse/unqueryable
       evidence, or missing intent are `InstallAmbiguous` and touch nothing. A
       valid, quiescent root adopts
       to `active/<legacyId>` with pointer `present{generation,sha256}` and
       `activeSessionRef = null`/`sessionState = not-running`; it never emits
       `CandidateReady`. A later launch uses fresh whole-group refs/prepare.
   - Ordering proof (write first): verify the immutable candidate/root; call the
      exact producer `prepare_group(plan, sink) -> PreparedGroup`; the sink must
      `persist`, `read_back`, and `verify` the complete ordered group/root
      binding. Flush that complete binding and verified sink receipt as
      `CandidatePrepared` before activation. `PreparedGroup` is opaque,
      move-only, live-only, and nonserializable; never serialize or pass its
      private permit through Cert. Call `activate_group(prepared)`, which
      consumes the value and activates the whole group. Wait for all-root
      loaded-worker/readiness identity, then flush `CandidateReady`; only after
      that flush `commitIntent` with the expected prior and intended candidate
      pointer observations from the closed union `absent | present{generation,sha256}`;
     lock and logically CAS/atomically replace and flush the pointer, then
     reread it; flush irreversible `NewActiveCommitted` only after an exact
     reread. First install (`prior = null`, prior observation `absent`) uses
     compare-and-create-if-absent; an unexpected present observation is a
     conflict/`InstallAmbiguous`. Flush `RetiredProved` directly with
     `retirement.status = not_applicable` and no degraded/block-next-promotion
     flag. For a prior session, persist `PriorRetiredDraining` before cleanup; call the
     producer proof seam with the distinct `priorReconcileRef` (never the
     candidate ref), retain only returned `proofSha256`, flush `RetiredProved`,
     and only then optionally delete the exact prior root. If candidate cleanup
     fails before commit, retry `candidateReconcileRef` independently while the
     prior active remains untouched. If prior retirement fails after commit,
     retry `priorReconcileRef` independently while the new active remains
     selected/degraded. There is no rollback after pointer commit.
  - Crash/startup reconciliation proof (write first):

    | Receipt and observed pointer (`absent | present{generation,sha256}`) | Required result |
    | --- | --- |
    | `CandidatePrepared` before activation/readiness, or candidate verification failed | Preserve active; reconcile only the exact candidate ref and complete group/root binding observe-only, and clean only an exact recorded candidate/temp ref. Never deserialize/replay `PreparedGroup` or a permit, flush `CandidateReady`, or touch the pointer. After terminal/no-resource proof, any retry uses fresh refs/prepare. |
    | `CandidatePrepared` with an activation/readiness crash and an exact candidate group observation | Never replay the old prepared value. If the original producer remains alive and verifies live ownership of the exact whole-group lease, the existing lease may continue semantically after fresh all-root readiness proof; otherwise reconcile the old ref observe-only. Producer restart/lost handle, partial, live-but-unverified, reused, unqueryable, or ambiguous observations remain `reconcile-required`; after terminal/no-resource proof, a new launch uses fresh refs/prepare. |
    | `CandidateReady`/no intent plus an observed pointer exactly matching the recorded prior observation | Pre-commit; do not commit from the stale receipt; preserve active and invoke only `RuntimeSessionJournal::reconcile(candidateReconcileRef)` for exact candidate refs. Complete absence/listener/staging proof may terminalize; only a still-running original producer with verified live lease ownership may continue semantically after fresh all-root readiness proof. Never deserialize a permit or resume a serialized ready group; otherwise wait for terminal/no-resource proof and use fresh refs/prepare for any launch. |
    | `commitIntent` plus an observed pointer exactly matching the expected prior `PointerObservation` | No commit; preserve active; never treat intent as permission to replace. |
    | `commitIntent` plus an observed pointer exactly matching the intended candidate `present{generation,sha256}` | Advance to `NewActiveCommitted`; if `prior = null`, advance directly to `RetiredProved` with `retirement.status = not_applicable`, `priorReconcileRef = null`, and no degraded/block-next-promotion flag; for the proven no-session legacy prior, revalidate its evidence and advance directly to `RetiredProved`/`not_applicable`; otherwise persist `PriorRetiredDraining` before prior-session cleanup. Never restore prior. |
    | unexpected pointer observation or generation/hash conflict | `InstallAmbiguous`, degraded and blocked; retain refs/errors; on first install any unexpected `present{generation,sha256}` is a compare-and-create-if-absent conflict; no rollback/deletion. |
    | `NewActiveCommitted` with `prior = null` | Keep new active selected and advance directly to `RetiredProved` with `retirement.status = not_applicable`; keep degraded/block-next-promotion false and do not invent predecessor proof. |
    | post-commit state with a prior active outside the proven no-session legacy branch | Keep new active selected/degraded and block the next promotion; invoke only `RuntimeSessionJournal::reconcile(priorReconcileRef)` for prior retirement proof. |
    | missing required durable candidate/prior session reconcile ref, outside first install or the proven no-session legacy prior | Keep the applicable cleanup path independently recoverable; for prior-session retirement remain blocked and do not claim `RetiredProved` or delete prior. |
    | `LegacyAdoptionPrepared` | Re-observe exact state-discriminated source, destination, content, layout, pointer intent, and move phase. Source exact/destination absent/pointer absent continues only the recorded move; source absent/destination exact/pointer absent completes only the recorded pointer; source absent/destination exact/pointer exact flushes `LegacyAdopted`. Both/unexpected/mismatch/reparse/unqueryable/missing intent is `InstallAmbiguous` and touches no runtime bytes. |
    | `LegacyAdopted` with `activeSessionRef = null`/`sessionState = not-running` | Keep `active/<legacyId>` selected, never flush `CandidateReady`, do not invent a group/ref, and require a later launch to use fresh `prepare_group`/`activate_group`/all-root readiness before it records a new session ref. |
    | temp/root/backup/cache entry | Delete only the exact receipt cleanup ref whose identity/hash/size matches. |

    Startup reconciliation is owned by `RuntimePromotionStore`, not by
    directory/process-name heuristics. The red matrix must cover a crash at
    every ordering edge and a second cleanup call that returns a real failure,
    not false success.
    Proposed focused Rust tests in `runtime_promotion.rs` are
      `receipt_round_trips_path_free_promotion_fields`,
      `candidate_prepared_persists_complete_group_binding_and_verified_receipt_without_permit`,
      `activate_group_and_all_root_readiness_precede_candidate_ready`,
      `candidate_activation_failure_preserves_active_and_never_commits`,
      `restart_never_replays_prepared_or_ready_group`,
      `live_producer_lease_continues_only_with_verified_ownership`,
      `producer_restart_requires_fresh_prepare_after_terminal_reconcile`,
      `commit_intent_with_prior_pointer_does_not_commit`,
      `commit_intent_with_candidate_pointer_advances_without_rollback`,
      `committed_first_install_recovers_to_retired_proved_not_applicable`,
      `committed_prior_recovers_to_prior_retired_draining`,
     `unexpected_pointer_is_install_ambiguous`,
    `distinct_candidate_and_prior_reconcile_refs_round_trip`,
    `candidate_precommit_cleanup_reconciles_without_prior_retirement`,
    `prior_postcommit_retirement_reconciles_without_candidate_cleanup`,
     `reconcile_present_reused_unqueryable_or_ambiguous_stays_blocked`,
     `first_install_without_prior_retirement_is_not_applicable`,
     `missing_prior_reconcile_ref_without_no_session_evidence_blocks_later_promotion`, and
     `cleanup_requires_exact_recorded_reference`,
     `legacy_quiescent_root_adopts_to_immutable_active`,
     `legacy_live_root_is_install_ambiguous_without_touching`,
     `legacy_unverifiable_or_path_failure_is_install_ambiguous_without_touching`,
     `legacy_root_is_not_empty_for_create_if_absent`,
      `legacy_adoption_receipt_requires_exact_state_and_intent`,
      `legacy_adoption_recovery_cases_are_state_discriminated`,
      `legacy_adoption_crash_edges_reconcile_without_promotion`, and
     `legacy_adoption_launch_records_a_new_group_ref`.
   - Verification: `corepack pnpm nx run cert-prep-desktop:capture-candidate-gate-test --skip-nx-cache`;
     `corepack pnpm nx run cert-prep-desktop:cargo-test --skip-nx-cache`;
     `corepack pnpm nx run cert-prep-desktop:cargo-check --skip-nx-cache`;
     `corepack pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`;
     `corepack pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`.
    - Stop condition: active bytes are mutated in place, a failed pre-commit step
      damages active state, a post-commit cleanup path claims old-active
      rollback, cache bytes are reused without verified digest/size, a second
      `terminate_once`-style false success remains, `CandidateReady` or
      `commitIntent` can be flushed before producer whole-group activation and
      all-root readiness proof, a `PreparedGroup`, `GroupLease`, or private
      permit is serialized/replayed by Cert, a stale receipt resumes an old
      group after restart, or a fresh launch is attempted before old refs have
      terminal/no-resource proof. Also stop if a legacy root is migrated while
      live/unverifiable/ambiguous, the exact adoption receipt fields or pointer
      intent are missing, `InstallAmbiguous` is called restored without proof,
      an ambiguous legacy path is touched, or the implementation invents a
      target/path without discovery. Do not run D4.
   - Rollback: before pointer commit, discard only isolated candidate staging
     proven to be slice-owned and leave active untouched. A failed or
     ambiguous legacy observation/adoption leaves
      `app_data_dir/runtimes/capture-runtime` byte-for-byte untouched; only an
      exact state-discriminated `LegacyAdoptionPrepared` receipt may continue
      its recorded adoption move/pointer operation, and there is no rollback
      after the pointer is created. A runtime `PreparedGroup` or `GroupLease`
      is never resumed from a Cert receipt. After commit,
     do not roll back the old active; retain the new active, distinct
     candidate/prior reconcile/proof refs, degraded marker, and failure
     evidence while retrying/reconciling cleanup at next start. Additive revert
     is limited to the implementation commit and must not pretend an install
     was restored without proof.
   - Commit boundary: `test(phase2): harden immutable candidate promotion`;
     record candidate/archive/runtime-worker identities, transaction state,
      candidate/prior `ReconcileRef`, complete group/root binding, verified sink
      receipt, the `prepare_group`/`activate_group`/all-root-readiness ordering,
      restart ownership distinction, legacy observation/adoption outcome,
      returned `proofSha256` handling, and pre/post-commit evidence. It must not
      record a private activation permit, prepared value, or live lease.

- [ ] **Slice 4.5: migrate the schema-1 acceptance manifest to the producer's
      semantic result and handoff.** Keep the current
      `acceptance-manifest.json` readable as a legacy local diagnostic. New Cert
      D4/D7 runs consume the future producer bundle/package
      `@capture-runtime/acceptance-contract` and its exact D3/D6-bound
      `contractSha256`; the package is the sole authority for version, schema,
      codec, manifest, and hash. Its package/target are absent at this
      checkpoint, so package/target creation is a discovery/creation stop.
      Cert consumes only the frozen, read-only invocation from
      `CAPTURE_ACCEPTANCE_INVOCATION_PATH`, verifies its canonical digest, and
      atomically create-new exactly one complete package-defined
      `ConsumerSemanticResultV1` at the distinct
      `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`. The runtime contract-set
      identity (`contractSetSha256`) used by `RuntimeReady`/typed OCR remains
      separate from the acceptance bundle hash; neither may be substituted for
      the other. The producer owns the mutable
      scope at `CAPTURE_ACCEPTANCE_SCOPE_PATH`, validates the result, proves
      cleanup, and later writes immutable `AcceptanceChildWireV1` at
      `CAPTURE_ACCEPTANCE_WIRE_PATH`. Cert never consumes/overwrites/returns/writes
      the scope, receives/writes the wire path, emits `evidence.aggregate`, creates
      an aggregate/D8 record, or mutates the stable pointer.
  - Owned paths/symbols: `apps/cert-prep-desktop/scripts/acceptance-artifacts.mts`
    (`writeAcceptanceManifest`) is the preserved schema-1 compatibility
    writer, covered by `apps/cert-prep-desktop/scripts/acceptance-artifacts.test.mts`;
    `apps/cert-prep-desktop/scripts/acceptance-real.mts`
    (`acceptancePassed`) remains the caller's verdict only and must not become a
    second writer; `apps/cert-prep-desktop/scripts/ocr-semantic-evidence.mts`
    (`serializePrivacySafeOcrSemanticEvidence`,
    `OCR_NORMALIZATION_VERSION`); `apps/cert-prep-desktop/scripts/phase1-acceptance-evidence.mts`
    (`buildPhase1AcceptanceEvidence`); and
    `apps/cert-prep-desktop/scripts/ocr-page-record-evidence.mts`
    (`assertOcrPageRecordEvidenceIntegrity`) provide semantic/page proof.
    `apps/cert-prep-desktop/scripts/ocr-truth-contract.mts`
    (`evaluateOcrTruth`, `normalizeOcrText`, `parseOcrTruthManifest`,
    `levenshtein`) remains the full-reference calculation seam. Formal D4/D7
    must delete/prohibit `anchorOnly` and `parseOcrAnchorExpectation` there,
    including the import/call in
    `apps/cert-prep-desktop/scripts/acceptance-real-options.mts`; synthetic
    anchor-only expectations may remain unit-only but are barred from formal
    acceptance. Retain/regenerate the producer-generated view
    `libs/cert-prep-api/src/lib/cert-prep-api.generated.ts`
    (`RuntimeReady`, `OcrComputePreflightV2`) without hand-editing or deleting
    it; it is not a child-wire writer. The proposed candidate installed-receipt
    owner `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs`
    (`RuntimePromotionStore`, `RuntimePromotionReceiptV1`) binds the result to
    the candidate/phase and separate nullable candidate/prior refs, retaining
    only returned `proofSha256` values. The producer's
    `ProducerChildScopeV1`, `ProducerChildInvocationV1`,
    `ConsumerSemanticResultV1`, `AcceptanceChildWireV1`, and their path
    variables are producer package symbols, not Cert implementations. Add the
    proposed private `FixtureCapabilityResolver` adapter in
    `apps/cert-prep-desktop/scripts/acceptance-real-options.mts`; it resolves
    only the ordered fixture capabilities and complete full-truth oracle
    handles required by the package, without becoming a second schema owner.
  - Semantic-result requirements: consume the exact future package/bundle
    version and `contractSha256`, consumer/child identity, and parent gate/tier
    binding; do not add, redefine, or restate local result fields. The
    frozen/read-only invocation binds D4 to the D3 candidate ledger or D7 to
    the D6 publication/download ledger; its canonical digest and package
    version/hash must match or the run fails closed. The package-defined
    `fixtureAssignments[]` is mandatory and ordered. The resolver supplies
    private JPEG and scanned PDF page-1 capabilities in exactly that order and
    the package codec writes the exact `ConsumerSemanticResultV1` with matching
    ordered results and canonical measurements. Raw OCR, raw truth, raw media,
    tokens, paths, and native IDs remain outside the result; producer cleanup,
    privacy, full D3/D6 ledger binding, invocation digest, and canonical wire
    digest are added only to the later producer wire.
  - Prerequisite: Slice 1 version inventory, Slices 2-3 exact projection and
    generated-contract pass-through gates, Slice 4 candidate/active receipt
    contract, current owner discovery, and the producer scope/invocation/result/
    wire contract are green or available. Do not create or stage a candidate in
    this contract migration slice. Schema-1 manifests remain compatibility
    inputs until the producer scope/invocation/result/wire protocol is green and
    the legacy output is deleted; `CAPTURE_ACCEPTANCE_INVOCATION_PATH` must be
    supplied as frozen/read-only input, its canonical digest must match the
    producer contract/ledger, and it must never be defaulted or inferred from
    `CAPTURE_ACCEPTANCE_SCOPE_PATH`.
  - Red proof (write first): the migration must fail closed when the old schema-1
    shape is emitted for a new run, the producer scope is consumed or
    missing/escaped, the immutable invocation is missing/writable/replaced or
    its canonical digest/contract hash mismatches, the semantic-result path is
    missing/escaped/pre-existing, a second/partial result is written, either
    required fixture result is missing or reordered, the invocation/tier/D3-or-
    D6 binding is absent, the actual normalized digest/projection digest/CER/
    anchor omission/outcome is absent, or raw OCR/truth/token/path/process data
    appears. Full private normalized reference text plus critical anchors is
    mandatory: a garbage-around-anchors output must not receive CER 0. RED must
    reject any `anchorOnly` expectation or `parseOcrAnchorExpectation` formal
    path, while synthetic anchor-only fixtures remain unit-only. A writer that
    emits a new `direct_pdf`, `embedded`, or `mixed` value, or that emits
    `evidence.aggregate`, any aggregate/D8 field, child wire, cleanup proof, or
    stable-pointer action is also a failing red proof.
    Proposed focused regression names in
    `apps/cert-prep-desktop/scripts/acceptance-artifacts.test.mts` and the
    semantic-evidence tests are `rejects_schema1_output_for_new_run`,
    `writes_one_consumer_semantic_result_only`,
    `rejects_scope_overwrite_or_wire_write`,
    `requires_private_jpeg_and_scanned_pdf_page1_fixture_results`,
    `rejects_garbage_around_anchors_even_when_anchors_are_present`, and
    `rejects_anchor_only_expectation_in_formal_acceptance`. These are red before
    implementation and green only after the producer-compatible result handoff
    is complete.
  - Verification: the existing discovered targets are
    `corepack pnpm nx run cert-prep-desktop:phase1-evidence-test --skip-nx-cache`;
    `corepack pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`;
    and `corepack pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`.
    Before using any new semantic-result target, rerun
    `corepack pnpm nx show project cert-prep-desktop --json`; no dedicated
    `acceptance-child-wire-test` target exists at this head. If coverage needs
    a new target/schema, create it in an explicitly authorized slice and
    rediscover its metadata first; do not invoke an invented target. These
    checks are contract/evidence checks, not installed OCR or publication proof.
  - Stop condition: a new run still writes schema-1 aggregate evidence,
    consumes/overwrites/returns/writes producer scope, writes a child wire or
    cleanup proof, lacks a complete semantic result, or has a non-exact
    invocation/result or child identity, anchor-only formal acceptance remains,
    candidate/prior refs are
    conflated, generated API view is hand-edited/deleted,
    `windowsml-ocr` is not mapped exactly to `windowsml_ocr`, or Cert waits for
    LAW/aggregates/mutates D8. Stop before D4/D7 staging or handoff.
  - Rollback: additive revert of the migration adapter and focused contract
    tests only; keep schema-1 compatibility reads/writes available until the
    producer protocol is ready, retain failed semantic evidence without
    publication, and do not alter runtime assets, receipts, stable-pointer
    state, or durable source rows.
  - Commit boundary: `feat(phase2): emit cert semantic result`; record the
    exact producer contract version/hash, invocation/result identity, red/green
    names, and the producer handoff SHA when its wire is later emitted. Do not
    add Cert-local privacy or cleanup fields.

- [ ] **Slice 5: candidate/active supervision adapter.** Expose only semantic
      readiness and terminal cleanup through a **proposed**
      `DesktopRuntimeSupervisor`; use one producer-owned `OwnedRuntimeSession`
      per active or candidate launch without exposing handles or PIDs.
  - Owned paths/symbols: **proposed**
    `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs`
    (`RuntimePromotionStore`, `RuntimePromotionReceiptV1`) for the local
    pointer/receipt only; `apps/cert-prep-desktop/src-tauri/src/lib.rs`
    (`run`) and `backend.rs` (`install_capture_runtime`, `start_capture_runtime`,
    `restart_owned_backend_with_capture_runtime`) as callers;
    `apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs`
    (`CaptureRuntimeState`, `CaptureRuntimeInner::terminate_child_process_tree`,
    `CaptureLaunchPolicy`),
    `apps/cert-prep-desktop/src-tauri/src/process_owner.rs`
    (`RuntimeProcessOwner`, `from_termination`, `terminate_once`,
    `owned_runtime_process!`),
    `apps/cert-prep-desktop/src-tauri/src/manifests.rs` (`verify_artifact`), and
     `apps/cert-prep-desktop/src-tauri/src/capture_manifest.rs`
     (`verify_capture_runtime`). The adapter name and its public methods are
     **proposed**; the producer's `OwnedRuntimeSession` is not a Cert symbol,
     and its session journal/proof remains producer-owned. The current Python
     `RuntimeInstallationManager`/`RuntimeInstaller` is not an adapter for
     this pointer or receipt.
  - Prerequisite: Slice 4 identity/root failure proofs are green and the
    producer session contract is available.
  - Red proof (write first): candidate readiness failure must terminate/prove
      only the candidate; active readiness and capture remain usable. A successful
      commit with a prior session enters `PriorRetiredDraining`; first install
      (`prior = null`) advances directly to `RetiredProved`/`not_applicable`.
      A prior session must not be claimed retired until producer proof reaches
      `RetiredProved`. A post-commit cleanup
      failure keeps the new active selected/degraded, retains the exact producer
       distinct candidate/prior reconcile refs and returned `proofSha256` values,
       blocks the next promotion, and retries at next start. A second cleanup
       call must return a real
     failure when proof is not available, never a false success from a
     consumed `FnOnce`. The adapter receives only the opaque producer
     `ReconcileRef` for the phase it owns and calls
      `RuntimeSessionJournal::reconcile(ref)`; it never assumes a local handle
      or substitutes candidate proof for prior retirement proof.
      On Cert restart, a still-running original producer may continue an
      existing live lease only when its exact ownership and all-root readiness
      are freshly verified; Cert never deserializes a permit or resumes a
      prepared/ready receipt. Producer restart or lost handle requires
      observe-only reconciliation and fresh refs/prepare after
      terminal/no-resource proof.
      A caller must not receive a native handle, bearer token, PID, or URL.
  - Verification: `corepack pnpm nx run cert-prep-desktop:cargo-test --skip-nx-cache`;
     `corepack pnpm nx run cert-prep-desktop:cargo-check --skip-nx-cache`;
     `corepack pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`.
  - Stop condition: candidate failure tears down active, cleanup is reported
    before it is proved, second-call cleanup is a false success, post-commit
    code rolls back the old active, or a proposed adapter becomes a second
    coordinator.
  - Rollback: additive revert of adapter wiring and focused tests; do not alter
    producer assets, durable source rows, or credentials.
  - Commit boundary: `feat(phase2): isolate cert runtime candidate sessions`;
    record terminate-and-prove evidence and SHA.

- [ ] **Slice 6: close, restart reconciliation, and durable handoff.** Cover
      normal/window close, readiness failure, runtime-root crash, host
      termination, and next-start identity reconciliation. Preserve durable
      runtime/model assets and an external Ollama baseline; remove only proven
      Cert-owned listeners, PIDs, run data, staging, and backups.
  - Owned paths/symbols: **proposed**
     `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs`
     (`RuntimePromotionStore`, `RuntimePromotionReceiptV1`) for durable local
     pointer/receipt reconciliation; `apps/cert-prep-desktop/src-tauri/src/lib.rs`
     (`run`) for startup wiring; `apps/cert-prep-desktop/src-tauri/src/backend.rs`
     (`install_capture_runtime`, `start_capture_runtime`,
     `restart_owned_backend_with_capture_runtime`) as callers;
     `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/persistence.py`
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
     `owned_runtime_process!`). The Python
     `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/manager.py`
     (`RuntimeInstallationManager`, `RuntimeInstaller`) remains model/provider
     installation only. Acceptance helpers are the existing
    `apps/cert-prep-desktop/scripts/packaged-flow-smoke/app-lifecycle.mts`
    (`closeAppAndCheckResidue`, `cleanupAfterRunWithTimeout`,
    `restartAndVerifyPersistence`) and
    `apps/cert-prep-desktop/scripts/process-residue-audit.mts`
    (`buildProcessResidueAuditReport`).
   - Prerequisite: Slices 2-5 are green; the producer
     `RuntimeSessionJournal::reconcile(ReconcileRef) -> ReconcileResult`
     contract is available; producer ordered JPEG then PDF page-1
    gate has a current cleanup proof before Cert starts.
  - Red proof (write first): inject leaked owned listener/PID/run directory,
     wrong-owner PID/path, stale reparse point, runtime-root crash, and a
     pre-existing Ollama PID. Prove owned residue is removed, unknown state and
     baseline survive, durable source/review/domain rows reload, and Cert never
     overlaps the LAW model slot. Also crash the store at every promotion
      edge: `commitIntent` plus prior pointer must not commit; `commitIntent`
      plus exact candidate pointer must advance to `NewActiveCommitted`, then
      to `RetiredProved`/`not_applicable` when `prior = null` or the proven
      no-session legacy prior evidence is revalidated, or persist
      `PriorRetiredDraining` when a prior session exists;
      candidate pre-commit cleanup must use only its candidate ref; prior
      post-commit retirement must use only its prior ref; absent/listener/staging
      proof may advance each independently; present, reused, unqueryable, or
      ambiguous observations must remain `reconcile-required`/degraded;
      unexpected pointers must be `InstallAmbiguous`; a missing producer ref
      must stay blocked on the applicable prior-session retirement path (first
      install and the proven no-session legacy prior have no prior ref and are
      `not_applicable`, with the latter requiring its documented evidence);
      restart must never replay a
      prepared/ready value or private permit, and only a verified live lease
      owned by the still-running original producer may continue semantically;
      producer restart/lost handle requires terminal/no-resource proof before
      fresh prepare; temp/root/backup/cache deletion must use exact cleanup refs
      only.
  - Verification: `corepack pnpm nx run cert-prep-backend:test --skip-nx-cache`;
     `corepack pnpm nx run cert-prep-desktop:cargo-test --skip-nx-cache`;
     `corepack pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`;
     `corepack pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`.
   - Stop condition: broad process-name kill, unknown residue deletion, durable
     asset deletion, nonterminal cleanup marked clean, a local-handle
      reconciliation assumption, candidate/prior ref or returned-proof
      substitution, or any
     Cert/Law overlap.
    Preserve failure evidence and do not hand off to LAW.
  - Rollback: additive revert of lifecycle/reconciliation changes; preserve
    durable assets and unproven residue for explicit manual recovery.
  - Commit boundary: `feat(phase2): prove cert runtime close handoff`;
    record cleanup/handoff evidence and SHA.

- [ ] **Slice 7: performance baseline before optimization.** Measure model-ready
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
  - Prerequisite: Slices 1-6 are green and the sequential private JPEG/PDF
    page-1 fixtures are available in the producer-assigned slot.
  - Red proof (write first): an evidence fixture that lacks a reproducible
    baseline or includes raw OCR/truth text, tokens, local paths, host names,
    or environment dumps must fail validation.
  - Verification: `corepack pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`;
    `corepack pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`;
    `corepack pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`.
  - Stop condition: measurement alters production behavior, includes unbounded
    diagnostics, or compares averages that hide a failed fixture/anchor.
  - Rollback: additive revert of measurement-only code and evidence schema;
    production capture behavior and durable records remain unchanged.
  - Commit boundary: `test(phase2): record cert OCR performance baseline`;
    record only privacy-safe baseline identities and metrics.

- [ ] **Slice 8: D4 pre-publication immutable-candidate acceptance and producer handoff.** Use the
      exact producer D3 bytes in Cert's installed real journey: JPEG first,
      cleanup/model-memory release, PDF page 1, restart persistence,
      review/export, and cleanup. Require producer `windowsml-ocr` provenance,
      Cert `windowsml_ocr`, JPEG CER <= 3%, PDF page-1 CER <= 1%, and zero
      missing critical anchors. Cert imports the exact producer
       future producer bundle/package `@capture-runtime/acceptance-contract`
       (proposed `packages/capture-acceptance-contract/`) and the exact
       D3-bound `contractSha256`; that package is the sole authority for the
       result schema/codec/manifest/hash and is absent at this checkpoint, so
       package/target creation is a discovery/creation stop. Cert consumes only
       the frozen/read-only D4 invocation from
       `CAPTURE_ACCEPTANCE_INVOCATION_PATH`, verifies its canonical digest, and
       atomically create-new exactly one package-defined
       `ConsumerSemanticResultV1` at `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`;
       the runtime contract-set identity (`contractSetSha256`) remains separate
       from the acceptance bundle hash;
      the producer owns mutable `CAPTURE_ACCEPTANCE_SCOPE_PATH`, validates the
      result, proves cleanup, and later writes `AcceptanceChildWireV1` at
      `CAPTURE_ACCEPTANCE_WIRE_PATH`. Cert never writes the scope/wire, waits
      for LAW, aggregates ledgers, or moves/mutates the producer stable pointer.
  - Owned paths/symbols: **proposed**
    `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs`
    (`RuntimePromotionStore`, `RuntimePromotionReceiptV1`) as the sole Cert
    local pointer/receipt owner, with `apps/cert-prep-desktop/src-tauri/src/backend.rs`
    (`install_capture_runtime`, `start_capture_runtime`) as callers;
    `apps/cert-prep-desktop/scripts/acceptance-artifacts.mts`
    (`writeAcceptanceManifest`) and its
    `apps/cert-prep-desktop/scripts/acceptance-artifacts.test.mts` tests;
    `apps/cert-prep-desktop/scripts/acceptance-real.mts`
     (`acceptancePassed`, caller/verdict only),
    `apps/cert-prep-desktop/scripts/acceptance-real-options.mts`
    (`createAcceptanceSmokeOptions`, `loadPhase1FinalCandidate`,
    `strictRuntimeIdentity`, and proposed private `FixtureCapabilityResolver`
    adapter for ordered fixture capabilities and full-truth oracle handles),
    `apps/cert-prep-desktop/scripts/ocr-truth-contract.mts`
    (`parseOcrTruthManifest`, `evaluateOcrTruth`),
    `apps/cert-prep-desktop/scripts/ocr-page-record-evidence.mts`
    (`assertOcrPageRecordEvidenceIntegrity`),
    `apps/cert-prep-desktop/scripts/phase1-acceptance-evidence.mts`
    (`buildPhase1AcceptanceEvidence`),
    `apps/cert-prep-desktop/scripts/phase1-final-identity.mts`
    (`loadPhase1FinalEvidence`),
    `apps/cert-prep-desktop/scripts/ocr-semantic-evidence.mts`
     (`serializePrivacySafeOcrSemanticEvidence`, `OCR_NORMALIZATION_VERSION`),
     and the candidate receipt's separate nullable candidate/prior
     `ReconcileRef` slots with only returned `proofSha256`,
    `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/mapping.py`
    (`capture_document_to_pdf_extraction`, `_ocr_only_extraction_method`), and
    `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/persistence.py`
    (`publish_capture_document`).
  - Prerequisite: Slices 1-7 and Slice 4.5 green, producer D3 candidate record complete,
     candidate root verified, and producer Capture JPEG -> PDF page-1 gate
     green with cleanup before Cert starts.
   - Red proof (write first): local URL-only transport, a supplied old
      executable, protocol fake, candidate with mismatched worker/contract,
      CER over threshold, missing anchor, garbage around otherwise present
      anchors, missing full private normalized reference, missing/false scoped
      lifecycle flag, writable/replaced invocation, canonical-digest/contract
      mismatch, reordered or incomplete fixture results, or incomplete cleanup
      must fail before a passing D4 semantic result or producer wire. Prove D4
       evidence is labeled pre-publication, Cert writes only one exact
       package-defined semantic result matching the ordered package invocation,
      the producer writes the child wire only after cleanup, and no producer
      stable pointer or aggregate ledger is changed. `anchorOnly` and
      `parseOcrAnchorExpectation` are deleted/prohibited in the formal path;
      full private normalized truth plus critical anchors is mandatory and
      synthetic anchor-only fixtures are unit-only.
  - Verification: `corepack pnpm nx run cert-prep-desktop:capture-candidate-gate-test --skip-nx-cache`;
     `corepack pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`;
     `corepack pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`.
  - Stop condition: candidate identity is incomplete, the semantic result is
      partial, invocation/result binding or canonical digest is wrong, result
      contains raw text/token/path/process data, D4 is reported as published
      acceptance, formal full-truth evaluation still accepts anchor-only input,
      Cert writes a wire/cleanup proof, waits for LAW, or writes an
      aggregate/stable-pointer mutation. Preserve the failed result and do not
      start LAW from a stopped Cert lane.
  - Rollback: apply Slice 4 transaction semantics. Before the local active
     commit, discard only isolated candidate staging and keep active untouched.
     After commit, do not restore the old active or producer stable pointer;
     keep the new active degraded with its exact candidate/prior reconcile refs
     and returned `proofSha256` values and retry or reconcile the relevant slot
     independently. Preserve the consumer semantic result and failure
     evidence; the producer emits no child wire until validation/cleanup pass.
   - Commit boundary: `test(phase2): accept immutable cert candidate`;
      record candidate hashes, exact producer contract version/hash, Cert D4
      semantic-result SHA, transaction state, and the producer cleanup/wire
      handoff only when producer-emitted.

- [ ] **Slice 9: D7 published download-back acceptance and producer handoff.**
      After D5 publishes the exact D3 bytes and D6 verifies download-back
      hashes, rerun the same Cert journey from downloaded bytes only. D7 is
      formal published acceptance. Cert imports the exact producer
       future producer bundle/package `@capture-runtime/acceptance-contract`
       (proposed `packages/capture-acceptance-contract/`) and the exact
       D6-bound `contractSha256`; that package is the sole authority for the
       result schema/codec/manifest/hash and is absent at this checkpoint, so
       package/target creation is a discovery/creation stop. Cert consumes only
       the frozen/read-only D7 invocation from
       `CAPTURE_ACCEPTANCE_INVOCATION_PATH`, verifies its canonical digest, and
       atomically create-new exactly one package-defined
       `ConsumerSemanticResultV1` at `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`,
       bound to D6. The runtime contract-set identity (`contractSetSha256`)
       remains separate from the acceptance bundle hash. The producer owns
       mutable `CAPTURE_ACCEPTANCE_SCOPE_PATH`,
      validates/cleans up, and later writes `AcceptanceChildWireV1` at
      `CAPTURE_ACCEPTANCE_WIRE_PATH`, then directs the handoff to LAW. Cert
      does not write the scope/wire, wait for LAW, aggregate consumer ledgers,
      or move/mutate/rollback the producer's stable pointer; the producer alone
      owns aggregation and D8 promotion.
  - Owned paths/symbols: **proposed**
    `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs`
    (`RuntimePromotionStore`, `RuntimePromotionReceiptV1`) as the sole Cert
    local pointer/receipt owner, with `apps/cert-prep-desktop/src-tauri/src/backend.rs`
    (`install_capture_runtime`, `start_capture_runtime`) as callers;
    `tools/capture-runtime-version.mts`
    (`CAPTURE_RUNTIME_RELEASE_BASE_URL`, `CAPTURE_RUNTIME_PACKAGE_NAME`,
    `CAPTURE_RUNTIME_CLIENT_PACKAGE_NAME`),
    `tools/capture-runtime-version-check.mts`
    (`assertCaptureRuntimeConsumerVersions`),
    `apps/cert-prep-desktop/scripts/acceptance-artifacts.mts`
    (`writeAcceptanceManifest`) and its
    `apps/cert-prep-desktop/scripts/acceptance-artifacts.test.mts` tests;
    `apps/cert-prep-desktop/scripts/acceptance-real.mts`
    (`acceptancePassed`, caller/verdict only),
    `apps/cert-prep-desktop/scripts/acceptance-real-options.mts`
    (`loadRuntimeCandidate`, `strictRuntimeIdentity`, and proposed private
    `FixtureCapabilityResolver` adapter for ordered fixture capabilities and
    full-truth oracle handles),
    `apps/cert-prep-desktop/scripts/phase1-final-identity.mts`
    (`loadPhase1FinalEvidence`),
    `apps/cert-prep-desktop/scripts/ocr-semantic-evidence.mts`
     (`serializePrivacySafeOcrSemanticEvidence`, `OCR_NORMALIZATION_VERSION`),
    and the separate `acceptance-real.mts` `sourceSuite.image` and
    `sourceSuite.pdf` child scopes,
    `apps/cert-prep-desktop/scripts/package-qa.mts` (`main`),
    `apps/cert-prep-desktop/src-tauri/src/capture_manifest.rs`
    (`verify_capture_runtime`, `validate_capture_manifest_contract`), and
     `apps/cert-prep-desktop/src-tauri/src/manifests.rs` (`verify_artifact`).
      There is no Cert stable-pointer or child-wire writer; producer scope,
      cleanup, aggregation, and D8 are outside this TODO's ownership. Cert's
      only formal output is the semantic result at
      `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`.
  - Prerequisite: Slices 1-8 and Slice 4.5 green; producer D5 publication and D6
     download-back record prove byte identity for the exact candidate; Cert has
     no local path/direct URL and no downstream LAW result is required to start
     or complete this Cert D7 run.
   - Red proof (write first): local candidate, mutable URL, URL/port-only match,
       stale 0.4.1 lock, mixed dependency, old executable, download-back byte
       mismatch, missing scoped JPEG/PDF fixture result, false lifecycle flag,
       writable/replaced invocation, canonical-digest/contract mismatch,
       reordered fixture result, garbage around anchors, missing full private
       normalized reference, or missing/substituted required session reconcile
       ref must fail (the proven no-session legacy prior requires its own durable evidence). Prove the run writes only Cert's exact package-defined D7
       `ConsumerSemanticResultV1`, matching the ordered package invocation; the
       producer emits its child wire only after validation/cleanup and directs
       it to LAW after green. Cert never writes the scope/wire, waits for LAW,
       or writes an aggregate ledger/stable-pointer mutation. Formal D7
       deletes/rejects `anchorOnly`/`parseOcrAnchorExpectation`; full private
       normalized truth plus critical anchors is mandatory and synthetic
       anchor-only fixtures are unit-only.
  - Verification: `corepack pnpm nx run cert-prep-desktop:release-tool-test --skip-nx-cache`;
     `corepack pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`;
     `corepack pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`.
     Producer aggregation and D8 stable-pointer promotion are external
     coordination outcomes, not something inferred from a local Cert target
     result; Cert verifies and hands off only its D7 semantic result for the
     producer to validate and turn into its child wire.
   - Stop condition: any artifact/lock/manifest/hash mismatch, local provenance,
      CER/anchor/cleanup failure, missing/partial Cert semantic result, invalid
      invocation/result binding or canonical digest, attempted Cert child-wire or cleanup write,
      attempted aggregate ledger, stable-pointer mutation, or wait for LAW is
      terminal. Do not hand off a failed result or claim a producer wire exists.
  - Rollback: apply Slice 4 transaction semantics for Cert's local install.
     Before commit, preserve the active root/session and discard only proven
     candidate staging. After commit, do not roll back the old active or the
     producer stable pointer; retain the new active degraded with its exact
       candidate/prior reconcile refs and returned `proofSha256` values while
       the relevant cleanup slot is retried/reconciled independently. Preserve
       the failed semantic result/evidence; the producer emits no wire until
       validation and cleanup pass, and do not relabel it green.
  - Commit boundary: `release(phase2): accept published capture-runtime bytes`;
      record exact published/download-back hashes, lockfile, manifests, Cert's
      D7 semantic-result SHA, and the producer-directed handoff to LAW when the
      producer wire exists. Producer aggregation and D8 are not part of this
      commit.

## Cross-slice rules

- New imports are OCR-only: producer `windowsml-ocr` maps to Cert durable
  `windowsml_ocr`; embedded PDF layers are ignored, and
  `direct_pdf`/`embedded`/`mixed` are legacy read-only values only.
- The UI decodes the exact generated producer `OcrComputePreflightV2` contract
  and displays producer-owned notice truth only. It never enumerates/ranks
  adapters, derives mode/reason/notice values, or retries a failed DirectML
  plan on CPU. Preserve the producer notice needed to tell the user CPU
  fallback was selected because no dGPU/iGPU was usable.
- Real model runs are sequential: Capture Workbench JPEG then PDF page 1,
  Cert Prep, then GX Law Prep. Each owner proves cleanup before handoff.
- Phase 1 is complete at `local-probe` only; it is not published or installed
   formal acceptance. Cert D4 is pre-publication candidate acceptance that
   consumes the future producer bundle/package
   `@capture-runtime/acceptance-contract` and exact D3-bound `contractSha256`;
   that package is the sole authority for the result schema/codec/manifest/hash
   and is absent at this checkpoint, so package/target creation is a
   discovery/creation stop. Cert consumes only the frozen/read-only invocation
   at `CAPTURE_ACCEPTANCE_INVOCATION_PATH`, verifies its canonical digest, and
   atomically create-new one exact package-defined `ConsumerSemanticResultV1`
   at `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`. Cert D7 repeats this from D6
   download-back bytes with a fresh invocation and the same exact result type at
   that distinct path. The runtime contract-set identity (`contractSetSha256`)
   remains separate from the acceptance bundle hash. The producer owns mutable
  `CAPTURE_ACCEPTANCE_SCOPE_PATH`, validates the result, proves cleanup, and
  later writes `AcceptanceChildWireV1` at `CAPTURE_ACCEPTANCE_WIRE_PATH`,
  aggregates child wires, and moves its stable pointer. Cert never writes the
  scope/wire, waits for LAW, aggregates ledgers, or owns D8. The package-defined
  ordered fixture assignments are supplied through the
   private `FixtureCapabilityResolver` adapter for the JPEG and scanned PDF
   page-1 capabilities; the package codec writes the exact ordered semantic
   result and only canonical measurements. No Cert-local privacy/cleanup fields
   or result-schema restatement is allowed. Full private normalized reference
   plus critical anchors is mandatory; formal D4/D7 deletes/prohibits
   `anchorOnly` and `parseOcrAnchorExpectation`, and a garbage-around-anchors
   result must not receive CER 0. Synthetic anchor-only fixtures are unit-only.
- Promotion is `CandidatePrepared -> CandidateReady -> NewActiveCommitted ->
    RetiredProved` for first install (`prior = null`) or the proven no-session legacy prior, and
    `CandidatePrepared -> CandidateReady -> NewActiveCommitted ->
    PriorRetiredDraining -> RetiredProved` for later promotions with a prior session. Pointer
    observations use the closed union `absent | present{generation,sha256}` in
    the receipt, intent, logical CAS, reread, and crash matrix. Persist the
    complete candidate group/root binding and verified sink receipt through the
    producer `ReconcileRefSink` before activation; call producer
    `activate_group(prepared)` with its live-only move-only `PreparedGroup`,
    wait for all-root loaded-worker/readiness identity, and only then flush
    `CandidateReady`. The private permit inside `PreparedGroup` is never
    serialized or persisted by Cert. Candidate/prior group and reconcile refs
    are distinct and no `ProofRef` exists. On restart, only a verified live
    lease owned by the still-running original producer may continue
    semantically; otherwise old refs reconcile observe-only and fresh
    refs/prepare follow terminal/no-resource proof. First install
  uses compare-and-create-if-absent with prior observation `absent`,
  `retirement.status = not_applicable`, keeps degraded/block-next-promotion
  false, and requires no predecessor proof. For a later promotion with a prior session, the new
  active remains selected/degraded and the next promotion is blocked until
  `RuntimeSessionJournal::reconcile(priorReconcileRef)` returns complete proof;
  retain only returned `proofSha256` values in the separate nullable candidate /
  prior ref slots. Cleanup is retried/reconciled at next start; the producer API
  is observe-only after restart. The proposed `RuntimePromotionStore` in
  `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs` is the sole Cert
  local pointer/receipt owner; it is distinct from the producer session journal
  and D8 stable pointer. A file install is `Restored` only with proof; otherwise
  it is `InstallAmbiguous`.
- Audio transcription/translation is a separate domain and acceptance lane,
  not an OCR Phase 2 requirement.
- Image-flow changes require design and both review axes before code; TDD red
  tests cross the public seam; staging is isolated before installed evidence.
- The historical [lazy-install decision](../DECISIONS/lazy-capture-runtime-installation.md)
  and [packaged-smoke spec](../SPECS/packaged-capture-workbench-smoke.md) remain
  for traceability. No lazy/package TODO files exist; do not invent or revive
  those references as active work.
