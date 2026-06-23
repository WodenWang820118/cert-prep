# Desktop Refactor (apps/cert-prep-desktop) TODO

## Duplicated Constants

- [ ] Replace hardcoded `DEFAULT_OLLAMA_MODEL` in `backend_process.rs` with a value derived from the Python backend config or a shared build artifact. Currently `"qwen3.5:4b"` is hardcoded in both Rust and Python.
  Affected: `apps/cert-prep-desktop/src-tauri/src/backend_process.rs`
  Verify: `rg "qwen3.5:4b" apps/ packages/ --no-heading` (should find only one canonical definition after backend-refactor is complete)

## Redundant Nx Target

- [x] Investigate and remove the duplicate `build-gpu` target in `project.json`. It is identical to `build-windowsml` - same command, same dependsOn, same outputs. If they serve different purposes, add comments; otherwise remove the redundant one.
  Affected: `apps/cert-prep-desktop/project.json`
  Verify: `pnpm nx show project cert-prep-desktop --json | python -c "import json,sys; t=json.load(sys.stdin)['targets']; print([k for k in t if 'build' in k])"`

## Declarative Backend Environment

- [x] Refactor `launch_backend_entrypoint()` in `backend_process.rs` to use a declarative map/struct for environment variables instead of a long chain of `.env()` calls. This improves readability and makes it easier to audit which env vars are passed.
  Affected: `apps/cert-prep-desktop/src-tauri/src/backend_process.rs`
  Verify: `cargo build --manifest-path apps/cert-prep-desktop/src-tauri/Cargo.toml`

## Final Check

- [ ] Cargo build + lint gate:
  Verify: `cargo build --manifest-path apps/cert-prep-desktop/src-tauri/Cargo.toml && pnpm nx run cert-prep-desktop:lint`
