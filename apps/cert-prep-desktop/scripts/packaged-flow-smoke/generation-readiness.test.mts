import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { APIResponse, Page, Response } from 'playwright';

import {
  captureGenerationReadinessAtProjectCreate,
  captureProjectApiAfterRestart,
  isProjectDocumentsCollectionResponse,
} from './generation-readiness.mts';
import { waitForUploadDocumentResponse } from './streaming-capture-api.mts';
import type { SmokeRunState } from './types.mts';

const API_BASE_URL = 'http://127.0.0.1:8765';
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const DOCUMENT_ID = '00000000-0000-4000-8000-000000000002';
const AUTH_TOKEN = 'alpha.super-secret-token';
const AUTHORIZATION = `Bearer ${AUTH_TOKEN}`;
const INSTALLED_PATH = 'C:\\Program Files\\FastFlowLM\\flm.exe';
const TERMS_URL =
  'https://raw.githubusercontent.com/FastFlowLM/FastFlowLM/v0.9.43/src/inno/terms.txt';

interface GetCall {
  readonly url: string;
  readonly options: Record<string, unknown>;
}

class FakePage {
  readonly responseListeners = new Set<(response: Response) => void>();
  readonly getCalls: GetCall[] = [];
  readonly routes = new Map<
    string,
    () => APIResponse | Promise<APIResponse>
  >();

  readonly request = {
    get: async (url: string, options: Record<string, unknown>) => {
      this.getCalls.push({ url, options });
      const route = this.routes.get(url);
      if (!route) {
        throw new Error('unregistered readiness route');
      }
      return route();
    },
  };

  on(event: string, listener: (response: Response) => void): this {
    assert.equal(event, 'response');
    this.responseListeners.add(listener);
    return this;
  }

  off(event: string, listener: (response: Response) => void): this {
    assert.equal(event, 'response');
    this.responseListeners.delete(listener);
    return this;
  }

  emit(response: Response): void {
    for (const listener of [...this.responseListeners]) {
      listener(response);
    }
  }
}

class RestartFakePage {
  reloadCalls = 0;
  private readonly response: Response;
  private predicate: ((response: Response) => boolean) | null = null;
  private resolveResponse: ((response: Response) => void) | null = null;

  constructor(response: Response) {
    this.response = response;
  }

  waitForResponse(
    predicate: (response: Response) => boolean,
  ): Promise<Response> {
    this.predicate = predicate;
    return new Promise<Response>((resolve) => {
      this.resolveResponse = resolve;
    });
  }

  async reload(): Promise<null> {
    this.reloadCalls += 1;
    if (this.predicate?.(this.response)) {
      this.resolveResponse?.(this.response);
    }
    return null;
  }
}

test('restart API capture reloads and replaces the backend origin and token', async () => {
  const restartedAuthorization = 'Bearer restarted-token';
  const page = new RestartFakePage(
    response({
      url: 'http://127.0.0.1:8877/projects',
      authorization: restartedAuthorization,
      status: 200,
      payload: { items: [{ id: PROJECT_ID }] },
      method: 'GET',
    }),
  );

  const projectApi = await captureProjectApiAfterRestart(
    page as unknown as Page,
    PROJECT_ID,
  );

  assert.equal(page.reloadCalls, 1);
  assert.deepEqual(projectApi, {
    apiBaseUrl: 'http://127.0.0.1:8877',
    authorization: restartedAuthorization,
    projectId: PROJECT_ID,
  });
});

test('restart API capture rejects a project list without the exact project', async () => {
  const page = new RestartFakePage(
    response({
      url: 'http://127.0.0.1:8877/projects',
      authorization: 'Bearer restarted-token',
      status: 200,
      payload: { items: [{ id: DOCUMENT_ID }] },
      method: 'GET',
    }),
  );

  await assert.rejects(
    captureProjectApiAfterRestart(page as unknown as Page, PROJECT_ID),
    /did not contain the exact project/,
  );
});

