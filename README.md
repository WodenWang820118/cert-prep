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

`capture-runtime@0.3.11` is installed as a Windows x64 release sidecar, not as
an npm or Python dependency. By default, the installer uses the canonical
`https://github.com/gx-capture/capture-workbench/releases/download/v0.3.11`
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
under `tmp/cert-prep/capture-runtime/0.3.11`. Desktop preparation consumes that
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

v0.3.11 is the engine-bearing release contract. Cert Prep uses
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

## Local Capture Workbench Registry Trial

The normal dependency is the pinned public release package
`@gx-capture/capture-workbench@0.3.11` from GitHub Packages. GitHub Actions configures
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

The local registry trial below remains an isolated development diagnostic.

The isolated Capture Workbench consumer can be tried through a local
NPM-compatible registry without changing cert-prep's normal application
dependencies or lockfile. Start Verdaccio and publish the package from the sibling
`capture-workbench` checkout first:

```powershell
# C:\software-dev\capture-workbench
corepack pnpm run local-registry:start

# In a second terminal, still in capture-workbench
corepack pnpm run local-registry:publish
```

Then run the isolated consumer from cert-prep:

```powershell
pnpm run trial:capture-workbench
```

The trial creates a temporary Vite consumer, runs a normal `pnpm install`
against `http://127.0.0.1:4873`, imports `@gx-capture/capture-workbench`, registers the
`capture-workbench` custom element, and runs a production build. The temporary
consumer is removed after the run. The cert-prep route also uses the installed
package through its `CaptureClient` adapter and the backend review API. With
the v0.3.11 sidecar, the route accepts embedded-text PDFs and exposes image and
audio only when their runtime requirements are ready.

### Capture Workbench local registry trial

The `capture-workbench-trial` route is an isolated distribution trial for the
published `@gx-capture/capture-workbench@0.3.11` Web Component. The `/build`
source-import flow remains unchanged; the retired local prototype is no longer
part of the workspace.

From a running local Verdaccio registry supplied by the `capture-workbench`
repository, install the package through the registry and launch Cert Prep:

```powershell
pnpm run install:capture-workbench:local
pnpm nx run cert-prep:serve
```

Open `http://localhost:4200/capture-workbench-trial`. The route uses the
registry-installed `@gx-capture/capture-workbench@0.3.11` package and a cert-prep
`CaptureClient` backed by the review-gated capture API. Capture Runtime and its
token remain backend-only. With the v0.3.11 engine-bearing sidecar, the route
accepts embedded-text PDFs directly; scanned PDFs, images, and audio require
their corresponding runtime requirement to be ready. The install command creates a
temporary root `.npmrc` pointing at `http://127.0.0.1:4873` and removes it when
pnpm finishes. It does not install the package from a `file:.tgz` dependency.
