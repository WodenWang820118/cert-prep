import type { Page } from 'playwright';

import type { JsonTransport } from './api-client.mts';
import { requireJsonObject } from './api-client.mts';
import { encoded, pollJson, stringField } from './scenario-utils.mts';

export interface RestartedPackagedContext {
  readonly transport: JsonTransport;
  readonly page: Page;
}

export interface SessionRestartScenarioOptions {
  readonly transport: JsonTransport;
  readonly page: Page;
  readonly projectId: string;
  readonly documentId: string;
  readonly timeoutMs: number;
  readonly restart: (label: string) => Promise<RestartedPackagedContext>;
}

export async function runSessionRestartScenario({
  transport: initialTransport,
  page: initialPage,
  projectId,
  documentId,
  timeoutMs,
  restart,
}: SessionRestartScenarioOptions): Promise<Record<string, unknown>> {
  let transport = initialTransport;
  let page = initialPage;
  const draftsPath = `/projects/${encoded(projectId)}/question-drafts`;
  await pollJson(
    transport,
    draftsPath,
    (body) => usableQuestions(body, projectId, documentId).length >= 2,
    { timeoutMs, label: 'session restart question drafts' },
  );
  const sessionsPath = `/projects/${encoded(projectId)}/practice-sessions`;
  const created = exactSession(
    requireJsonObject(
      await transport.request('POST', sessionsPath, {
        data: { mode: 'full_document', document_id: documentId },
      }),
      [201],
      'session restart create',
    ),
    projectId,
    documentId,
  );
  const sessionId = created.id;
  const sessionPath = `${sessionsPath}/${encoded(sessionId)}`;
  if (
    created.status !== 'active' ||
    created.questions.length < 2 ||
    created.attempts.length !== 0
  ) {
    throw new Error(
      'New practice session was not an unanswered active session with at least two questions.',
    );
  }
  const firstQuestion = created.questions[0];
  if (!firstQuestion) {
    throw new Error('Practice session did not contain a first question.');
  }
  const firstAttempt = requireJsonObject(
    await transport.request('POST', `${sessionPath}/attempts`, {
      data: {
        question_id: firstQuestion.id,
        selected_answer: firstQuestion.answer,
      },
    }),
    [201],
    'first practice attempt',
  );
  assertAttemptScope(firstAttempt, projectId, sessionId, firstQuestion.id);

  ({ transport, page } = await restart('session-first-restart'));
  const activeAfterFirstRestart = activeSessionIds(
    requireJsonObject(
      await transport.request('GET', sessionsPath),
      [200],
      'active sessions after first restart',
    ),
    projectId,
    documentId,
  );
  if (
    activeAfterFirstRestart.length !== 1 ||
    activeAfterFirstRestart[0] !== sessionId
  ) {
    throw new Error('First restart did not expose the exact active session.');
  }

  await openRandomQuiz(page);
  const resumeResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method().toUpperCase() === 'GET' &&
      new URL(response.url()).pathname === sessionPath,
    { timeout: timeoutMs },
  );
  const resumeButton = page.getByRole('button', { name: /Resume session/i });
  await resumeButton.waitFor({ state: 'visible', timeout: timeoutMs });
  await resumeButton.click();
  const resumeResponse = await resumeResponsePromise;
  const resumed = exactSession(
    requireJsonObject(
      {
        status: resumeResponse.status(),
        body: await resumeResponse.json().catch(() => null),
      },
      [200],
      'explicit Resume response',
    ),
    projectId,
    documentId,
    sessionId,
  );
  if (resumed.status !== 'active' || resumed.attempts.length !== 1) {
    throw new Error('Explicit Resume did not restore exactly one attempt.');
  }

  const attemptedIds = new Set(
    resumed.attempts.map((attempt) => attempt.questionId),
  );
  for (const question of resumed.questions) {
    if (attemptedIds.has(question.id)) {
      continue;
    }
    const attempt = requireJsonObject(
      await transport.request('POST', `${sessionPath}/attempts`, {
        data: { question_id: question.id, selected_answer: question.answer },
      }),
      [201],
      'practice completion attempt',
    );
    assertAttemptScope(attempt, projectId, sessionId, question.id);
  }
  const completed = exactSession(
    requireJsonObject(
      await transport.request('GET', sessionPath),
      [200],
      'completed practice session',
    ),
    projectId,
    documentId,
    sessionId,
  );
  assertCompletedSession(completed, 'Practice session');
  const questionCount = completed.questions.length;
  const attemptCount = completed.attempts.length;

  ({ transport } = await restart('session-second-restart'));
  const activeAfterSecondRestart = activeSessionIds(
    requireJsonObject(
      await transport.request('GET', sessionsPath),
      [200],
      'active sessions after second restart',
    ),
    projectId,
    documentId,
  );
  const completedAfterSecondRestart = exactSession(
    requireJsonObject(
      await transport.request('GET', sessionPath),
      [200],
      'completed session after second restart',
    ),
    projectId,
    documentId,
    sessionId,
  );
  assertCompletedSession(completedAfterSecondRestart, 'Restarted practice session');
  if (activeAfterSecondRestart.length !== 0) {
    throw new Error('Second restart did not retain completion without Resume.');
  }
  assertRetainedCompletion(completed, completedAfterSecondRestart);

  return {
    projectId,
    sessionId,
    answeredBeforeFirstRestart: 1,
    firstRestart: {
      projectId,
      activeSessionIds: activeAfterFirstRestart,
      explicitAction: 'resume',
      resumedSessionId: resumed.id,
      restoredAttemptCount: resumed.attempts.length,
    },
    completion: {
      sessionId,
      status: completed.status,
      questionCount,
      attemptCount,
    },
    secondRestart: {
      sessionId,
      activeSessionIds: activeAfterSecondRestart,
      completedSessionStatus: completedAfterSecondRestart.status,
    },
  };
}

