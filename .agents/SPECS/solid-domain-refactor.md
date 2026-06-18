# SOLID Domain Refactor 規格

## 現況

- 本輪是 pure refactor，沒有主動實作 OCR health、first chunk latency、worker count 效能調整、reasoning bakeoff 等功能 TODO。
- Root 先建立 baseline commit `803310f docs: prepare solid domain refactor baseline`，把舊 archive TODO 刪除和本輪工作包切開。
- 三個 domain 已由 sub-agent 分工完成：
  - Tauri：`lib.rs` 從大型混合檔拆成 app wiring、commands、backend state/process、runtime installation、manifest、archive/download、Windows process helper 等模組。
  - Angular：`HealthStore` 與 runtime health UI 拆出 snapshot loading、API client、requirement derivation、job view、status chip/view-model、runtime drawer presentation。
  - Python：source document repository、runtime installations、mock exam provider 拆成 persistence/progress/chunk/classification、manager/installers/manifest/archive/process、deterministic/reasoning/Ollama/fake provider/normalization。

## 決策

- 保持產品行為不變；外部 Tauri command、Angular flow、Backend REST/OpenAPI 沒有刻意改 contract。
- `runtime_installations.py` 改為 package；`exam_prep_backend.domains.runtime_installations` 仍是目前 domain public API，不保留舊檔 shim。
- Runtime manifests 在 release build 後同步更新並納入 commit，避免 packaged app 指到 stale artifact hash。
- Docstring/TSDoc/Rust doc comment 只補在 public boundary、provider protocol、non-obvious state derivation、manifest/process helper、parser/validator 等有維護價值的位置。
- File-size 目標採務實原則：優先拆掉混合責任；仍較長的檔案如 `health.store.ts`、`source-import.store.ts`、`pdf_extraction.py` 不在本輪 scope 內。

## QA 證據

Baseline / hygiene：

- `git diff --check`：通過。
- `rg "^- \\[x\\]" .agents/TODOS`：無完成勾選殘留。
- `rg "\\?\\?\\?\\?|\\x{FFFD}" .agents/SPECS .agents/TODOS .agents/DECISIONS`：通過。

Automated checks：

- `pnpm nx run exam-prep-backend:test`：通過，80 tests passed，1 個既有 FastAPI/TestClient warning。
- `pnpm nx run exam-prep-backend:lint`：通過。
- `pnpm nx run exam-prep:test --skip-nx-cache`：通過，32 tests passed。
- `pnpm nx run exam-prep:lint`：通過。
- `pnpm nx run exam-prep-e2e:e2e`：通過，3 Playwright tests passed。
- `pnpm nx run exam-prep-desktop:typecheck-scripts`：通過。
- `pnpm nx run exam-prep-desktop:package-qa-test`：通過，8 tests passed。
- `pnpm nx run exam-prep-desktop:cargo-test`：通過，12 Rust tests passed。
- `pnpm nx run exam-prep:build --skip-nx-cache`：通過；Angular initial bundle 761.71 kB，超過 700 kB budget 61.71 kB，列為既有 warning。
- `pnpm nx run exam-prep-desktop:build-gpu --skip-nx-cache`：通過，產出 release exe、MSI、NSIS installer；Cargo PDB filename collision warning 仍存在。
- `pnpm nx run exam-prep-desktop:package-qa --skip-nx-cache --args='--ocr-page-workers 1'`：通過，報告在 `tmp/exam-prep-desktop/package-qa/package-qa.json`。

Packaged production smoke：

- Command：`$env:EXAM_PREP_OCR_PAGE_WORKERS='1'; node .agents/tmp/parallel-parsing-reasoning/run-packaged-flow-current.cjs`
- PDF：`pdfs/【1】2025年07月N1 真题.pdf`
- Artifact：`.agents/tmp/parallel-parsing-reasoning/2026-06-18T07-57-13-180Z/`
- Screenshots：16 張，包含 runtime ready、project created、PDF selected with `ja`、parsing started、mid-parse、parsing complete、draft edit、approved draft、full exam、wrong answer、review populated、random quiz correct、review cleared、restart persistence。
- Flow 結果：通過。runtime ready → upload/parse → deterministic draft → manual answer/rationale → approve → full exam wrong answer → wrong-answer review populated → random quiz correct answer → wrong-answer review cleared → restart persistence。
- Metrics：
  - upload to processing visible：546 ms
  - first chunk visible：71,067 ms
  - parse complete visible：98,733 ms
  - deterministic draft generation：570 ms
  - save and approve：31 ms
  - restart persistence：verified

## UX 觀察

- Runtime checklist 已維持為 header chips + Manage runtime drawer，主工作區沒有再被 runtime checklist 大量佔用。
- Build 頁 parsing complete 後 metrics、chunks preview、draft controls 都可用；但大量 OCR preview 仍讓 draft edit 畫面很長，後續可考慮 collapsible chunks 或 draft review focus mode。
- UI copy 仍混合英文、繁中、日文與 runtime model label，後續 i18n/copy cleanup 可獨立處理。
- Package smoke 觀察到 OCR health 需要 refresh/settle 才顯示 ready；這是既有 runtime health UX 後續，不在本輪純重構內修正。
- Packaged app graceful close 仍需要 process-tree kill，且 app exit code 為 1；flow 可完成，但 close/cleanup 是後續 hardening 風險。

## 未解風險

- First chunk latency 仍高，本輪沒有修效能路徑。
- Angular bundle budget warning 未在本輪處理。
- Cargo PDB filename collision warning 未在本輪處理。
- Package QA JSON 的乾淨 data dir 仍顯示 OCR runtime missing；完整 OCR/parsing flow 由 packaged smoke script 驗證。
