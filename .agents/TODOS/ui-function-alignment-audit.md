# UI / Function Alignment Audit

Date: 2026-07-02

## Outcome

The first pass began as an audit-only matrix. The 2026-07-02 correction pass
has now closed the two high-priority findings from that matrix.

The current UI is mostly wired to Angular stores and the generated API client.
The main follow-up work is not wholesale wiring; it is tightening a few product
alignment seams and adding coverage where UI claims are broader than the tests.

## Method

- Root agent inspected Nx project configuration, existing workbench specs,
  design references, e2e coverage, and shared app-level behavior.
- Four read-only sub-agents audited disjoint slices:
  - W1: Build, Source Import, Draft Review.
  - W2: Full Exam, Random Quiz, Practice flow.
  - W3: Runtime modal/route, model health, desktop/runtime install surfaces.
  - W4: Wrong Answers, shell chrome, project rail, shared stores.
- Runtime is treated as two surfaces: topbar modal is canonical, `/runtime` is a
  compatibility route.
- Placeholder UI is classified, not fixed: Settings, Account, footer links, and
  Mark for review.

## Consolidated Matrix

| Surface / location | UI claim / state | Design ref | Template / store / API evidence | Acceptance signal | Design parity | Wiring | Coverage | Severity | Recommended next slice | Touched files if fixed |
|---|---|---|---|---|---|---|---|---|---|---|
| Build `/build` | Header, runtime chips, workspace banner, Source PDF and Mock Exam Items workbench | `.agents/SPECS/workbench-screen-alignment.md` Build section | `build-workbench.page.html`; `ModelHealthComponent`; `SourceImportPanelComponent`; `DraftReviewPanelComponent` | Page/component smoke specs and e2e happy path touch this route | match | wired | partial | low | Add assertions for runtime chip region and responsive two-column behavior | `apps/cert-prep/src/app/pages/build-workbench/*` |
| Build startup/project load | Selecting or restoring a project loads latest document, drafts, and review data | Preserve existing stores | `WorkspaceFacade.selectProject()` resets and loads source import, drafts, review; `App.applyStartupProjectSelection()` restores last project | `app-project-selection.spec.ts` covers startup selection | match | wired | covered | low | None unless regression appears | none |
| Source Import upload | Choose PDF, language hint, upload action, file/status row | Source PDF workbench | `source-import-panel.component.ts`; `SourceImportStore.canUpload()`; generated client document upload endpoint | e2e uploads a mocked PDF; component specs cover readiness gating | match | wired | partial | medium | Add focused upload success spec for `FormData`, `language_hint`, document upsert, and draft reload | `components/source-import-panel/*`, `stores/source-import/*` |
| Source Import parsing/progress | Parsing stage, progress bar, page/chunk metrics, preview chunks, Show more | Progress and dense workbench cards | `SourceImportStore.refreshUploadedDocument()`, polling, preview limit; `DocumentParsingMetricsService` | Source import specs cover progress, first-chunk polling, OCR readiness | match | wired | covered except Show more interaction | low | Add chunk preview/show-more component assertion | `components/source-import-panel/source-import-panel.component.spec.ts` |
| Draft generation | Question count, Generate questions, streaming job summary, retry skipped/failed jobs | Mock Exam Items workbench | `DraftReviewStore.generateDrafts()`, job polling, retry API calls | Draft generation and streaming job specs cover payloads/retry | match | wired | covered | low | None unless strategy selection becomes UI-controlled | none |
| Draft card playability | UI distinguishes playable approved drafts from defensive non-playable rows; practice counts only approved drafts | Preserve behavior, accurate workbench content | `DraftReviewStore.playableQuestions()` filters `approved`; `draftStatusLabel()` drives Draft Review labels; Practice uses playable questions for counts and active question lookup; backend currently emits only `approved` by contract | Store/component specs cover approved rows and defensive non-approved frontend handling | match | wired | frontend covered | done | Completed 2026-07-02 for frontend alignment; no backend contract change | `stores/draft-review/*`, `components/draft-review-panel/*`, `stores/practice/*` |
| Draft edit/save | Edit question, choices, answer, rationale; Save/Cancel persists changes | Editable mock item review | `DraftReviewStore.startEdit/saveDraft()`; `DraftEditService.updatePayload()`; generated update draft endpoint | Store spec covers save payload and exiting edit mode | match | wired | covered at store level | low | Add component interaction spec only if WebView smoke remains flaky | `components/draft-review-panel/*` |
| Full Exam page | `/full-exam` renders shared practice runner in `full_document` mode | Full Exam page requirements | `full-exam.page.html`; `PracticePanelComponent.sessionMode`; route config | Page smoke spec and store payload spec | match | wired | partial | low | Add richer full-exam component assertions around document selector and metrics | `pages/full-exam/*`, `components/practice-panel/*` |
| Random Quiz page | Reuses Full Exam runner and keeps random draw controls | Random Quiz inherits Full Exam | `random-quiz.page.html`; shared `PracticePanelComponent`; mode-specific count input | Random page/component smoke specs; e2e starts random quiz | match | wired | covered for happy path | low | None unless random-mode UX changes | none |
| Practice setup/runner | Source selector or draw size, metrics, stable answer rows, Submit answer | Full Exam runner requirements | `practice-panel.component.html`; `PracticeStore.createPracticeSession()` and `submitAnswer()` | Store specs cover payloads; e2e records a wrong answer | match | wired | partial | medium | Add active-session component spec for answer selection, clear, submit disabled states, and navigator state | `components/practice-panel/*`, `stores/practice/*` |
| Practice rail | Session Details and Question Navigator render even before useful session state | Rail should appear when session active or useful state exists | `practice-panel.component.html` always renders rail with `Not started` / `Ready` / `0/0` | No direct assertion for useful-state gating | partial | product-gap | gap | low | Decide whether to hide or keep inactive rail; add spec for chosen behavior | `components/practice-panel/*` |
| Mark for review | Visible but disabled practice action | No explicit current requirement | Disabled button in `practice-panel.component.html` | No functional or policy spec | placeholder | placeholder | gap | low | Grill-me/product decision: keep marker or define real review flag feature | `components/practice-panel/*`, backend if feature is real |
| Runtime topbar modal | Manage runtime opens canonical modal with Python Backend, LLM Runtime, Reasoning Model, OCR, Refresh all, Cancel/close | Runtime modal requirement | `app.html`; `App.openRuntimeManager()`; `runtime-manager.page.html` | `app.spec.ts`, `runtime-manager.page.spec.ts`, consent specs | match | wired | covered | low | None | none |
| `/runtime` compatibility route | Deep link shows runtime details before backend/project gating but omits Cancel/close route controls | Route may remain compatibility surface | `app.routes.ts`; `app.html` special-cases runtime route; `RuntimeManagerPage.modal=false` hides close controls | Route and runtime specs lock current behavior | partial | wired | covered | medium | Decide whether route exception is documented enough or should match modal controls more closely | `pages/runtime-manager/*`, `app.*` |
| ModelHealth standalone Manage button | Standalone component navigates to `/runtime`, while canonical shell action opens modal | Runtime modal is canonical | `ModelHealthComponent.openRuntimeManager()` navigates to route; Build passes `showManageButton=false` | Model health spec expects navigation | partial | wired | covered | medium | Decide whether standalone manage action should emit/open modal or keep route fallback | `components/model-health/*`, `app.*` |
| Runtime install/download actions | Python runtime install, Ollama/model download, OCR runtime install, refresh/polling | Existing install/download/refresh actions remain available | `DesktopRuntimeStore`; `HealthStore`; runtime consent dialogs; generated runtime/model endpoints | Runtime/model health specs cover many consent and polling paths | match | wired | partial | medium | Add direct desktop runtime store coverage for start/poll/failure/manual refresh and `waiting_for_user` runtime jobs | `stores/desktop-runtime/*`, `stores/health/*` |
| Global operation success strip | Routine success messages no longer render globally; global shell keeps errors and active work only | Spec says global strips only for blocking errors or active work | `app.html` renders only `operations.error()` and `operations.busy()` strips; `OperationStore` still records status for local consumers | `app.spec.ts` asserts routine success is not rendered as a global strip | match | wired | covered | done | Completed 2026-07-02 | `app.html`, `app.spec.ts` |
| Shell placeholders | Settings, Account, footer links are disabled design parity markers | Existing spec checkpoint says these are placeholders, open risk says decide future | Disabled buttons in `app.html`; footer spans with `aria-disabled=true` | No direct policy assertion | placeholder | placeholder | gap | low | Grill-me/product decision: keep markers for now or promote to real surfaces | `app.html`, `app.spec.ts` if policy locked |
| Project rail | Local Workspace/Projects rail supports create/select project | Workbench side rail | `project-rail.component.html`; `ProjectStore.createProject/selectProject()` | E2E creates project; store specs cover create/select; component spec only empty state | match | wired | partial | low | Add project rail interaction component spec if shell regressions recur | `components/project-rail/*` |
| Wrong Answers review | `/review` shows recorded count, refresh, cards, page chips, answer comparison, rationale/source, footer guidance | Wrong Answers review requirement | `wrong-answer-review.component.html`; `WrongAnswerReviewStore.load/refresh()`; generated wrong-answer API | Store specs cover load/refresh; e2e checks correct answer and rationale only | match | wired | partial | medium | Add populated-card component/e2e assertions for count, page chip, selected answer, source excerpt, footer guidance | `components/wrong-answer-review/*`, `apps/cert-prep-e2e/src/support/*` |

