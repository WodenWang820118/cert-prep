# Cross-Platform Runtime Nodes TODO

## Purpose

Define and implement product runtime nodes for Windows, macOS, and Linux without
blurring OCR acceleration, LLM provider selection, packaging, and evidence into
one opaque "GPU" switch.

The current Windows production lane is:

- OCR: `windowsml` external runtime through `packages/cert-prep-ocr-windowsml`
  with ONNX Runtime `DmlExecutionProvider + CPUExecutionProvider`.
- LLM: `fastflowlm` with `qwen3.5:4b` through the OpenAI-compatible local
  FastFlowLM server.
- Desktop smoke: `cert-prep-desktop:packaged-streaming-production-windowsml`
  with `--ocr-provider windowsml --llm-provider fastflowlm --llm-model qwen3.5:4b`.

This TODO is about adding the next runtime nodes cleanly, not about rewriting
the completed WindowsML or FastFlowLM evidence.

## Non-Goals

- Do not revive the retired standalone AMD NPU OCR provider.
- Do not keep backend shim/re-export paths when a runtime becomes package-owned.
- Do not auto-install runtimes or auto-download models from health checks or app
  startup.
- Do not claim "system GPU" readiness without a concrete runtime provider,
  device ID/type, and smoke evidence.
- Do not hide TensorRT under the existing Ollama or FastFlowLM provider until
  the API boundary is explicitly chosen.
- Do not revive the legacy Paddle OCR runtime manifest as the product artifact
  for the new cross-platform PaddleOCR node.
- Do not silently supersede existing runtime-packaging decisions; record when a
  node extends, replaces, or rejects a prior packaging decision.

## Current Repo Surface To Respect

- Workspace projects already include `cert-prep-ocr-windowsml`,
  `cert-prep-ollama`, `cert-prep-backend`, and `cert-prep-desktop`.
- `cert-prep-backend` still owns generic PaddleOCR CPU/GPU targets:
  `ocr-setup-cpu`, `ocr-setup-gpu`, `ocr-setup-gpu-capable`,
  `build-ocr-runtime-gpu`, and the `paddle` OCR adapter.
- `cert-prep-backend` has WindowsML targets that call package modules directly.
- `Settings.llm_provider` currently allows `fake | ollama | fastflowlm`.
- `Settings.ocr_provider` currently allows `fake | ollama | paddle | windowsml`.
- Tauri launch currently defaults to `CERT_PREP_LLM_PROVIDER=fastflowlm` and
  `CERT_PREP_OCR_PROVIDER=windowsml`, and only allows `fastflowlm | ollama` plus
  `windowsml | paddle`.
- Runtime requirement kinds currently cover `ollama`, `ollama_model`,
  `paddle_ocr`, and `windowsml_ocr`.
- `.agents/SPECS/domains/runtime-packaging.md` already owns the packaged desktop
  runtime story: downloadable runtime artifacts, manifest metadata, explicit
  user consent, Package QA v2, and script-level gates through Nx targets.
- `.agents/DECISIONS/tauri-packaging-deferred-ollama.md` already chose Windows
  x64 first, a lite backend sidecar, optional runtime artifacts, no bundled
  Ollama models, and confirmation-gated install/model jobs.
- `.agents/SPECS/domains/runtime-packaging.md` says the legacy Paddle OCR
  runtime manifest is not a packaged product artifact. A future PaddleOCR node
  must therefore be a new package-owned node, not a revival of that legacy
  manifest.
- `.agents/DECISIONS/tensorrt-api-boundary.md` and
  `.agents/SPECS/runtime-nodes.md` do not exist yet.
- Packaged flow smoke arguments currently default OCR to `windowsml`, and
  package QA constants/health fixtures are WindowsML-specific enough that node
  selection must be made explicit before any other node is called supported.

## Runtime Node Matrix

### OCR Nodes

- Windows default: keep `windowsml` for iGPU OCR with DirectML/WindowsML evidence.
- Windows generic PaddleOCR: support only as a separate `paddle` node, not as
  the default WindowsML node. Prove CUDA dGPU or CPU fallback explicitly.
- Linux PaddleOCR: start with CUDA dGPU plus CPU fallback. Treat ROCm as a
  separate candidate that needs wheel availability, smoke evidence, and package
  target proof before it can be called supported.
- macOS PaddleOCR: start as CPU fallback unless a PaddleOCR-supported Metal/MPS
  or custom-device path is proven on a real macOS target. Do not promise "use
  existing system GPU" for macOS by default.

### LLM Nodes

