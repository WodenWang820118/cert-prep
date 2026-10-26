# DDD 重構：提議的決策

狀態：**已核可**（2026-10-26）。產品題（P）已由產品負責人核可；設計題（D）照本表實作，實作中若要推翻其中一條，先在這裡改，並寫明理由。

## 產品決策（產品負責人）

| 編號 | 提議                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1   | 不全面暫停新功能。搬移的 PR 小而快，進行中的功能分支在每次搬移合併後 rebase；但 C3 搬某個上下文時，那個上下文的新功能先暫停（LAW 在 R1–R3 全面暫停）。 |
| P2   | 順序：後端（C1–C5）→ 前端（C6）→ Rust（C7）。後端先做，因為規則與資料表歸屬都在後端。                                                                  |
| P3   | 畫面、REST／OpenAPI、Tauri 指令與資料表結構這次都不改；重構只改程式的位置與依賴方向。                                                                  |

## 設計決策（計畫作者提議）

| 編號 | 提議                                                                                                                                                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | 上下文：學習專案、教材來源、擷取整合、題目編寫、練習與複習、AI 供應、執行環境，另有平台（不是上下文）。`domains/` 這一層拿掉，上下文直接放在 `cert_prep_backend/` 下。                                                                                                                                          |
| D2   | 上下文內分 `domain`、`application`、`infrastructure`、`api`；只建有內容的層。`api` 與 `infrastructure` 可以依賴 `application` 與 `domain`，`application` 只依賴 `domain`，`domain` 只依賴標準函式庫與 `platform` 的錯誤型別。組裝（`create_app`、`app.state`）集中在 `bootstrap`。                              |
| D3   | 每張資料表屬於一個上下文（C5 開始前在本文件列出完整對照）。別的上下文經所屬上下文 `application` 的函式讀寫；跨上下文、原本同一個交易的寫入，改用傳入同一個交易的 unit of work，不拆成兩個交易。                                                                                                                 |
| D4   | 工具：後端 import-linter，前端 Sheriff（跑在既有 ESLint），Nx 專案層級沿用 `@nx/enforce-module-boundaries`，Rust 用模組可見性與允許清單測試。既有違規以 import-linter `ignore_imports` 與 ESLint bulk suppressions 列為已知例外，每個 PR 只能減少。與 LAW A31 用同一組工具。                                    |
| D5   | `domain` 不 import FastAPI、starlette、sqlite3、httpx、ollama、`capture_runtime_client`、pydantic。現在使用 pydantic 的 8 個領域檔案列為已知例外，DTO 移到 `api`、設定移到 `platform` 後解除。                                                                                                                  |
| D6   | 合約不變：每個 PR 重新產生 OpenAPI 與 `libs/cert-prep-api`，必須和 main 逐 byte 相同；router 的函式名稱、tag、路徑都不改。Tauri 指令與 package QA JSON 不變。                                                                                                                                                   |
| D7   | AI 供應自成上下文：`DraftGenerationProvider` 這類 port 移到 `ai_providers.application`，Ollama 用戶端移到它的 `infrastructure`，`packages/cert-prep-ollama` 維持套件但只由 `ai_providers` 引用。題目編寫、練習、擷取、教材都依賴 `ai_providers`，不再依賴題目編寫。                                             |
| D8   | 擷取整合是 Capture Runtime 的防腐層：Capture SDK 的型別只出現在 `capture_integration.infrastructure`；寫入教材經 `source_library.application`。                                                                                                                                                                 |
| D9   | 前端每個上下文一個資料夾，內分 `feature`（頁面與容器）、`ui`（展示元件）、`data`（store、API 呼叫）、`domain`（型別與純函式）；上下文之間只經 `index.ts`。跨上下文共用的殼層、路由、作業事件放 `core`。                                                                                                         |
| D10  | 文件：說明用繁體中文，程式名稱用英文；每個上下文一份 `docs/domain/<上下文>.md`，圖用 Mermaid，改程式時同一個 PR 更新。                                                                                                                                                                                          |
| D11  | 語意分層：`domain` 依聚合分子套件（第 4.1 節的表），聚合根守住不變條件、值物件取代 `dict` 與裸字串、領域事件描述業務事實；`application` 每個用例以業務動作命名，不用 `service`、`manager`、`helpers`；repository 回傳領域物件。依賴方向的規則（D4）之外，另以用語、用例、領域物件三項測試檢查語意（第 5 節）。  |
| D12  | 概念集 `packages/cert-prep-contracts/vocabulary/cert-prep-vocabulary-v1.json`：每個概念有固定 id、中文標籤、程式名稱；OpenAPI 的每個列舉值以 `{ enumId, value }` 對應到一個概念，缺少或重複的對應讓測試失敗。概念只能停用、不能刪除或改 id。比照 LAW A13–A15、A29：JSON 是唯一來源，執行時不用 RDF 或推理引擎。 |
