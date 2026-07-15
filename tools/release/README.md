# Public unsigned Alpha release tooling

The release workflow is intentionally fail-closed. Before dispatching it, configure:

- a **public** GitHub repository and repository Actions variables confirming the public-alpha decision;
- protected `alpha-release` and `alpha-hardware` environments with required reviewers;
- an online self-hosted Windows x64 runner labeled `cert-prep-alpha-hardware`;
- `ALPHA_HARDWARE_HARNESS` in the hardware environment, pointing to an absolute, provisioned harness path, plus its reviewed `ALPHA_HARDWARE_HARNESS_SHA256`;
- an absolute provisioned `ALPHA_FFPROBE_PATH` and reviewed `ALPHA_FFPROBE_SHA256` in the hardware environment;
- the publisher's recorded FastFlowLM terms/attribution decision.

For tag-triggered releases, set these repository variables to the literal value `true`:

- `ALPHA_PUBLIC_REPOSITORY_CONFIRMED`
- `ALPHA_RELEASE_ENVIRONMENT_PROTECTED`
- `ALPHA_FASTFLOW_TERMS_CONFIRMED`
- `ALPHA_HARDWARE_RUNNER_READY`

The candidate ID covers both publishable release files and the exact release
harness scripts. The hardware harness executable is separately pinned by SHA-256. It
receives the downloaded candidate root, candidate ID, version, tag, commit SHA,
harness SHA-256, and output root. It must echo those identities in
`hardware-result.json` and create the referenced WebM recording. The verifier requires exactly four PDFs, WindowsML OCR, FastFlowLM
`qwen3.5:4b` without provider/model fallback, per-PDF usable and Full Exam
questions, generation readiness/resource release, restart persistence, and zero
process residue. Cancellation evidence is granular: upload, OCR, draft,
runtime, model, cancel-vs-complete race, crash recovery, partial-data cleanup,
and owned-process release must each have its own candidate-bound JSON report,
byte count, and SHA-256. Acceptance and recording timestamps bind the recording
to the completed run. The verifier executes the pinned `ffprobe` and requires a
playable Matroska/WebM container, VP8/VP9/AV1 video stream, positive dimensions,
duration, and decoded frame count. It writes `recording-probe.json`; the
finalizer revalidates and publishes only the declared evidence files.

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

To run the real forced-Ollama fallback lane against that same installed local
candidate, keep the six environment bindings printed by the install harness:
`CERT_PREP_RESILIENCE_CANDIDATE_ROOT`, `CERT_PREP_RELEASE_CANDIDATE_ID`,
`ALPHA_HARDWARE_HARNESS_SHA256`, `CERT_PREP_RESILIENCE_INSTALLED_EXE_PATH`,
`CERT_PREP_RESILIENCE_INSTALL_RECEIPT_PATH`, and
`CERT_PREP_RESILIENCE_ACCEPTANCE_RUN_ID`. Also set these run-specific values:

```powershell
$env:CERT_PREP_RESILIENCE_PDF_PATH = '<absolute canonical PDF path>'
$env:CERT_PREP_RESILIENCE_OUTPUT_ROOT = '<workspace>\tmp\cert-prep-desktop\packaged-streaming-ollama-fallback-local\<new-run>'
$env:CERT_PREP_RESILIENCE_CDP_PORT = '9691'
pnpm nx run cert-prep-desktop:local-ollama-fallback-acceptance-nsis --skip-nx-cache
```

The target launches the receipt-bound installed executable without rebuilding
it, propagates the verified local OCR profile, and revalidates the candidate,
receipt, installer, and executable after the run. It atomically emits
`local-ollama-fallback-evidence.json`, binding the acceptance checks and
provider/model/resource-release attribution to the candidate and hashed run
artifacts. Local evidence does not close a public release gate.

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
