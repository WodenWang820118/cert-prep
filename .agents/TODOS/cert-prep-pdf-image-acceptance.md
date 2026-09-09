# Cert Prep real PDF and image acceptance

## Status checkpoint (2026-09-09)

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

Phase 1 local-probe acceptance is complete. This checklist captures the
remaining Phase 2 sequential formal/published-package regression path. D4 is
the pre-publication immutable-candidate acceptance. Cert imports producer
`ProducerAcceptanceContractV1` version `"1"` and the exact D3/D6-bound
`contractSha256`, consumes only the frozen/read-only
`ProducerChildInvocationV1` at `CAPTURE_ACCEPTANCE_INVOCATION_PATH`, verifies
its canonical digest, and atomically create-new exactly one complete
producer-schema `ConsumerSemanticResultV1` at the distinct
`CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`. The producer owns the mutable
`ProducerChildScopeV1` at `CAPTURE_ACCEPTANCE_SCOPE_PATH`; Cert never consumes,
overwrites, returns, or writes that scope. Cert never writes a child wire. D7
repeats the same journey from D5/D6 published download-back bytes with a fresh
frozen invocation and writes the same exact semantic result type at that result
path. The producer validates the result, proves cleanup, adds cleanup/privacy
fields, and later writes immutable `AcceptanceChildWireV1` at
`CAPTURE_ACCEPTANCE_WIRE_PATH`, then directs any handoff to LAW. Cert never
waits for LAW, aggregates consumer ledgers, or mutates/rolls back the producer
stable pointer. The producer alone aggregates child wires and owns D8
stable-pointer promotion. Cert owns durable source/review/export state;
`capture-runtime` owns the OCR projection.
The producer engine `windowsml-ocr` maps to the Cert durable discriminator
`windowsml_ocr`; embedded layers are ignored, and `direct_pdf`/`embedded`/`mixed`
are legacy read-only compatibility values only. No new `direct_pdf`, `embedded`,
or `mixed` write is permitted.

`ConsumerSemanticResultV1` is not locally defined or extended. Its ordered
producer `fixtureAssignments[]` must map one-for-one to equal-cardinality,
equal-order `fixtureResults[]` for the private JPEG and scanned PDF page 1,
preserving exact assignment identity/media/page/oracle/truth/anchor/threshold/
artifact fields and supplying only canonical measurements. It has no Cert-local
privacy or cleanup fields; producer cleanup/privacy is added only to the final
wire.

Audio transcription/translation is a separate Capture Runtime lane and is not
part of this OCR-only PDF/JPEG Phase 2 acceptance.

The canonical implementation slices, exact owners, red proofs, green
verification, prerequisites, stop conditions, rollback, and discovered Nx
commands are in the [consumer TODO](capture-runtime-consumer.md). The register
below binds this acceptance checklist to those slices without inventing a
second owner. An unavailable package manager or undiscovered target is a
discovery-stop, never a green claim.

For both events, the **proposed** `runtime_promotion.rs` store is the sole Cert
local installed-runtime pointer/receipt owner. `lib.rs::run` wires startup
reconciliation; `backend.rs::install_capture_runtime`,
`start_capture_runtime`, and `restart_owned_backend_with_capture_runtime` are
callers; `capture_runtime.rs` verifies/stages/launches; and
`process_owner.rs` supplies the planned retryable producer proof/cleanup seam.
The store is distinct from the producer session journal and D8 stable pointer.
Every pointer observation in its receipt, intent, logical CAS, reread, and crash
matrix uses the closed union `absent | present{generation,sha256}`. Its receipt
retains separate nullable `candidateReconcileRef` and `priorReconcileRef` slots
and only the `proofSha256` returned by each addressed producer reconcile result;
there is no `ProofRef` type or independent proof-reference field. R3 uses the
producer `ReconcileRefSink::persist(ref,generation) ->
ActivationPermit{refDigest,generation,receiptDigest}`; persist the exact
candidate ref and permit receipt before activation. The candidate ref is
persisted before activation. For first install (`prior = null`, pointer
observation `absent`), compare-and-create-if-absent is required, retirement is
`not_applicable`, and, after candidate/session conditions,
`NewActiveCommitted` advances directly to `RetiredProved` without degraded or
permanently blocked state. An unexpected present observation is a
conflict/`InstallAmbiguous`. When a prior exists, candidate pre-commit cleanup
and prior post-commit retirement are independent recovery paths and never
substitute one another's ref or returned proof.
The producer API is `RuntimeSessionJournal::reconcile(ReconcileRef) ->
ReconcileResult`; the ref is an opaque journal address, not a local Job/process
handle, PID, path, port, or takeover lease. Complete absence/listener/staging
proof may terminalize its addressed ref; present, reused, unqueryable, or
ambiguous observations remain `reconcile-required` and degraded only for the
applicable prior-retirement path.
The Python `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/manager.py`
(`RuntimeInstallationManager`, `RuntimeInstaller`) and its
`apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/installers.py`
(`LLMModelInstaller`) remain provider/model installation only.

