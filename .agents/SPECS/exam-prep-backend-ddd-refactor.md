# Backend DDD Refactor 規格

## 現況

FastAPI backend 已按 domain 拆分 source documents、mock exams/question drafts、practice、runtime installations 等模組。此切片的目標是讓 OCR、draft generation、practice session 與 project persistence 能獨立測試與演進。

## 決策

- Domain code 放在 `exam_prep_backend/domains/<domain>/`。
- Endpoint path、auth、error envelope 盡量維持相容。
- Public DTO 由 owning domain 輸出；OpenAPI client 必須跟 schema 同步。
- Generated/AI draft 不自動 approved；approved-only 是 playable exam rule。

## QA 證據

- Backend pytest/ruff/OpenAPI client checks 已在後續 QA 中反覆跑過。
- OCR page failure、draft approval、practice full/random mode、wrong-answer projection 均有測試或 packaged QA 證據。

## 未解風險

- OCR worker 與 repository progress persistence 還要支援 as-completed chunk flush。
- Reasoning bakeoff harness 會新增評測入口，需避免污染 production API。
- Schema 變更後若忘記重產前端 client，會造成 UI payload drift。
