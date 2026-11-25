import type { Page, Route } from '@playwright/test';
import type {
  DevicePreferenceRead,
  DevicePreferenceUpdate,
  SourceRead,
  HealthResponse,
  LLMHealthRead,
  LLMProviderSelectionRead,
  ManualQuestionGenerationRead,
  OllamaDeviceRead,
  PracticeAttemptCreate,
  PracticeAttemptRead,
  PracticeSessionCreate,
  PracticeSessionList,
  PracticeSessionRead,
  ProjectRead,
  QuestionGenerateRequest,
  QuestionGenerationJobList,
  QuestionRead,
  LLMRequirementsRead,
  WrongAnswerExplanationRead,
  WrongAnswerRead,
  WrongAnswerSummaryRead,
} from '@cert-prep/api';

export const apiBaseUrl = 'http://127.0.0.1:8765';
export const devToken = 'cert-prep-local-dev-token';

export type CompleteQuestion = QuestionRead & {
  readonly answer: string;
  readonly source_id: string;
  readonly rationale: string;
};

export type CompleteQuestionWithExcerpt = CompleteQuestion & {
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
  readonly source: SourceRead;
  readonly secondarySource: SourceRead;
  readonly sources: readonly SourceRead[];
  readonly question: CompleteQuestionWithExcerpt;
  readonly secondaryQuestion: CompleteQuestionWithExcerpt;
  readonly questions: readonly QuestionRead[];
  readonly playableQuestions: readonly CompleteQuestion[];
  readonly secondaryPlayableQuestions: readonly CompleteQuestion[];
  readonly incompleteQuestions: readonly QuestionRead[];
  readonly wholeSource: SourceRead;
  attempts(projectId?: string): readonly PracticeAttemptRead[];
  currentSession(projectId?: string): PracticeSessionRead | null;
  holdUpload(filename: string): void;
  markRequestLog(): number;
  playableQuestionsForSource(
    sourceId: string,
    projectId?: string,
  ): readonly CompleteQuestion[];
  practiceSessionPayload(projectId?: string): PracticeSessionCreate | null;
  practiceSessionPayloads(projectId?: string): readonly PracticeSessionCreate[];
  requestLog(): readonly string[];
  requestLogSince(marker: number): readonly string[];
  releaseUpload(filename: string): void;
  seenPaths(): Set<string>;
  startedUploads(): readonly string[];
  uploadedSources(projectId?: string): readonly SourceRead[];
  uploadedSourceFiles(projectId?: string): readonly MockUploadedSourceFile[];
  wrongAnswerExplanations(
    projectId?: string,
  ): readonly MockWrongAnswerExplanationRead[];
  wrongAnswers(projectId?: string): readonly WrongAnswerRead[];
  wrongAnswerSummary(projectId?: string): WrongAnswerSummaryRead;
  devicePreferenceUpdates(): readonly DevicePreferenceUpdate[];
  settleDeviceSwitch(): void;
  setDeviceState(
    device: OllamaDeviceRead,
    preference: DevicePreferenceRead,
  ): void;
}

export interface MockCertPrepApiOptions {
  readonly device?: OllamaDeviceRead | null;
  readonly devicePreference?: DevicePreferenceRead | null;
  readonly pendingDeviceSwitch?: boolean;
}