## Acceptance slice register

- **Cert semantic-result migration (prerequisite to D4/D7):** preserve the
  current schema-1 local `acceptance-manifest.json` as a compatibility input
  through `apps/cert-prep-desktop/scripts/acceptance-artifacts.mts::writeAcceptanceManifest`
  (covered by `apps/cert-prep-desktop/scripts/acceptance-artifacts.test.mts`)
  and keep `apps/cert-prep-desktop/scripts/acceptance-real.mts::acceptancePassed`
  as the caller/verdict only. Import producer `ProducerAcceptanceContractV1`
  version `"1"` and the exact D3/D6-bound `contractSha256`; consume only the
  frozen/read-only invocation from `CAPTURE_ACCEPTANCE_INVOCATION_PATH`, verify
  its canonical digest, and atomically create-new exactly one complete
  producer-schema `ConsumerSemanticResultV1` at the distinct
  `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`; never consume, overwrite, return,
  or write the mutable producer scope at `CAPTURE_ACCEPTANCE_SCOPE_PATH` and
  never write/receive `CAPTURE_ACCEPTANCE_WIRE_PATH`. The producer validates
  the result, proves cleanup, adds cleanup/privacy fields, and later writes
  `AcceptanceChildWireV1`.
  Use `apps/cert-prep-desktop/scripts/ocr-semantic-evidence.mts::serializePrivacySafeOcrSemanticEvidence`
  (`OCR_NORMALIZATION_VERSION`),
  `apps/cert-prep-desktop/scripts/phase1-acceptance-evidence.mts::buildPhase1AcceptanceEvidence`,
  and `apps/cert-prep-desktop/scripts/ocr-page-record-evidence.mts::assertOcrPageRecordEvidenceIntegrity`
  for semantic/page proof. The full-reference seams remain
  `apps/cert-prep-desktop/scripts/ocr-truth-contract.mts::evaluateOcrTruth`,
  `normalizeOcrText`, `parseOcrTruthManifest`, and `levenshtein`. Formal D4/D7
  deletes/prohibits `anchorOnly` and `parseOcrAnchorExpectation` there,
  including the import/call in `apps/cert-prep-desktop/scripts/acceptance-real-options.mts`;
  synthetic anchor-only expectations may remain unit-only but are barred from
  acceptance. Retain/regenerate the producer-generated view
  `libs/cert-prep-api/src/lib/cert-prep-api.generated.ts`
  (`RuntimeReady`, `OcrComputePreflightV2`) without hand-editing or deleting it;
  it is not a child-wire writer. The proposed installed candidate receipt
  owner is `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs`
  (`RuntimePromotionStore`, `RuntimePromotionReceiptV1`) with separate nullable
  candidate/prior reconcile refs and only returned `proofSha256` values.
  Ordered producer `fixtureAssignments[]` is mandatory; Cert maps both private
  JPEG and scanned-PDF page-1 assignments one-for-one to equal-cardinality,
  equal-order `fixtureResults[]`, preserving exact assignment identity/media/
  page/oracle/truth/anchor/threshold/artifact fields and supplying only
  canonical measurements. `ConsumerSemanticResultV1` has no Cert-local
  privacy or cleanup fields; raw OCR/truth, media, tokens, paths, and native
  identities stay out of it. Bind the result to the invocation/tier and closed
  D4/D3 or D7/D6 ledger identity. Prerequisite: consumer TODO Slices 1-4.5 and
  the producer scope/invocation/result/wire contract. Red proof: schema-1 output
  for a new run, missing/escaped/unbound invocation or result, writable/replaced
  invocation, canonical-digest/contract mismatch, scope overwrite/return,
  second/partial result write, missing or reordered JPEG/PDF fixture result,
  duplicate identity, missing binding, missing semantic digest/CER/anchor/
  outcome, any false lifecycle flag, missing/substituted receipt ref, raw
  OCR/token/path/process data, a garbage-around-anchors result receiving CER 0,
  a new `direct_pdf`, `embedded`, or `mixed` value, `evidence.aggregate`, an
  aggregate/D8 field, child-wire/cleanup write, or stable-pointer mutation must
  fail closed. Green verification uses the existing
  discovered targets:
  `corepack pnpm nx run cert-prep-desktop:phase1-evidence-test --skip-nx-cache`;
  `corepack pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`;
  `corepack pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`.
  Proposed focused regression names in
  `apps/cert-prep-desktop/scripts/acceptance-artifacts.test.mts` and the
  semantic-evidence tests are `rejects_schema1_output_for_new_run`,
  `writes_one_consumer_semantic_result_only`,
  `rejects_scope_overwrite_or_wire_write`,
  `requires_private_jpeg_and_scanned_pdf_page1_fixture_results`,
  `rejects_garbage_around_anchors_even_when_anchors_are_present`, and
  `rejects_anchor_only_expectation_in_formal_acceptance`. Keep these red until
  the producer-compatible result handoff is implemented; green requires the
  complete semantic result and no Cert child-wire output.
  First run `corepack pnpm nx show project cert-prep-desktop --json` if a
  semantic-result target is needed; no dedicated child-wire target exists at
  this head, so target or schema creation is an explicit discovery stop rather
  than an invented command. Rollback is an additive revert of the adapter/tests,
  retaining schema-1 compatibility and failed semantic evidence without
  publication. Commit boundary: `feat(phase2): emit cert semantic result`.

