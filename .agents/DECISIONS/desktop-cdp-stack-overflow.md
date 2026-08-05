# Desktop CDP Stack-Overflow Diagnosis Decision

## 2026-08-02

- Treat `0xC00000FD` (Rust `thread 'main' has overflowed its stack`) as a
  native desktop release blocker independent of Capture Runtime readiness. The
  `capture-runtime@0.3.8` core-only state may legitimately show capture setup
  as unavailable, but it does not explain away a process-level stack overflow.
- Do not attribute the crash to NSIS, the runtime sidecar, or
  `page.setViewportSize` without a controlled failure test. The installed
  probe connected to WebView CDP before the harness observed the closed page;
  therefore its `page.setViewportSize` error is downstream evidence, not the
  established root cause.
- Diagnose with the same fresh, isolated app-data layout for both the NSIS
  installed executable and the loose release executable. For each binary,
  establish three ordered phases: no CDP argument, CDP connect without
  viewport mutation, and CDP connect with the existing viewport mutation.
- First add a deterministic probe/report seam and failure-classification tests.
  The report must identify the executable and resource hashes, phase reached,
  exit code, redacted launch environment, and only processes owned by the run.
  It must never persist a sidecar bearer token.
- The `cert-prep-desktop` Windows binary reserves `8 MiB` via its bin-scoped
  linker argument. This is accepted as bounded startup-overflow containment
  because the PE parser proved the red `1 MiB` baseline and green `8 MiB`
  candidate, while the same fresh candidate completed three no-CDP/CDP/viewport
  cold starts for both loose and freshly installed NSIS executables without an
  overflow, forced termination, or owned-process residue.
- That containment evidence does not identify a symbolized recursion or prove
  that stack reserve is the unique root cause. Symbolized native evidence is
  not a prerequisite for this bounded mitigation, but is required before any
  further stack increase, broader startup change, or recurrence investigation.
- The separate Capture Trial UI gate is closed by a fresh NSIS-installed run
  that completed explicit Python install, Capture Runtime install/start, the
  embedded-text PDF review/persistence/export flow, relaunch persistence, and
  both normal-close residue checks. This is core-only PDF evidence, not OCR/STT
  evidence.

## Decision trigger for a code fix

A further production change beyond the bounded `8 MiB` containment requires:

1. a fresh failing probe with an explicit phase and `0xC00000FD`/overflow
   classification; and
2. process, executable/resource, and, when needed, WER/minidump evidence that
   narrows the native cause.

Do not increase the reserve again merely to delay a recurrence.
