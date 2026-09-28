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

The acceptance seam consumes the future producer bundle/package
`@capture-runtime/acceptance-contract` (proposed
`packages/capture-acceptance-contract/`) and the exact D3/D6-bound
`contractSha256` supplied by the producer ledger. That package is the sole
authority for version, schema, codec, manifest, and hash; its package/target
are absent at this checkpoint, so package/target creation is a producer
discovery/creation stop. The runtime contract-set identity
(`contractSetSha256`) used by `RuntimeReady`/typed OCR is separate from the
acceptance bundle hash. Cert does not define or extend
`ProducerChildScopeV1`, `ProducerChildInvocationV1`,
`ConsumerSemanticResultV1`, or `AcceptanceChildWireV1`; the producer package
is the sole schema and validation authority.

## 2026-09-13 implementation status refresh

The 2026-09-09 checkpoint remains the historical Phase 1 baseline. The current
ledger records bounded implementation evidence and does not mark an unchecked
Phase 2 slice complete.

- Cert Prep is clean at `df9175a2deffe9f6297abf327ec824fb6c0386c4`. Its reviewed
  consumer foundations cover candidate artifact receipt/preflight binding,
  exact OCR projection mapping, and producer-notice presentation. They do not
  install or load a candidate SDK and do not perform promotion.
- Capture Workbench's current committed runtime head is
  `fa5ed29e0b55dd5fc02f400634f3803fb3f56dc4`, following `ca9500b`, `5d92374`,
  `4c36ce1`, and `6127eca`. These commits provide private R3
  Running/Closing/native and staging-cleanup/Terminal foundations. The public
  producer SDK and required `GroupLease`, restart, recovery, and `RequestRef`
  seams, plus a verified D3 candidate/ledger, remain Cert prerequisites.
- The reported Capture evidence is `231` main plus `14` fixture tests passing
  with a known startup flake. It is not evidence of an installed package,
  publication, or real JPEG/PDF OCR acceptance. The active source remains
  pinned to `0.4.1`; synthetic `0.4.2` fixtures do not establish a delivered
  and loaded `0.4.2` schema-3 SDK.

The dependency decision is therefore unchanged: leave Slice 1 migration
readiness and later candidate/promotion/D4/D7 work unchecked until the public
producer seam and immutable verified D3 candidate are available. The next
consumer cut is a private adapter over that exact generated/public seam, then
candidate installation and D4 only after the candidate ledger is verified; no
Cert-local contract substitute is permitted. Rollback stays additive for each
slice, preserves the active `0.4.1` source and durable domain rows, discards
only proven isolated candidate staging before pointer commit, and retains
post-commit candidate reconcile refs/proofs for independent recovery rather
than restoring the prior active root.

## Chosen decisions

1. **Cert owns durable product state.** Cert Prep owns durable sources, domain
   records, review overrides, export, and persistence. Capture Runtime owns
   the ephemeral job and is the sole OCR projection owner. Cert maps and
   persists the typed projection; it does not create a second OCR policy.
