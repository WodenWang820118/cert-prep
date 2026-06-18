# SOLID Domain Refactor 規格

## 現況

- 本輪只做結構性重構，不主動修正 OCR health、first chunk latency、reasoning bakeoff、parallel parsing 預設值等功能 TODO。
- 目前最大混合責任檔案集中在三個 domain：
  - Tauri：`apps/exam-prep-desktop/src-tauri/src/lib.rs` 同時負責 app wiring、runtime manifest、下載解壓、Python backend lifecycle、Tauri commands 與 Windows process helper。
  - Angular：`HealthStore` 與 `ModelHealthComponent` 同時負責狀態讀取、runtime job polling、需求判斷、UI copy/status mapping 與 drawer 呈現。
  - Python：source document repository、runtime installations、mock exam provider 同時混合 persistence、IO adapters、parser、model transport、validation 與 mapping。
- 舊 `.agents/TODOS/*.md` 指標檔已只剩 archive/superseded 訊息；active backlog 保留在 `.agents/TODOS/parallel-parsing-reasoning.md`，本輪另新增 `.agents/TODOS/solid-domain-refactor.md`。

## 決策

- 採 pure refactor：任何功能行為漂移都視為 blocker，除非是為了同步破壞性 contract 變更而更新所有本地 consumer、generated client、測試與 QA 腳本。
- 不保留 compatibility shim；內部 API、REST/OpenAPI、runtime manifest、package QA JSON 或 DB 邊界若需要更名，可同輪同步改完。
- Root agent 只負責 baseline gate、domain scope、整合 review、QA evidence 與 commit 邊界。
- Domain worker ownership：
  - Tauri worker：只修改 `apps/exam-prep-desktop/src-tauri/src/**` 與必要 Rust 測試。
  - Angular worker：只修改 `apps/exam-prep/src/app/**` 的 health/runtime UI 相關檔案與對應測試。
  - Python worker：只修改 `apps/exam-prep-backend/src/**` 的 source documents、runtime installations、mock exams 相關檔案與對應測試。
- 共享 contract 變更由 root sequencing；worker 不同時修改同一檔案。
- Docstring/TSDoc/Rust doc comment 只加在 public boundary、provider protocol、non-obvious computed state、process cleanup、manifest verification 與 parsing/validation helper；避免為 trivial private helper 補噪音註解。

## QA 證據

- Baseline gate：
  - `git diff --check`
  - `rg "^- \\[x\\]" .agents/TODOS`
  - `rg "\\?\\?\\?\\?|\\x{FFFD}" .agents/SPECS .agents/TODOS .agents/DECISIONS`
- Behavior preservation gate：
  - `pnpm nx run exam-prep-backend:test`
  - `pnpm nx run exam-prep-backend:lint`
  - `pnpm nx run exam-prep:test --skip-nx-cache`
  - `pnpm nx run exam-prep:lint`
  - `pnpm nx run exam-prep-e2e:e2e`
  - `pnpm nx run exam-prep-desktop:typecheck-scripts`
  - `pnpm nx run exam-prep-desktop:package-qa-test`
  - `pnpm nx run exam-prep-desktop:cargo-test`
- Production smoke：
  - `pnpm nx run exam-prep-desktop:build-gpu --skip-nx-cache`
  - `pnpm nx run exam-prep-desktop:package-qa --skip-nx-cache --args='--ocr-page-workers 1'`
  - PDF：`pdfs/【1】2025年07月N1 真题.pdf`
  - Flow：runtime ready → upload/parse → draft approve → full exam/random quiz → wrong-answer review → restart persistence。

## 未解風險

- Tauri `lib.rs` 拆分時若 command registration visibility 沒同步，package QA 會先壞。
- Angular health UI 若把 polling lifecycle 拆太散，容易造成 stale runtime required 或 drawer 狀態卡住。
- Python repository/provider 拆分若 row mapping 或 transaction boundary 漂移，會影響 parsing progress、draft ordering 與 saved exam persistence。
- 本輪不解 active backlog 的效能問題；若 QA 指標仍慢，只能記錄在後續 TODO，不在本輪混修。
