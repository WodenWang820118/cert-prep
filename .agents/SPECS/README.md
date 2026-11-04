# Cert Prep Specs

This folder is the durable product memory for Cert Prep. Each file describes
current behaviour and the decisions behind it; a decision is recorded in the
spec of the area it governs, not in a separate decision file. The per-context
domain model (backend contexts, aggregates, use cases) is in
[`docs/domain/`](../../docs/domain/README.md), and the DDD plan and its
decisions are in [`.agents/PLANS/ddd-refactor/`](../PLANS/ddd-refactor/README.md).

## Domain specs

- `domains/product-ux.md` - product baseline, UI system, workbench screens,
  source import, practice and review.
- `domains/parsing-reasoning.md` - extraction ownership, Ollama reasoning,
  provider policy and recovery.
- `domains/capture-runtime-integration.md` - the Capture Runtime consumer
  contract: SDK boundary, OCR-only admission and mapping, compute preflight,
  review, OCR summary, desktop boundary and verification.
- `domains/audio-transcription-translation.md` - audio capture and Traditional
  Chinese translation.
- `domains/runtime-packaging.md` - Tauri packaging, bundled runtimes, lifecycle
  and release evidence.
- `domains/backend-architecture.md` - backend contracts, persistence and
  generated-client rules.
- `domains/workspace-governance.md` - naming, package manager and Nx
  conventions, refactor slicing, documentation rules and agent routing.

## Feature specs

- `lazy-capture-runtime-installation.md` - explicit Capture Runtime install
  and start, versioned runtime slots and the refresh after an app update.
- `cert-prep-pdf-image-acceptance.md` - the real OCR acceptance gate
  (`cert-prep-desktop:acceptance-real`) and its inputs.
- `packaged-capture-workbench-smoke.md` - the standalone packaged Capture
  Workbench smoke.
- `long-running-operation-sse.md` - authenticated snapshot SSE for document,
  draft, runtime and model-download operations.
- `angular-resource-migration.md` - `httpResource` reads beside the generated
  Promise client.
- `desktop-cdp-stack-overflow.md` - the desktop's 8 MiB main-thread stack
  reserve and its probe.

## Active backlog

Open work is in [`.agents/TODOS/`](../TODOS/README.md) or in GitHub issues.
When a TODO is finished, move any durable behaviour into the spec that owns it
and delete the TODO.
