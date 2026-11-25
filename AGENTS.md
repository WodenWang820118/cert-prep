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

# Naming

- A name says what the thing is or does. Name by function; a vendor, engine, model or technology belongs in a name only when it is exactly what the thing denotes.
- No past design, phase, slice, trial, plan id or version in identifiers, file names, routes, targets, stored values or environment variables.
- One term per concept across backend, API, generated client, UI, Desktop and docs. Terms live in `docs/domain/glossary.md` and `packages/cert-prep-contracts/vocabulary/cert-prep-vocabulary-v1.json`. At the Capture boundary use Capture's terms and map them to Cert's terms in one place.
- A name states its scope: page source or any source; backend, Capture or language-model runtime; and what a target runs against (mocked API, fixture runtime or packaged app).
- When behaviour makes a name untrue, rename it in the same PR, including environment variables and stored values. Stored values need a migration and retirement of the old vocabulary concept. A misleading name is a defect.
- Retired names do not come back: `pnpm run retired-names:check` rejects new occurrences. Add each retired name to `tools/quality/retired-names.json` in the same PR as its rename. Existing occurrences are frozen per file in `tools/quality/retired-names-baseline.json`; after removing occurrences run `pnpm run retired-names:update`. CI uses `--ci` and also rejects stale baseline entries.
- `.claude/settings.json` runs the retired-names gate as a Stop hook when the checkout has changes; local CI always runs it alongside the dead-code gate.

# Dead code

- Dead code is gated as a ratchet. `tools/quality/dead-code-baseline.json` lists the known findings of knip (TypeScript; `knip.json`), vulture (backend, contracts and ollama `src`) and every Rust `#[allow(dead_code)]`. `pnpm run dead-code:check` fails only on new findings. CI runs it with `--ci`, which also fails when a baseline entry is gone, so run `pnpm run dead-code:update` after deleting dead code. `production` and `python` entries mean only tests still use that code.
- In `knip.json`, keep production (`!`) and non-production project globs disjoint; an overlap silently drops those files from the production pass.
- When a design is replaced, delete the old path, its config, CI and release steps, and its docs in the same change. Do not keep it "for compatibility" unless a named consumer still needs it. When a tool cannot see a real use (a CLI entry, a framework callback), add a `knip.json` entry or a vulture decorator ignore in `tools/dead-code-gate.mts`; never add new dead code to the baseline. Rust code only tests use goes under `#[cfg(test)]`, not behind `allow(dead_code)`.
- `.claude/settings.json` runs the check as a Claude Code Stop hook before a turn that changed code ends.

# Code size and complexity

- ESLint, Ruff and Clippy measure hand-written production code. Thresholds and exclusions live in `tools/quality/code-complexity.json`. The baseline in `tools/quality/code-complexity-baseline.json` freezes existing findings and their measured values.
- `pnpm run code-complexity:check` runs all three tools by default and includes untracked source files. New or worsened findings fail the check. CI uses `--ci`, which also fails when a baseline entry disappears. Run `pnpm run code-complexity:update` after reducing or removing known violations. Baseline updates require all three tools.
- Local CI and `ci.yml` run the gate in the same two steps. `portable-quality` runs "Code size and complexity gate (TypeScript and Python)": the gate's unit tests, then ESLint and Ruff with `--ci --without clippy`. `windows-quality` runs "Code size and complexity gate (Rust)": Clippy with `--ci --without eslint,ruff`. GitHub CI (scheduled and dispatched) and `pnpm ci:local --all` always run Clippy there. Affected `pnpm ci:local` adds `--clippy-when-changed-since` with its selected base, normally `origin/main`: Clippy runs only when committed or working-tree changes touch Rust sources, Cargo manifests or locks, Cargo, Clippy or toolchain configuration, Tauri configuration, the Capture adoption pin, the complexity gate or policy, or `ci.yml`. Otherwise the step checks nothing and passes, and the Clippy baseline rows stay unchecked.
- Split code where responsibility and coupling justify a boundary. Use line counts to locate code to inspect and fix findings in the code. The gate measures through inline lint suppressions.
- The optional Claude Code Stop command is `node "$CLAUDE_PROJECT_DIR/tools/code-complexity-gate.mts" --hook`. It checks measured changes in the working tree or in commits ahead of upstream, with Clippy conditional on the changed inputs. A finding exits 2 and keeps the turn working. A tool or diagnostic failure exits 1 and reports the error to the user.

