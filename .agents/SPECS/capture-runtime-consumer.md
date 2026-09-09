# Capture Runtime 0.4.2 Cert Prep consumer delta

This document is the Cert Prep consumer specification for the OCR-only
0.4.2 cutover and its Phase 2 hardening follow-up. It defines what this
repository must consume and prove. Producer implementation policy remains in
Capture Workbench's canonical Phase 2 documents; this document does not copy
that policy.

## Current checkpoint (2026-09-09)

- Capture Workbench PR #39 at `c6d2140` is deterministic-green but has not
  merged.
- There is no current-HEAD real OCR result, candidate artifact, or published
  `capture-runtime` 0.4.2 artifact that Cert Prep can claim.
- Cert Prep PR #19 is open at HEAD `d5af0f2a3939949bc10667a40252e96963ba64bb`.
  Production remains blocked on a formal, complete 0.4.2 candidate and its
  consumer evidence.
- Older local OCR evidence is historical. It cannot be described as a
  completed Phase 1 gate for this checkpoint or for a later Cert Prep HEAD.

This is a coordination checkpoint, not installed-artifact acceptance. The
ordered producer gate must be current before a Cert Prep model-enabled run;
Cert Prep then runs before GX Law Prep, with cleanup proven between consumers.

## Purpose and non-goals

Cert Prep owns the durable product experience around a capture. It consumes
the runtime's typed OCR projection through its public/generated seam and keeps
the domain state useful after the ephemeral runtime job ends.

This specification does not authorize:

- a Cert Prep PaddleOCR, PDF rasterization, embedded-text, mixed-arbitration,
  OCR-provider, or host CPU-retry implementation;
- host-side GPU enumeration, ranking, device-ID persistence, model creation,
  preprocessing, inference, or process-name cleanup;
- treating a local candidate, package smoke, snapshot, or successful command as
  published-release or real-OCR proof; or
- deleting the existing lazy-install/package-smoke specifications before
  their relevant consumer content is merged here.

## Responsibility and seam

| Concern | Owner | Cert Prep consumer rule |
| --- | --- | --- |
| Durable sources and domain records | Cert Prep | Persist source identity and domain data; runtime jobs are ephemeral. |
| Review override and export | Cert Prep | Apply the local review overlay, retain user overrides, and export the domain result. |
| Persistence and restart recovery | Cert Prep | Reconcile durable source/review state across app restarts; do not persist a runtime process as domain state. |
| OCR projection | `capture-runtime` | The runtime is the sole OCR projection owner. Cert maps the typed projection and does not recreate it. |
| Runtime/model installation | Producer contract via `RuntimeAssetInstaller` adapter | Verify and stage producer assets; do not choose models or invent a second install policy. |
| Runtime process lifecycle | Producer contract via `DesktopRuntimeSupervisor` adapter | Present product status and invoke the owned-session seam; do not own native process policy. |

`DesktopRuntimeSupervisor` and `RuntimeAssetInstaller` are Cert Prep adapters
to the producer-owned seams. They do not own a model, preprocessing, device
ranking, inference, Windows process policy, or broad cleanup rule. A raw Job
handle, process handle, sidecar bearer token, or runtime URL never crosses the
Angular/WebView seam.

## Consumer contract

The target producer contract is API `2.0` with the schema-3 typed,
page/segment-bound OCR projection. Cert Prep must regenerate or consume the
producer-published contract artifacts only after the complete 0.4.2 candidate
exists; no digest is invented in advance.

### OCR-only source admission

- Every new PDF page and image import enters the `windowsml_ocr` capture
  projection. Rasterization and OCR happen in `capture-runtime`.
- `embedded` and `mixed` are fail-closed at the new import seam. Cert Prep
  must not inspect an embedded text layer, arbitrate a mixed result, or call a
  second OCR provider.
- Existing persisted `embedded` and `mixed` rows are legacy read-only
  compatibility data. They are never written as the result of a new import,
  never used to select an OCR route, and never silently rewritten as current
  OCR evidence.
- Runtime capture state and OCR projection are transient execution data. Cert
  owns the durable source, review, export, and domain records that consume the
  projection.

The public capture seam remains authenticated and fail-closed. An invalid
contract, unsupported source, unavailable OCR requirement, malformed
projection, cancellation, timeout, or runtime failure is a typed unavailable
or terminal result; it is not an invitation to fall back locally.

