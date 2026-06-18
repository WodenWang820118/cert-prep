# Saved Parsed Exams And Runtime UX Decisions

- Approved-only 是 playable exam rule；parsed candidates 在核准前只可 review/edit。
- Full exam 等於同一 parsed document 的所有 approved items，依 source order 排序。
- Random quiz 等於 project-level approved items 的 uniform sample，session 保存 seed 以便重現。
- Deterministic classification 優先於 Gemma/reasoning；低信心結果留給人工 review。
- `question_drafts` 暫時仍是 item bank；等 grouped passage 需求超過 `group_key/group_prompt` 能力時才考慮新表。
- Runtime UI 採 compact header chips + drawer；縮小畫面佔用但保留 explicit install/download consent。
- Root agent 負責 coordination、report、TODO sync、final QA；domain workers 負責 backend/frontend/QA bounded implementation。