- **D4 candidate journey:** owned by
  the **proposed** local pointer/receipt seam
  `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs`
  (`RuntimePromotionStore`, `RuntimePromotionReceiptV1`) plus
  `apps/cert-prep-desktop/scripts/acceptance-artifacts.mts`
  (`writeAcceptanceManifest`) and its
  `apps/cert-prep-desktop/scripts/acceptance-artifacts.test.mts` tests;
  `apps/cert-prep-desktop/scripts/acceptance-real.mts`
  (`acceptancePassed`, caller/verdict only),
  `apps/cert-prep-desktop/scripts/acceptance-real-options.mts`
  (`createAcceptanceSmokeOptions`, `loadPhase1FinalCandidate`),
  `apps/cert-prep-desktop/scripts/ocr-truth-contract.mts`
  (`parseOcrTruthManifest`, `evaluateOcrTruth`, `normalizeOcrText`),
  `apps/cert-prep-desktop/scripts/ocr-semantic-evidence.mts`
  (`serializePrivacySafeOcrSemanticEvidence`, `OCR_NORMALIZATION_VERSION`),
  `apps/cert-prep-desktop/scripts/ocr-page-record-evidence.mts`
  (`assertOcrPageRecordEvidenceIntegrity`), and backend
  `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/ocr_summary.py`
  (`build_ocr_summary`, `_map_provenance`),
  `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/mapping.py`
  (`_ocr_only_extraction_method`), and
  `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/persistence.py`
  (`publish_capture_document`). First red proof:
  old/local/fake/mismatched candidate or threshold/anchor/cleanup failure,
  missing full private normalized reference, or garbage around otherwise
  present anchors must fail before a D4 semantic result. Cert consumes only the
  frozen/read-only D4 invocation from `CAPTURE_ACCEPTANCE_INVOCATION_PATH`,
  verifies its canonical digest and D3 contract hash, and writes exactly one
  exact producer-schema `ConsumerSemanticResultV1` at
  `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`, with ordered `fixtureResults[]`
  matching ordered `fixtureAssignments[]` one-for-one for the private JPEG and
  scanned PDF page 1; the producer validates/cleans up and later writes the
  child wire. The mutable producer scope remains at
  `CAPTURE_ACCEPTANCE_SCOPE_PATH`. Prerequisite: consumer TODO Slices 1-7 and
  4.5 and producer D3 candidate record. Stop if D4 changes the producer stable
  pointer, consumes/overwrites/returns/writes scope, writes wire/cleanup, writes
  direct_pdf/embedded/mixed, waits for LAW, aggregates ledgers, or records raw
  text/token/path/process data. Formal D4 deletes/prohibits `anchorOnly` and
  `parseOcrAnchorExpectation`; full private normalized truth plus critical
  anchors is mandatory and synthetic anchor-only fixtures are unit-only. The
  local promotion red proof must also verify immutable candidate/root ->
  persisted candidate `ReconcileRef` via producer `ReconcileRefSink` and
  `ActivationPermit{refDigest,generation,receiptDigest}` -> flushed
  `CandidateReady` -> flushed `commitIntent` with expected prior
  `PointerObservation` -> locked logical CAS/atomic pointer replace plus exact
  reread -> irreversible `NewActiveCommitted`.
  If `prior = null`, the prior pointer observation is `absent` and the store
  uses compare-and-create-if-absent; an unexpected `present{generation,sha256}`
  is a conflict/`InstallAmbiguous`, never an overwrite. Advance directly to
  `RetiredProved` with `retirement.status = not_applicable` and no
  degraded/block-next-promotion flag; otherwise flush `PriorRetiredDraining`
  before cleanup -> producer proof -> `RetiredProved`.
  Rollback follows the consumer transaction: before local active commit
  preserve the active root/session; after commit keep the new active degraded
  with its exact candidate/prior reconcile refs and returned `proofSha256`
  values and retry or reconcile the relevant cleanup slot independently; never
  roll back the producer stable pointer. Cert writes no child wire or cleanup
  proof.
  Green verification: `corepack pnpm nx run cert-prep-desktop:capture-candidate-gate-test --skip-nx-cache`;
  `corepack pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`; and
  `corepack pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`.
  Commit boundary: the D4 evidence-only semantic-result acceptance change; the
  producer child wire is emitted later by the producer-owned flow.
