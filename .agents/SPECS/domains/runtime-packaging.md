# Runtime And Packaging Domain

## Purpose

This domain owns the packaged desktop runtime story: Tauri shell startup,
backend/OCR runtime artifacts, explicit installation/health UX, package QA,
and process cleanup.

## Decisions

### Public Alpha Distribution Contract (2026-07-11)

- The first distributable channel is a public, unsigned Windows 11 x64 alpha,
  versioned `0.1.0-alpha.1` and tagged `cert-prep-v0.1.0-alpha.1`. It is not a
  GA or production-ready claim. Release metadata and release notes must use
  `unsigned_public_alpha`, explain the expected SmartScreen warning, and
  publish SHA-256 verification instructions.
- Source, Cargo, Tauri, manifests, tag, and asset names retain the SemVer
  `0.1.0-alpha.1`. WiX alone receives the deterministic numeric product
  version `0.1.0.1`, because MSI prerelease identifiers must be numeric-only;
  release metadata records both values and the release tool validates the
  mapping.
- Backend, shared contracts, WindowsML OCR, and Ollama Python projects declare
  the same alpha source version; Python packaging normalizes it to
  `0.1.0a1`. Backend health retains the product SemVer. Release runtime builds
  and inventory collection use isolated Python 3.12, and clean-install rejects
  any backend health outside the pinned 3.12 line.
- The backend runtime ZIP and its manifest are Tauri resources. The backend
  artifact URL is `null`; missing bundled bytes are package corruption, not a
  download state. The installed app verifies byte count and SHA-256, extracts
  into a temporary directory with traversal/symlink rejection, and atomically
  swaps the verified runtime into app data.
- The WindowsML OCR ZIP is not bundled. Its generated release manifest uses a
  version-addressed HTTPS GitHub Release URL plus byte count and SHA-256. The
  downloader supports bounded retry and HTTP Range resume. URL uniqueness is
  not treated as immutability; digest verification remains fail-closed.
- FastFlowLM is never bundled, mirrored, or republished by Cert Prep. The app
  may download the allowlisted v0.9.43 installer only from the official
  FastFlowLM release, after displaying the upstream terms and collecting
  explicit consent. Size, SHA-256, WinVerifyTrust status, timestamp, signer
  identity, and signer thumbprint are all required before execution.
- Generated runtime manifests belong under an ignored desktop
  `generated-resources` directory. Release-mode package QA rejects `file://`,
  absolute development paths, `latest` URLs, unexpected repository/tag/asset
  names, or absent bundled backend bytes.
- Code signing remains an explicit GA blocker. Alpha does not configure a fake
  certificate, self-signed certificate, or placeholder `signCommand`.
- Every redistributed archive and installer must ship an SPDX/CycloneDX SBOM,
  license inventory, and required license texts. Unknown or unapproved
  redistribution terms block publishing. License expressions must parse and
  use only the reviewed identifier/exception allowlist; arbitrary SPDX-shaped
  identifiers are not accepted.
- Backend and OCR inventories explicitly include PyInstaller v6.20.0 and its
  complete GPL-2.0-or-later bootloader-exception text. The OCR ZIP additionally
  has an exact-entry declaration for both ONNX models, both configs, the
  recognition dictionary, and `pipeline.json`; each payload byte count and
  SHA-256 is visible in the OCR-scoped SPDX/CycloneDX documents.
- Candidate identity covers both publishable release files and the scripts
  that execute clean-install, hardware verification, finalization, and
  publishing. The separately provisioned AMD acceptance harness and `ffprobe`
  executable are protected-environment inputs pinned by SHA-256.
- Hardware acceptance cannot report cancellation/recovery with bare booleans.
  Every required check references its own candidate-bound JSON evidence and
  digest. The recording is time-bound to the completed run and must pass the
  pinned `ffprobe` gate for container, codec, dimensions, duration, and decoded
  frame count. Finalization revalidates the declared hardware files and both
  clean-install report schemas/digests before marking evidence passed.

- The packaged app should use downloadable release/runtime artifacts rather than
  assuming machine-wide Python or hidden global setup.
- Python runtime means the packaged PyInstaller backend executable zip, not a
  system Python installer.
- The initial Windows installer ships the Angular UI plus the verified backend
  runtime archive. OCR and LLM/model payloads remain explicit downloads.
- Runtime artifacts are described by manifests with file name, byte size,
  SHA-256, target, entrypoint, and release/local URL.
- Remote runtime payloads are release assets addressed by generated manifest
  URLs. The backend is the explicit exception because it is bundled.
- The retired Tauri `externalBin`/sidecar path is unsupported and must be
  deleted rather than retained as a compatibility lane.
