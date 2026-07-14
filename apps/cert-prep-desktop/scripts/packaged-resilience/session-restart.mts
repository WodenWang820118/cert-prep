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
    (body) => usableQuestions(body).length >= 2,
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
  );
  const sessionId = stringField(created.id, 'practice session id');
  const sessionPath = `${sessionsPath}/${encoded(sessionId)}`;
  const firstQuestion = sessionQuestions(created)[0];
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
  );
  if (!activeAfterFirstRestart.includes(sessionId)) {
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
    sessionId,
  );
  const restoredAttempts = sessionAttempts(resumed);
  if (restoredAttempts.length !== 1) {
    throw new Error('Explicit Resume did not restore exactly one attempt.');
  }

  const attemptedIds = new Set(restoredAttempts.map((attempt) => attempt.question_id));
  for (const question of sessionQuestions(resumed)) {
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
    sessionId,
  );
  const questionCount = sessionQuestions(completed).length;
  const attemptCount = sessionAttempts(completed).length;
  if (completed.status !== 'completed' || attemptCount < questionCount) {
    throw new Error('Practice session did not reach completed with all attempts.');
  }

  ({ transport } = await restart('session-second-restart'));
  const activeAfterSecondRestart = activeSessionIds(
    requireJsonObject(
      await transport.request('GET', sessionsPath),
      [200],
      'active sessions after second restart',
    ),
    projectId,
  );
  const completedAfterSecondRestart = exactSession(
    requireJsonObject(
      await transport.request('GET', sessionPath),
      [200],
      'completed session after second restart',
    ),
    projectId,
    sessionId,
  );
  if (
    activeAfterSecondRestart.length !== 0 ||
    completedAfterSecondRestart.status !== 'completed'
  ) {
    throw new Error('Second restart did not retain completion without Resume.');
  }

  return {
    projectId,
    sessionId,
    answeredBeforeFirstRestart: 1,
    firstRestart: {
      projectId,
      activeSessionIds: activeAfterFirstRestart,
      explicitAction: 'resume',
      resumedSessionId: stringField(resumed.id, 'resumed session id'),
      restoredAttemptCount: restoredAttempts.length,
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
  sessionId?: string,
): Record<string, unknown> {
  if (
    body.project_id !== projectId ||
    (sessionId !== undefined && body.id !== sessionId)
  ) {
    throw new Error('Practice session response scope did not match.');
  }
  stringField(body.id, 'session id');
  stringField(body.status, 'session status');
  sessionQuestions(body);
  sessionAttempts(body);
  return body;
}

function sessionQuestions(
  session: Record<string, unknown>,
): Array<{ id: string; answer: string }> {
  if (!Array.isArray(session.questions) || session.questions.length === 0) {
    throw new Error('Practice session questions were missing.');
  }
  return session.questions.map((raw) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Practice session question was invalid.');
    }
    const question = raw as Record<string, unknown>;
    return {
      id: stringField(question.id, 'session question id'),
      answer: stringField(question.answer, 'session question answer'),
    };
  });
}

function sessionAttempts(
  session: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (!Array.isArray(session.attempts)) {
    throw new Error('Practice session attempts were missing.');
  }
  return session.attempts.map((raw) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Practice session attempt was invalid.');
    }
    return raw as Record<string, unknown>;
  });
}

function activeSessionIds(
  body: Record<string, unknown>,
  projectId: string,
): string[] {
  if (!Array.isArray(body.items)) {
    throw new Error('Active practice session list was invalid.');
  }
  return body.items.map((raw) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Active practice session item was invalid.');
    }
    const item = raw as Record<string, unknown>;
    if (item.project_id !== projectId || item.status !== 'active') {
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
}

function usableQuestions(body: Record<string, unknown>): unknown[] {
  if (!Array.isArray(body.items)) {
    return [];
  }
  return body.items.filter(
    (raw) =>
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as Record<string, unknown>).answer === 'string' &&
      ((raw as Record<string, unknown>).answer as string).trim().length > 0,
  );
}
