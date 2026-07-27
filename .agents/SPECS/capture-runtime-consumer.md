# Capture Runtime Release Consumer Spec

## Purpose

讓 cert-prep 以與線上發布一致的 release-artifact 流程取得並使用
`capture-runtime@0.3.0` Windows x64 sidecar，並以 authenticated host-mode
capture smoke 證明 backend 可實際消費下載後的 runtime。

## Non-Goals

- 不新增 npm package、Python wheel dependency 或 workspace link。
- 不在 build/prepare 階段自動發起網路下載。
- 不新增 Capture Runtime HTTP endpoint 或 CaptureDocument schema 欄位。
- 不把 fake extraction/structuring smoke 當作 WindowsML/Whisper 真實引擎證據。

## Interfaces

- `CERT_PREP_CAPTURE_RUNTIME_RELEASE_BASE_URL`: version-addressed release base URL.
- `CERT_PREP_CAPTURE_RUNTIME_ROOT`: optional staging root override for isolated tests.
- `pnpm nx run cert-prep-desktop:install-capture-runtime`: explicit installer target.
- Installer downloads exactly the executable, checksum, manifest, and schema artifacts.
- Default staging root is `tmp/cert-prep/capture-runtime/0.3.0`.

## Key Decisions

- Pin runtime `0.3.0`, API `1.0`, and CaptureDocument schema `1`.
- Permit HTTP only for `127.0.0.1`; non-loopback release URLs must use HTTPS.
- Reject redirects, unexpected files, digest/byte drift, and placeholder WindowsML
  descriptors in the production consumer path.
- Same-version identical staging is reusable; same-version mismatch fails closed.
- Tauri continues to own the sidecar process and keeps its bearer token out of
  the WebView and backend logs.

## Edge Cases and Failure Modes

- Missing or malformed base URL.
- HTTP response errors, redirects, partial downloads, and connection failures.
- Manifest version/platform/file-name/schema drift.
- Executable, checksum, or schema tampering.
- Existing staging with different bytes.
- Runtime exits before readiness or returns an incompatible handshake.
- Mirror, runtime, and consumer process cleanup after success or failure.

## Acceptance Criteria

- A local versioned HTTP mirror installs the four artifacts into a temporary
  consumer without workspace, symlink, or `file:` resolution.
- The downloaded executable passes authenticated readiness.
- cert-prep's existing `CaptureRuntimeClient` and coordinator complete a fake
  extraction plus host structuring run and return a validated document.
- Every listed tamper and URL-policy case is rejected.
- No runtime, mirror, consumer process, or temporary install remains afterward.

## Test Plan

- Node installer contract tests for validation, idempotency, URL policy, and cleanup.
- Desktop package-QA and Rust contract regressions after the version pin update.
- Backend existing test target plus an actual-sidecar Python consumer flow.
- Nx local release consumer smoke using a loopback mirror backed by the sibling
  capture-workbench release directory.
