# Public unsigned Alpha release tooling

The release workflow is intentionally fail-closed. Before dispatching it, configure:

- a **public** GitHub repository and repository Actions variables confirming the public-alpha decision;
- `ALPHA_EXPECTED_REPOSITORY` set to the independently reviewed, exact
  `OWNER/REPO` identity used for this release;
- protected `alpha-release` and `alpha-hardware` environments with required reviewers;
- default-branch protection plus a protected `cert-prep-v*` tag/ruleset; manual
  dispatches must originate from the default branch, and tag-triggered commits
  must be ancestors of that branch; manual and tag invocations for the same
  canonical tag are serialized;
- an online self-hosted Windows x64 runner labeled `cert-prep-alpha-hardware`;
- `ALPHA_HARDWARE_HARNESS` in the hardware environment, pointing to an
  absolute, directly invocable provisioned script/executable, plus its reviewed
  `ALPHA_HARDWARE_HARNESS_SHA256`. The workflow rejects reparse points, rehashes
  immediately before invocation, and fails on a failed PowerShell invocation
  or nonzero process exit;
- `ALPHA_ACCEPTANCE_PDF_DIR` in the hardware environment, pointing to an
  absolute directory containing
  `alpha-acceptance-pdf-manifest.json` and exactly the four PDFs it declares.
  The directory entry itself and the manifest must not be reparse points, and
  no PDF may be missing, renamed, duplicated, byte-drifted, digest-drifted, or
  joined by an extra PDF;
- exactly one `ffprobe` application on the protected runner's `PATH`, plus its
  independently reviewed `ALPHA_FFPROBE_SHA256` in the hardware environment.
  The runner baseline owns installation; the workflow derives the absolute
  non-reparse path and rejects any executable whose digest differs from the
  approved value;
- an Ollama installation/model provisioned by the hardware harness.

For tag-triggered releases, set these repository variables to the literal value `true`:

- `ALPHA_PUBLIC_REPOSITORY_CONFIRMED`
- `ALPHA_RELEASE_ENVIRONMENT_PROTECTED`
- `ALPHA_HARDWARE_RUNNER_READY`

The OCR bootstrap release contains a candidate-bound publication owner marker
made from the workflow run ID and attempt. An identical prerelease may be reused
without clobbering assets, but rollback only runs through the protected
`alpha-release` environment and only the workflow run that created that
prerelease may delete it. The workflow reserves the release and records that
owner before uploading OCR assets, so a failed upload can be withdrawn safely.
A separate candidate-bound state marker moves from `ocr-bootstrap` to
`finalized`; cleanup rejects finalized releases even if a later workflow step
fails.

The candidate ID covers both publishable release files and the exact release
harness scripts, including the reviewed acceptance PDF manifest. The hardware
harness executable remains separately pinned by its reviewed SHA-256. The
workflow derives the provisioned manifest from `ALPHA_ACCEPTANCE_PDF_DIR`,
requires it to match the candidate manifest byte for byte, copies it into
hardware evidence after the harness finishes, and passes its candidate-derived
digest to the harness and verifier so they can enumerate its four colocated
PDFs. The harness receives
the downloaded candidate root, candidate ID, version, tag, commit SHA, harness
SHA-256, manifest path and SHA-256, and output root. It must echo those
identities in `hardware-result.json` and create the referenced WebM recording.
The verifier requires the manifest's exact four PDFs, WindowsML OCR, Ollama
`qwen3.5:4b` without provider/model fallback, per-PDF usable and Full Exam
questions, generation readiness/resource release, restart persistence, and zero
process residue. Cancellation evidence is granular: upload, OCR, draft,
runtime, model, cancel-vs-complete race, crash recovery, partial-data cleanup,
and owned-process release must each have its own candidate-bound JSON report,
byte count, and SHA-256. Acceptance and recording timestamps bind the recording
to the completed run. A preflight requires exactly one protected-runner
`ffprobe` on `PATH`, checks it against `ALPHA_FFPROBE_SHA256`, and passes the
resolved path and approved hash to the verifier. The verifier rehashes it and
requires a playable Matroska/WebM container, VP8/VP9/AV1 video stream, positive
dimensions, duration, and decoded frame count. It writes
`recording-probe.json`; the finalizer revalidates and publishes only the
declared evidence files.

This transition reduces the protected hardware lane from six configured
machine inputs to four: the external harness path, its reviewed SHA-256, the
acceptance PDF directory, and the reviewed `ffprobe` SHA-256. The external
harness remains required because the candidate does not yet contain the full
hardware evidence producer, Playwright runtime, and packaged-flow/resilience
script graph. Moving that producer into the candidate is the next
simplification phase; it must not be treated as complete until equivalent
contract tests and a protected hardware run pass.

Run the release-tool tests through the workspace task graph:

```powershell
pnpm nx run cert-prep-desktop:release-tool-test
```