test('captures generation readiness from the exact project response before upload', async () => {
  const page = readyPage();
  const run = smokeRun();
  const order: string[] = [];
  let nowIndex = 0;
  const nowValues = [
    new Date('2026-07-13T01:00:00.000Z'),
    new Date('2026-07-13T01:00:01.000Z'),
  ];

  await captureGenerationReadinessAtProjectCreate(
    run,
    async () => {
      assert.equal(page.responseListeners.size, 1);
      order.push('project-submit');
      page.emit(projectResponse());
    },
    {
      page: page as unknown as Page,
      now: () => nowValues[Math.min(nowIndex++, nowValues.length - 1)],
      installedPathVerifier: (path) => {
        assert.equal(path, INSTALLED_PATH);
        return true;
      },
    },
  );
  order.push('upload');

  assert.equal(page.responseListeners.size, 0);
  assert.deepEqual(order, ['project-submit', 'upload']);
  assert.deepEqual(run.projectApi, {
    apiBaseUrl: API_BASE_URL,
    authorization: AUTHORIZATION,
    projectId: PROJECT_ID,
  });
  assert.equal(run.trustedFastFlowExecutablePath, INSTALLED_PATH);
  const readiness = run.metrics.generation_readiness_at_start;
  assert.ok(readiness);
  assert.equal(readiness.captured_at, '2026-07-13T01:00:01.000Z');
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.blockers, []);
  assert.equal(readiness.provider_selection?.preference, 'auto');
  assert.equal(readiness.provider_selection?.effective_provider, 'fastflowlm');
  assert.equal(readiness.provider_selection?.effective_model, 'qwen3.5:4b');
  assert.equal(
    readiness.provider_selection?.selection_reason,
    'provider_selection_reported',
  );
  assert.deepEqual(
    readiness.runtime_requirements.map((item) => ({
      kind: item.kind,
      available: item.available,
      version: item.version,
      installed_path_verified: item.installed_path_verified,
    })),
    [
      {
        kind: 'fastflowlm',
        available: true,
        version: '0.9.43',
        installed_path_verified: true,
      },
      {
        kind: 'fastflowlm_model',
        available: true,
        version: 'qwen3.5:4b',
        installed_path_verified: false,
      },
    ],
  );
  assert.deepEqual(
    page.getCalls.map(({ url }) => url),
    [
      `${API_BASE_URL}/llm/provider-selection`,
      `${API_BASE_URL}/runtime/requirements`,
    ],
  );
  for (const call of page.getCalls) {
    assert.deepEqual(call.options.headers, { Authorization: AUTHORIZATION });
    assert.equal(call.options.timeout, 30_000);
    assert.equal(call.options.maxRedirects, 0);
  }

  const serializedMetrics = JSON.stringify(run.metrics);
  for (const forbidden of [
    AUTH_TOKEN,
    AUTHORIZATION,
    API_BASE_URL,
    PROJECT_ID,
    INSTALLED_PATH,
    TERMS_URL,
    'raw-runtime-detail',
  ]) {
    assert.equal(serializedMetrics.includes(forbidden), false, forbidden);
  }
});

