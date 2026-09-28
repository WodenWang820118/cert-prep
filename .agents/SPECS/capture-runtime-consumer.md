# Capture Runtime 0.4.2 Cert Prep consumer delta

This document is the Cert Prep consumer specification for the OCR-only
0.4.2 cutover and its Phase 2 hardening follow-up. It defines what this
repository must consume and prove. Producer implementation policy remains in
Capture Workbench's canonical Phase 2 documents; this document does not copy
that policy.

## Status

Capture Runtime 0.4.2 was published on 2026-09-27 and Cert Prep pins it on
`main`. The canonical JPEG passed published-mode practical OCR in the installed
app, and the Capture consumer gate passed for the 0.4.2 release candidate.
Open consumer work is tracked in the [consumer TODO](../TODOS/capture-runtime-consumer.md)
and the [acceptance TODO](../TODOS/cert-prep-pdf-image-acceptance.md).

## Purpose and non-goals

Cert Prep owns the durable product experience around a capture. It consumes
the runtime's typed OCR projection through its public/generated seam and keeps
the domain state useful after the ephemeral runtime job ends.

This specification does not authorize:

- a Cert Prep PaddleOCR, PDF rasterization, embedded-text, mixed-arbitration,
  OCR-provider, or host CPU-retry implementation;
- host-side GPU enumeration, ranking, device-ID persistence, model creation,
  preprocessing, inference, or process-name cleanup;
- treating local-probe evidence, a package smoke, snapshot, or successful
  command as published-release proof, or treating a protocol fake as real OCR
  proof; or
- deleting the existing lazy-install/package-smoke specifications before
  their relevant consumer content is merged here.

Audio transcription remains a separate Capture Runtime domain and acceptance
lane. It is not folded into the OCR-only Phase 2 D4/D7 checklist.

The companion records are [the consumer decision record](../DECISIONS/capture-runtime-consumer.md),
[the active implementation TODO](../TODOS/capture-runtime-consumer.md), and
[the real PDF/image acceptance TODO](../TODOS/cert-prep-pdf-image-acceptance.md).
The producer policy is referenced by its portable repository-relative name,
`capture-workbench/.agents/SPECS/capture-runtime-042-p2-hardening.md`; it is
not a Cert Prep file and is not copied into this specification.

The acceptance seam consumes only the future producer package/bundle
`@capture-runtime/acceptance-contract` (proposed at
`packages/capture-acceptance-contract/`) and the literal D3/D6-bound
`contractSha256` recorded for those immutable bytes. That package/bundle is the
sole acceptance schema, codec, manifest, and hash authority; it is not present
at this checkpoint, so its package/target creation is a producer discovery and
creation stop. `ProducerChildScopeV1`, `ProducerChildInvocationV1`,
`ConsumerSemanticResultV1`, and `AcceptanceChildWireV1` are consumed exactly as
exported by that bundle: Cert defines no local fields, extensions, validators,
or competing wire and does not restate the producer schema. The runtime
contract-set used by `RuntimeReady` and the typed OCR projection is separate
(`contractSetVersion`/`contractSetSha256`); the acceptance bundle hash and
runtime contract-set hash are never compared or substituted.

## Responsibility and seam

| Concern | Owner | Cert Prep consumer rule |
| --- | --- | --- |
| Durable sources and domain records | Cert Prep | Persist source identity and domain data; runtime jobs are ephemeral. |
| Review override and export | Cert Prep | Apply the local review overlay, retain user overrides, and export the domain result. |
| Persistence and restart recovery | Cert Prep | Reconcile durable source/review state across app restarts; do not persist a runtime process as domain state. |
| OCR projection | `capture-runtime` | The runtime is the sole OCR projection owner. Cert maps the typed projection and does not recreate it. |
| Compute decision and notice | `capture-runtime` | The producer owns adapter selection, mode/reason semantics, and the CPU-fallback notice. Cert decodes the exact generated public contract and displays producer notice truth without recomputation. |
| Runtime/model installation | **Proposed** `RuntimeAssetInstaller` adapter over the existing Rust installation/manifest functions | Verify and stage producer assets; do not choose models or invent a second install policy. The name is a design candidate, not a current Cert symbol. |
| Runtime process lifecycle | **Proposed** `DesktopRuntimeSupervisor` adapter over the existing `CaptureRuntimeState`/`RuntimeProcessOwner` seams | Present product status and invoke the producer-owned session seam; do not own native process policy. The name is a design candidate, not a current Cert symbol. |
| Local installed-runtime pointer and promotion receipt | **Proposed** `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs`: `RuntimePromotionStore`, `RuntimePromotionReceiptV1` | Sole Cert owner of the local logical active pointer and its durable receipt/reconciliation record. This is not the producer session journal or producer D8 stable pointer. The module does not exist yet. |

The proposed adapter names above do not exist in the current checkout. Until a
slice creates one and records its public interface, the real owners remain the
paths and symbols below. They do not own a model, preprocessing, device
ranking, inference, Windows process policy, or broad cleanup rule. A raw Job
handle, process handle, sidecar bearer token, or runtime URL never crosses the
Angular/WebView seam.

## Existing Cert owners and symbols

These are the implementation owners a fresh worker must inspect before a code
slice. A symbol is listed as existing only when it is present at the stated
path; names marked **proposed** are design candidates and must not be used as
if they were already implemented.

| Owner concern | Existing path and symbols | Required responsibility |
| --- | --- | --- |
| Typed OCR projection | `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/ocr_summary.py`: `CaptureOcrSummaryRead`, `CaptureOcrResolvedProvenanceRead`, `build_ocr_summary`, `_map_provenance` | Validate the authenticated schema-3 projection and allowlist provenance/page evidence. |
| Producer-to-Cert mapping | `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/mapping.py`: `capture_document_to_pdf_extraction`, `capture_document_to_audio_segments`, `_ocr_only_extraction_method` | Map the producer projection without reading a PDF embedded layer or creating a second OCR route. |
| Durable capture publication | `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/persistence.py`: `publish_capture_document`; `apps/cert-prep-backend/src/cert_prep_backend/domains/source_documents/operations.py`: `create_and_attach_document`, `mark_capture_review_pending`, `begin_capture_review_commit`, `publish_success`, `publish_capture_audio_success`, `finish_failed`, `recover_operations` | Keep source/review/domain records durable and commit or fail them atomically. |
| Draft-job lifecycle | `apps/cert-prep-backend/src/cert_prep_backend/domains/mock_exams/draft_jobs.py`: `enqueue_chunk_job`, `recover_runnable_jobs`, `begin_commit`, `request_cancel`, `mark_canceled`, `mark_failed` | Keep generation jobs downstream of durable source publication and preserve cancel/commit ordering. |
| Python backend installer (separate scope) | `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/manager.py`: `RuntimeInstallationManager`, `RuntimeInstaller`; `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/installers.py`: `LLMModelInstaller` | Own provider/model requirement jobs and snapshots only; never write the desktop local installed-runtime pointer or promotion receipt. |
| Runtime installation and launch | `apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs`: `CaptureRuntimeState::launch_cancellable`, `install_bundled_capture_runtime`, `installed_capture_runtime_paths`, `replace_runtime_directory`, `clean_stale_capture_runtime_staging`, `CaptureLaunchPolicy`; `apps/cert-prep-desktop/src-tauri/src/manifests.rs`: `RuntimeManifest`, `RuntimeArtifact`, `load_runtime_manifest`, `write_installed_manifest`, `verify_artifact` | Verify immutable bytes, launch only verified resources, and isolate candidate failure from active state. |
| Runtime manifest and cleanup seams | `apps/cert-prep-desktop/src-tauri/src/capture_manifest.rs`: `verify_capture_runtime`, `validate_capture_manifest_contract`, `capture_manifest_expectations`, `capture_runtime_expected_version`; `apps/cert-prep-desktop/src-tauri/src/process_owner.rs`: `RuntimeProcessOwner`, `from_termination`, `terminate_once`, `owned_runtime_process!`, `sanitize_termination_error` | Keep manifest/schema identity and owned-process cleanup fail-closed and privacy-safe. |
| Local installed-runtime pointer/receipt (planned) | **Proposed** `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs`: `RuntimePromotionStore`, `RuntimePromotionReceiptV1`; `apps/cert-prep-desktop/src-tauri/src/lib.rs`: `run`; `apps/cert-prep-desktop/src-tauri/src/backend.rs`: `install_capture_runtime`, `start_capture_runtime`, `restart_owned_backend_with_capture_runtime` | Sole Cert owner of the local logical pointer, revision/CAS, receipt, and startup reconciliation. It is distinct from the producer session journal and D8 stable pointer; no current implementation exists. |
| Host compute-policy cleanup (planned) | `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/host_models.py`: fallback `OcrComputePreflightV2` and `_validate_decision`; `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/coordinator.py`: `CertPrepCaptureCoordinator._assert_ocr_compute_preflight`; `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/client.py`: `_install_candidate_runtime_ready_decoder`; `apps/cert-prep/src/app/pages/capture-workbench-trial/cert-prep-capture-client.ts`: `mapOcrCompute`; `apps/cert-prep/src/app/pages/capture-workbench-trial/contracts/capture-workbench-trial.contracts.ts`: `OcrComputeMode`, `OcrAdapterClass`, `OcrComputeReasonCode`, `OcrComputeNoticeCode`, `OcrComputePreflight`; `apps/cert-prep/src/app/stores/capture-runtime/capture-runtime-preflight.store.ts`: `GPU_ACCELERATION_MESSAGE`, `CPU_FALLBACK_MESSAGE`, `gpuAccelerationMessage`, `cpuFallbackNotice` | After the producer-generated public contract exists, retain/regenerate `libs/cert-prep-api/src/lib/cert-prep-api.generated.ts` and delete only the fallback DTO/validator/decoder shim and local GPU mode/adapter/reason/notice matrices. Never hand-edit or delete the generated consumer view. Preserve producer-owned notice fields needed to tell the user about CPU fallback. |

