# Cert Prep real PDF and image acceptance

## Status checkpoint (2026-09-09)

Capture Workbench PR #39 at `c6d2140` is deterministic-green but unmerged.
There is no current-HEAD real OCR result, complete candidate, or published
0.4.2 artifact. Cert Prep PR #19 is open at HEAD
`d5af0f2a3939949bc10667a40252e96963ba64bb`, so production remains blocked on
the formal complete candidate. Older local OCR evidence is historical only and
does not close Phase 1.

This checklist is for Cert Prep's installed consumer journey. The producer
must first pass its ordered gate. Cert then owns durable source/review/export
state; `capture-runtime` owns the OCR projection. New imports accept only
`windowsml_ocr`; `embedded` and `mixed` are legacy read-only compatibility
rows and fail closed at the new import seam.

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
- [ ] Complete `afterCapture` cleanup for the JPEG before beginning the PDF
      run. Prove owned listeners, PIDs, run data, and staging are gone while
      durable runtime/model assets remain.
- [ ] Run the real private PDF's page 1 only. Assert the same
      `windowsml_ocr` projection and producer provenance. Full-document OCR is
      a separate gate reserved for a tested ordering, accumulation, memory,
      or accuracy risk.
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

## Failure and evidence rules

- A missing/malformed asset, identity mismatch, incompatible handshake,
  unavailable OCR requirement, malformed projection, cancellation, timeout,
  or runtime failure is terminal or unavailable. Cert does not create a local
  OCR fallback.
- The UI presents producer `OcrComputePreflight` and notice only. It does not
  rank adapters. Producer order is usable dGPU, usable iGPU, then noticed CPU;
  post-selection DirectML failure is fail-closed and receives no host CPU
  retry.
- A local candidate result is `local-probe` evidence only. A clean local
  install cannot become published evidence by changing the URL or claiming
  the current repository HEAD.
- Package QA, protocol fakes, snapshots, a supplied older executable, and a
  successful exit code are supporting checks, not real OCR acceptance.
- If any ordered run or cleanup proof fails, stop promotion, preserve the
  privacy-safe failure artifact, and do not start LAW. Restore the last
  reviewed 0.4.1 pins/assets/locks consistently if rollback is required.

## Design and verification gate

Any change to this image/PDF journey requires a written design and both
independent review axes before code. TDD starts with a red test at the public
consumer seam. Candidate staging must be deterministic and isolated. Future
implementation verification uses the narrowest package-manager-prefixed Nx
target with `--skip-nx-cache`, followed by this installed journey when its
source or producer identity changes. This documentation checkpoint performs
docs checks and `git diff --check` only.

## Supersession

The lazy-install and package-smoke specs/TODOs remain in the repository. Their
consumer-relevant content will eventually merge into the canonical consumer
spec/decision/TODO; this checkpoint does not delete them. This document
supersedes older acceptance wording that treated local OCR evidence as Phase 1
completion or allowed embedded/mixed output for new imports.
