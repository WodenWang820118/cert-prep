# Public unsigned Alpha release tooling

The public Alpha is built from one exact commit and one immutable candidate.
The source of truth is
[`.github/workflows/release-alpha.yml`](../../.github/workflows/release-alpha.yml),
the release tools in this directory, and the Nx targets in
[`apps/cert-prep-desktop/project.json`](../../apps/cert-prep-desktop/project.json).

## Required GitHub configuration

Before running the workflow, configure:

- a public GitHub repository;
- `ALPHA_EXPECTED_REPOSITORY` with the reviewed, exact `OWNER/REPO` identity;
- an `alpha-release` environment with the intended reviewers;
- default-branch protection and a protected `cert-prep-v*` tag/ruleset.

For a manual dispatch, provide an Alpha SemVer such as `0.1.0-alpha.1` and
confirm both the public repository and protected release environment inputs.
For a `cert-prep-v*-alpha.*` tag trigger, set these repository variables to the
literal value `true`:

- `ALPHA_PUBLIC_REPOSITORY_CONFIRMED`
- `ALPHA_RELEASE_ENVIRONMENT_PROTECTED`

The workflow rejects a repository mismatch, a non-public repository, a manual
dispatch from the wrong source ref, a tag/version mismatch, or a release commit
that is not an ancestor of the default branch. Runs for the same canonical tag
are serialized.

All Windows validation uses GitHub-hosted `windows-2025`. Publication and
failure cleanup use GitHub-hosted `ubuntu-24.04`. No separately provisioned
runner or machine-specific release input is required.

## Workflow

The workflow has one linear release path plus failure cleanup:

```text
build-candidate -> clean-install -> publish-alpha
incomplete prerelease + failed gate -> cleanup-incomplete-prerelease
```

### `build-candidate`

This job checks out the exact release source once and performs all source and
package validation before creating an artifact. It:

- validates release identity, repository visibility, tag/version, and commit;
- runs the Windows-owned lint and test targets through Nx;
- runs desktop script type-checking, package-QA tests, release-tool tests, and
  Rust host tests;
- runs the real-backend browser smoke once;
- builds and validates one unsigned NSIS installer;
- inventories Node, backend Python, OCR Python, OCR payload, and Rust
  dependencies;
- creates SPDX documents, the license inventory, license texts, notices, and
  `SHA256SUMS`;
- uploads one candidate containing both the publishable files and the exact
  release scripts used by downstream jobs.

The candidate ID is derived from the sorted file identities and SHA-256
digests. Downstream jobs verify that ID and download this artifact without a
source checkout or rebuild.

### `clean-install`

This hosted Windows job first reserves the candidate-bound public prerelease.
It uploads or reuses exactly the version-pinned WindowsML OCR ZIP and manifest;
an existing asset is reusable only when its SHA-256 digest is identical. Assets
are never overwritten.

The NSIS installer bundles the backend runtime but not the OCR ZIP. Its installed
OCR manifest points to the public release URL and pins the expected file name,
byte count, and SHA-256. The clean-install script then:

1. verifies every downloaded candidate file and the expected commit;
2. installs the single NSIS package silently;
3. validates the installed backend and OCR runtime manifests;
4. downloads the public OCR ZIP and verifies its bytes and SHA-256;
5. launches the installed app with fresh app data;
6. requires the owned backend to report matching packaged health and runtime
   versions;
7. stops the owned processes and uninstalls the app;
8. confirms the uninstall registration, installed executable, and installation
   root are all gone.

Evidence is written only after every step, including uninstall, succeeds. The
finalizer accepts exactly one `clean-install-nsis.json` report bound to the
candidate, commit, installer digest, and verified lifecycle fields.

### `publish-alpha`

This job downloads the same candidate and clean-install evidence. It finalizes
the candidate-bound release metadata and checksum inventory, then uploads all
assets without replacing a different asset and keeps the release marked as a
public unsigned prerelease.

After publication, `publish-assets.ts --mode verify-public` downloads every
declared public file without an authorization header. It requires unique asset
basenames and verifies the exact byte count and SHA-256 of the NSIS installer,
WindowsML OCR files, SPDX documents, license inventory and texts, notices,
release metadata, evidence, and `SHA256SUMS`. The job fails if any declared file
is missing, extra, private, or changed.

### `cleanup-incomplete-prerelease`

The OCR bootstrap release records a publication owner made from the workflow
run, attempt, and candidate ID. If a later pre-finalization gate fails, cleanup
may delete only an incomplete prerelease owned by that same run. It rejects a
different owner, commit, candidate, or already-finalized release, and it never
deletes the source tag.

## Release artifact contract

The public release contains:

- one versioned unsigned NSIS setup executable;
- the bundled backend ZIP and manifest;
- the remotely published, version-pinned WindowsML OCR ZIP and manifest;
- combined and artifact-scoped SPDX JSON documents;
- a dependency license inventory, canonical license texts, project license,
  privacy notice, changelog, and third-party notices;
- package-QA and clean-install evidence;
- candidate-bound release plan and final release metadata;
- one `SHA256SUMS` entry for every other public file.

Release file basenames must be unique because GitHub release assets are flat.
The final publisher revalidates candidate immutability, the artifact inventory,
the checksum manifest, and the sanitized NSIS evidence before upload.

Run the two release contract suites locally through Nx:

```powershell
pnpm nx run cert-prep-desktop:package-qa-test
pnpm nx run cert-prep-desktop:release-tool-test
```

The workflow uses the repository-pinned Node 24 runtime to execute the native
`.ts` release scripts directly.

## Local diagnostic candidates

Local candidate and resilience targets are diagnostic tools. They are not jobs
in the public release workflow, do not publish assets, and cannot satisfy or
replace `clean-install`.

Build a local candidate only from an isolated clean worktree:

```powershell
pnpm nx run cert-prep-desktop:local-candidate-windowsml --skip-nx-cache
```

The result is permanently marked `local_nonpublishable`, uses a local OCR file
URL, and is rejected by the public publisher, finalizer, and cleanup modes. The
builder also rejects a dirty source tree, linked inputs, identity drift, and an
existing output path.

To diagnose the current-user install path, first ensure Cert Prep is neither
installed nor running, then execute:

```powershell
pnpm nx run cert-prep-desktop:local-install-acceptance-nsis --skip-nx-cache
```

That target installs the local candidate and emits the candidate/run/install
bindings required by the optional packaged resilience targets. It intentionally
leaves the diagnostic installation in place; reruns fail until that local state
is handled explicitly.

The optional diagnostic targets are:

```powershell
pnpm nx run cert-prep-desktop:packaged-document-cancellation-windowsml --skip-nx-cache
pnpm nx run cert-prep-desktop:packaged-remaining-resilience-windowsml --skip-nx-cache
pnpm nx run cert-prep-desktop:local-resilience-evidence-verify --skip-nx-cache
```

They require the exact environment bindings emitted by local install
acceptance. Their evidence remains local and has no effect on public release
status.