The current Rust installation path uses `app_data_dir/runtimes` and a
`capture-runtime` directory; an `active/`, `candidate/`, or pointer layout is
not yet an existing symbol. Any such layout in the next sections is explicitly
**proposed** until an implementation slice adds it.

### Proposed local promotion receipt seam

Cert Prep's sole owner for the local installed-runtime pointer and its durable
promotion receipt is the **proposed** module
`apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs`, with the
**proposed** `RuntimePromotionStore` implementation and
`RuntimePromotionReceiptV1` record. Neither symbol exists in this checkout.
The first implementation slice must add `mod runtime_promotion;` in
`apps/cert-prep-desktop/src-tauri/src/lib.rs` and construct/reconcile the store
from the Tauri setup/startup path. `backend.rs` callers
`install_capture_runtime`, `start_capture_runtime`, and
`restart_owned_backend_with_capture_runtime` request promotion or
reconciliation; `capture_runtime.rs` remains the adapter that verifies,
stages, launches, and reports the runtime; and `process_owner.rs` remains the
cleanup/proof seam. These callers must not write a second pointer or receipt.

The store is an internal durable persistence module, not a new public facade or
second coordinator. It owns the logical pointer record, its compare-and-swap
(CAS) revision, atomic receipt writes, and startup reconciliation. Filesystem
adapters may resolve internal roots, but persisted receipts contain logical
references and content identities only. The producer's session journal and
retryable reconcile operations remain producer-owned; the store records only
distinct candidate/prior opaque `ReconcileRef` values and their returned
`proofSha256` values. The producer's shared
release stable pointer and D8 ledger aggregation remain outside Cert authority.

`RuntimePromotionReceiptV1` must be sufficient to reconcile a crash without
reading a private path or secret. Its path-free fields are:

Every pointer observation uses the closed union
`absent | present{generation,sha256}`. This union is used in the receipt's
active/prior observations, `commitIntent`, logical CAS expected/observed values,
the locked post-replace reread, and the startup crash matrix. `prior = null`
below means that no prior `ContentIdentityV1` exists; its pointer observation is
`absent`. Null, omitted, or free-form pointer observations are invalid.

| Field | Required contents and invariant |
| --- | --- |
| `schemaVersion`, `promotionId`, `state`, `revision` | `1`; a non-secret logical promotion id; one of `CandidatePrepared`, `CandidateReady`, `NewActiveCommitted`, `PriorRetiredDraining`, `RetiredProved`, `LegacyAdoptionPrepared`, `LegacyAdopted`, or `InstallAmbiguous`; and a monotonically increasing durable revision. |
| `candidate`, `prior` | Runtime content identities for the candidate and prior active (prior may be `null` on first install), including the independent runtime `contractSetSha256` and verified byte identity; acceptance-bundle identity is recorded separately as the producer's `contractSha256` and is never substituted for the runtime contract-set. |
| `candidateGroup`, `priorGroup` | Separate producer whole-group bindings with the complete path-free `CompleteGroupBinding` tuple: binding-attempt identity, plan digest, opaque group ref/digest and immutable group generation, and every ordered root ref/digest, role/ordinal, immutable root generation, spec digest, and reserved-listener identity. `candidateGroup` is required in `CandidatePrepared`, `priorGroup` is `null` when `prior = null` or for the proven no-session legacy prior, and the two group bindings are never substituted for one another. |
| `activationReceiptDigest` | The verified `CompleteGroupBindingReceiptV1` digest returned by the producer sink after `persist`, `read_back`, and `verify`. `CandidatePrepared` stores that verified receipt together with the complete candidate group/root binding; the producer-private `PreparedGroup`, `GroupLease`, and `ActivationPermitV1` never appear in the Cert receipt. |
| `activePointer`, `priorPointer` | `PointerObservation` values in the closed union `absent | present{generation,sha256}` for the selected and prior values; hashes are over canonical pointer bytes, not a path. |
| `cas` | `expectedRevision`, `expectedPointer: PointerObservation`, `observedRevision`, `observedPointer: PointerObservation`, and a bounded result (`matched`, `replaced`, `conflict`, or `ambiguous`). A conflict never silently retries against a different prior. |
| `commitIntent` | `null` before intent, otherwise the expected prior `PointerObservation`, intended candidate `PointerObservation`, and expected revision. It is flushed before any pointer replacement. |
| `degraded`, `blockNextPromotion` | Durable booleans. Post-commit prior-retirement uncertainty sets both true; they clear only after the applicable producer proof or documented no-session evidence reaches `RetiredProved`. A first install with `prior = null` keeps both false and does not enter a permanent degraded/blocked state. |
| `candidateReconcileRef`, `priorReconcileRef` | Separate nullable, opaque, retryable producer-owned `ReconcileRef` values for candidate cleanup and prior retirement. They are not bearer tokens, raw session journals, PIDs, URLs, paths, local/native handles, or `ProofRef` values. `candidateReconcileRef` is bound to the complete candidate group/root binding and verified sink receipt; the complete candidate group is persisted/verified before activation. `priorReconcileRef` is `null` when `prior = null` or for the proven no-session legacy prior, and neither ref may be invented, borrowed, or substituted. Each ref may retain only a `proofSha256` returned by its producer reconcile result; no independent proof-reference field or locally authored proof identity is allowed. |
| `retirement` | `attempts`, bounded `status` (`not_applicable`, `not_started`, `draining`, `proof_pending`, `proved`, `failed`, or `blocked`), and the latest attempt revision. Proof status is never inferred from a process exit. For first install (`prior = null`) or the proven no-session legacy prior, set `status = not_applicable`; retain the latter's documented no-session evidence and present prior content identity; after candidate/session conditions, `NewActiveCommitted` advances directly to `RetiredProved`. |
| `cleanupRefs` | Exact logical references for candidate root, prior root, temporary staging, backup, and cache entries, each with kind, content id/hash, byte count, and cleanup status. A cleanup adapter may delete only a reference whose identity still matches. |
| `sanitizedError` | Optional stable error `code` and safe public `message`; raw diagnostics, paths, tokens, PIDs, command lines, host names, and OCR/truth text are forbidden. |

The proposed store interface stays small and internal: observe or adopt the
legacy root; record the complete producer group/root binding and verified sink
receipt for a candidate; record verified candidate readiness; record the
flushed commit intent; perform the locked logical CAS/atomic pointer replace and
reread; record retirement draining and each producer proof attempt; and
reconcile startup against the observed pointer. These are design-only
operations until the module is added; callers do not receive a path, handle,
token, PID, `PreparedGroup`, `GroupLease`, or producer journal. A candidate
cannot skip `CandidatePrepared`, whole-group activation, or readiness by calling
a lower-level file helper.

The producer proof seam is addressable, not handle-based:
`RuntimeSessionJournal::reconcile(ReconcileRef) -> ReconcileResult`. A
`ReconcileRef` is an opaque producer journal index/address; Cert must not retain
or reconstruct a Job handle, process handle, PID, path, port, or takeover lease.
The candidate and prior sessions each receive their own ref; a slot retains
only the `proofSha256` returned for that exact ref.
After restart the call is observe-only. Complete proof of absent exact process
identities, absent owned listeners, and exact staging binding may advance that
ref to terminal; a present, PID-reused, unqueryable, or otherwise ambiguous
observation returns `reconcile-required`, touches nothing, and leaves the
corresponding Cert promotion path degraded/blocked. Candidate pre-commit
cleanup therefore has its own retry/reconcile path that can preserve the prior
active without invoking prior retirement. Prior post-commit retirement has its
own retry/reconcile path and can never be satisfied by candidate proof. The
receipt must retain both paths independently across a crash.

