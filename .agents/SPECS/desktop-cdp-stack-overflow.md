# Desktop NSIS/CDP Stack-Overflow Containment Spec

## Purpose

Find and prevent the native Rust-main-thread stack overflow observed when the
packaged-flow Playwright/CDP harness starts Cert Prep Desktop. This is a
startup reliability investigation, not a Capture Runtime feature change.

## Observed evidence and current reproduction

The installed probe at
`tmp/cert-prep-desktop/installed-core-only-probe/2026-08-02T02-01-02-019Z`
recorded:

- `app.stderr.log`: `thread 'main' (1960) has overflowed its stack`;
- `run.log`: application exit code `3221225725` (`0xC00000FD`); and
- `metrics.json`: CDP had connected, then
  `page.setViewportSize` found that its page/context/browser was already
  closed. The harness reported no remaining owned process after closeout.

The failure was also reported for the loose release executable, but the
existing artifact above proves only the installed run. The comparison remains a
required test, not an assumption. Both executable forms must be checked with a
new unique `--out-dir` and `--app-data-dir` on every run.

Current installed reproduction (replace `<run-id>` and use an uncreated output
directory):

```powershell
node apps/cert-prep-desktop/scripts/packaged-flow-smoke.mts `
  --exe 'tmp/cert-prep-desktop/manual-install-acceptance/installed/cert-prep-desktop.exe' `
  --pdf 'pdfs/【1】2025年07月N1 真题.pdf' `
  --out-dir 'tmp/cert-prep-desktop/installed-cdp-probe/<run-id>' `
  --app-data-dir 'tmp/cert-prep-desktop/installed-cdp-probe/<run-id>/app-data' `
  --cdp-port 9494 `
  --llm-provider fake
```

Use the same command with the loose release executable at
`apps/cert-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/cert-prep-desktop.exe`.
The future probe must also exercise a direct launch with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` unset, then a CDP attach without a
viewport operation, before it runs the existing viewport path.

## Scope and non-goals

In scope:

- a narrow, testable desktop startup probe or launch-plan seam;
- typed classification of normal exit, `0xC00000FD`, Rust stack-overflow
  stderr, CDP-connect failure, and post-connect page failure;
- redacted process/PE/resource evidence for NSIS and loose release binaries;
- a real fresh-NSIS-install packaged E2E proof through Capture Trial UI and
  owned-process cleanup.

Out of scope:

- changing Capture Runtime requirements, adding OCR/STT engines, or treating
  v0.3.8 core-only availability as a crash workaround;
- widening host persistence or logging sidecar bearer tokens;
- increasing the Rust stack again without new failure, PE, matrix, and native
  cause evidence.

## Bounded containment evidence (2026-08-02)

The baseline fresh build and fresh NSIS install both had a PE
`SizeOfStackReserve` of `1,048,576` bytes. For loose and installed binaries,
no-CDP, CDP-attach, and CDP-viewport all exited with `0xC00000FD` and the Rust
main-thread overflow line; every baseline closeout reported zero owned residue.

The candidate applies `/STACK:8388608` only to the `cert-prep-desktop` Windows
binary. The built-binary PE test proved `8,388,608` bytes. The same candidate
then completed three cold starts of every phase (nine runs) for both its loose
binary and a freshly installed NSIS binary, with zero failures, forced
terminations, and owned-process residue.

This proves bounded containment for the observed startup failure. It does not
prove a symbolized recursion or establish stack reserve as the unique root
cause. A symbolized dump is not required to retain this mitigation, but it is
required before raising the reserve again or making a wider native-startup
change.

## Required implementation order

1. Add unit tests around a pure failure classifier and launch-phase plan using
   fake process results. The failure fixture must classify exit code
   `3221225725` and the exact Rust overflow line, and it must demonstrate that
   a later `page.setViewportSize` closed-page error cannot overwrite that root
   classification.
2. Add the minimal probe/report implementation to run the ordered matrix for a
   supplied executable. Persist: run id, binary path/SHA-256/size, capture
   resource identities, phase reached, exit code, relevant redacted environment
   names/values, timestamps, and owned process PID/image-path evidence. Record
   only token presence, never token value.
3. Run the matrix against fresh NSIS and loose release binaries using the same
   product build and fresh isolated app data. Preserve phase, PE, process, and
   closeout evidence. The 2026-08-02 baseline proved the failure without CDP;
   the candidate matrix is the required containment regression.
4. A bin-scoped stack reserve may be accepted without a symbolized recursion
   only when the PE red/green test and same-build loose/NSIS phase matrices
   prove bounded containment. A further increase or broader startup change
   requires WER/minidump or equivalent native-cause evidence and must not
   merely delay a recurrence.

## Verification and release conditions

Before a fix is accepted, run the relevant targeted tests plus:

```powershell
pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache
pnpm nx run cert-prep-desktop:package-qa --skip-nx-cache
```

The startup-containment gate is satisfied by the PE test and same-build
loose/NSIS phase matrices described above. The broader fresh-install acceptance
is also satisfied: the installed NSIS executable completed the packaged
Capture Trial embedded-text PDF journey, relaunch persistence, and both normal
closeouts with no `0xC00000FD`, Rust stack-overflow stderr, forced close, owned
process, or listener residue. This is not OCR/STT evidence.

The evidence bundle must contain the launch phase, binary/resource identities,
redacted environment, process closeout, and any native-dump reference needed
to support the selected fix.
