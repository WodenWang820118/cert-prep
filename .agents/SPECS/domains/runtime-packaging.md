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
- The public Alpha reasoning runtime is Ollama-only. Provider-neutral contracts
  remain available for future adapters, but retired provider implementations,
  runtime kinds, terms workflows, and installer paths are not product
  capabilities.
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
- Public release identity is pinned twice without hardcoding an owner in the
  repository: GitHub provides `${{ github.repository }}`, while the publisher
  configures an independent `ALPHA_EXPECTED_REPOSITORY` repository variable.
  Metadata generation fails unless they are identical. Manual dispatch must
  originate from the repository default branch, tag dispatch must use the
  canonical alpha tag ref, and the candidate commit must be an ancestor of the
  fetched default branch. Manual and tag invocations that resolve to the same
  canonical tag share one non-canceling concurrency group.
- The OCR bootstrap release records an opaque owner composed of the workflow
  run ID, run attempt, and candidate ID. Reusing an identical prerelease from a
  previous run is allowed by the no-clobber contract, but only the run that
  created the prerelease may delete it. Reservation records ownership before a
  separate OCR upload step, so upload failure can withdraw the creating run's
  partial prerelease. A second candidate-bound marker distinguishes
  `ocr-bootstrap` from `finalized`; cleanup refuses the finalized state even if
  a later workflow-summary step fails. Cleanup has `contents: write` only behind
  the protected `alpha-release` environment and fails closed when either marker
  is missing or differs.
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
  validators alone did not close a real provider gate; the exact local
  candidate execution is recorded below.
- Commit `bfb7ca6` pinned Node 24, pnpm 10.33.2, Python 3.12/uv, and Rust stable,
  and added Windows CI plus the isolated real-backend E2E lane. The exact
  successful hosted code-checkpoint result is recorded in the public repository
  checkpoint below.
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
  and Ruff. The exact installed-candidate execution is recorded below.
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
  acceptance run ID, harness digest, and install receipt. Commits `cc4f3d0`
  and `c7efc6f` make terminal commit probes fail immediately on a failed or
  canceled operation and require the successful manual-draft terminal payload
  to prove exact effective Ollama/model attribution, at least two generated
  questions, and no fallback. Local verification through `c7efc6f` passed
  script type checking, package QA 262 tests with one skip, and desktop lint
  with two pre-existing warnings. The exact current-candidate execution below
  closes this local nonpublishable parent gate.
- Commits `14875e6` and `8728cb0` moved release execution scripts and the final
  E2E backend proxy to native TypeScript. The only remaining tracked `.mjs`
  file is an ESLint configuration, not an execution script.

### Exact Local Candidate Acceptance (2026-07-16)

- Product and harness commit
  `06db87d1e19a6e1e2e633730a69ce89f5bfb4678` produced local candidate ID
  `5ebde8afc5e956a98daf6bdd11e31742d7bcde00c714687236260c1a5c2350a6`
  and tag `cert-prep-local-v0.1.0-alpha.1-06db87d1e19a`. Its profile is
  `local_nonpublishable` with `publishable=false`; it is not part of the public
  release chain. Independent verification rehashed all 696 declared and actual
  files with zero mismatch, missing, unexpected, or reparse entries and
  recomputed the exact candidate ID. `candidate.json` SHA-256 is
  `c0f08b071d6eab059e7dcbc149290130f2ebd45b28c19c5179c63f422acb4c47`;
  harness SHA-256 is
  `b99cc8d4a7e6dfa290cdffe652cc1b2a8b6083bc7c5c596e0b2e139756a33afd`.
- The candidate contains NSIS SHA-256
  `476e24012acdf9361d1e5189d52f31b4dfa4a65dc61b150fcf99d40a898fd183`
  and MSI SHA-256
  `263d5e176d69c8e996a3c5c02ec02202023b64823841c58f6f03ef07b4cad983`.
  Install run
  `local-install-06db87d1e19a-1fb5fa29-2a1c-4aed-94ee-17e118716a2e`
  produced schema-v1 receipt SHA-256
  `4e3f4a91cd6e824f2aef54e78cd009b12d33bcdfc20345e75e2a94f5cd15a941`
  and acceptance-context SHA-256
  `2251ff0e0dbe84015d4184b7befb72352ed457a32a6f7567a5274b6a8bb20388`.
  The receipt bound a fresh NSIS install to `cert-prep-desktop.exe`
  (9,339,904 bytes, SHA-256
  `b2ab479940038b9b4fab5d30de89491ebda8075a29928d9fd7e3223fc27e0f25`).
- `packaged-document-cancellation-windowsml` atomically published exactly five
  schema-v2 evidence files under
  `tmp/cert-prep-desktop/packaged-document-cancellation-06db87d-1fb5fa29-2a1c-4aed-94ee-17e118716a2e`.
  Their SHA-256 values are:
  - `upload.json`:
    `9169323c9e81d0636be7ea58519efc89861cd2a463bbeac041bbc43b6e7f2175`;
  - `ocr.json`:
    `cc0e8e183ebad8550f3768ba15c1d1a2eef031fd8e2652dad249b8450a7e1ff7`;
  - `cancelVsCompleteRace.json`:
    `1e45d4f0e2a8862cebf0610d202ddf8f72cc06532085d626dc6305078d072704`;
  - `crashRecovery.json`:
    `31054d8a099c158b02deddcb4d0ae2ab67dfc4b03c399f22ed660b26126b3ff2`;
  - `partialDataRemoved.json`:
    `4ca311d6a1344118c6e4561167cfb4502b67956761ffa6efde75249334b3f5e0`.
    Upload cancellation created no document. OCR operation
    `ocr-b41f8cca-30dd-4b5d-8df9-01d2d7ce632d` canceled; distinct same-document
    retry `499434b0-9c72-425c-b0e1-6d6bc1bce49c` completed all 46 pages and
    chunks through `windowsml_ocr` on `amd_windowsml:0` with no fallback. The
    race stayed canceled, crash recovery retained the same operation, partial
    data returned to zero, and no late publication occurred during the
    two-second observation window.