2. **The new source contract is OCR-only.** New PDF and image imports write
   only `windowsml_ocr` capture projections. `direct_pdf`, `embedded`, and
   `mixed` are fail-closed at the new import seam. Existing rows with those
   values remain read-only compatibility data and are never a route or a new
   write target.
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
   back to the old active. The addressable producer seam is
   `RuntimeSessionJournal::reconcile(ReconcileRef) -> ReconcileResult`:
   candidate and prior sessions receive distinct nullable refs, and Cert never
   assumes a local Job/process handle, PID, path, port, or takeover lease.
   Complete absence/listener/staging proof may terminalize the addressed ref;
   only its returned `proofSha256` is retained. Present, reused, unqueryable,
   or ambiguous observations remain `reconcile-required` and touch nothing.
   Candidate pre-commit cleanup and prior post-commit retirement retain their
   own ref/proof result and remain independently recoverable. When `prior =
   null` on first install, the prior ref is null and no predecessor proof is
   required. Candidate promotion is whole-group R3:
   `OwnedRuntimeSession::prepare_group(plan: &ImmutableGroupPlan, sink: &dyn
   ReconcileRefSink) -> Result<PreparedGroup, PrepareError>` asks the sink to
   `persist`, `read_back`, and `verify` one complete ordered group/root binding.
   All three sink calls bind the same fresh `bindingAttemptId`, persisted in
   both complete binding and receipt. Cert flushes that complete path-free binding and the verified sink receipt
   digest as `CandidatePrepared` before activation. `PreparedGroup` is
   producer-private, opaque, move-only, live-only, and nonserializable; its
   private `ActivationPermitV1` is never a Cert field or public parameter.
   `OwnedRuntimeSession::activate_group(prepared: PreparedGroup) ->
   Result<GroupLease, LaunchError>` consumes it and activates the whole group.
   Cert verifies all-root loaded-worker/readiness identity, then flushes
   `CandidateReady`; pointer commit intent/CAS follows. Candidate and prior
   group refs remain distinct. A pre-activation/readiness crash never becomes
   `CandidateReady` or changes the pointer.

   A Cert restart never deserializes a permit or resumes an old prepared/ready
   group from its receipt. It reconciles the exact recorded refs and complete
   binding observe-only. If the original producer is still alive and verifies
   live ownership of the exact `GroupLease`, the existing lease may continue
   semantically after a fresh all-root readiness observation; this is not
   replaying `PreparedGroup`. If the producer restarted or lost its native
   handle, Cert cannot claim or adopt the old group. It waits for exact
   terminal/no-resource proof, and every later launch allocates fresh refs and
   runs a fresh `prepare_group`/sink binding. Present, reused, unqueryable, or
   ambiguous observations remain `reconcile-required` and block launch.
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
      model slot to GX Law Prep. Cert consumes the future producer bundle/package
      `@capture-runtime/acceptance-contract` and the exact D3/D6-bound
      `contractSha256`; that package is the sole authority for version, schema,
      codec, manifest, and hash, and is absent at this checkpoint, so package/
      target creation is a producer discovery/creation stop. Cert consumes only
      the producer's frozen, read-only invocation from the separate immutable
      `CAPTURE_ACCEPTANCE_INVOCATION_PATH`; it never consumes the mutable
      `CAPTURE_ACCEPTANCE_SCOPE_PATH`. Cert verifies the invocation's frozen
      canonical bytes and `invocationSha256`, then atomically create-new exactly
      one complete package-defined `ConsumerSemanticResultV1` at
      `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`. The runtime contract-set
      identity (`contractSetSha256`) used by `RuntimeReady`/typed OCR is
      separate from the acceptance bundle hash. The producer validates that
      result, performs cleanup, and later writes `AcceptanceChildWireV1`.
      The package-defined ordered fixture assignments are resolved by the
      proposed private `FixtureCapabilityResolver` adapter for the private JPEG
      and scanned PDF page-1 capabilities; the package codec writes matching
      ordered results and only canonical measurements. No Cert-local result
      fields, privacy block, or cleanup block may be added or restated.
      Restart persistence, review/export, cleanup, and baseline survival are
      required. JPEG CER must be <= 3%, scanned PDF page-1 CER must be <= 1%,
      and critical anchors must have zero omissions. D4/D7 require the full
      private normalized reference plus critical anchors; formal acceptance
      deletes/prohibits `anchorOnly` and `parseOcrAnchorExpectation` in the
      `ocr-truth-contract.mts`/`acceptance-real-options.mts` path. A garbage-
      around-anchors RED fixture must not receive CER 0. Synthetic anchor-only
      expectations may remain unit-only and are barred from D4/D7.
10. **Design gates precede image-flow code.** The image/PDF design receives
    both an independent Standards review and an independent Specification
    review before code. Implementation uses TDD red tests at the public seam,
    deterministic staging, small vertical slices, and exact-HEAD approvals.
