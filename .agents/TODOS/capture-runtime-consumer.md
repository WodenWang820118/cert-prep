# Capture Runtime Release Consumer TODO

- [x] Record the completed Phase 1 local-probe checkpoint without upgrading it
      into a published-release claim. The accepted manifest SHA-256 is
      `1e001417498de86556de4f9984338cfe62079b84be96f434b5163d10c8925765`;
      it proves real installed JPEG and scanned-PDF page-one OCR, `gpu-dml`,
      durable `windowsml_ocr` records, and owned cleanup for the tested bytes.

- [x] Inventory the fixed-base range `ea720334...56c1cd3`. The 17 commits map to
      Phase 1 OCR-only integration/evidence, the local-probe identity policy,
      GPU preflight, or pnpm 12.0.0 governance. No agent-owned implementation
      was identified as safe to delete at this checkpoint. Preserve the
      content-identical tracked status entries and unknown untracked `name`.
      This inventory is not the pending independent two-axis review.

- [ ] At the exact post-design HEAD, run independent Standards and Spec reviews
      against fixed base `ea720334`, then have Root use `grill-me` one finding
      at a time. Any commit or rebase makes the approval stale. Do not begin a
      product implementation slice until this gate passes.

- [ ] With a fresh implementation worker, replace scattered backend/runtime
      process ownership with the deep `DesktopRuntimeSupervisor` interface and
      launcher-native `OwnedRuntimeSession`. Start with a red native test for a
      failed candidate retaining the active stack, then implement only that
      vertical slice and commit it.
      Verify: `pnpm nx run cert-prep-desktop:cargo-test --skip-nx-cache`

- [ ] Add vertical native slices for normal/window close, every readiness
      failure, runtime-root crash, host termination, an app-started model
      descendant, and a pre-existing baseline process. Prove owned roots and
      descendants terminate while the baseline survives; do not mock Windows
      process inheritance or use broad process-name kills.
      Verify: installed lifecycle evidence records terminate-and-prove results.

- [ ] Deepen transactional install/reconciliation into
      `RuntimeAssetInstaller`. Preserve durable runtime/model assets and caches;
      remove only validated app-owned PID/listener/run-scoped/staging/backup
      residue, including safe reconciliation after an unclean prior exit.
      Verify: native tests exercise real temporary directories and fail-closed
      recovery through the module interface.

- [ ] Consume the authenticated runtime compute decision without adding a host
      selector: usable dGPU, otherwise usable iGPU, otherwise explicit
      user-visible CPU fallback. Keep DirectML initialization/inference failure
      fail-closed. Real dGPU/iGPU claims require hardware evidence; deterministic
      projection tests alone do not prove the hardware lane.
      Verify: backend/UI contract tests plus the assigned real-hardware gate.

- [ ] Capture performance baselines before optimizing: model-ready latency,
      per-page latency, peak process memory, and GPU memory by adapter. Commit
      each measured vertical optimization separately and retain the sequential
      model lane.

- [x] Add the authenticated project-scoped privacy-safe OCR summary interface
      as three narrow commits: durable contract/task updates; primitive-`const`
      generated-client support with exhaustive provenance narrowing; then the
      pure summary mapper plus HTTP lifecycle/error matrix. Start every code
      slice with a focused red test. Prove the runtime adapter calls only
      `get_capture` and `get_ocr`, the project-scoped session is read before and
      after remote work, and structure/commit/provider/draft/DB writes remain
      zero. `projectionSchemaVersion: 3` is the OCR projection identity, not a
      `CaptureDocument` schema-version change.
      Verify: `pnpm nx run cert-prep-backend:test-unit --skip-nx-cache`,
      `pnpm nx run cert-prep-backend:test-integration --skip-nx-cache`,
      `pnpm nx run cert-prep-backend:lint --skip-nx-cache`, and
      `pnpm nx run cert-prep:build --skip-nx-cache`.
      Rollback: remove only the additive route, summary module/tests, generator
      const handling, and regenerated client symbols; no database or runtime
      artifact rollback is required.

- [ ] Refresh every consumer artifact to the producer-published `0.4.2` SDK,
      launcher, schema-3 page projection, manifest, and matching locks. Do not
      invent a local sibling fallback or update locks before publication.
      Verify: strict source/registry resolution and schema-byte checks agree on
      one producer release.

- [ ] Run real OCR-only PDF/image positive capture against the published
      engine-bearing `capture-runtime@0.4.2` release after explicit consent.
      Every page must persist `windowsml_ocr`; embedded/mixed outputs fail.
      Verify: installed-artifact smoke records page provenance, CER/anchor
      evidence, restart persistence, and cleanup.

- [ ] Re-run the independent freshly installed Cert Prep app after the native
      or performance slices affect its evidence. Use the private JPEG and only
      page one of the real 46-page scanned PDF for the routine parse gate;
      process a complete document only when an accuracy/lifecycle gate requires
      it. Run in the producer-assigned sequential model slot and release the
      slot only after all owned PID/listener/model evidence is zero.

- [ ] After all Phase 2 gates are green, commit the remaining necessary Cert
      changes, open this repository's PR, and monitor CI on the reviewed exact
      SHA. Do not push or open the PR from an intermediate design checkpoint.

The readiness/host-protocol consumer smoke, deterministic fixtures, and any
source-import or registry prototype are not substitutes for the engine-bearing
real OCR/Whisper smoke above.
