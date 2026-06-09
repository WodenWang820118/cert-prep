import { expect, test, type Route } from '@playwright/test';

const apiBaseUrl = 'http://127.0.0.1:8765';
const devToken = 'exam-prep-local-dev-token';

test('completes the local practice loop with a mocked API', async ({
  page,
}) => {
  const project = {
    id: 'project-1',
    name: 'Security+ 701',
    description: 'Local certification drill',
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
  };
  const document = {
    id: 'document-1',
    project_id: project.id,
    filename: 'security.pdf',
    sha256: 'abc123',
    page_count: 2,
    has_text: true,
    status: 'ready',
    chunks_count: 2,
    created_at: '2026-06-09T00:00:00Z',
  };
  const draft = {
    id: 'draft-1',
    project_id: project.id,
    document_id: document.id,
    chunk_id: 'chunk-1',
    question: 'Which access control principle is cited by the source?',
    choices: [
      'Apply the cited concept',
      'Ignore the cited source',
      'Choose an unrelated control',
      'Remove all safeguards',
    ],
    answer: 'Apply the cited concept',
    rationale: 'Least privilege keeps permissions scoped to the task.',
    citation_page: 1,
    source_excerpt: 'Least privilege limits access to required permissions.',
    status: 'draft',
    rejection_reason: null,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:00Z',
  };
  const session = {
    id: 'session-1',
    project_id: project.id,
    question_ids: [draft.id],
    status: 'active',
    created_at: '2026-06-09T00:00:00Z',
    completed_at: null,
  };
  let draftGenerated = false;
  const wrongAnswers: unknown[] = [];
  const seenPaths = new Set<string>();

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

    seenPaths.add(`${method} ${path}`);

    if (method === 'GET' && path === '/llm/health') {
      await fulfillJson(route, 200, {
        provider: 'fake',
        model: 'gemma4:12b',
        available: true,
        detail: 'deterministic local fake provider',
      });
      return;
    }

    if (method === 'GET' && path === '/projects') {
      await fulfillJson(route, 200, { items: [] });
      return;
    }

    if (method === 'POST' && path === '/projects') {
      await fulfillJson(route, 201, project);
      return;
    }

    if (
      method === 'GET' &&
      path === `/projects/${project.id}/question-drafts`
    ) {
      await fulfillJson(
        route,
        200,
        draftGenerated ? { items: [draft] } : { items: [] },
      );
      return;
    }

    if (method === 'GET' && path === `/projects/${project.id}/wrong-answers`) {
      await fulfillJson(route, 200, { items: wrongAnswers });
      return;
    }

    if (method === 'POST' && path === `/projects/${project.id}/documents`) {
      await fulfillJson(route, 201, document);
      return;
    }

    if (
      method === 'POST' &&
      path === `/projects/${project.id}/documents/${document.id}/drafts`
    ) {
      draftGenerated = true;
      await fulfillJson(route, 201, { items: [draft] });
      return;
    }

    if (
      method === 'POST' &&
      path === `/projects/${project.id}/question-drafts/${draft.id}/approve`
    ) {
      draft.status = 'approved';
      draft.updated_at = '2026-06-09T00:01:00Z';
      await fulfillJson(route, 200, draft);
      return;
    }

    if (
      method === 'POST' &&
      path === `/projects/${project.id}/practice-sessions`
    ) {
      await fulfillJson(route, 201, session);
      return;
    }

    if (
      method === 'GET' &&
      path === `/projects/${project.id}/practice-sessions/${session.id}`
    ) {
      await fulfillJson(route, 200, session);
      return;
    }

    if (
      method === 'POST' &&
      path ===
        `/projects/${project.id}/practice-sessions/${session.id}/attempts`
    ) {
      const payload = parseJsonBody(request.postData());
      wrongAnswers.push({
        attempt_id: 'attempt-1',
        session_id: session.id,
        question_id: draft.id,
        question: draft.question,
        selected_answer: payload['selected_answer'],
        correct_answer: draft.answer,
        rationale: draft.rationale,
        citation_page: draft.citation_page,
        source_excerpt: draft.source_excerpt,
        created_at: '2026-06-09T00:02:00Z',
      });
      await fulfillJson(route, 201, {
        id: 'attempt-1',
        session_id: session.id,
        project_id: project.id,
        question_id: draft.id,
        selected_answer: payload['selected_answer'],
        is_correct: false,
        created_at: '2026-06-09T00:02:00Z',
      });
      return;
    }

    await fulfillJson(route, 404, {
      code: 'not_found',
      message: `${method} ${path} was not mocked.`,
    });
  });

  await page.addInitScript(
    ([baseUrl, token]) => {
      localStorage.setItem('examPrepApiBaseUrl', baseUrl);
      localStorage.setItem('examPrepApiToken', token);
    },
    [apiBaseUrl, devToken],
  );

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Exam Prep' })).toBeVisible();
  await expect(page.getByText('fake / gemma4:12b')).toBeVisible();

  await page.getByLabel('Name').fill(project.name);
  await page.getByLabel('Description').fill(project.description);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(
    page.getByRole('button', { name: /Security\+ 701/ }),
  ).toBeVisible();

  await page.getByLabel('PDF file').setInputFiles({
    name: document.filename,
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% mocked text pdf\n'),
  });
  await page.getByRole('button', { name: 'Upload PDF' }).click();
  await expect(page.getByText(document.filename)).toBeVisible();

  await page.getByRole('button', { name: 'Generate cited drafts' }).click();
  await expect(page.getByText(draft.question)).toBeVisible();
  await expect(page.getByText(draft.source_excerpt)).toBeVisible();

  await page.getByRole('button', { name: 'Approve draft' }).click();
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Create practice session' }).click();
  await expect(page.getByText(`Session ${session.id}`)).toBeVisible();

  await page.getByLabel('Ignore the cited source').check();
  await page.getByRole('button', { name: 'Submit answer' }).click();

  await expect(page.getByText('Needs review')).toBeVisible();
  await expect(page.getByText(`Correct: ${draft.answer}`)).toBeVisible();
  await expect(page.getByText(draft.rationale)).toBeVisible();

  expect(seenPaths).toEqual(
    new Set([
      'GET /llm/health',
      'GET /projects',
      'POST /projects',
      `POST /projects/${project.id}/documents`,
      `POST /projects/${project.id}/documents/${document.id}/drafts`,
      `GET /projects/${project.id}/question-drafts`,
      `POST /projects/${project.id}/question-drafts/${draft.id}/approve`,
      `POST /projects/${project.id}/practice-sessions`,
      `GET /projects/${project.id}/practice-sessions/${session.id}`,
      `POST /projects/${project.id}/practice-sessions/${session.id}/attempts`,
      `GET /projects/${project.id}/wrong-answers`,
    ]),
  );
});

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

function parseJsonBody(body: string | null): Record<string, string> {
  if (body === null || body.length === 0) {
    return {};
  }

  return JSON.parse(body) as Record<string, string>;
}
