# Capture Runtime 0.4.2 Cert Prep consumer decisions

## 2026-09-09 checkpoint

Phase 1 is complete at the `local-probe` tier. Capture Workbench, Cert Prep,
and GX Law Prep each passed real local-package OCR, and Cert Prep's
local-package OCR evidence is accepted at that tier. This is not published or
release evidence: the formal `capture-runtime` 0.4.2 candidate/package remains
unbuilt and unpublished.

Capture Workbench PR #39 (`c6d2140`), Cert Prep PR #19 at
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

These decisions describe the consumer delta. The producer's canonical Phase 2
specification remains the authority for OCR internals, compute truth, and
native ownership details.

The companion [consumer specification](../SPECS/capture-runtime-consumer.md)
defines the interface comparison and [active TODO](../TODOS/capture-runtime-consumer.md)
defines the executable slices. The producer source is referenced portably as
`capture-workbench/.agents/SPECS/capture-runtime-042-p2-hardening.md`; no
machine-specific path is part of this decision.

## Chosen decisions

1. **Cert owns durable product state.** Cert Prep owns durable sources, domain
   records, review overrides, export, and persistence. Capture Runtime owns
   the ephemeral job and is the sole OCR projection owner. Cert maps and
   persists the typed projection; it does not create a second OCR policy.
2. **The new source contract is OCR-only.** New PDF and image imports write
   only `windowsml_ocr` capture projections. `embedded` and `mixed` are
   fail-closed at the new import seam. Existing rows with those values remain
   read-only compatibility data and are never a route or a new write target.
3. **Desktop adapters stay thin at the producer seam.** **Proposed**
   `DesktopRuntimeSupervisor` and **proposed** `RuntimeAssetInstaller` are
   design candidates over the existing Rust functions; neither is a current
   Cert symbol. They do not own a model, preprocessing, device ranking,
   inference, or process policy. Native handles and bearer tokens remain below
   the desktop/backend seam.
4. **Candidate and active sessions are isolated.** Every active and candidate
   launch has its own producer-owned `OwnedRuntimeSession` interface (not a
   current Cert symbol). A failed candidate is terminated and proved
   independently; it never tears down the active session before commit. The
   atomic pointer commit selects the new active, then retirement drains the
   prior session until producer proof reaches `RetiredProved`; a retirement
   failure leaves the new active selected/degraded and is retried, not rolled
   back to the old active.
5. **Close and recovery preserve durable assets.** App close clears owned
   listeners, PIDs, run data, and staging while leaving durable runtime/model
   assets and caches. A pre-existing external Ollama process is a baseline and
   survives. Next-start reconciliation may remove only stale state whose
   app-owned identity is proven; ambiguous state fails closed.