test('readiness endpoints fail closed with fixed blockers', async (t) => {
  const cases: Array<{
    name: string;
    endpoint: 'selection' | 'requirements';
    route: () => APIResponse | Promise<APIResponse>;
    blocker: string;
  }> = [
    {
      name: 'provider request failure',
      endpoint: 'selection',
      route: () => Promise.reject(new Error(`do not leak ${AUTH_TOKEN}`)),
      blocker: 'provider_selection_request_failed',
    },
    {
      name: 'provider HTTP failure',
      endpoint: 'selection',
      route: () => apiResponse(503, { secret: AUTH_TOKEN }),
      blocker: 'provider_selection_http_error',
    },
    {
      name: 'provider JSON failure',
      endpoint: 'selection',
      route: () => apiResponse(200, null, true),
      blocker: 'provider_selection_json_invalid',
    },
    {
      name: 'provider malformed schema',
      endpoint: 'selection',
      route: () => apiResponse(200, { ...providerPayload(), terms_url: 7 }),
      blocker: 'provider_selection_schema_invalid',
    },
    {
      name: 'runtime request timeout',
      endpoint: 'requirements',
      route: () => Promise.reject(new Error('Timeout 30000ms exceeded')),
      blocker: 'runtime_requirements_timeout',
    },
    {
      name: 'runtime HTTP failure',
      endpoint: 'requirements',
      route: () => apiResponse(302, { location: `https://${AUTH_TOKEN}` }),
      blocker: 'runtime_requirements_http_error',
    },
    {
      name: 'runtime JSON failure',
      endpoint: 'requirements',
      route: () => apiResponse(200, null, true),
      blocker: 'runtime_requirements_json_invalid',
    },
    {
      name: 'runtime malformed schema',
      endpoint: 'requirements',
      route: () => {
        const payload = runtimePayload();
        delete (payload.items[0] as Record<string, unknown>).detail;
        return apiResponse(200, payload);
      },
      blocker: 'runtime_requirements_schema_invalid',
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const page = readyPage();
      const path =
        item.endpoint === 'selection'
          ? '/llm/provider-selection'
          : '/runtime/requirements';
      page.routes.set(`${API_BASE_URL}${path}`, item.route);
      const run = smokeRun();
      await capture(run, page);
      assert.equal(run.metrics.generation_readiness_at_start?.ready, false);
      assert.ok(
        run.metrics.generation_readiness_at_start?.blockers.includes(item.blocker),
      );
      assert.equal(page.responseListeners.size, 0);
      const serialized = JSON.stringify(run.metrics);
      assert.equal(serialized.includes(AUTH_TOKEN), false);
      assert.equal(serialized.includes('https://'), false);
    });
  }
});

test('auto provider readiness accepts an explicit Ollama fallback lane', async () => {
  const page = readyPage();
  page.routes.set(`${API_BASE_URL}/llm/provider-selection`, () =>
    apiResponse(200, {
      ...providerPayload(),
      selected_provider: 'ollama',
      effective_provider: 'ollama',
      effective_model: 'cert-prep-qwen3.5-4b-study-8k',
      selection_reason: 'No compatible XDNA2 hardware was detected.',
      fallback_reason: 'FastFlowLM hardware is incompatible.',
      hardware_compatible: false,
      requires_terms_acceptance: false,
      terms_accepted: false,
      terms_version: null,
      terms_url: null,
      runtime_requirement_kind: 'ollama',
      model_requirement_kind: 'ollama_model',
    }),
  );
  page.routes.set(`${API_BASE_URL}/runtime/requirements`, () =>
    apiResponse(200, {
      items: [
        {
          kind: 'ollama',
          label: 'Ollama',
          available: true,
          detail: 'Ollama is installed.',
          unavailable_reason: null,
          version: '0.12.0',
          bytes: null,
          installed_path: 'C:\\Program Files\\Ollama\\ollama.exe',
        },
        {
          kind: 'ollama_model',
          label: 'Ollama model',
          available: true,
          detail: 'Model is available.',
          unavailable_reason: null,
          version: 'cert-prep-qwen3.5-4b-study-8k',
          bytes: null,
          installed_path: null,
        },
      ],
    }),
  );
  const run = smokeRun();
  await capture(run, page);

  assert.equal(run.metrics.generation_readiness_at_start?.ready, true);
  assert.deepEqual(run.metrics.generation_readiness_at_start?.blockers, []);
  assert.equal(
    run.metrics.generation_readiness_at_start?.provider_selection
      ?.effective_provider,
    'ollama',
  );
  assert.equal(
    run.metrics.generation_readiness_at_start?.provider_selection
      ?.configured_model,
    'qwen3.5:4b',
  );
  assert.equal(
    run.metrics.generation_readiness_at_start?.provider_selection
      ?.effective_model,
    'cert-prep-qwen3.5-4b-study-8k',
  );
  assert.equal(
    run.metrics.generation_readiness_at_start?.provider_selection
      ?.fallback_reason,
    'provider_fallback_reported',
  );
});