11. **Cert acceptance has two named events and a bounded handoff.** D4
      `CandidateAccepted` consumes one immutable, pre-publication candidate and
      the future producer bundle/package `@capture-runtime/acceptance-contract`
      with the exact D3-bound `contractSha256`; that package is the sole
      authority for the result schema/codec/manifest/hash and is absent at this
      checkpoint, so package/target creation is a producer discovery/creation
      stop. Cert consumes the producer's frozen, read-only invocation from
      `CAPTURE_ACCEPTANCE_INVOCATION_PATH`; the producer's mutable scope remains
      at `CAPTURE_ACCEPTANCE_SCOPE_PATH` and is never a Cert input. Cert verifies
      the canonical invocation digest and atomically create-new exactly one
      complete package-defined `ConsumerSemanticResultV1` at the distinct
      `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`. After D5 publication and D6
      download-back byte verification, D7 `PublishedAccepted` repeats the same
      installed journey using only the downloaded bytes and a fresh frozen
      invocation from that invocation path, then writes the same exact producer
      result type bound to D6. For each event, the package-defined ordered
      fixture assignments are resolved by the proposed private
      `FixtureCapabilityResolver` adapter for the JPEG and scanned PDF page-1
      capabilities; the package codec owns the exact ordered result. Cert never
      overwrites or returns the producer scope, receives/writes the wire path,
      defines or restates local result fields, waits for downstream LAW, aggregates ledgers, or moves a
      shared stable pointer. The producer validates the exact result, proves
      cleanup, adds its cleanup/privacy fields to `AcceptanceChildWireV1`, and
      writes that wire at `CAPTURE_ACCEPTANCE_WIRE_PATH`. The schema-1 Cert
      acceptance manifest remains a compatibility input through
      `acceptance-artifacts.mts::writeAcceptanceManifest` and its tests; it is
      not canonical output. Cert emits no aggregate/D8 record.
