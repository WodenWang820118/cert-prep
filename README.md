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
