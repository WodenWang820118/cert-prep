# Capture Runtime 0.4.2 Cert Prep consumer TODO

## Current checkpoint (2026-09-09)

Capture Workbench PR #39 at `c6d2140` is deterministic-green but unmerged.
There is no current-HEAD real OCR result, candidate, or published 0.4.2.
Cert Prep PR #19 is open at HEAD
`d5af0f2a3939949bc10667a40252e96963ba64bb`; production remains blocked on a
formal, complete 0.4.2 candidate. Older local OCR evidence is historical and
must not be called a completed Phase 1 gate.

This TODO is the consumer delta only. Capture Runtime remains the sole OCR
projection owner. Cert Prep owns durable sources, review overrides, export,
and persistence. `DesktopRuntimeSupervisor` and `RuntimeAssetInstaller` are
adapters and do not own models, preprocessing, device ranking, or process
policy.

Every item below is a small, independently reviewable slice. The red proof is
written before implementation; the listed `--skip-nx-cache` command is the
verification floor for that future slice. A green slice gets its own focused
commit checkpoint before the next slice starts.

## Slices

- [x] **Consumer docs cleanup and status freeze.** Replace stale claims with
      the 2026-09-09 checkpoint; state OCR-only admission, producer ownership,
      tiered identity, lifecycle invariants, private acceptance, supersession,
      design-before-code, TDD, two review axes, and deterministic staging.
  Red proof: the pre-change docs could call historical local OCR “Phase 1
  complete” or omit the unmerged producer/candidate blocker; required current
  checkpoint and fail-closed phrases must be present after the edit.
  Owner: Cert Prep consumer documentation owner; Root performs exact-HEAD
  review.
  Verify: `git diff --check -- .agents/SPECS/capture-runtime-consumer.md .agents/DECISIONS/capture-runtime-consumer.md .agents/TODOS/capture-runtime-consumer.md .agents/TODOS/cert-prep-pdf-image-acceptance.md`; future affected-code gate `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`.
  Rollback: additive revert of the documentation commit only.
  Commit checkpoint: `docs(phase2): define cert runtime consumer hardening`;
  record the resulting SHA.

- [ ] **Canonical version inventory and package expectation.** Inventory the
      runtime, API/schema, Python/npm/Cargo clients, desktop metadata,
      catalogs, manifests, and Cert expectations from one source. Generate a
      next-version check that rejects stale literals and mixed 0.4.1/0.4.2
      locks. Keep current `pnpm@12.0.0`; track Nx `23.1.0` to `23.1.2` as a
      separate backlog upgrade.
  Red proof: a deliberately stale version or mixed lock passes the old checks;
  the new inventory/check must fail it before any artifact is installed.
  Owner: Capture release inventory owner with Cert package consumer owner.
  Verify: `pnpm nx run cert-prep-desktop:release-tool-test --skip-nx-cache`; `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`.
  Rollback: additive revert of the inventory/check and generated changes;
  restore the last reviewed 0.4.1 expectation without mixing versions.
  Commit checkpoint: `chore(phase2): add canonical runtime version inventory`;
  record the exact SHA and generated inventory.

- [ ] **Deterministic candidate staging and clean install.** Stage one local
      candidate with an isolated archive boundary and shared-resource scope.
      Require contract/schema, archive/provenance, and loaded runtime-worker
      identity; reject sibling junctions, source-tree/local paths,
      `direct_url`, and mixed versions where applicable. Treat URL/port as
      transport only, never as a HEAD binding.
  Red proof: a clean-install test using a sibling junction, local path,
  `direct_url`, or mixed 0.4.1/0.4.2 lock must be rejected; a URL-only match
  must not satisfy identity.
  Owner: Cert desktop packaging owner with producer candidate owner.
  Verify: `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`; `pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`.
  Rollback: additive revert of staging/identity checks; retain durable assets
  and remove only the isolated run staging created by the slice.
  Commit checkpoint: `test(phase2): harden cert candidate staging identity`;
  record candidate/archive/runtime-worker identities.

- [ ] **Candidate/active supervision adapter.** Wire Cert's
      `DesktopRuntimeSupervisor` adapter to one producer-owned
      `OwnedRuntimeSession` per active or candidate launch. A failed candidate
      must terminate-and-prove only itself and leave active service usable;
      swap only after candidate readiness is proven.
  Red proof: a candidate failure in the old path tears down or corrupts the
  active session; the new public seam must keep active state and report a
  failed candidate.
  Owner: Cert desktop/native adapter owner; producer owns native session
  semantics.
  Verify: `pnpm nx run cert-prep-desktop:cargo-test --skip-nx-cache`; `pnpm nx run cert-prep-desktop:typecheck-scripts --skip-nx-cache`.
  Rollback: additive revert of adapter wiring and focused tests; do not alter
  producer runtime assets or expose native handles.
  Commit checkpoint: `feat(phase2): isolate cert runtime candidate sessions`;
  record the terminate-and-prove evidence SHA.

