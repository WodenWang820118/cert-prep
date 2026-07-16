# Public Alpha Launch Readiness TODO

Target: public unsigned Windows 11 x64 alpha `0.1.0-alpha.1`, canonical tag
`cert-prep-v0.1.0-alpha.1`.

This file tracks active release blockers only. Completed implementation and
local/hosted evidence belongs in
`.agents/SPECS/domains/runtime-packaging.md` and
`.agents/SPECS/domains/parsing-reasoning.md`.

## Current Architecture Boundary

- The Windows product is the Angular application inside the Tauri desktop
  shell, with a bundled Python backend runtime.
- WindowsML OCR is a separately downloaded, digest-pinned GitHub Release
  runtime backed by `DmlExecutionProvider + CPUExecutionProvider`; its protected
  hardware gate requires observed use of a supported AMD iGPU. Ollama is the
  only Alpha reasoning adapter and remains an explicit external runtime/model
  dependency. Reasoning acceleration is not tied to an RTX model or a protected
  NVIDIA lane: when supported acceleration cannot be confirmed, the backend
  must warn, force Ollama CPU execution, and expose that state to the UI.
- Provider-neutral ports, lazy construction, selection, health, and
  configured/effective attribution remain extension points. Adding another
  provider is not an Alpha task.
- `.github/workflows/release-alpha.yml` is the canonical release orchestrator.
  Its job dependency chain is:

  ```text
  metadata
    -> windows-quality
    -> build-candidate
    -> publish-ocr-prerelease
    -> clean-install
    -> hardware-acceptance
    -> finalize-release
    -> attest-release
    -> publish-alpha
  ```

- A local nonpublishable candidate, an older hosted run, or schema-only tests
  cannot close a public candidate gate. All candidate-bound checks below must
  refer to one commit SHA, candidate ID, declared artifact digests, and
  workflow run.

## Active Release Blockers

### 1. Provision The Protected Hardware Lane

- [ ] Bring an online clean-snapshot Windows x64 runner into the
      `alpha-hardware` environment with labels `self-hosted`, `Windows`, `X64`,
      and `cert-prep-alpha-hardware`. The machine must expose a supported AMD
      iGPU used by the WindowsML OCR runtime, and it must return to a known clean
      snapshot with no Cert Prep-owned process, install, app-data, or port
      residue before each acceptance run. No RTX/NVIDIA GPU model is a runner
      requirement.

- [ ] Provision Ollama and `qwen3.5:4b`, the external hardware harness, and
      exactly one `ffprobe` application on that runner's `PATH`. Provision the
      approved four-PDF manifest from commit `58a156c` beside its exact four
      PDFs in one absolute non-reparse directory. Independently verify the
      harness path and SHA-256, then configure only
      `ALPHA_HARDWARE_HARNESS`, `ALPHA_HARDWARE_HARNESS_SHA256`, and
      `ALPHA_ACCEPTANCE_PDF_DIR`, plus the independently reviewed
      `ALPHA_FFPROBE_SHA256`, in `alpha-hardware`. The workflow rejects harness
      reparse/digest drift immediately before execution, derives and
      candidate-checks the manifest, resolves `ffprobe` from `PATH`, and rejects
      any executable whose digest differs from the approved value. Set repository
      variable `ALPHA_HARDWARE_RUNNER_READY=true` only after the revised
      AMD-iGPU/CPU-capable acceptance contract and these inputs pass preflight.

### 2. Freeze One Canonical Release Run

- [ ] Select the exact release commit already merged to `main`, confirm that
      all workspace/package versions still resolve to `0.1.0-alpha.1`, and
      start one canonical `release-alpha.yml` run for that commit. Use the
      manual-dispatch confirmations or the canonical tag path, but do not run
      two independent candidates for the same version. Record the workflow run
      URL, commit SHA, tag, and generated candidate ID.

### 3. Pass Exact-Commit Quality And Candidate Assembly

- [ ] Require `metadata`, `windows-quality`, and `build-candidate` to pass for
      the selected commit. The Windows job must execute the current Nx-owned
      contracts, backend, WindowsML, Ollama, Angular, desktop, mocked browser,
      and `e2e-real-backend` gates. Candidate assembly must freeze one MSI, one
      NSIS installer, bundled backend ZIP, remote WindowsML OCR ZIP/manifest,
      release metadata, approved license inventory/texts, SPDX and CycloneDX
      SBOMs, `SHA256SUMS`, QA reports, and candidate-bound harness files. Reject
      any identity/digest drift, development path, `file://` URL, unknown
      license, missing license text, symbolic link, or forbidden binary.