12. **Immutable roots and a non-rollback promotion transaction are explicit.**
     A **proposed** active root and **proposed** candidate root are immutable,
     separate content identities under the app-owned runtime root. Only a
     verified, durable, content-addressed cache may be shared. Every pointer
     observation uses the closed union `absent | present{generation,sha256}` in
     the receipt, `commitIntent`, logical CAS, locked reread, and crash matrix;
     no null, omitted, or free-form pointer state is valid. Promotion is
     `CandidatePrepared -> CandidateReady -> NewActiveCommitted -> RetiredProved`
     for first install (`prior = null`) or the proven no-session legacy prior, and
     `CandidatePrepared -> CandidateReady -> NewActiveCommitted ->
     PriorRetiredDraining -> RetiredProved` when a prior session exists (excluding the proven no-session legacy prior below), with an
     atomic active-pointer
     replacement at commit. Before commit, failure preserves the active
     root/pointer/session and the candidate group binding is already durable.
     R3 uses the exact producer contract
     `prepare_group(plan: &ImmutableGroupPlan, sink: &dyn ReconcileRefSink) ->
     Result<PreparedGroup, PrepareError>` and sink `persist`, `read_back`, and
     `verify` calls for one complete ordered group/root binding. Cert flushes
     that binding and the verified sink receipt digest as `CandidatePrepared`.
     `PreparedGroup` is producer-private, opaque, move-only, live-only, and
     nonserializable; its private `ActivationPermitV1` is never persisted by
     Cert and is not a public activation parameter. The producer consumes it
     through `activate_group(prepared: PreparedGroup) -> Result<GroupLease,
     LaunchError>`, activates the whole group, and returns a lease only after
     all-root readiness. Cert then flushes `CandidateReady`; no `ProofRef` type
     or slot exists. If `prior = null` on first install,
     compare-and-create-if-absent is the only valid pointer operation;
     `NewActiveCommitted` advances directly to `RetiredProved` with
     `retirement.status = not_applicable`, no degraded flag, and no blocked
     next promotion. An unexpected present pointer is a conflict and
     `InstallAmbiguous`, never an overwrite. For a later promotion with a prior
     session, after commit there is no rollback to the old active: the new active
     remains selected and degraded, blocks the next promotion, retains distinct
     candidate/prior opaque producer refs and only returned `proofSha256`
     values, and retries/reconciles cleanup at next start. A file install is
      `Restored` only after the prior root, manifest, byte count, content hash,
      and session identity are re-proved; otherwise it is `InstallAmbiguous`.
      A completed adopted legacy root may instead be a **proven no-session
      legacy prior**: durable completed adoption identity, uninterrupted
      durable history with no launch intent/group/ref since adoption, reverified
      exact prior content/layout/pointer identity, and unambiguous quiescent
      listener/process ownership are all required. The store serializes this
      check with launch/promotion; launch records durable intent before prepare.
      Persist path-free adoption/content/pointer identities, history revision
      interval, and bounded ownership evidence; revalidate them on recovery.
      Content existence is not a live session. After candidate readiness and
      exact committed pointer proof, advance directly to
      `RetiredProved`/`retirement.status = not_applicable` with present prior
      content identity, null prior group/ref, and no degraded/block flag.
      No fabricated producer ref/hash or pointless prior launch is allowed.
      Missing history/adoption evidence, any intervening launch intent/group/ref,
      changed content, or ambiguous/unqueryable ownership is
      `InstallAmbiguous`/`reconcile-required`; after commit keep new active
      selected/degraded and block further promotion. Actual prior sessions
      still require their own producer ref/proof; missing refs stay blocked.
      Optional content deletion retains exact cleanup-reference checks.
      This branch qualifies all prior-session retirement requirements here;
      the [canonical specification](../SPECS/capture-runtime-consumer.md#proven-no-session-legacy-prior-retirement)
      defines the evidence and crash semantics.

      Before any auto-launch, observe the existing
      `app_data_dir/runtimes/capture-runtime` through the proposed
      `RuntimePromotionStore::observe_legacy_root`. Use existing
      `capture_runtime.rs::installed_capture_runtime_paths`,
      `capture_manifest.rs::verify_capture_runtime` and
      `capture_runtime_expected_version`, `manifests.rs::load_runtime_manifest`
      and `verify_artifact`, plus identity-scoped `process_owner.rs` proof, to
      verify manifest/content hashes, byte count, known version, and quiescence:
      no owned listener, process, producer session, or unqueryable session.
      A present root with missing, mismatched, unreadable, reparse, unknown, or
      ambiguous evidence is not empty and is `InstallAmbiguous`; touch nothing
      (no launch, migrate, delete, overwrite, or promotion). A valid known and
      quiescent root with pointer observation `absent` may use proposed
      `RuntimePromotionStore::adopt_verified_legacy_root`, but only after a
      fully state-discriminated `LegacyAdoptionPrepared` receipt is flushed.
      That receipt records exact logical source and destination root refs,
      content identity, canonical layout identity, pointer intent (expected
      prior `absent`, intended `present{generation,sha256}`, expected revision),
      and move phase (`prepared`, `moved`, `pointer_created`, or `adopted`).
      These are closed populated variants retaining the immutable tuple;
      `none` is allowed only outside adoption states. The spec's phase-aware
      recovery matrix allows one completed-operation crash edge of receipt lag,
      never a receipt phase ahead of the observed move/pointer operation.
      Recovery permits only these exact observations: source exact/destination
      absent/pointer absent continues the recorded move; source absent/
      destination exact/pointer absent completes the recorded pointer; source
      absent/destination exact/pointer exact flushes `LegacyAdopted`. Both
      roots, unexpected or any content/layout/pointer-intent/move-phase
      mismatch, reparse, unqueryable evidence,
      or missing intent is `InstallAmbiguous` and touches nothing. Adoption
      flushes `LegacyAdopted` with `activeSessionRef = null`/
      `sessionState = not-running`, never `CandidateReady`; a later launch must
      run fresh whole-group prepare/activate/readiness and create a new session
      ref. An exact pointer create is never rolled back.
      Replace the current one-shot `RuntimeProcessOwner` `FnOnce` termination
     seam; a second termination call must never return a false success.
13. **Projection strings are not interchangeable.** Producer
    `provenance.engine == "windowsml-ocr"` maps through the existing
    `mapping.py` seam to Cert durable `documents.extraction_method` and page or
    chunk `extraction_method == "windowsml_ocr"`. Embedded PDF layers are
    ignored. No new document/page/chunk may write `direct_pdf`, `embedded`, or
    `mixed`; those values remain legacy read compatibility only.
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
    say CPU fallback when no dGPU/iGPU is usable; the CPU notice merely
    projects producer truth and Cert does not recalculate it.
16. **Audio is a separate lane.** Audio transcription/translation remains in
    its domain specification and is not part of the OCR-only Phase 2 D4/D7
    acceptance or its handoff ledger.
17. **One Cert-owned local pointer and receipt owner.** The proposed
    `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs` module defines
    `RuntimePromotionStore` and `RuntimePromotionReceiptV1` as the sole owner
    of the local installed-runtime logical active pointer, revision/CAS, and
    durable promotion receipts. The module is not yet implemented and is not
    the producer session journal or producer D8 stable pointer. Its receipt
     records candidate/prior content identities, closed-union pointer
     observations, state, commit intent, degraded/block-next-promotion flags,
     separate nullable `candidateReconcileRef` and `priorReconcileRef` slots, the
    `proofSha256` returned by each addressed producer reconcile result when
    available, retirement attempts/status, exact cleanup refs, and sanitized
     errors; raw paths, tokens, PIDs, local handles, and OCR are forbidden. There
     is no `ProofRef` type or independent proof-reference field. R3 uses the
     exact producer `prepare_group(plan, sink) -> PreparedGroup` contract and
     sink `persist`/`read_back`/`verify` calls. The complete group/root binding
     and verified sink receipt digest are durable before activation; the
     producer-private, move-only, nonserializable `PreparedGroup`, its private
     `ActivationPermitV1`, and the live `GroupLease` never enter the Cert
     receipt. The producer consumes the value through
     `activate_group(prepared)`, then Cert verifies all-root readiness before
     `CandidateReady`. Candidate cleanup is independently recoverable before
     commit; prior retirement is independently recoverable after commit and
     cannot consume candidate proof. On Cert restart, old prepared/ready values
     are never replayed: only a still-running original producer with verified
     live lease ownership may continue semantically. After producer restart or
     lost handle, old refs are observe-only until terminal/no-resource proof,
     then any launch uses fresh refs/prepare. For `prior = null`, the prior ref
     is null and `retirement.status = not_applicable`.
    `capture_runtime.rs` verifies/stages/launches, `backend.rs` invokes the
    store from `install_capture_runtime`, `start_capture_runtime`, and
    `restart_owned_backend_with_capture_runtime`, `lib.rs` wires the module
    and startup reconciliation, and `process_owner.rs` supplies the planned
    retryable proof/cleanup seam. The Python
    `RuntimeInstallationManager`/`RuntimeInstaller` scope in
    `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/`
    remains provider/model installation and never writes this pointer or
    receipt.
18. **Promotion ordering is irreversible after local pointer commit.** A pointer
     observation is the closed union `absent | present{generation,sha256}` and
     is used in the receipt, `commitIntent`, logical CAS, locked post-replace
     reread, and startup crash matrix; no null, omitted, or free-form pointer
     state is valid. First install has content identity `prior = null`, pointer
     observation `absent`, and uses compare-and-create-if-absent. Verify the
     immutable candidate/root; call the exact producer
     `prepare_group(plan, sink) -> PreparedGroup`, let the sink
     `persist`/`read_back`/`verify` the complete ordered group/root binding, and
     flush that binding plus its verified sink receipt digest as
     `CandidatePrepared` before activation. `PreparedGroup` is producer-private,
     move-only, live-only, and nonserializable; its private
     `ActivationPermitV1` is never a Cert field. Call only producer
     `activate_group(prepared)`, which consumes the value and activates the
     whole group; verify all-root loaded-worker/readiness identity and then
     flush `CandidateReady`. Candidate and prior group/refs remain distinct and
     no `ProofRef` is retained. Flush
     `commitIntent` with expected prior and intended candidate pointer
     observations; take the store lock, perform the logical CAS/atomic pointer
     operation and flush it, then reread it; flush
     `NewActiveCommitted` only after an exact match. An unexpected present
     pointer on first install is a conflict and `InstallAmbiguous`, never an
     overwrite. If `prior = null`, flush `RetiredProved` directly with
     `retirement.status = not_applicable`, retaining no prior ref and leaving
     degraded/block-next-promotion false. If a prior session exists, persist
     `PriorRetiredDraining` before cleanup, ask the producer for prior proof
     through `RuntimeSessionJournal::reconcile(priorReconcileRef)`, retain only
     its returned `proofSha256`, and flush `RetiredProved` before optional exact
     prior-root deletion. A failed candidate before commit uses only
     `RuntimeSessionJournal::reconcile(candidateReconcileRef)` and leaves the
     active untouched. Before commit, failures preserve active. After commit of
     a later promotion with a prior session, never roll back: keep the new active selected/degraded
     and block the next promotion until prior proof. Complete
     absence/listener/staging proof may advance a ref; missing, present, reused,
     unqueryable, or ambiguous results remain `reconcile-required`/degraded.
     Startup reconciliation compares the same closed pointer observations:
     intent plus prior observation is no commit, intent plus exact candidate
     observation is committed, and any unexpected observation is a conflict/
     `InstallAmbiguous`; missing required session refs remain independently recoverable/blocked
     only for the applicable cleanup path, and temporary, root, backup, or cache
     deletion uses only exact receipt refs. A Cert restart never reuses a
     private permit or resumes a serialized prepared/ready group: it invokes
     observe-only reconciliation for old refs. A still-running original
     producer with verified live ownership may continue its existing lease
     semantically after fresh all-root readiness proof; a producer restart or
     lost handle cannot claim it. After terminal/no-resource proof, any launch
     uses fresh refs and a fresh prepare/binding sequence.

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
| Local installed-runtime pointer/receipt (planned) | **Proposed** `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs`: `RuntimePromotionStore`, `RuntimePromotionReceiptV1`, `observe_legacy_root`, `adopt_verified_legacy_root`; `apps/cert-prep-desktop/src-tauri/src/lib.rs`: `run`; `apps/cert-prep-desktop/src-tauri/src/backend.rs`: `install_capture_runtime`, `start_capture_runtime`, `restart_owned_backend_with_capture_runtime` | Sole Cert owner of the local logical pointer and durable promotion receipt/reconciliation, including legacy-root observation/adoption. It is distinct from the producer session journal and producer D8 stable pointer; current symbols do not exist. |
| Schema-1 manifest to semantic result (planned migration) | `apps/cert-prep-desktop/scripts/acceptance-artifacts.mts`: `writeAcceptanceManifest`; `apps/cert-prep-desktop/scripts/acceptance-artifacts.test.mts`; `apps/cert-prep-desktop/scripts/acceptance-real.mts`: `acceptancePassed`; `apps/cert-prep-desktop/scripts/ocr-semantic-evidence.mts`: `serializePrivacySafeOcrSemanticEvidence`, `OCR_NORMALIZATION_VERSION`; `apps/cert-prep-desktop/scripts/phase1-acceptance-evidence.mts`: `buildPhase1AcceptanceEvidence`; `apps/cert-prep-desktop/scripts/ocr-page-record-evidence.mts`: `assertOcrPageRecordEvidenceIntegrity`; proposed private `FixtureCapabilityResolver` adapter at `apps/cert-prep-desktop/scripts/acceptance-real-options.mts`; proposed installed receipt `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs`: `RuntimePromotionStore`, `RuntimePromotionReceiptV1` | Keep schema-1 as a compatibility input, consume the future `@capture-runtime/acceptance-contract` bundle/package and exact D3/D6-bound `contractSha256`, consume only the frozen/read-only `CAPTURE_ACCEPTANCE_INVOCATION_PATH`, verify its canonical digest, and atomically create-new one exact package-defined `ConsumerSemanticResultV1` at `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`. The package is the sole schema/codec/manifest/hash authority and is absent at this checkpoint, so package/target creation is a discovery/creation stop. The resolver supplies ordered private JPEG and scanned PDF page-1 capabilities; no Cert-local schema restatement, cleanup, or privacy block. The producer validates/cleans up and later writes `AcceptanceChildWireV1`; its scope/wire symbols and cleanup fields are not Cert symbols. Preserve the generated view `libs/cert-prep-api/src/lib/cert-prep-api.generated.ts` and never create an aggregate/D8 record. |
| Python backend installer (separate) | `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/manager.py`: `RuntimeInstallationManager`, `RuntimeInstaller`; `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/installers.py`: `LLMModelInstaller` | Owns provider/model requirement jobs and snapshots only; it never writes the desktop local runtime pointer or receipt. |

## Design-It-Twice selection

Three **proposed** interface shapes were compared before selecting the seam;
none of these proposed names is an existing Cert symbol.

| Candidate | Usage and hidden internals | Dependencies/adapters | Trade-off and decision |
| --- | --- | --- | --- |
| **proposed `CaptureRuntimeFacade`** | `facade.capture(candidate, upload) -> receipt`; hides auth, roots, session, projection, mapping, and durable commit. | Installed runtime remote-owned; filesystem local-substitutable; SQLite durable; deterministic receipt test adapter. | Deep for one caller but fuses unrelated failure modes and risks a second coordinator. Rejected. |
| **proposed explicit ports**: `RuntimeAssetInstaller`, `DesktopRuntimeSupervisor`, `OcrProjectionMapper` | `installer.prepare(candidate)`, `supervisor.start(verified)`, `mapper.map(projection)`; hides manifest/hash, producer session/pointer, and discriminator details. | Existing Rust verification functions are native filesystem adapters; producer session is remote-owned; existing Python owners are domain adapters; failure-injection fakes are test adapters. | More interface knowledge, but high leverage/locality and readable typed failures. Selected. |
| **proposed `CaptureRuntimePromotion`** | `prepare_group(plan, sink) -> PreparedGroup`; Cert persists the complete verified binding as `CandidatePrepared`; producer consumes the move-only `PreparedGroup` through `activate_group(prepared) -> GroupLease`; all-root readiness -> `CandidateReady`; `commit(candidate) -> NewActiveCommitted`; `reconcile(receipt) -> RetiredProved or InstallAmbiguous`; hides cache, pointer journal, retirement proof, readiness, and publication. | Filesystem/pointer local-substitutable; producer session remote-owned; journal fixture test adapter. | Common caller is simple, but promotion becomes coupled to persistence and harder to test independently. Rejected. |

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
- **One generic producer session/proof slot or a local handle assumption:**
  rejected because candidate pre-commit cleanup and prior post-commit
  retirement are independent recoveries. Cert must address each producer
  session with its own opaque `ReconcileRef` through
  `RuntimeSessionJournal::reconcile`; handles, PIDs, paths, and ports are not
  durable recovery identity.
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
- **Keeping the schema-1 aggregate acceptance manifest as the handoff:**
  rejected because it collapses Cert's JPEG/PDF fixture results and can imply
  producer aggregation/D8 authority. The migration consumes the future
  `@capture-runtime/acceptance-contract` bundle/package and exact D3/D6-bound
  `contractSha256`, consumes only the frozen, read-only
  `CAPTURE_ACCEPTANCE_INVOCATION_PATH` after canonical-digest verification,
  and atomically create-new one exact package-defined `ConsumerSemanticResultV1`
  at `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`. The package is the sole schema/
  codec/manifest/hash authority and is absent at this checkpoint, so package/
  target creation is a producer discovery/creation stop. The proposed private
  `FixtureCapabilityResolver` supplies ordered fixture capabilities and full
  truth to the package codec; no Cert-local result schema is restated. The
  producer remains the sole scope owner and later emits `AcceptanceChildWireV1`
  at its wire path, including cleanup/privacy fields.
  Cert never writes or receives the mutable scope/wire output.

## Supersession, review, and documentation rollback

This record supersedes older Cert statements that denied the completed Phase 1
local-probe gate, treated local-probe evidence as published/release acceptance,
or allowed embedded/mixed output for a new import. The earlier lazy-install and
packaged-smoke documents were removed; this record and the consumer
specification replace them.

The review unit is the exact documentation commit. Any subsequent commit,
generated artifact, or rebase invalidates both review axes. The rollback is an
additive revert of the documentation commit only; runtime assets, database
records, lockfiles, and published artifacts are untouched.

## 2026-09-27 publication

Capture Runtime 0.4.2 was published and Cert Prep moved its pins to it (PR #21)
after its CI and a published-mode practical OCR run of the canonical JPEG in
the installed app. Test scope was relaxed in favour of publishing: the fake
host-flow smoke was removed, and the candidate gate treats a candidate equal to
the pinned version as the published-pin path. The Capture candidate gate was
repaired for pnpm 12 (PRs #22-#24): the pinned `pnpm/action-setup`, no
`--lockfile=false`, committed pins restored after the candidate install, the
runtime client resolved beside the UI package in pnpm's store, and GitHub
Packages auth for the checks.
