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

Phase 2 now owns hardening, the Nx 23.1.2 upgrade, lifecycle and performance
work, version inventory, deterministic candidate staging, and then sequential
formal/published-package regression across the consumers.

These decisions describe the consumer delta. The producer's canonical Phase 2
specification remains the authority for OCR internals, compute truth, and
native ownership details.

## Chosen decisions

1. **Cert owns durable product state.** Cert Prep owns durable sources, domain
   records, review overrides, export, and persistence. Capture Runtime owns
   the ephemeral job and is the sole OCR projection owner. Cert maps and
   persists the typed projection; it does not create a second OCR policy.
2. **The new source contract is OCR-only.** New PDF and image imports write
   only `windowsml_ocr` capture projections. `embedded` and `mixed` are
   fail-closed at the new import seam. Existing rows with those values remain
   read-only compatibility data and are never a route or a new write target.
3. **Desktop adapters stay thin at the producer seam.**
   `DesktopRuntimeSupervisor` and `RuntimeAssetInstaller` adapt Cert Prep to
   the producer contract. They do not own a model, preprocessing, device
   ranking, inference, or process policy. Native handles and bearer tokens
   remain below the desktop/backend seam.
4. **Candidate and active sessions are isolated.** Every active and candidate
   launch has its own `OwnedRuntimeSession`. A failed candidate is terminated
   and proved independently; it never tears down the active session. A
   successful swap closes the retired active session before reporting the new
   one active.
5. **Close and recovery preserve durable assets.** App close clears owned
   listeners, PIDs, run data, and staging while leaving durable runtime/model
   assets and caches. A pre-existing external Ollama process is a baseline and
   survives. Next-start reconciliation may remove only stale state whose
   app-owned identity is proven; ambiguous state fails closed.
6. **The UI presents producer truth.** Cert displays the authenticated
   `OcrComputePreflight` and notice. The canonical policy is usable dGPU,
   then usable iGPU, then noticed CPU; the exact truth is referenced from
   Capture Workbench's Phase 2 spec, not restated here. Cert never ranks
   adapters or derives an ordinal. Post-selection DirectML failure is
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
   private JPEG and PDF page 1, then proves Cert cleanup before the model slot
   is handed to GX Law Prep. Restart persistence, review/export, cleanup, and
   baseline survival are required. Raw OCR/truth text, tokens, paths, and
   host-specific diagnostics never enter a manifest.
10. **Design gates precede image-flow code.** The image/PDF design receives
    both an independent Standards review and an independent Specification
    review before code. Implementation uses TDD red tests at the public seam,
    deterministic staging, small vertical slices, and exact-HEAD approvals.

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

## Rejected alternatives

- **Host OCR or embedded-text fallback:** rejected because it creates a second
  projection owner and makes PDF/image behavior differ from the producer.
- **Host GPU ranking or CPU retry:** rejected because readiness could disagree
  with the executing plan and hide a DirectML defect.
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
- **Deleting the lazy-install/package-smoke specs now:** rejected because
  their consumer-relevant content must be merged deliberately; they remain
  historical/auxiliary source documents until then.

## Supersession, review, and rollback

This record supersedes older Cert statements that denied the completed Phase 1
local-probe gate, treated local-probe evidence as published/release acceptance,
or allowed embedded/mixed output for a new import. It does not delete the
existing lazy-install or package-smoke docs; their relevant content will
eventually be merged into this consumer record.

The review unit is the exact documentation commit. Any subsequent commit,
generated artifact, or rebase invalidates both review axes. The rollback is an
additive revert of the documentation commit only; runtime assets, database
records, lockfiles, and published artifacts are untouched.
