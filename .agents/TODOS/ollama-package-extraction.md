# Ollama Infrastructure Package Extraction TODO

將 Ollama 相關的泛用基礎設施從 `cert-prep-backend` 抽離為獨立 workspace package，供 backend、desktop 等專案共用。

## Phase 1 — 建立 Package 結構

- [x] 建立 `packages/cert-prep-ollama/` 並註冊為 Nx Python package。
  Affected: `packages/cert-prep-ollama/pyproject.toml`, `packages/cert-prep-ollama/project.json`
  Verify: `pnpm nx show projects --json | grep cert-prep-ollama`

- [x] 設定 package 相依：backend 的 `pyproject.toml` 加入 `cert-prep-ollama` dependency（`editable = true`，走 workspace）。
  Affected: `apps/cert-prep-backend/pyproject.toml`
  Verify: `uv sync --directory apps/cert-prep-backend`

## Phase 2 — 搬移泛用基礎設施

- [x] 從 `cert_prep_backend.domains.runtime_installations.ollama` 搬移以下函式到 `cert_prep_ollama`：
  - `resolve_ollama_executable()` → `cert_prep_ollama.executable`
  - `ensure_ollama_server_running()` → `cert_prep_ollama.server`
  - `ollama_api_available()` → `cert_prep_ollama.server`
  - `_start_ollama_server()`, `_ollama_server_bind_host()` → `cert_prep_ollama.server`
  Affected: deleted `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/ollama.py`
  Verify: backend imports `cert_prep_ollama` directly, `pnpm nx run cert-prep-backend:test`

- [x] 從 `cert_prep_backend.domains.runtime_installations.installers` 搬移：
  - `OllamaRuntimeInstaller`（winget 安裝 + server 啟動）
  - `OllamaModelInstaller`（ollama pull 模型）
  到 `cert_prep_ollama.installers`。
  Affected: `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/installers.py`
  Verify: `pnpm nx run cert-prep-backend:test`

- [x] 從 `cert_prep_backend.domains.mock_exams.ollama_transport` 搬移泛用 helper：
  - `extract_model_names()`（parse ollama list response）
  - `pull_progress()`（normalize pull progress）
  到 `cert_prep_ollama`。
  Affected: `apps/cert-prep-backend/src/cert_prep_backend/domains/mock_exams/ollama_transport.py`
  Verify: `pnpm nx run cert-prep-backend:test`

## Phase 3 — 保持 Domain Provider 留在 Backend

- [x] 確認 `OllamaProvider`（`ollama_transport.py`）**不搬移**。它依賴 `DraftSuggestion`、`SourceChunk`、`EXAM_ITEMS_SCHEMA`、考題 prompt 等領域邏輯，屬於 exam generation domain，不適合放入泛用 package。
  - 搬移後 `OllamaProvider` 改從 `cert_prep_ollama` import 泛用工具。
  - 未來新增其他 LLM backend（OpenAI、Anthropic 等）直接在同一 domain 下實作 `DraftGenerationProvider` Protocol。
  Affected: `apps/cert-prep-backend/src/cert_prep_backend/domains/mock_exams/ollama_transport.py`
  Verify: `pnpm nx run cert-prep-backend:test && pnpm nx run cert-prep-backend:lint`

## Phase 4 — 向後相容與清理

- [x] Backend 原有 Ollama import 路徑不保留 re-export/deprecation shim；backend 直接引用 `cert_prep_ollama`。
  Affected: `apps/cert-prep-backend/src/cert_prep_backend/domains/runtime_installations/__init__.py`
  Verify: `pnpm nx run cert-prep-backend:test`

- [x] Desktop（`cert-prep-desktop`）若有直接引用 Ollama 邏輯，改從 `cert-prep-ollama` package 引用。
  Affected: `apps/cert-prep-desktop/`
  Verify: `rg -n "cert_prep_ollama|runtime_installations\.ollama|OllamaRuntimeInstaller|OllamaModelInstaller|ollama_windows_install_command" apps\cert-prep-desktop apps\cert-prep\src -g "*.ts" -g "*.tsx" -g "*.rs" -g "*.json" -g "*.toml"` returns no direct desktop/app references.

## Phase 5 — 最終驗證

- [x] 執行全 workspace 測試與 lint。
  Verify: `pnpm nx run-many -t="test,lint" --skipNxCache --parallel=false`
