# Production PDF Upload Journey QA

Date: 2026-06-17
Scope: packaged Tauri app, installed downloadable Python backend runtime, Ollama/Gemma readiness, PaddleOCR runtime, and normal-user PDF upload flow.

## Method

- Use the built Tauri release executable instead of the Angular dev server.
- Drive the real WebView through Playwright CDP for repeatable UI actions and screenshots.
- Use PDFs from the repository `pdfs` directory.
- Record grill-me questions, recommended answers, actual evidence, UX observations, and follow-up candidates as the test runs.

## Grill-Me Question Log

### Q1. What user journey are we actually validating?

Recommended answer: A first productive user journey after runtime setup: open packaged app, confirm runtime checklist is green enough, create or select a project, upload a PDF, wait for extraction/OCR/LLM processing, and understand what to do next.

Actual answer: Validate the first productive packaged-app journey: start from a reset QA database, confirm the installed runtime stack is ready, create a project, choose the real repository PDF, upload it through the UI, wait for OCR/LLM processing, and verify that the app shows usable results without terminal-only intervention.

### Q2. Which PDF should represent normal usage?

Recommended answer: Prefer a real exam/legal-prep PDF in `pdfs`, not a synthetic tiny fixture. If both text and image-only PDFs exist, test at least one text PDF and one OCR-heavy PDF.

Actual answer: Use `pdfs/【1】2025年07月N1 真题.pdf` because it is the only PDF in `pdfs`, has a realistic non-ASCII filename, and is large enough (7,652,941 bytes) to exercise real upload/processing behavior.

### Q3. What counts as production success?

Recommended answer: The user can complete the flow without terminal intervention; runtime statuses are understandable; upload creates a document record; generated or extracted items become visible; errors, waiting states, and next actions are clear.

Actual answer: Production success is partially achieved and now better defined. The packaged app can start its bundled Python backend, reuse the installed PaddleOCR runtime, OCR the real 46-page image-only PDF, show extracted text chunks in the UI, and create deterministic manual draft candidates without Gemma. It is not yet fully practice-ready because deterministic extraction intentionally leaves answers blank; the next production success bar is an explicit review/enrichment step that lets the user complete answer/rationale data before enabling practice sessions.

### Q4. Should the user be able to use the app while parsing?

Recommended answer: Yes. A production journey should not force the user to stare at a disabled workspace for a long image-only PDF. The app should expose incremental parsing state and allow safe parallel work, such as reviewing already parsed pages, editing project metadata, reading partial extracted text, starting draft generation on completed chunks, or switching to another project.

Actual answer: This run strongly supports the need for "use while parsing." The sample PDF is 46 image-only pages, and OCR progresses page-by-page for many minutes while the UI remains globally busy. Backend work is real and moving, but the current user experience hides that progress and blocks most actions.

### Q5. Should upload capture the document language?

Recommended answer: Yes. Add a document language hint at upload time, with a safe default of `Auto` and explicit choices such as `Japanese`, `Traditional Chinese`, `Simplified Chinese`, `English`, and `Mixed`. This should be stored with the document and passed through OCR, text normalization, chunking, and LLM prompt construction.

Actual answer: Yes, but it solves a different class of problem than the UTF-8 subprocess bug found in this run. The first-run `ocr_failed` was caused by backend decoding OCR runtime JSON with the Windows default locale, not by PaddleOCR choosing the wrong language. Language metadata would still improve production quality by guiding OCR model/language selection, mixed-language post-processing, chunk validation, and LLM question generation for JLPT-style Japanese PDFs with Chinese/English annotations.

### Q6. Should extracted PDF text be usable before Gemma?

Recommended answer: Yes. The first useful product artifact should be deterministic OCR/extracted text and question-block candidates. Gemma should not sit on the critical path for "can I see what the PDF contains?"

Actual answer: Strong yes. The second run proved PaddleOCR can extract 46/46 pages and 46 text chunks from the production PDF. The unstable/slow part is the later Gemma JSON generation step. For JLPT-style PDFs, the app should first output text and deterministic question blocks, then optionally use Gemma for answer inference, rationale, cleanup, or variant generation.

