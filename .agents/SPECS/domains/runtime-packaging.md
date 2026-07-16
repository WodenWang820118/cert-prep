# Runtime And Packaging Domain

## Purpose

This domain owns the Windows desktop distribution contract: the Tauri shell,
the packaged backend and remotely acquired OCR runtime, runtime health and
fallback UX, release artifact/legal evidence, clean-install acceptance, and
owned-process cleanup.

The contract below reflects the simplified Alpha implementation at
`b5f63f5`. Historical hardware-certification requirements are not active
release requirements.

## Effective Alpha Decisions

### Supported channel and platform

- The first distributable channel is a public, unsigned Windows 11 x64 Alpha.
  It is not a GA or production-readiness claim.
- Release metadata and notes must identify the build as an unsigned public
  Alpha, explain the expected Windows SmartScreen warning, and point users to
  `SHA256SUMS`.
- Code signing remains a GA blocker. Alpha must not configure a fake,
  self-signed, or placeholder signing command.
- Source, Cargo, Tauri, Python package, runtime manifest, tag, and public asset
  versions must describe the same release. Python distribution metadata may use
  the normal PEP 440 representation of the SemVer prerelease.
- Packaged backend creation and clean-install health validation use the pinned
  Python 3.12 line.

### Runtime ownership and acquisition

- The backend runtime ZIP and manifest are Tauri resources. The backend
  artifact URL is `null`; missing packaged backend bytes are package
  corruption, not a download state.
- Backend installation verifies byte count and SHA-256, rejects archive
  traversal and symlinks, extracts through a temporary location, and replaces
  the installed runtime atomically.
- The WindowsML OCR ZIP is not bundled in the installer. Its generated manifest
  uses a version-addressed HTTPS GitHub Release URL plus an exact byte count and
  SHA-256 digest.
- OCR download supports bounded retry and HTTP Range resume. A versioned URL is
  not considered sufficient integrity evidence; the digest check is
  fail-closed.
- Release-mode package QA rejects development paths, `file://` URLs,
  `latest` URLs, unexpected repository/tag/asset identity, and missing
  packaged backend bytes.
- Network acquisition of the OCR runtime or Ollama model remains
  user-initiated and consented. The app must not silently pull models or install
  machine-wide dependencies.
- Runtime health, installation progress, cancellation, retry, and actionable
  failures are exposed through the top-bar runtime status and the dedicated
  runtime-management route.

### WindowsML OCR acceleration and CPU fallback

- WindowsML OCR prefers `DmlExecutionProvider` when its runtime, adapter, and
  model session are usable. DirectML availability is an optimization, not an
  Alpha release gate.
- If DirectML is unavailable or adapter selection fails, the backend emits an
  acceleration warning and starts with `CPUExecutionProvider`.
- If DML session/pipeline construction or DML prediction fails, the backend
  emits an acceleration warning, replaces the DML pipeline with a CPU-only
  pipeline, and retries that operation once. The CPU retry must not loop; if it
  also fails, the CPU error is propagated as the OCR failure.
- The selected device and fallback reason flow through backend health and OCR
  results. The frontend renders CPU fallback as a warning and displays the
  exact status `WindowsML OCR · 使用 CPU 中` or `使用 CPU 中` in the
  applicable runtime view.
- CPU-only OCR is therefore a supported degraded mode. It may be slower, but it
  is not rejected merely because DirectML or a preferred GPU is unavailable.
- If `CPUExecutionProvider` itself is unavailable, WindowsML OCR is
  unavailable; this is not presented as a successful fallback.
- No particular GPU SKU, including RTX 4600, is required or specially certified
  for Alpha acceptance.

### Ollama reasoning runtime

- Ollama is the only Alpha reasoning runtime. FastFlowLM, WindowsML/XDNA2
  reasoning, and their installers or provider terms are not product paths.
  WindowsML remains only the OCR runtime described above.
- The reasoning model is fixed to base model `qwen3.5:4b` with the single
  local profile `cert-prep-qwen3.5-4b-study-8k` and an 8,192-token context
  window. The desktop `auto` profile alias resolves to that same profile.
- The profile catalog exposes no alternate or fallback model. A missing or
  failed fixed model is reported as reasoning unavailable; the app must not
  silently select another model.
- If Windows hardware inventory is missing, fails, or reports no `kind=gpu`
  entry, the execution policy uses CPU and emits a warning. Any reported GPU
  leaves Ollama in `auto`; this inventory hint does not prove compatibility or
  actual GPU execution. The frontend displays
  `Reasoning model: qwen3.5:4b · 使用 CPU 中` for the available CPU state.
