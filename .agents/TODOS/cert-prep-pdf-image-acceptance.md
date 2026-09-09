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
the pre-publication immutable-candidate acceptance; Cert writes only its own
candidate child ledger and hands it to the producer publication lane. D7
repeats the same journey from D5/D6 published download-back bytes and is the
formal published acceptance; Cert writes only its own published child ledger
and hands it to LAW. Cert never waits for LAW, aggregates consumer ledgers, or
mutates/rolls back the producer stable pointer. The producer alone aggregates
child ledgers and owns D8 stable-pointer promotion. Cert owns durable
source/review/export state; `capture-runtime` owns the OCR projection.
The producer engine `windowsml-ocr` maps to the Cert durable discriminator
`windowsml_ocr`; embedded layers are ignored, and `embedded`/`mixed` are
legacy read-only compatibility values only.

Audio transcription/translation is a separate Capture Runtime lane and is not
part of this OCR-only PDF/JPEG Phase 2 acceptance.

The canonical implementation slices, exact owners, red proofs, green
verification, prerequisites, stop conditions, rollback, and discovered Nx
commands are in the [consumer TODO](capture-runtime-consumer.md). The register
below binds this acceptance checklist to those slices without inventing a
second owner. An unavailable package manager or undiscovered target is a
discovery-stop, never a green claim.

## Acceptance slice register

- **D4 candidate journey:** owned by
  `apps/cert-prep-desktop/scripts/acceptance-real.mts`
  (`acceptancePassed`, `writeAcceptanceManifest`),
  `apps/cert-prep-desktop/scripts/acceptance-real-options.mts`
  (`createAcceptanceSmokeOptions`, `loadPhase1FinalCandidate`),
  `apps/cert-prep-desktop/scripts/ocr-truth-contract.mts`
  (`parseOcrTruthManifest`), and backend
  `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/ocr_summary.py`
  (`build_ocr_summary`, `_map_provenance`),
  `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/mapping.py`
  (`_ocr_only_extraction_method`), and
  `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/persistence.py`
  (`publish_capture_document`). First red proof:
  old/local/fake/mismatched candidate or threshold/anchor/cleanup failure
  must fail before a D4 manifest. Prerequisite: consumer TODO Slices 1-7 and
  producer D3 candidate record. Stop if D4 changes the producer stable pointer,
  writes embedded/mixed, waits for LAW, aggregates ledgers, or records raw
  text/token/path. Rollback follows the consumer transaction: before local
  active commit preserve the active root/session; after commit keep the new
  active degraded with its exact producer session/proof token and retry or
  reconcile cleanup; never roll back the producer stable pointer. Cert writes
  only its D4 candidate child ledger, then hands it to the producer.
  Green verification: `pnpm nx run cert-prep-desktop:capture-candidate-gate-test --skip-nx-cache`;
  `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`; and
  `pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`.
  Commit boundary: the D4 evidence-only child-ledger acceptance change.
- **D7 published download-back journey:** owned by
  `apps/cert-prep-desktop/scripts/acceptance-real.mts`
  (`acceptancePassed`, `writeAcceptanceManifest`),
  `apps/cert-prep-desktop/scripts/acceptance-real-options.mts`
  (`loadRuntimeCandidate`, `strictRuntimeIdentity`),
  `apps/cert-prep-desktop/scripts/ocr-truth-contract.mts`
  (`parseOcrTruthManifest`, `evaluateOcrTruth`),
  `apps/cert-prep-desktop/scripts/ocr-page-record-evidence.mts`
  (`assertOcrPageRecordEvidenceIntegrity`),
  `apps/cert-prep-desktop/scripts/phase1-acceptance-evidence.mts`
  (`buildPhase1AcceptanceEvidence`),
  `apps/cert-prep-desktop/scripts/phase1-final-identity.mts`
  (`loadPhase1FinalEvidence`), plus `tools/capture-runtime-version-check.mts`
  (`assertCaptureRuntimeConsumerVersions`) and
  `apps/cert-prep-desktop/src-tauri/src/capture_manifest.rs`
  (`verify_capture_runtime`, `validate_capture_manifest_contract`) and
  `apps/cert-prep-desktop/src-tauri/src/manifests.rs` (`verify_artifact`).
  First red proof: local URL/path, mutable artifact,
  stale/mixed lock, or download-back byte mismatch must fail. Prerequisite:
  D5 published exact D3 bytes and D6 download-back record. Stop without a
  complete Cert D7 child ledger. Cert does not wait for LAW's ledger. Rollback
  follows the consumer transaction: before local active commit preserve the
  active identity; after commit keep the new active degraded with its exact
  producer session/proof token and retry/reconcile cleanup. Never mutate or
  roll back the producer stable pointer. Commit boundary: the D7 evidence and
  Cert child-ledger update followed by handoff to LAW. Green verification:
  `pnpm nx run cert-prep-desktop:release-tool-test --skip-nx-cache`;
  `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`; and
  `pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`.