interface SessionQuestion {
  readonly id: string;
  readonly answer: string;
}

interface SessionAttempt {
  readonly questionId: string;
  readonly raw: Record<string, unknown>;
}

interface ValidatedSession {
  readonly id: string;
  readonly status: string;
  readonly questions: readonly SessionQuestion[];
  readonly attempts: readonly SessionAttempt[];
}

async function openRandomQuiz(page: Page): Promise<void> {
  const navigation = page
    .getByRole('button', { name: /^\s*Random Quiz\s*$/ })
    .or(page.getByRole('link', { name: /^\s*Random Quiz\s*$/ }))
    .first();
  if (await navigation.isVisible().catch(() => false)) {
    await navigation.click();
  }
}

function exactSession(
  body: Record<string, unknown>,
  projectId: string,
  documentId: string,
  sessionId?: string,
): ValidatedSession {
  if (
    body.project_id !== projectId ||
    (sessionId !== undefined && body.id !== sessionId)
  ) {
    throw new Error('Practice session response scope did not match.');
  }
  if (body.mode !== 'full_document' || body.document_id !== documentId) {
    throw new Error('Practice session document scope did not match.');
  }
  const id = stringField(body.id, 'session id');
  const status = stringField(body.status, 'session status');
  const questionIds = sessionQuestionIds(body);
  const questions = sessionQuestions(body, documentId);
  if (
    questionIds.length !== questions.length ||
    questionIds.some((questionId, index) => questionId !== questions[index]?.id)
  ) {
    throw new Error('Practice session question scope did not match.');
  }
  const attempts = sessionAttempts(body, projectId, id, new Set(questionIds));
  return { id, status, questions, attempts };
}

function sessionQuestions(
  session: Record<string, unknown>,
  documentId: string,
): SessionQuestion[] {
  if (!Array.isArray(session.questions) || session.questions.length === 0) {
    throw new Error('Practice session questions were missing.');
  }
  const seen = new Set<string>();
  return session.questions.map((raw) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Practice session question was invalid.');
    }
    const question = raw as Record<string, unknown>;
    const id = stringField(question.id, 'session question id');
    if (question.document_id !== documentId || seen.has(id)) {
      throw new Error('Practice session question scope did not match.');
    }
    seen.add(id);
    return {
      id,
      answer: stringField(question.answer, 'session question answer'),
    };
  });
}

