# Public Alpha Launch Readiness TODO

Target: public unsigned Windows 11 x64 alpha `0.1.0-alpha.1`, tag
`cert-prep-v0.1.0-alpha.1`.

Checkpoint: 2026-07-16. The exact local nonpublishable acceptance checkpoint
uses product and harness commit
`06db87d1e19a6e1e2e633730a69ce89f5bfb4678`, candidate ID
`5ebde8afc5e956a98daf6bdd11e31742d7bcde00c714687236260c1a5c2350a6`,
and install run
`local-install-06db87d1e19a-1fb5fa29-2a1c-4aed-94ee-17e118716a2e`.
Completed implementation and exact-run evidence is recorded in
`.agents/SPECS/domains/runtime-packaging.md` and
`.agents/SPECS/domains/parsing-reasoning.md`. Dirty worktree changes, ignored
candidate clones, placeholder URLs, and schema-only validators do not count as
completed Alpha gates.

## Closed Local Checkpoint

- [x] Complete the current-HEAD local installed-app resilience, forced-Ollama,
      combined evidence verification, owned-process cleanup, and real NSIS
      uninstall gates. The immutable local candidate remains
      `local_nonpublishable`; this checkpoint is not a public candidate,
      protected hardware result, hosted clean-install result, or release claim.

## Remaining Public Alpha Gates

GitHub, hosted, and public-asset work below is intentionally excluded from the
current local execution scope.

### Hosted Windows CI

- [ ] Obtain a successful hosted Windows CI run from committed HEAD. Local
      workflow inspection and local Nx results do not satisfy this gate.

### Exact Publishable XDNA2 Acceptance

- [ ] Re-run B3 on the exact publishable XDNA2 candidate. For each of four
      acceptance PDFs, prove WindowsML/iGPU OCR, configured/effective FastFlow
      `qwen3.5:4b`, no provider/model fallback, usable questions above zero,
      and Full Exam question count above zero. Health after owned FastFlow
      shutdown may be false only when start readiness, job attribution, and
      resource-release evidence are independently present. The current machine
      and local nonpublishable candidate cannot close this protected hardware
      gate.

### Public Repository And Release Chain

- [ ] Create and configure the public GitHub repository and protected
      `alpha-release` and `alpha-hardware` environments. Pin the provisioned AMD
      harness and `ffprobe` absolute paths and digests, configure required
      reviewers, disable release-asset clobbering, and confirm the FastFlow
      free-tier, publisher, and attribution terms. If the publisher cannot
      confirm the terms, intentionally rebuild as Ollama-only instead of
      weakening the gate.

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