- `qwen3.5:4b` FastFlowLM NPU node: already specified for Windows; keep it
  OpenAI-compatible and user-started.
- `qwen3.5:4b` Ollama GPU node: keep provider `ollama`, require health to report
  configured/effective model and packaged smoke to record GPU/resource evidence.
- `qwen3.5:4b` TensorRT node: first decide the API boundary. It should become
  either a new provider such as `tensorrt`, or a documented local
  OpenAI-compatible server adapter. Do not treat it as a model-name-only option.
- `qwen3.5:9b` Ollama GPU node: add as a larger-model product node with explicit
  model override and fallback behavior.
- `qwen3.5:9b` TensorRT node: Windows candidate only until packaging, memory, and
  response-contract evidence exist.

## Grill-Me Questions And Recommended Answers

- Question: Should the product promise "use the current system GPU"?
  Recommended answer: no. Promise node-specific acceleration only after the
  runtime reports the exact provider and device, then keep CPU fallback visible.
- Question: Is TensorRT an Ollama variant or a provider?
  Recommended answer: treat it as undecided until a real local API is selected.
  If it exposes OpenAI-compatible chat completions, make it a provider sibling to
  FastFlowLM. If it is only an engine behind another server, document that server
  as the provider and TensorRT as acceleration evidence.
- Question: Should `qwen3.5:9b` use FastFlowLM NPU by default?
  Recommended answer: no. Keep FastFlowLM defaulted to the proven 4B node until
  NPU memory, latency, and quality evidence proves the 9B path.
- Question: Should Mac/Linux package GPU OCR in the first pass?
  Recommended answer: Linux CUDA can be a first GPU candidate; macOS should be
  CPU-first unless a supported PaddleOCR GPU backend is proven. Both must have
  target-specific package manifests.
- Question: Should all nodes ship in one installer?
  Recommended answer: no. Keep the main desktop installer light and publish
  runtime artifacts per OS/target/provider node.

## Claude DeepSeek Adversarial Review Write-In

`claude-deepseek` returned `shouldWriteIntoTodo: true` for this TODO. The
review confirmed that the draft has the right shape, but it needs stronger
decision gates before implementation starts.

### Confirmed Blockers

- TensorRT API boundary is a blocker for Work Package 3. Before TensorRT work
  starts, create `.agents/DECISIONS/tensorrt-api-boundary.md` and choose one:
  `llm_provider=tensorrt`, a local OpenAI-compatible adapter with TensorRT as
  accelerator evidence, or explicit deferral to a future TODO.
- Tauri provider allowlists are a Rust-level blocker. `configured_llm_provider()`
  and `configured_ocr_provider()` currently hardcode provider names and silently
  coerce unknown values back to defaults. Any new provider must first update this
  path so unsupported provider values fail visibly or are sourced from a
  provider manifest.

### Confirmed Risks

- The existing `ocr_provider=ollama` backend path is live but not part of the
  PaddleOCR/WindowsML OCR matrix. Decide whether it remains a lightweight OCR
  option, is explicitly out of scope for package extraction, or is deprecated.
- Tauri currently emits WindowsML-oriented environment variables for backend
  launch. macOS/Linux nodes must not receive meaningless WindowsML device
  settings, and `CERT_PREP_OCR_RUNTIME_MODE` defaults must be platform-aware.
- Runtime installation currently assumes a zip-manifest extraction protocol.
  Each platform node must declare its distribution protocol, such as zip
  manifest, pip wheel, conda environment, Homebrew formula, or AppImage resource.

### Needed Decisions

- macOS sidecar strategy: CPU-only PaddleOCR first, experimental Metal-backed
  lane, or defer macOS runtime nodes to a follow-up TODO.
- Linux packaging format: choose first-class Linux packaging, with AppImage as
  the current candidate and `.deb` as secondary candidate unless later evidence
  rejects that split.
- PaddleOCR package boundary: define exactly what moves into
  `packages/cert-prep-ocr-paddle`, including inference code, diagnostics, build
  runtime code, Nx setup/build targets, backend adapter behavior, and health
  integration.
- `qwen3.5:9b` fallback graph: decide whether failure falls back to `4b`, then
  `2b`, or surfaces an error immediately for OOM/timeout cases.

### Work Package Dependencies

```text
WP2 Extract PaddleOCR -> blocked by PaddleOCR package boundary decision.
WP3 LLM boundary -> blocked by TensorRT API boundary decision.
WP4 Node-aware packaging -> blocked by Tauri Rust allowlist update.
WP4 Node-aware packaging -> blocked by macOS and Linux packaging decisions.
```

