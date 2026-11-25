# Cert Prep Real-Engine Dev-Server Journey

## Purpose

`cert-prep-e2e:smoke-real-engines-dev-server` proves Cert Prep's integration
with the pinned Capture Runtime release on the dev server: the Angular app and
the backend in dev mode, headless Chromium, and the published runtime. Real text recognition,
speech recognition and Cert-owned Ollama each run, and each phase passes only
when the designed device, the device the product reports, and the device
observed on the machine agree.

The target is manual and local. It is not part of `pnpm ci:local` or GitHub
CI. `cert-prep-e2e:real-engines-unit-test` covers the pure parsing and verdict
only.

The packaged app alone proves the Tauri host, sidecar launch through the
launcher crate, WebView2, installer contents, and exit cleanup of an installed
build. This journey does not.

## Inputs

- `CERT_PREP_REAL_ENGINES_ROOT`: short absolute directory outside the
  workspace, such as `C:\cpl1`. The run tree is `<root>/run-<UTC timestamp>`
  and is kept. Delete it by hand.
- `CERT_PREP_REAL_ENGINES_PDF`, `CERT_PREP_REAL_ENGINES_IMAGE`,
  `CERT_PREP_REAL_ENGINES_RECORDING`: the scanned PDF, the image and the
  recording. Each has `<file>.expected.json` beside it:
  `{"schemaVersion": 1, "rawTextIncludes": ["...", ...]}`. Anchors are
  verbatim and stay private. Comparison uses one normalization: NFKC, then
  collapsed whitespace.
- `CERT_PREP_REAL_ENGINES_SPEECH_MODEL`: optional. Default `tea-asr-1.1-mini`.
- `CERT_PREP_REAL_ENGINES_OLLAMA_MODELS`: optional models directory to reuse.
  When omitted, the run tree holds the models.
- `CAPTURE_ENGINE_CACHE_DIR`: optional absolute cache passed through to the
  runtime.
- Ollama must already be installed (`ollama.exe` on `PATH` or in the user
  install). The journey does not install system software. Cert starts its own
  `ollama serve`.

Tokens exist only in child environments and the browser's local storage. The
report, logs and Playwright output do not contain tokens, recognized text,
anchors, file names or questions. Every token the run creates is registered
for redaction before a child starts.

Children do not inherit ambient `CAPTURE_*`, `OLLAMA_*` or `CERT_PREP_*`
variables, or `GITHUB_PACKAGES_TOKEN`. `CAPTURE_ENGINE_CACHE_DIR` is the one
inherited exception. Explicit settings are applied after that filter.

## What each phase proves

1. Provision. Cert `/health` is ok. `/capture-runtime/ready` matches the
   pinned runtime version, API 2.0 and schema 2. A dedicated NVIDIA adapter is
   listed. Device preference stays `auto`. `text-recognition`,
   `speech-recognition` and the Ollama model install with consent. Once
   `text-recognition` is installed, the GPU `ocrCompute` preflight (which the
   runtime reports only then) names a dedicated or integrated adapter; that
   class is the reported value, and the designed class comes from the adapter
   list. A project is created.
2. PDF, then image, through the `/capture` page file input. Every anchor is
   in the normalized raw text. The review is confirmed in the UI. `/result`
   reports engine `text-recognition` and device `directml`. The source is
   stored with chunks. Samples cover OCR only, until the review heading.
3. Recording through the `/questions` upload. The source-language select is
   set to `auto` before upload (the page default is `ja`). The source becomes
   `ready`, chunk text contains every anchor, `effective_transcription_model`
   is the speech model, and `transcription_device` is `cuda`.
4. Question generation on the stored PDF source with `hybrid_reasoning` and
   limit 3. The job succeeds, `generated_count` is greater than 0,
   `effective_provider` is `ollama`, and there is no fallback. `/llm/health`
   before generation checks that Cert owns the server. After generation,
   ownership is still `owned` and verification is `verified` on CUDA.