- **D7 published download-back journey:** owned by
  the **proposed** local pointer/receipt seam
  `apps/cert-prep-desktop/src-tauri/src/runtime_promotion.rs`
  (`RuntimePromotionStore`, `RuntimePromotionReceiptV1`) plus
  `apps/cert-prep-desktop/scripts/acceptance-artifacts.mts`
  (`writeAcceptanceManifest`) and its
  `apps/cert-prep-desktop/scripts/acceptance-artifacts.test.mts` tests;
  `apps/cert-prep-desktop/scripts/acceptance-real.mts`
  (`acceptancePassed`, caller/verdict only),
  `apps/cert-prep-desktop/scripts/acceptance-real-options.mts`
  (`loadRuntimeCandidate`, `strictRuntimeIdentity`),
  `apps/cert-prep-desktop/scripts/ocr-truth-contract.mts`
  (`parseOcrTruthManifest`, `evaluateOcrTruth`, `normalizeOcrText`),
  `apps/cert-prep-desktop/scripts/ocr-page-record-evidence.mts`
  (`assertOcrPageRecordEvidenceIntegrity`),
  `apps/cert-prep-desktop/scripts/phase1-acceptance-evidence.mts`
  (`buildPhase1AcceptanceEvidence`),
  `apps/cert-prep-desktop/scripts/phase1-final-identity.mts`
  (`loadPhase1FinalEvidence`),
  `apps/cert-prep-desktop/scripts/ocr-semantic-evidence.mts`
  (`serializePrivacySafeOcrSemanticEvidence`, `OCR_NORMALIZATION_VERSION`),
  and the producer's immutable, frozen/read-only
  `CAPTURE_ACCEPTANCE_INVOCATION_PATH` invocation input, plus
  `tools/capture-runtime-version-check.mts`
  (`assertCaptureRuntimeConsumerVersions`) and
  `apps/cert-prep-desktop/src-tauri/src/capture_manifest.rs`
  (`verify_capture_runtime`, `validate_capture_manifest_contract`) and
  `apps/cert-prep-desktop/src-tauri/src/manifests.rs` (`verify_artifact`).
  First red proof: local URL/path, mutable artifact,
  stale/mixed lock, download-back byte mismatch, missing full private
  normalized reference, or garbage around otherwise present anchors must fail.
  Prerequisite: D5 published exact D3 bytes and D6 download-back record, and
  consumer TODO Slice 4.5 is green. Cert consumes only the frozen/read-only D7
  invocation from `CAPTURE_ACCEPTANCE_INVOCATION_PATH`, verifies its canonical
  digest and D6 contract hash, and atomically create-new exactly one exact
  producer-schema `ConsumerSemanticResultV1` at
  `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`, with ordered `fixtureResults[]`
  matching ordered `fixtureAssignments[]` one-for-one for the private JPEG and
  scanned PDF page 1 and D7/tier/D6 binding. The mutable producer scope remains
  at `CAPTURE_ACCEPTANCE_SCOPE_PATH` and is never a Cert input.
  Stop without a complete semantic result. The producer validates/cleans up
  and later writes the D7 `AcceptanceChildWireV1`; Cert never writes/receives
  that wire or waits for LAW's ledger. The same promotion order and startup
  crash matrix apply: pointer observations are the closed union
  `absent | present{generation,sha256}`; intent plus exact prior observation is
  no commit; intent plus exact candidate observation advances to committed;
  with `prior = null`, prior observation is `absent` and compare-and-create-if-
  absent is required before advancing directly to `RetiredProved`/
  `not_applicable`; an unexpected present pointer is a conflict/
  `InstallAmbiguous`; candidate cleanup and prior retirement use their
  distinct producer refs; missing/present/reused/unqueryable/ambiguous
  producer observations remain `reconcile-required`/degraded for a prior
  retirement; and deletion uses exact cleanup refs only.
  Rollback follows the
  consumer transaction: before local active commit preserve the active
  identity; after commit keep the new active degraded with its exact
  candidate/prior reconcile refs and returned `proofSha256` values and
  retry/reconcile the relevant slot independently. Never mutate or roll back
  the producer stable pointer. Commit
  boundary: the D7 `ConsumerSemanticResultV1` update followed by the
  producer-directed child-wire handoff to LAW. Green verification:
  `corepack pnpm nx run cert-prep-desktop:release-tool-test --skip-nx-cache`;
  `corepack pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`; and
  `corepack pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`.
