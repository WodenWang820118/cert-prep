# Cross-Platform Runtime Nodes TODO

## Status

Deferred.

The current product lane is Windows-first:

- OCR: `windowsml` through `packages/cert-prep-ocr-windowsml`.
- LLM: `fastflowlm` with `qwen3.5:4b`.
- Backend smoke: `cert-prep-backend:streaming-cli-test`.
- Packaged smoke:
  `cert-prep-desktop:packaged-streaming-production-windowsml`.

There is no current product need to implement the full macOS/Linux/runtime-node
matrix. Keep this TODO as a restart point for future platform or provider
expansion, not as active release-blocking work.

## Keep

- Do not rewrite the proven WindowsML/FastFlowLM lane.
- Do not revive the retired standalone AMD NPU OCR provider.
- Do not claim generic "system GPU" support without provider, device, smoke,
  fallback, and resource evidence.
- Do not reuse the legacy Paddle OCR runtime manifest as the product artifact
  for a future PaddleOCR node.
- Do not hide TensorRT behind an existing provider until its local API boundary
  is decided.
- Do not add backend shims or re-export paths once a runtime is package-owned.

## Resume Only When

Resume this TODO only if one of these becomes a real product goal:

- Ship a supported macOS or Linux desktop runtime.
- Promote generic PaddleOCR from backend-owned internals to a package-owned
  runtime node.
- Add a new LLM provider such as TensorRT or a TensorRT-backed local server.
- Make packaged smoke and Package QA select multiple supported runtime nodes.

## Current Gaps To Recheck

- `.agents/SPECS/domains/parsing-reasoning.md` owns the cross-platform runtime
  node classification and evidence gates.
- `packages/cert-prep-ocr-paddle` does not exist yet.
- PaddleOCR package-boundary details are not decided yet.
- TensorRT API-boundary details are not decided yet.
- Tauri launch still defaults to `fastflowlm` and `windowsml`, and provider
  allowlists are hardcoded.
- Packaged smoke and Package QA are still WindowsML/FastFlowLM-oriented.

## Small Safe Slice

If this TODO needs cleanup before full implementation, do only this:

1. Add a `PaddleOCR Package Boundary` note to
   `.agents/SPECS/domains/parsing-reasoning.md` and explicitly defer
   `packages/cert-prep-ocr-paddle` until cross-platform OCR is reopened.
2. Add a `TensorRT API Boundary` note to
   `.agents/SPECS/domains/parsing-reasoning.md` and explicitly defer TensorRT
   until a real local API is chosen.
3. Leave runtime behavior unchanged.

Suggested checks for that docs-only slice:

- `git diff --check -- .agents/TODOS/cross-platform-runtime-nodes.md .agents/SPECS/domains/parsing-reasoning.md`

## Full Implementation Gate

Before implementing any new node, update these together:

- Shared runtime contract types and `RuntimeRequirementKind`.
- Backend provider settings and health payloads.
- Tauri provider allowlists and launch environment.
- Runtime manifests and distribution protocol.
- Packaged smoke arguments and Package QA reporting.
- Per-node evidence: install, health, smoke, fallback, and resource telemetry.

## Final Check For This TODO

- `git diff --check -- .agents/TODOS/cross-platform-runtime-nodes.md`