function sessionQuestionIds(session: Record<string, unknown>): string[] {
  if (!Array.isArray(session.question_ids) || session.question_ids.length === 0) {
    throw new Error('Practice session question IDs were missing.');
  }
  const questionIds = session.question_ids.map((value) =>
    stringField(value, 'session question ID'),
  );
  if (new Set(questionIds).size !== questionIds.length) {
    throw new Error('Practice session question scope did not match.');
  }
  return questionIds;
}

function sessionAttempts(
  session: Record<string, unknown>,
  projectId: string,
  sessionId: string,
  questionIds: ReadonlySet<string>,
): SessionAttempt[] {
  if (!Array.isArray(session.attempts)) {
    throw new Error('Practice session attempts were missing.');
  }
  const seen = new Set<string>();
  return session.attempts.map((raw) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Practice session attempt was invalid.');
    }
    const attempt = raw as Record<string, unknown>;
    const questionId = stringField(
      attempt.question_id,
      'practice attempt question id',
    );
    if (!questionIds.has(questionId) || seen.has(questionId)) {
      throw new Error('Practice session attempt question scope did not match.');
    }
    assertAttemptScope(attempt, projectId, sessionId, questionId);
    seen.add(questionId);
    return { questionId, raw: attempt };
  });
}

function activeSessionIds(
  body: Record<string, unknown>,
  projectId: string,
  documentId: string,
): string[] {
  if (!Array.isArray(body.items)) {
    throw new Error('Active practice session list was invalid.');
  }
  return body.items.map((raw) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Active practice session item was invalid.');
    }
    const item = raw as Record<string, unknown>;
    if (
      item.project_id !== projectId ||
      item.status !== 'active' ||
      item.mode !== 'full_document' ||
      item.document_id !== documentId
    ) {
      throw new Error('Active session response was not bound to the project.');
    }
    return stringField(item.id, 'active session id');
  });
}

function assertAttemptScope(
  body: Record<string, unknown>,
  projectId: string,
  sessionId: string,
  questionId: string,
): void {
  if (
    body.project_id !== projectId ||
    body.session_id !== sessionId ||
    body.question_id !== questionId
  ) {
    throw new Error('Practice attempt response scope did not match.');
  }
  stringField(body.id, 'practice attempt id');
}

function usableQuestions(
  body: Record<string, unknown>,
  projectId: string,
  documentId: string,
): unknown[] {
  if (!Array.isArray(body.items)) {
    throw new Error('Question draft response was invalid.');
  }
  for (const raw of body.items) {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      (raw as Record<string, unknown>).project_id !== projectId
    ) {
      throw new Error('Question draft response scope did not match.');
    }
  }
  return body.items.filter(
    (raw) =>
      typeof raw === 'object' &&
      raw !== null &&
      (raw as Record<string, unknown>).document_id === documentId &&
      typeof (raw as Record<string, unknown>).answer === 'string' &&
      ((raw as Record<string, unknown>).answer as string).trim().length > 0,
  );
}

function assertCompletedSession(
  session: ValidatedSession,
  label: string,
): void {
  const answeredIds = new Set(
    session.attempts.map((attempt) => attempt.questionId),
  );
  if (
    session.status !== 'completed' ||
    session.attempts.length !== session.questions.length ||
    session.questions.some((question) => !answeredIds.has(question.id))
  ) {
    throw new Error(`${label} did not reach completed with all attempts.`);
  }
}

function assertRetainedCompletion(
  beforeRestart: ValidatedSession,
  afterRestart: ValidatedSession,
): void {
  const beforeQuestions = beforeRestart.questions.map((question) => question.id);
  const afterQuestions = afterRestart.questions.map((question) => question.id);
  const beforeAttempts = beforeRestart.attempts.map(
    (attempt) => attempt.questionId,
  );
  const afterAttempts = afterRestart.attempts.map(
    (attempt) => attempt.questionId,
  );
  if (
    JSON.stringify(beforeQuestions) !== JSON.stringify(afterQuestions) ||
    JSON.stringify(beforeAttempts) !== JSON.stringify(afterAttempts)
  ) {
    throw new Error('Second restart did not retain the completed session state.');
  }
}
