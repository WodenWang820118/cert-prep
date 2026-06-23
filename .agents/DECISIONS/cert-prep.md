# Local Cert Prep Desktop App Decisions

## Accepted Decisions

- Use a new cert-prep app family beside the existing shop sample.
- Use `pnpm@10.33.2`; do not mix npm and pnpm after migration.
- Use managed local Ollama: detect installed/running Ollama and guide users to pull `gemma4:12b`.
- Use selectable-text PDFs first; scanned/image-only PDFs are explicitly unsupported in v1.
- Support multiple-choice questions only in v1.
- Save AI output as cited drafts requiring user approval before practice.
- Store state locally in SQLite owned by the Python backend.
- Store original PDFs by SHA-256 under the app data directory.
- Use OpenAPI as the backend/frontend contract source.
- Use fake LLM providers for deterministic automated tests.
- Use `pypdf` for v1 selectable-text PDF extraction.
- Use PyInstaller to build the Python backend sidecar executable for packaged desktop builds.
- Use backend-owned versioned SQLite migrations.
- Tauri owns sidecar startup, readiness polling, local token generation, and backend config handoff to Angular.
- Commit each phase separately after verification.

## Rejected Or Deferred Options

- Fully bundling Ollama and Gemma 4 12B: deferred because installer size and platform complexity are high.
- OCR in v1: deferred to keep the first loop reliable and testable.
- Vision-based page extraction in v1: deferred because it is slower and harder to verify deterministically.
- Auto-activating AI questions: rejected because bad extractions would pollute practice.
- Retrofitting the existing shop app/API: rejected to keep starter code isolated and avoid accidental regressions.
- PyMuPDF in v1: rejected because AGPL/commercial licensing creates distribution risk for the desktop app.

## Guardrails

- No large god services or catch-all utility modules.
- No direct filesystem or SQLite access from Angular.
- No live LLM calls in deterministic tests.
- No question approval without citation fields and source excerpt.
- No broad cleanup of unrelated starter code during feature phases.

## References

- Ollama model: https://ollama.com/library/gemma4:12b
- Ollama structured outputs: https://docs.ollama.com/capabilities/structured-outputs
- Tauri sidecars: https://v2.tauri.app/develop/sidecar/
- Tauri config: https://v2.tauri.app/reference/config/
- pnpm workspaces: https://pnpm.io/10.x/workspaces
- pypdf package/license metadata: https://pypi.org/project/pypdf/
- PyInstaller package support: https://pypi.org/project/PyInstaller/