- **D8 stable-pointer decision (producer-owned and out of scope):** Cert has
  no stable-pointer writer, aggregate-ledger owner, or D8 commit. The producer
  alone validates/cleans up, writes `AcceptanceChildWireV1`, aggregates Capture
  Workbench, Cert Prep, and LAW child wires, and moves its stable pointer. Cert
  must not wait for downstream LAW before completing its semantic result; the
  producer owns emission and handoff of its D7 wire. There is no Cert
  red/green/rollback step for D8.
- **Privacy and semantic evidence:** owned by
  `apps/cert-prep-desktop/scripts/ocr-truth-contract.mts`
  (`parseOcrTruthManifest`, `evaluateOcrTruth`, `normalizeOcrText`,
  `levenshtein`),
  `apps/cert-prep-desktop/scripts/ocr-semantic-evidence.mts`
  (`serializePrivacySafeOcrSemanticEvidence`, `OCR_NORMALIZATION_VERSION`),
  `apps/cert-prep-desktop/scripts/ocr-page-record-evidence.mts`
  (`assertOcrPageRecordEvidenceIntegrity`),
  `apps/cert-prep-desktop/scripts/phase1-acceptance-evidence.mts`
  (`buildPhase1AcceptanceEvidence`), and
  `apps/cert-prep-desktop/scripts/phase1-final-identity.mts`
  (`loadPhase1FinalEvidence`). First red proof: raw OCR/truth text, bearer
  token, local path, process/native identity, host/user name, or environment
  dump must fail semantic-result validation. The full private normalized
  reference plus critical anchors is mandatory for D4/D7; explicit formal
  deletion/prohibition of `anchorOnly` and `parseOcrAnchorExpectation` is
  required, and a garbage-around-anchors result must not receive CER 0.
  Synthetic anchor-only expectations are unit-only and barred from acceptance.
  Prerequisite: the exact candidate or download-back bytes. Stop on CER > 1%
  for scanned PDF page 1, CER > 3% for real JPEG, or any missing critical
  anchor. `ConsumerSemanticResultV1` is the exact producer schema with only its
  canonical per-fixture semantic measurements; it has no Cert-local privacy or
  cleanup fields. Cleanup/process/path/raw text remain out of it and are
  producer-wire concerns. Rollback retains failed evidence without publishing
  it. Green verification:
  `corepack pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`;
  `corepack pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`; and
  `corepack pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`.
  Commit boundary: the exact producer semantic-result schema reference and
  privacy-safe evidence mapping; no local schema extension.

