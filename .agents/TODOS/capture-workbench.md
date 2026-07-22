# Capture Workbench TODO

- [ ] Pin a published Angular package and matching Windows x64 runtime release.
- [ ] Start the capture sidecar from Tauri and pass its URL/token to the backend only.
  Native lifecycle, fail-closed executable/schema staging, authenticated
  host-only handshake, static package QA, and PID-scoped cleanup are
  implemented; packaged smoke awaits the first real `0.1.0` release artifact.
- [x] Add the backend capture coordinator and Cert Prep structuring-provider adapter.
- [x] Atomically map validated `CaptureDocumentV1` into the existing document pipeline.
- [x] Proxy Capture Runtime requirements/install/cancel through the authenticated
  backend without exposing the sidecar token to the WebView.
- [ ] Stage checksum-pinned WindowsML install assets and prove the clean-install
  setup flow with the released sidecar.
- [ ] Replace the upload UI with the published component and a host backend client.
- [ ] Prove document/crop/retry/cancel/chunk/reasoning regressions and process isolation.
- [ ] Remove the local prototype and duplicated capture OCR/Whisper/install/provider paths after parity.
- [ ] Fold this TODO into durable domain specs when cutover is complete.