The producer R3 seam is the whole-group receipt-persistence contract for
activation:
`OwnedRuntimeSession::prepare_group(plan: &ImmutableGroupPlan, sink: &dyn
ReconcileRefSink) -> Result<PreparedGroup, PrepareError>` creates the opaque
candidate group. The sink's exact `persist(bindingAttemptId, binding)`,
`read_back(bindingAttemptId)`, and `verify(bindingAttemptId, expected,
readBack)` operations flush and verify the complete ordered group/root binding.
`persist` returns `Result<(), PersistError>`, `read_back` returns
`Result<CompleteGroupBindingReceiptV1, PersistError>`, and `verify` returns
`Result<VerifiedGroupBinding, PersistError>`. Each uses the same fresh
`bindingAttemptId`, also stored in the binding and receipt. Cert persists that
complete path-free binding and verified receipt digest as `CandidatePrepared`
before activation. The producer holds `PreparedGroup` only in live memory; it is
opaque, move-only, nonserializable, and contains the producer-private permit.
Cert never stores, reconstructs, or passes that permit. The producer then calls
`OwnedRuntimeSession::activate_group(prepared: PreparedGroup)`, which consumes
the value and returns a live `GroupLease` only after whole-group activation.
Cert waits for all-root loaded-worker/readiness identity of that group before
flushing `CandidateReady`; only then may commit intent/CAS run. Candidate and
prior sessions/groups use distinct nullable refs; there is no `ProofRef` type or
slot. Cert retains only each addressed producer-reconcile result's returned
`proofSha256`.

### Cert restart rule for producer-owned groups

The Cert receipt is durable, but `PreparedGroup` and `GroupLease` are not. On
every Cert restart, a `CandidatePrepared` or `CandidateReady` receipt is an
observation record, never a serialized activation input. Cert never reuses a
private permit, deserializes a `PreparedGroup`, or resumes an old prepared/ready
group by replaying its receipt. It invokes
`RuntimeSessionJournal::reconcile(ReconcileRef)` observe-only for the exact
recorded refs and complete binding.

There is one semantic distinction. If the original producer process is still
alive and the producer verifies live ownership of the exact whole-group
`GroupLease`, Cert may continue that existing live lease semantically after a
fresh all-root readiness observation; this does not deserialize a permit or
recreate a prepared value. If the producer restarted or lost the native handle,
Cert cannot claim or adopt that group/lease. It continues observe-only
reconciliation until exact terminal/no-resource proof. Once the old ref is
proven terminal or no resource was acquired, any new launch must allocate fresh
refs, run `prepare_group` with a fresh sink binding, and follow the full order
again. A present, reused, unqueryable, or ambiguous observation remains
`reconcile-required` and permits no launch or pointer mutation.

### Existing legacy installation observation

The current installed-runtime path is the legacy root
`app_data_dir/runtimes/capture-runtime`. Before any auto-launch, startup through
`apps/cert-prep-desktop/src-tauri/src/lib.rs::run` and the
`backend.rs::start_capture_runtime` caller must ask the proposed
`RuntimePromotionStore::observe_legacy_root` adapter to classify that exact
root. The adapter uses the existing
`capture_runtime.rs::installed_capture_runtime_paths`,
`capture_manifest.rs::verify_capture_runtime` and
`capture_runtime_expected_version`, `manifests.rs::load_runtime_manifest` and
`verify_artifact`, plus the identity-scoped `process_owner.rs` cleanup/proof
seam. It proves manifest/content hashes, byte count, and known runtime version,
then proves quiescence: no owned listener, process, producer session, or
unqueryable session identity remains. Missing evidence is not quiescence, and
no producer group ref is fabricated for a legacy root that is not running.

The root's presence is not a true empty install, even when the directory has
no recognized files. A true empty first install requires both the legacy root
to be absent and the local active-pointer observation to be `absent`. A
present, empty, reparse-point, unreadable, or otherwise unverified legacy root
must not enter the create-if-absent path.

When the legacy root is verified, known, quiescent, and the local pointer is
`absent`, the proposed
`RuntimePromotionStore::adopt_verified_legacy_root` operation records a fully
state-discriminated, path-free `LegacyAdoptionPrepared` receipt before moving
anything. Its required `legacyAdoption` value contains the exact logical
`source` and `destination` root refs, verified `content` identity, canonical
`layout` identity (manifest/schema/core/worker/catalog/runtime-contract-set
files and digests), `pointerIntent` (expected prior `absent`, intended
`present{generation,sha256}`, and expected revision), and `movePhase`
(`prepared`, `moved`, `pointer_created`, or `adopted`). The adapter rechecks all
of those fields under the store lock before each irreversible phase and flushes
the phase transition atomically. The `legacyId` is derived from verified
content, never from a persisted machine path.

The required value is a closed durable variant, not optional bag fields:
`legacyAdoption = none | prepared{source,destination,content,layout,pointerIntent}
| moved{source,destination,content,layout,pointerIntent}
| pointer_created{source,destination,content,layout,pointerIntent}
| adopted{source,destination,content,layout,pointerIntent}`. The variant tag is
`movePhase`; `none` is valid only outside adoption states. Source and destination
are distinct logical root refs with expected content hash/size; every populated
variant retains the same immutable tuple. Unknown tags, missing fields, or
inconsistent state/tag combinations are invalid.

Startup recovery is state-discriminated and exact. A durable phase may lag its
completed filesystem operation by one crash edge; it may never lead the observed
operation:

| Legacy source | Legacy destination | Pointer | Required result |
| --- | --- | --- | --- |
| exact recorded source | absent | absent | Only `prepared`: continue the exact recorded move, flush `moved`, then apply the recorded pointer intent. |
| absent | exact recorded destination | absent | Only `prepared` (crash after move) or `moved`: verify and flush `moved`, then complete the recorded pointer intent; do not move or recopy bytes. |
| absent | exact recorded destination | exact intended `present{generation,sha256}` | Only `moved` (crash after pointer create), `pointer_created`, or `adopted`: verify/flush `pointer_created` as needed, then flush `LegacyAdopted`/`adopted`. |
| both present, unexpected, any content/layout/pointer-intent/move-phase mismatch, reparse, unqueryable, or missing `legacyAdoption`/`pointerIntent` | any | any | `InstallAmbiguous`; touch nothing. |

Any live, unverifiable, path-inaccessible, reparse, mismatched-pointer, or
ambiguous legacy observation reports `InstallAmbiguous` and does not launch,
migrate, delete, overwrite the pointer, or promote a candidate. `LegacyAdopted`
selects `active/<legacyId>` with `activeSessionRef = null` and
`sessionState = not-running`; it never writes `CandidateReady`. A later launch
must run the fresh producer whole-group prepare/activate/readiness protocol and
produce a new group/session ref. Adoption never rolls back an exact pointer
create.

The record is a durable local receipt, not an OpenAPI/generated view. It must
be written atomically (private temporary file, flush, atomic replace, and
parent-directory flush as supported by the platform) before the next
irreversible step. No field may encode a raw root path, bearer token, process
handle/PID, OCR payload, or producer journal contents.

### Proven no-session legacy prior retirement

An adopted content root is not a live session. A later candidate may replace
that root without launching it merely to manufacture a prior ref. This branch
applies only when the store has durable completed `LegacyAdopted` evidence
bound to the exact prior content/layout/pointer identity, and complete durable
history proves no launch intent, prepare/group binding, activation, or session
ref has existed since adoption. `activeSessionRef = null` and
`sessionState = not-running` alone are insufficient.

Before commit, under the same store serialization used by launch/promotion,
reverify the exact adopted prior content and pointer, the completed adoption
identity and uninterrupted history, and quiescent listener/process ownership
through the existing ownership adapter. Persist this path-free evidence with
the promotion receipt, including adoption identity, content/layout/pointer
identity, history revision interval, and bounded ownership observation/result.
Launch must durably record intent under that serialization before any
prepare/activation, so an uncertain or interrupted launch cannot pass as
never launched. Recovery revalidates the evidence and current ownership/content
before completing retirement; a crash after pointer replacement retains the
recorded prior identity and checks the exact committed candidate pointer.
The proposed receipt field `noSessionPriorEvidence` is null outside this
branch; otherwise it contains those exact path-free evidence values. It is
local adoption evidence, never a producer `proofSha256` or a public contract.

After the ordinary candidate readiness, intent, CAS, and exact pointer reread,
this proven no-session legacy prior advances `NewActiveCommitted` directly to
`RetiredProved` with `retirement.status = not_applicable` and the documented
no-session evidence. Its `prior` content identity and prior pointer remain
present; `priorGroup` and `priorReconcileRef` are null. No producer proof hash,
group, or ref is fabricated, and no pointless prior launch is required.
The new active remains selected with degraded/block-next-promotion false.
Optional prior-content deletion still requires its exact cleanup reference
and fresh identity/pointer checks; existence of content is not session liveness.

