# Capture Workbench consumer boundary

## Purpose

Consume the independently versioned Capture Workbench and Capture Runtime
artifacts for PDF, image, and audio capture without retaining a Cert Prep-owned
OCR/Whisper implementation.

## Contract

- Install the published, pinned `@gx-capture/capture-workbench` version matching the
  Capture Runtime release; do not use a workspace alias or retain a private UI
  fork.
- Resolve the `@gx-capture` scope through GitHub Packages with a read-only token in CI
  or an ephemeral local npm user config; never commit registry credentials.
- Tauri may start the installed Cert Prep backend after first paint. It installs
  and starts the matching `capture-runtime` sidecar only after separate explicit
  user actions. Only the backend receives the process-scoped sidecar URL and
  bearer token.
- Packaging explicitly stages the versioned `capture-runtime` release before
  resource preparation. There is no sibling checkout, workspace alias, or
  implicit development-path fallback.
- The staged manifest is pinned to Windows x64 runtime `0.3.8`, API `1.0`, and
  `CaptureDocumentV1` schema `1`; resource preparation and Tauri both verify
  the executable and schema file names, the executable's bounded integer byte
  count (`1..536870912`), SHA-256 provenance, and the canonical schema bytes
  against Cert Prep's independent pinned digest before spawning the
  executable, then repeat the
  version/schema check through the authenticated readiness handshake.
- Capture Runtime owns model asset installation and requirement validation.
  v0.3.8's empty catalog reports the WindowsML OCR and Whisper requirements as
  unavailable. Cert Prep is the host adapter for this core-only release: it
  configures `hostManagedHandshake: true` with `showRuntimeSetup: false`,
  exposes only the PDF source control, and performs the
  compatibility/capability plus source-aware requirement policy through its
  authenticated backend. v0.3.8 still shows image/audio and OCR-dependent PDF
  as unavailable; a successor model-enabled release installs OCR then Whisper
  sequentially after consent. Cert Prep does not bundle a source-built
  OCR/STT payload.
- Tauri clears the inherited environment and restores only an explicit Windows
  process-bootstrap allowlist before passing the verified host-mode Capture
  settings to the sidecar.
- Tauri passes `CERT_PREP_CAPTURE_RUNTIME_URL`,
  `CERT_PREP_CAPTURE_RUNTIME_TOKEN`,
  `CERT_PREP_CAPTURE_RUNTIME_VERSION`,
  `CERT_PREP_CAPTURE_RUNTIME_API_VERSION`, and
  `CERT_PREP_CAPTURE_DOCUMENT_SCHEMA_VERSION` only to the backend child
  process. None of these fields are added to the WebView `backend_config`.
- The backend creates and polls capture jobs, retrieves `RawCaptureV1`, applies
  the existing host structuring adapter, and submits the candidate back to the
  sidecar for strict validation.
- Runtime requirements and installation jobs are proxied through authenticated
  `/capture-runtime/*` backend routes. The browser uses the Cert Prep token;
  the Capture Runtime token remains process-only.
- Only a sidecar-validated `CaptureDocumentV1` may become a completed document.
  Raw extraction is diagnostic-only and never triggers UI completion.
- The existing document upload URL, SQLite rows, operation polling, chunks,
  crop behavior, and historical documents remain stable.
- The component continues to expose width, height, density, colors, labels,
  enabled sources, progress, cancel, JSON output, and text projection.
- The component is configured with `structuringMode: 'host'` and
  `hostStructuringOwner: 'client'`, `hostManagedHandshake: true`, and
  `showRuntimeSetup: false`, with `enabledSources: ['pdf']`;
  it polls the Cert Prep client while the backend invokes the existing provider
  and enforces the capture admission contract. No raw payload or provider seam
  is required in the WebView.

## Boundaries

- Capture Workbench owns source sniffing, PDF rendering, image normalization,
  capture runtime requirements, capture job state, and canonical validation.
  Its v0.3.8 release is core-only and has no downloadable WindowsML OCR or
  Whisper engine bundle. An all-pages embedded-text PDF remains a real
  no-model sidecar path with `pdf-embedded-text` provenance; image, audio, and
  a PDF page requiring OCR remain unavailable and must fail closed.
- Cert Prep retains its reasoning Ollama process, study profile, question
  generation, semantic explanation, and real-time Q&A.
- Cert Prep must not launch the Workbench isolated Ollama in host mode. The
  isolated Workbench Ollama exists only for standalone development and clean
  installation verification.
- The Capture sidecar is launched with `CAPTURE_STRUCTURING_PROVIDER=host`, a
  unique 256-bit bearer token, and an ephemeral loopback port. Its child
  environment allowlists only Windows bootstrap variables before injecting
  verified Capture settings; inherited Cert Prep/Ollama credentials,
  model-store settings, proxies, and cloud credentials are absent. Shutdown
  targets only the two recorded backend/sidecar PID trees rather than process
  image names.
- Host-only readiness advertises only `structuringModes: ["host"]`; its setup
  contract exposes only WindowsML and Whisper requirements and rejects Ollama
  runtime/model installation requests. The Cert Prep adapter checks the
  sidecar's runtime/API/schema/host capability before each job and calls no
  create API when it is incompatible. It admits image only with ready WindowsML
  and audio only with ready Whisper; every PDF is delegated to the runtime
  without browser scanned-PDF classification, so an OCR-dependent PDF's
  terminal sidecar failure must be clear to the user. Tauri aligns the sidecar
  upload, PDF page, and image-pixel ceilings with the existing Cert Prep source
  limits.
- Browser code never receives the sidecar bearer token and never invokes the
  reasoning provider directly.
- Cert Prep capture OCR, capture Whisper, local runtime installation, and the
  local UI prototype are retired. No production compatibility shim or
  dual-provider fallback is allowed.

## Acceptance

- Runtime/client major and schema handshake rejects incompatible artifacts.
- Provider output that changes digest, raw text, locators, coverage, or order
  reaches terminal `failed/structuring`; `/result` remains unavailable while
  `/raw` is diagnostic-only.
- Existing documents, crop uploads, retries, cancellation, chunks, study
  generation, semantic explanations, and real-time Q&A pass regression tests.
- A true all-pages embedded-text PDF completes through the published v0.3.8
  sidecar, review, host persistence, and export with `pdf-embedded-text`
  provenance; it is not OCR evidence.
- Image, audio, and any OCR-dependent PDF fail closed with an explicit
  unavailable-model error when v0.3.8 lacks the required runtime asset. The
  browser never receives the sidecar token and Cert Prep provides no OCR/STT
  fallback.
- A process isolation test proves Capture Workbench sidecar resources never
  terminate or mutate the Cert Prep reasoning Ollama process/model store.
