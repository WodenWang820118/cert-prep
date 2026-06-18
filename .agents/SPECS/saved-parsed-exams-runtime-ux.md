# Saved Parsed Exams 與 Runtime UX 規格

## 現況

已解析 PDF 是 project 內可重開的 question bank。使用者可以從同一份文件啟動 full exam，也可以從 project approved questions 啟動 random quiz。Runtime UI 已從大 checklist 改為 header chips + drawer。

## 決策

- `question_drafts` 暫時仍是題庫表；新增 source order、question number、item kind、group key/prompt 等 metadata。
- Full exam 只取同一文件 approved drafts，並依 source order 排序。
- Random quiz 從 project approved drafts uniform sample，保存 random seed。
- Deterministic parser/classifier 是 v1 主路徑；低信心結果進人工 review。
- Runtime drawer 保留 explicit consent，不因 compact UI 而自動下載。

## QA 證據

- packaged QA 於 2026-06-17 驗證 parsed document/chunks/approved drafts 可跨 restart 保存。
- SQLite evidence 顯示 46 chunks、3 approved drafts、full document session、random draw seed 與 wrong-answer cleanup。
- Runtime compact header/drawer 截圖已保存於 `.agents/tmp/saved-parsed-exams-runtime-ux/`。

## 未解風險

- UI 未提供 random seed replay 控制，debug 仍靠 SQLite/backend tests。
- Source preview 完成後仍過高，需要下一輪 UX 收斂。
- Ollama/model offline copy 仍需更清楚標示 optional。