- Python backend and WindowsML OCR runtime readiness are required for packaged
  OCR/manual PDF workflows.
- Runtime management has two supported entrypoints: the app topbar opens the
  shell modal, while `/runtime` remains an unguarded recovery/deep-link route
  rendering the same runtime details without modal-only close or cancel
  controls. Standalone `ModelHealthComponent` instances keep route navigation
  for app-shell compatibility.
- Ollama and model availability are optional reasoning dependencies. They must
  never block OCR, source import, manual questions, Full Exam, Random Quiz, or
  wrong-answer review.
- Runtime install/download actions require explicit user consent.
- Health checks and app startup must not install Ollama, pull models, or
  install OCR runtimes implicitly.
- Package QA schema v3 must verify MSI/NSIS artifacts, bundled backend runtime zip,
  WindowsML OCR runtime zip, manifests, launch env, and script-level gates
  through Nx targets. The legacy Paddle OCR runtime manifest is not a packaged
  product artifact.
- Runtime manifest hash churn should only be committed when the artifact change
  is part of the intended slice.
- Process residue handling is audit-first. The desktop process residue audit may
  classify and recommend actions for Node/Python processes, but it must not kill
  processes by default.
- Scoped cleanup is limited to processes launched and owned by the active
  package QA or packaged-flow script. Future cleanup commands require manual
  confirmation and must protect Codex, MCP, Claude, Nx, VS Code, servicehub, and
  other known tooling residents.

## Rejected Packaging Options

- Installing machine-wide Python is rejected because it affects user systems
  and complicates version support.
- Bundling Ollama model files is rejected because installer size and
  model-licensing/storage become packaging concerns.
- Keeping the backend only as a bundled `externalBin` is rejected because the
  UI cannot guide recovery when the runtime is missing.
- Bundling PaddleOCR or WindowsML OCR into the initial installer is rejected
  because every install would pay the OCR payload cost.
- CPU-only OCR runtime packaging is rejected for the Windows optional runtime
  because it does not satisfy the GPU-auto product requirement.
- Blocking pull requests or UI startup on large model/runtime downloads is
  rejected; runtime work must be explicit and progress-visible.

## Evidence

- The 2026-07-11 local candidate build produced exactly one alpha MSI and one
  alpha NSIS. Package QA schema v3 rejects stale or unexpected bundle files,
  rejects development/file URLs, requires the backend ZIP in the candidate
  resource tree, and requires the OCR ZIP to be absent from that tree.
  Extraction from real MSI/NSIS installs remains a clean-runner gate.
- Runtime builders retain only the requested versioned ZIP for their owned
  prefix. Ignored legacy `exam-prep-backend` binaries/spec/build directories
  and unversioned backend/OCR ZIPs were removed; a `-uu` workspace scan has no
  remaining old sidecar-name match.
- The bundled backend executable launched from the packaged resource ZIP,
  returned `status=ok`, `version=0.1.0-alpha.1`,
  `python_version=3.12.12`, created a fresh database through migration 19, and
  stopped its owned process tree. The package QA report records
  `cleanup.backend_process.stopped=true`.
- A 2026-07-11 QA-only launch of the rebuilt Tauri executable used empty
  app-data, exercised the real Rust bundled-runtime verifier/extractor/atomic
  installer, wrote `runtimes/python_backend/runtime-manifest.json`, and reached
  packaged backend health. The Tauri and backend PIDs plus listener were absent
  after scoped process-tree cleanup. Normal launches do not set the QA switch
  and retain explicit user consent.
- The rebuilt WindowsML OCR executable passed its real self-test with
  `provider=windowsml`, `text=OCRTEST`, selected device `amd_windowsml:0`, and
  no fallback reason. The OCR ZIP remains a release asset rather than an
  installer resource.
- The OCR builder excludes `aistudio_sdk` from the PyInstaller archive and
  inspects the built CArchive/PYZ to enforce that exclusion. Offline PaddleX
  downloader stubs cover the optional import surface without redistributing
  the unlicensed SDK.
- Actual packaged Python archive inventories contain 35 backend components and
  82 OCR components after explicitly adding the PyInstaller bootloader, with
  zero `UNKNOWN` licenses and no `aistudio` component. The integrated
  Node/Cargo/Python/model-payload candidate contains 1,304 components. Its OCR
  payload inventory covers 6 non-Python files totaling 138,836,489 bytes, and
  all 6 appear with individual hashes in both OCR-scoped SBOM formats. Release
  tooling fails closed on unsupported or unapproved licenses, missing text,
  undeclared OCR ZIP entries, payload/source drift, or a FastFlow binary inside
  Cert Prep artifacts.
