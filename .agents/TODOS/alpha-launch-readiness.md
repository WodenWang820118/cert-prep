# Public Alpha Launch Readiness TODO

Target: public unsigned Windows 11 x64 alpha `0.1.0-alpha.1`, tag
`cert-prep-v0.1.0-alpha.1`.

Checkpoint: 2026-07-14. Checked items are committed local milestones; unchecked
items remain required Public Alpha gates. The original worktree checkpoint was
main HEAD `9313e7e`; the local implementation commits now end at `9f87f31`.
Completed local implementation evidence belongs in
`.agents/SPECS/domains/runtime-packaging.md` and
`.agents/SPECS/domains/parsing-reasoning.md`. Dirty worktree changes, ignored
candidate clones, placeholder URLs, and schema-only evidence validators do not
count as completed Alpha gates.

## Phase 3 — Finish And Commit Resilience Owners

- [x] Finish, verify, and commit the remaining long-task cancellation surfaces
      (`175ea89`):
  - automatic and manual draft-operation GET/DELETE flows, including atomic
    draft insert plus terminal job state;
  - runtime and model-install DELETE flows, persisted
    `cancel_requested/canceled` recovery, and honest `phase/cancellable` state;
  - Tauri-owned helper PID/process-tree tracking and cancellation cleanup;
    this owner was already committed at the original checkpoint and its 23
    Cargo tests were re-run after the phase commits;
  - OpenAPI-first contract changes and regenerated TypeScript client, with no
    hand edits to generated output.
    Verify: `pnpm nx run cert-prep-backend:test --skip-nx-cache`,
    `pnpm nx run cert-prep:test --skip-nx-cache`,
    `pnpm nx run cert-prep-desktop:cargo-test --skip-nx-cache`, and
    `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`.

- [x] Implement, verify, and commit the fail-closed schema-v2 resilience
      contracts, validators, and scenario primitives (`59aa070`). This local
      milestone covers all nine evidence schemas plus separately hashed session
      restart evidence; it is not installed-app acceptance evidence.

- [ ] Execute the installed-app packaged resilience lanes and produce
      candidate-bound JSON for `upload`, `ocr`,
      `draft`, `runtime`, `model`, `cancelVsCompleteRace`, `crashRecovery`,
      `partialDataRemoved`, and `ownedProcessesReleased`.
  - [x] Implement and locally verify
    `cert-prep-desktop:packaged-document-cancellation-windowsml` (`9f87f31`).
    Its fail-closed runner can produce only the five document-level files
    `upload`, `ocr`, `cancelVsCompleteRace`, `crashRecovery`, and
    `partialDataRemoved`. It has not been run against the exact installed
    candidate, so this parent gate remains open.
  - Complete the pending packaged OCR lane for
    `cancel -> cancel_requested -> canceled -> same-document Retry -> ready`.
    Bind every action and terminal state to the exact authenticated
    project/document/operation response; global body-text matches are not
    acceptable evidence.
  - Prove canceled OCR removes partial chunks and derived metrics while keeping
    the original PDF retryable, uses a distinct retry operation ID, and cannot
    publish late data after cancellation wins.
  - Cover upload-before-document-ID cancellation, draft/runtime/model cancel,
    non-cancellable commit phases, app crash/restart recovery, and zero owned
    process residue after final close.
  - Cover practice-session restart after one answer, explicit Resume,
    completion, and a second restart; `sessionRestartPassed` must be backed by
    real evidence rather than a bare boolean.
    Verify: run `cert-prep-desktop:packaged-document-cancellation-windowsml`
    against the exact installed candidate plus the remaining packaged
    resilience lanes, then validate the nine
    per-check evidence files through `cert-prep-desktop:release-tool-test`.

## Phase 4 — Land CI And Real Integration Coverage

- [x] Implement, locally verify, and commit the Windows CI definition and
      no-route real-backend Playwright project (`bfb7ca6`).
  - The committed CI must pin Node 24, pnpm `10.33.2`, Python 3.12/uv, and Rust
    stable, use `pnpm nx`, and run contracts/OCR/backend/frontend tests,
    desktop script typecheck, Cargo tests, and package-QA tests on Windows.
  - Keep mock E2E as the fast UI lane, but commit a separate project that does
    not call `page.route`, starts an ephemeral backend with deterministic fake
    OCR/LLM, and covers multi-PDF, session Resume/Abandon, polling recovery,
    cancellation, and stale-response guards.
    Local verify: `pnpm nx run cert-prep-e2e:lint --skip-nx-cache` and
    `pnpm nx run cert-prep-e2e:e2e-real-backend --skip-nx-cache`.

