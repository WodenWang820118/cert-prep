# Parsing And Reasoning Domain

## Purpose

This domain owns the WindowsML OCR execution policy, OCR-to-question pipeline,
Ollama reasoning policy, runtime/model health, editable question generation,
operation recovery, and the backend-to-UI status contract for packaged desktop
flows.

## Current Source Of Truth

- Commit `1b9d631` owns the current runtime behavior and regression tests:
  WindowsML prefers DML and falls back once to CPU, while Ollama uses one fixed
  model/profile and keeps CPU execution separate from provider/model selection.
- Commit `b5f63f5` owns the simplified Alpha release boundary. Parsing and
  reasoning do not have a separate accelerator-specific protected release gate.
- Older local candidate, benchmark, and resilience runs remain diagnostic
  history. They do not override the current code, tests, or active release TODO.

## Current Product Lane

- OCR provider: `windowsml`.
- OCR implementation owner: `packages/cert-prep-ocr-windowsml`.
- OCR runtime artifact kind: `windowsml_ocr`.
- OCR runtime process: `cert-prep-ocr-windowsml-runtime.exe`.
- Preferred OCR execution provider: `DmlExecutionProvider`, with
  `CPUExecutionProvider` required for explicit recovery.
- Reasoning provider: `ollama`. The fake provider is a test seam, not a product
  fallback.
- Raw reasoning model: `qwen3.5:4b`.
- Fixed study profile: `qwen3.5-4b-study-8k`, materialized locally as
  `cert-prep-qwen3.5-4b-study-8k` from `qwen3.5:4b` with `num_ctx=8192`.
- `auto` provider preference resolves to Ollama. `auto` profile selection
  resolves to the same fixed study profile on every machine.

The supported product catalog contains no alternate provider, model, or
profile fallback.

## WindowsML OCR Execution Contract

1. Runtime health first requires the WindowsML ONNX Runtime, PaddleOCR 3.7,
   bundled model files, and `CPUExecutionProvider`. Missing prerequisites are
   visible unavailable states; they are not reported as CPU fallback.
2. When DML is available, the runtime resolves the configured AMD/DXGI adapter
   and creates the PaddleOCR/ONNX Runtime session with providers ordered as
   `DmlExecutionProvider`, then `CPUExecutionProvider`.
3. A missing DML provider or failed AMD/DXGI adapter selection switches the
   runner to CPU before inference and records a non-empty warning reason.
4. If DML session/pipeline initialization or prediction fails, the runner
   discards the DML pipeline, creates a CPU-only pipeline, and retries that
   operation exactly once.
5. The one-retry guard is runner-scoped. A failed CPU retry propagates that CPU
   failure as terminal; it never loops and never returns a false success.
6. A successful CPU recovery returns `device="cpu"` plus a non-empty
   `fallback_reason`. The runtime logs the acceleration warning once per
   provider instance.

The backend worker pool retains an observed CPU recovery from prewarm or real
page extraction. Subsequent `GET /ocr/health` responses remain consistent with
that observation instead of reverting to an earlier DML-ready snapshot.

## CPU Status Contract

| Layer | OCR state | Reasoning state |
| --- | --- | --- |
| Runtime | `device="cpu"` and a non-empty `fallback_reason` | `execution_mode="cpu"`, a non-empty `execution_warning`, and `num_gpu=0` |
| Backend health | `available=true`, `selected_device="cpu"`, and the warning in `detail`/`fallback_reason` | Preserves `execution_mode` and `execution_warning`; provider/model `fallback_reason` remains null |
| Angular | Shows `WindowsML OCR · 使用 CPU 中` as a warning | Shows `Reasoning model: <model> · 使用 CPU 中` as a warning |

The Angular CPU label is shown only for an available runtime. Runtime/model
unavailability and failed OCR recovery take precedence and remain visible as
missing, offline, or failed states; stale CPU copy must not mask them.

## Fixed Ollama Model And Profile Contract

- `Settings.ollama_model` accepts only `qwen3.5:4b`.
- The profile catalog contains only `qwen3.5-4b-study-8k`. Its Modelfile is
  deterministic, starts from `qwen3.5:4b`, and declares an 8192-token context
  window.
- Request-specific smaller context limits used by fast-first streaming are
  latency bounds inside the same profile. They do not select another profile
  or model.
- Low or incomplete machine inventory produces requirement warnings but never
  changes the selected profile. Removed or unknown profile IDs fail validation.
- `fallback_profiles` and `fallback_models` are empty. Successful generation
  uses Ollama and either the fixed local profile alias or the same raw 4B model;
  `fallback_reason` remains null.
- An installed unrelated model is never selected when the configured model is
  missing or fails.
- Runtime and model installation remain explicit, confirmation-gated actions.
  Health checks and generation do not silently start a model pull.
- Missing Ollama, an unreachable Ollama API, or a missing fixed model stays a
  visible unavailable/missing state. The UI offers model installation only for
  the actual missing-model condition.
