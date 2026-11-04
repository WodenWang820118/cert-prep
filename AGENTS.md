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

- Cert Prep's Capture adoption pin is `tools/capture-runtime-version.json`; `tools/capture-runtime-version.mts` is its shared facade. Use `cert-prep-desktop:version-plan` / `version-apply` / `version-check` for adoption changes; native dependency manifests are explicit mirrors. Rust embeds the JSON pin at build time; Python runtime uses the installed SDK constant and packaging verifies the adoption pin. Refresh package-manager locks and regenerate `libs/cert-prep-api` with the adopted SDK before `version-check` can pass. See `tools/version-management.md`; product alpha versions use the separate `--scope product`.
- `@gx-capture/*` packages come from GitHub Packages, which needs a token even for public packages (`packages: read` plus `NODE_AUTH_TOKEN` in workflows).
- The Capture producer dispatches `.github/workflows/capture-candidate-gate.yml` during a release. Before that, pre-run `tools/capture-candidate-gate.mts` locally against the downloaded release candidate, following `.agents/GUIDES/release-runbook.md` in the sibling `capture-workbench` checkout. Keep the gate's `pnpm/action-setup` pin identical to `ci.yml`.
- The Capture consumer contract is `.agents/SPECS/domains/capture-runtime-integration.md`. Open work is indexed in `.agents/TODOS/README.md`. Handwriting OCR quality is a known Capture Runtime limitation.

# Dead code

- Dead code is gated as a ratchet. `tools/quality/dead-code-baseline.json` lists the known findings of knip (TypeScript; `knip.json`), vulture (backend, contracts and ollama `src`) and every Rust `#[allow(dead_code)]`. `pnpm run dead-code:check` fails only on new findings. CI runs it with `--ci`, which also fails when a baseline entry is gone, so run `pnpm run dead-code:update` after deleting dead code. `production` and `python` entries mean only tests still use that code.
- In `knip.json`, keep production (`!`) and non-production project globs disjoint; an overlap silently drops those files from the production pass.
- When a design is replaced, delete the old path, its config, CI and release steps, and its docs in the same change. Do not keep it "for compatibility" unless a named consumer still needs it. When a tool cannot see a real use (a CLI entry, a framework callback), add a `knip.json` entry or a vulture decorator ignore in `tools/dead-code-gate.mts`; never add new dead code to the baseline. Rust code only tests use goes under `#[cfg(test)]`, not behind `allow(dead_code)`.
- `.claude/settings.json` runs the check as a Claude Code Stop hook before a turn that changed code ends.

# Architecture

- `docs/architecture/` holds generated diagrams of today's dependencies (Nx projects, backend contexts, UI modules); the hand-written context map in `.agents/PLANS/ddd-refactor/README.md` is the target, and the difference is the DDD work left. Never edit the generated files: run `pnpm run architecture:update` after changing dependencies; CI's `portable-quality` job fails when they are stale (`architecture:check`). The levels are in `architecture-graph.config.json`.
- The rules live in the `[tool.importlinter]` contracts of `apps/cert-prep-backend/pyproject.toml` (`cert-prep-backend:lint-architecture`), `sheriff.config.ts` (UI modules, run by `cert-prep:lint`) and the `depConstraints` of `@nx/enforce-module-boundaries` in `eslint.config.mts` (Nx tags). Decisions are in `.agents/PLANS/ddd-refactor/`.
- Known exceptions (`ignore_imports`, ESLint disables or bulk suppressions of the Nx and Sheriff rules) are a ratchet in `tools/quality/architecture-exceptions-baseline.json`: a new one fails; fix the import instead. After removing one, run `pnpm run architecture-exceptions:update` (CI runs the gate with `--ci`).
- Every pull request description carries an architecture section between `<!-- architecture:start -->` and `<!-- architecture:end -->`: `.github/workflows/architecture-diff.yml` rewrites it on each push with the touched nodes, their direct dependencies and the dependency edges the PR adds or removes. Write your own text outside the markers.
- The tools are copied from capture-workbench (`tools/architecture-graph.ts` there); change them in all three repos together. The Stop hook also runs `node tools/architecture-graph.mts --hook`: the diagram check and the exception gate, plus the backend's import-linter contracts when backend Python or `pyproject.toml` changed.

# Testing

- CI (`ci.yml`) runs the same checks on PR and main in two parallel jobs: platform-neutral lint and tests once on Linux; packaging, the Capture Runtime install, and the Tauri host on Windows. `release-alpha.yml` reruns them on the exact release source and adds the built-binary stack check; `validate_only` stops before anything is reserved or published.
- `package-qa-test` and `phase1-evidence-test` list their test files explicitly: add every new `apps/cert-prep-desktop/scripts/**/*.test.mts` to one of them, or it never runs.
- The real OCR acceptance (a scanned JPEG and PDF on the packaged app) is `cert-prep-desktop:acceptance-real`; its spec header lists the journey and inputs.
- Tests must not leave temporary files. Node test targets load `apps/cert-prep-desktop/scripts/package-qa/canonical-test-temp.mts` with `--import`, which gives each process a private temp root removed on exit; pytest uses `tmp_path_retention_policy = "failed"` (passed tests' dirs are removed; only failed ones from the last 3 sessions stay). Never use `"none"`: it disables pytest's session lock, so concurrent pytest runs delete each other's temp dirs.