- [ ] **Close and lifecycle handoff.** Cover app/window close, readiness
      failure, runtime-root crash, and host termination through the same
      producer terminal proof. Clear owned listeners/PIDs/run data/staging,
      leave durable assets, and preserve the baseline external Ollama process.
      Run Cert only after the producer's ordered JPEG then PDF page-1 gate;
      hand off to LAW only after Cert cleanup is zero.
  Red proof: the old close path leaks an owned listener/PID/run directory,
  kills a pre-existing Ollama, or allows Cert and LAW model runs to overlap;
  each case must fail before the fix.
  Owner: Cert desktop lifecycle owner with acceptance owner.
  Verify: `pnpm nx run cert-prep-desktop:cargo-test --skip-nx-cache`; `pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`.
  Rollback: additive revert of the lifecycle adapter/acceptance slice; leave
  unrelated external processes and durable model/runtime assets untouched.
  Commit checkpoint: `feat(phase2): prove cert runtime close handoff`;
  record cleanup and handoff evidence.

- [ ] **Next-start identity reconciliation.** Reconcile stale app-owned PIDs,
      listeners, run data, staging, and backups after an unclean exit only
      when ownership identity is proven. Unknown, ambiguous, or mismatched
      state must remain untouched and visible for recovery.
  Red proof: inject a wrong-owner PID/path and an identity-matching stale
  record; the former must survive and the latter must be removed. No broad
  process-name kill is permitted.
  Owner: Cert installer adapter owner with producer lifecycle owner.
  Verify: `pnpm nx run cert-prep-desktop:cargo-test --skip-nx-cache`; `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`.
  Rollback: additive revert of reconciliation logic; preserve durable assets
  and retain unproven residue for manual recovery.
  Commit checkpoint: `fix(phase2): reconcile cert runtime state by identity`;
  record proof of preserved unknown state and removed owned state.

- [ ] **Performance measurement before optimization.** Add privacy-safe
      internal measurements for model-ready time, per-page latency, first-page
      and total elapsed time, process/Job memory, and GPU memory by producer
      adapter. Use the private JPEG and PDF page 1 first; do not change
      production behavior or record raw text, truth text, paths, or tokens.
  Red proof: the measurement path either has no reproducible baseline or leaks
  private OCR/truth content into evidence; the new test must fail those cases.
  Owner: Cert acceptance/performance owner with producer measurement owner.
  Verify: `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`; `pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`.
  Rollback: additive revert of measurement-only code and evidence schema;
  production capture behavior and durable records remain unchanged.
  Commit checkpoint: `test(phase2): record cert OCR performance baseline`;
  record the privacy-safe baseline identity and metric set.

- [ ] **Published 0.4.2 cutover and real consumer acceptance.** Wait for the
      formal complete candidate and producer publication. Refresh strict
      registry locks and exact artifact hashes; reject local path/
      `direct_url`, sibling, and mixed-version provenance. Then run the
      installed Cert journey with a real private JPEG and PDF page 1, prove
      `windowsml_ocr`, restart persistence, review/export, cleanup, and
      baseline Ollama survival. Raw OCR text never enters the manifest.
  Red proof: a local candidate, URL-only transport, supplied old executable,
  package smoke, or fake OCR can pass the old gate; the published gate must
  reject each substitute and bind the downloaded-back bytes.
  Owner: Cert release/acceptance owner after producer release owner publishes
  the exact candidate.
  Verify: `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`; `pnpm nx run cert-prep-desktop:acceptance-real --skip-nx-cache`; `pnpm nx run cert-prep-desktop:release-tool-test --skip-nx-cache`.
  Rollback: restore the last reviewed 0.4.1 pins/assets/locks consistently;
  stop ordered promotion and preserve failure evidence. Do not publish a
  failed candidate or start LAW.
  Commit checkpoint: `release(phase2): cut cert consumer to capture-runtime-0.4.2`;
  record exact published bytes, lockfile, manifest, and acceptance SHA.

## Cross-slice rules

- New imports are OCR-only: `windowsml_ocr` is the only current projection;
  `embedded` and `mixed` remain legacy read-only compatibility values.
- The UI presents producer `OcrComputePreflight` and notice only. It never
  ranks adapters. The canonical order is dGPU, iGPU, then noticed CPU; a
  DirectML failure never receives a host CPU retry.
- Real model runs are sequential: Capture Workbench's JPEG then PDF page 1,
  Cert Prep, then GX Law Prep. Each owner proves cleanup before handoff.
- The current local candidate tier is not published evidence. Published
  acceptance requires strict locks, immutable bytes, and download-back
  identity.
- Image-flow changes require design and both review axes before code; TDD red
  tests cross the public seam; staging is isolated before installed evidence.
- The existing lazy-install and package-smoke specs/TODOs remain in place.
  Their relevant content will eventually merge into these consumer docs; do
  not delete them in this backlog.