- Reasoning-runtime failure must not block OCR, manual question entry, import,
  or exam flows that do not require generated reasoning.

## Hosted-Only Alpha Release Workflow

The canonical `.github/workflows/release-alpha.yml` pipeline uses only GitHub
hosted runners:

1. `build-candidate` runs on `windows-2025`.
2. `clean-install` runs on `windows-2025` and consumes the exact candidate
   produced by `build-candidate`.
3. `publish-alpha` runs on `ubuntu-24.04` after both preceding jobs pass.
4. `cleanup-incomplete-prerelease` runs on `ubuntu-24.04` when the creating
   run must remove an incomplete prerelease it owns.

The workflow contract is:

- Manual dispatch must originate from the default branch; a tag dispatch must
  use the canonical Alpha tag. The candidate commit must be an ancestor of the
  fetched default branch.
- Repository visibility must be public and the GitHub-provided repository
  identity must match the independently configured expected repository.
- Candidate identity binds the exact source, release plan, installer, runtime
  payloads/manifests, legal evidence, checksums, and the scripts used for
  clean-install, finalization, and publishing.
- The clean-install job downloads the immutable candidate artifact. It does not
  check out source, rebuild, or substitute another installer.
- Hosted quality checks cover the applicable Nx lint/test/build targets,
  desktop script type checking, release-tool and package-QA contracts, Rust
  tests, and one real-backend functional smoke. They do not attempt GPU
  certification.
- The workflow contains no self-hosted runner label, protected hardware
  environment variables, external hardware harness, acceptance-PDF directory,
  `ffprobe`, screen recording, or hardware-verifier gate.

## Installer, Artifacts, and Legal Evidence

- Alpha publishes exactly one Windows installer: NSIS setup. Tauri bundle
  targets are `["nsis"]`.
- MSI/WiX is not built, smoke-tested, or published. There is no numeric MSI
  version mapping in the effective release contract.
- The candidate and final release use one canonical asset identity and reject
  duplicate basenames or unexpected release files.
- The final release inventory includes:
  - the single NSIS setup installer;
  - the bundled backend ZIP and its manifest;
  - the remote WindowsML OCR ZIP and its manifest;
  - SPDX SBOM evidence;
  - the dependency license inventory;
  - project `LICENSE`, `PRIVACY.md`, `CHANGELOG.md`, third-party notices, and
    required dependency license texts;
  - package-QA and clean-install evidence;
  - release metadata and the release plan; and
  - `SHA256SUMS`.
- Redistribution is fail-closed. Dependencies need reviewed license metadata
  and required license text. Bundled backend/OCR payload declarations and
  hashes must match the shipped bytes.
- PyInstaller bootloader licensing and the exact WindowsML OCR model/config/
  dictionary/pipeline entries remain represented in legal and artifact
  inventory.
- SPDX is the sole SBOM format for this Alpha. CycloneDX assets are rejected.
- Provenance generation and artifact attestation are not Alpha publication
  gates. Candidate identity, exact inventory, and SHA-256 verification are the
  active integrity controls.

## Fresh-Install and Public-Publish Acceptance

### OCR bootstrap and clean install

- The workflow reserves a no-clobber prerelease and publishes the versioned
  WindowsML OCR ZIP and manifest before clean-install validation.
- The clean hosted runner downloads the public OCR asset without relying on
  local build bytes and verifies its byte count and SHA-256.
- Clean-install acceptance requires exactly one NSIS setup installer and proves:
  - unattended installation into a fresh app-data context;
  - packaged desktop launch;
  - bundled backend installation and health using the packaged Python 3.12
    runtime;
  - backend/product version agreement; and
  - NSIS uninstall registration, uninstaller execution, and removal of the
    installed executable and install root.
- The clean-install report passes only after uninstall succeeds. A package that
  launches but cannot be removed is not accepted.

### Final publication

- Finalization reuses the accepted candidate and clean-install evidence. It
  does not rebuild the installer.
- Publishing is no-clobber. A creating run may clean up only its own incomplete
  prerelease; finalized releases are never removed by failure cleanup.
- The public prerelease must contain exactly the finalized inventory. After
  publication, verification downloads every public asset anonymously, without
  `GH_TOKEN` or an Authorization header, and checks every byte against the
  exact `SHA256SUMS` inventory.
- Successful authenticated upload alone is not acceptance. Anonymous exact
  inventory and hash verification is the final publication proof.

## Local Diagnostics

- Local packaged-runtime smoke, package QA, WindowsML provider probes, process
  residue audits, and resilience exercises remain useful developer
  diagnostics.
