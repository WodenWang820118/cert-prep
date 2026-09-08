# Capture Runtime Staged OCR Adoption

Cert Prep follows the producer repository's canonical
`staged-ocr-delivery-workflow` for design-first work, TDD, evidence, review,
commits, and release promotion. This document records the responsibilities
that belong to this consumer; it does not redefine the capture-runtime OCR
policy.

## Phase 1: prove the consumer journey

Before implementation, write or update the local spec, decision, and task
breakdown. Review the design and its failure cases before writing feature code.
Split work into vertical slices with red tests, focused verification, and an
explicit rollback target. Close and commit each green slice with explicit paths;
do not accumulate unrelated changes in one worktree.

For the first real journey:

- Consume an immutable capture-runtime candidate and its generated contract,
  SDK, schema, and model identity. Frozen installs must reject sibling/local
  paths, direct URL metadata, and mixed runtime versions.
- Accept only the capture-runtime OCR projection for new imports. Persist the
  fixed OCR method (`windowsml_ocr`) and fail closed for new `embedded` or
  `mixed` extraction. Historical records may remain readable under their old
  method.
- Use the application journey and public capture contract, not a private OCR
  implementation or a test-only shortcut. Preserve page order, page status,
  text, confidence, boxes, failure evidence, and provenance.
- Run real PaddleOCR acceptance only after the Capture Workbench app has passed.
  The required order is **Capture Workbench → Cert Prep → GX Law Prep**. Run
  model-enabled apps sequentially; after Capture Workbench, prove its owned
  processes/listeners and run-scoped residue are gone and model memory is
  released before starting Cert Prep.
- Use scanned PDF/JPEG truth fixtures with no text layer. Local package QA,
  fake OCR, snapshots, or a successful process exit are not real OCR proof.

Phase 1 is complete for Cert Prep only when the freshly installed app produces
semantic OCR evidence from the real model and its candidate identity matches
the tested producer artifact. Do not claim Phase 2 hardening at this point.

## Phase 2: consumer hardening

After Phase 1, adopt the producer's deep modules rather than growing local
policy:

- Keep the canonical OCR pipeline behind its small interface. Cert Prep owns
  durable source/domain persistence and presentation; it does not own Paddle
  initialization, preprocessing, inference, OCR arbitration, or confidence
  semantics.
- Use the native `OwnedRuntimeSession` seam for each active/candidate launch.
  A failed candidate cleanup must not destroy the active backend. Stop only
  app-owned runtime/model descendants; a baseline process that existed before
  launch must survive. Reconcile stale PID/listener/staging state safely at
  startup without broad process-name kills.
- Measure real model memory and latency before optimizing. Keep the ordered,
  sequential acceptance lane because the available memory is constrained.
- Keep evidence privacy-safe: manifests contain hashes, CER/anchor counts,
  provenance, and cleanup flags, never raw OCR/truth text, tokens, or machine
  paths. Screenshots mask the complete privacy-sensitive card before capture.

## Local reviews, evidence, and promotion

Every slice receives two independent reviews: a standards review for repository
conventions, security, tests, generated files, and CI; and a specification
review for contract compatibility, failure behavior, lifecycle ownership, and
the stated phase gate. Use `grill-me` one finding at a time. Approval is bound
to the exact HEAD and must be repeated after any commit or rebase.

Label evidence as fast/local, local-real, or published. A Cert Prep PR must
name the exact candidate or published artifact hashes, the tested producer
HEAD, evidence tier, deferred gates, and the 0.4.1 rollback pins. Published
0.4.2 bytes are immutable; the stable pointer moves only after all three apps'
ordered published-artifact acceptance is green.

## Identity policy by evidence tier

Phase 1 local-package E2E evidence is labeled `local-probe` and hard-gates API
`2.0`, schema `3`, the exact contract hash, the packaged archive boundary (no
sibling junction or source-tree import), and loaded runtime-executable plus
OCR-worker SHAs matching the local probe. It records, but does not hard-fail
solely on, package semver, the full all-asset byte/size inventory, an app/desktop
hash after a legitimate rebuild, local `direct_url`, and registry/frozen-lock
purity. A source change invalidates the affected component's evidence, not
automatically unrelated component evidence. SHA equality is sufficient identity
proof for the same bytes; do not add a redundant local byte-by-byte comparison.
Fake OCR, snapshots, successful exits, source-tree imports, and archive-boundary
substitution remain fake-green and cannot prove the journey.

Release/published acceptance restores exact version, all artifact hashes and
manifest entries, frozen locks, and download-back byte identity, and rejects
local paths and `direct_url`. The full inventory, legitimate app/desktop hashes,
and registry purity are release gates. Keep the evidence label and tier explicit
when reporting a local-probe result.

This repository has its own focused commits, PR, and CI. Root coordinates and
reviews; the Luna worker implements, verifies, and commits the owned slice. A
failure stops the ordered promotion and is repaired by the owning slice; it is
never hidden by mixing runtime versions or restoring removed private OCR.

## Sol xhigh escalation

For one named blocking condition, count only consecutive Luna implementation
failures. After more than three failures, Luna reports each attempt and its
evidence to Root. Root may activate a standby Sol xhigh worker for read-only
diagnosis, options, and proposed tests. Sol xhigh never edits, commits, pushes,
publishes, or takes ownership; the original Luna implements the accepted fix.
Different findings keep separate counters and do not combine to trigger
escalation.
