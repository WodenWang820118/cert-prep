import type { Page, Route } from '@playwright/test';
import type {
  DocumentRead,
  HealthResponse,
  LLMHealthRead,
  LLMProviderSelectionRead,
  OCRHealthRead,
  PracticeAttemptCreate,
  PracticeAttemptRead,
  PracticeSessionCreate,
  PracticeSessionList,
  PracticeSessionRead,
  ProjectRead,
  QuestionDraftRead,
  RuntimeRequirementsRead,
  WrongAnswerExplanationRead,
  WrongAnswerRead,
  WrongAnswerSummaryRead,
} from '@cert-prep/api';

export const apiBaseUrl = 'http://127.0.0.1:8765';
export const devToken = 'cert-prep-local-dev-token';

export type CompleteQuestionDraft = QuestionDraftRead & {
  readonly answer: string;
  readonly document_id: string;
  readonly rationale: string;
};

export type CompleteQuestionDraftWithExcerpt = CompleteQuestionDraft & {
  readonly source_excerpt: string;
};

export type MockWrongAnswerExplanationRead = WrongAnswerExplanationRead;

export interface MockUploadedSourceFile {
  readonly bytes: Buffer;
  readonly contentType: string | null;
  readonly filename: string;
}

export interface MockCertPrepApi {
  readonly project: ProjectRead;
  readonly secondaryProject: ProjectRead;
  readonly document: DocumentRead;
  readonly secondaryDocument: DocumentRead;
  readonly documents: readonly DocumentRead[];
  readonly draft: CompleteQuestionDraftWithExcerpt;
  readonly secondaryDraft: CompleteQuestionDraftWithExcerpt;
  readonly drafts: readonly QuestionDraftRead[];
  readonly playableDrafts: readonly CompleteQuestionDraft[];
  readonly secondaryPlayableDrafts: readonly CompleteQuestionDraft[];
  readonly incompleteApprovedDrafts: readonly QuestionDraftRead[];
  readonly fullExamDocument: DocumentRead;
  attempts(projectId?: string): readonly PracticeAttemptRead[];
  currentSession(projectId?: string): PracticeSessionRead | null;
  markRequestLog(): number;
  playableDraftsForDocument(
    documentId: string,
    projectId?: string,
  ): readonly CompleteQuestionDraft[];
  practiceSessionPayload(projectId?: string): PracticeSessionCreate | null;
  practiceSessionPayloads(projectId?: string): readonly PracticeSessionCreate[];
  requestLog(): readonly string[];
  requestLogSince(marker: number): readonly string[];
  seenPaths(): Set<string>;
  uploadedDocuments(projectId?: string): readonly DocumentRead[];
  uploadedSourceFiles(projectId?: string): readonly MockUploadedSourceFile[];
  wrongAnswerExplanations(
    projectId?: string,
  ): readonly MockWrongAnswerExplanationRead[];
  wrongAnswers(projectId?: string): readonly WrongAnswerRead[];
  wrongAnswerSummary(projectId?: string): WrongAnswerSummaryRead;
}

interface MockProjectState {
  readonly project: ProjectRead;
  readonly document: DocumentRead;
  readonly documents: readonly DocumentRead[];
  readonly draft: CompleteQuestionDraftWithExcerpt;
  readonly drafts: readonly QuestionDraftRead[];
  readonly playableDrafts: readonly CompleteQuestionDraft[];
  readonly incompleteApprovedDrafts: readonly QuestionDraftRead[];
  readonly fullExamDocument: DocumentRead;
  readonly uploadedDocuments: DocumentRead[];
  readonly uploadedSourceFiles: MockUploadedSourceFile[];
  readonly sessions: Map<string, PracticeSessionRead>;
  readonly practiceSessionPayloads: PracticeSessionCreate[];
  readonly attempts: PracticeAttemptRead[];
  readonly wrongAnswerExplanations: MockWrongAnswerExplanationRead[];
  readonly wrongAnswers: WrongAnswerRead[];
  documentUploaded: boolean;
  currentSession: PracticeSessionRead | null;
  practiceSessionPayload: PracticeSessionCreate | null;
  sessionCounter: number;
  attemptCounter: number;
}

