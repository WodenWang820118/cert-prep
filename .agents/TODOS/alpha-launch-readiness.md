# Public Alpha Launch Readiness TODO

Target: public unsigned Windows 11 x64 Alpha `0.1.0-alpha.1`, canonical tag
`cert-prep-v0.1.0-alpha.1`.

This file tracks active release work only. The executable contract is
`.github/workflows/release-alpha.yml`; operating instructions are in
`tools/release/README.md`; durable decisions and evidence belong in
`.agents/SPECS/domains/runtime-packaging.md` and
`.agents/SPECS/domains/parsing-reasoning.md`.

## Active Release Blockers

### 1. Prepare And Trigger One Canonical Run

- [ ] Merge the corrected non-empty Nx lint/test commands and their regression
      contract to `main`. Require a new exact-HEAD `ci.yml` run that shows the
      intended lint and test targets actually executed; then select that exact
      release commit and use exactly one trigger path to start
      `release-alpha.yml`. Record the workflow URL, run attempt, commit SHA,
      canonical tag, and generated candidate ID.

### 2. Accept One End-To-End Green Exact-Candidate Workflow

- [ ] Require `build-candidate`, `clean-install`, and `publish-alpha` to pass for
      that exact identity. Downstream jobs must reuse the same candidate without
      checkout or rebuild. The run must prove the fresh NSIS
      install/launch/backend-health/uninstall lifecycle and the anonymous exact
      public asset inventory, bytes, and SHA-256 verification. Do not substitute
      local or older-run evidence. If the run owns an incomplete prerelease and
      fails before finalization, its cleanup must succeed before retry, and the
      failed run's evidence must not be reused.

## Final Closeout

- [ ] Confirm that the exact workflow attempt's `publish-alpha` job and anonymous
      verifier succeeded. Record its workflow URL, identity, clean-install
      receipt, and public verification in both owning domain specs; then delete
      this TODO and record the release state as exactly
      `Public Alpha ready with unsigned exception`.
