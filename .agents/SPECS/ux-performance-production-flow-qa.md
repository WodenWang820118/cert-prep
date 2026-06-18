# UX Performance Production Flow QA 摘要

## 現況

2026-06-17 以 packaged Tauri app 驗證 async parsing → manual draft → practice → wrong-answer cleanup。測試資料重置 AppData DB/uploads，保留既有 PaddleOCR runtime。

PDF：`pdfs/【1】2025年07月N1 真题.pdf`。

## QA 證據

- Python runtime 可從 UI 安裝並啟動。
- PaddleOCR ready on `gpu:0`。
- PDF upload with `language_hint=ja` under 2s 進入 processing。
- Source panel 顯示 page progress/chunks；當時 first chunk 約 22s 後出現。
- Parsing complete：46/46 pages、46 chunks。
- Manual draft edit + Save & approve 成功。
- Wrong attempt 進 Review；後續 correct answer 清空 wrong-answer panel。

## 量測

- Python runtime install：5.7s。
- Full parsing wall time：18m19s。
- OCR engine reported：27,303 ms。
- Manual edit/approve：人類操作含輸入約 33s。
- Correct-answer cleanup：1.4s。

## UX 結論

- Async parsing 讓 app 不再像 frozen，但 source panel 完成後仍太佔第一屏。
- Manual draft editing 是可信 production fallback。
- Runtime checklist 拆分 Python/Ollama/model/PaddleOCR 後更清楚，但 Ollama offline 仍缺 guided install/launch/download flow。
- `use while parsing` 應成為正式 workflow：從 completed chunks 產生 drafts，並持續背景 parse。

## 已吸收完成 TODO

- Packaged build + production run。
- Runtime ready/install screenshots。
- Parsing progress/chunks screenshots。
- Draft approve、practice wrong answer、wrong answer clear screenshots。
- Grill-me notes and use journey analysis。

## 未解風險

- Wall time 和 OCR engine time 落差很大，指向 orchestration/process startup/page pipeline。
- Progress bar complete-state mismatch 待修。
- Session completion state 仍可能保持 `active`，後續可另開小切片。
