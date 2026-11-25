# Desktop Main-Thread Stack Reserve Spec

## Purpose

Keep Cert Prep Desktop from overflowing its Rust main-thread stack at startup
(`thread 'main' has overflowed its stack`, exit `0xC00000FD`). The overflow was
observed on 2026-08-02 for both the loose release binary and the NSIS-installed
binary, with and without a CDP attach, independent of Capture Runtime readiness.

## Current contract

- `apps/cert-prep-desktop/src-tauri/build.rs` gives only the
  `cert-prep-desktop` Windows binary an 8 MiB stack reserve
  (`/STACK:8388608`). The default reserve was 1 MiB.
- `apps/cert-prep-desktop/scripts/desktop-startup-probe.mts` reads the PE
  `SizeOfStackReserve` without running the binary and classifies startup
  results (normal exit, `0xC00000FD`, Rust overflow stderr, CDP-connect failure,
  post-connect page failure) so a later `page.setViewportSize` closed-page error
  never hides the root classification. Its unit tests run in
  `cert-prep-desktop:package-qa-test`.
- `release-alpha.yml` checks the built binary's reserve
  (`desktop-startup-probe-built.test.mts`) because only a release build has the
  binary to inspect.
- Probe reports record run id, binary path/SHA-256/size, resource identities,
  phase reached, exit code, redacted environment and owned-process evidence.
  They record only token presence, never a token value.

## Decision

The 8 MiB reserve is accepted as bounded containment: the PE test proved the
1 MiB baseline and the 8 MiB candidate, and the candidate completed three cold
starts of each phase (no CDP, CDP attach, CDP with viewport change) for both
the loose and a freshly installed NSIS binary with no overflow, forced
termination or owned-process residue. It does not identify a symbolized
recursion or prove the reserve is the only cause.

Do not attribute the crash to NSIS, the sidecar or `page.setViewportSize`
without a controlled failure test.

## Trigger for a further change

Raising the reserve again or a broader native-startup change requires:

1. a fresh failing probe with an explicit phase and `0xC00000FD`/overflow
   classification; and
2. process, executable/resource and, when needed, WER/minidump evidence that
   narrows the native cause.

Do not increase the reserve merely to delay a recurrence. Every probe run uses
a new unique `--out-dir` and `--app-data-dir`.
