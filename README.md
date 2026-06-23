# Cert Prep

Local-first desktop cert-prep workspace built with Nx, pnpm, Angular, Tauri, Python FastAPI, SQLite, and Ollama.

## Projects

- `cert-prep` - Angular standalone-component UI for project setup, PDF import, draft approval, practice, and wrong-answer review.
- `cert-prep-e2e` - Playwright coverage for the full practice loop.
- `cert-prep-backend` - FastAPI backend for persistence, file handling, PDF extraction, draft/question workflows, and Ollama integration.
- `cert-prep-desktop` - Tauri v2 desktop wrapper that launches the Python sidecar and passes the local API URL/token to Angular.

## Quick Start

```bash
pnpm install
pnpm nx run cert-prep:serve
```

For the desktop shell:

```bash
pnpm nx run cert-prep-desktop:dev
```

The app expects local Ollama to be installed separately. Pull the configured model manually when needed:

```bash
ollama pull qwen3.5:4b
```

## Verification

```bash
pnpm nx run cert-prep:lint
pnpm nx run cert-prep:test
pnpm nx run cert-prep:build
pnpm nx run cert-prep-e2e:e2e
pnpm nx run cert-prep-backend:lint
pnpm nx run cert-prep-backend:test
pnpm nx run cert-prep-desktop:lint
pnpm nx run cert-prep-desktop:cargo-test
```

## Backend Notes

The backend owns all persistence and file I/O. It stores data under `CERT_PREP_DATA_DIR` when provided, or a local app-data directory in desktop mode. Angular communicates through the generated API client and never writes directly to SQLite or disk.

Deterministic tests use fake AI providers. Live Ollama checks are optional smoke tests and should not be required for CI.

## Useful Nx Commands

```bash
pnpm nx show projects --json
pnpm nx graph
pnpm nx run-many --targets=lint,test,build
pnpm nx affected --targets=lint,test,build
```