- A generation exception is recorded as a visible skipped-unavailable or
  failed/error terminal operation, depending on the owning automatic/manual
  flow. The same job never switches provider, model, or profile.

## Execution Policy Is Separate From Provider And Model Selection

Ollama execution mode answers where the fixed model may run; it does not choose
a different provider or model.

- On Windows, a generic confirmed GPU signal keeps `execution_mode="auto"`.
- If Windows accelerator inventory is missing, failed, or contains no GPU, the
  backend selects `execution_mode="cpu"`, emits a warning, and sends
  `num_gpu=0` to Ollama.
- Both modes keep the same Ollama provider and fixed 4B/8K profile.
- CPU execution populates `execution_warning`, not provider/model
  `fallback_reason`.
- `GET /llm/health` may preserve CPU execution metadata while unavailable, but
  Angular displays the CPU label only when `available=true`; otherwise it shows
  the runtime/model error.

For successful generation, configured/effective attribution records Ollama and
the fixed model/profile identity. The local profile alias is profile
materialization, not model fallback.

## Pipeline Contract

1. The desktop/backend starts OCR only when an upload requires parsing.
2. WindowsML emits page/chunk progress and persists the selected device plus any
   CPU recovery reason.
3. Reasoning waits for OCR completion, then checks Ollama runtime and fixed-model
   health.
4. A blocked health check records a visible terminal state and does not install
   or pull anything implicitly.
5. A healthy provider generates grounded editable questions through the
   streaming draft workflow.
6. Draft inserts, effective attribution, and job success commit atomically.
7. Reasoning releases provider resources after terminal work. The owned OCR
   provider pool may be reused between documents and closes its workers during
   backend shutdown.

The local-first queue remains SQLite-backed with bounded local workers. No
external message broker is required.

## Source Preparation And Image OCR Contract

- `POST /projects/{project_id}/documents` accepts PDF, PNG, JPEG/JPG, and static
  WebP. Actual bytes determine the source format; multipart MIME and filename
  extension are hints only.
- The existing 20 MB upload limit remains. Images also enforce
  `CERT_PREP_MAX_IMAGE_PIXELS`, defaulting to 50,000,000 pixels.
- Image preparation fully decodes on `asyncio.to_thread`. Empty, corrupt,
  zero-sized, oversized, multi-frame/animated, decompression-bomb, and
  unsupported sources fail through the existing 422 `validation_error` envelope.
- BMP, GIF, TIFF, SVG, HEIC/HEIF, animated PNG, and animated WebP are outside
  the accepted source set.
- Preparation applies EXIF orientation, composites transparency onto white,
  converts to RGB, and supplies every OCR provider with normalized PNG bytes.
- Original bytes, filename, and SHA-256 remain the persistence identity. The
  private source-file suffix comes from trusted content rather than metadata.
- A static image bypasses PDF rendering and calls OCR as one page. It reports
  page 1 of 1, creates the existing page-1 chunk when text exists, and reaches
  `no_text_detected` when OCR returns no text.
- Retry re-reads the stored source, verifies its SHA-256, detects the format,
  and repeats image normalization before OCR. Existing stored `.pdf` records do
  not require migration.

## Attribution And Error Semantics

- Draft job `provider` and `model` fields retain configured intent.
- `effective_provider`, `effective_model`, and `fallback_reason` record the
  actual successful generation attribution.
- Post-job health is readiness evidence, not generation proof.
- Invalid JSON, ungrounded content, invalid choices, or conflicting answers do
  not create playable questions.
- Multi-item reasoning may make at most one supplemental logical pass to fill a
  short but otherwise valid result. This is a second prompt to the same fixed
  model, not a model retry or fallback.
- A `limit=1` fast-first request remains one model call for latency.
- Reasoning output is optional enrichment. Failure must not block OCR, manual
  editing, practice, or review of already usable questions.

## Recovery And Cancellation

- Upload/OCR, automatic draft, manual draft, runtime-install, and model-install
  operations persist their lifecycle state.
- Long work follows
  `queued -> running -> cancel_requested -> canceled`; terminal states are
  irreversible.
- Non-cancellable commit phases are persisted and reported honestly. A later
  cancel receives the durable conflict instead of pretending cancellation.
- OCR cancellation retains the source file for Retry, removes partial OCR
  output, and suppresses automatic draft enqueue.
- Polling retries transient failures after 1, 2, and 4 seconds. Exhaustion stops
  indefinite progress and exposes an actionable Retry state.
- Stale responses cannot overwrite a newer cancel or retry operation.
- Owned runtime/model/helper processes are terminated by process tree; unrelated
  processes are not cleanup targets.

## Package And Provider Ownership

- `packages/cert-prep-ocr-windowsml` owns reusable WindowsML OCR runtime code
  under the `cert_prep_ocr_windowsml` import root.
- Backend integrations consume the package directly; legacy backend OCR shims
  are unsupported.
- Backend `ocr-windowsml-*` Nx targets remain stable entrypoints and invoke the
  package modules with `python -m`.
- The WindowsML package must not import `cert_prep_backend`.
- PyInstaller packages the WindowsML import root and excludes unrelated OCR
  providers.