export async function installMockCertPrepApi(
  page: Page,
): Promise<MockCertPrepApi> {
  const project = {
    id: 'project-1',
    name: 'JLPT_N1',
    description: '2025 N1 mock exam',
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
  } satisfies ProjectRead;

  const documents = [
    documentRead(project.id, {
      id: 'document-1',
      filename: 'jlpt-n1-vocabulary.pdf',
      sha256: 'document-1-sha',
      page_count: 3,
      processed_page_count: 3,
      exam_item_count: 3,
      chunks_count: 3,
    }),
    documentRead(project.id, {
      id: 'document-2',
      filename: 'jlpt-n1-reading.pdf',
      sha256: 'document-2-sha',
      page_count: 4,
      processed_page_count: 4,
      exam_item_count: 2,
      chunks_count: 4,
    }),
    documentRead(project.id, {
      id: 'document-3',
      filename: 'jlpt-n1-incomplete-outline.pdf',
      sha256: 'document-3-sha',
      page_count: 1,
      processed_page_count: 1,
      exam_item_count: 1,
      chunks_count: 1,
    }),
  ] as const satisfies readonly DocumentRead[];

  const drafts = [
    completeDraft(project.id, documents[0].id, {
      id: 'draft-1',
      chunk_id: 'chunk-1',
      question: 'Which access control principle is cited by the source?',
      choices: [
        'Apply least privilege',
        'Ignore the cited source',
        'Choose an unrelated control',
        'Remove all safeguards',
      ],
      answer: 'Apply least privilege',
      rationale: 'Least privilege keeps permissions scoped to the task.',
      citation_page: 1,
      source_excerpt: 'Least privilege limits access to required permissions.',
      source_order: 10001,
      source_question_number: '1',
    }),
    completeDraft(project.id, documents[0].id, {
      id: 'draft-2',
      chunk_id: 'chunk-2',
      question: 'What should a learner verify before trusting an OCR answer?',
      choices: [
        'The cited page and excerpt',
        'Only the model name',
        'The color of the button',
        'A random confidence number',
      ],
      answer: 'The cited page and excerpt',
      rationale: 'Grounded review depends on checking the source citation.',
      citation_page: 2,
      source_excerpt: 'Review every answer against the cited source page.',
      source_order: 10002,
      source_question_number: '2',
    }),
    completeDraft(project.id, documents[0].id, {
      id: 'draft-source-excerpt-only',
      chunk_id: 'chunk-source-only',
      question: 'Which evidence is enough when page metadata is unavailable?',
      choices: [
        'A nonempty source excerpt',
        'An empty review note',
        'A missing answer key',
        'An unrelated project name',
      ],
      answer: 'A nonempty source excerpt',
      rationale:
        'The product accepts source excerpts as grounding even without a citation page.',
      citation_page: null,
      source_excerpt:
        'A source excerpt can ground a playable question without page metadata.',
      source_order: 10003,
      source_question_number: '3',
    }),
    completeDraft(project.id, documents[1].id, {
      id: 'draft-3',
      chunk_id: 'chunk-3',
      question: 'Which study action best matches a full exam review?',
      choices: [
        'Complete every question from the selected document',
        'Mix questions from unrelated PDFs',
        'Skip questions with citations',
        'Answer only the first item',
      ],
      answer: 'Complete every question from the selected document',
      rationale: 'Full exam mode is document-scoped.',
      citation_page: 1,
      source_excerpt: 'Full exam sessions use questions from one document.',
      source_order: 20001,
      source_question_number: '1',
    }),
    completeDraft(project.id, documents[1].id, {
      id: 'draft-4',
      chunk_id: 'chunk-4',
      question: 'What does the source say to preserve after a wrong answer?',
      choices: [
        'The selected answer and the correct answer',
        'Only the session title',
        'A blank review card',
        'The upload button state',
      ],
      answer: 'The selected answer and the correct answer',
      rationale:
        'Wrong-answer review compares the selected and correct answers.',
      citation_page: 3,
      source_excerpt:
        'Store wrong attempts with both selected and correct answers.',
      source_order: 20002,
      source_question_number: '2',
    }),
    incompleteDraft(project.id, documents[0].id, {
      id: 'draft-approved-missing-answer',
      chunk_id: 'chunk-incomplete-1',
      question: 'Approved-looking draft missing an answer',
      answer: null,
      rationale: 'This row is deliberately incomplete.',
      source_excerpt: 'It has a source but no selected correct answer.',
      citation_page: 3,
      source_order: 10003,
    }),
    incompleteDraft(project.id, documents[1].id, {
      id: 'draft-approved-answer-not-in-choices',
      chunk_id: 'chunk-incomplete-2',
      question: 'Approved-looking draft with an answer outside the choices',
      choices: ['Choice A', 'Choice B', 'Choice C', 'Choice D'],
      answer: 'Choice E',
      rationale: 'This row should not be playable.',
      source_excerpt: 'The answer key points outside the listed choices.',
      citation_page: 4,
      source_order: 20003,
    }),
    incompleteDraft(project.id, documents[2].id, {
      id: 'draft-approved-missing-source',
      chunk_id: 'chunk-incomplete-3',
      question: 'Approved-looking draft missing source grounding',
      answer: 'Choice A',
      rationale: null,
      source_excerpt: null,
      citation_page: null,
      source_order: 30001,
    }),
  ] as const satisfies readonly QuestionDraftRead[];

  const playableDrafts = drafts.filter(isCompletePlayableDraft);
  const incompleteApprovedDrafts = drafts.filter(
    (draft) => !isCompletePlayableDraft(draft),
  );
  const primaryDraft = playableDrafts.find(hasSourceExcerpt);
  if (primaryDraft === undefined) {
    throw new Error('Mock API requires at least one playable draft excerpt.');
  }

  const secondaryProject = {
    id: 'project-2',
    name: 'JLPT_N2',
    description: '2025 N2 mock exam',
    created_at: '2026-06-10T00:00:00Z',
    updated_at: '2026-06-10T00:00:00Z',
  } satisfies ProjectRead;
  const secondaryDocuments = [
    documentRead(secondaryProject.id, {
      id: 'document-4',
      filename: 'jlpt-n2-grammar.pdf',
      sha256: 'document-4-sha',
      page_count: 2,
      processed_page_count: 2,
      exam_item_count: 1,
      chunks_count: 2,
    }),
  ] as const satisfies readonly DocumentRead[];
  const secondaryDrafts = [
    completeDraft(secondaryProject.id, secondaryDocuments[0].id, {
      id: 'draft-project-2-1',
      chunk_id: 'chunk-project-2-1',
      question: 'Which grammar review habit belongs to the second project?',
      choices: [
        'Keep the second project isolated',
        'Reuse the first project session',
        'Submit the old PDF document id',
        'Mix unrelated review cards',
      ],
      answer: 'Keep the second project isolated',
      rationale: 'Project switching must load only the selected project data.',
      citation_page: 1,
      source_excerpt: 'Project isolation keeps sessions and review scoped.',
      source_order: 40001,
      source_question_number: '1',
    }),
  ] as const satisfies readonly QuestionDraftRead[];
  const secondaryPlayableDrafts = secondaryDrafts.filter(
    isCompletePlayableDraft,
  );
  const secondaryDraft = secondaryPlayableDrafts.find(hasSourceExcerpt);
  if (secondaryDraft === undefined) {
    throw new Error('Mock API requires a secondary playable draft excerpt.');
  }

  const primaryState = createMockProjectState({
    project,
    document: documents[0],
    documents,
    draft: primaryDraft,
    drafts,
    playableDrafts,
    incompleteApprovedDrafts,
    fullExamDocument: documents[0],
  });
  const secondaryState = createMockProjectState({
    project: secondaryProject,
    document: secondaryDocuments[0],
    documents: secondaryDocuments,
    draft: secondaryDraft,
    drafts: secondaryDrafts,
    playableDrafts: secondaryPlayableDrafts,
    incompleteApprovedDrafts: [],
    fullExamDocument: secondaryDocuments[0],
  });
  const projectStates = new Map(
    [primaryState, secondaryState].map((state) => [state.project.id, state]),
  );
  const createdProjectIds: string[] = [];
  let lastProjectState = primaryState;
  const seenPaths = new Set<string>();
  const requestLog: string[] = [];

  await page.route(`${apiBaseUrl}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;

    if (method === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: corsHeaders(),
      });
      return;
    }

    if (request.headers()['authorization'] !== `Bearer ${devToken}`) {
      await fulfillJson(route, 401, {
        code: 'unauthorized',
        message: 'Bearer token required.',
      });
      return;
    }

    const requestLabel = `${method} ${path}`;
    seenPaths.add(requestLabel);
    requestLog.push(requestLabel);

    if (method === 'GET' && path === '/health') {
      const body = {
        status: 'ok',
        app: 'cert-prep-backend',
        version: '0.1.0',
        python_version: '3.13.5',
        runtime_mode: 'source',
      } satisfies HealthResponse;
      await fulfillJson(route, 200, body);
      return;
    }

    if (method === 'GET' && path === '/llm/health') {
      const body = {
        provider: 'fake',
        model: 'qwen3.5:4b',
        available: true,
        detail: 'deterministic local fake provider',
      } satisfies LLMHealthRead;
      await fulfillJson(route, 200, body);
      return;
    }

    if (method === 'GET' && path === '/llm/provider-selection') {
      const body = {
        preference: 'auto',
        selected_provider: 'fake',
        effective_provider: 'fake',
        configured_model: 'qwen3.5:4b',
        effective_model: 'qwen3.5:4b',
        selection_reason: 'Deterministic browser-test provider.',
        fallback_reason: null,
        hardware_compatible: false,
        requires_terms_acceptance: false,
        terms_accepted: false,
        terms_version: null,
        terms_url: null,
        runtime_requirement_kind: null,
        model_requirement_kind: null,
      } satisfies LLMProviderSelectionRead;
      await fulfillJson(route, 200, body);
      return;
    }

    if (method === 'GET' && path === '/ocr/health') {
      const body = {
        provider: 'paddle',
        engine: 'paddleocr',
        available: true,
        detail: 'PaddleOCR imports available',
        python_version: '3.13.5',
        paddle_version: '3.3.0',
        paddleocr_version: '3.3.0',
        selected_device: 'gpu:0',
        cuda_available: true,
        gpu_count: 1,
        model_cache_dir: null,
        fallback_reason: null,
      } satisfies OCRHealthRead;
      await fulfillJson(route, 200, body);
      return;
    }

    if (method === 'GET' && path === '/runtime/requirements') {
      const body = { items: [] } satisfies RuntimeRequirementsRead;
      await fulfillJson(route, 200, body);
      return;
    }

    if (method === 'GET' && path === '/projects') {
      await fulfillJson(route, 200, {
        items: createdProjectIds.flatMap(
          (projectId) => projectStates.get(projectId)?.project ?? [],
        ),
      });
      return;
    }

    if (method === 'POST' && path === '/projects') {
      const payload = parseJsonBody<{ readonly name?: string }>(
        request.postData(),
      );
      const createdState =
        [...projectStates.values()].find(
          (state) => state.project.name === payload.name,
        ) ?? primaryState;
      if (!createdProjectIds.includes(createdState.project.id)) {
        createdProjectIds.unshift(createdState.project.id);
      }
      await fulfillJson(route, 201, createdState.project);
      return;
    }

    const projectState = projectStateForPath(path, projectStates);
    if (projectState === null) {
      await fulfillJson(route, 404, {
        code: 'not_found',
        message: `${method} ${path} was not mocked.`,
      });
      return;
    }
    const projectId = projectState.project.id;

    if (method === 'GET' && path === `/projects/${projectId}/question-drafts`) {
      await fulfillJson(
        route,
        200,
        projectState.documentUploaded
          ? { items: projectState.drafts }
          : { items: [] },
      );
      return;
    }

    if (method === 'GET' && path === `/projects/${projectId}/documents`) {
      await fulfillJson(
        route,
        200,
        projectState.documentUploaded
          ? { items: visibleProjectDocuments(projectState) }
          : { items: [] },
      );
      return;
    }

    const requestedDocument = visibleProjectDocuments(projectState).find(
      (document) => path === `/projects/${projectId}/documents/${document.id}`,
    );
    if (method === 'GET' && requestedDocument) {
      await fulfillJson(route, 200, requestedDocument);
      return;
    }

    const chunksDocument = visibleProjectDocuments(projectState).find(
      (document) =>
        path === `/projects/${projectId}/documents/${document.id}/chunks`,
    );
    if (method === 'GET' && chunksDocument) {
      await fulfillJson(route, 200, { items: [] });
      return;
    }

    if (
      method === 'GET' &&
      path === `/projects/${projectId}/wrong-answers/summary`
    ) {
      await fulfillJson(route, 200, createWrongAnswerSummary(projectState));
      return;
    }

    if (method === 'GET' && path === `/projects/${projectId}/wrong-answers`) {
      await fulfillJson(route, 200, { items: projectState.wrongAnswers });
      return;
    }

    const explanationAttemptId = wrongAnswerExplanationAttemptId(
      path,
      projectId,
    );
    if (method === 'POST' && explanationAttemptId !== null) {
      const wrongAnswer = projectState.wrongAnswers.find(
        (candidate) => candidate.attempt_id === explanationAttemptId,
      );
      if (wrongAnswer === undefined) {
        await fulfillJson(route, 404, {
          code: 'not_found',
          message: `Wrong answer ${explanationAttemptId} was not mocked.`,
        });
        return;
      }

      const explanation = createWrongAnswerExplanation(wrongAnswer);
      projectState.wrongAnswerExplanations.push(explanation);
      await fulfillJson(route, 200, explanation);
      return;
    }

    if (method === 'POST' && path === `/projects/${projectId}/documents`) {
      const uploadedSourceFile = multipartUploadFile(
        request.postDataBuffer(),
        request.headers()['content-type'],
      );
      if (uploadedSourceFile === null) {
        await fulfillJson(route, 400, {
          code: 'invalid_multipart',
          message: 'The mocked upload did not contain a valid file part.',
        });
        return;
      }
      const uploadedDocument = nextUploadDocument(
        projectState,
        uploadedSourceFile.filename,
      );
      projectState.documentUploaded = true;
      projectState.uploadedSourceFiles.push(uploadedSourceFile);
      if (
        !projectState.uploadedDocuments.some(
          (document) => document.id === uploadedDocument.id,
        )
      ) {
        projectState.uploadedDocuments.push(uploadedDocument);
      }
      await fulfillJson(route, 201, uploadedDocument);
      return;
    }

    if (
      method === 'GET' &&
      path === `/projects/${projectId}/practice-sessions`
    ) {
      const body = { items: [] } satisfies PracticeSessionList;
      await fulfillJson(route, 200, body);
      return;
    }

    if (
      method === 'POST' &&
      path === `/projects/${projectId}/practice-sessions`
    ) {
      const practiceSessionPayload = parseJsonBody<PracticeSessionCreate>(
        request.postData(),
      );
      projectState.practiceSessionPayload = practiceSessionPayload;
      projectState.practiceSessionPayloads.push(practiceSessionPayload);
      projectState.currentSession = createPracticeSession({
        payload: practiceSessionPayload,
        playableDrafts: projectState.playableDrafts,
        wrongAnswers: projectState.wrongAnswers,
        projectId,
        sessionNumber: ++projectState.sessionCounter,
      });
      projectState.sessions.set(
        projectState.currentSession.id,
        projectState.currentSession,
      );
      lastProjectState = projectState;
      await fulfillJson(route, 201, projectState.currentSession);
      return;
    }

    const sessionPathPrefix = `/projects/${projectId}/practice-sessions/`;
    if (path.startsWith(sessionPathPrefix)) {
      const [, sessionId, suffix] =
        path.slice(sessionPathPrefix.length).match(/^([^/]+)(?:\/(.*))?$/) ??
        [];
      const session = sessionId
        ? projectState.sessions.get(sessionId)
        : undefined;
      if (session === undefined) {
        await fulfillJson(route, 404, {
          code: 'not_found',
          message: `${method} ${path} was not mocked.`,
        });
        return;
      }

      if (method === 'GET' && suffix === undefined) {
        await fulfillJson(route, 200, session);
        return;
      }

      if (method === 'POST' && suffix === 'attempts') {
        const payload = parseJsonBody<PracticeAttemptCreate>(
          request.postData(),
        );
        const draft = projectState.drafts.find(
          (candidate) => candidate.id === payload.question_id,
        );
        if (draft === undefined) {
          await fulfillJson(route, 404, {
            code: 'not_found',
            message: `Question ${payload.question_id} was not mocked.`,
          });
          return;
        }

        const attempt = createAttempt({
          attemptNumber: ++projectState.attemptCounter,
          payload,
          projectId,
          session,
          draft,
        });
        projectState.attempts.push(attempt);
        if (!attempt.is_correct) {
          projectState.wrongAnswers.push(createWrongAnswer(attempt, draft));
        } else {
          clearWrongAnswersForQuestion(projectState, attempt.question_id);
        }

        await fulfillJson(route, 201, attempt);
        return;
      }
    }

    await fulfillJson(route, 404, {
      code: 'not_found',
      message: `${method} ${path} was not mocked.`,
    });
  });

  return {
    project,
    secondaryProject,
    document: documents[0],
    secondaryDocument: secondaryDocuments[0],
    documents,
    draft: primaryDraft,
    secondaryDraft,
    drafts,
    playableDrafts,
    secondaryPlayableDrafts,
    incompleteApprovedDrafts,
    fullExamDocument: documents[0],
    attempts: (projectId) => [
      ...stateFor(projectStates, projectId, lastProjectState).attempts,
    ],
    currentSession: (projectId) =>
      stateFor(projectStates, projectId, lastProjectState).currentSession,
    markRequestLog: () => requestLog.length,
    playableDraftsForDocument: (documentId, projectId) =>
      stateFor(projectStates, projectId, primaryState).playableDrafts.filter(
        (draft) => draft.document_id === documentId,
      ),
    practiceSessionPayload: (projectId) =>
      stateFor(projectStates, projectId, lastProjectState)
        .practiceSessionPayload,
    practiceSessionPayloads: (projectId) => [
      ...stateFor(projectStates, projectId, lastProjectState)
        .practiceSessionPayloads,
    ],
    requestLog: () => [...requestLog],
    requestLogSince: (marker) => requestLog.slice(marker),
    seenPaths: () => new Set(seenPaths),
    uploadedDocuments: (projectId) => [
      ...stateFor(projectStates, projectId, lastProjectState).uploadedDocuments,
    ],
    uploadedSourceFiles: (projectId) => [
      ...stateFor(projectStates, projectId, lastProjectState)
        .uploadedSourceFiles,
    ],
    wrongAnswerExplanations: (projectId) => [
      ...stateFor(projectStates, projectId, lastProjectState)
        .wrongAnswerExplanations,
    ],
    wrongAnswers: (projectId) => [
      ...stateFor(projectStates, projectId, lastProjectState).wrongAnswers,
    ],
    wrongAnswerSummary: (projectId) =>
      createWrongAnswerSummary(
        stateFor(projectStates, projectId, lastProjectState),
      ),
  };
}

function createMockProjectState(args: {
  readonly project: ProjectRead;
  readonly document: DocumentRead;
  readonly documents: readonly DocumentRead[];
  readonly draft: CompleteQuestionDraftWithExcerpt;
  readonly drafts: readonly QuestionDraftRead[];
  readonly playableDrafts: readonly CompleteQuestionDraft[];
  readonly incompleteApprovedDrafts: readonly QuestionDraftRead[];
  readonly fullExamDocument: DocumentRead;
}): MockProjectState {
  return {
    ...args,
    uploadedDocuments: [],
    uploadedSourceFiles: [],
    sessions: new Map<string, PracticeSessionRead>(),
    practiceSessionPayloads: [],
    attempts: [],
    wrongAnswerExplanations: [],
    wrongAnswers: [],
    documentUploaded: false,
    currentSession: null,
    practiceSessionPayload: null,
    sessionCounter: 0,
    attemptCounter: 0,
  };
}

function nextUploadDocument(
  projectState: MockProjectState,
  filename: string | null,
): DocumentRead {
  const uploadedIds = new Set(
    projectState.uploadedDocuments.map((document) => document.id),
  );
  const matchedDocument = projectState.documents.find(
    (document) => document.filename === filename,
  );
  if (matchedDocument !== undefined) {
    return uploadedIds.has(matchedDocument.id)
      ? createAdditionalUploadDocument(projectState, matchedDocument, filename)
      : matchedDocument;
  }

  const remainingDocument = projectState.documents.find(
    (document) => !uploadedIds.has(document.id),
  );

  if (remainingDocument !== undefined && filename === null) {
    return remainingDocument;
  }
  return createAdditionalUploadDocument(
    projectState,
    remainingDocument ?? projectState.document,
    filename,
  );
}

function createAdditionalUploadDocument(
  projectState: MockProjectState,
  baseDocument: DocumentRead,
  filename: string | null,
): DocumentRead {
  const usedIds = new Set([
    ...projectState.documents.map((document) => document.id),
    ...projectState.uploadedDocuments.map((document) => document.id),
  ]);
  let index = projectState.uploadedDocuments.length + 1;
  let id = `document-upload-${index}`;
  while (usedIds.has(id)) {
    index += 1;
    id = `document-upload-${index}`;
  }

  return {
    ...baseDocument,
    id,
    filename: filename ?? `${baseDocument.filename}-upload-${index}`,
    sha256: `${id}-sha`,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
  };
}

function multipartUploadFile(
  body: Buffer | null,
  contentType: string | undefined,
): MockUploadedSourceFile | null {
  if (body === null) {
    return null;
  }

  const boundary = multipartBoundary(contentType);
  if (boundary === null) {
    return null;
  }

  const boundaryBytes = asciiBytes(`--${boundary}`);
  let searchStart = 0;
  while (searchStart < body.length) {
    const boundaryStart = indexOfBytes(body, boundaryBytes, searchStart);
    if (boundaryStart === -1) {
      return null;
    }
    const headerStart = skipMultipartBoundaryLine(
      body,
      boundaryStart + boundaryBytes.length,
    );
    if (headerStart === null) {
      return null;
    }
    const headerEnd = indexOfBytes(body, asciiBytes('\r\n\r\n'), headerStart);
    if (headerEnd === -1) {
      return null;
    }

    const partHeaders = body.subarray(headerStart, headerEnd);
    const filename = filenameFromMultipartHeaders(partHeaders);
    if (filename !== null && multipartFieldName(partHeaders) === 'file') {
      const dataStart = headerEnd + 4;
      const dataEnd = indexOfBytes(
        body,
        asciiBytes(`\r\n--${boundary}`),
        dataStart,
      );
      if (dataEnd === -1) {
        return null;
      }
      return {
        bytes: Buffer.from(body.subarray(dataStart, dataEnd)),
        contentType: contentTypeFromMultipartHeaders(partHeaders),
        filename,
      };
    }
    searchStart = headerEnd + 4;
  }

  return null;
}

function contentTypeFromMultipartHeaders(headers: Uint8Array): string | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(headers);
  const contentType = text
    .split(/\r?\n/)
    .find((line) => /^content-type:/i.test(line));
  return contentType?.slice(contentType.indexOf(':') + 1).trim() ?? null;
}

function multipartFieldName(headers: Uint8Array): string | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(headers);
  const disposition = text
    .split(/\r?\n/)
    .find((line) => /^content-disposition:/i.test(line));
  const [, fieldName] = disposition?.match(/(?:^|;\s*)name="([^"]+)"/i) ?? [];
  return fieldName ?? null;
}

function multipartBoundary(contentType: string | undefined): string | null {
  const [, quotedBoundary, rawBoundary] =
    contentType?.match(/boundary=(?:"([^"]+)"|([^;]+))/i) ?? [];
  return (quotedBoundary ?? rawBoundary)?.trim() ?? null;
}

function filenameFromMultipartHeaders(headers: Uint8Array): string | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(headers);
  const disposition = text
    .split(/\r?\n/)
    .find((line) => /^content-disposition:/i.test(line));
  if (disposition === undefined) {
    return null;
  }

  const [, encodedFilename] =
    disposition.match(/filename\*=(?:UTF-8'')?([^;\r\n]+)/i) ?? [];
  if (encodedFilename !== undefined) {
    try {
      return decodeURIComponent(unquoteHeaderValue(encodedFilename));
    } catch {
      return unquoteHeaderValue(encodedFilename);
    }
  }

  const [, quotedFilename, rawFilename] =
    disposition.match(/filename="([^"]+)"/i) ??
    disposition.match(/filename=([^;\r\n]+)/i) ??
    [];
  return (quotedFilename ?? rawFilename)?.trim() ?? null;
}

function skipMultipartBoundaryLine(
  body: Uint8Array,
  offset: number,
): number | null {
  if (body[offset] === 45 && body[offset + 1] === 45) {
    return null;
  }
  if (body[offset] === 13 && body[offset + 1] === 10) {
    return offset + 2;
  }
  if (body[offset] === 10) {
    return offset + 1;
  }
  return null;
}

function indexOfBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  startIndex: number,
): number {
  if (needle.length === 0) {
    return startIndex;
  }

  for (
    let index = startIndex;
    index <= haystack.length - needle.length;
    index += 1
  ) {
    let matched = true;
    for (let needleIndex = 0; needleIndex < needle.length; needleIndex += 1) {
      if (haystack[index + needleIndex] !== needle[needleIndex]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return index;
    }
  }
  return -1;
}

function asciiBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function unquoteHeaderValue(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function visibleProjectDocuments(
  projectState: MockProjectState,
): readonly DocumentRead[] {
  const documents = new Map(
    projectState.documents.map((document) => [document.id, document]),
  );
  for (const document of projectState.uploadedDocuments) {
    documents.set(document.id, document);
  }

  return [...documents.values()];
}

function projectStateForPath(
  path: string,
  projectStates: ReadonlyMap<string, MockProjectState>,
): MockProjectState | null {
  const [, projectId] = path.match(/^\/projects\/([^/]+)(?:\/|$)/) ?? [];
  return projectId
    ? (projectStates.get(decodeURIComponent(projectId)) ?? null)
    : null;
}

function stateFor(
  projectStates: ReadonlyMap<string, MockProjectState>,
  projectId: string | undefined,
  fallback: MockProjectState,
): MockProjectState {
  if (projectId === undefined) {
    return fallback;
  }

  return projectStates.get(projectId) ?? fallback;
}

export function expectedSeenPaths(api: MockCertPrepApi): Set<string> {
  const session = api.currentSession();
  const explanationPaths = api
    .wrongAnswerExplanations()
    .map(
      (explanation) =>
        `POST /projects/${api.project.id}/wrong-answers/${explanation.attempt_id}/explanation`,
    );
  return new Set([
    'GET /health',
    'GET /llm/health',
    'GET /llm/provider-selection',
    'GET /ocr/health',
    'GET /runtime/requirements',
    'GET /projects',
    'POST /projects',
    `GET /projects/${api.project.id}/documents`,
    `POST /projects/${api.project.id}/documents`,
    `GET /projects/${api.project.id}/documents/${api.document.id}`,
    `GET /projects/${api.project.id}/documents/${api.document.id}/chunks`,
    `GET /projects/${api.project.id}/question-drafts`,
    `GET /projects/${api.project.id}/practice-sessions`,
    `POST /projects/${api.project.id}/practice-sessions`,
    ...(session
      ? [
          `GET /projects/${api.project.id}/practice-sessions/${session.id}`,
          `POST /projects/${api.project.id}/practice-sessions/${session.id}/attempts`,
        ]
      : []),
    `GET /projects/${api.project.id}/wrong-answers`,
    `GET /projects/${api.project.id}/wrong-answers/summary`,
    ...explanationPaths,
  ]);
}

function documentRead(
  projectId: string,
  overrides: Partial<DocumentRead>,
): DocumentRead {
  return {
    id: 'document-1',
    project_id: projectId,
    filename: 'jlpt-n1.pdf',
    sha256: 'abc123',
    page_count: 2,
    has_text: true,
    status: 'ready',
    extraction_method: 'paddle_ocr_gpu',
    ocr_device: 'gpu:0',
    ocr_fallback_reason: null,
    ocr_duration_ms: 384,
    processed_page_count: 1,
    parse_wall_duration_ms: 1200,
    render_duration_ms: 180,
    ocr_engine_duration_ms: 384,
    ocr_worker_count: 1,
    first_chunk_ms: 850,
    exam_item_count: 1,
    language_hint: 'ja',
    content_profile: 'vocabulary_single_questions',
    classification_detail: '{"profile":"vocabulary_single_questions"}',
    chunks_count: 2,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
    ...overrides,
  };
}

function completeDraft(
  projectId: string,
  documentId: string,
  overrides: Partial<CompleteQuestionDraft>,
): CompleteQuestionDraft {
  return {
    id: 'draft-1',
    project_id: projectId,
    document_id: documentId,
    chunk_id: 'chunk-1',
    question: 'Which answer is supported by the cited source?',
    choices: ['A', 'B', 'C', 'D'],
    answer: 'A',
    answer_key_source: 'ai_inferred',
    rationale: 'The source supports A.',
    citation_page: 1,
    source_excerpt: 'The cited source supports answer A.',
    confidence: 0.94,
    source_order: 10001,
    source_question_number: '1',
    item_kind: 'vocabulary_single',
    group_key: null,
    group_prompt: null,
    status: 'approved',
    rejection_reason: null,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
    ...overrides,
  };
}

function incompleteDraft(
  projectId: string,
  documentId: string,
  overrides: Partial<QuestionDraftRead>,
): QuestionDraftRead {
  return {
    ...completeDraft(projectId, documentId, {
      id: 'draft-incomplete',
      question: 'Incomplete approved-looking draft',
      choices: ['Choice A', 'Choice B', 'Choice C', 'Choice D'],
      answer: 'Choice A',
      rationale: 'Incomplete draft rationale.',
      source_excerpt: 'Incomplete draft source.',
      citation_page: 1,
    }),
    ...overrides,
    status: 'approved',
    rejection_reason: null,
  };
}

function createPracticeSession(args: {
  readonly payload: PracticeSessionCreate;
  readonly playableDrafts: readonly CompleteQuestionDraft[];
  readonly wrongAnswers: readonly WrongAnswerRead[];
  readonly projectId: string;
  readonly sessionNumber: number;
}): PracticeSessionRead {
  const mode = args.payload.mode ?? 'random_draw';
  const documentId =
    mode === 'full_document' ? (args.payload.document_id ?? null) : null;
  const pool = practiceSessionPool(
    args.payload,
    args.playableDrafts,
    args.wrongAnswers,
  );
  const requestedCount = Math.max(
    1,
    Math.trunc(args.payload.question_count ?? pool.length),
  );
  const questionIds = pool
    .slice(0, Math.min(requestedCount, pool.length))
    .map((draft) => draft.id);

  return {
    id: `session-${args.sessionNumber}`,
    project_id: args.projectId,
    question_ids: questionIds,
    questions: pool
      .slice(0, Math.min(requestedCount, pool.length))
      .map(practiceSessionQuestion),
    mode,
    document_id: documentId,
    question_count: questionIds.length,
    random_seed: args.payload.random_seed ?? 42,
    status: 'active',
    created_at: '2026-06-09T00:00:00Z',
    completed_at: null,
  };
}

function practiceSessionPool(
  payload: PracticeSessionCreate,
  playableDrafts: readonly CompleteQuestionDraft[],
  wrongAnswers: readonly WrongAnswerRead[],
): readonly CompleteQuestionDraft[] {
  const mode = payload.mode ?? 'random_draw';
  if (mode === 'review_retry') {
    const attemptIds = new Set(payload.wrong_attempt_ids ?? []);
    const questionIds = new Set(
      wrongAnswers
        .filter((wrongAnswer) => attemptIds.has(wrongAnswer.attempt_id))
        .map((wrongAnswer) => wrongAnswer.question_id),
    );
    return playableDrafts.filter((draft) => questionIds.has(draft.id));
  }

  if (mode === 'full_document' && payload.document_id != null) {
    return playableDrafts.filter(
      (draft) => draft.document_id === payload.document_id,
    );
  }

  return playableDrafts;
}

function practiceSessionQuestion(
  draft: CompleteQuestionDraft,
): PracticeSessionRead['questions'][number] {
  return {
    id: draft.id,
    question: draft.question,
    choices: [...draft.choices],
    answer: draft.answer,
    rationale: draft.rationale,
    citation_page: draft.citation_page,
    source_excerpt: draft.source_excerpt,
    document_id: draft.document_id,
  };
}

function createAttempt(args: {
  readonly attemptNumber: number;
  readonly payload: PracticeAttemptCreate;
  readonly projectId: string;
  readonly session: PracticeSessionRead;
  readonly draft: QuestionDraftRead;
}): PracticeAttemptRead {
  return {
    id: `attempt-${args.attemptNumber}`,
    session_id: args.session.id,
    project_id: args.projectId,
    question_id: args.payload.question_id,
    selected_answer: args.payload.selected_answer,
    is_correct: args.payload.selected_answer === args.draft.answer,
    created_at: '2026-06-09T00:02:00Z',
  };
}

function createWrongAnswer(
  attempt: PracticeAttemptRead,
  draft: QuestionDraftRead,
): WrongAnswerRead {
  return {
    attempt_id: attempt.id,
    session_id: attempt.session_id,
    question_id: draft.id,
    question: draft.question,
    selected_answer: attempt.selected_answer,
    correct_answer: draft.answer,
    rationale: draft.rationale,
    citation_page: draft.citation_page,
    source_excerpt: draft.source_excerpt,
    document_id: draft.document_id,
    created_at: attempt.created_at,
  };
}

function clearWrongAnswersForQuestion(
  projectState: MockProjectState,
  questionId: string,
): void {
  for (
    let index = projectState.wrongAnswers.length - 1;
    index >= 0;
    index -= 1
  ) {
    if (projectState.wrongAnswers[index]?.question_id === questionId) {
      projectState.wrongAnswers.splice(index, 1);
    }
  }
}

function createWrongAnswerSummary(
  projectState: MockProjectState,
): WrongAnswerSummaryRead {
  const wrongAttempts = projectState.attempts.filter(
    (attempt) => !attempt.is_correct,
  );
  const correctQuestionIds = new Set(
    projectState.attempts
      .filter((attempt) => attempt.is_correct)
      .map((attempt) => attempt.question_id),
  );
  const currentQuestionIds = new Set(
    projectState.wrongAnswers.map((wrongAnswer) => wrongAnswer.question_id),
  );
  const clearedWrongAttempts = wrongAttempts.filter(
    (attempt) =>
      correctQuestionIds.has(attempt.question_id) &&
      !currentQuestionIds.has(attempt.question_id),
  );

  return {
    current_wrong_count: projectState.wrongAnswers.length,
    cleared_count: clearedWrongAttempts.length,
    last_wrong_date: projectState.wrongAnswers.at(-1)?.created_at ?? null,
    repeated_misses: repeatedMisses(projectState, wrongAttempts),
    clusters: wrongAnswerClusters(projectState),
  };
}

function repeatedMisses(
  projectState: MockProjectState,
  wrongAttempts: readonly PracticeAttemptRead[],
): WrongAnswerSummaryRead['repeated_misses'] {
  const counts = new Map<string, number>();
  for (const attempt of wrongAttempts) {
    counts.set(attempt.question_id, (counts.get(attempt.question_id) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, missCount]) => missCount > 1)
    .flatMap(([questionId, missCount]) => {
      const draft = projectState.drafts.find(
        (candidate) => candidate.id === questionId,
      );
      const lastWrongAt = wrongAttempts
        .filter((attempt) => attempt.question_id === questionId)
        .at(-1)?.created_at;
      if (draft === undefined || lastWrongAt === undefined) {
        return [];
      }

      return [
        {
          question_id: questionId,
          question: draft.question,
          document_id: draft.document_id,
          citation_page: draft.citation_page,
          source_excerpt: draft.source_excerpt,
          miss_count: missCount,
          last_wrong_at: lastWrongAt,
        },
      ];
    });
}

function wrongAnswerClusters(
  projectState: MockProjectState,
): WrongAnswerSummaryRead['clusters'] {
  const clusters = new Map<
    string,
    WrongAnswerSummaryRead['clusters'][number]
  >();
  for (const wrongAnswer of projectState.wrongAnswers) {
    const key = `${wrongAnswer.document_id ?? 'none'}:${wrongAnswer.citation_page ?? 'none'}`;
    const current = clusters.get(key);
    clusters.set(key, {
      document_id: wrongAnswer.document_id,
      citation_page: wrongAnswer.citation_page,
      current_wrong_count: (current?.current_wrong_count ?? 0) + 1,
      cleared_count: current?.cleared_count ?? 0,
      last_wrong_at: wrongAnswer.created_at,
    });
  }

  return [...clusters.values()];
}

function createWrongAnswerExplanation(
  wrongAnswer: WrongAnswerRead,
): MockWrongAnswerExplanationRead {
  const fallback = isFallbackAttempt(wrongAnswer.attempt_id);
  const correctAnswer = wrongAnswer.correct_answer ?? 'the recorded answer key';
  const rationale =
    wrongAnswer.rationale ??
    'Review the recorded rationale and source excerpt.';
  const sourceExcerpt =
    wrongAnswer.source_excerpt ?? 'No source excerpt was recorded.';
  const explanation = fallback
    ? `Local AI is not ready, so use the recorded rationale: ${rationale}`
    : `The selected answer "${wrongAnswer.selected_answer}" misses the source evidence. The correct answer is "${correctAnswer}" because ${sourceExcerpt}`;

  return {
    attempt_id: wrongAnswer.attempt_id,
    explanation,
    provider: fallback ? 'deterministic-fallback' : 'fake',
    model: 'qwen3.5:4b',
    grounded_fields: {
      question: wrongAnswer.question,
      selected_answer: wrongAnswer.selected_answer,
      correct_answer: wrongAnswer.correct_answer,
      rationale: wrongAnswer.rationale,
      citation_page: wrongAnswer.citation_page,
      source_excerpt: wrongAnswer.source_excerpt,
    },
    fallback,
  };
}

function isFallbackAttempt(attemptId: string): boolean {
  const [, attemptNumberText] = attemptId.match(/^attempt-(\d+)$/) ?? [];
  const attemptNumber = Number(attemptNumberText);
  return Number.isInteger(attemptNumber) && attemptNumber % 2 === 0;
}

function isCompletePlayableDraft(
  draft: QuestionDraftRead,
): draft is CompleteQuestionDraft {
  const hasGrounding = draft.citation_page !== null || hasSourceExcerpt(draft);

  return (
    draft.status === 'approved' &&
    draft.document_id !== null &&
    draft.answer !== null &&
    draft.answer.length > 0 &&
    draft.choices.includes(draft.answer) &&
    draft.rationale !== null &&
    draft.rationale.length > 0 &&
    hasGrounding
  );
}

function hasSourceExcerpt(
  draft: QuestionDraftRead,
): draft is QuestionDraftRead & { readonly source_excerpt: string } {
  return (
    draft.source_excerpt !== null && draft.source_excerpt.trim().length > 0
  );
}

function wrongAnswerExplanationAttemptId(
  path: string,
  projectId: string,
): string | null {
  const prefix = `/projects/${projectId}/wrong-answers/`;
  const suffix = '/explanation';

  if (!path.startsWith(prefix) || !path.endsWith(suffix)) {
    return null;
  }

  return decodeURIComponent(path.slice(prefix.length, -suffix.length));
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  };
}

async function fulfillJson(
  route: Route,
  status: number,
  body: unknown,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: corsHeaders(),
    body: JSON.stringify(body),
  });
}

function parseJsonBody<TBody>(body: string | null): TBody {
  if (body === null || body.length === 0) {
    return {} as TBody;
  }

  return JSON.parse(body) as TBody;
}
