import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  CERT_PREP_API,
  CertPrepRuntimeConfig,
  type CertPrepGeneratedClient,
  type HealthResponse,
} from './cert-prep-api';

describe('CertPrepRuntimeConfig', () => {
  beforeEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('does not provide a static bearer token for browser fallback', async () => {
    const config = await TestBed.inject(
      CertPrepRuntimeConfig,
    ).getBackendConfig();

    expect(config).toEqual({
      base_url: 'http://127.0.0.1:8765',
      token: '',
    });
  });

  it('uses explicit local developer connection settings when provided', async () => {
    localStorage.setItem('certPrepApiBaseUrl', 'http://127.0.0.1:9001/');
    localStorage.setItem('certPrepApiToken', 'developer-token');

    const config = await TestBed.inject(
      CertPrepRuntimeConfig,
    ).getBackendConfig();

    expect(config).toEqual({
      base_url: 'http://127.0.0.1:9001/',
      token: 'developer-token',
    });
  });

  it('does not silently fall back when desktop config is present but unavailable', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    await expect(
      TestBed.inject(CertPrepRuntimeConfig).getBackendConfig(),
    ).rejects.toThrow('Desktop backend configuration is unavailable.');
  });

  it('retries desktop config after a transient failure and caches the recovery', async () => {
    localStorage.setItem('certPrepApiBaseUrl', 'http://127.0.0.1:9999/');
    const recoveredConfig = {
      base_url: 'http://127.0.0.1:9001/',
      token: 'runtime-token',
    };
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('Backend is still starting.'))
      .mockResolvedValueOnce(recoveredConfig);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    });
    const runtimeConfig = TestBed.inject(CertPrepRuntimeConfig);

    const firstLookup = runtimeConfig.getBackendConfig();
    const concurrentLookup = runtimeConfig.getBackendConfig();
    expect(concurrentLookup).toBe(firstLookup);
    await expect(firstLookup).rejects.toThrow(
      'Desktop backend configuration is unavailable.',
    );
    await expect(concurrentLookup).rejects.toThrow(
      'Desktop backend configuration is unavailable.',
    );
    const recoveryLookup = runtimeConfig.getBackendConfig();
    const concurrentRecoveryLookup = runtimeConfig.getBackendConfig();
    expect(concurrentRecoveryLookup).toBe(recoveryLookup);
    await expect(recoveryLookup).resolves.toEqual(recoveredConfig);
    const cachedLookup = runtimeConfig.getBackendConfig();
    expect(cachedLookup).toBe(recoveryLookup);
    await expect(cachedLookup).resolves.toEqual(recoveredConfig);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, 'backend_config', {}, undefined);
    expect(invoke).toHaveBeenNthCalledWith(2, 'backend_config', {}, undefined);
  });
});