- `packaged-remaining-resilience-windowsml` atomically published exactly five
  files under
  `tmp/cert-prep-desktop/packaged-remaining-resilience-06db87d-1fb5fa29-2a1c-4aed-94ee-17e118716a2e`.
  Their SHA-256 values are:
  - `draft.json`:
    `be4a7a030711f35fd1e9b8a63af2206973b73b9ea5f085fa5580a916b24143bd`;
  - `runtime.json`:
    `f6db2e616bd361cddd4552647dbb459d27d522ba18cdbeba5d7893a69f9d73af`;
  - `model.json`:
    `e005545c788c86a3d1a826b086b732469f7ea3c9a6f016229d9fe22b16f76b44`;
  - `ownedProcessesReleased.json`:
    `2a560fd5de0494d4ab71b26ab54226a08c07a330581df1902c8c7be880fec82c`;
  - `session-restart.json`:
    `dc9bd3915d34fccfeeb42e54a2d011f1e689e5fcdddc19db6e5c2cc8bb99e4d9`.
    The isolated model store began empty. Model and runtime cancel-versus-commit
    checks passed; a canceled manual draft stayed at zero before a committed
    manual operation generated two usable questions with effective
    `ollama`/`qwen3.5:4b` and no fallback. Explicit Resume retained the first
    answer, the two-question session completed, and a second restart preserved
    completion. Two stable empty process snapshots proved zero residue.
- The official `local-resilience-evidence-verify` target accepted all ten
  document, remaining, and session artifacts with the exact candidate, harness,
  acceptance run, receipt, installer, and installed-executable bindings.
- Final NSIS uninstall parsed the actual quoted registry `UninstallString` and
  ran its 79,386-byte uninstaller (SHA-256
  `a54e72705eb33057034d2f05eb6fd0b628b64a800b6b93d2deae577e30a92db5`)
  with `/S`; exit code was zero. The install root, installed executable,
  uninstaller, Cert Prep product key, and Cert Prep uninstall key were absent
  afterward. The Exam Prep sibling retained identical HKCU and HKLM registry
  snapshots. All 18 preserved candidate, receipt, and evidence fingerprints
  were byte-for-byte unchanged. Ports `19640` through `19660` and all owned
  app/backend/OCR/Ollama processes were absent. The unrelated global Ollama
  remained PID `43052`, path
  `C:\Users\User\AppData\Local\Programs\Ollama\ollama.EXE`, start time
  `2026-07-06T02:54:56.1777980Z`, and sole listener
  `127.0.0.1:11434`.
- This closes only the exact local nonpublishable install, resilience,
  forced-provider, combined-verifier, cleanup, and uninstall checkpoint. It
  does not substitute for hosted MSI/NSIS clean installs, four-PDF B3,
  protected XDNA2 evidence, a public OCR asset, or Public Alpha release
  approval.

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

### Public Repository And Hosted Quality Checkpoint (2026-07-16)

- `WodenWang820118/cert-prep` is public with default branch `main`. Repository
  variables pin `ALPHA_EXPECTED_REPOSITORY=WodenWang820118/cert-prep`,
  `ALPHA_PUBLIC_REPOSITORY_CONFIRMED=true`, and
  `ALPHA_RELEASE_ENVIRONMENT_PROTECTED=true`.
  `ALPHA_HARDWARE_RUNNER_READY` remains intentionally unset.
- Both `alpha-release` and `alpha-hardware` require reviewer
  `WodenWang820118` and restrict deployments to `main` and
  `cert-prep-v*-alpha.*`. `prevent_self_review=false`; this checkpoint does not
  claim independent review. Active no-bypass rulesets prevent deletion and
  non-fast-forward changes for the default branch and matching Alpha tags.
- Hosted CI run
  [29463901598](https://github.com/WodenWang820118/cert-prep/actions/runs/29463901598)
  at exact commit `d54341a6174c6dc514260c8f26435752242c63a3` passed both
  `Portable quality` and `Windows product quality`. The Windows job executed
  and passed the shared/backend/OCR/Ollama/Angular aggregate, desktop script
  type checking, package QA, and Cargo tests. This closes the hosted
  cross-runner quality gate only; it is not an anonymous OCR prerelease,
  checkout-free MSI/NSIS result, protected XDNA2/B3 result, or release
  approval.

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

- Public alpha publication remains blocked until pinned clean-snapshot
  AMD/XDNA2 runner/harness/ffprobe inputs,
  anonymous OCR prerelease asset, checkout-free clean MSI/NSIS lanes, and
  protected hardware acceptance exist. The release must keep the Ollama-only
  Alpha contract rather than weakening the gate.
- The protected hardware gate must prove four PDFs, WindowsML/iGPU OCR, exact
  effective Ollama `qwen3.5:4b` attribution, usable and Full Exam counts above
  zero, Ollama reasoning on the Nvidia dGPU, restart/cancellation cleanup with
  per-check evidence, and a playable pinned-`ffprobe`-validated WebM from the
  same installer SHA.
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
