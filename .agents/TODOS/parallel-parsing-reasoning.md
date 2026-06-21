# Parallel Parsing And Reasoning TODO

Status: active backlog only. Completed OCR health and first-chunk gate evidence
has been merged into `.agents/SPECS/domains/parsing-reasoning.md`.

## 1. Live Reasoning-Model Bakeoff

- [ ] Produce scored live bakeoff evidence for `qwen3:14b`,
  `deepseek-r1:14b`, and `gemma4:12b`, or explicitly record
  model-availability blockers.
  - Current blocker:
    `apps/exam-prep-backend/.benchmarks/reasoning-bakeoff-20260621T052159Z.json`
    recorded `qwen3:14b=missing_model`, `deepseek-r1:14b=missing_model`, and
    `gemma4:12b=request_failed` with `json_error=ReadTimeout`.
  - Plan:
    1. Keep model installation user-controlled. Do not pull models
       automatically.
    2. Re-run the existing bakeoff target only after the missing local models
       are intentionally installed or the timeout condition is addressed.
    3. Compare JSON validity, citation validity, group detection, latency,
       manual-review burden, and artifact hygiene.
    4. Update `.agents/SPECS/domains/parsing-reasoning.md` with the scored
       artifact or a refreshed concrete blocker.
    5. Only update the default model decision if the evidence supports it.
  - Verify:
    `pnpm nx run exam-prep-backend:reasoning-bakeoff --skip-nx-cache`
    `pnpm nx run exam-prep-backend:test --skip-nx-cache`
    `pnpm nx run exam-prep-backend:lint --skip-nx-cache`