Any missing adoption/history evidence, any launch intent or group/ref since
adoption, identity mismatch, unqueryable ownership, or ambiguous listener/
process ownership disqualifies this branch. Persist/report
`InstallAmbiguous`/`reconcile-required`; after commit keep the new active
selected/degraded and block the next promotion. If an actual prior session
exists, use its own producer reconcile ref and proof; a missing ref remains
blocked. Never substitute candidate proof or infer never-launched from a null
ref, missing process, or process exit. All prior-session retirement clauses
below apply outside this proven no-session branch.

### Promotion ordering and crash reconciliation

The exact order is part of the interface and is not an all-or-nothing rollback
promise:

1. `capture_runtime.rs` verifies the immutable candidate root and every
   manifest/schema/core/worker/catalog/runtime-contract-set identity. Candidate
   assembly writes only its isolated root; the verified active root is
   untouched.
   2. The producer runs the whole-group R3 preparation:
    `OwnedRuntimeSession::prepare_group(plan: &ImmutableGroupPlan, sink: &dyn
    ReconcileRefSink) -> Result<PreparedGroup, PrepareError>`. The sink performs
    exact `persist`, `read_back`, and `verify` calls for the complete ordered
    group/root binding and returns a verified receipt. `RuntimePromotionStore`
    records that complete path-free binding and verified sink receipt digest in a
    flushed `CandidatePrepared` receipt before any activation or pointer change.
    The producer-private `PreparedGroup` stays live, move-only, and
    nonserializable; its private permit never enters the Cert receipt. The
    candidate group binding and the prior group binding are distinct; a first
    install records `prior = null`, `priorReconcileRef = null`, and prior pointer
    observation `absent`.
 3. The supervisor passes the live `PreparedGroup` to the only producer
    activation operation, `OwnedRuntimeSession::activate_group(prepared)`. That
    call consumes the prepared value and activates the complete group. Cert
    verifies every root's loaded-worker and producer readiness identity (not a
    single-root or port-only signal). A partial assignment, activation failure,
    worker mismatch, readiness mismatch, or timeout is a candidate failure; it
    never reaches `CandidateReady` and never changes the active pointer. Only
    after all-root activation and readiness are proved does the store flush
    `CandidateReady`.
4. Only after `CandidateReady` does the store flush `commitIntent` with the
   expected prior `PointerObservation` and intended candidate
   `PointerObservation` (candidate is `present{generation,sha256}`), plus the
   expected revision.
5. Under the store lock, the implementation performs a logical CAS against the
   expected revision and prior pointer observation, atomically replaces and
   flushes the local active pointer, and rereads it while still holding the
   lock. First install uses compare-and-create-if-absent; an unexpected present
   observation is a conflict. Any conflict or unexpected reread is
   `InstallAmbiguous`; it is never a reason to choose a different candidate.
6. Only after the reread is the exact intended `present{generation,sha256}`
   observation does the store flush the irreversible `NewActiveCommitted`
   receipt. There is no rollback operation after this pointer commit; the new
   active remains selected.
7. If a prior session exists (outside the proven no-session legacy branch), the store flushes `PriorRetiredDraining` with
   exact cleanup references and the distinct prior group/ref slot before
   touching the prior session or root. Retirement cleanup then asks the
   producer for proof through `RuntimeSessionJournal::reconcile(priorReconcileRef)`;
   it never uses the candidate group/ref as a prior-session handle. If
   `prior = null`, there is no prior cleanup: after the candidate/session
   conditions and the reread, the store advances directly from
   `NewActiveCommitted` to `RetiredProved` with
   `retirement.status = not_applicable`. The proven no-session legacy prior
   follows the same direct transition with its documented evidence and present
   prior content identity, without a producer prior ref.
8. Each candidate cleanup or prior retirement attempt updates only its own
   receipt slot and records only a returned `proofSha256`. Complete producer
   proof permits a flushed `RetiredProved` receipt and clearing
   `degraded`/`blockNextPromotion`; absence of a proof, presence, reuse,
   unqueryability, or ambiguity remains `reconcile-required`/degraded for a
   prior-session retirement. The first install does not degrade or block forever.
9. Optional prior-root deletion happens last and only through the exact prior
   cleanup reference after identity and pointer rereads pass. Cache deletion is
   likewise limited to an exact unreferenced cache reference.

Startup reconciliation is owned by the same store and follows this matrix;
the app must not infer a state from directory names or process names:

| Durable receipt / observed pointer at startup | Required reconciliation |
| --- | --- |
| `CandidatePrepared` before activation/readiness, or candidate verification failed | Preserve the active root/pointer/session. Reconcile only the exact candidate ref and complete group/root binding observe-only; never deserialize `PreparedGroup` or a permit, flush `CandidateReady`, or touch the pointer. After exact terminal/no-resource proof, any retry uses fresh refs and a fresh `prepare_group`. |
| `CandidatePrepared` with an activation/readiness crash and an exact candidate group observation | Never replay the old prepared value. If the original producer is alive and verifies live ownership of the exact whole-group lease, the existing lease may continue semantically after fresh all-root readiness observation; otherwise reconcile the old ref observe-only. Producer restart/lost handle, partial, reused, unqueryable, or ambiguous observations remain `reconcile-required`; after terminal/no-resource proof, a new launch must use fresh refs/prepare. |
| `CandidateReady` (or no intent) and the observed pointer exactly matches the recorded prior `PointerObservation` | Treat the operation as pre-commit. Do not commit from the stale receipt. Preserve active; reconcile only the exact candidate ref/binding observe-only. Only a verified live lease owned by the still-running original producer may continue semantically after fresh all-root readiness proof; never deserialize a permit or resume a serialized ready group. Otherwise wait for terminal/no-resource proof, then use fresh refs/prepare for any launch. |
| `commitIntent` exists and the observed pointer exactly matches the expected prior `PointerObservation` | The crash happened before commit. Do not commit or reinterpret the intent as permission to replace; preserve active and reconcile only the recorded candidate refs. |
| `commitIntent` exists and the observed pointer exactly matches its intended candidate `present{generation,sha256}` observation | The pointer replacement committed before its receipt. Advance durably to `NewActiveCommitted`; when `prior = null`, advance directly to `RetiredProved` with `retirement.status = not_applicable`, `priorReconcileRef = null`, and no degraded/block-next-promotion flag. For the proven no-session legacy prior, revalidate its evidence and advance directly to `RetiredProved`/`not_applicable`; otherwise persist `PriorRetiredDraining` before any prior-session cleanup. Never restore the prior pointer. |
| The observed pointer is neither the recorded prior nor intended candidate `PointerObservation`, or receipt/pointer observations conflict | Persist/report `InstallAmbiguous`, keep the selected bytes untouched, set degraded/block-next-promotion, retain all exact refs and sanitized error, and require explicit recovery. On first install, any unexpected `present{generation,sha256}` is a compare-and-create-if-absent conflict. No rollback or broad deletion. |
| `NewActiveCommitted` with `prior = null` | Keep the new active selected and advance directly to `RetiredProved` with `retirement.status = not_applicable`, `priorReconcileRef = null`, and no degraded/block-next-promotion flag. First install must not wait for or invent predecessor proof. |
| `NewActiveCommitted` or `PriorRetiredDraining` with a prior active outside the proven no-session legacy branch | Keep the new active selected and degraded; block the next promotion; retry producer retirement proof only through `RuntimeSessionJournal::reconcile(priorReconcileRef)`. A missing, present, reused, unqueryable, or ambiguous prior observation remains `reconcile-required`; candidate cleanup proof cannot satisfy prior retirement, and a missing durable prior ref cannot become `RetiredProved`. |
| `NewActiveCommitted` with a proven no-session legacy prior | Revalidate the completed adoption identity, uninterrupted no-launch history, exact prior content/committed pointer, and unambiguous quiescent ownership evidence. Advance directly to `RetiredProved`/`not_applicable` with null prior group/ref and no degraded/block flag. Any uncertainty is `InstallAmbiguous`/`reconcile-required`; keep new active selected/degraded and block further promotion. |
| `RetiredProved` | Keep the new active selected. Delete a prior root only by its recorded exact ref after a fresh identity/pointer check; never delete an unreferenced root or cache entry. |
| `LegacyAdoptionPrepared` | Re-observe the state-discriminated exact source, destination, content, layout, pointer intent, and move phase. Exact source/destination/pointer cases may only continue the recorded move or pointer create as listed above; both/unexpected/any content-layout-pointer-intent-move-phase mismatch/reparse/unqueryable/missing intent is `InstallAmbiguous` and touches no runtime bytes. |
| `LegacyAdopted` with `activeSessionRef = null` and `sessionState = not-running` | Keep `active/<legacyId>` selected, never flush `CandidateReady`, and do not invent a group/ref. A later launch must use fresh producer `prepare_group`/`activate_group`/all-root readiness and create a new session ref. |
| Any temporary, backup, root, or cache candidate | Remove only when its receipt cleanup reference, content hash, byte count, and ownership all match. Unknown, mismatched, or path-only entries stay untouched. |

