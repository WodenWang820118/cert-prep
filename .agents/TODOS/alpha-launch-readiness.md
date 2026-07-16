# Public Alpha Launch Readiness TODO

Target: public unsigned Windows 11 x64 alpha `0.1.0-alpha.1`, tag
`cert-prep-v0.1.0-alpha.1`.

Completed local, GitHub configuration, and hosted quality evidence is retained
in `.agents/SPECS/domains/runtime-packaging.md` and
`.agents/SPECS/domains/parsing-reasoning.md`. Dirty worktree changes, ignored
candidate clones, placeholder URLs, and schema-only validators do not count as
completed Alpha gates.

## Remaining Public Alpha Gates

Only remaining publisher-decision, public-asset, clean-install, and protected
hardware gates are listed below.

### Protected Inputs And Publisher Decision

- [ ] Provision an online clean-snapshot Windows x64 runner labeled
      `cert-prep-alpha-hardware`. In `alpha-hardware`, pin
      `ALPHA_HARDWARE_HARNESS`, `ALPHA_HARDWARE_HARNESS_SHA256`,
      `ALPHA_FFPROBE_PATH`, and `ALPHA_FFPROBE_SHA256`. Set the repository
      variable `ALPHA_HARDWARE_RUNNER_READY=true` only after the paths, digests,
      runner labels, and snapshot reset have been independently verified.

- [ ] Record the publisher's FastFlow free-tier/commercial-use and Powered by
      FastFlowLM attribution decision, then set the repository variable
      `ALPHA_FASTFLOW_TERMS_CONFIRMED=true`. If the decision cannot be
      confirmed, intentionally rebuild and release an Ollama-only Alpha
      instead.

### Exact Publishable XDNA2 Acceptance

- [ ] Re-run B3 on the exact publishable XDNA2 candidate. For each of four
      acceptance PDFs, prove WindowsML/iGPU OCR, configured/effective FastFlow
      `qwen3.5:4b`, no provider/model fallback, usable questions above zero,
      and Full Exam question count above zero. Health after owned FastFlow
      shutdown may be false only when start readiness, job attribution, and
      resource-release evidence are independently present. The current machine
      and local nonpublishable candidate cannot close this protected hardware
      gate.

### Public Assets And Release Chain

- [ ] Publish the versioned WindowsML OCR ZIP as an anonymously downloadable,
      no-clobber prerelease asset in the real `${{ github.repository }}`. The
      current `github.com/local/cert-prep` staging URL is test-only and must not
      appear in a publishable manifest or installer.

- [ ] Rebuild one exact candidate from the public OCR URL and freeze its
      candidate ID and SHA. Regenerate and revalidate MSI, NSIS, bundled backend
      ZIP, OCR ZIP, release metadata, approved license inventory, SPDX and
      CycloneDX SBOMs, SHA256SUMS, QA reports, and provenance inputs. Reject any
      digest drift, `file://` URL, development path, unknown license, missing
      license text, or FastFlow binary inside a Cert Prep artifact.

- [ ] Run checkout-free hosted clean-install lanes for both MSI and NSIS using
      that same candidate SHA. From fresh app-data, prove bundled-backend
      extraction and startup, anonymous OCR download, resume and hash
      validation, installed-resource QA, migration startup, and complete
      process cleanup.

- [ ] Run the protected clean-snapshot AMD/XDNA2 hardware lane with the same
      installer SHA. It must execute the B3 checks, session restart, all nine
      cancellation, race, and recovery checks, process-residue audit, and a
      candidate-bound Playwright WebM. The SHA-pinned `ffprobe` result must show
      a valid WebM video stream, positive duration and dimensions, and decoded
      frames.

- [ ] Finalize attestations and publish only after both clean-install reports,
      protected hardware evidence, SBOM and license allowlist, no-clobber OCR
      asset, and GitHub environment approvals all pass. Release notes and
      `release-metadata.json` must say `unsigned_public_alpha`, explain the
      expected SmartScreen warning, and publish SHA-256 verification steps;
      never claim production or GA readiness.

### Final Closeout

- [ ] Merge the final public, hosted, and protected-hardware evidence and
      decisions into the two domain specs, delete this TODO, and mark the
      release state exactly `Public Alpha ready with unsigned exception` only
      after every checkbox above is closed.
      Verify: successful `release-alpha.yml` execution and
      `pnpm nx run cert-prep-desktop:packaged-streaming-production-recorded-windowsml --skip-nx-cache`
      against the published candidate SHA.

The unsigned exception applies only to this public Alpha. GA remains blocked
until the backend and OCR runtime executables, main executable, MSI, and NSIS
are all Authenticode-signed.