6. **The UI presents producer truth.** Cert decodes the exact generated public
   `OcrComputePreflightV2`/`RuntimeReady` contract and displays its
   producer-owned notice. It never ranks adapters, derives an ordinal or
   device id, translates a reason into local copy, or recomputes a
   mode/adapter/reason/notice matrix. The producer response retains enough
   notice truth (`mode`, `reasonCode`, `userNoticeRequired`, and `noticeCode`
   or the contract's equivalent notice payload) to tell the user about CPU
   fallback when no dGPU/iGPU is usable. Post-selection DirectML failure is
   terminal and receives no host CPU retry.
7. **Identity is tiered by evidence.** For local candidates, URL and port
   identify transport only and do not bind repository HEAD. Contract/schema,
   archive boundary, package/provenance, and loaded runtime-worker identity
   are hard gates. Clean install rejects sibling junctions, source-tree or
   local-path substitution, `direct_url`/path provenance, and mixed versions
   wherever applicable. Published acceptance instead requires strict exact
   0.4.2 locks, hashes, manifests, and download-back byte identity with no
   local provenance.
8. **Phase 2 owns hardening and release preparation.** `pnpm@12.0.0` remains
   current and Nx is currently `23.1.0`; Phase 2 owns the upgrade to `23.1.2`,
   lifecycle and performance work, version inventory, deterministic candidate
   staging, and then sequential formal/published-package regression. No such
   upgrade or release claim is made by this local-probe checkpoint.
9. **Real evidence is sequential and private.** Acceptance uses a real
    private JPEG and PDF page 1, then proves Cert cleanup before handing the
    model slot to GX Law Prep. Cert writes only its own child ledger and hands
    it off; it does not wait for LAW or aggregate consumer ledgers. Restart
    persistence, review/export, cleanup, and baseline survival are required.
    JPEG CER must be <= 3%, scanned PDF page-1 CER must be <= 1%, and critical
    anchors must have zero omissions. Raw OCR/truth text, tokens, paths, and
    host-specific diagnostics never enter a manifest.
10. **Design gates precede image-flow code.** The image/PDF design receives
    both an independent Standards review and an independent Specification
    review before code. Implementation uses TDD red tests at the public seam,
    deterministic staging, small vertical slices, and exact-HEAD approvals.
11. **Cert acceptance has two named events and a bounded handoff.** D4
    `CandidateAccepted` consumes one immutable, pre-publication candidate and
    writes only Cert's candidate child ledger. On green it hands that ledger
    back to the producer publication lane. After D5 publication and D6
    download-back byte verification, D7 `PublishedAccepted` repeats the same
    installed journey using only the downloaded bytes and writes only Cert's
    published child ledger. On green it hands that ledger to LAW. Cert never
    waits for downstream LAW, aggregates ledgers, or moves a shared stable
    pointer.
12. **Immutable roots and a non-rollback promotion transaction are explicit.**
    A **proposed** active root and **proposed** candidate root are immutable,
    separate content identities under the app-owned runtime root. Only a
    verified, durable, content-addressed cache may be shared. Promotion is
    `CandidateReady -> NewActiveCommitted -> PriorRetiredDraining ->
    RetiredProved`, with an atomic active-pointer replacement at commit. Before
    commit, failure preserves the active root/pointer/session. After commit,
    there is no rollback to the old active: the new active remains selected and
    degraded, blocks the next promotion, retains the exact opaque producer
    session/proof refs, and retries/reconciles cleanup at next start. A file
    install is `Restored` only after the prior root, manifest, byte count,
    content hash, and session identity are re-proved; otherwise it is
    `InstallAmbiguous`. Replace the current one-shot `RuntimeProcessOwner`
    `FnOnce` termination seam; a second termination call must never return a
    false success.
13. **Projection strings are not interchangeable.** Producer
    `provenance.engine == "windowsml-ocr"` maps through the existing
    `mapping.py` seam to Cert durable `documents.extraction_method` and page or
    chunk `extraction_method == "windowsml_ocr"`. Embedded PDF layers are
    ignored. No new document/page/chunk may write `embedded` or `mixed`; those
    values remain legacy read compatibility only.
14. **Version-first is a hard stop.** The first executable Phase 2 slice is
    the `pnpm@12.0.0`/Nx `23.1.2` upgrade plus one complete
    version/projection inventory for API `2.0`, typed projection schema `3`,
    and the exact producer-generated contract SHA-256. No candidate root,
    shared cache, active pointer, or acceptance staging may be created until
    that slice is green. Current Nx `23.1.0` and the 0.4.1 baseline are facts,
    not a passing Phase 2 gate; no contract digest is invented in advance.
15. **Compute-policy deletion is first-class.** Once the producer-generated
    public contract is available, retain and regenerate the generated
    consumer view
    `libs/cert-prep-api/src/lib/cert-prep-api.generated.ts`; it is never
    hand-edited or deleted. Delete only the fallback DTO and validator in
    `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/host_models.py`,
    `CertPrepCaptureCoordinator._assert_ocr_compute_preflight` in
    `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/coordinator.py`,
    the candidate decoder shim in
    `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/client.py`,
    frontend `mapOcrCompute` from
    `apps/cert-prep/src/app/pages/capture-workbench-trial/cert-prep-capture-client.ts`,
    duplicate `OcrCompute*` contract types from
    `apps/cert-prep/src/app/pages/capture-workbench-trial/contracts/capture-workbench-trial.contracts.ts`,
    and hardcoded preflight-store messages/matrices from
    `apps/cert-prep/src/app/stores/capture-runtime/capture-runtime-preflight.store.ts`.
    Replace policy-only tests with pass-through tests at the retained
    generated public seam. Preserve producer-owned notice truth so the UI can
    say CPU fallback when no dGPU/iGPU is usable; Cert does not recalculate it.
16. **Audio is a separate lane.** Audio transcription/translation remains in
    its domain specification and is not part of the OCR-only Phase 2 D4/D7
    acceptance or its handoff ledger.
17. **One Cert-owned local pointer and receipt owner.** The proposed
    `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs` module defines
    `RuntimePromotionStore` and `RuntimePromotionReceiptV1` as the sole owner
    of the local installed-runtime logical active pointer, revision/CAS, and
    durable promotion receipts. The module is not yet implemented and is not
    the producer session journal or producer D8 stable pointer. Its receipt
    records candidate/prior content identities, pointer generations/hashes,
    state, commit intent, degraded/block-next-promotion flags, opaque
    producer session/proof refs, retirement attempts/status, exact cleanup
    refs, and sanitized errors; raw paths, tokens, PIDs, and OCR are forbidden.
    `capture_runtime.rs` verifies/stages/launches, `backend.rs` invokes the
    store from `install_capture_runtime`, `start_capture_runtime`, and
    `restart_owned_backend_with_capture_runtime`, `lib.rs` wires the module
    and startup reconciliation, and `process_owner.rs` supplies the planned
    retryable proof/cleanup seam. The Python
    `RuntimeInstallationManager`/`RuntimeInstaller` scope in
    `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/`
    remains provider/model installation and never writes this pointer or
    receipt.
18. **Promotion ordering is irreversible after local pointer commit.** Verify
    the immutable candidate/root; flush `CandidateReady`; flush
    `commitIntent` with the expected prior pointer; take the store lock,
    perform the logical CAS/atomic pointer replace and flush it, then reread it; flush
    `NewActiveCommitted`; persist `PriorRetiredDraining` before cleanup; ask
    the producer for proof through the retained retryable opaque ref; and
    flush `RetiredProved` before optional exact prior-root deletion. Before
    commit, failures preserve active. After commit, never roll back: keep the
    new active selected/degraded and block the next promotion until proof.
    Startup reconciliation treats intent plus prior pointer as no commit,
    intent plus candidate pointer as committed, and an unexpected pointer as
    `InstallAmbiguous`; missing producer refs remain blocked, and temporary,
    root, backup, or cache deletion uses only exact receipt refs.

## Why these decisions are consumer-specific

The consumer needs only a small interface: authenticated readiness, typed OCR
projection, lifecycle status, and durable domain persistence. Keeping the
complexity behind the producer seam gives Cert Prep leverage and preserves
locality: a producer policy change is fixed in one owner rather than copied
into the backend, desktop adapter, and UI. The adapters remain replaceable
without widening the public contract.

The local identity exception is deliberate. A local candidate must be
debuggable before publication, but a URL or current repository HEAD is not a
runtime identity. Contract/archive/provenance and loaded executable identity
are therefore hard gates for local transport; release and published checks
use stricter immutable bytes and frozen locks.

## Existing owner map

The selected design is grounded in current symbols, not planned names:

| Concern | Existing owner and symbols |
| --- | --- |
| OCR projection validation | `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/ocr_summary.py`: `CaptureOcrSummaryRead`, `CaptureOcrResolvedProvenanceRead`, `build_ocr_summary`, `_map_provenance` |
| Engine-to-discriminator mapping | `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/mapping.py`: `capture_document_to_pdf_extraction`, `_ocr_only_extraction_method` |
| Durable commit/recovery | `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/persistence.py`: `publish_capture_document`; `apps/cert-prep-backend/src/cert_prep_backend/domains/source_documents/operations.py`: `create_and_attach_document`, `begin_capture_review_commit`, `publish_success`, `finish_failed`, `recover_operations` |
| Draft job ordering | `apps/cert-prep-backend/src/cert_prep_backend/domains/mock_exams/draft_jobs.py`: `enqueue_chunk_job`, `recover_runnable_jobs`, `begin_commit`, `request_cancel` |
| Install/manifest verification | `apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs`: `install_bundled_capture_runtime`, `installed_capture_runtime_paths`, `replace_runtime_directory`; `apps/cert-prep-desktop/src-tauri/src/manifests.rs`: `RuntimeManifest`, `RuntimeArtifact`, `load_runtime_manifest`, `verify_artifact` |
| Runtime identity/cleanup | `apps/cert-prep-desktop/src-tauri/src/capture_manifest.rs`: `verify_capture_runtime`, `validate_capture_manifest_contract`, `capture_runtime_expected_version`; `apps/cert-prep-desktop/src-tauri/src/process_owner.rs`: `RuntimeProcessOwner`, `terminate_once`, `owned_runtime_process!` |
| Local installed-runtime pointer/receipt (planned) | **Proposed** `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs`: `RuntimePromotionStore`, `RuntimePromotionReceiptV1`; `apps/cert-prep-desktop/src-tauri/src/lib.rs`: `run`; `apps/cert-prep-desktop/src-tauri/src/backend.rs`: `install_capture_runtime`, `start_capture_runtime`, `restart_owned_backend_with_capture_runtime` | Sole Cert owner of the local logical pointer and durable promotion receipt/reconciliation. It is distinct from the producer session journal and producer D8 stable pointer; current symbols do not exist. |
| Python backend installer (separate) | `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/manager.py`: `RuntimeInstallationManager`, `RuntimeInstaller`; `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/installers.py`: `LLMModelInstaller` | Owns provider/model requirement jobs and snapshots only; it never writes the desktop local runtime pointer or receipt. |

## Design-It-Twice selection

Three **proposed** interface shapes were compared before selecting the seam;
none of these proposed names is an existing Cert symbol.

| Candidate | Usage and hidden internals | Dependencies/adapters | Trade-off and decision |
| --- | --- | --- | --- |
| **proposed `CaptureRuntimeFacade`** | `facade.capture(candidate, upload) -> receipt`; hides auth, roots, session, projection, mapping, and durable commit. | Installed runtime remote-owned; filesystem local-substitutable; SQLite durable; deterministic receipt test adapter. | Deep for one caller but fuses unrelated failure modes and risks a second coordinator. Rejected. |
| **proposed explicit ports**: `RuntimeAssetInstaller`, `DesktopRuntimeSupervisor`, `OcrProjectionMapper` | `installer.prepare(candidate)`, `supervisor.start(verified)`, `mapper.map(projection)`; hides manifest/hash, producer session/pointer, and discriminator details. | Existing Rust verification functions are native filesystem adapters; producer session is remote-owned; existing Python owners are domain adapters; failure-injection fakes are test adapters. | More interface knowledge, but high leverage/locality and readable typed failures. Selected. |
| **proposed `CaptureRuntimePromotion`** | `prepare(candidate) -> CandidateReady`; `commit(candidate) -> NewActiveCommitted`; `reconcile(receipt) -> RetiredProved or InstallAmbiguous`; hides cache, pointer journal, retirement proof, readiness, and publication. | Filesystem/pointer local-substitutable; producer session remote-owned; journal fixture test adapter. | Common caller is simple, but promotion becomes coupled to persistence and harder to test independently. Rejected. |

The rejected public `CaptureRuntimePromotion` facade does not preclude the
proposed internal `RuntimePromotionStore`. The store is a deep persistence
module behind the selected explicit ports: it owns only Cert's local pointer,
receipt, CAS, and crash reconciliation, while the ports retain responsibility
for verification, lifecycle, projection mapping, and durable domain commits.

The selected explicit ports retain the existing public seams: `build_ocr_summary`
validates the typed projection, `capture_document_to_pdf_extraction` performs
the exact `windowsml-ocr` -> `windowsml_ocr` mapping, and
`publish_capture_document`/`operations.publish_success` own durable commit.
The deletion test is that removing one of these modules would otherwise spread
page-order, identity, persistence, or cleanup complexity across callers; if a
new proposed facade merely forwards calls and fails this depth test, it is not
implemented.

## Rejected alternatives

- **Host OCR or embedded-text fallback:** rejected because it creates a second
  projection owner and makes PDF/image behavior differ from the producer.
- **Host GPU ranking, CPU retry, or copied preflight matrices:** rejected
  because readiness could disagree with the executing plan, hide a DirectML
  defect, and drift from the generated producer contract.
- **One shared active/candidate process tree:** rejected because a failed
  candidate could destroy a working active session.
- **Broad process-name cleanup:** rejected because it can terminate the
  pre-existing Ollama baseline or another user's process.
- **URL/port or repository HEAD as candidate identity:** rejected because
  transport location and source state do not prove the loaded archive or
  worker bytes.
- **Calling a local package smoke published acceptance:** rejected because
  local paths, `direct_url`, sibling junctions, and mixed locks can masquerade
  as a release.
- **Copying producer Phase 2 policy into Cert docs:** rejected because the
  duplicated truth table and lifecycle rules would drift. Cert links to the
  canonical producer documents instead.
- **Treating historical documents as active task files:** rejected because
  only the existing [lazy-install decision](lazy-capture-runtime-installation.md)
  and [packaged-smoke spec](../SPECS/packaged-capture-workbench-smoke.md) are
  present; they are historical source documents, not active task owners.

## Supersession, review, and documentation rollback

This record supersedes older Cert statements that denied the completed Phase 1
local-probe gate, treated local-probe evidence as published/release acceptance,
or allowed embedded/mixed output for a new import. The historical [lazy-install
decision](lazy-capture-runtime-installation.md) and [packaged-smoke
spec](../SPECS/packaged-capture-workbench-smoke.md) remain only for traceability;
there are no corresponding TODO files. Their body text does not define D4/D7,
the immutable root/pointer contract, or the current projection mapping.

The review unit is the exact documentation commit. Any subsequent commit,
generated artifact, or rebase invalidates both review axes. The rollback is an
additive revert of the documentation commit only; runtime assets, database
records, lockfiles, and published artifacts are untouched.
