# Streaming Parse To Qwen QA

No implementation evidence yet. This file is reserved for artifact-backed
results once the research plan moves into a prototype or product slice.

Initial research decision on 2026-06-19:

- Do not add Kafka or another external broker for the first local-first version.
- Use a SQLite-backed local job queue/outbox and bounded qwen worker.
- Keep qwen output draft-only and approval-gated.
- Treat Ollama/model unavailability as an environment blocker.