- **D8 stable-pointer decision (producer-owned and out of scope):** Cert has
  no stable-pointer writer, aggregate-ledger owner, or D8 commit. The producer
  alone aggregates Capture Workbench, Cert Prep, and LAW child ledgers and moves
  its stable pointer. Cert must not wait for downstream LAW before completing
  or handing off its own D7 ledger. There is no Cert red/green/rollback step
  for D8.
- **Privacy and semantic evidence:** owned by
  `apps/cert-prep-desktop/scripts/ocr-truth-contract.mts`
  (`parseOcrTruthManifest`),
  `apps/cert-prep-desktop/scripts/ocr-page-record-evidence.mts`
  (`assertOcrPageRecordEvidenceIntegrity`),
  `apps/cert-prep-desktop/scripts/phase1-acceptance-evidence.mts`
  (`buildPhase1AcceptanceEvidence`), and
  `apps/cert-prep-desktop/scripts/phase1-final-identity.mts`
  (`loadPhase1FinalEvidence`). First red proof:
  raw OCR/truth text, bearer token, local path, host/user name, or environment
  dump must fail manifest validation. Prerequisite: the exact candidate or
  download-back bytes. Stop on CER > 1% for scanned PDF page 1, CER > 3% for
  real JPEG, or any missing critical anchor. Rollback retains failed evidence
  without publishing it. Green verification:
  `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`;
  `pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`; and
  `pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`.
  Commit boundary: the privacy-safe evidence schema.

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
      `windowsml_ocr`-provenanced; no embedded-text or host OCR route is used.
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
- [ ] Inspect the privacy-safe manifest. It may contain bounded identities,
      hashes, semantic counts/anchors, provenance, timing/memory numbers, and
      cleanup flags. Raw OCR text, truth text, tokens, local paths,
      host/user names, and environment dumps must not be present.

- [ ] Label the manifest `D4 CandidateAccepted` before publication. It must
      identify the immutable candidate and must not move the producer stable
      pointer; write only Cert's D4 candidate child ledger before handoff.
- [ ] After D5 publication and D6 download-back hash verification, rerun from
      downloaded bytes and label the result `D7 PublishedAccepted`. Write only
      Cert's D7 published child ledger, hand it to LAW, and do not wait for LAW
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
  selected when no dGPU/iGPU was usable. Post-selection DirectML failure is
  fail-closed and receives no host CPU retry. The delete-first inventory and
  tests are tracked in consumer TODO Slice 3.
- The accepted local-package result is `local-probe` evidence only: it
  completes Phase 1 but is not published/release evidence. A clean local
  install cannot become published evidence by changing the URL or claiming
  the current repository HEAD.
- Package QA, protocol fakes, snapshots, a supplied older executable, and a
  successful exit code are supporting checks, not real OCR acceptance.
- If any ordered run or cleanup proof fails, stop the Cert handoff, preserve
  the privacy-safe failure artifact, and do not start LAW. Apply the consumer
  transaction rule: before local active commit preserve the active
  root/pointer/session; after commit retain the new active degraded with its
  exact producer session/proof token and retry/reconcile cleanup. Never mutate
  or roll back the producer stable pointer.

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
