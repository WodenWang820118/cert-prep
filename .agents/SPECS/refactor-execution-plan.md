# Refactor Execution Plan

## Context

The active `.agents/TODOS/` backlog now has five broad refactor tracks:

- backend API and domain boundaries
- frontend component/store structure
- desktop runtime packaging and process configuration
- e2e coverage and support fixtures
- workspace metadata and shared library structure

This plan keeps the work sliced by verification boundary. Completed evidence
should move into the owning domain specs; active checklist items remain in
`.agents/TODOS/`.

## Refactor Analysis

- Task size pressure: large overall, medium per track when sliced.
- Refactoring risk: medium, with high-risk pockets around document processing,
  desktop runtime launch, and e2e workflow coverage.
- Preparatory refactor needed: yes, but only inside each track's current
  verification boundary.
- Current-scope refactor candidates:
  - remove backend import-time app construction
  - clean stale workspace metadata that does not change runtime behavior
  - fix frontend lifecycle/browser-global hygiene before component moves
  - remove duplicate desktop targets only after script/cargo gates stay green
  - extract document processing only with focused backend async tests in place
- Cleanup to avoid:
  - new shared libraries before a concrete second consumer exists
  - Alembic migration adoption without a separate persistence plan
  - broad component moves bundled with store behavior changes
  - e2e journey expansion before reusable fixtures are split
- Suggested implementation slices:
  1. Baseline plan plus low-risk hygiene for backend, frontend, and workspace.
  2. Frontend component directory/template extraction with build/test coverage.
  3. Backend document processing service extraction with async document tests.
  4. Desktop runtime environment map and duplicate target cleanup with cargo
     and package script tests.
  5. E2E support fixture/page-object extraction, then journey expansion.
  6. Shared library evaluation after repeated API/store/test contracts are
     identified from the completed slices.
- Behavior-preservation checks:
  - `pnpm nx show projects --json`
  - `pnpm nx run cert-prep:lint`
  - `pnpm nx run cert-prep:test`
  - `pnpm nx run cert-prep-backend:lint`
  - `pnpm nx run cert-prep-backend:test`
  - `pnpm nx run cert-prep-desktop:cargo-test`
  - `pnpm nx run cert-prep-desktop:package-qa-test`
- Review/checkpoint needs: self-check for slice 1; focused design review before
  backend extraction, desktop process refactor, or shared library creation.
- Decision: proceed with implementation slices, not a single broad rewrite.

## Refactor Design Review

- Repo gate: `AGENTS.md` requires `nx-workspace` first, package-manager-prefixed
  Nx commands, and no guessed Nx flags.
- Stack evidence: Angular 21 frontend, FastAPI/Python backend, Tauri/Rust
  desktop shell, Playwright e2e, Nx 22 workspace.
- Specialists used: Angular and Python guidance for the first implementation
  slice; Rust-specific changes stay limited to existing local test coverage.
- Refactor goal: reduce import side effects, stale metadata, and component
  hygiene debt while preserving current application behavior.
- SOLID lens: split when ownership differs, especially router orchestration
  versus document processing domain services; avoid interfaces or libraries
  for one local implementation.
- FP/OOP recommendation: keep Angular DI class boundaries, move pure mapping
  and validation into services/helpers only when reused; keep Python domain
  workflows as cohesive functions/services around explicit dependencies.
- Current-scope refactor: low-risk hygiene plus plan artifact.
- Cleanup to avoid: package rename or agent-file dedupe that changes external
  contributor workflow without explicit verification.
- Behavior-preservation checks: run the focused Nx gates listed above after
  each slice.
- Decision: split.

## Slice 1 Scope

- Remove `app = create_app()` from backend `main.py`.
- Keep `sidecar.py` for now because `scripts/build_sidecar.py` still uses it as
  the PyInstaller entrypoint.
- Replace direct frontend `window` reads in app/runtime config code with
  `globalThis.window` helpers.
- Convert `async ngOnInit()` to a fire-and-forget `void` lifecycle hook.
- Use `String.raw` for the root ESLint module-boundary allow regex.
- Add a route-strategy comment to the intentionally empty route table.
- Remove the stale `libs/**` workspace package pattern until a real library is
  generated.
- Rename the root package to `@cert-prep/source`.

## Deferred Decisions

- `DEFAULT_OLLAMA_MODEL` needs a separate cross-language contract decision
  because it appears in backend config, desktop runtime defaults, frontend/e2e
  test fixtures, and packaged smoke commands.
- `AGENTS.md` and `CLAUDE.md` dedupe touches agent governance. Keep both intact
  until the preferred cross-agent instruction strategy is explicit.
- Alembic adoption is a persistence roadmap decision, not a drive-by refactor.
- `libs/` creation should wait until at least one shared contract has two
  production consumers or an e2e fixture needs the same typed surface.
