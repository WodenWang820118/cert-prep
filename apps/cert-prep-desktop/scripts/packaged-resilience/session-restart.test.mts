import assert from 'node:assert/strict';
import test from 'node:test';

import type { Page, Response } from 'playwright';

import type {
  JsonRequestOptions,
  JsonResponse,
  JsonTransport,
} from './api-client.mts';
import { runSessionRestartScenario } from './session-restart.mts';

const projectId = 'project-1';
const documentId = 'document-1';
const sessionId = 'session-1';
const sessionsPath = `/projects/${projectId}/practice-sessions`;
const sessionPath = `${sessionsPath}/${sessionId}`;
const questionOne = question('question-1', 'Answer 1');
const questionTwo = question('question-2', 'Answer 2');

test('refreshes transport and page through the caller across two forced restarts', async () => {
  const firstAttempt = attempt('attempt-1', questionOne.id);
  const secondAttempt = attempt('attempt-2', questionTwo.id);
  const resumedSession = session('active', [firstAttempt]);
  const completedSession = session('completed', [firstAttempt, secondAttempt]);
  const initialTransport = new ScriptedTransport('initial', [
    request('GET', `/projects/${projectId}/question-drafts`, {
      status: 200,
      body: { items: [draft(questionOne), draft(questionTwo)] },
    }),
    request(
      'POST',
      sessionsPath,
      { status: 201, body: session('active', []) },
      { data: { mode: 'full_document', document_id: documentId } },
    ),
    request(
      'POST',
      `${sessionPath}/attempts`,
      { status: 201, body: firstAttempt },
      {
        data: {
          question_id: questionOne.id,
          selected_answer: questionOne.answer,
        },
      },
    ),
  ]);
  const firstRestartTransport = new ScriptedTransport('first restart', [
    request('GET', sessionsPath, {
      status: 200,
      body: { items: [activeSessionSummary()] },
    }),
    request(
      'POST',
      `${sessionPath}/attempts`,
      { status: 201, body: secondAttempt },
      {
        data: {
          question_id: questionTwo.id,
          selected_answer: questionTwo.answer,
        },
      },
    ),
    request('GET', sessionPath, { status: 200, body: completedSession }),
  ]);
  const secondRestartTransport = new ScriptedTransport('second restart', [
    request('GET', sessionsPath, { status: 200, body: { items: [] } }),
    request('GET', sessionPath, { status: 200, body: completedSession }),
  ]);
  const firstRestartPage = resumePage(resumedSession, 43_021);
  const secondRestartPage = unusedPage();
  const restartLabels: string[] = [];

  const proof = await runSessionRestartScenario({
    transport: initialTransport,
    page: unusedPage(),
    projectId,
    documentId,
    timeoutMs: 1_000,
    restart: async (label) => {
      restartLabels.push(label);
      if (label === 'session-first-restart') {
        return {
          transport: firstRestartTransport,
          page: firstRestartPage.page,
        };
      }
      if (label === 'session-second-restart') {
        return {
          transport: secondRestartTransport,
          page: secondRestartPage,
        };
      }
      throw new Error(`Unexpected restart label: ${label}`);
    },
  });

  assert.deepEqual(restartLabels, [
    'session-first-restart',
    'session-second-restart',
  ]);
  assert.deepEqual(proof, {
    projectId,
    sessionId,
    answeredBeforeFirstRestart: 1,
    firstRestart: {
      projectId,
      activeSessionIds: [sessionId],
      explicitAction: 'resume',
      resumedSessionId: sessionId,
      restoredAttemptCount: 1,
    },
    completion: {
      sessionId,
      status: 'completed',
      questionCount: 2,
      attemptCount: 2,
    },
    secondRestart: {
      sessionId,
      activeSessionIds: [],
      completedSessionStatus: 'completed',
    },
  });
  assert.deepEqual(firstRestartPage.actions, [
    'open-random-quiz',
    'wait-for-resume-response',
    'wait-for-resume-button',
    'click-resume',
  ]);
  initialTransport.assertConsumed();
  firstRestartTransport.assertConsumed();
  secondRestartTransport.assertConsumed();
});