## Evidence Log

- 2026-06-17: `pdfs` contains one PDF: `pdfs/【1】2025年07月N1 真题.pdf`.
- 2026-06-17: Local PDF inspection tools were not available (`pypdf` missing and `pdftoppm` not on PATH), so page/chunk/OCR facts will come from the packaged app upload response.
- 2026-06-17: Existing QA database was backed up, then reset, while keeping installed runtimes. Backup: `.agents/tmp/production-pdf-upload-db-backup-20260617-093138`.
- 2026-06-17: Packaged executable launched from `apps/exam-prep-desktop/src-tauri/target/release/exam-prep-desktop.exe` with WebView2 CDP on port 9224.
- 2026-06-17: Baseline app state: Python backend ready (`Python 3.13.5 / packaged`), Ollama ready (`gemma4:12b`, `model available`), and PaddleOCR ready (`PaddleOCR imports available`, selected device `gpu:0` from `/ocr/health`).
- 2026-06-17: Baseline screenshot captured at `.agents/tmp/production-pdf-upload/01-baseline-empty-workspace.png`.
- 2026-06-17: Created project through UI: `JLPT N1 2025-07 Production QA`; screenshot captured at `.agents/tmp/production-pdf-upload/02-project-created.png`.
- 2026-06-17: Selected the PDF through the UI file input; pre-upload screenshot captured at `.agents/tmp/production-pdf-upload/03-pdf-selected-before-upload.png`.
- 2026-06-17: Started upload through the UI; upload-start screenshot captured at `.agents/tmp/production-pdf-upload/04-upload-started.png`.
- 2026-06-17: Venv-based read-only PDF inspection shows 46 pages, 46 pages with no embedded text, and 0 extracted characters. The production upload is therefore a full OCR path, not a text-only PDF path.
- 2026-06-17: During upload, SQLite shows the project exists but no document/chunks yet, which means the backend is still in extraction/OCR before `create_document`.
- 2026-06-17: Process tree confirms the backend spawned `exam-prep-ocr-runtime.exe`; command line showed page 12 in progress with `--ocr-page ... --page-number 12 --device auto`.
- 2026-06-17: First full upload run completed in the UI but produced `ocr_failed`: 46 pages, 0 text chunks, 0 processed pages, 0 mock items. Screenshot: `.agents/tmp/production-pdf-upload/06-after-ocr-waiting-for-response.png`.
- 2026-06-17: Manual single-page OCR against installed `exam-prep-ocr-runtime.exe` succeeded for page 1, returning Japanese/English text with `paddle_ocr_gpu`, `gpu:0`, and non-empty UTF-8 JSON.
- 2026-06-17: Root cause found: backend `run_ocr_runtime_command()` decoded OCR runtime stdout/stderr with the Windows default locale because it used `subprocess.run(..., text=True)` without `encoding`. Japanese OCR JSON can raise `UnicodeDecodeError` under cp950. The upload path swallowed those page-level exceptions and stored the document as `ocr_failed`.
- 2026-06-17: Fixed backend runtime command decoding to use UTF-8 with replacement for invalid stderr bytes; added `test_ocr_runtime_command_decodes_utf8_output`.
- 2026-06-17: Verification after fix: `pnpm nx run exam-prep-backend:test` passed 58 tests.
- 2026-06-17: Rebuilt backend runtime with `pnpm nx run exam-prep-backend:build-backend-runtime` and replaced the AppData Python backend runtime. Old runtime backup: `.agents/tmp/python-backend-runtime-before-utf8-fix-20260617-100127`. Failed-run DB backup: `.agents/tmp/production-pdf-upload-db-after-ocr-failed-20260617-100127.sqlite3`.
- 2026-06-17: Second full upload run after the UTF-8 fix succeeded: document `7aa890e0-ecdf-4dac-bafd-730e9544cc1d`, project `1edb6608-39a2-4036-b5f1-076920d96e26`, 46 pages, 46 chunks, 46 processed pages, `paddle_ocr_gpu`, `gpu:0`, 26,412 ms OCR time.
- 2026-06-17: The first Gemma-based generation attempt against the full OCR text failed with invalid JSON, even though a small direct Gemma prompt could return valid JSON. This supports keeping Gemma out of the first-value path and bounding any later prompt context.
- 2026-06-17: Added prompt bounding and deterministic JLPT question-block extraction. Deterministic extraction returns manual draft candidates with blank answers instead of pretending to know an answer key.
- 2026-06-17: Added document listing and chunk reload so a restarted packaged app can select the existing project and show the latest OCR document plus extracted text chunks.
- 2026-06-17: Verification after deterministic extraction and document reload changes: `pnpm nx run exam-prep-backend:test` passed 60 tests.
- 2026-06-17: `pnpm nx run exam-prep:build --skip-nx-cache` passed. Warning: the Angular initial bundle exceeded the configured 700 kB budget by 28.53 kB.
- 2026-06-17: `pnpm nx run exam-prep-desktop:build --skip-nx-cache` passed after stopping the running release app. Artifacts: `apps/exam-prep-desktop/src-tauri/target/release/exam-prep-desktop.exe`, `apps/exam-prep-desktop/src-tauri/target/release/bundle/msi/Exam Prep_0.1.0_x64_en-US.msi`, and `apps/exam-prep-desktop/src-tauri/target/release/bundle/nsis/Exam Prep_0.1.0_x64-setup.exe`.
- 2026-06-17: Replaced the AppData Python backend runtime with the latest build for final packaged verification. Old runtime backup: `.agents/tmp/python-backend-runtime-before-deterministic-blocks-20260617-105640`.
- 2026-06-17: Final packaged restart loaded the existing project. Selecting the project showed the production PDF, 46 chunks, 46 processed pages, extracted text preview, and `paddle_ocr_gpu`. Screenshot: `.agents/tmp/production-pdf-upload/17-final-project-selected-extracted-text.png`.
- 2026-06-17: With Ollama/Gemma offline in the runtime checklist, `Regenerate mock exam` still produced 3 manual draft candidates from OCR text via deterministic question-block extraction. Screenshot: `.agents/tmp/production-pdf-upload/18-final-deterministic-drafts-without-gemma.png`.
- 2026-06-17: SQLite verification after regeneration: document status `ready`, 46 chunks, `exam_item_count=3`; question drafts total `3`, all `draft`, all `manual`, all on citation page 2, with blank answers by design.
- 2026-06-17: Refreshed UI state after reselecting the project showed `STATUS ready`, `MOCK ITEMS 3`, `EXTRACTED TEXT 46 chunks`. Screenshot: `.agents/tmp/production-pdf-upload/19-final-refreshed-document-ready.png`.
- 2026-06-17: Draft viewport screenshot captured normal review context: 3 manual draft items, 0 approved, practice session disabled. Screenshot: `.agents/tmp/production-pdf-upload/20-final-manual-draft-items-viewport.png`.