The current one-shot `RuntimeProcessOwner` `FnOnce` termination seam in
`process_owner.rs` is not sufficient for steps 6-7: replacing it is a planned
implementation requirement. The replacement must retain a retryable producer
`ReconcileRef` and its returned `proofSha256`, and return a real failure on a
second unsuccessful call; a second call must never be reported as false success merely because a closure
was consumed. `RuntimePromotionStore` still does not own that producer journal
or its native process policy.

The Python backend installer is a separate scope. The existing
`apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/manager.py`
(`RuntimeInstallationManager`, `RuntimeInstaller`) and
`apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/installers.py`
(`LLMModelInstaller`) own provider/model requirement jobs and their durable
installation snapshots. They do not write the local installed-runtime pointer
or promotion receipt. `routers/capture_runtime.py` and the capture client are
authenticated proxy/SDK seams only; they do not become a second promotion
owner.

## Consumer contract

The runtime contract-set is API `2.0` with the schema-3 typed,
page/segment-bound OCR projection and its independent `contractSetSha256`.
Cert Prep must consume that runtime contract-set for readiness/projection only;
the acceptance seam consumes the future `@capture-runtime/acceptance-contract`
package/bundle and its separate producer `contractSha256`. Cert must consume
producer-published bytes only after the complete 0.4.2 candidate exists; no
digest is invented in advance and the two contract identities are never
substituted.

### OCR-only source admission

- Every new PDF page and image import enters the `windowsml_ocr` capture
  projection. Rasterization and OCR happen in `capture-runtime`.
- `direct_pdf`, `embedded`, and `mixed` are fail-closed at the new import
  seam. Cert Prep must not inspect an embedded text layer, arbitrate a mixed
  result, write a `direct_pdf` result, or call a second OCR provider.
- Existing persisted `direct_pdf`, `embedded`, and `mixed` rows are legacy
  read-only compatibility data. They are never written as the result of a new
  import,
  never used to select an OCR route, and never silently rewritten as current
  OCR evidence.
- Runtime capture state and OCR projection are transient execution data. Cert
  owns the durable source, review, export, and domain records that consume the
  projection.

The public capture seam remains authenticated and fail-closed. An invalid
contract, unsupported source, unavailable OCR requirement, malformed
projection, cancellation, timeout, or runtime failure is a typed unavailable
or terminal result; it is not an invitation to fall back locally.

### Producer projection to Cert durable mapping

The two strings below are intentionally different fields in different
contracts. A producer engine value is never copied verbatim into the Cert
durable discriminator.

| Producer projection (authenticated, transient) | Cert durable result (SQLite/domain) |
| --- | --- |
| `provenance.engine: "windowsml-ocr"` for a resolved OCR projection | `documents.extraction_method` and every page/chunk extraction method: `"windowsml_ocr"` |
| Ordered projection pages, including recognized/empty/failed status, boxes, confidence, and sanitized failure | `ExtractedPage`/document chunk rows in source page order, published through `publish_capture_document` -> `publish_success`; no page is silently dropped or reordered. |
| Projection source identity (`sha256`, file name, media type, byte count) | The existing durable source identity; `build_ocr_summary` and the persistence seam reject a digest/source mismatch before commit. |
| Resolved projection provenance (`runtime_version`, contract/profile digests, model digest, device, profile) | Allowlisted durable OCR provenance/device fields needed for review/export and acceptance evidence; never a bearer token, local path, raw diagnostic, or model-store location. |
| Host structuring state and `structuring_engine` | Separate Cert host-domain state; it never changes the extraction discriminator or becomes OCR provenance. |

`apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/mapping.py`
must therefore accept the exact producer engine `windowsml-ocr`, then return
the exact Cert value `windowsml_ocr`. It must not infer either value from a
substring or from the presence of an embedded PDF layer. The embedded layer is
always ignored; no new document, page, or chunk may be written as `direct_pdf`,
`embedded`, or `mixed`. Those values are legacy read compatibility only. A legacy
row may be displayed or exported according to its existing domain rules, but it is
never a new import target, route selector, or source for silently rewriting
current OCR evidence.

### User-facing compute projection

The producer is the sole compute-policy owner. Cert Prep must decode the exact
generated public `OcrComputePreflightV2`/`RuntimeReady` contract from the pinned
SDK and display its producer-owned notice. It must not enumerate or rank
adapters, interpret ordinals, derive a device id, translate a reason into local
copy, or recompute a mode/adapter/reason/notice matrix. The producer response
must retain enough authenticated notice truth (`mode`, `reasonCode`,
`userNoticeRequired`, and `noticeCode` or the contract's equivalent user-notice
payload) for the host to tell the user when CPU fallback was selected because
no dGPU or iGPU was usable.

CPU fallback messaging is a projection of that producer truth only. Cert does
not recompute, enrich, or otherwise reinterpret the notice.

The delete-first implementation inventory is explicit: remove the fallback
`OcrComputePreflightV2` model and `_validate_decision` from
`apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/host_models.py`,
remove `CertPrepCaptureCoordinator._assert_ocr_compute_preflight` from
`apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/coordinator.py`, remove the compatibility decoder shim
`_install_candidate_runtime_ready_decoder` from `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/client.py` once the public
generated contract is present, and remove the frontend `mapOcrCompute` and
hardcoded contract/store matrices from
`apps/cert-prep/src/app/pages/capture-workbench-trial/` and
`apps/cert-prep/src/app/stores/capture-runtime/capture-runtime-preflight.store.ts`.
The host keeps only generated types and a thin notice presentation path.

DirectML construction or inference failure after a producer GPU plan is
selected is a failed capture. The Cert host never retries that operation on
CPU or chooses a different GPU. An indeterminate producer preflight remains
unavailable and does not become a CPU notice.

## Owned runtime sessions and cleanup

Each active launch and each candidate launch has a distinct producer-owned
`OwnedRuntimeSession` interface. It is not a current Cert Prep symbol; Cert
observes it through the proposed `DesktopRuntimeSupervisor` adapter only after
that adapter's interface is reviewed and implemented.

- A candidate is prepared as one producer whole-group session before an
  active-session swap. The sink persists and verifies the complete ordered
  group/root binding; `RuntimePromotionStore` persists that binding and the
  verified sink receipt digest in `CandidatePrepared`. The producer-private
  `PreparedGroup` is opaque, move-only, live-only, and nonserializable;
  `OwnedRuntimeSession::activate_group(prepared)` consumes it and returns one
  `GroupLease` only after the complete group is live. The store verifies every
  root's loaded-worker and producer readiness identity before flushing
  `CandidateReady`. Candidate failure terminates and proves only that candidate;
  the existing active session remains untouched.
- Promotion is a transaction with the states
  `CandidatePrepared -> CandidateReady -> NewActiveCommitted -> RetiredProved`
  for first install (`prior = null`) or the proven no-session legacy prior, and
  `CandidatePrepared -> CandidateReady -> NewActiveCommitted ->
  PriorRetiredDraining -> RetiredProved` when a prior session exists (excluding the proven no-session legacy prior below). A
  candidate may be reported ready only after its immutable root, manifest,
  complete group activation, loaded worker identity, and producer readiness
  identity are proved. `commitIntent` and pointer CAS are forbidden before
  that receipt.
- Before `NewActiveCommitted`, any failure leaves the active root/pointer and
  active session untouched; the candidate is isolated and its failure proof is
  retained. At `NewActiveCommitted` the active pointer is atomically replaced
  with the verified candidate.
- After `NewActiveCommitted`, there is no rollback to the old active. The new
   active remains selected; outside first install and the proven no-session
   legacy branch, it stays degraded and blocks the next promotion
   while the distinct candidate/prior opaque producer references remain in the
   receipt. Before commit, candidate cleanup calls
   `RuntimeSessionJournal::reconcile(candidateReconcileRef)` and can be
   recovered independently without touching the active or prior session. After
   commit, prior-session retirement calls
   `RuntimeSessionJournal::reconcile(priorReconcileRef)` and can be recovered
   independently until `RetiredProved`; only then may the degraded marker
   clear. A present, reused, unqueryable, or ambiguous observation remains
   `reconcile-required` and must not be treated as proof. On a Cert restart,
   never deserialize a prepared/ready group or reuse its private permit. Only a
   verified live lease owned by the still-running original producer may
   continue semantically; after producer restart/lost handle, reconcile the old
   ref observe-only and use fresh refs/prepare after terminal/no-resource proof.
   Replace the current one-shot `RuntimeProcessOwner` `FnOnce` termination seam;
   a second cleanup call must not become a false success.
- App close, window close, readiness failure, runtime-root crash, and host
  termination converge on the producer's owned-session terminal proof. Cert
  observes that proof through its adapter rather than duplicating native
  cleanup.
- Close clears Cert-owned listeners, PIDs, run data, and staging residue. It
  leaves durable runtime/model assets and caches in place for the next start.