test('provider model, FastFlow terms, and runtime availability drift fail closed', async (t) => {
  await t.test('model differs from CLI policy', async () => {
    const page = readyPage();
    page.routes.set(`${API_BASE_URL}/llm/provider-selection`, () =>
      apiResponse(200, {
        ...providerPayload(),
        configured_model: 'qwen3.5:2b',
        effective_model: 'qwen3.5:2b',
      }),
    );
    const payload = runtimePayload();
    payload.items[1].version = 'qwen3.5:2b';
    page.routes.set(`${API_BASE_URL}/runtime/requirements`, () =>
      apiResponse(200, payload),
    );
    const run = smokeRun();
    await capture(run, page);
    assert.ok(
      run.metrics.generation_readiness_at_start?.blockers.includes(
        'provider_model_mismatch',
      ),
    );
  });

  await t.test('FastFlow terms version differs from allowlist', async () => {
    const page = readyPage();
    page.routes.set(`${API_BASE_URL}/llm/provider-selection`, () =>
      apiResponse(200, { ...providerPayload(), terms_version: '0.9.42' }),
    );
    const run = smokeRun();
    await capture(run, page);
    assert.ok(
      run.metrics.generation_readiness_at_start?.blockers.includes(
        'fastflowlm_terms_unverified',
      ),
    );
  });

  await t.test('selected runtime is unavailable', async () => {
    const page = readyPage();
    const payload = runtimePayload();
    payload.items[0].available = false;
    page.routes.set(`${API_BASE_URL}/runtime/requirements`, () =>
      apiResponse(200, payload),
    );
    const run = smokeRun();
    await capture(run, page);
    assert.ok(
      run.metrics.generation_readiness_at_start?.blockers.includes(
        'selected_runtime_requirement_unavailable',
      ),
    );
  });
});

test('strict runtime schema, local path policy, and secret filtering block bad evidence', async (t) => {
  const mutations: Array<{
    name: string;
    mutate: (page: FakePage) => void;
    blocker: string;
  }> = [
    {
      name: 'duplicate runtime kind',
      mutate: (page) => {
        const payload = runtimePayload();
        payload.items[1] = { ...payload.items[0] };
        page.routes.set(`${API_BASE_URL}/runtime/requirements`, () =>
          apiResponse(200, payload),
        );
      },
      blocker: 'runtime_requirements_schema_invalid',
    },
    {
      name: 'unknown runtime kind',
      mutate: (page) => {
        const payload = runtimePayload();
        payload.items[0].kind = 'unknown';
        page.routes.set(`${API_BASE_URL}/runtime/requirements`, () =>
          apiResponse(200, payload),
        );
      },
      blocker: 'runtime_requirements_schema_invalid',
    },
    {
      name: 'nonboolean availability',
      mutate: (page) => {
        const payload = runtimePayload();
        payload.items[0].available = 'true';
        page.routes.set(`${API_BASE_URL}/runtime/requirements`, () =>
          apiResponse(200, payload),
        );
      },
      blocker: 'runtime_requirements_schema_invalid',
    },
    {
      name: 'missing selected model requirement',
      mutate: (page) => {
        const payload = runtimePayload();
        payload.items.pop();
        page.routes.set(`${API_BASE_URL}/runtime/requirements`, () =>
          apiResponse(200, payload),
        );
      },
      blocker: 'selected_model_requirement_missing',
    },
    {
      name: 'UNC installed path',
      mutate: (page) => {
        const payload = runtimePayload();
        payload.items[0].installed_path = '\\\\server\\share\\flm.exe';
        page.routes.set(`${API_BASE_URL}/runtime/requirements`, () =>
          apiResponse(200, payload),
        );
      },
      blocker: 'selected_runtime_path_unverified',
    },
    {
      name: 'auth token in provider reason',
      mutate: (page) => {
        page.routes.set(`${API_BASE_URL}/llm/provider-selection`, () =>
          apiResponse(200, {
            ...providerPayload(),
            selection_reason: AUTH_TOKEN,
          }),
        );
      },
      blocker: 'provider_selection_schema_invalid',
    },
  ];

  for (const item of mutations) {
    await t.test(item.name, async () => {
      const page = readyPage();
      item.mutate(page);
      let verifierCalls = 0;
      const run = smokeRun();
      await capture(run, page, () => {
        verifierCalls += 1;
        return true;
      });
      assert.ok(
        run.metrics.generation_readiness_at_start?.blockers.includes(item.blocker),
      );
      if (item.name === 'UNC installed path') {
        assert.equal(verifierCalls, 0);
      }
      assert.equal(JSON.stringify(run.metrics).includes(AUTH_TOKEN), false);
      assert.equal(JSON.stringify(run.metrics).includes('server'), false);
    });
  }
});