- Candidate assembly emits separate SPDX and CycloneDX documents for the MSI,
  NSIS, backend ZIP, and OCR ZIP. Each has an explicit artifact-to-component
  dependency mapping; the release-wide inventory remains available for license
  review. The current local placeholder-URL assembly passed with 701
  candidate-bound files, including 19 harness files, and all four artifact
  scopes.
- Packaged flow smoke records restart and final close summaries with
  `gracefulExited`, `fallbackUsed`, `exitCode`, and residual process lists.
- `cert-prep-desktop:process-residue-audit` provides a read-only Windows
  process-table report with PID, parent PID, command line, working set when
  available, classification, protection status, evidence, and recommended
  action.
- Python/PaddleOCR health can settle after startup; QA runner checks are scoped
  to the runtime dialog so background document text cannot falsely satisfy OCR
  readiness.

### Local Resilience And CI Closeout (2026-07-14)

- Commit `59aa070` added schema-v2 contracts and scenario primitives for
  `upload`, `ocr`, `draft`, `runtime`, `model`, `cancelVsCompleteRace`,
  `crashRecovery`, `partialDataRemoved`, and `ownedProcessesReleased`.
  Validators bind candidate ID, version, tag, commit, harness SHA, acceptance
  run/time window, bytes, and SHA-256 instead of accepting bare booleans.
- `sessionRestartPassed` now requires its own hashed JSON evidence covering one
  answer, first restart, explicit Resume, completion, and a clean second
  restart.
- The same commit added the real-only
  `packaged-streaming-ollama-fallback-windowsml` target with fail-closed
  declined-terms, unsupported-XDNA2, and old-driver trigger contracts. The
  heavyweight packaged run has not executed, so no real provider gate is
  closed by these validators.
- Commit `bfb7ca6` pinned Node 24, pnpm 10.33.2, Python 3.12/uv, and Rust stable,
  and added Windows CI plus the isolated real-backend E2E lane. A hosted run on
  committed HEAD is still required.
- Verification through `bfb7ca6` passed desktop lint with two pre-existing
  warnings, package QA 124 tests, release tooling 30 Node plus 21 Python tests,
  Cargo 23 tests, E2E lint with two pre-existing warnings, and real-backend E2E
  5 tests.
- Commit `9f87f31` added the fail-closed
  `packaged-document-cancellation-windowsml` Nx target. It validates the exact
  candidate root and identity, installed executable, PDF, harness digest, and
  acceptance run ID before it can atomically publish exactly five
  document-level evidence files: `upload`, `ocr`, `cancelVsCompleteRace`,
  `crashRecovery`, and `partialDataRemoved`. Evidence publication additionally
  requires a residue-free final cleanup.
- Local contract verification for `9f87f31` passed script type checking,
  package QA 147 tests, and release tooling with 30 Node plus 21 Python tests
  and Ruff. The heavyweight target has not run against the exact installed
  candidate, and no candidate-bound five-file output exists.
- Commit `6e5db86` requires a fresh-install receipt bound to the candidate ID,
  acceptance run, pinned harness, physical installer digest, installed
  executable path/size/digest, successful installer exit, and install time.
  Commit `d9fbfcc` requires that installation binding on every one of the nine
  resilience proofs and the session-restart proof, and rejects evidence whose
  run starts before installation.
- Commits `65c3b85` and `f110dee` added an isolated real-Ollama lane and the
  `packaged-remaining-resilience-windowsml` target. It starts canonical
  `ollama.exe` on a dedicated loopback port with a new output-contained empty
  model root, sanitizes inherited Ollama variables, and atomically publishes
  only `draft`, `runtime`, `model`, `ownedProcessesReleased`, and
  `session-restart.json` after app/Ollama cleanup. Process release is tied to
  PID, name, creation time, executable path, and two stable empty snapshots.
- The document and remaining-resilience targets deliberately form two halves
  of one installed-candidate gate. Both must use the same candidate ID,
  acceptance run ID, harness digest, and install receipt. Local verification
  through `f110dee` passed script type checking, package QA 200 tests, release
  tooling with 30 Node plus 21 Python tests and Ruff, and desktop lint with two
  pre-existing warnings. Neither heavyweight target has run against the exact
  installed candidate, so the nine-check parent gate remains open.

### Additional Local Release Prerequisites (2026-07-14)

- Commit `f460d19` copies `README.md`, `PRIVACY.md`, `LICENSE`,
  `THIRD_PARTY_NOTICES.md`, and `CHANGELOG.md` into the Angular `legal` build
  directory so packaged legal links have concrete assets. Frontend lint,
  221 tests, and build passed; the existing bundle-budget warnings remain.