## Claude GLM 5.2 Review Write-In

`claude-glm` ran a visible `glm-5.2` review log and produced concrete
repo-grounded findings worth writing into this TODO.

### Confirmed Additions

- Reference the existing runtime-packaging documents before changing node
  behavior: `.agents/SPECS/domains/runtime-packaging.md` and
  `.agents/DECISIONS/tauri-packaging-deferred-ollama.md`.
- Treat the PaddleOCR package work as a new product node. Do not reuse the
  legacy Paddle OCR runtime manifest that runtime-packaging already rejected as
  a packaged product artifact.
- Expand provider changes as a full contract update, not only a Tauri launch
  update. Any new node must update backend settings enums, Tauri allowlists,
  runtime requirement kinds, health payloads, packaged smoke arguments, and QA
  reporting together.
- Make the Tauri launch environment node-aware. `backend_launch_env()` currently
  emits `CERT_PREP_OCR_RUNTIME_MODE=external`, `CERT_PREP_OCR_DEVICE=auto`, and
  `CERT_PREP_OCR_WINDOWSML_DEVICE_ID` regardless of provider or platform.
- Tighten the WP4 wording: the confirmed WindowsML default is in packaged smoke
  arguments and WindowsML-specific package QA constants/fixtures, not merely a
  generic `ocrProvider` type.

### GLM Work Package Dependency Refinement

```text
WP1 Runtime Node Spec -> blocked by existing packaging decision reconciliation.
WP2 Extract PaddleOCR -> blocked by legacy Paddle manifest replacement policy.
WP3 LLM boundary -> blocked by backend settings enum and RuntimeRequirementKind updates.
WP4 Node-aware packaging -> blocked by packaged smoke default and QA fixture updates.
```

## Implementation Phases

### Phase 0. Decision Reconciliation And Scope Freeze

Purpose: turn the review findings into explicit implementation boundaries
before touching provider code.

Tasks:

- Create `.agents/SPECS/runtime-nodes.md` as the controlling implementation
  spec.
- Cross-reference `.agents/SPECS/domains/runtime-packaging.md`,
  `.agents/DECISIONS/tauri-packaging-deferred-ollama.md`,
  `.agents/SPECS/fastflowlm-npu-reasoning.md`,
  `.agents/DECISIONS/fastflowlm-npu-reasoning.md`,
  `.agents/SPECS/winml-package-extraction.md`, and
  `.agents/DECISIONS/winml-package-extraction.md`.
- State whether each new node extends, replaces, or rejects prior packaging
  decisions.
- Create `.agents/DECISIONS/paddleocr-package-boundary.md` and decide what
  belongs in `packages/cert-prep-ocr-paddle`.
- Create `.agents/DECISIONS/tensorrt-api-boundary.md` with either a provider
  boundary, an adapter boundary, or explicit deferral.
- Decide whether existing backend `ocr_provider=ollama` remains supported,
  deprecated, or out of scope for the first implementation pass.

Exit gate:

- No code changes are required in this phase.
- `.agents/SPECS/runtime-nodes.md`,
  `.agents/DECISIONS/paddleocr-package-boundary.md`, and
  `.agents/DECISIONS/tensorrt-api-boundary.md` exist.
- TensorRT is either deferred or has one concrete local API boundary.

### Phase 1. Runtime Node Contract Skeleton

Purpose: add the shared node vocabulary without changing runtime behavior.

Tasks:

- Add or extend shared contract types for node ID, OS, architecture, provider,
  model, accelerator, distribution protocol, install artifact, and support
  status.
- Update backend settings enums, `RuntimeRequirementKind`, health payload
  shapes, and API client generation only for nodes approved in Phase 0.
- Add tests proving unknown providers fail visibly instead of silently falling
  back where the behavior is newly controlled by shared contracts.
- Keep the current Windows default as `windowsml + fastflowlm + qwen3.5:4b`.

Exit gate:

- Contract tests pass.
- Backend tests pass with current default behavior unchanged.
- No new runtime is advertised product-ready.

Suggested verification:

- `pnpm nx run cert-prep-contracts:test`
- `pnpm nx run cert-prep-backend:test`
- `pnpm nx run cert-prep-backend:generate-openapi-client`
- `pnpm nx run cert-prep-api:lint`

### Phase 2. PaddleOCR Package Ownership

Purpose: move generic PaddleOCR out of backend ownership and make it a new
package-owned product node candidate.

Tasks:

- Create `packages/cert-prep-ocr-paddle`.
- Move generic PaddleOCR runtime code and tests into the package.
- Define the new PaddleOCR package as a fresh product node and not the legacy
  Paddle OCR runtime manifest previously rejected by runtime-packaging docs.
- Move setup/build entrypoints behind `python -m` modules. Do not leave backend
  compatibility shims for old runtime internals.
- Keep `cert-prep-ocr-windowsml` as the WindowsML-specific package.
- Retire backend-owned generic PaddleOCR runtime internals once package imports
  are stable.
- Add package-owned diagnostics for CUDA availability, GPU count, selected
  device, CPU fallback reason, and model cache/runtime artifact paths.
- Extend build targets so `build-ocr-runtime-gpu` and future Linux/macOS runtime
  builds call package modules directly with `python -m`.
- Add a runtime installer abstraction where distribution protocol is declared by
  the node instead of inherited from the current Windows x64 downloadable
  artifact path by assumption.

Exit gate:

- `paddle` can remain candidate-only until package-local diagnostics and tests
  pass.
- Backend imports generic PaddleOCR through package-owned APIs only.
- The legacy Paddle OCR runtime manifest is not used as the product artifact.

Suggested verification:

- `pnpm nx run cert-prep-ocr-paddle:test`
- `pnpm nx run cert-prep-ocr-paddle:lint`
- `pnpm nx run cert-prep-backend:test`
- `pnpm nx run cert-prep-backend:lint`

### Phase 3. LLM Node Policy And Non-TensorRT Models

Purpose: add model-node policy for Ollama/FastFlowLM before taking on TensorRT.

Tasks:

- Keep FastFlowLM defaulted to the proven `qwen3.5:4b` Windows NPU node.
- Add node metadata for `qwen3.5:4b` Ollama GPU and `qwen3.5:9b` Ollama GPU.
- Add `configured_model`, `effective_model`, `fallback_models`, and
  `fallback_reason` health/reporting fields for every LLM node.
- Decide and implement the `qwen3.5:9b` fallback graph:
  fallback to `4b`, fallback to `2b`, or explicit no-auto-fallback for
  OOM/timeout failures.
- Defer TensorRT implementation unless Phase 0 chose a concrete provider or
  OpenAI-compatible adapter boundary.

Exit gate:

- Ollama/FastFlowLM behavior remains explicit and user-started.
- `qwen3.5:9b` is opt-in or hardware-gated, not the default editing node.
- TensorRT nodes are either still deferred or represented by a real API
  boundary with no model-name-only shortcut.

Suggested verification:

- `pnpm nx run cert-prep-ollama:test`
- `pnpm nx run cert-prep-ollama:lint`
- `pnpm nx run cert-prep-backend:test`
- `pnpm nx run cert-prep-backend:lint`

### Phase 4. Node-Aware Desktop Packaging

Purpose: make desktop launch, packaged smoke, and Package QA select nodes
explicitly.

Tasks:

- Add target/provider-aware runtime manifests for OCR and LLM artifacts.
- Update Tauri env filters so new providers are explicit allow-list entries,
  not silently coerced back to `fastflowlm` or `windowsml`.
- Make Tauri env emission platform-aware so WindowsML-only values are omitted
  for macOS/Linux nodes.
- Update packaged flow smoke defaults and package QA WindowsML-specific
  constants/fixtures so `windowsml` is no longer the implicit OCR provider for
  every product node.
- Update package QA reports and generated artifacts so node manifests include
  provider, platform, architecture, accelerator, distribution protocol,
  manifest hash, release/local URL, and install consent behavior.
- Keep the installer light; publish node runtimes as release assets.

Exit gate:

- Desktop launch, package QA, and packaged smoke can select the current
  supported node without hidden WindowsML/FastFlowLM assumptions.
- Unsupported provider values fail visibly.
- Existing Windows x64 package behavior stays compatible.

Suggested verification:

- `pnpm nx run cert-prep-desktop:typecheck-scripts`
- `pnpm nx run cert-prep-desktop:package-qa-test`
- `pnpm nx run cert-prep-desktop:cargo-test`
- `pnpm nx run cert-prep-desktop:packaged-streaming-production-windowsml`

### Phase 5. Evidence Gates And Product-Ready Promotion

Purpose: promote only measured nodes from candidate to product-ready.

Tasks:

- For every OCR node, require provider health, selected device, fallback reason,
  runtime artifact manifest, package QA, and one packaged flow smoke.
- For every LLM node, require provider health, configured/effective model,
  fallback metadata, model download behavior, structured JSON validation, and
  one packaged streaming smoke.
