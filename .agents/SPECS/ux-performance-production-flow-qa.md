# UX Performance Production Flow QA

Date: 2026-06-17

## Scope

Packaged Tauri production verification for the async parsing to wrong-answer
cleanup flow.

- Build target: `pnpm nx run exam-prep-desktop:build-gpu --skip-nx-cache`
- Release exe: `apps/exam-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/exam-prep-desktop.exe`
- QA data root: `.agents/tmp/ux-performance-production-flow/20260617-143827`
- PDF: `pdfs/【1】2025年07月N1 真题.pdf`
- AppData state: SQLite DB and uploads reset before the run; Python backend
  runtime reset; existing PaddleOCR runtime kept.

## Result

The production journey is functional for the OCR-first/manual path:

- Python backend runtime can be installed from the UI and starts successfully.
- PaddleOCR is detected as ready.
- A clean project can upload the JLPT PDF with `language_hint=ja`.
- The upload returns a visible `processing` document quickly.
- The source panel updates page progress and chunks while parsing continues.
- Parsing finishes as `ready` with `46/46` pages and `46` chunks.
- Manual draft review works without Gemma: edit answer/rationale, save and
  approve.
- Practice can use the approved draft.
- A wrong attempt appears in Wrong Answers.
- A later correct attempt clears the wrong-answer panel.

Ollama/Gemma was not fully production-verified in this run. The checklist showed
Ollama offline with a download URL, and `gemma4:12b` remained unavailable. This
run validates that the product can still complete the core OCR/manual workflow
without Gemma, but the Ollama install + model download CTA needs a dedicated
follow-up run on a machine state where Ollama is missing or installable.

## Metrics

| Step | Observed value |
| --- | --- |
| Python runtime install | 5.7s after the local release manifest was corrected |
| Upload response / first processing render | Under 2s, visible immediately after selecting Upload PDF |
| First chunk visible | About 22s after parsing started |
| Full parsing wall time | 18m 19s for 46 pages |
| OCR engine reported time | 27,303ms, `paddle_ocr_gpu`, `gpu:0` |
| Draft generation | Perceived immediate for manual OCR chunk drafts; not a bottleneck |
| Manual edit and approve | Completed in the packaged app; screenshot delta 33s including human-style input |
| Wrong-answer recording | Wrong attempt persisted and panel showed `1 recorded` |
| Correct-answer cleanup | 1.4s from new session creation to `0 recorded` in the wrong-answer panel |

Important performance finding: the UI wall clock was 18m 19s while the OCR
engine reported 27.3s. The likely bottleneck is orchestration overhead around
page rendering, process startup, IPC, or serial page handling rather than pure
OCR inference. The progress UI makes the wait survivable, but the critical
performance follow-up is a persistent/batched OCR worker or parallel page
pipeline.

## Screenshots

Screenshots are stored under
`.agents/tmp/ux-performance-production-flow/20260617-143827/`.

- `01-runtime-missing-or-ready.png`
- `02-python-runtime-install-started.png`
- `03-runtime-checklist-ready.png`
- `04-runtime-checklist-refreshed.png`
- `05-project-created.png`
- `06-pdf-selected-language-hint.png`
- `07-parsing-started-progress-visible.png`
- `08-mid-parsing-chunks-visible-ui-usable.png`
- `09-parsing-complete.png`
- `10-draft-edit-form.png`
- `11-approved-draft.png`
- `12-practice-wrong-answer.png`
- `13-wrong-answer-panel-populated.png`
- `14-corrected-answer-wrong-answer-cleared.png`

`03a-runtime-install-timeout.png` records a QA-only release-manifest encoding
failure. The target release manifest was first patched with a UTF-8 BOM, which
the runtime manifest parser rejected. Rewriting it as UTF-8 without BOM fixed
the issue. This was not a source code failure, but it argues for friendlier
manifest parse errors.

## DB Evidence

Final clean-run SQLite state:

- `documents.status=ready`
- `documents.page_count=46`
- `documents.processed_page_count=46`
- `documents.exam_item_count=3`
- `documents.language_hint=ja`
- `documents.extraction_method=paddle_ocr_gpu`
- `documents.ocr_device=gpu:0`
- First draft `status=approved`, `answer_key_source=manual`
- Practice attempts:
  - selected `2 よか`, `is_correct=0`
  - selected `1 ようか`, `is_correct=1`
- Wrong-answer panel ended at `0 recorded`

## Use Journey Notes

The new async parsing behavior changes the first impression in the right
direction. Upload no longer feels like a frozen app: the document appears,
progress moves, and chunks are usable before completion.

The source panel is still too tall for a production learning workflow. Even with
the six-chunk preview, the first screen is dominated by OCR text. After parsing,
the next primary action is draft review, so the source text should collapse more
aggressively or move behind a tab/detail drawer.

The runtime checklist is much clearer than a single ready/offline state. Python,
Ollama, model, and PaddleOCR are visually separated. The remaining UX gap is
that an offline Ollama state can still feel like a dead end; the user sees a URL
but not a guided install/launch/download sequence.

Manual draft editing is a credible production fallback. The concrete blockers
are understandable: missing answer and missing rationale were shown before
approval, and `Save & approve` correctly combined PATCH then approve.

Practice and wrong-answer cleanup are conceptually clear. The copy now explains
that answering correctly later clears the item, and the final state proved that
behavior.

## Grill-Me Notes

Question: Should users be able to use the app while parsing is still running?

Answer: Yes. This run proves progress and chunk preview can appear during
parsing. The next step is to make this more intentional: allow draft generation
from completed chunks, keep source text lightweight, and let users move to review
without waiting for all pages when enough chunks exist.

Question: Should upload require or encourage a language hint?

Answer: It should remain optional but visible. `ja` was useful as explicit
intent for this PDF and should reduce wrong OCR/model choices later. It will not
by itself prevent mojibake or OCR mistakes, but it gives the pipeline a durable
signal for future OCR language selection and draft parsing heuristics.

Question: Can extracted PDF/OCR text become usable questions without Gemma?

Answer: Yes. For structured exam PDFs, the OCR-first/manual path is the best
default: split candidate question blocks, let the user fill answer/rationale,
and avoid AI overhead until enrichment is needed. Gemma should be optional for
cleanup, explanations, and more complex extraction, not required for the first
usable draft.

Question: What is the biggest UX risk now?

Answer: The app can technically continue while parsing, but the user may not see
where to go next because the source panel occupies too much vertical space. A
stepper, sticky next-action bar, or split review workspace would make the journey
more obvious.

Question: What is the biggest performance risk now?

Answer: Full parsing time. The progress UI works, but 18m 19s for 46 pages is
too long for repeated use. The measured gap between wall time and OCR engine
time points at orchestration, not model speed alone.

## Follow-Up Candidates

1. Add a first-class "use while parsing" workflow: generate reviewable drafts
   from completed chunks and keep updating the document in the background.
2. Collapse completed source chunks by default and add a "Review drafts" sticky
   action after first chunks are available.
3. Add a guided Ollama journey: install, launch/check server, download
   `gemma4:12b`, and show model download progress.
4. Treat language hint as an OCR/parser input, not only persisted metadata.
5. Replace per-page/process OCR orchestration with a persistent worker, batch
   mode, or bounded parallel page pipeline.
6. Add a manifest validation preflight to catch BOM/invalid JSON before release
   QA.
7. Add practice session completion state updates; sessions currently remain
   `active` after all questions are answered.