## Use Journey Observations

- First launch after runtime setup is understandable: all runtime checklist entries are green and the workspace opens.
- Project creation is straightforward and the main work area immediately exposes Source PDF, Mock Exam Items, and Practice Session.
- Once upload starts, the UI gives weak feedback. Buttons become disabled, but the top status still says `Ready`; there is no visible "Uploading", "OCR page x/y", elapsed time, or "this can take several minutes" message.
- Because this repository PDF is a realistic 46-page image-only file, a normal user would likely wonder whether the app froze during the OCR phase.
- The long-running OCR path makes "use while parsing" a product requirement, not just a nice-to-have. Users should be able to keep orienting themselves, inspect partial results, or work elsewhere while parsing continues.
- Failure state clarity needs work. The first run showed `ocr_failed`, but the UI did not expose the underlying cause; diagnosis required process inspection, manual OCR reproduction, and code tracing.
- Upload needs document-language intent. For this JLPT sample, a user likely knows it is primarily Japanese with Chinese/English support text; capturing that intent would help OCR/prompt behavior and give the user confidence that the app is handling the right language family.
- The app should not require Gemma before showing value. Extracted text and page-level chunks are already useful study material and QA evidence. Hiding them behind mock-item generation makes the successful OCR work feel like failure when Gemma times out or returns invalid JSON.
- The final run confirms that OCR text and deterministic question blocks can be useful even when Ollama/Gemma is offline. Gemma should be a later enrichment lane, not the gate before the user sees text.
- The current review workflow needs a clearer next step for manual drafts. The UI shows `manual` candidates and keeps practice disabled, which is data-safe, but the user needs an obvious path to fill answers, approve items, or run optional Gemma enrichment.
- There is a state refresh gap after draft regeneration: the backend document immediately becomes `ready` with 3 items, but the Source PDF summary did not update until the project was reselected.
- The runtime checklist needs sharper status semantics. During final verification, Ollama reported offline and Gemma detail was unavailable; the UI should avoid showing any contradictory ready/offline combination.

