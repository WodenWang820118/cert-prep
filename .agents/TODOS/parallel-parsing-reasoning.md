# Parallel Parsing And Reasoning Active TODO

> 這是目前唯一 active backlog。已完成項目已吸收到 `.agents/SPECS/parallel-parsing-reasoning.md` 與 `.agents/SPECS/parallel-parsing-reasoning-qa.md`。

- [ ] Run same-build production parsing QA with worker count 1
  - Reason: required before changing default worker count from `1` to `2`.
  - Verify: packaged flow with `EXAM_PREP_OCR_PAGE_WORKERS=1`; compare wall time, first chunk, chunks/page count, and GPU samples against same-build worker `2`.

- [ ] Implement ordered as-completed OCR chunk flushing
  - Reason: current 2-worker run shows first chunk only near full completion.
  - Verify: backend test where page 2 finishes before page 1; UI/package QA shows chunks while parsing continues.

- [ ] Fix runtime/progress/restart UX follow-ups
  - Reason: Python runtime install can leave stale copy, complete progress bar looks short, restart required manual project selection.
  - Verify: Angular tests plus packaged screenshots for install refresh, complete progress, and restart auto-selection.

- [ ] Harden packaged Tauri backend/OCR process-tree cleanup
  - Reason: failed automation runs left backend/OCR child processes alive.
  - Verify: Rust tests and package QA run exit without manual `taskkill`.

- [ ] Run reasoning-model bakeoff
  - Reason: model downloads require explicit consent and were not needed for deterministic production acceptance.
  - Verify: compare `qwen3:14b`, `deepseek-r1:14b`, and `gemma4:12b` on selected JLPT pages for JSON validity, citation validity, group detection, latency, and manual review burden.
