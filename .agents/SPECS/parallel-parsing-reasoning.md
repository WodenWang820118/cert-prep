# Parallel Parsing 與 Reasoning 題目正式化規格

## 現況

本切片在 saved parsed exams/runtime UX 之上，加入 persistent PaddleOCR worker、worker count metrics、document parsing metrics、deterministic/reasoning draft strategy、reasoning model copy。Production acceptance 目前以 deterministic/manual path 通過；reasoning bakeoff 尚未完成。

## 決策

- `EXAM_PREP_OCR_PAGE_WORKERS` 預設維持 `1`，`2` workers 只在 same-build QA 達標後才可提議升級。
- OCR workers 只回傳 page results，不直接寫 DB；backend processing thread 負責 persistence。
- `deterministic_only` 是預設 draft strategy，不需要 Ollama。
- `hybrid_reasoning` 只能產生 review drafts，不可 auto approve，不保存 chain-of-thought。
- 新安裝預設 reasoning model 為 `qwen3:14b`；`deepseek-r1:14b` 與 `gemma4:12b` 是 bakeoff candidates。
- UI copy 使用 Reasoning model，不再硬編 Gemma。

## QA 證據

- package QA JSON generated at `2026-06-18T04:06:03.165Z`。
- Packaged 2-worker OCR：46/46 pages、46 chunks、wall 58,068 ms、first chunk 57,587 ms、render 2,459 ms、OCR engine 38,788 ms、GPU memory peak 4,348/8,188 MiB。
- Runtime/draft UI 顯示 compact chips、`qwen3:14b` model name、deterministic/reasoning actions、parsing metrics。
- Manual Save & approve、full exam、random quiz、wrong-answer cleanup、restart persistence 已在 packaged app 走通。

## 已吸收完成 TODO

- Baseline freeze。
- Persistent PaddleOCR worker mode 與 worker count。
- Parsing metrics/API/client。
- Deterministic-only / hybrid-reasoning strategy。
- Runtime/draft UI copy and metrics。
- Browser/desktop automated checks。
- Packaged build/package QA。
- 2-worker production QA。
- Common mistakes log。

## 未解風險

- Same-build 1-worker packaged baseline 尚未跑，不能比較 `1` vs `2`。
- `_extract_ocr_pages()` 仍可能等全部 futures 結束才 flush，導致 first chunk 幾乎等於 full parse。
- Python runtime install 後 UI 狀態可能 stale。
- Complete progress bar 有視覺 mismatch。
- Restart 後 project 未自動選回。
- Product sidecar shutdown 需要 process-tree cleanup。
- Reasoning model bakeoff 尚未驗證。