### User-facing compute projection

The UI presents only the producer's authenticated `OcrComputePreflight` and
its user notice. It may display the producer-reported compute mode/class and
the explicit CPU notice, but it does not rank adapters, interpret adapter
names or ordinals, or calculate a device ID. The canonical producer policy is
usable dGPU, then usable iGPU, then noticed CPU; see
`C:\software-dev\capture-workbench\.agents\SPECS\capture-runtime-042-p2-hardening.md`.

DirectML construction or inference failure after a GPU plan is selected is a
failed capture. The Cert host never retries that operation on CPU or chooses a
different GPU. An indeterminate producer preflight remains unavailable and
does not become a CPU notice.

## Owned runtime sessions and cleanup

Each active launch and each candidate launch has a distinct producer-owned
`OwnedRuntimeSession`.

- A candidate is readiness-checked before an active-session swap. Candidate
  failure terminates and proves only that candidate; the existing active
  session remains untouched.
- After a successful swap, the retired active session is closed and proved
  empty before the replacement is reported active.
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
  recovery.

The adapter may report lifecycle state, but it must not expose raw OS handles
or ask the Angular host to terminate a process tree.

## Candidate identity and installation tiers

Local candidate acceptance is intentionally tiered:

- A local transport URL or port identifies transport only. It does not bind a
  candidate to repository HEAD, and it is not sufficient identity.
- The hard gate binds the API/schema and contract identity, the packaged
  archive boundary, package/provenance metadata, and the loaded runtime and
  OCR worker executable identities. The loaded runtime-worker identity must
  agree with the candidate record before capture.
- A clean-install check rejects a sibling junction, source-tree import,
  local-path substitution, `direct_url`/path provenance, and mixed 0.4.1/
  0.4.2 versions wherever those checks apply. A local candidate may retain
  diagnostic local metadata, but that metadata never satisfies a published
  claim.

Published-consumer acceptance restores strict locks: exact 0.4.2 semver,
frozen registry resolution, every declared artifact/checksum/manifest entry,
download-back byte identity, and no local path or `direct_url`. Until those
immutable producer bytes exist, the current 0.4.1 pin remains a compatibility
baseline rather than evidence for the 0.4.2 cutover.

## Tooling baseline

The current workspace package manager is `pnpm@12.0.0`. Nx packages and the
workspace CLI are currently `23.1.0`; upgrading to `23.1.2` is a tracked
backlog item, not part of this consumer documentation commit. Verification
uses package-manager-prefixed Nx commands and `--skip-nx-cache` for final
confidence.

## Acceptance checklist

The real consumer gate is an installed Cert Prep app using private fixtures
and an exact producer candidate. Package QA and protocol fakes are supporting
checks only.

- [ ] Run a real private JPEG through the installed app and persist a semantic
      `windowsml_ocr` projection with producer provenance.
- [ ] Run the real private PDF's page 1 through the same installed app after
      the JPEG run, sequentially in the assigned model slot. The routine gate
      is page 1; full-document OCR is reserved for an explicitly tested
      accumulation, ordering, or accuracy risk.
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
- [ ] Record candidate/archive/runtime-worker/contract identities and cleanup
      flags in a privacy-safe manifest. Raw OCR text, truth text, bearer
      tokens, local paths, host/user names, and environment dumps never enter
      the manifest.

## Design and verification workflow

Any image/PDF-flow implementation starts with the design and a serious review
before code. The red test crosses the public consumer seam, then TDD proceeds
as one observable vertical slice. Standards review and Specification review
are independent axes and are bound to the exact commit; a later commit makes
both approvals stale. Candidate staging is deterministic and isolated before
an installed journey is trusted.

The planned verification floor for implementation slices is the narrowest
relevant `pnpm nx` target with `--skip-nx-cache`, followed by the installed
real journey for changes that affect it. This documentation checkpoint runs
docs checks and `git diff --check` only.

## Supersession and rollback

The existing lazy-install and package-smoke specs/TODOs remain in the tree.
Their consumer-relevant content will eventually be merged into this consumer
specification, decision record, and TODO; they are not deleted now. This
specification supersedes stale statements that call historical local OCR
evidence a completed Phase 1 gate.

Rollback for this documentation-only change is an additive revert of the
focused documentation commit. It does not alter runtime assets, database
records, package locks, or published artifacts.