interface MockUploadHold {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

interface MockProjectState {
  readonly project: ProjectRead;
  readonly source: SourceRead;
  readonly sources: readonly SourceRead[];
  readonly question: CompleteQuestionWithExcerpt;
  readonly questions: readonly QuestionRead[];
  readonly playableQuestions: readonly CompleteQuestion[];
  readonly incompleteQuestions: readonly QuestionRead[];
  readonly wholeSource: SourceRead;
  readonly uploadedSources: SourceRead[];
  readonly uploadedSourceFiles: MockUploadedSourceFile[];
  readonly sessions: Map<string, PracticeSessionRead>;
  readonly practiceSessionPayloads: PracticeSessionCreate[];
  readonly attempts: PracticeAttemptRead[];
  readonly wrongAnswerExplanations: MockWrongAnswerExplanationRead[];
  readonly wrongAnswers: WrongAnswerRead[];
  sourceUploaded: boolean;
  currentSession: PracticeSessionRead | null;
  practiceSessionPayload: PracticeSessionCreate | null;
  sessionCounter: number;
  attemptCounter: number;
}

export async function installMockCertPrepApi(
  page: Page,
  options: MockCertPrepApiOptions = {},
): Promise<MockCertPrepApi> {
  const devicePreferenceUpdates: DevicePreferenceUpdate[] = [];
  let currentDevice: OllamaDeviceRead | null = options.device ?? null;
  let currentDevicePreference: DevicePreferenceRead | null =
    options.devicePreference !== undefined ? options.devicePreference : null;
  const project = {
    id: 'project-1',
    name: 'JLPT_N1',
    description: '2025 N1 practice questions',
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
  } satisfies ProjectRead;

  const sources = [
    sourceRead(project.id, {
      id: 'source-1',
      filename: 'jlpt-n1-vocabulary.pdf',
      sha256: 'source-1-sha',
      page_count: 3,
      processed_page_count: 3,
      question_count: 4,
      chunks_count: 3,
    }),
    sourceRead(project.id, {
      id: 'source-2',
      filename: 'jlpt-n1-reading.pdf',
      sha256: 'source-2-sha',
      page_count: 4,
      processed_page_count: 4,
      question_count: 3,
      chunks_count: 4,
    }),
    sourceRead(project.id, {
      id: 'source-3',
      filename: 'jlpt-n1-incomplete-outline.pdf',
      sha256: 'source-3-sha',
      page_count: 1,
      processed_page_count: 1,
      question_count: 1,
      chunks_count: 1,
    }),
  ] as const satisfies readonly SourceRead[];

  const questions = [
    completeQuestion(project.id, sources[0].id, {
      id: 'question-1',
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
    completeQuestion(project.id, sources[0].id, {
      id: 'question-2',
      answer_key_source: 'source',
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
    completeQuestion(project.id, sources[0].id, {
      id: 'question-source-excerpt-only',
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
    completeQuestion(project.id, sources[1].id, {
      id: 'question-3',
      chunk_id: 'chunk-3',
      question: 'Which study action best matches a whole source review?',
      choices: [
        'Complete every question from the selected source',
        'Mix questions from unrelated PDFs',
        'Skip questions with citations',
        'Answer only the first item',
      ],
      answer: 'Complete every question from the selected source',
      rationale: 'Whole source mode is source-scoped.',
      citation_page: 1,
      source_excerpt: 'Whole source sessions use questions from one source.',
      source_order: 20001,
      source_question_number: '1',
    }),
    completeQuestion(project.id, sources[1].id, {
      id: 'question-4',
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
    incompleteQuestion(project.id, sources[0].id, {
      id: 'question-missing-answer',
      chunk_id: 'chunk-incomplete-1',
      question: 'Question missing an answer',
      answer: null,
      rationale: 'This row is deliberately incomplete.',
      source_excerpt: 'It has a source but no selected correct answer.',
      citation_page: 3,
      source_order: 10003,
    }),
    incompleteQuestion(project.id, sources[1].id, {
      id: 'question-answer-not-in-choices',
      chunk_id: 'chunk-incomplete-2',
      question: 'Question with an answer outside the choices',
      choices: ['Choice A', 'Choice B', 'Choice C', 'Choice D'],
      answer: 'Choice E',
      rationale: 'This row should not be playable.',
      source_excerpt: 'The answer key points outside the listed choices.',
      citation_page: 4,
      source_order: 20003,
    }),
    incompleteQuestion(project.id, sources[2].id, {
      id: 'question-missing-source',
      chunk_id: 'chunk-incomplete-3',
      question: 'Question missing source grounding',
      answer: 'Choice A',
      rationale: null,
      source_excerpt: null,
      citation_page: null,
      source_order: 30001,
    }),
  ] as const satisfies readonly QuestionRead[];

  const playableQuestions = questions.filter(isCompletePlayableQuestion);
  const incompleteQuestions = questions.filter(
    (question) => !isCompletePlayableQuestion(question),
  );
  const primaryQuestion = playableQuestions.find(hasSourceExcerpt);
  if (primaryQuestion === undefined) {
    throw new Error('Mock API requires at least one playable question excerpt.');
  }

  const secondaryProject = {
    id: 'project-2',
    name: 'JLPT_N2',
    description: '2025 N2 practice questions',
    created_at: '2026-06-10T00:00:00Z',
    updated_at: '2026-06-10T00:00:00Z',
  } satisfies ProjectRead;
  const secondarySources = [
    sourceRead(secondaryProject.id, {
      id: 'source-4',
      filename: 'jlpt-n2-grammar.pdf',
      sha256: 'source-4-sha',
      page_count: 2,
      processed_page_count: 2,
      question_count: 1,
      chunks_count: 2,
    }),
  ] as const satisfies readonly SourceRead[];
  const secondaryQuestions = [
    completeQuestion(secondaryProject.id, secondarySources[0].id, {
      id: 'question-project-2-1',
      chunk_id: 'chunk-project-2-1',
      question: 'Which grammar review habit belongs to the second project?',
      choices: [
        'Keep the second project isolated',
        'Reuse the first project session',
        'Submit the old PDF source id',
        'Mix unrelated review cards',
      ],
      answer: 'Keep the second project isolated',
      rationale: 'Project switching must load only the selected project data.',
      citation_page: 1,
      source_excerpt: 'Project isolation keeps sessions and review scoped.',
      source_order: 40001,
      source_question_number: '1',
    }),
  ] as const satisfies readonly QuestionRead[];
  const secondaryPlayableQuestions = secondaryQuestions.filter(
    isCompletePlayableQuestion,
  );
  const secondaryQuestion = secondaryPlayableQuestions.find(hasSourceExcerpt);
  if (secondaryQuestion === undefined) {
    throw new Error('Mock API requires a secondary playable question excerpt.');
  }

  const primaryState = createMockProjectState({
    project,
    source: sources[0],
    sources,
    question: primaryQuestion,
    questions,
    playableQuestions,
    incompleteQuestions,
    wholeSource: sources[0],
  });
  const secondaryState = createMockProjectState({
    project: secondaryProject,
    source: secondarySources[0],
    sources: secondarySources,
    question: secondaryQuestion,
    questions: secondaryQuestions,
    playableQuestions: secondaryPlayableQuestions,
    incompleteQuestions: [],
    wholeSource: secondarySources[0],
  });
  const projectStates = new Map(
    [primaryState, secondaryState].map((state) => [state.project.id, state]),
  );
  const createdProjectIds: string[] = [];
  let lastProjectState = primaryState;
  const seenPaths = new Set<string>();
  const requestLog: string[] = [];
  const manualGenerations = new Map<string, ManualQuestionGenerationRead>();
  const startedUploads: string[] = [];
  const uploadHolds = new Map<string, MockUploadHold>();

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
        ...(currentDevice !== null ? { device: currentDevice } : {}),
      } satisfies LLMHealthRead;
      await fulfillJson(route, 200, body);
      return;
    }

    if (method === 'GET' && path === '/llm/device-preference') {
      if (currentDevicePreference !== null) {
        await fulfillJson(route, 200, currentDevicePreference);
        return;
      }
      await fulfillJson(route, 404, { message: 'Not found' });
      return;
    }

    if (method === 'PUT' && path === '/llm/device-preference') {
      const postData = route.request().postDataJSON() as DevicePreferenceUpdate;
      devicePreferenceUpdates.push(postData);
      if (currentDevicePreference !== null) {
        currentDevicePreference = {
          ...currentDevicePreference,
          mode: postData.mode,
          adapter_key: postData.adapter_key ?? null,
          adapter_name:
            postData.mode === 'adapter'
              ? (currentDevicePreference.choices.find(
                  (choice) => choice.adapter_key === postData.adapter_key,
                )?.name ?? null)
              : null,
          status:
            currentDevicePreference.status === 'external_server'
              ? 'external_server'
              : options.pendingDeviceSwitch
                ? 'pending'
                : 'active',
        };
      }
      if (postData.mode === 'cpu' && currentDevice?.server === 'owned') {
        currentDevice = {
          ...currentDevice,
          server: 'owned',
          requested: {
            target: 'cpu',
            backend: 'cpu',
            adapter_name: null,
          },
          verification: 'verified',
          observed: {
            backend: 'cpu',
            adapter_name: null,
            offloaded_layers: 0,
            total_layers: 16,
          },
        };
      }
      await fulfillJson(
        route,
        200,
        currentDevicePreference ?? {
          mode: postData.mode,
          adapter_key: postData.adapter_key ?? null,
          status: 'active',
          choices: [],
        },
      );
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
        llm_engine_requirement_kind: null,
        model_requirement_kind: null,
      } satisfies LLMProviderSelectionRead;
      await fulfillJson(route, 200, body);
      return;
    }

    if (method === 'GET' && path === '/llm/requirements') {
      const body = {
        items: [],
      } satisfies LLMRequirementsRead;
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
    const captureReviewsPath = `/projects/${projectId}/capture-reviews`;

    if (path === captureReviewsPath || path.startsWith(`${captureReviewsPath}/`)) {
      await fulfillJson(route, 503, {
        code: 'capture_runtime_unavailable',
        message: 'Capture Runtime is not configured for this process.',
      });
      return;
    }

    if (method === 'GET' && path === `/projects/${projectId}/questions`) {
      await fulfillJson(
        route,
        200,
        projectState.sourceUploaded
          ? { items: projectState.questions }
          : { items: [] },
      );
      return;
    }

    if (method === 'GET' && path === `/projects/${projectId}/sources`) {
      await fulfillJson(
        route,
        200,
        projectState.sourceUploaded
          ? { items: visibleProjectSources(projectState) }
          : { items: [] },
      );
      return;
    }

    const requestedSource = visibleProjectSources(projectState).find(
      (source) => path === `/projects/${projectId}/sources/${source.id}`,
    );
    if (method === 'GET' && requestedSource) {
      await fulfillJson(route, 200, requestedSource);
      return;
    }

    const questionWorkSource = visibleProjectSources(projectState).find((source) => {
      const prefix = `/projects/${projectId}/sources/${source.id}/`;
      return path.startsWith(`${prefix}question-jobs`) ||
        path.startsWith(`${prefix}question-generations`);
    });
    if (questionWorkSource !== undefined) {
      const sourcePath = `/projects/${projectId}/sources/${questionWorkSource.id}`;
      const jobsPath = `${sourcePath}/question-jobs`;
      const generationsPath = `${sourcePath}/question-generations`;
      const storedQuestions = projectState.questions.filter(
        (question) => question.source_id === questionWorkSource.id,
      );
      if (method === 'GET' && (path === jobsPath || path === `${jobsPath}/events`)) {
        const payload = {
          items: storedQuestions.length === 0 ? [] : [{
            id: `job-${questionWorkSource.id}`,
            project_id: projectId,
            source_id: questionWorkSource.id,
            chunk_id: storedQuestions[0].chunk_id ?? 'mock-chunk',
            page_number: storedQuestions[0].citation_page ?? 1,
            strategy: 'deterministic_only',
            status: 'succeeded',
            phase: 'succeeded',
            cancellable: false,
            provider: 'mock',
            model: 'mock-model',
            effective_provider: null,
            effective_model: null,
            fallback_reason: null,
            generated_count: storedQuestions.length,
            retry_count: 0,
            last_error: null,
            created_at: questionWorkSource.created_at,
            updated_at: questionWorkSource.updated_at,
          }],
        } satisfies QuestionGenerationJobList;
        if (path === jobsPath) {
          await fulfillJson(route, 200, payload);
        } else {
          await fulfillEvent(route, 'question-jobs', payload);
        }
        return;
      }

      if (method === 'POST' && path === generationsPath) {
        const requestBody = parseJsonBody<QuestionGenerateRequest>(request.postData());
        const limit = requestBody.limit ?? 3;
        const operation = {
          id: `generation-${manualGenerations.size + 1}-${questionWorkSource.id}`,
          project_id: projectId,
          source_id: questionWorkSource.id,
          limit,
          strategy: requestBody.strategy ?? 'hybrid_reasoning',
          status: 'succeeded',
          phase: 'succeeded',
          cancellable: false,
          provider: 'mock',
          model: 'mock-model',
          generated_count: Math.min(limit, storedQuestions.length),
          created_at: questionWorkSource.created_at,
          updated_at: questionWorkSource.updated_at,
        } satisfies ManualQuestionGenerationRead;
        manualGenerations.set(`${generationsPath}/${operation.id}`, operation);
        await fulfillJson(route, 202, {
          ...operation, status: 'queued', phase: 'queued', generated_count: 0,
        } satisfies ManualQuestionGenerationRead);
        return;
      }
      if (method === 'GET') {
        const operationPath = path.endsWith('/events') ? path.slice(0, -'/events'.length) : path;
        const operation = manualGenerations.get(operationPath);
        if (operation !== undefined) {
          if (operationPath === path) {
            await fulfillJson(route, 200, operation);
          } else {
            await fulfillEvent(route, 'question-generation', operation);
          }
          return;
        }
      }
    }

    const chunksSource = visibleProjectSources(projectState).find(
      (source) =>
        path === `/projects/${projectId}/sources/${source.id}/chunks`,
    );
    if (method === 'GET' && chunksSource) {
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

    if (method === 'POST' && path === `/projects/${projectId}/sources`) {
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
      startedUploads.push(uploadedSourceFile.filename);
      const hold = uploadHolds.get(uploadedSourceFile.filename);
      if (hold !== undefined) {
        await hold.promise;
      }
      const uploadedSource = nextUploadSource(
        projectState,
        uploadedSourceFile.filename,
      );
      projectState.sourceUploaded = true;
      projectState.uploadedSourceFiles.push(uploadedSourceFile);
      if (
        !projectState.uploadedSources.some(
          (source) => source.id === uploadedSource.id,
        )
      ) {
        projectState.uploadedSources.push(uploadedSource);
      }
      await fulfillJson(route, 201, uploadedSource);
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
        playableQuestions: projectState.playableQuestions,
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
        const question = projectState.questions.find(
          (candidate) => candidate.id === payload.question_id,
        );
        if (question === undefined) {
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
          question,
        });
        projectState.attempts.push(attempt);
        session.attempts.push(attempt);
        if (!attempt.is_correct) {
          projectState.wrongAnswers.push(createWrongAnswer(attempt, question));
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
    source: sources[0],
    secondarySource: secondarySources[0],
    sources,
    question: primaryQuestion,
    secondaryQuestion,
    questions,
    playableQuestions,
    secondaryPlayableQuestions,
    incompleteQuestions,
    wholeSource: sources[0],
    attempts: (projectId) => [
      ...stateFor(projectStates, projectId, lastProjectState).attempts,
    ],
    currentSession: (projectId) =>
      stateFor(projectStates, projectId, lastProjectState).currentSession,
    holdUpload: (filename) => {
      if (uploadHolds.has(filename)) {
        throw new Error(`Upload ${filename} is already held.`);
      }
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      uploadHolds.set(filename, { promise, release });
    },
    markRequestLog: () => requestLog.length,
    playableQuestionsForSource: (sourceId, projectId) =>
      stateFor(projectStates, projectId, primaryState).playableQuestions.filter(
        (question) => question.source_id === sourceId,
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
    releaseUpload: (filename) => {
      const hold = uploadHolds.get(filename);
      if (hold === undefined) {
        throw new Error(`Upload ${filename} is not held.`);
      }
      uploadHolds.delete(filename);
      hold.release();
    },
    seenPaths: () => new Set(seenPaths),
    startedUploads: () => [...startedUploads],
    uploadedSources: (projectId) => [
      ...stateFor(projectStates, projectId, lastProjectState).uploadedSources,
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
    devicePreferenceUpdates: () => [...devicePreferenceUpdates],
    settleDeviceSwitch: () => {
      if (currentDevicePreference?.status === 'pending') {
        currentDevicePreference = {
          ...currentDevicePreference,
          status: 'active',
        };
      }
    },
    setDeviceState: (device, preference) => {
      currentDevice = device;
      currentDevicePreference = preference;
    },
  };
}

function createMockProjectState(args: {
  readonly project: ProjectRead;
  readonly source: SourceRead;
  readonly sources: readonly SourceRead[];
  readonly question: CompleteQuestionWithExcerpt;
  readonly questions: readonly QuestionRead[];
  readonly playableQuestions: readonly CompleteQuestion[];
  readonly incompleteQuestions: readonly QuestionRead[];
  readonly wholeSource: SourceRead;
}): MockProjectState {
  return {
    ...args,
    uploadedSources: [],
    uploadedSourceFiles: [],
    sessions: new Map<string, PracticeSessionRead>(),
    practiceSessionPayloads: [],
    attempts: [],
    wrongAnswerExplanations: [],
    wrongAnswers: [],
    sourceUploaded: false,
    currentSession: null,
    practiceSessionPayload: null,
    sessionCounter: 0,
    attemptCounter: 0,
  };
}

function nextUploadSource(
  projectState: MockProjectState,
  filename: string | null,
): SourceRead {
  const uploadedIds = new Set(
    projectState.uploadedSources.map((source) => source.id),
  );
  const matchedSource = projectState.sources.find(
    (source) => source.filename === filename,
  );
  if (matchedSource !== undefined) {
    return uploadedIds.has(matchedSource.id)
      ? createAdditionalUploadSource(projectState, matchedSource, filename)
      : matchedSource;
  }

  const remainingSource = projectState.sources.find(
    (source) => !uploadedIds.has(source.id),
  );

  if (remainingSource !== undefined && filename === null) {
    return remainingSource;
  }
  return createAdditionalUploadSource(
    projectState,
    remainingSource ?? projectState.source,
    filename,
  );
}

function createAdditionalUploadSource(
  projectState: MockProjectState,
  baseSource: SourceRead,
  filename: string | null,
): SourceRead {
  const usedIds = new Set([
    ...projectState.sources.map((source) => source.id),
    ...projectState.uploadedSources.map((source) => source.id),
  ]);
  let index = projectState.uploadedSources.length + 1;
  let id = `source-upload-${index}`;
  while (usedIds.has(id)) {
    index += 1;
    id = `source-upload-${index}`;
  }

  const extension = filename?.match(/\.([^.]+)$/u)?.[1]?.toLowerCase();
  let sourceKind = baseSource.source_kind ?? 'pdf';
  if (extension === 'pdf') {
    sourceKind = 'pdf';
  } else if (extension && ['jpg', 'jpeg', 'png', 'webp'].includes(extension)) {
    sourceKind = 'image';
  } else if (extension && ['mp3', 'wav', 'm4a'].includes(extension)) {
    sourceKind = 'recording';
  }

  return {
    ...baseSource,
    source_kind: sourceKind,
    id,
    filename: filename ?? `${baseSource.filename}-upload-${index}`,
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

function visibleProjectSources(
  projectState: MockProjectState,
): readonly SourceRead[] {
  const sources = new Map(
    projectState.sources.map((source) => [source.id, source]),
  );
  for (const source of projectState.uploadedSources) {
    sources.set(source.id, source);
  }

  return [...sources.values()];
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
    'GET /llm/requirements',
    'GET /projects',
    'POST /projects',
    `GET /projects/${api.project.id}/sources`,
    `POST /projects/${api.project.id}/sources`,
    `GET /projects/${api.project.id}/sources/${api.source.id}`,
    `GET /projects/${api.project.id}/sources/${api.source.id}/chunks`,
    `GET /projects/${api.project.id}/questions`,
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

function sourceRead(
  projectId: string,
  overrides: Partial<SourceRead>,
): SourceRead {
  return {
    id: 'source-1',
    project_id: projectId,
    filename: 'jlpt-n1.pdf',
    source_kind: 'pdf',
    sha256: 'abc123',
    page_count: 2,
    has_text: true,
    status: 'ready',
    extraction_method: 'text_recognition',
    ocr_device: 'directml',
    extraction_warnings: null,
    failure_message: null,
    processed_page_count: 1,
    question_count: 1,
    language_hint: 'ja',
    content_profile: 'vocabulary_single_questions',
    classification_detail: '{"profile":"vocabulary_single_questions"}',
    chunks_count: 2,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
    ...overrides,
  };
}

function completeQuestion(
  projectId: string,
  sourceId: string,
  overrides: Partial<CompleteQuestion>,
): CompleteQuestion {
  return {
    id: 'question-1',
    project_id: projectId,
    source_id: sourceId,
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


    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
    ...overrides,
  };
}

function incompleteQuestion(
  projectId: string,
  sourceId: string,
  overrides: Partial<QuestionRead>,
): QuestionRead {
  return {
    ...completeQuestion(projectId, sourceId, {
      id: 'question-incomplete',
      question: 'Incomplete question',
      choices: ['Choice A', 'Choice B', 'Choice C', 'Choice D'],
      answer: 'Choice A',
      rationale: 'Incomplete question rationale.',
      source_excerpt: 'Incomplete question source.',
      citation_page: 1,
    }),
    ...overrides,


  };
}

function createPracticeSession(args: {
  readonly payload: PracticeSessionCreate;
  readonly playableQuestions: readonly CompleteQuestion[];
  readonly wrongAnswers: readonly WrongAnswerRead[];
  readonly projectId: string;
  readonly sessionNumber: number;
}): PracticeSessionRead {
  const mode = args.payload.mode ?? 'random_draw';
  const sourceId =
    mode === 'full_source' ? (args.payload.source_id ?? null) : null;
  const pool = practiceSessionPool(
    args.payload,
    args.playableQuestions,
    args.wrongAnswers,
  );
  const requestedCount = Math.max(
    1,
    Math.trunc(args.payload.question_count ?? pool.length),
  );
  const questionIds = pool
    .slice(0, Math.min(requestedCount, pool.length))
    .map((question) => question.id);

  return {
    id: `session-${args.sessionNumber}`,
    project_id: args.projectId,
    question_ids: questionIds,
    questions: pool
      .slice(0, Math.min(requestedCount, pool.length))
      .map(practiceSessionQuestion),
    mode,
    source_id: sourceId,
    question_count: questionIds.length,
    random_seed: args.payload.random_seed ?? 42,
    status: 'active',
    created_at: '2026-06-09T00:00:00Z',
    completed_at: null,
    abandoned_at: null,
    attempts: [],
  };
}

function practiceSessionPool(
  payload: PracticeSessionCreate,
  playableQuestions: readonly CompleteQuestion[],
  wrongAnswers: readonly WrongAnswerRead[],
): readonly CompleteQuestion[] {
  const mode = payload.mode ?? 'random_draw';
  if (mode === 'review_retry') {
    const attemptIds = new Set(payload.wrong_attempt_ids ?? []);
    const questionIds = new Set(
      wrongAnswers
        .filter((wrongAnswer) => attemptIds.has(wrongAnswer.attempt_id))
        .map((wrongAnswer) => wrongAnswer.question_id),
    );
    return playableQuestions.filter((question) => questionIds.has(question.id));
  }

  if (mode === 'full_source' && payload.source_id != null) {
    return playableQuestions.filter(
      (question) => question.source_id === payload.source_id,
    );
  }

  return playableQuestions;
}

function practiceSessionQuestion(
  question: CompleteQuestion,
): PracticeSessionRead['questions'][number] {
  return {
    id: question.id,
    question: question.question,
    choices: [...question.choices],
    answer: question.answer,
    rationale: question.rationale,
    citation_page: question.citation_page,
    source_excerpt: question.source_excerpt,
    source_id: question.source_id,
    answer_key_source: question.answer_key_source,
  };
}

function createAttempt(args: {
  readonly attemptNumber: number;
  readonly payload: PracticeAttemptCreate;
  readonly projectId: string;
  readonly session: PracticeSessionRead;
  readonly question: QuestionRead;
}): PracticeAttemptRead {
  return {
    id: `attempt-${args.attemptNumber}`,
    session_id: args.session.id,
    project_id: args.projectId,
    question_id: args.payload.question_id,
    selected_answer: args.payload.selected_answer,
    is_correct: args.payload.selected_answer === args.question.answer,
    created_at: '2026-06-09T00:02:00Z',
  };
}

function createWrongAnswer(
  attempt: PracticeAttemptRead,
  question: QuestionRead,
): WrongAnswerRead {
  return {
    attempt_id: attempt.id,
    session_id: attempt.session_id,
    question_id: question.id,
    question: question.question,
    selected_answer: attempt.selected_answer,
    correct_answer: question.answer,
    rationale: question.rationale,
    citation_page: question.citation_page,
    source_excerpt: question.source_excerpt,
    source_id: question.source_id,
    created_at: attempt.created_at,
    answer_key_source: question.answer_key_source,
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
      const question = projectState.questions.find(
        (candidate) => candidate.id === questionId,
      );
      const lastWrongAt = wrongAttempts
        .filter((attempt) => attempt.question_id === questionId)
        .at(-1)?.created_at;
      if (question === undefined || lastWrongAt === undefined) {
        return [];
      }

      return [
        {
          question_id: questionId,
          question: question.question,
          source_id: question.source_id,
          citation_page: question.citation_page,
          source_excerpt: question.source_excerpt,
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
    const key = `${wrongAnswer.source_id ?? 'none'}:${wrongAnswer.citation_page ?? 'none'}`;
    const current = clusters.get(key);
    clusters.set(key, {
      source_id: wrongAnswer.source_id,
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

function isCompletePlayableQuestion(
  question: QuestionRead,
): question is CompleteQuestion {
  const hasGrounding = question.citation_page !== null || hasSourceExcerpt(question);

  return (

    question.source_id !== null &&
    question.answer !== null &&
    question.answer.length > 0 &&
    question.choices.includes(question.answer) &&
    question.rationale !== null &&
    question.rationale.length > 0 &&
    hasGrounding
  );
}

function hasSourceExcerpt<T extends QuestionRead>(
  question: T,
): question is T & { readonly source_excerpt: string } {
  return (
    question.source_excerpt !== null && question.source_excerpt.trim().length > 0
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

let eventId = 0;

// The app rejects a frame without an id, as the backend always sends one.
async function fulfillEvent(
  route: Route,
  event: 'question-jobs' | 'question-generation',
  payload: QuestionGenerationJobList | ManualQuestionGenerationRead,
): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    headers: corsHeaders(),
    body: `id: ${++eventId}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
  });
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