## Prioritized Follow-Up Slices

Completed:

- **Playable draft/status boundary** (2026-07-02): approved drafts are the only
  playable questions; Practice counts and active question lookup use playable
  questions. Draft Review has defensive non-playable labeling for future or
  legacy rows, while the current backend contract still emits only `approved`.
- **Global operation strip alignment** (2026-07-02): App shell no longer renders
  routine success globally; blocking errors and active work remain global.

Remaining:

1. **Runtime surface policy**
   - Decide whether `/runtime` remains a route-mode exception or fully matches
     modal controls.
   - Decide whether standalone model-health Manage opens the modal or keeps
     route navigation as compatibility behavior.

2. **Practice and review coverage**
   - Add component/e2e assertions for active answer flow, navigator state,
     populated wrong-answer cards, source/page metadata, and footer guidance.

3. **Placeholder policy**
   - Decide whether Settings, Account, footer links, and Mark for review remain
     disabled design markers or become real product surfaces.

## Current Verification Baseline

Current Nx targets:

- `cert-prep:test`
- `cert-prep:lint`
- `cert-prep:build`
- `cert-prep-e2e:e2e`

Current e2e coverage is intentionally narrow:

- Mocked local practice loop: project creation, runtime status, PDF upload,
  draft display, random quiz, wrong answer submission, Review navigation.
- Runtime route before project creation.

Recommended verification for later UI/function slices:

- `pnpm nx run cert-prep:test --skip-nx-cache`
- `pnpm nx run cert-prep:lint --skip-nx-cache`
- `pnpm nx run cert-prep-e2e:e2e --skip-nx-cache`
- Playwright screenshots for Build, Practice, Runtime, and Review when visual
  behavior changes.

## Grill-Me Gate

First product question for the next turn:

Should disabled placeholders remain non-interactive parity markers for now, or
should any become real features in the next implementation slice?

Recommended answer: keep Settings, Account, and footer links as placeholders for
now; only consider `Mark for review` after the playable-draft/status boundary is
fixed, because practice eligibility and review semantics should be stable first.

## Notes

- No public API, database schema, or generated contract changes were made in
  the 2026-07-02 correction pass.
- Functional source changes are limited to the frontend draft/playability and
  app-shell operation-strip alignment slices recorded above.
- This TODO is intentionally active. Once follow-up slices are completed, merge
  the durable outcome back into `.agents/SPECS/workbench-screen-alignment.md`
  or a successor spec and remove this TODO.