## Ordered real journey

- [ ] Confirm the exact candidate tier before launch. For a local candidate,
      URL/port identify transport only; hard-gate contract/schema, archive
      boundary, provenance, and loaded runtime-worker identity. For published
      acceptance, require strict 0.4.2 locks, hashes, manifests, and
      download-back byte identity. Reject sibling junctions, local/source
      paths, `direct_url`, and mixed 0.4.1/0.4.2 versions wherever applicable.
- [ ] Confirm the producer's Capture Workbench gate has run the private JPEG,
      then the original private PDF page 1, with cleanup and released model
      memory between runs. Do not start Cert before that gate is current.
- [ ] Launch the installed Cert Prep app with the real private JPEG. Assert
      the resulting page projection is semantic, ordered, and
      `windowsml_ocr`-provenanced; no direct_pdf, embedded-text, or host OCR route
      is used.
      Require CER <= 3% and zero missing critical anchors.
- [ ] Complete `afterCapture` cleanup for the JPEG before beginning the PDF
      run. Prove owned listeners, PIDs, run data, and staging are gone while
      durable runtime/model assets remain.
- [ ] Run the real private PDF's page 1 only. Assert the same
      `windowsml_ocr` projection and producer provenance. Full-document OCR is
      a separate gate reserved for a tested ordering, accumulation, memory, or
      accuracy risk. Require page-1 CER <= 1% and zero missing critical
      anchors.
- [ ] Complete `afterCapture` cleanup for the PDF before any next consumer.
      Before handing the model slot to LAW, prove zero owned backend,
      Capture Runtime, OCR/model PIDs, listeners, run data, and staging.
- [ ] Restart Cert Prep. Confirm durable source identity, projection
      reference, review override, and domain persistence reload without
      reviving an old runtime session or losing page order/provenance.
- [ ] Review the OCR result, apply a Cert-owned review override, and export
      the durable domain result. Export must preserve the OCR provenance but
      must not expose runtime diagnostics as domain data.
- [ ] Close the app and prove identity-scoped cleanup. Durable runtime/model
      assets and caches survive; the pre-existing external Ollama baseline
      survives; only Cert-owned listeners, PIDs, run data, and staging are
      removed.