- Commit `346c0b7` adds an explicit QA-only
  `CERT_PREP_PACKAGE_QA_AUTO_INSTALL_BUNDLED_BACKEND=true` startup switch. It
  starts bundled-backend installation only when the installed backend cannot
  launch, enabling the checkout-free clean-install harness without changing
  normal explicit-consent behavior. Cargo 23 tests and release tooling with 30
  Node plus 21 Python tests and Ruff passed locally.
- Commit `4e1a717` makes WindowsML model preparation use isolated Python 3.12
  with copied uv links and installs an offline AIStudio stub before PaddleOCR
  import, preventing the optional downloader path from entering the packaged
  runtime. OCR lint and 36 tests, backend lint, and 370 backend tests with 2
  skips passed. The real WindowsML runtime build/self-test passed and produced
  a local 275,729,817-byte ZIP with SHA-256
  `c76565bd0d2de60e7938f74da89fc8758b8274ad47c4209a92eb2cdaa473438b`.
- These are committed local prerequisites only. They do not establish an
  anonymous public OCR asset, a frozen exact candidate, hosted MSI/NSIS clean
  installs, protected AMD/XDNA2 evidence, or Public Alpha readiness.

## Size And Artifact Evidence

2026-07-11 local candidate evidence:

- Final QA report: `tmp/cert-prep-desktop/package-qa/package-qa.json`.
- Target: Windows x64, `x86_64-pc-windows-msvc`.
- MSI: `Cert Prep_0.1.0-alpha.1_x64_en-US.msi`, 35,790,848 bytes, SHA-256
  `72357593ef1849e12a51a23ebcbe36217ba61ac6485f5111136ad0a3349ba41d`.
- NSIS: `Cert Prep_0.1.0-alpha.1_x64-setup.exe`, 34,789,661 bytes, SHA-256
  `9ba3eba9f60e72cf0f018b9ee5d88bafd39dc9068746b433065e65f8c288f58a`.
- Bundled backend ZIP:
  `cert-prep-backend-runtime-0.1.0-alpha.1-x86_64-pc-windows-msvc.zip`,
  31,479,237 bytes, SHA-256
  `55696e8c39a1f6eb0064888f2a0cefbb11b802be1b321c9b45289b1bf5c6af26`.
- Remote WindowsML OCR ZIP:
  `cert-prep-ocr-windowsml-runtime-0.1.0-alpha.1-x86_64-pc-windows-msvc.zip`,
  275,730,911 bytes, SHA-256
  `a395d0209be8e6280736d8170b57594a0c6061f5c0c904d3e740e2f6519a56f5`.
- Size gate passed: largest initial artifact 34.13 MB, under the 150 MB warning
  threshold and 250 MB failure threshold.
- Runtime QA passed bundled-backend health. OCR health correctly reports
  runtime missing in external mode until the optional runtime is installed.
- LLM QA is read-only when Ollama is unavailable; install/model jobs remain
  confirmation-gated.

These hashes prove the local candidate only. They are not release checksums:
the staged OCR URL is `github.com/local/cert-prep`, so this exact installer is
deliberately non-publishable and must be rebuilt from the real public
prerelease URL.

## Open Risks

- Public alpha publication remains blocked until a public GitHub repository,
  protected release environments, anonymous OCR prerelease asset, checkout-free
  clean MSI/NSIS lanes, and a clean-snapshot AMD/XDNA2 hardware runner exist.
- The publisher must confirm the FastFlow free-tier/commercial and attribution
  assumptions in the protected environment. Without that confirmation the
  release must switch to an Ollama-only alpha rather than weakening the gate.
- The protected hardware gate must prove four PDFs, WindowsML/iGPU OCR, exact
  effective FastFlow `qwen3.5:4b` attribution, usable and Full Exam counts above
  zero, restart/cancellation cleanup with per-check evidence, and a playable
  pinned-`ffprobe`-validated WebM from the same installer SHA.
- The unsigned exception applies only to the public alpha. GA remains blocked
  until the runtime executables, main executable, MSI, and NSIS are all
  Authenticode-signed.
- A single GitHub Release source is accepted for the alpha OCR payload; a
  second mirror is deferred, while retry/resume and digest verification are
  mandatory.

- Runtime health copy must keep distinguishing checking, warming, stale, ready,
  and failed states without regressing upload availability once OCR is known.
- Release URL and local file manifest behavior should be rechecked whenever
  packaging scripts or runtime distribution changes.
- Cargo PDB filename collision warning is known and not part of the active
  parsing/reasoning gate.
- PyInstaller hidden-import warnings and ONNXRuntime provider bridge warnings
  are known from the 2026-06-26 package round; the WindowsML OCR smoke still
  returned ready.
- Generated runtime manifests and archives are ignored build inputs. Only the
  `.gitkeep` belongs in source control; release evidence records their generated
  bytes and hashes without restoring tracked manifests.
