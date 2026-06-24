# FastFlowLM NPU Reasoning Decisions

- Use FastFlowLM through its OpenAI-compatible server instead of shelling out
  per prompt. Server mode is the only path that matches the app's streaming job
  and health-check architecture.
- Keep runtime installation explicit. Health may detect `flm`, but it must not
  install FastFlowLM or pull `qwen3.5:4b`.
- Keep `qwen3.5:4b` as the configured model and `qwen3.5:2b` as the fallback
  candidate for the same-family low-memory path.
- Keep Ollama available as a supported provider for existing setups and tests.
- Treat FastFlowLM runtime availability separately from OCR WindowsML/NPU
  evidence. This slice changes reasoning execution only.
- Packaged production summaries are provider-aware: Ollama still requires
  `reasoning_uses_nvidia_dgpu`, while FastFlowLM requires model health,
  configured-model selection, and no fallback. This avoids treating intentional
  NPU reasoning as a failed NVIDIA dGPU routing check.
- Local closeout evidence on 2026-06-23 used FastFlowLM `FLM v0.9.43`,
  `qwen3.5:4b`, and the OpenAI-compatible server on
  `http://127.0.0.1:52625/v1`.