test('rejects a new full-document session with fewer than two questions', async () => {
  const transport = new ScriptedTransport('one-question session', [
    request('GET', `/projects/${projectId}/question-drafts`, {
      status: 200,
      body: { items: [draft(questionOne), draft(questionTwo)] },
    }),
    request('POST', sessionsPath, {
      status: 201,
      body: session('active', [], { questions: [questionOne] }),
    }),
  ]);

  await assert.rejects(
    runSessionRestartScenario({
      transport,
      page: unusedPage(),
      projectId,
      documentId,
      timeoutMs: 1_000,
      restart: async () => {
        throw new Error('A one-question session must fail before restart.');
      },
    }),
    /at least two questions/,
  );
  transport.assertConsumed();
});

test('fails closed when a session response drifts to another project', async () => {
  const transport = new ScriptedTransport('project drift', [
    request('GET', `/projects/${projectId}/question-drafts`, {
      status: 200,
      body: { items: [draft(questionOne), draft(questionTwo)] },
    }),
    request('POST', sessionsPath, {
      status: 201,
      body: session('active', [], { projectId: 'project-other' }),
    }),
  ]);

  await assert.rejects(
    runSessionRestartScenario({
      transport,
      page: unusedPage(),
      projectId,
      documentId,
      timeoutMs: 1_000,
      restart: async () => {
        throw new Error('Project drift must fail before restart.');
      },
    }),
    /session response scope did not match/,
  );
  transport.assertConsumed();
});

test('fails closed when the explicit Resume response has another session ID', async () => {
  await assertResumeRejects(
    session('active', [attempt('attempt-1', questionOne.id)], {
      sessionId: 'session-other',
    }),
    /session response scope did not match/,
  );
});

test('fails closed when a restored attempt references a foreign question', async () => {
  await assertResumeRejects(
    session('active', [attempt('attempt-foreign', 'question-other')]),
    /attempt question scope did not match/,
  );
});

async function assertResumeRejects(
  resumeBody: Record<string, unknown>,
  expected: RegExp,
): Promise<void> {
  const firstAttempt = attempt('attempt-1', questionOne.id);
  const initialTransport = new ScriptedTransport('resume setup', [
    request('GET', `/projects/${projectId}/question-drafts`, {
      status: 200,
      body: { items: [draft(questionOne), draft(questionTwo)] },
    }),
    request('POST', sessionsPath, {
      status: 201,
      body: session('active', []),
    }),
    request('POST', `${sessionPath}/attempts`, {
      status: 201,
      body: firstAttempt,
    }),
  ]);
  const restartedTransport = new ScriptedTransport('resume drift', [
    request('GET', sessionsPath, {
      status: 200,
      body: { items: [activeSessionSummary()] },
    }),
  ]);
  const restartedPage = resumePage(resumeBody, 43_022);

  await assert.rejects(
    runSessionRestartScenario({
      transport: initialTransport,
      page: unusedPage(),
      projectId,
      documentId,
      timeoutMs: 1_000,
      restart: async (label) => {
        assert.equal(label, 'session-first-restart');
        return {
          transport: restartedTransport,
          page: restartedPage.page,
        };
      },
    }),
    expected,
  );
  initialTransport.assertConsumed();
  restartedTransport.assertConsumed();
}

interface ExpectedRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly response: JsonResponse;
  readonly options?: JsonRequestOptions;
}

class ScriptedTransport implements JsonTransport {
  readonly #label: string;
  readonly #requests: ExpectedRequest[];
  #index = 0;

  constructor(label: string, requests: readonly ExpectedRequest[]) {
    this.#label = label;
    this.#requests = [...requests];
  }