Designed devices: DirectML OCR uses the dedicated adapter when `adapters.json`
lists one, and the integrated adapter otherwise. `ocrCompute.adapterClass` is
only the reported value. The phase passes only when designed, reported and
observed agree. Speech is `cuda` on the dedicated NVIDIA GPU. Ollama preference
`auto` runs on the dedicated NVIDIA GPU (CUDA). A phase without enough busy
samples is `not observed` and does not pass. Workers are unloaded between
phases (`CAPTURE_OCR_WORKER_IDLE_SECONDS=0` and
`CAPTURE_SPEECH_WORKER_IDLE_SECONDS=0`) so one engine uses the GPU at a time.
The device sampler stops if the phase has not written its stop file by the
longest phase budget plus a margin, and writes `timed-out` in the sample
directory.

## Decisions

- The orchestrator is `apps/cert-prep-e2e/src/real-engines/run.mts`, run with
  Node's type stripping. The typechecked journey does not import `.mts`; it
  calls `devices.mts` as a CLI. Nothing is imported from `tmp/`.
- The backend serve command hardcodes `--port 8765`. The orchestrator appends
  `--args=--port=<free>` and expects uvicorn to keep the later port. The
  Angular dev server is bound to `127.0.0.1` on its own free port.
- `CAPTURE_ALLOWED_ORIGINS` is empty, matching the existing consumer smoke.
  `CAPTURE_EXTRACTION_PROVIDER=runtime` and `CAPTURE_SPEECH_PREFER_GPU=true`
  are set so extraction stays on the runtime and CUDA is attempted.
- Install and Capture job timeouts are 3600 seconds, and the Ollama request
  timeout is 900 seconds, above the code defaults, because the first model
  load can exceed those defaults.
- `NX_DAEMON=false` so this run does not leave a shared Nx daemon. Child
  `TEMP` and `TMP` point at the run tree. The smoke does not use the desktop
  canonical temp import, because that import deletes its temp directory on
  exit. The unit test does use it.
- Playwright traces, video and screenshots are off. The run tree is kept and
  marked with `kept-run-tree.json`. Cleanup kills a child only while Node
  still records it as running and the live process creation time matches the
  time recorded at spawn. The descendant walk keeps a process only when its
  creation time is after its parent's, so a recycled PID is not killed.
  Cleanup then checks that the runtime, backend, frontend and Ollama ports
  no longer accept a connection.
- `taskkill`, `where.exe`, the owned-process and worker-exit scripts,
  `nvidia-smi -L`, the adapter list and the devices verdict each run with a
  15 or 30 second timeout. A timeout fails that command with a clear message.

## Rejected alternatives

- Importing Capture's journey or sampler from `tmp/`: those files are a
  reference, not a Cert dependency.
- Installing Ollama, the GPU runtime or other system software from this
  target.
- Registering the journey as `e2e`, `test` or a `ci:local` step.
- Treating a phase with no busy samples as a pass.
- Requiring `/llm/health` verification `verified` before question generation.
  Verification stays `pending` until a runner has loaded a model.

## Acceptance criteria

- Missing inputs, a missing Ollama install, a runtime pin mismatch or an
  empty adapter list fails before engines are used, or with a failed report
  once the run tree exists.
- Each of provision, PDF OCR, image OCR, speech and question generation is
  recorded with duration, and OCR and speech also record anchor counts
  (found / expected). Device phases record designed, reported and observed.
- The run passes only when every phase passes, Playwright exits 0, and every
  cleanup check passes.
- The report and Playwright output contain no recognized text, anchors, file
  names, questions or tokens.
- The kept run path is the only line printed on success.

## Test plan

- `cert-prep-e2e:real-engines-unit-test` for LUID formatting, adapter class,
  the designed OCR adapter, sample parsing, the verdict, the creation-time
  check that allows a kill, the child-environment filter, anchor
  normalization, redaction, the backend port argument and the kept-run marker.
- `cert-prep-e2e:smoke-real-engines-dev-server` when the short root, the three
  fixtures and their anchor files are available, on a Windows machine with a
  dedicated NVIDIA GPU and Ollama already installed.

## Non-goals

- No Tauri window, launcher-crate sidecar, WebView2 check, installer-content
  check, or packaged-app exit cleanup. Those stay on the desktop acceptance
  and package QA targets.
- No change to Capture, the published runtime, or `pnpm ci:local`.
- No claim that a unit-test pass is a real-engine pass.
