# Parallel Parsing And Reasoning Decisions

- Baseline：saved parsed exams/runtime UX 視為已完成 dirty baseline；本切片在其上加入 parallel parsing/reasoning foundation。
- OCR worker：先用 persistent external PaddleOCR JSONL worker，避免每頁 cold start；workers 不寫 DB。
- Worker default：`EXAM_PREP_OCR_PAGE_WORKERS` 預設維持 `1`，直到 same-build `1` vs `2` QA 證明 `2` 有 >=20% wall-time 改善且 counts/GPU memory 無回歸。
- First chunk：2-worker run 證明 GPU memory 可承受，但 first chunk 幾乎等於 full parse；下一步優先做 ordered as-completed flush，而不是先改 default。
- Reasoning model：新預設候選為 `qwen3:14b`，`deepseek-r1:14b` 與 `gemma4:12b` 為 bakeoff comparator；`EXAM_PREP_OLLAMA_MODEL` 保持相容 override。
- Draft strategy：`deterministic_only` 預設不需 Ollama；`hybrid_reasoning` 只補 enrichment/gaps，輸出永遠是 draft。
- QA artifacts：package QA JSON、runtime manifests、bundle sizes 必須與當前 build artifact 對齊，不能手改報告當證據。
- Error governance：單頁 OCR/render 失敗應降級為 page-level failure，能保留其他頁 chunks。
