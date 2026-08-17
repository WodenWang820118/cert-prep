# Cert Prep

Local-first Windows certificate-preparation app built with Nx, pnpm, Angular,
Tauri, Python FastAPI, SQLite, WindowsML, and Ollama.

## Alpha Status

The source tree is preparing `0.1.0-alpha.1` for a Windows 11 x64 public
alpha. No release is available until the clean-install and protected AMD
hardware acceptance gates pass. The alpha installers will be intentionally
unsigned (`unsigned_public_alpha`), so Windows SmartScreen warnings are
expected. Published installers must be verified against the release's
`SHA256SUMS` file before they are run.

This is not a production or GA readiness claim. Authenticode signing of the
application, bundled runtime, MSI, and NSIS installer remains a GA blocker.

## Projects

- `cert-prep` - Angular standalone-component UI for project setup, PDF import, draft approval, practice, and wrong-answer review.
- `cert-prep-e2e` - Playwright mock UI regression and real-backend contract coverage.
- `cert-prep-backend` - FastAPI backend for persistence, file handling, PDF extraction, draft/question workflows, and local LLM providers.
- `cert-prep-desktop` - Tauri v2 desktop wrapper that installs and launches the bundled, digest-verified backend runtime.

## Quick Start

```bash
pnpm install
pnpm nx run cert-prep:serve
```

For the desktop shell:

```bash
pnpm nx run cert-prep-desktop:dev
```

For browser-only development, install Ollama and pull the configured model when
live generation is needed. Packaged Alpha onboarding uses Ollama:

```bash
ollama pull qwen3.5:4b
```

## Capture Runtime release sidecar

`capture-runtime@0.4.1` is installed as a Windows x64 release sidecar, not as
an npm or Python dependency. By default, the installer uses the canonical
`https://github.com/gx-capture/capture-workbench/releases/download/v0.4.1`
release. `CERT_PREP_CAPTURE_RUNTIME_RELEASE_BASE_URL` is only for an explicit
versioned HTTPS release URL or loopback HTTP mirror during local testing. For a
local Capture Workbench candidate, set
`CERT_PREP_CAPTURE_RUNTIME_RELEASE_DIRECTORY` to its release artifact directory;
the installer copies and verifies only the canonical consumer assets, without
changing the default public URL.

```powershell
pnpm nx run cert-prep-desktop:install-capture-runtime
pnpm nx run cert-prep-desktop:dev
```

The installer downloads only the executable, checksum, manifest, and schema;
verifies their version, platform, bytes, and SHA-256 contract; and stages them
under `tmp/cert-prep/capture-runtime/0.4.1`. Desktop preparation consumes that
staging directory without network access. To exercise the complete local
release-consumer path, including the downloaded sidecar and cert-prep host
structuring coordinator, run:

```powershell
pnpm nx run cert-prep-desktop:capture-runtime-consumer-smoke
```

The same smoke can consume a local candidate without using the Capture
Workbench desktop app as evidence:

```powershell
$env:CERT_PREP_CAPTURE_RUNTIME_RELEASE_DIRECTORY =
  'C:\software-dev\capture-workbench\packages\capture-runtime\dist\release'
pnpm nx run cert-prep-desktop:capture-runtime-consumer-smoke
Remove-Item Env:CERT_PREP_CAPTURE_RUNTIME_RELEASE_DIRECTORY
```

For the independent Cert Prep Tauri app, install that local artifact first,
then build `cert-prep-desktop:build-capture`; its own generated resources and
NSIS bundle are the consumer under test.

v0.4.1 is the engine-bearing release contract. Cert Prep uses
`hostManagedHandshake: true` and keeps runtime setup in the host. Embedded-text
PDFs can run through the `pdf-embedded-text` CPU extractor; scanned PDFs and
images require a ready `windowsml-ocr` requirement, and audio requires a ready
`whisper-primary` requirement after explicit consent. The consumer smoke proves
the published sidecar's authenticated readiness, requirement identifiers, and
host protocol. It is not by itself positive OCR/STT evidence.

## Verification

```bash
pnpm nx run cert-prep:lint
pnpm nx run cert-prep:test
pnpm nx run cert-prep:build
pnpm nx run cert-prep-e2e:e2e
pnpm nx run cert-prep-e2e:e2e-real-backend
pnpm nx run cert-prep-backend:lint
pnpm nx run cert-prep-backend:test
pnpm nx run cert-prep-desktop:lint
pnpm nx run cert-prep-desktop:cargo-test
pnpm nx run cert-prep-desktop:package-qa-test
pnpm nx run cert-prep-desktop:release-tool-test
```

## Backend Notes

The backend owns all persistence and file I/O. It stores data under `CERT_PREP_DATA_DIR` when provided, or a local app-data directory in desktop mode. Angular communicates through the generated API client and never writes directly to SQLite or disk.

Deterministic tests use fake AI providers. Live Ollama checks are optional smoke tests and should not be required for CI.

Privacy, licensing, and redistribution details are documented in
[PRIVACY.md](PRIVACY.md), [LICENSE](LICENSE), and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Useful Nx Commands

```bash
pnpm nx show projects --json
pnpm nx graph
pnpm nx run-many --targets=lint,test,build
pnpm nx affected --targets=lint,test,build
```

## Capture Workbench and Capture Runtime

The normal dependency is the pinned public release package
`@gx-capture/capture-workbench-ui@0.4.1` from GitHub Packages. GitHub Actions configures
the `@gx-capture` registry and read token automatically. For a local install, configure
an npm user config without committing credentials:

```powershell
$npmConfig = Join-Path $env:TEMP 'cert-prep-github-packages.npmrc'
$token = (gh auth token).Trim()
try {
  Set-Content -LiteralPath $npmConfig -Value "@gx-capture:registry=https://npm.pkg.github.com`n//npm.pkg.github.com/:_authToken=`${NODE_AUTH_TOKEN}`n"
  $env:NODE_AUTH_TOKEN = $token
  $env:NPM_CONFIG_USERCONFIG = $npmConfig
  pnpm install --frozen-lockfile
} finally {
  Remove-Item Env:NODE_AUTH_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:NPM_CONFIG_USERCONFIG -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $npmConfig -Force -ErrorAction SilentlyContinue
}
```

The pinned Capture Runtime is downloaded by
`pnpm nx run cert-prep-desktop:install-capture-runtime`; it defaults to the
matching GitHub Release and accepts
`CERT_PREP_CAPTURE_RUNTIME_RELEASE_BASE_URL` only for an explicit local mirror.