describe('CertPrepAuthenticatedTransport', () => {
  const baseUrl = 'http://127.0.0.1:9001';
  const backendConfig = {
    base_url: `${baseUrl}/`,
    token: 'runtime-token',
  };
  const healthResponse: HealthResponse = {
    status: 'ok',
    app: 'cert-prep',
    version: 'test',
    python_version: '3.12',
    runtime_mode: 'test',
  };
  let api: CertPrepGeneratedClient;
  let httpTesting: HttpTestingController;
  let backendConfigPromise: Promise<typeof backendConfig>;
  let backendConfigCalls: number;

  beforeEach(() => {
    backendConfigPromise = Promise.resolve(backendConfig);
    backendConfigCalls = 0;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: CertPrepRuntimeConfig,
          useValue: {
            getBackendConfig: () => {
              backendConfigCalls += 1;
              return backendConfigPromise;
            },
          },
        },
      ],
    });

    api = TestBed.inject(CERT_PREP_API);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTesting.verify({ ignoreCancelled: true });
  });

  function trackAbortListener(signal: AbortSignal) {
    const added = vi.spyOn(signal, 'addEventListener');
    const removed = vi.spyOn(signal, 'removeEventListener');

    return {
      added,
      expectRemoved(): void {
        const abortHandler = added.mock.calls.find(
          ([eventName]) => eventName === 'abort',
        )?.[1];
        expect(abortHandler).toEqual(expect.any(Function));
        expect(removed).toHaveBeenCalledWith('abort', abortHandler);
      },
    };
  }

  it('preserves caller headers but overrides Authorization case-insensitively', async () => {
    const callerHeaders = {
      Authorization: 'Bearer first-caller-token',
      authorization: 'Bearer caller-token',
      AUTHORIZATION: 'Bearer second-caller-token',
      'X-Cert-Prep-Operation-Id': 'operation-1',
      'X-Caller-Header': 'preserved',
    };
    const originalHeaders = { ...callerHeaders };
    const responsePromise = api.health({
      headers: callerHeaders,
    });
    await Promise.resolve();

    const request = httpTesting.expectOne(`${baseUrl}/health`);
    expect(request.request.headers.getAll('Authorization')).toEqual([
      'Bearer runtime-token',
    ]);
    expect(request.request.headers.get('X-Cert-Prep-Operation-Id')).toBe(
      'operation-1',
    );
    expect(request.request.headers.get('X-Caller-Header')).toBe('preserved');
    expect(callerHeaders).toEqual(originalHeaders);

    request.flush(healthResponse);
    await expect(responsePromise).resolves.toEqual(healthResponse);
  });

  it('does not send a request for an already-aborted signal', async () => {
    const controller = new AbortController();
    const abortReason = new DOMException('Already canceled.', 'AbortError');
    controller.abort(abortReason);

    await expect(api.health({ signal: controller.signal })).rejects.toBe(
      abortReason,
    );
    expect(backendConfigCalls).toBe(0);
    httpTesting.expectNone(`${baseUrl}/health`);
  });

  it('aborts during config lookup without a late request or canceling the shared config', async () => {
    let resolveConfig: (config: typeof backendConfig) => void = () => undefined;
    backendConfigPromise = new Promise((resolve) => {
      resolveConfig = resolve;
    });
    const controller = new AbortController();
    const listeners = trackAbortListener(controller.signal);
    const abortReason = new DOMException('Canceled during config.', 'AbortError');
    const abortedResponse = api.health({ signal: controller.signal });
    expect(backendConfigCalls).toBe(1);
    expect(listeners.added).toHaveBeenCalledWith(
      'abort',
      expect.any(Function),
      { once: true },
    );
    const rejection = expect(abortedResponse).rejects.toBe(abortReason);

    controller.abort(abortReason);

    await rejection;
    listeners.expectRemoved();
    httpTesting.expectNone(`${baseUrl}/health`);

    const siblingResponse = api.health();
    expect(backendConfigCalls).toBe(2);
    resolveConfig(backendConfig);
    await Promise.resolve();
    await Promise.resolve();

    const requests = httpTesting.match(`${baseUrl}/health`);
    expect(requests).toHaveLength(1);
    requests[0].flush(healthResponse);
    await expect(siblingResponse).resolves.toEqual(healthResponse);
  });

  it('cancels an in-flight HttpClient request and rejects with the abort reason', async () => {
    const controller = new AbortController();
    const listeners = trackAbortListener(controller.signal);
    const abortReason = new DOMException('Canceled by the user.', 'AbortError');
    const responsePromise = api.health({ signal: controller.signal });
    await Promise.resolve();
    const request = httpTesting.expectOne(`${baseUrl}/health`);
    const rejection = expect(responsePromise).rejects.toBe(abortReason);

    controller.abort(abortReason);

    await rejection;
    expect(request.cancelled).toBe(true);
    listeners.expectRemoved();
  });

  it('returns a normal response when no signal is provided', async () => {
    const responsePromise = api.health();
    await Promise.resolve();
    const request = httpTesting.expectOne({
      method: 'GET',
      url: `${baseUrl}/health`,
    });

    request.flush(healthResponse);

    await expect(responsePromise).resolves.toEqual(healthResponse);
  });

  it('does not set Content-Type for a FormData upload', async () => {
    const body = new FormData();
    body.append('file', new Blob(['pdf']), 'exam.pdf');
    const responsePromise = api.uploadDocument('project-1', body, {
      headers: { 'X-Cert-Prep-Operation-Id': 'operation-1' },
    });
    await Promise.resolve();
    const request = httpTesting.expectOne(
      `${baseUrl}/projects/project-1/documents`,
    );

    expect(request.request.body).toBe(body);
    expect(request.request.headers.has('Content-Type')).toBe(false);
    request.flush(null);
    await responsePromise;
  });

  it('removes the abort listener after a successful response', async () => {
    const controller = new AbortController();
    const listeners = trackAbortListener(controller.signal);
    const responsePromise = api.health({ signal: controller.signal });
    await Promise.resolve();
    const request = httpTesting.expectOne(`${baseUrl}/health`);

    request.flush(healthResponse);

    await expect(responsePromise).resolves.toEqual(healthResponse);
    listeners.expectRemoved();
  });

  it('preserves an HTTP error and removes the abort listener', async () => {
    const controller = new AbortController();
    const listeners = trackAbortListener(controller.signal);
    const responsePromise = api.health({ signal: controller.signal });
    await Promise.resolve();
    const request = httpTesting.expectOne(`${baseUrl}/health`);

    request.flush({ detail: 'failed' }, { status: 500, statusText: 'Failed' });

    const error = await responsePromise.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HttpErrorResponse);
    expect(error).toMatchObject({ status: 500, error: { detail: 'failed' } });
    listeners.expectRemoved();
  });

  it('preserves a config error and removes the abort listener', async () => {
    const configError = new Error('Config failed.');
    backendConfigPromise = Promise.reject(configError);
    const controller = new AbortController();
    const listeners = trackAbortListener(controller.signal);

    await expect(api.health({ signal: controller.signal })).rejects.toBe(
      configError,
    );

    httpTesting.expectNone(`${baseUrl}/health`);
    listeners.expectRemoved();
  });

  it('preserves an HTTP error when no signal is provided', async () => {
    const responsePromise = api.health();
    await Promise.resolve();
    const request = httpTesting.expectOne(`${baseUrl}/health`);

    request.flush({ detail: 'failed' }, { status: 503, statusText: 'Failed' });

    await expect(responsePromise).rejects.toMatchObject({ status: 503 });
  });
});