- Candidate-bound resilience may exercise cancellation, retry, restart,
  single-flight installation, interrupted downloads, backend health, and owned
  process cleanup.
- Local diagnostics are not canonical release evidence and cannot replace the
  hosted candidate -> clean-install -> publish chain.
- GPU telemetry, provider traces, OCR benchmarks, and multi-document workloads
  may be collected when diagnosing performance. They are not required release
  artifacts and do not decide Alpha acceptance.
- There is no required external harness, four-PDF corpus, `ffprobe` binary,
  video/screen recording, or GPU-residency proof.
- Local resilience failures should still be investigated, but passing those
  targets does not add hardware certification to the product claim.

## Process and Cleanup Contract

- Runtime/model jobs use their owner-specific single-flight and cancellation
  contracts where those APIs are exposed. The bundled-backend installer is
  single-flight and status-queryable after start, but it does not expose a
  cancellation command. Retry must not silently create duplicate installers,
  downloads, or backend processes.
- The desktop owns only the child processes it launches. Shutdown and
  cancellation clean up those owned descendants without killing unrelated
  machine-wide Python, Ollama, Node, or browser processes.
- Runtime health must distinguish ready, installing, degraded CPU fallback,
  missing runtime/model, and failed states. CPU fallback is visible and must
  never be reported as GPU acceleration.

## Superseded or Rejected Requirements

The following items are deliberately outside the effective Alpha contract and
must not reappear as active TODOs or release gates without a new decision:

- self-hosted GitHub runners or hardware-specific runner labels;
- `alpha-hardware` environment variables and protected hardware inputs;
- an external fixed-version hardware acceptance harness;
- exactly four acceptance PDFs or a protected acceptance-PDF manifest;
- `ffprobe`, video recording, screen recording, or media-duration checks;
- candidate hardware verifier/evidence and mandatory AMD/NVIDIA routing proof;
- rejection of otherwise healthy CPU-only OCR;
- special acceptance for RTX 4600 or any other GPU SKU;
- MSI/WiX packaging or dual NSIS/MSI clean-install coverage;
- CycloneDX SBOMs;
- provenance or attestation publication gates;
- alternate Ollama model fallback;
- machine-wide Python as the packaged backend;
- `externalBin` backend sidecars;
- bundling the WindowsML OCR ZIP inside the installer; and
- FastFlowLM or WindowsML/XDNA2 as a reasoning provider.

## Verification Evidence

### Current simplified implementation

At `b5f63f5`, repository checks covered the contracts that enforce this
simplification:

- release workflow contract tests reject self-hosted/hardware, `ffprobe`,
  recording, MSI, CycloneDX, provenance, and attestation terms;
- release-tool tests passed 66 Node tests and 21 Python tests, including Ruff;
- package-QA tests passed 205 cases with one Windows permission-specific skip;
- desktop release script type checking passed;
- frontend model-health coverage passed and asserts the CPU status strings;
- WindowsML OCR coverage passed 44 tests, including DML-unavailable,
  adapter-selection, pipeline-construction, prediction-failure, and
  single-CPU-retry cases;
- Ollama coverage passed 53 tests and asserts one `qwen3.5:4b` 8K profile
  with no fallback profiles; and
- Rust desktop tests passed 20 cases.

### Historical evidence retained for diagnostic value

- Hosted CI run `29463901598` at `d54341a` passed the then-current Windows
  portable and product-quality checks. It is historical CI precedent, not
  evidence that the current release commit passed the simplified canonical
  workflow.
- A local candidate at `06db87d` proved real packaged installation, launch,
  bundled-backend health, resilience/process cleanup, and uninstall. That run
  predates the hosted-only/NSIS-only simplification and is retained only as
  diagnostic evidence; its removed MSI and hardware conditions are not current
  acceptance requirements.

## Remaining Alpha Release Work and Risks

- The exact release commit is accepted only after the canonical hosted workflow
  completes build-candidate, NSIS clean-install/launch/health/uninstall, final
  publication, and anonymous exact inventory/hash verification.
- The public Alpha remains unsigned and will trigger SmartScreen warnings.
  Production signing is still required before GA.
- WindowsML OCR acquisition depends on a versioned GitHub Release asset. Bounded
  retry/resume and byte/hash validation remain mandatory because there is no
  separate mirror in the Alpha contract.
- CPU fallback can be materially slower than GPU execution. This is a visible
  degraded mode, not a hidden failure or a release blocker.
- Packaging or release-layout changes must rerun release-tool, package-QA,
  clean-install, and anonymous public verification; historical local or hosted
  evidence cannot be substituted.