- [ ] Obtain a successful hosted Windows CI run from committed HEAD. Local
      workflow inspection and local Nx results do not satisfy this gate.

## Phase 2 — Close Both Real Provider Acceptance Lanes

- [x] Implement, verify, and commit the real-only forced-Ollama acceptance
      target and fail-closed trigger validation (`59aa070`). The target accepts
      only declined terms or physically observed unsupported-XDNA2/old-driver
      routing and rejects overrides or fake-provider evidence.

- [ ] Run the real forced-Ollama fallback/onboarding lane against the exact
      packaged candidate. It must prove
      the unsupported-XDNA2/old-driver/declined-FastFlow route, install or use a
      real Ollama runtime, generate with `qwen3.5:4b` (or the explicit
      `qwen3.5:2b` low-resource fallback), persist exact configured/effective
      attribution and fallback reason, and release resources. Unit tests or a
      deterministic fake provider are not sufficient for this gate.

- [ ] Re-run B3 on the exact publishable XDNA2 candidate. For each of four
      acceptance PDFs, prove WindowsML/iGPU OCR, configured/effective FastFlow
      `qwen3.5:4b`, no provider/model fallback, usable questions above zero,
      and Full Exam question count above zero. Health after owned FastFlow
      shutdown may be false only when start readiness, job attribution, and
      resource-release evidence are independently present.

## Phase 0/1/4 — Provision And Execute The Public Release Chain

- [x] Implement, locally verify, and commit the remaining local release-chain
      prerequisites: packaged legal assets (`f460d19`), the explicit QA-only
      bundled-backend install switch (`346c0b7`), and isolated/offline
      WindowsML OCR build hardening (`4e1a717`). These commits do not prove a
      public OCR asset, exact candidate, hosted clean install, or release
      readiness.

- [ ] Create/configure the public GitHub repository and protected
      `alpha-release`/`alpha-hardware` environments. Pin the provisioned AMD
      harness and `ffprobe` absolute paths/digests, configure required reviewers,
      disable release-asset clobbering, and confirm the FastFlow
      free-tier/publisher/attribution terms. If the publisher cannot confirm the
      terms, intentionally rebuild as Ollama-only instead of weakening the gate.

- [ ] Publish the versioned WindowsML OCR ZIP as an anonymously downloadable,
      no-clobber prerelease asset in the real `${{ github.repository }}`. The
      current `github.com/local/cert-prep` staging URL is test-only and must not
      appear in a publishable manifest or installer.

- [ ] Rebuild one exact candidate from the public OCR URL and freeze its
      candidate ID/SHA. Regenerate and revalidate MSI, NSIS, bundled backend
      ZIP, OCR ZIP, release metadata, approved license inventory, SPDX and
      CycloneDX SBOMs, SHA256SUMS, QA reports, and provenance inputs. Reject any
      digest drift, `file://` URL, development path, unknown license, missing
      license text, or FastFlow binary inside a Cert Prep artifact.

- [ ] Run checkout-free hosted clean-install lanes for both MSI and NSIS using
      that same candidate SHA. From fresh app-data, prove bundled-backend
      extraction/startup, anonymous OCR download/resume/hash validation,
      installed-resource QA, migration startup, and complete process cleanup.

- [ ] Run the protected clean-snapshot AMD/XDNA2 hardware lane with the same
      installer SHA. It must execute the B3 checks, session restart, all nine
      cancellation/race/recovery checks, process-residue audit, and a
      candidate-bound Playwright WebM. The SHA-pinned `ffprobe` result must show
      a valid WebM/video stream, positive duration and dimensions, and decoded
      frames.

- [ ] Finalize attestations and publish only after both clean-install reports,
      protected hardware evidence, SBOM/license allowlist, no-clobber OCR asset,
      and GitHub environment approvals all pass. Release notes and
      `release-metadata.json` must say `unsigned_public_alpha`, explain the
      expected SmartScreen warning, and publish SHA-256 verification steps;
      never claim production or GA readiness.

- [ ] Merge the final evidence and decisions into the two domain specs, delete
      this TODO, and mark the release state exactly
      `Public Alpha ready with unsigned exception` only after every checkbox
      above is closed.
      Verify: successful `release-alpha.yml` execution and
      `pnpm nx run cert-prep-desktop:packaged-streaming-production-recorded-windowsml --skip-nx-cache`
      against the published candidate SHA.

The unsigned exception applies only to this public Alpha. GA remains blocked
until the backend/OCR runtime executables, main executable, MSI, and NSIS are
all Authenticode-signed.