- An external Ollama process that predates the Cert session is a baseline and
  must survive. Cleanup is identity-scoped and never kills by executable name.
- Next-start reconciliation removes only stale app-owned listeners, PIDs,
   run data, staging, or backups after ownership identity is proven. Unknown,
   ambiguous, or mismatched identity fails closed and is left for explicit
   recovery. The producer's addressable observe-only seam is
   `RuntimeSessionJournal::reconcile(ReconcileRef) -> ReconcileResult`; no
   local Job/process handle, PID, path, port, or takeover lease is a substitute
   for either the candidate or prior `ReconcileRef`.

The adapter may report lifecycle state, but it must not expose raw OS handles
or ask the Angular host to terminate a process tree.

### Immutable roots and promotion

The following filesystem roles are the required design, not claims about the
current `capture_runtime.rs` layout. Their concrete directory or pointer names
are **proposed** until a bounded implementation slice records them.

- The **active root** (**proposed**) is an immutable, fully verified runtime
  tuple used by new launches. It contains the manifest, executable, schema,
  worker/catalog identity, and contract identity for one content address. It
  is never patched in place.
- The **candidate root** (**proposed**) is a separate immutable tuple under
  the app-owned runtime root. Candidate assembly and readiness checks write
  only there; they never mutate the active root or its pointer.
- The existing legacy root at `app_data_dir/runtimes/capture-runtime` is an
  observation input, not a candidate and never a true-empty install. Before
  auto-launch, verify its manifest/content/known version and prove no owned
  listener or session. A verified quiescent root may be atomically adopted as
  the proposed immutable `active/<legacyId>` only after a
  `LegacyAdoptionPrepared` receipt records exact source/destination/content/
  layout/pointer-intent/move-phase fields. The pointer is
  `present{generation,sha256}` and `LegacyAdopted` has
  `activeSessionRef = null` / `sessionState = not-running`; a later launch
  creates fresh producer group/ref state. A live, unverifiable, or ambiguous
  root is `InstallAmbiguous` and is left untouched.
- The only shared bytes may come from a durable, content-addressed cache
  (**proposed** layout) keyed by verified SHA-256 and byte count. A cache entry
  is reusable only after manifest, schema, package/provenance, and loaded
  worker identities have been verified. Mutable staging, a sibling checkout,
  a local path, and a URL/port are not shared cache identities.
- Promotion uses an atomic replacement of the **active pointer** (**proposed**)
  after the candidate is verified and its own session is ready. The active
  pointer is a local runtime-install pointer, not the producer's shared release
  stable pointer. Keep the prior active root, pointer value, and session until
  `NewActiveCommitted`; retain the prior root while it drains, but do not use a
  rollback operation after commit.
- Candidate verification or candidate launch failure is pre-commit failure and
   leaves the prior active pointer/root/session usable. Pointer replacement is
   the commit boundary. After commit, retired-session cleanup failure leaves
   the new active selected, marks the install degraded, blocks the next
   promotion, retains the exact candidate/prior reconcile refs and returned
   `proofSha256` values, and
   retries or reconciles each slot at next start. It never restores the old
   active by claim. Candidate pre-commit cleanup may terminalize only on exact
   absence/listener/staging proof; prior-session post-commit retirement uses its own
   `priorReconcileRef` and remains degraded/blocked for missing, present,
   reused, unqueryable, or ambiguous observations.
- A file-install restore may be called `Restored` only after the prior root's
  path, manifest, byte count, content hash, and session identity have been
  re-verified. If any proof is missing or conflicting, return
  `InstallAmbiguous`; do not report restored, delete the new active, or choose
  another candidate. The current `replace_runtime_directory` implementation
  is not this transaction contract and must be replaced behind a reviewed seam.

The current implementation facts behind this design are
`install_bundled_capture_runtime`, `installed_capture_runtime_paths`, and
`replace_runtime_directory` in `capture_runtime.rs`, plus
`verify_capture_runtime` in `capture_manifest.rs`. These existing functions
verify/copy a bundled runtime but do not yet constitute the proposed
active/candidate pointer contract. The first implementation slice that changes
them must add failure-injection coverage for candidate failure, pre-commit
active preservation, post-commit degraded retirement, `Restored` proof versus
`InstallAmbiguous`, and retryable cleanup. This is not an all-or-nothing
rollback contract.

### Two consumer acceptance events and producer handoff

Cert Prep performs its own acceptance twice for the same candidate identity.
Each event consumes a producer-owned, frozen/read-only invocation and returns
one exact result from the future `@capture-runtime/acceptance-contract`
package/bundle. The producer remains the sole writer of the mutable scope and
the canonical child wire. Cert records the bundle's version `"1"` and the
exact D3/D6-bound `contractSha256` from the invocation/ledger; it does not
define, extend, or restate any producer record. That acceptance hash remains
distinct from the runtime `contractSetSha256` used by the readiness/projection
contract.

1. **D4 `CandidateAccepted` (pre-publication).** After the producer's D3
   candidate record exists, the producer owns the mutable
   `ProducerChildScopeV1` at
   `CAPTURE_ACCEPTANCE_SCOPE_PATH`; the producer publishes the separate frozen
   `ProducerChildInvocationV1` at `CAPTURE_ACCEPTANCE_INVOCATION_PATH` (or its
   canonical read-only handle/pipe). Cert never consumes, overwrites, returns,
   or treats the scope as consumer output. Cert verifies the invocation's
   frozen/read-only canonical bytes and `invocationSha256`, runs the immutable
   candidate in the strict serial lane through the proposed private
   `FixtureCapabilityResolver` adapter. The resolver accepts the invocation's
   ordered fixture assignments and opens the complete full-truth oracle for
   each assignment read-only; it cannot add, remove, reorder, or substitute a
   fixture and it never exposes raw truth or media to the result. Cert then
   atomically create-new exactly one complete `ConsumerSemanticResultV1` from
   the package/bundle codec at `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`.
2. **D7 `PublishedAccepted` (post-publication).** After the producer publishes
   the exact D3 bytes and provides the D6 download-back identity, Cert consumes
   a fresh frozen/read-only invocation from
   `CAPTURE_ACCEPTANCE_INVOCATION_PATH`, verifies its canonical digest and D7/
   D6 binding, reruns the installed journey from those downloaded bytes only,
   and atomically create-new one exact package-defined
   `ConsumerSemanticResultV1` from the same package/bundle codec at the
   distinct `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`. The resolver again
   consumes the fresh invocation's ordered assignments and full-truth oracle
   read-only; the result is bound to the published tier and D6 ledger identity.

After Cert's write-once result is validated, the producer performs its own
cleanup/proof and later writes the immutable `AcceptanceChildWireV1` at
`CAPTURE_ACCEPTANCE_WIRE_PATH`. `ConsumerSemanticResultV1` is the exact
package/bundle record and has no Cert-local extension or cleanup/privacy
addition. Cert never receives or writes the wire path, never defines a
competing child wire, and never claims ownership of producer cleanup. A green
D4 hands the exact result to the producer publication lane; a green D7 makes
the result available for producer validation. The producer alone emits its
child wire and directs any handoff to LAW. Cert does not wait for LAW, hand off
a wire, aggregate consumer ledgers, or move/mutate the producer's stable
pointer. A Cert candidate/active pointer is local install state and must not be
confused with that producer-owned stable release pointer.

## Candidate identity and installation tiers

Candidate identity is a content identity, not a location identity. Local
candidate acceptance is intentionally tiered:

- A local transport URL or port identifies transport only. It does not bind a
  candidate to repository HEAD, and it is not sufficient identity.
- The hard gate binds the API/schema and runtime `contractSetSha256`, the
  packaged archive boundary, package/provenance metadata, and the loaded
  runtime and OCR worker executable identities. The loaded runtime-worker
  identity must agree with the candidate record before capture. Acceptance
  bundle `contractSha256` is a separate D3/D6 input and is not a runtime
  contract-set substitute.
- A clean-install check rejects a sibling junction, source-tree import,
  local-path substitution, `direct_url`/path provenance, and mixed 0.4.1/
  0.4.2 versions wherever those checks apply. A local candidate may retain
  diagnostic local metadata, but that metadata never satisfies a published
  claim.

The D4 candidate gate requires an immutable candidate root, exact candidate
ledger, and verified loaded runtime/worker identity; it does not require a
published registry URL and does not move the stable pointer. D7 published
acceptance restores strict locks: exact 0.4.2 semver, frozen registry
resolution, every declared artifact/checksum/manifest entry, download-back
byte identity, and no local path or `direct_url`. Until those immutable
producer bytes exist, the current 0.4.1 pin remains a compatibility baseline
rather than evidence for the 0.4.2 cutover.

## Tooling baseline

