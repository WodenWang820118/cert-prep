# Public Alpha Launch Readiness TODO

Target: public unsigned Windows 11 x64 Alpha `0.1.0-alpha.1`, canonical tag
`cert-prep-v0.1.0-alpha.1`.

This file tracks active release work only. Implemented contracts and local or
hosted evidence belong in `.agents/SPECS/domains/runtime-packaging.md` and
`.agents/SPECS/domains/parsing-reasoning.md`.

## Frozen Alpha Boundary

- The product is the Angular application inside the Tauri desktop shell, with a
  bundled Python backend runtime and a separately downloaded, version-pinned,
  SHA-256-verified WindowsML OCR runtime.
- WindowsML OCR prefers DirectML. If the DirectML provider or AMD adapter cannot
  be selected, it starts on CPU with a warning; if DML session construction or
  prediction fails, it retries once on CPU. Backend health must expose the CPU
  device and fallback reason, and Angular must display `使用 CPU 中`.
- Ollama is the only reasoning adapter. Alpha uses exactly `qwen3.5:4b` with the
  fixed 8K study profile. There is no alternate provider, model, or profile
  fallback. Missing runtime/model and generation failures remain visible
  unavailable/error states. Ollama execution may be `auto` or forced `cpu`; CPU
  execution is warned and is separate from provider/model fallback.
- `.github/workflows/release-alpha.yml` is the only public release orchestrator:

  ```text
  build-candidate
    -> clean-install
    -> publish-alpha

  failed owned prerelease before finalization
    -> cleanup-incomplete-prerelease
  ```

- The release workflow uses GitHub-hosted runners and publishes one unsigned
  NSIS installer. A self-hosted hardware runner, external hardware harness,
  fixed PDF suite, `ffprobe`, video evidence, MSI, CycloneDX, provenance, and
  attestation are not Alpha gates.
- Local candidates, local resilience runs, and older workflow runs are
  diagnostic evidence only. All release gates below must bind the same commit
  SHA, candidate ID, tag, artifact digests, and workflow run.

## Active Release Blockers

### 1. Freeze One Canonical Release Run

- [ ] Select the exact release commit already merged to `main`; confirm every
      workspace/package version resolves to `0.1.0-alpha.1`; confirm the
      repository is public and the protected `alpha-release` environment is
      ready; then start exactly one canonical `release-alpha.yml` run. Use either
      the manual-dispatch confirmations or the canonical tag path. Record the
      workflow URL, run attempt, commit SHA, tag, and generated candidate ID.

### 2. Pass Hosted Quality And Candidate Assembly

- [ ] Require `build-candidate` to pass on `windows-2025` for the selected
      commit. It must run the current Nx-owned lint/tests, desktop script and
      release contracts, Tauri host tests, one real-backend functional smoke,
      and package QA. Candidate assembly must freeze exactly one NSIS installer,
      the bundled backend ZIP, the remote WindowsML OCR ZIP/manifest, release
      metadata, approved dependency inventory and license texts, SPDX documents,
      `THIRD_PARTY_NOTICES.md`, and `SHA256SUMS`. Reject identity/digest drift,
      development paths, `file://` release URLs, unknown or unbacked licenses,
      links, forbidden binaries, and any extra installer format.

### 3. Pass OCR Bootstrap And One Fresh NSIS Install

- [ ] Require `clean-install` to consume the exact candidate without checkout or
      rebuild. It must reserve or reuse the owned prerelease without clobbering,
      publish the candidate-bound WindowsML OCR ZIP and manifest, anonymously
      download the ZIP from its embedded versioned HTTPS URL, verify its exact
      bytes/SHA-256, and then perform one fresh NSIS install. The installed app
      must match candidate identity, extract/start the bundled backend, reach
      pinned backend health, launch successfully, and uninstall cleanly. Passing
      uninstall evidence requires the uninstall registry entry, installed
      executable, and installation root all to disappear. Final anonymous
      verification of the manifest belongs to `publish-alpha` with the complete
      public asset inventory.

### 4. Finalize And Publish Without Bypass

- [ ] Require `publish-alpha` to consume the same candidate and clean-install
      receipt, finalize candidate-bound metadata and checksums, and publish the
      canonical tag as an unsigned public prerelease. The final asset tree must
      contain exactly one installer-like file—the declared NSIS setup—and must
      retain SPDX, license/notices, metadata, and checksum evidence. After upload,
      the verifier must use the anonymous public GitHub API, match the complete
      remote asset-name inventory exactly, download every asset, and verify its
      bytes and SHA-256. The release notes must retain the SmartScreen warning
      and must not claim production or GA readiness.

If an owned OCR prerelease exists and any pre-finalization gate fails, verify
that `cleanup-incomplete-prerelease` removes only that run's incomplete release.
It must never delete a finalized or foreign release, and evidence from the failed
run must not be reused.

## Final Closeout

- [ ] Verify the public tag, prerelease flag, anonymous asset inventory and
      downloads, NSIS checksum, OCR hashes, release metadata, SPDX documents,
      licenses, and notices against the recorded commit SHA and candidate ID.
      Merge the final workflow URL and exact clean-install/public verification
      evidence into the two owning domain specs, delete this TODO, and record the
      release state as exactly `Public Alpha ready with unsigned exception`.

## Explicitly Deferred Beyond Alpha

- Additional provider adapters, alternate models/profiles, and compatibility
  shims.
- macOS/Linux distribution and broader performance or hardware qualification.
- Authenticode signing. The unsigned exception applies only to this Alpha; GA
  remains blocked until the distributed application, runtime payloads, and NSIS
  installer are signed.
