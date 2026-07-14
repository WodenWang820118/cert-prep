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