# Architecture

- `docs/architecture/` holds generated diagrams of today's dependencies (Nx projects, backend contexts, UI modules); the hand-written context map in `.agents/PLANS/ddd-refactor/README.md` is the target, and the difference is the DDD work left. Never edit the generated files: run `pnpm run architecture:update` after changing dependencies; CI's `portable-quality` job fails when they are stale (`architecture:check`). The levels are in `architecture-graph.config.json`.
- The rules live in the `[tool.importlinter]` contracts of `apps/cert-prep-backend/pyproject.toml` (`cert-prep-backend:lint-architecture`), `sheriff.config.ts` (UI modules, run by `cert-prep:lint`) and the `depConstraints` of `@nx/enforce-module-boundaries` in `eslint.config.mts` (Nx tags). Decisions are in `.agents/PLANS/ddd-refactor/`.
- Known exceptions (`ignore_imports`, ESLint disables or bulk suppressions of the Nx and Sheriff rules) are a ratchet in `tools/quality/architecture-exceptions-baseline.json`: a new one fails; fix the import instead. After removing one, run `pnpm run architecture-exceptions:update` (CI runs the gate with `--ci`).
- Every pull request description carries an architecture section between `<!-- architecture:start -->` and `<!-- architecture:end -->`: `.github/workflows/architecture-diff.yml` rewrites it on each push with the touched nodes, their direct dependencies and the dependency edges the PR adds or removes. Write your own text outside the markers.
- The tools are copied from capture-workbench (`tools/architecture-graph.ts` there); change them in all three repos together. The Stop hook also runs `node tools/architecture-graph.mts --hook`: the diagram check and the exception gate, plus the backend's import-linter contracts when backend Python or `pyproject.toml` changed.

# Testing

- Pull requests do not run CI on GitHub; before merging, run `pnpm ci:local` and paste the summary into the PR description. By default `pnpm ci:local` runs in affected mode against `origin/main` (including uncommitted and untracked files), running the always-on workspace gates (dead code, retired names, code size and complexity, architecture tools/diagrams/exceptions, and source Capture Runtime version declarations) plus only the lanes and setup steps affected by the change; pass `--all` to run every step, `--base=<ref>` for another base, or positional job names (`portable-quality`, `windows-quality`). Full GitHub CI (`ci.yml`) runs weekly and on dispatch in two parallel jobs: platform-neutral lint and tests once on Linux; packaging, the Capture Runtime install, and the Tauri host on Windows. `release-alpha.yml` reruns them on the exact release source and adds the built-binary stack check; `validate_only` stops before anything is reserved or published.
- `package-qa-test` explicitly lists hermetic `apps/cert-prep-desktop/scripts/**/*.test.mts` tests: add new tests there so they run. The built-binary `desktop-startup-probe-built.test.mts` check runs separately in the release workflow.
- The real OCR acceptance (a scanned JPEG and PDF on the packaged app) is `cert-prep-desktop:acceptance-real`; its spec header lists the journey and inputs.
- Tests must not leave temporary files. Node test targets load `apps/cert-prep-desktop/scripts/package-qa/canonical-test-temp.mts` with `--import`, which gives each process a private temp root removed on exit; pytest uses `tmp_path_retention_policy = "failed"` (passed tests' dirs are removed; only failed ones from the last 3 sessions stay). Never use `"none"`: it disables pytest's session lock, so concurrent pytest runs delete each other's temp dirs.