## UX Improvement Candidates

- Show an explicit busy status for upload, ideally with stage text: `Uploading PDF`, `Extracting text`, `Running OCR`, `Generating mock exam`.
- For image-only or OCR-heavy PDFs, surface a longer-running task state with elapsed time and cancel/retry affordances.
- Consider creating the document row earlier with `processing` status, then updating page/chunk counts as work progresses, so the UI has something concrete to show.
- Support "use while parsing" by moving PDF processing into a background job model. Recommended UI states: document appears immediately as `processing`; page/chunk counters update incrementally; completed pages can be viewed; draft generation can start from completed chunks when enough text exists; unrelated project/workspace actions stay available.
- Avoid global app busy locks for document parsing. Scope disabled states to the active upload controls and any actions that truly depend on complete parsing.
- Preserve and surface per-page OCR errors. The backend should not silently collapse all page-level exceptions into `ocr_failed` without diagnostic detail; the UI should show a concise recoverable message and keep a debug detail for QA/support.
- Add a document language field to upload. Use `Auto` by default, but let users override to Japanese/Traditional Chinese/Simplified Chinese/English/Mixed; store the choice, show it in document details, and feed it to OCR and LLM prompts. Also consider a post-OCR warning when extracted text does not match the selected language.
- Show extracted text/chunks immediately after OCR. Add a scrollable page/chunk viewer, copy affordance, and "use this page for drafts" action so the PDF parsing result is directly usable without AI.
- Add deterministic question-block extraction for structured exam PDFs. For JLPT, parse `問題` sections, numbered stems, and `1/2/3/4` choices before invoking Gemma. Gemma should be optional for answer inference, rationale, OCR repair, and generated variants.
- Collapse or compact the runtime checklist once everything is ready, leaving more first-screen room for the user's active task.
- Add a visible "Review extracted questions" step for deterministic candidates. The user should be able to edit OCR text, fill answer keys, approve/reject drafts, and then create a practice session.
- After `Regenerate mock exam`, refresh the Source PDF document summary so status and item counts do not lag behind the draft list.
- Treat model installation and model availability as separate states: Ollama app installed, Ollama server running, model downloaded, and model usable should each have clear text and action buttons.

## Product Decision: OCR First, Gemma Optional

I agree with the proposal to output text directly after PDF extraction and to cut question blocks before involving Gemma. The final packaged test validates this direction: the real PDF produced 46 OCR chunks, the UI could show those chunks directly, and deterministic JLPT parsing produced 3 reviewable question candidates while Ollama/Gemma was offline.

Recommended pipeline:

1. Upload PDF and store document metadata immediately.
2. Extract embedded text or OCR page images.
3. Show page/chunk text as the first user-visible result.
4. Run deterministic structure extraction for known exam patterns, such as JLPT numbered stems and 1/2/3/4 choices.
5. Store those as manual draft candidates when no answer key is visible.
6. Use Gemma only for optional enrichment: answer inference, rationale writing, OCR repair suggestions, deduplication, classification, and variant generation.

This reduces latency, avoids unnecessary local-model overhead, works offline from the model layer, and gives users something inspectable even when model generation fails.