The JavaScript release tools are native `.ts` ESM scripts executed directly by
the repository-pinned Node 24 runtime; no transpiler or compatibility wrapper
is part of the release harness.

## Local nonpublishable acceptance candidate

Installed-app and hardware acceptance may be exercised before GitHub release
infrastructure is available. Build that candidate only from an isolated clean
worktree at the commit under test:

```powershell
pnpm nx run cert-prep-desktop:local-candidate-windowsml --skip-nx-cache
```

The target deliberately uses the development WindowsML resource layout so the
OCR ZIP remains a canonical local `file:` dependency. Its release plan,
package-QA report, SBOM namespace, and candidate identity are permanently
marked `local_nonpublishable`. The publisher, cleanup command, and finalizer
reject this profile even if it is paired with a separate public-looking plan.
The command also refuses a dirty checkout, symbolic-link inputs, an OCR URL
that does not resolve to the declared ZIP, or an existing output path. It
assembles and validates under a temporary same-volume directory before
atomically renaming the candidate to `tmp/local-alpha-candidate`.

Keep the isolated worktree and its OCR runtime ZIP in place while running the
installed-app acceptance lanes. Passing local acceptance does not satisfy or
close any public candidate, hosted clean-install, or GitHub publication gate.

Before running resilience against the local candidate, verify that Cert Prep
is not installed or running on the machine. The candidate-pinned harness can
check its candidate, exact workspace HEAD, registry, process, and install-root
preconditions without starting the installer:

```powershell
node tmp/local-alpha-candidate/harness/tools/release/local-install-acceptance.ts `
  --workspace-root . `
  --candidate-root tmp/local-alpha-candidate `
  --output-root tmp/cert-prep-desktop/local-install-acceptance `
  --dry-run true
```

Run the real current-user NSIS install acceptance through Nx:

```powershell
pnpm nx run cert-prep-desktop:local-install-acceptance-nsis --skip-nx-cache
```

The harness installs silently into its new isolated output root, verifies the
HKCU uninstall registration and installed executable, and atomically writes a
schema-v1 `install-receipt.json`. Its JSON output provides the exact candidate,
acceptance-run, harness, executable, and receipt environment bindings required
by both packaged resilience targets. A successful install is intentionally
preserved for those targets; the harness never uninstalls it. Reruns fail
closed until the existing Cert Prep installation state is handled explicitly.

After the packaged resilience targets finish with the same six candidate and
install bindings, verify their combined local evidence set through Nx:

```powershell
$env:CERT_PREP_RESILIENCE_DOCUMENT_OUTPUT_ROOT = '<absolute document-cancellation output root>'
$env:CERT_PREP_RESILIENCE_REMAINING_OUTPUT_ROOT = '<absolute remaining-resilience output root>'
pnpm nx run cert-prep-desktop:local-resilience-evidence-verify --skip-nx-cache
```

The verifier accepts only a `local_nonpublishable` candidate. It rejects an
incomplete or extra file set, candidate/run/install-receipt drift, and binding
changes during verification. On success it prints the byte count and SHA-256
for all nine cancellation files plus `session-restart.json`; it does not write
a hardware result, recording, release artifact, or other public-gate evidence.

The workflow publishes the OCR ZIP/manifest first as a public mutable prerelease so clean
runners can download it anonymously. Existing assets are reused only when their SHA-256
digest matches; assets are never clobbered. Final installers remain withheld until both
clean-install lanes, protected hardware evidence, SBOM/license gates, and GitHub provenance
attestation succeed.

Candidate assembly inventories the backend and isolated WindowsML OCR Python
environments separately, filtered against the actual modules inside each
PyInstaller executable, and explicitly includes the pinned PyInstaller bootloader
distribution. A separate collector verifies the OCR ZIP exact entry set and records
individual hashes for both ONNX models, both model configs, the recognition
dictionary, and `pipeline.json`. Those payload hashes are included in the scoped
SPDX and CycloneDX documents. It copies deduplicated dependency license texts under
`legal/licenses/texts` and blocks when a shipped dependency has neither a
primary text nor a text-backed fallback for every term in its SPDX expression.
SPDX expressions are also checked against an explicit reviewed license and
exception allowlist; merely well-formed unknown identifiers are rejected.
It emits separate SPDX and CycloneDX documents for the MSI, NSIS, bundled
backend ZIP, and remote WindowsML OCR ZIP. Each document contains explicit
artifact-to-component dependency relationships; the combined inventory remains
available for license review.

The checkout-free clean-install lane starts the installed app with a dedicated
QA-only environment switch. This exercises the real Rust bundled-runtime
installer in fresh app-data, then discovers the owned loopback backend process
and requires matching packaged `/health` before the lane can pass. Normal app
launch does not set this switch and still requires explicit user action. Final
assembly parses both MSI and NSIS reports and rechecks candidate identity,
installer digest, runtime versions, fresh app-data, OCR download, and packaged
backend health before marking clean install passed.
