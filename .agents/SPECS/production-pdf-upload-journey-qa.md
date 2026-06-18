# Production PDF Upload Journey QA 摘要

## 現況

2026-06-17 以 packaged Tauri app、已安裝 Python backend runtime、PaddleOCR runtime 與 repo 內真實 PDF 驗證一般使用者第一次 productive journey。

PDF：`pdfs/【1】2025年07月N1 真题.pdf`。此檔為 46 頁 image-only PDF，無 embedded text，因此是完整 OCR path。

## Grill-Me 結論

- 使用者旅程要驗證：runtime ready → project → upload PDF → OCR/parse → 看到可用文字/草稿 → 明確知道下一步。
- 真實 PDF 必須優先於 synthetic fixture，因為非 ASCII 檔名、長 OCR、語言混合才是 production 風險。
- 使用者應可在 parsing 時繼續操作；長 PDF 不可讓 workspace 看起來 frozen。
- Upload 應保留 language hint；它不能解決 mojibake，但可降低 OCR/parser/model 選錯語言的機率。
- OCR text 應先直接輸出，Gemma/reasoning 只作後續 enrichment。

## QA 證據

- 初次 OCR failure root cause：Windows default locale 解碼 OCR runtime JSON，導致日文 stdout under cp950 發生 `UnicodeDecodeError`。
- Fix：backend OCR runtime command 改 UTF-8 decode with replacement for stderr；新增測試。
- 後續 packaged run：46 pages、46 chunks、`paddle_ocr_gpu`、`gpu:0` 成功。
- Gemma full OCR prompt 曾產生 invalid JSON，因此 deterministic/manual path 被確認為必要。
- Deterministic JLPT question-block extraction 可在 Ollama/Gemma offline 時產生 3 個 manual drafts。

## 已吸收完成 TODO

- UTF-8 subprocess decode 修正。
- Document listing/chunk reload。
- Deterministic question-block extraction。
- Rebuild backend runtime and packaged app verification。
- UI 顯示 OCR chunks 與 manual draft candidates。

## 未解風險

- 長 OCR 期間 UI feedback 不足，已由 async parsing slice 改善但仍需 first-chunk flush。
- Failure state 要保留 per-page diagnostic，不應只顯示 `ocr_failed`。
- Manual draft review 需要更強 next-action guidance。