### 4. Publish Candidate-Bound OCR Bootstrap Assets

- [ ] Require `publish-ocr-prerelease` to reserve the candidate-bound
      prerelease and upload or byte-for-byte reuse the exact WindowsML OCR ZIP
      and manifest without clobbering assets. Both assets must be anonymously
      downloadable from the canonical versioned HTTPS URL embedded by
      `build-candidate`. Do not rebuild a second candidate after this upload;
      all downstream jobs must consume the original candidate ID.

### 5. Pass Both Checkout-Free Clean Installs

- [ ] Require both `clean-install` matrix jobs (`msi` and `nsis`) to pass with
      the same candidate ID; each installer must match its candidate-declared
      SHA. From fresh app-data and without a repository checkout, each lane
      must prove installer identity, bundled backend extraction/startup and
      pinned Python/backend health, installed runtime-manifest integrity, one
      anonymous OCR download with exact byte/hash verification, and successful
      application launch. The job must stop its owned processes, remove its
      temporary app-data, and execute the existing best-effort uninstall path.
      HTTP Range resume remains a separately tested downloader contract; this
      fresh install lane must not claim to exercise an interrupted download.

### 6. Pass Protected Hardware Acceptance

- [ ] Require `hardware-acceptance` to run the pinned harness against the same
      candidate and prove all of the following without weakening the
      Ollama-only contract:
  - the exact four reviewed manifest-declared acceptance PDFs complete through
    WindowsML OCR on the AMD iGPU lane;
  - configured/effective provider and model are exactly
    `ollama`/`qwen3.5:4b`, with no provider or model fallback;
  - every PDF produces usable questions and a non-zero Full Exam count;
  - Ollama reaches generation readiness and reports execution mode separately
    from provider/model fallback. `auto` and forced `cpu` are both accepted;
    `cpu` must carry the backend warning surfaced by the frontend as
    `使用 CPU 中`. No RTX/NVIDIA routing or `nvidia-smi` evidence is required;
  - the reasoning model is released after the job;
  - session restart succeeds, and the nine candidate-bound checks for upload,
    OCR, draft, runtime, model, cancel-versus-complete race, crash recovery,
    partial-data removal, and owned-process release each have their own JSON
    evidence and digest;
  - no Cert Prep-owned process or port residue remains; and
  - the run-bound Playwright WebM passes checks from the preflight-resolved
    protected-runner `ffprobe`, whose digest must match the reviewed SHA-256 and
    is rehashed by the verifier, for container/codec, positive dimensions and
    duration, and decoded frames.

### 7. Finalize, Attest, And Publish Without Bypass

- [ ] Require `finalize-release`, `attest-release`, and `publish-alpha` to pass
      in order. Finalization must revalidate both clean-install reports,
      protected hardware evidence, license/SBOM inputs, checksums, candidate
      identity, and declared artifacts before GitHub provenance is generated.
      Publish the release as a prerelease with
      `channel=unsigned_public_alpha`, the expected SmartScreen warning, and
      SHA-256 verification instructions; never claim production or GA
      readiness.

If any post-bootstrap gate fails, treat that workflow run as failed and verify
that `cleanup-incomplete-prerelease` removes only the OCR bootstrap owned by that
run without deleting a finalized or foreign release before retrying. Do not
carry evidence from the failed run into final closeout; this is a conditional
recovery rule, not an independent launch checkbox.

## Final Closeout

- [ ] Verify the public tag, prerelease status, anonymous OCR assets, MSI/NSIS
      assets, checksums, release metadata, SBOMs, licenses, and GitHub
      provenance against the recorded commit SHA and candidate ID. Merge the
      final workflow URL and exact public/clean-install/hardware evidence into
      the two owning domain specs, delete this TODO, and set the release state
      to exactly `Public Alpha ready with unsigned exception`.

## Explicitly Deferred Beyond Alpha

- Additional provider adapters, provider-specific onboarding, and compatibility
  shims.
- macOS/Linux distribution and larger-model default changes.
- Authenticode signing. The unsigned exception applies only to this Alpha; GA
  remains blocked until the main executable, backend/OCR runtime executables,
  MSI, and NSIS are signed.