The current workspace package manager is `pnpm@12.0.0`. Nx packages and the
workspace CLI are currently `23.1.0`; the first executable Phase 2 slice must
upgrade the workspace to Nx `23.1.2` and establish one version/projection
inventory covering API `2.0`, the typed projection schema `3`, and the exact
producer-generated contract SHA-256 before any candidate root, shared cache,
active pointer, or acceptance staging is created. No contract digest is
invented in advance. This local-probe checkpoint makes no upgrade or release
claim.

The inventory must cover `tools/capture-runtime-version.mts`,
`tools/capture-runtime-version-check.mts`, the Python/npm/Cargo client and
lockfile values, `apps/cert-prep-desktop/scripts/package-qa/constants.mts`,
`capture_manifest.rs`, `manifests.rs`, and the loaded candidate manifest and
worker/catalog identities. It must also record the loaded producer public
`RuntimeReady`/`OcrComputePreflightV2` projection contract and its exact
contract hash; `libs/cert-prep-api/src/lib/cert-prep-api.generated.ts` is a
generated consumer view, not permission to hand-author a second matrix. A
stale literal, missing schema-3 projection, missing contract hash, or mixed
0.4.1/0.4.2 lock is a stop, not a warning. The version check is read-only; an
explicit upgrade is a separate reviewable change. Candidate staging is
forbidden until the Nx 23.1.2 and complete inventory checks are green.

The 2026-09-09 Nx discovery found the existing targets
`cert-prep-desktop:release-tool-test`, `cert-prep-desktop:typecheck-scripts`,
`cert-prep-desktop:package-qa-test`, `cert-prep-desktop:cargo-test`,
`cert-prep-desktop:capture-candidate-gate-test`,
`cert-prep-desktop:capture-fresh-projection-typecheck`,
`cert-prep-desktop:capture-fresh-projection-lint`,
`cert-prep-desktop:capture-fresh-projection-test`, and
`cert-prep-desktop:acceptance-real`. No `version-check` target was discovered;
the first slice must either attach its inventory to an existing discovered
target or add and discover a target before using it. A guessed target name is
never a passing gate. Future implementation verification uses the exact
package-manager-prefixed target with `--skip-nx-cache` recorded in the TODO.

## Acceptance checklist

Phase 1 local-probe acceptance is complete. The following remains the Phase 2
sequential formal/published-package regression checklist: it uses private
fixtures and an exact producer candidate. Package QA and protocol fakes are
supporting checks only.

The semantic thresholds are unchanged and blocking: the scanned PDF page 1
must have CER <= 1%, the real JPEG must have CER <= 3%, and every critical
anchor must be present (zero omissions). The producer field must be
`windowsml-ocr`; the Cert durable field must be `windowsml_ocr`.

- [ ] Run a real private JPEG through the installed app and persist a semantic
      `windowsml_ocr` projection with producer `windowsml-ocr` provenance; record
      CER <= 3% and zero missing critical anchors.
- [ ] Run the real private PDF's page 1 through the same installed app after
      the JPEG run, sequentially in the assigned model slot. The routine gate
      is page 1; require CER <= 1% and zero missing critical anchors.
      Full-document OCR is reserved for an explicitly tested accumulation,
      ordering, or accuracy risk.
- [ ] Keep the schema-1 Cert `acceptance-manifest.json` as a read-only
      compatibility input. The migration owners remain
      `apps/cert-prep-desktop/scripts/acceptance-artifacts.mts::writeAcceptanceManifest`
      and its `acceptance-artifacts.test.mts` coverage;
      `acceptance-real.mts::acceptancePassed` remains the caller/verdict only.
      A new D4/D7 run consumes the future
      `@capture-runtime/acceptance-contract` package/bundle and exact D3/D6
      `contractSha256`; that package is the sole version/schema/codec/manifest/
      hash authority and is absent at this checkpoint, so package/target
      creation is a producer discovery/creation stop. It consumes only the
      frozen/read-only invocation from `CAPTURE_ACCEPTANCE_INVOCATION_PATH`,
      verifies its canonical digest, and atomically create-new exactly one
      package-defined `ConsumerSemanticResultV1` at the distinct
      `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`. The package-defined ordered
      fixture assignments are resolved through the proposed private
      `FixtureCapabilityResolver`, which supports ordered JPEG/PDF capabilities
      and complete full-truth oracles; the package codec owns the exact result
      and Cert defines no local result fields or privacy/cleanup block. The
      producer later validates the exact result,
      performs cleanup, adds producer cleanup/privacy to `AcceptanceChildWireV1`,
      and emits the wire. Cert emits no aggregate/D8 record and never writes the
      producer scope or wire path.
- [ ] Complete D4 `CandidateAccepted` with the pre-publication immutable
      candidate root and Cert's one `ConsumerSemanticResultV1` at
      `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`; hand the result to the
      producer publication lane for validation, cleanup, and later
      `AcceptanceChildWireV1` emission. Do not write the producer scope or wire,
      wait for LAW, create aggregate ledgers, or move/mutate the producer stable
      pointer.
- [ ] After D5 publication and D6 download-back verification, complete D7
      `PublishedAccepted` from the downloaded bytes and compare every artifact
      hash, manifest, lock, and worker identity. Write only Cert's
      `ConsumerSemanticResultV1` at the distinct semantic-result path, then
      let the producer validate, clean up, emit its child wire, and direct any
      handoff to LAW; do not write the scope/wire, hand off a wire, wait for
      LAW, or create an aggregate ledger.
- [ ] Record that producer-owned cleanup, child-wire emission, aggregation, and
      D8 stable-pointer promotion are outside Cert authority. Cert never writes,
      moves, or rolls back the shared stable pointer, producer scope, or child
      wire.
- [ ] Prove the producer gate and Cert capture cleanup before handing the
      model slot to GX Law Prep. No owned backend/capture/OCR/model PIDs,
      listeners, run data, or staging may remain at handoff.
- [ ] Restart the app and prove durable source, projection reference, review
      override, and domain persistence remain available without reviving a
      stale runtime session.
- [ ] Confirm review/export output comes from Cert-owned durable domain data
      and retains `windowsml_ocr` provenance; do not export raw runtime
      diagnostics as product data.
- [ ] Confirm app close removes owned listeners/PIDs/run data/staging while
      retaining durable runtime/model assets and the pre-existing external
      Ollama baseline.
- [ ] Record candidate/archive/runtime-worker/runtime-contract-set identities,
      the exact acceptance-bundle `contractSha256`, and semantic-result digests
      in privacy-safe evidence. The bundle codec owns the exact result and its
      ordered assignment/result binding; Cert's private
      `FixtureCapabilityResolver` supports both ordered fixtures and complete
      full-truth oracles read-only. Producer cleanup/privacy belongs only to the
      later child wire. Raw OCR/truth, media, bearer tokens, local paths,
      host/user names, process/native IDs, and environment dumps never enter
      the semantic result.

## Design and verification workflow

Any image/PDF-flow implementation starts with the design and a serious review
before code. The red test crosses the public consumer seam, then TDD proceeds
as one observable vertical slice. Standards review and Specification review
are independent axes and are bound to the exact commit; a later commit makes
both approvals stale. Candidate staging is deterministic and isolated before
an installed journey is trusted.

The acceptance manifest owner is
`apps/cert-prep-desktop/scripts/acceptance-artifacts.mts::writeAcceptanceManifest`,
covered by `apps/cert-prep-desktop/scripts/acceptance-artifacts.test.mts`. The
`acceptancePassed` value in
`apps/cert-prep-desktop/scripts/acceptance-real.mts` is only the caller's final
verdict; it is not a second manifest writer or artifact-owner seam.

### Acceptance semantic-result migration

The current Cert `acceptance-manifest.json` is a schema-1 local diagnostic
manifest. It is not the producer's cross-project acceptance record. Preserve
the existing migration owners:

The future `@capture-runtime/acceptance-contract` package/bundle and its
producer Nx project are absent at this checkpoint. Their owner, exact bytes,
and `contractSha256` must be discovered and authorized by the producer before
Cert consumes them; package/schema/target creation or a guessed target is a
creation stop, never a local substitute.

- `apps/cert-prep-desktop/scripts/acceptance-artifacts.mts::writeAcceptanceManifest`
  and `apps/cert-prep-desktop/scripts/acceptance-artifacts.test.mts` remain the
  schema-1 compatibility writer/tests; they must not become a canonical wire
  writer.
- `apps/cert-prep-desktop/scripts/acceptance-real.mts::acceptancePassed` remains
  the caller's final verdict only.
- `apps/cert-prep-desktop/scripts/ocr-semantic-evidence.mts::serializePrivacySafeOcrSemanticEvidence`
  and `OCR_NORMALIZATION_VERSION`,
  `apps/cert-prep-desktop/scripts/phase1-acceptance-evidence.mts::buildPhase1AcceptanceEvidence`,
  and `apps/cert-prep-desktop/scripts/ocr-page-record-evidence.mts::assertOcrPageRecordEvidenceIntegrity`
  remain the semantic/page evidence owners during migration.