- For every acceleration claim, require resource evidence:
  Windows counters/DXGI/NVIDIA sampling where applicable, Linux GPU telemetry
  where applicable, and macOS telemetry/profiling if a GPU path is claimed.
- For every node, require install, health, smoke, resource, and fallback gates:
  target-platform runtime self-test, health payload with selected device/model,
  packaged smoke against installer-built artifacts, peak RAM/VRAM budget, and a
  documented `unavailable_reason` enum for failure states.

Exit gate:

- Package QA reports a per-node evidence section.
- No node is marked product-ready without install, health, smoke, resource, and
  fallback evidence.
- Current Windows default remains the fallback product lane if new nodes lack
  evidence.

Suggested verification:

- `pnpm nx run cert-prep-desktop:package-qa-test`
- One packaged smoke target per supported runtime node.
- Resource telemetry command appropriate to the OS and accelerator.

### Deferred Candidate Phases

- TensorRT provider implementation: start only after
  `.agents/DECISIONS/tensorrt-api-boundary.md` chooses the API boundary.
- Linux CUDA PaddleOCR product readiness: start only after Phase 2 package
  ownership and Phase 4 node-aware packaging are complete.
- macOS PaddleOCR GPU readiness: defer unless a supported PaddleOCR Metal/MPS or
  custom-device path is proven on a real macOS target.
- ROCm PaddleOCR readiness: defer until wheel availability, smoke evidence, and
  package target proof exist.

## Implementation Start Slice

Start implementation with Phase 0 and Phase 1 only.

First actionable slice:

1. Create `.agents/SPECS/runtime-nodes.md`.
2. Create `.agents/DECISIONS/paddleocr-package-boundary.md`.
3. Create `.agents/DECISIONS/tensorrt-api-boundary.md` and explicitly defer
   TensorRT if no real local API boundary is chosen.
4. Add shared node contract skeletons only after the three documents above are
   present.
5. Run the Phase 1 verification commands before starting package extraction.

## Acceptance Criteria

- `.agents/SPECS/runtime-nodes.md` exists and identifies the default Windows,
  macOS, and Linux product nodes.
- `.agents/SPECS/runtime-nodes.md` explicitly reconciles or supersedes
  `.agents/SPECS/domains/runtime-packaging.md` and
  `.agents/DECISIONS/tauri-packaging-deferred-ollama.md`.
- Generic PaddleOCR is package-owned and no longer grows backend internals.
- Generic PaddleOCR is represented as a new package-owned product node and does
  not reuse the legacy Paddle OCR runtime manifest as its product artifact.
- PaddleOCR package ownership is explicit enough that `ocr-setup-*` and
  `build-ocr-runtime-gpu` either move to `cert-prep-ocr-paddle` or have a
  documented temporary forwarding target with no backend runtime shim imports.
- TensorRT is either explicitly deferred or represented by a real provider or
  provider mode with health and smoke evidence.
- Backend settings enums, `RuntimeRequirementKind`, Tauri provider allowlists,
  launch env emission, health payloads, smoke args, and package QA reports are
  updated together for each newly supported provider or node.
- `qwen3.5:4b` and `qwen3.5:9b` model nodes are documented with provider,
  fallback, and install behavior.
- `qwen3.5:9b` fallback behavior is represented as a concrete chain or as an
  explicit no-auto-fallback policy for OOM/timeout failures.
- Desktop launch, package QA, and packaged smoke can select each supported node
  without hardcoded WindowsML/FastFlowLM assumptions.
- Package QA reports a per-node section with provider, model, device type or ID,
  installer kind, distribution protocol, manifest artifact, manifest hash,
  release/local URL, install consent behavior, and health pass/fail.
- No TODO item is marked complete until the stated verification commands pass.

## Verification Plan

- Orientation:
  `pnpm nx show projects --json`
- Existing package gates:
  `pnpm nx run cert-prep-ocr-windowsml:test`
  `pnpm nx run cert-prep-ollama:test`
- Backend gates:
  `pnpm nx run cert-prep-backend:test`
  `pnpm nx run cert-prep-backend:lint`
- Desktop gates:
  `pnpm nx run cert-prep-desktop:typecheck-scripts`
  `pnpm nx run cert-prep-desktop:package-qa-test`
  `pnpm nx run cert-prep-desktop:cargo-test`
- Node smoke gates:
  add one packaged smoke target per supported runtime node before calling that
  node product-ready.

## Final Check For This TODO

- `git diff --check -- .agents/TODOS/cross-platform-runtime-nodes.md`
