# Cert Prep

Cert Prep is a local-first certification study application for Windows. It
turns source material into editable study content and practice sessions while
keeping application data and local processing under the user's control.

The main user journey is:

1. Create or select a study project.
2. Import PDF, image, or audio source files.
3. Review the captured text and source evidence.
4. Edit and approve multiple-choice question drafts.
5. Practice with Full Exam or Random Quiz sessions.
6. Review wrong answers and retry weak areas.

## Architecture

The repository is an Nx workspace containing the Angular application, Python
backend, Windows desktop host, shared contracts, and test tooling.

```text
Angular UI
    |  authenticated Cert Prep API
    v
FastAPI backend  ---->  SQLite and local source files
    |\
    | +------------->  Capture Runtime sidecar for source extraction
    +--------------->  Ollama for optional local language-model features

Tauri desktop host owns the backend and sidecar lifecycle and packages them
with the Angular UI.
```

The backend owns persistence and file I/O. The Angular application does not
read SQLite or the local filesystem directly. Capture Runtime owns extraction
and its wire protocol; Cert Prep owns the authenticated host proxy, review
workflow, document mapping, and study features. Ollama is optional enrichment,
not a prerequisite for manual review or deterministic tests.

## Repository map

| Path | Responsibility |
| --- | --- |
| [`apps/cert-prep`](apps/cert-prep) | Angular standalone-component UI, workbench screens, signal stores, API services, and runtime status views. |
| [`apps/cert-prep-backend`](apps/cert-prep-backend) | FastAPI sidecar, SQLite persistence, source-document handling, question generation, practice, wrong-answer review, and runtime integration. |
| [`apps/cert-prep-desktop`](apps/cert-prep-desktop) | Tauri 2 Windows host, backend process management, sidecar installation/verification, packaging, and desktop smoke/QA scripts. |
| [`apps/cert-prep-e2e`](apps/cert-prep-e2e) | Playwright mock-UI tests and real-backend browser tests. |
| [`libs/cert-prep-api`](libs/cert-prep-api) | Generated TypeScript client and typed request helpers derived from the backend OpenAPI contract. |
| [`packages/cert-prep-contracts`](packages/cert-prep-contracts) | Shared Python value types and provider protocols. |
| [`packages/cert-prep-ollama`](packages/cert-prep-ollama) | Ollama discovery, lifecycle, model, profile, and installer utilities shared by the backend and related packages. |
| [`design`](design) | Workbench design references and screen prototypes. |
| [`tools`](tools) | OpenAPI generation helpers, Capture Runtime consumer tooling, packaging checks, and release tooling. |
| [`.agents/SPECS`](.agents/SPECS) | Durable product and architecture specifications. Active temporary work belongs in `.agents/TODOS`. |

## Development prerequisites

The workspace uses:

- Windows for the Tauri desktop and packaged sidecar workflows.
- Node.js 24 and pnpm 11 for the Nx/Angular workspace.
- Python 3.12 with `uv` for the backend and Python packages.
- Stable Rust with the MSVC Windows toolchain for Tauri.

Install JavaScript dependencies from the repository root:

```bash
pnpm install
```

The workspace consumes private `@gx-capture` packages from GitHub Packages.
For local installs, use [`.npmrc.example`](.npmrc.example) as a user-level npm
configuration and provide `GITHUB_PACKAGES_TOKEN`; keep credentials outside the
repository.

The backend declares the local Python packages as editable sources. Sync its
environment when working on Python code:

```bash
uv sync --project apps/cert-prep-backend
```

## Run locally

Run the browser UI and backend independently when working on web/API features:

```bash
pnpm nx run cert-prep:serve
pnpm nx run cert-prep-backend:serve
```

Run the desktop application when testing Tauri integration, process ownership,
runtime setup, or packaged behavior:

```bash
pnpm nx run cert-prep-desktop:dev
```

Live local-model features use Ollama. The application can still be developed
and tested with deterministic fake providers when Ollama is unavailable.

## Verification

Nx is the task entry point for this workspace. Use the target defined by each
project rather than invoking the underlying test runner directly.

### Application and backend

```bash
pnpm nx run cert-prep:lint
pnpm nx run cert-prep:test
pnpm nx run cert-prep:build
pnpm nx run cert-prep-backend:lint
pnpm nx run cert-prep-backend:test
pnpm nx run cert-prep-api:lint
pnpm nx run cert-prep-api:vite:test
```

### Shared packages and browser flows

```bash
pnpm nx run cert-prep-contracts:lint
pnpm nx run cert-prep-contracts:test
pnpm nx run cert-prep-ollama:lint
pnpm nx run cert-prep-ollama:test
pnpm nx run cert-prep-e2e:e2e
pnpm nx run cert-prep-e2e:e2e-real-backend
```

### Desktop and packaging

```bash
pnpm nx run cert-prep-desktop:lint
pnpm nx run cert-prep-desktop:typecheck-scripts
pnpm nx run cert-prep-desktop:cargo-test
pnpm nx run cert-prep-desktop:package-qa-test
pnpm nx run cert-prep-desktop:release-tool-test
```

Build the Tauri application with the desktop project targets:

```bash
pnpm nx run cert-prep-desktop:build
pnpm nx run cert-prep-desktop:build-capture
```

## Contracts and generated code

The backend REST/OpenAPI document is the contract between Python and Angular.
After changing backend routes or response models, regenerate the TypeScript
client and run its checks:

```bash
pnpm nx run cert-prep-backend:generate-openapi-client
pnpm nx run cert-prep-api:lint
pnpm nx run cert-prep-api:vite:test
```

The generated client is written to
[`libs/cert-prep-api/src/lib/cert-prep-api.generated.ts`](libs/cert-prep-api/src/lib/cert-prep-api.generated.ts).
Capture Runtime integration uses the pinned typed client and its authenticated
host boundary; Cert Prep should not duplicate the sidecar wire protocol in
Angular or in backend adapters.

## Data and privacy

The backend stores projects, source metadata, parsed chunks, question drafts,
practice sessions, and wrong-answer history in SQLite. Original source files
are retained under the application data directory and can be redirected with
`CERT_PREP_DATA_DIR`.

See [`PRIVACY.md`](PRIVACY.md) for data-handling details. License and
redistribution information is in [`LICENSE`](LICENSE) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); release-specific workflow
documentation is kept with the tooling in [`tools/release`](tools/release).

## Nx workspace commands

Use these commands to inspect the workspace before selecting a target:

```bash
pnpm nx show projects --json
pnpm nx show project cert-prep --json
pnpm nx graph
pnpm nx affected --targets=lint,test,build
```

The root [`AGENTS.md`](AGENTS.md) contains workspace operating rules. Product
and architecture decisions belong in the domain specifications under
[`.agents/SPECS`](.agents/SPECS), while this README remains a stable guide to
what the repository contains and how its main surfaces fit together.