test('project listener is installed before action and cleaned on timeout or action failure', async () => {
  const timeoutPage = readyPage();
  const timeoutRun = smokeRun();
  await captureGenerationReadinessAtProjectCreate(timeoutRun, async () => {
    assert.equal(timeoutPage.responseListeners.size, 1);
  }, {
    page: timeoutPage as unknown as Page,
    projectResponseTimeoutMs: 1,
  });
  assert.deepEqual(
    timeoutRun.metrics.generation_readiness_at_start?.blockers,
    ['project_response_timeout'],
  );
  assert.equal(timeoutPage.responseListeners.size, 0);

  const actionPage = readyPage();
  const actionRun = smokeRun();
  await assert.rejects(
    captureGenerationReadinessAtProjectCreate(actionRun, async () => {
      assert.equal(actionPage.responseListeners.size, 1);
      throw new Error(`UI failure ${AUTH_TOKEN}`);
    }, { page: actionPage as unknown as Page }),
    /UI failure/,
  );
  assert.deepEqual(
    actionRun.metrics.generation_readiness_at_start?.blockers,
    ['project_create_action_failed'],
  );
  assert.equal(actionPage.responseListeners.size, 0);
  assert.equal(JSON.stringify(actionRun.metrics).includes(AUTH_TOKEN), false);
});

test('project capture ignores external origins and rejects malformed authorization', async () => {
  const externalPage = readyPage();
  const externalRun = smokeRun();
  await captureGenerationReadinessAtProjectCreate(
    externalRun,
    async () => {
      externalPage.emit(
        projectResponse({ url: 'http://example.test:8765/projects' }),
      );
      assert.equal(externalPage.responseListeners.size, 1);
      externalPage.emit(projectResponse());
    },
    {
      page: externalPage as unknown as Page,
      installedPathVerifier: () => true,
    },
  );
  assert.equal(externalRun.metrics.generation_readiness_at_start?.ready, true);

  const authPage = readyPage();
  const authRun = smokeRun();
  await captureGenerationReadinessAtProjectCreate(
    authRun,
    async () => authPage.emit(projectResponse({ authorization: 'Basic bad' })),
    { page: authPage as unknown as Page },
  );
  assert.deepEqual(
    authRun.metrics.generation_readiness_at_start?.blockers,
    ['project_response_schema_invalid'],
  );
  assert.equal(authPage.getCalls.length, 0);
  assert.equal(authPage.responseListeners.size, 0);
});

test('project and upload capture reject a different origin, auth, or project', async () => {
  const projectApi = {
    apiBaseUrl: API_BASE_URL,
    authorization: AUTHORIZATION,
    projectId: PROJECT_ID,
  };
  const matching = uploadResponse();
  assert.equal(isProjectDocumentsCollectionResponse(projectApi, matching), true);
  assert.equal(
    isProjectDocumentsCollectionResponse(
      projectApi,
      uploadResponse({ url: `http://127.0.0.1:8766/projects/${PROJECT_ID}/documents` }),
    ),
    false,
  );
  assert.equal(
    isProjectDocumentsCollectionResponse(
      projectApi,
      uploadResponse({ authorization: 'Bearer different-token' }),
    ),
    false,
  );
  assert.equal(
    isProjectDocumentsCollectionResponse(
      projectApi,
      uploadResponse({
        url: `${API_BASE_URL}/projects/00000000-0000-4000-8000-000000000009/documents`,
      }),
    ),
    false,
  );
  assert.equal(
    isProjectDocumentsCollectionResponse(
      projectApi,
      uploadResponse({
        url: `${API_BASE_URL}/projects/${PROJECT_ID}/documents?forward=https://example.test`,
      }),
    ),
    false,
  );

  const noContextRun = smokeRun();
  noContextRun.page = null;
  assert.equal(await waitForUploadDocumentResponse(noContextRun), null);
  assert.match(noContextRun.metrics.observations[0] ?? '', /context was unavailable/);
});

