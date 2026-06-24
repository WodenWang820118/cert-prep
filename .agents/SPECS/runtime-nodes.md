# Runtime Nodes Specification

This specification defines the runtime nodes for OCR and LLM execution across Windows, macOS, and Linux. It establishes the default configuration, hardware capabilities, and verification requirements for promoting candidates to product-ready status.

## Platform Alignment & Reconciliation

This specification extends and reconciles the rules defined in [.agents/SPECS/domains/runtime-packaging.md](file:///C:/software-dev/cert-prep/.agents/SPECS/domains/runtime-packaging.md) and [.agents/DECISIONS/tauri-packaging-deferred-ollama.md](file:///C:/software-dev/cert-prep/.agents/DECISIONS/tauri-packaging-deferred-ollama.md):
- **Windows x64 First**: Keep the core lightweight NSIS/MSI desktop installer (under 50 MB) and download platform-specific runtime assets on demand.
- **No Global Ollama Bundling**: Ollama models are never bundled inside the installer. Model download remains confirmation-gated.
- **Legacy Paddle Manifest Replacement**: We reject the legacy Paddle OCR runtime manifest. Any future PaddleOCR node is represented by the new package `packages/cert-prep-ocr-paddle`.

---

## Runtime Node Matrix

### 1. OCR Nodes

| Platform | Node ID | Default / Override | Accelerator | Distribution / Packaging |
| :--- | :--- | :--- | :--- | :--- |
| **Windows** | `windowsml` | **Default** | DirectML / AMD iGPU / Intel / Nvidia | Zip package extraction to local runtime dir |
| **Windows** | `paddle` | Override | CUDA dGPU or CPU fallback | Custom Zip package / pip dependency |
| **macOS** | `paddle` | **Default** | CPU-first (MPS / Metal deferred) | Plat-specific Zip package / local virtualenv |
| **Linux** | `paddle` | **Default** | CUDA dGPU / CPU fallback (ROCm deferred)| Plat-specific Zip package / AppImage resource |

### 2. LLM Nodes

| Platform | Provider | Target Model | Default / Override | Accelerator |
| :--- | :--- | :--- | :--- | :--- |
| **Windows** | `fastflowlm` | `qwen3.5:4b` | **Default** | OpenAI-compatible NPU server |
| **Windows** | `ollama` | `qwen3.5:4b` | Override | local Ollama (GPU/CPU) |
| **Windows** | `ollama` | `qwen3.5:9b` | Override (Hardware-gated) | local Ollama (GPU/CPU) |
| **macOS** | `ollama` | `qwen3.5:4b` | **Default** | local Ollama (Apple Silicon GPU/CPU) |
| **macOS** | `ollama` | `qwen3.5:9b` | Override (Hardware-gated) | local Ollama (Apple Silicon GPU/CPU) |
| **Linux** | `ollama` | `qwen3.5:4b` | **Default** | local Ollama (Nvidia CUDA/CPU) |
| **Linux** | `ollama` | `qwen3.5:9b` | Override (Hardware-gated) | local Ollama (Nvidia CUDA/CPU) |

---

## Model Policy & Fallback Graph

### Default vs. High-Capability LLM
- `qwen3.5:4b` remains the default, low-latency, editing/study model.
- `qwen3.5:9b` is introduced as a higher-capability option for advanced explanation tasks.

### Fallback Graph Policy
1. **OOM or Timeout (Ollama)**:
   - When a `9b` request fails due to Out-Of-Memory (OOM) or timeout, **do not automatically fall back** to `4b`. Auto-fallback can lead to silent quality degradation.
   - The failure must surface an explicit error instructing the user to free VRAM or switch back to the `4b` node manually.
2. **Missing Model (`missing_model`)**:
   - If a model is not found in the local Ollama instance, the system must trigger a confirmation-gated download job.

---

## Evidence Gates for Product-Ready Promotion

Before any candidate node is promoted to **Product-Ready**, it must satisfy the following validation gates:

1. **Install Gate**: Verify the platform-specific zip/virtualenv/AppImage artifact extracts cleanly on the target OS, and is correctly tracked by a target manifest containing the package hash.
2. **Health Gate**: The provider endpoint must successfully return a health payload specifying the configured/effective model, selected device ID, and diagnostic telemetry.
3. **Smoke Gate**: Pass at least one packaged flow/streaming smoke test using the target node.
4. **Resource Gate**: Peak RAM/VRAM usage must be recorded during active inference and verify it fits within platform-specific budgets (e.g. Nvidia dGPU vs AMD iGPU vs CPU).
5. **Fallback Gate**: Verify that error handling behaves as expected (e.g., OOM raises visible alerts, missing models trigger confirmation-gated downloads).
