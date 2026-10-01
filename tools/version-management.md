# Scoped version management

Capture adoption and the Cert product release are independent version domains.

- `tools/capture-runtime-version.json` owns the adopted Capture release. Existing TypeScript tooling imports its facade, Rust embeds it during compilation, and Python packaging/CI read the same source. Installed Python code uses the packaged SDK's constant; package and contract checks still compare actual artifacts with adoption intent.
- `apps/cert-prep-desktop/src-tauri/tauri.conf.json` owns Cert's product alpha release. QA reads it. Python packaging reads its own native pyproject mirror. Protocol/schema versions, document schema hashes, historical Phase 1 identity and third-party dependencies have separate ownership.

Use the existing desktop Nx project, without manually replacing version text:

```powershell
pnpm nx run cert-prep-desktop:version-plan --args="--version 0.4.5"
pnpm nx run cert-prep-desktop:version-apply --args="--version 0.4.5"
pnpm nx run cert-prep-desktop:version-check

pnpm nx run cert-prep-desktop:version-plan --args="--scope product --version 0.1.0-alpha.2"
pnpm nx run cert-prep-desktop:version-apply --args="--scope product --version 0.1.0-alpha.2"
pnpm nx run cert-prep-desktop:version-check --scope product
```

`plan` and `check` never write. `apply` validates every declared field before writing any file and rejects missing/duplicate owners, invalid versions, escaped workspace paths and a source changed since planning. It edits only the shared owner and named native declaration fields. An unchanged version is a no-op. The tool does not search/replace the repository.

An apply result is **source-prepared**, not a synchronized release. Resolve npm, Python and Cargo lockfiles using their package managers and the exact published/candidate artifacts. Run `cert-prep-backend:generate-openapi-client` with the adopted Python SDK. No lock checksum, generated contract, source hash or historical evidence is rewritten by the updater. `version-check` verifies declarations, installed npm versions and contract bytes/digests through the existing strict consumer inventory; candidate identity gates and installed acceptance remain separate. Product check reuses `assertWorkspaceVersions` and explicitly retains package-manager lock/release verification as pending.

`cert-prep-desktop:version-management-test` rehearses an alternate version in an isolated temporary workspace and tests scope, no-op, read-only checks, duplicate owners, stale plans and rejection of a wrong installed SDK. These tests also run in `capture-runtime-consumer-test`.

Current checked-in versions remain Capture 0.4.4 and Cert 0.1.0-alpha.1. Existing schemas and lockfiles are unchanged by this reference refactor.