async function capture(
  run: SmokeRunState,
  page: FakePage,
  installedPathVerifier: (path: string) => boolean = () => true,
): Promise<void> {
  await captureGenerationReadinessAtProjectCreate(
    run,
    async () => page.emit(projectResponse()),
    {
      page: page as unknown as Page,
      installedPathVerifier,
    },
  );
}

function readyPage(): FakePage {
  const page = new FakePage();
  page.routes.set(`${API_BASE_URL}/llm/provider-selection`, () =>
    apiResponse(200, providerPayload()),
  );
  page.routes.set(`${API_BASE_URL}/runtime/requirements`, () =>
    apiResponse(200, runtimePayload()),
  );
  return page;
}

function providerPayload(): Record<string, unknown> {
  return {
    preference: 'auto',
    selected_provider: 'fastflowlm',
    effective_provider: 'fastflowlm',
    configured_model: 'qwen3.5:4b',
    effective_model: 'qwen3.5:4b',
    selection_reason: 'Compatible XDNA2 hardware selected FastFlowLM.',
    fallback_reason: null,
    hardware_compatible: true,
    requires_terms_acceptance: true,
    terms_accepted: true,
    terms_version: '0.9.43',
    terms_url: TERMS_URL,
    runtime_requirement_kind: 'fastflowlm',
    model_requirement_kind: 'fastflowlm_model',
  };
}

function runtimePayload(): { items: Array<Record<string, unknown>> } {
  return {
    items: [
      {
        kind: 'fastflowlm',
        label: 'FastFlowLM',
        available: true,
        detail: 'raw-runtime-detail',
        unavailable_reason: null,
        version: '0.9.43',
        bytes: 18_577_840,
        installed_path: INSTALLED_PATH,
      },
      {
        kind: 'fastflowlm_model',
        label: 'FastFlowLM model',
        available: true,
        detail: 'Model is available.',
        unavailable_reason: null,
        version: 'qwen3.5:4b',
        bytes: null,
        installed_path: null,
      },
    ],
  };
}

function apiResponse(
  status: number,
  payload: unknown,
  rejectJson = false,
): APIResponse {
  return {
    status: () => status,
    json: () =>
      rejectJson
        ? Promise.reject(new Error(`raw JSON ${AUTH_TOKEN}`))
        : Promise.resolve(payload),
  } as unknown as APIResponse;
}

function projectResponse(overrides: {
  url?: string;
  authorization?: string;
  status?: number;
  payload?: unknown;
} = {}): Response {
  return response({
    url: overrides.url ?? `${API_BASE_URL}/projects`,
    authorization: overrides.authorization ?? AUTHORIZATION,
    status: overrides.status ?? 201,
    payload: overrides.payload ?? { id: PROJECT_ID },
    method: 'POST',
  });
}

function uploadResponse(overrides: {
  url?: string;
  authorization?: string;
} = {}): Response {
  return response({
    url:
      overrides.url ?? `${API_BASE_URL}/projects/${PROJECT_ID}/documents`,
    authorization: overrides.authorization ?? AUTHORIZATION,
    status: 201,
    payload: { id: DOCUMENT_ID, project_id: PROJECT_ID },
    method: 'POST',
  });
}

function response(options: {
  url: string;
  authorization: string;
  status: number;
  payload: unknown;
  method: string;
}): Response {
  return {
    url: () => options.url,
    status: () => options.status,
    json: () => Promise.resolve(options.payload),
    request: () => ({
      method: () => options.method,
      headers: () => ({ authorization: options.authorization }),
    }),
  } as unknown as Response;
}

function smokeRun(): SmokeRunState {
  return {
    options: { llmProvider: 'auto', ollamaModel: 'qwen3.5:4b' },
    metrics: {
      observations: [],
      generation_readiness_at_start: undefined,
    },
    page: null,
    projectApi: null,
  } as unknown as SmokeRunState;
}
