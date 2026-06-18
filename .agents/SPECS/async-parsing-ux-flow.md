# Async Parsing UX Flow 規格

## 現況

PDF upload 已改為快速建立 `processing` document，背景解析，UI polling document/chunks，讓使用者看到 page progress、chunks count、partial preview，並可走 manual draft review、approval、practice、wrong-answer cleanup。

## 決策

- 使用 polling，不導入 WebSocket/SSE。
- `language_hint` 保留在 upload，預設 `auto`，可用於 OCR/parser/model prompt。
- Manual answer/rationale entry 是 production fallback；Gemma/reasoning 不在 critical path。
- Parsing 不應 global lock workspace，只 disable 正在執行的控制項。

## QA 證據

- packaged production QA 顯示 upload under 2s 進入 processing。
- 先前 run 曾看到 chunks during parsing；後續 2-worker run 發現 first chunk 又接近 full completion，列為下一階段修正。
- Manual draft edit、Save & approve、practice wrong answer、correct answer clears review 已驗證。

## 未解風險

- OCR worker pool 現在仍可能等全部 futures 才 flush 給 UI。
- Source chunks preview 仍需更輕量，避免完成後壓過 draft review。
- Restart 後 project auto-selection 有 race 或缺漏。
