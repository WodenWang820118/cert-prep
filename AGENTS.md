<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `pnpm nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->

# Capture Runtime integration

- Cert Prep consumes Capture Runtime **0.4.2**. The pin lives in `tools/capture-runtime-version.mts`, `package.json`, `pnpm-workspace.yaml`, `apps/cert-prep-backend/pyproject.toml` (and `uv.lock`), `apps/cert-prep-desktop/src-tauri/Cargo.toml` (and `Cargo.lock`), and `apps/cert-prep-desktop/src-tauri/src/constants.rs`. Bump them together; `tools/capture-runtime-version-check.mts` fails on any mismatch. Regenerate `libs/cert-prep-api` after contract changes.
- `@gx-capture/*` packages come from GitHub Packages, which needs a token even for public packages (`packages: read` plus `NODE_AUTH_TOKEN` in workflows).
- The Capture producer dispatches `.github/workflows/capture-candidate-gate.yml` during a release. Before that, pre-run `tools/capture-candidate-gate.mts` locally against the downloaded release candidate, following `.agents/GUIDES/release-runbook.md` in the sibling `capture-workbench` checkout. Keep the gate's `pnpm/action-setup` pin identical to `ci.yml`.
- Open Capture consumer work is in `.agents/TODOS/capture-runtime-consumer.md` and `.agents/TODOS/cert-prep-pdf-image-acceptance.md`. Handwriting OCR quality is a known 0.4.2 limitation.

# Testing

- CI (`ci.yml`) runs the same checks on PR and main in two parallel jobs: platform-neutral lint and tests once on Linux; packaging, the Capture Runtime install, and the Tauri host on Windows. `release-alpha.yml` reruns them on the exact release source and adds the real-backend E2E and the built-binary stack check.
- `package-qa-test` and `phase1-evidence-test` list their test files explicitly: add every new `apps/cert-prep-desktop/scripts/**/*.test.mts` to one of them, or it never runs.
- The real OCR acceptance (a scanned JPEG and PDF on the packaged app) is `cert-prep-desktop:acceptance-real`; its spec header lists the journey and inputs.
- Tests must not leave temporary files. Node test targets load `apps/cert-prep-desktop/scripts/package-qa/canonical-test-temp.mts` with `--import`, which gives each process a private temp root removed on exit; pytest uses `tmp_path_retention_policy = "failed"` (passed tests' dirs are removed; only failed ones from the last 3 sessions stay). Never use `"none"`: it disables pytest's session lock, so concurrent pytest runs delete each other's temp dirs.