- [ ] Inspect the exact producer-schema `ConsumerSemanticResultV1`. Its ordered
      `fixtureResults[]` must match ordered `fixtureAssignments[]` one-for-one
      for the private JPEG and scanned PDF page-1 assignments, retaining exact
      identity/media/page/oracle/truth/anchor/threshold/artifact fields and
      canonical actual normalized-output digest, CER, anchor omissions, outcome,
      projection digest, and semantic-result digest. Cert consumes only the
      frozen/read-only invocation from
      `CAPTURE_ACCEPTANCE_INVOCATION_PATH`, verifies its canonical digest, and
      writes the result only by atomic create-new at
      `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`; it never consumes the mutable
      producer scope at `CAPTURE_ACCEPTANCE_SCOPE_PATH`, writes or receives the
      producer `CAPTURE_ACCEPTANCE_WIRE_PATH`, or adds local privacy/cleanup
      fields. The producer adds cleanup/privacy to `AcceptanceChildWireV1` only
      after validation and cleanup. Raw OCR text, truth text, tokens, local
      paths, process/native IDs, host/user names, and environment dumps must not
      be present in the semantic result.

- [ ] Label the semantic result `D4 CandidateAccepted` before publication. It
      must identify the immutable candidate and must not move the producer
      stable pointer; write only Cert's D4 semantic result before the producer
      validates it and emits any child wire.
- [ ] After D5 publication and D6 download-back hash verification, rerun from
      downloaded bytes and label the result `D7 PublishedAccepted`. Write only
      Cert's D7 semantic result; the producer validates/cleans up and directs
      its emitted child wire to LAW. Do not write the scope/wire, wait for LAW,
      or call D4 local/candidate evidence published acceptance.

## Failure and evidence rules

- A missing/malformed asset, identity mismatch, incompatible handshake,
  unavailable OCR requirement, malformed projection, cancellation, timeout,
  or runtime failure is terminal or unavailable. Cert does not create a local
  OCR fallback.
- The UI presents producer `OcrComputePreflightV2` and notice only. It does not
  rank adapters, derive mode/reason/notice values, or recalculate policy. It
  decodes the exact generated public contract and displays producer-owned
  notice truth, retaining enough truth to tell the user CPU fallback was
  selected when no dGPU/iGPU was usable. The CPU notice is a projection of
  producer truth only; Cert does not recalculate mode/reason/notice.
  Post-selection DirectML failure is fail-closed and receives no host CPU retry.
  The delete-first inventory and tests are tracked in consumer TODO Slice 3.
- The accepted local-package result is `local-probe` evidence only: it
  completes Phase 1 but is not published/release evidence. A clean local
  install cannot become published evidence by changing the URL or claiming
  the current repository HEAD.
- Package QA, protocol fakes, snapshots, a supplied older executable, and a
  successful exit code are supporting checks, not real OCR acceptance.
- If any ordered run or cleanup proof fails, stop the Cert handoff, preserve
  the privacy-safe semantic-result failure artifact, and do not start LAW.
  Apply the consumer transaction rule: before local active commit preserve the
  active root/pointer/session and retry candidate cleanup only through its
  distinct `candidateReconcileRef`; after commit of a later promotion retain the
  new active degraded with its distinct `priorReconcileRef` and only returned
  `proofSha256`, then retry/reconcile prior retirement through the producer API.
  For first install (`prior = null`), do not invent predecessor proof or enter a
  degraded/block-next-promotion loop. Never mutate or roll back the producer
  stable pointer or write its scope/wire.

## Design and verification gate

Any change to this image/PDF journey requires a written design and both
independent review axes before code. TDD starts with a red test at the public
consumer seam. Candidate staging must be deterministic and isolated. Future
implementation verification uses the narrowest package-manager-prefixed Nx
target with `--skip-nx-cache`, followed by this installed journey when its
source or producer identity changes. This documentation checkpoint performs
docs checks and `git diff --check` only.

## Supersession

The historical [lazy-install decision](../DECISIONS/lazy-capture-runtime-installation.md)
and [packaged-smoke spec](../SPECS/packaged-capture-workbench-smoke.md) remain
for traceability. No corresponding TODO files exist; do not invent or revive
those references as active work. Current D4/D7, roots, version-first staging,
and exact projection mapping are defined by the [consumer specification](../SPECS/capture-runtime-consumer.md),
[decision](../DECISIONS/capture-runtime-consumer.md), and [consumer TODO](capture-runtime-consumer.md).