  async request(
    method: ExpectedRequest['method'],
    path: string,
    options?: JsonRequestOptions,
  ): Promise<JsonResponse> {
    const expected = this.#requests[this.#index];
    assert.ok(expected, `${this.#label}: unexpected ${method} ${path}.`);
    assert.equal(method, expected.method, `${this.#label}: request method.`);
    assert.equal(path, expected.path, `${this.#label}: request path.`);
    if (expected.options !== undefined) {
      assert.deepEqual(options, expected.options, `${this.#label}: options.`);
    }
    this.#index += 1;
    return expected.response;
  }

  assertConsumed(): void {
    assert.equal(
      this.#index,
      this.#requests.length,
      `${this.#label}: scripted requests consumed.`,
    );
  }
}

function request(
  method: ExpectedRequest['method'],
  path: string,
  response: JsonResponse,
  options?: JsonRequestOptions,
): ExpectedRequest {
  return { method, path, response, options };
}

interface TestQuestion {
  readonly id: string;
  readonly answer: string;
  readonly document_id: string;
}

function question(id: string, answer: string): TestQuestion {
  return { id, answer, document_id: documentId };
}

function draft(value: TestQuestion): Record<string, unknown> {
  return {
    id: value.id,
    project_id: projectId,
    document_id: value.document_id,
    answer: value.answer,
  };
}

function attempt(id: string, questionId: string): Record<string, unknown> {
  return {
    id,
    project_id: projectId,
    session_id: sessionId,
    question_id: questionId,
  };
}

interface SessionOverrides {
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly questions?: readonly TestQuestion[];
}

function session(
  status: 'active' | 'completed',
  attempts: readonly Record<string, unknown>[],
  overrides: SessionOverrides = {},
): Record<string, unknown> {
  const questions = overrides.questions ?? [questionOne, questionTwo];
  return {
    id: overrides.sessionId ?? sessionId,
    project_id: overrides.projectId ?? projectId,
    question_ids: questions.map((value) => value.id),
    questions: questions.map((value) => ({ ...value })),
    mode: 'full_document',
    document_id: documentId,
    status,
    attempts: [...attempts],
  };
}

function activeSessionSummary(): Record<string, unknown> {
  return {
    id: sessionId,
    project_id: projectId,
    mode: 'full_document',
    document_id: documentId,
    status: 'active',
  };
}

interface ResumePage {
  readonly page: Page;
  readonly actions: string[];
}

function resumePage(
  resumeBody: Record<string, unknown>,
  port: number,
): ResumePage {
  const actions: string[] = [];
  const navigation = fakeLocator({
    visible: true,
    onClick: () => actions.push('open-random-quiz'),
  });
  const resume = fakeLocator({
    visible: true,
    onWait: () => actions.push('wait-for-resume-button'),
    onClick: () => actions.push('click-resume'),
  });
  const page = {
    getByRole: (_role: string, options?: { name?: string | RegExp }) =>
      String(options?.name).includes('Resume session') ? resume : navigation,
    waitForResponse: async (predicate: (response: Response) => boolean) => {
      actions.push('wait-for-resume-response');
      const response = {
        request: () => ({ method: () => 'GET' }),
        url: () => `http://127.0.0.1:${port}${sessionPath}`,
        status: () => 200,
        json: async () => resumeBody,
      } as unknown as Response;
      assert.equal(predicate(response), true);
      return response;
    },
  } as unknown as Page;
  return { page, actions };
}

interface FakeLocatorOptions {
  readonly visible: boolean;
  readonly onWait?: () => void;
  readonly onClick?: () => void;
}

function fakeLocator({ visible, onWait, onClick }: FakeLocatorOptions) {
  const locator = {
    or: () => locator,
    first: () => locator,
    isVisible: async () => visible,
    waitFor: async () => onWait?.(),
    click: async () => onClick?.(),
  };
  return locator;
}

function unusedPage(): Page {
  return {} as Page;
}