- `apps/cert-prep-desktop/scripts/ocr-truth-contract.mts::evaluateOcrTruth`,
  `normalizeOcrText`, `parseOcrTruthManifest`, and `levenshtein` remain the
  full-reference calculation seams. The formal D4/D7 path must
  delete/prohibit `anchorOnly` and `parseOcrAnchorExpectation` in
  `ocr-truth-contract.mts`, including the import/call in
  `apps/cert-prep-desktop/scripts/acceptance-real-options.mts`. Synthetic
  anchor-only expectations may remain in unit-only regression tests, but are
  barred from D4/D7 acceptance.
- The proposed private `FixtureCapabilityResolver` adapter is owned at
  `apps/cert-prep-desktop/scripts/acceptance-real-options.mts` during
  migration. Its `resolveMedia`/`resolveOracle` seam accepts the producer
  invocation's ordered fixture assignments and opens each complete full-truth
  oracle read-only. It is an adapter over private fixture storage, not a local
  acceptance schema, codec, or validator; the future package/bundle remains
  authoritative.

The producer runner owns the mutable
`ProducerChildScopeV1` at `CAPTURE_ACCEPTANCE_SCOPE_PATH` and publishes the
separate immutable `ProducerChildInvocationV1` at
`CAPTURE_ACCEPTANCE_INVOCATION_PATH` (or its canonical read-only handle/pipe).
Cert must consume only that frozen/read-only invocation, verify its canonical
bytes and `invocationSha256` plus the exact version/hash of the future
`@capture-runtime/acceptance-contract` package/bundle, and must not consume,
overwrite, return, or write the scope. A new D4/D7 run atomically create-new
exactly one complete `ConsumerSemanticResultV1` through that package/bundle
codec at the distinct `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`; a second
write, overwrite, partial record, pre-existing final path, missing result, or
unbound result fails closed. The producer validates the result, performs its
own cleanup/proof, and later writes immutable `AcceptanceChildWireV1` at
`CAPTURE_ACCEPTANCE_WIRE_PATH`. Cert never receives or writes the producer wire
path and never defines a competing child wire.

`ConsumerSemanticResultV1` is consumed exactly as exported by the future
package/bundle; no Cert-local type, field list, extension, or schema
restatement is allowed. The proposed private `FixtureCapabilityResolver`
adapter accepts the invocation's ordered fixture assignments and resolves the
complete full-truth oracle for each one read-only. A missing, reordered,
substituted, or digest-mismatched fixture/oracle fails closed before the exact
result is written. The producer codec binds the result to its invocation
parent gate/tier and D4 -> D3 or D7 -> D6 ledger identity. Producer
cleanup/privacy, full ledger binding, invocation digest, and canonical wire
digest remain producer-owned and are not added locally.

The private resolver must supply the complete full-truth reference and critical
anchors for both D4 and D7. A garbage-around-anchors output must not receive
CER 0: the RED regression must prove that anchor presence alone cannot pass.
Missing or unscoped `CAPTURE_ACCEPTANCE_INVOCATION_PATH`, mutable/writable
invocation, canonical-digest mismatch, missing or overwritten semantic-result
path, missing JPEG/PDF fixture result, false/omitted outcome, duplicate
identity, schema/contract/ledger mismatch, or a candidate/prior receipt
reference mismatch fails closed before handoff. During migration, schema-1
manifests are read/retained only for compatibility until the producer
scope/invocation/result/wire contract is implemented and the legacy output is
deleted; new formal runs emit only the exact package/bundle semantic result.

### Design-It-Twice record for the consumer seam

The current checkout has deep existing seams in `build_ocr_summary`,
`capture_document_to_pdf_extraction`, `publish_capture_document`,
`CaptureRuntimeState::launch_cancellable`, and `RuntimeProcessOwner`. It does
not have a Cert `DesktopRuntimeSupervisor` or `RuntimeAssetInstaller`. Before
adding a new module around those seams, compare the following materially
different **proposed** interfaces. The examples are illustrative contracts,
not existing methods or implementation authority.

| Alternative | Interface and usage example | Hidden implementation and dependency adapters | Trade-off |
| --- | --- | --- | --- |
| **A. Proposed `CaptureRuntimeFacade`** (minimum surface) | `capture(candidate, upload) -> DurableCaptureReceipt`; caller only invokes `facade.capture(candidate, upload)` and later `facade.close() -> CleanupProof`. | Hides authentication, candidate verification, active/candidate roots, producer session, `build_ocr_summary`, mapping, `publish_capture_document`, and draft-job ordering. Dependencies: installed runtime is a remote-owned adapter, filesystem/cache is local-substitutable, SQLite is durable state, and a deterministic receipt is the test adapter. | Highest depth for the common call and strongest caller locality, but install, lifecycle, projection, and persistence failure modes are collapsed into one shallow error surface; likely to become a second coordinator. |
| **B. Proposed explicit ports** (flexibility) | `RuntimeAssetInstaller.prepare(candidate) -> VerifiedRuntime`; `DesktopRuntimeSupervisor.start(verified) -> RuntimeReadiness`; `OcrProjectionMapper.map(projection) -> DurableProjection`; `publish_capture_document(...)` remains the durable commit call. | Hides manifest/hash checks behind the installer, producer session and pointer swap behind the supervisor, and string/discriminator mapping behind the mapper. Dependencies: `capture_manifest.rs`/`manifests.rs` are native filesystem adapters, producer `OwnedRuntimeSession` is a remote-owned adapter, existing Python owners are the domain adapter, and failure-injection fakes are test adapters. | More interface knowledge for callers, but each seam has high leverage and clear typed failures; changes stay local and a second consumer can reuse an adapter. |
| **C. Proposed `CaptureRuntimePromotion` state machine** (common caller) | `prepare_group(plan, sink) -> PreparedGroup`; Cert records the complete verified binding as `CandidatePrepared`; the producer consumes the move-only `PreparedGroup` through `activate_group(prepared) -> GroupLease`; all-root readiness -> `CandidateReady`; `commit(candidate) -> NewActiveCommitted`; `reconcile(receipt) -> RetiredProved or InstallAmbiguous`. The common caller never sees install/session details, `PreparedGroup`, `GroupLease`, or an all-or-nothing rollback method. | Hides candidate/active roots, content-addressed cache, pointer journal, readiness, retirement proof, and durable handoff behind one transition table. Dependencies: filesystem and pointer replacement are local-substitutable, producer session is remote-owned, and a journal fixture is the test adapter. | The common path is simple and promotion invariants are centralized, but a durable state machine couples release promotion to capture persistence and makes independent lifecycle testing harder. |

Selection: choose **B, the proposed explicit ports, while retaining the
existing Python public seams**. `build_ocr_summary` owns typed projection
validation, `capture_document_to_pdf_extraction` owns the exact
`windowsml-ocr` -> `windowsml_ocr` mapping, and `publish_capture_document` plus
`operations.publish_success` owns the atomic durable commit. A future
**proposed** `RuntimeAssetInstaller` may wrap the existing Rust verification
functions, and a future **proposed** `DesktopRuntimeSupervisor` may wrap the
producer-owned session, but neither may add a second coordinator or expose
native handles. This choice gives the best depth/leverage and locality at the
actual seams, keeps dependency adapters replaceable, and makes candidate/swap
failure readable without moving domain ownership.

Deletion test for the selection: deleting `mapping.py` must force page order,
projection checks, and discriminator policy into multiple callers; that
complexity must not reappear. Deleting a proposed facade must not change the
behavior of the existing mapper, summary, persistence, or Rust cleanup seams.
If the implementation cannot satisfy that deletion test, stop the slice and
return to design review.

The compute-policy deletion test is equally strict: remove the host fallback
DTO, coordinator validator, compatibility decoder, frontend mode/adapter/
reason/notice matrices, and their policy-only tests. The host must still decode
the producer-generated public contract and display the producer-owned CPU
fallback notice when no dGPU/iGPU is usable. If deletion would force policy
recalculation into a caller, the producer contract is incomplete and the slice
stops.

The planned verification floor for implementation slices is the narrowest
relevant `corepack pnpm nx` target with `--skip-nx-cache`, followed by the installed
real journey for changes that affect it. This documentation checkpoint runs
docs checks and `git diff --check` only.

## Supersession and documentation rollback

The [lazy-install decision](../DECISIONS/lazy-capture-runtime-installation.md)
and [packaged-smoke spec](packaged-capture-workbench-smoke.md) describe the
current install/start lifecycle and smoke harness. This specification defines
the consumer policy for 0.4.2, including the D4/D7
acceptance distinction, immutable roots, exact engine/discriminator mapping,
and stable-pointer rule. It also supersedes stale statements that deny the
completed Phase 1 local-probe gate or treat it as published/release evidence.

Rollback for this documentation-only change is an additive revert of the
focused documentation commit. It does not alter runtime assets, database
records, package locks, or published artifacts.
