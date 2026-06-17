# Downloadable Runtimes Decisions

## Decisions

- Python runtime means the packaged PyInstaller backend executable zip, not a system Python installer.
- The initial Tauri installer ships the Angular UI plus manifest resources only.
- Runtime payloads are release assets addressed by manifest URLs.
- Tauri owns Python/backend runtime download, verification, extraction, launch, and backend config handoff.
- Backend runtime APIs remain the source of truth for Ollama, model, and PaddleOCR requirements after Python/backend is running.

## Rejected Options

- Installing a machine-wide Python was rejected because it would affect user systems and complicate version support.
- Keeping the backend as a bundled `externalBin` was rejected because the UI cannot guide recovery when the runtime is missing.
- Bundling PaddleOCR in the installer remains rejected because it makes all installs pay the OCR payload cost.

## Assumptions

- Release automation provides `EXAM_PREP_RUNTIME_ASSET_BASE_URL` when building distributable runtime manifests.
- Browser development mode continues to use `http://127.0.0.1:8765` unless local storage overrides it.