- The provider-neutral reasoning port, lazy provider factory, selection result,
  health payload, and generation attribution remain extension seams. A future
  product provider requires an explicit adapter and policy change; it cannot
  appear as an implicit fallback.

Stable backend status and onboarding APIs include:

- `GET /ocr/health`
- `GET /llm/health`
- `GET /llm/provider-selection`
- `GET /llm/profiles`
- `GET /llm/profile-selection`
- `POST /llm/model-downloads`
- `GET /llm/model-downloads/{job_id}`
- `DELETE /llm/model-downloads/{job_id}`

## Editable Questions And Source-Document Upload

- Generated and manual records are immediately editable/playable when they pass
  the shared playable predicate; the old approval-only flow stays retired.
- Full Exam, Random Quiz, review, and packaged summaries use the same definition
  of a playable question: valid stem, distinct visible choices, and an answer.
- Multi-document import remains a client-side bounded batch over
  `POST /projects/{project_id}/documents`, with default concurrency 2 and a
  supported configuration range of 1 through 4.
- Each successful document independently runs OCR and reasoning. Failed files
  remain visible for retry, successful files stay in the project library, and
  the latest successful upload becomes active.
- One document's reasoning failure must not remove other successful documents or
  their usable questions.

## Release Boundary

- The Alpha workflow consumes these behaviors through the current Nx-owned unit,
  integration, real-backend, package-QA, and desktop tests in `build-candidate`.
- The fresh-install lane verifies the packaged backend and version-pinned public
  WindowsML runtime, then launches and uninstalls the one NSIS package.
- Local packaged streaming and resilience targets remain useful diagnostics;
  they are not a separate public release acceptance lane.
- Active release work is owned by `.agents/TODOS/alpha-launch-readiness.md` and
  the runtime-packaging domain. This domain must not recreate a device-specific
  performance gate.

## Retired Surfaces

Do not use or recreate:

- standalone NPU/XDNA2 OCR providers, prepasses, runtime manifests, or product
  acceptance paths;
- legacy WindowsML device-policy proof flags or backend compatibility shims;
- alternate product reasoning transports, model lists, profile catalogs, or
  automatic provider/model switching;
- approval-only question workflow code;
- a separate device-specific release evidence workflow.

## Durable Verification

Behavior owners and focused regression evidence:

- WindowsML DML/CPU selection, one CPU retry, warning, and retry-failure stop:
  `packages/cert-prep-ocr-windowsml/tests/test_runtime.py`.
- Backend prewarm/extraction CPU observation and health propagation:
  `apps/cert-prep-backend/tests/test_ocr_external_windowsml_runtime.py`.
- Fixed profile catalog, deterministic 8K Modelfile, CPU policy, and no profile
  fallback: `packages/cert-prep-ollama/tests/test_profiles.py`.
- Fixed model validation, provider selection, unavailable/error behavior, and no
  generation-time model switch:
  `apps/cert-prep-backend/tests/test_llm_provider_settings.py` and
  `apps/cert-prep-backend/tests/test_ollama_provider.py`.
- Frontend CPU and unavailable-state copy:
  `apps/cert-prep/src/app/components/model-health/model-health.component.spec.ts`.
- Source content detection, defensive image decoding, normalization, storage,
  Retry, page-one OCR/chunks, cancellation, and draft isolation:
  `apps/cert-prep-backend/tests/test_source_preparation.py` and the document
  upload/OCR/async/cancellation suites.
- Mixed source batches and real-backend static PNG behavior:
  `apps/cert-prep-e2e/src/example.spec.ts` and
  `apps/cert-prep-e2e/src/real-backend/real-backend.spec.ts`.
- Packaged WindowsML image acceptance, including deterministic raw SHA-256,
  `amd_windowsml:0`, page 1 of 1, zero chunks, and process cleanup:
  `pnpm nx run cert-prep-desktop:packaged-image-upload-smoke --skip-nx-cache`.
- The release `cert-prep-desktop:package-qa` target also completed and produced
  its installer/resource report. The report retains the existing
  `blocked_pending_clean_install` release status until separate installer-content
  and fresh-install verification run.

Primary Nx verification commands:

- `pnpm nx run cert-prep-ocr-windowsml:lint`
- `pnpm nx run cert-prep-ocr-windowsml:test`
- `pnpm nx run cert-prep-ollama:lint`
- `pnpm nx run cert-prep-ollama:test`
- `pnpm nx run cert-prep-backend:lint`
- `pnpm nx run cert-prep-backend:test`
- `pnpm nx run cert-prep-backend:streaming-cli-test`
- `pnpm nx run cert-prep:lint`
- `pnpm nx run cert-prep:test`
- `pnpm nx run cert-prep-desktop:typecheck-scripts`
- `pnpm nx run cert-prep-desktop:package-qa-test`
- Optional local packaged diagnostic:
  `pnpm nx run cert-prep-desktop:packaged-streaming-production-windowsml --skip-nx-cache`
