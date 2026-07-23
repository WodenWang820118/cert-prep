import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  Observable,
  of,
  Subject,
  throwError,
} from 'rxjs';
import { CERT_PREP_API } from './constants/cert-prep-api.constants';
import { CertPrepRuntimeConfig } from './cert-prep-api';
import type { CertPrepGeneratedClient, HealthResponse } from './contracts/api.contracts';
import { CertPrepTauriBridgeService } from './cert-prep-tauri-bridge.service';

describe('CertPrepRuntimeConfig', () => {
  const tauriBridge = {
    isDesktop: vi.fn(),
    invoke: vi.fn(),
  };

  beforeEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    vi.clearAllMocks();
    tauriBridge.isDesktop.mockReturnValue(false);
    TestBed.configureTestingModule({
      providers: [
        { provide: CertPrepTauriBridgeService, useValue: tauriBridge },
      ],
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('does not provide a static bearer token for browser fallback', () => {
    let config: unknown;
    TestBed.inject(CertPrepRuntimeConfig)
      .getBackendConfig()
      .subscribe((value) => (config = value));

    expect(config).toEqual({
      base_url: 'http://127.0.0.1:8765',
      token: '',
    });
  });

  it('uses explicit local developer connection settings when provided', () => {
    localStorage.setItem('certPrepApiBaseUrl', 'http://127.0.0.1:9001/');
    localStorage.setItem('certPrepApiToken', 'developer-token');

    let config: unknown;
    TestBed.inject(CertPrepRuntimeConfig)
      .getBackendConfig()
      .subscribe((value) => (config = value));

    expect(config).toEqual({
      base_url: 'http://127.0.0.1:9001/',
      token: 'developer-token',
    });
  });

  it('does not silently fall back when desktop config is present but unavailable', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    tauriBridge.isDesktop.mockReturnValue(true);
    tauriBridge.invoke.mockReturnValue(
      throwError(() => new Error('Backend is still starting.')),
    );

    let error: unknown;
    TestBed.inject(CertPrepRuntimeConfig)
      .getBackendConfig()
      .subscribe({ error: (reason) => (error = reason) });
    expect(error).toEqual(
      expect.objectContaining({
        message: 'Desktop backend configuration is unavailable.',
      }),
    );
  });

  it('retries desktop config after a transient failure and caches the recovery', () => {
    localStorage.setItem('certPrepApiBaseUrl', 'http://127.0.0.1:9999/');
    const recoveredConfig = {
      base_url: 'http://127.0.0.1:9001/',
      token: 'runtime-token',
    };
    const invoke = tauriBridge.invoke
      .mockReturnValueOnce(throwError(() => new Error('Backend is still starting.')))
      .mockReturnValueOnce(of(recoveredConfig));
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    });
    tauriBridge.isDesktop.mockReturnValue(true);
    const runtimeConfig = TestBed.inject(CertPrepRuntimeConfig);

    const firstErrors: unknown[] = [];
    const concurrentErrors: unknown[] = [];
    const firstLookup = runtimeConfig.getBackendConfig();
    const concurrentLookup = runtimeConfig.getBackendConfig();
    expect(concurrentLookup).toBe(firstLookup);
    firstLookup.subscribe({ error: (error) => firstErrors.push(error) });
    concurrentLookup.subscribe({ error: (error) => concurrentErrors.push(error) });
    expect(firstErrors[0]).toEqual(
      expect.objectContaining({
        message: 'Desktop backend configuration is unavailable.',
      }),
    );
    expect(concurrentErrors[0]).toEqual(
      expect.objectContaining({
        message: 'Desktop backend configuration is unavailable.',
      }),
    );

    let recovery: unknown;
    const recoveryLookup = runtimeConfig.getBackendConfig();
    const concurrentRecoveryLookup = runtimeConfig.getBackendConfig();
    expect(concurrentRecoveryLookup).toBe(recoveryLookup);
    recoveryLookup.subscribe((value) => (recovery = value));
    concurrentRecoveryLookup.subscribe();
    expect(recovery).toEqual(recoveredConfig);

    let cached: unknown;
    const cachedLookup = runtimeConfig.getBackendConfig();
    expect(cachedLookup).toBe(recoveryLookup);
    cachedLookup.subscribe((value) => (cached = value));
    expect(cached).toEqual(recoveredConfig);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, 'backend_config');
    expect(invoke).toHaveBeenNthCalledWith(2, 'backend_config');
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
  let backendConfig$: Observable<typeof backendConfig>;
  let backendConfigCalls: number;

  beforeEach(() => {
    backendConfig$ = of(backendConfig);
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
              return backendConfig$;
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

  it('preserves caller headers but overrides Authorization case-insensitively', () => {
    const callerHeaders = {
      Authorization: 'Bearer first-caller-token',
      authorization: 'Bearer caller-token',
      AUTHORIZATION: 'Bearer second-caller-token',
      'X-Cert-Prep-Operation-Id': 'operation-1',
      'X-Caller-Header': 'preserved',
    };
    const originalHeaders = { ...callerHeaders };
    let response: HealthResponse | undefined;
    const subscription = api
      .health({ headers: callerHeaders })
      .subscribe((value) => (response = value));

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
    expect(response).toEqual(healthResponse);
    subscription.unsubscribe();
  });

  it('does not send a request for an already-aborted signal', () => {
    const controller = new AbortController();
    const abortReason = new DOMException('Already canceled.', 'AbortError');
    controller.abort(abortReason);
    let error: unknown;

    api.health({ signal: controller.signal }).subscribe({
      error: (reason) => (error = reason),
    });

    expect(error).toBe(abortReason);
    expect(backendConfigCalls).toBe(0);
    httpTesting.expectNone(`${baseUrl}/health`);
  });

  it('aborts during config lookup without a late request or canceling the shared config', () => {
    const pendingConfig = new Subject<typeof backendConfig>();
    backendConfig$ = pendingConfig.asObservable();
    const controller = new AbortController();
    const listeners = trackAbortListener(controller.signal);
    const abortReason = new DOMException('Canceled during config.', 'AbortError');
    let abortedError: unknown;
    api.health({ signal: controller.signal }).subscribe({
      error: (reason) => (abortedError = reason),
    });
    expect(backendConfigCalls).toBe(1);
    expect(listeners.added).toHaveBeenCalledWith(
      'abort',
      expect.any(Function),
      { once: true },
    );

    controller.abort(abortReason);

    expect(abortedError).toBe(abortReason);
    listeners.expectRemoved();
    httpTesting.expectNone(`${baseUrl}/health`);

    let siblingResponse: HealthResponse | undefined;
    api.health().subscribe((value) => (siblingResponse = value));
    expect(backendConfigCalls).toBe(2);
    pendingConfig.next(backendConfig);
    const requests = httpTesting.match(`${baseUrl}/health`);
    expect(requests).toHaveLength(1);
    requests[0].flush(healthResponse);
    expect(siblingResponse).toEqual(healthResponse);
  });

  it('cancels an in-flight HttpClient request and rejects with the abort reason', () => {
    const controller = new AbortController();
    const listeners = trackAbortListener(controller.signal);
    const abortReason = new DOMException('Canceled by the user.', 'AbortError');
    let error: unknown;
    api.health({ signal: controller.signal }).subscribe({
      error: (reason) => (error = reason),
    });
    const request = httpTesting.expectOne(`${baseUrl}/health`);

    controller.abort(abortReason);

    expect(error).toBe(abortReason);
    expect(request.cancelled).toBe(true);
    listeners.expectRemoved();
  });

  it('returns a normal response when no signal is provided', () => {
    let response: HealthResponse | undefined;
    api.health().subscribe((value) => (response = value));
    const request = httpTesting.expectOne({
      method: 'GET',
      url: `${baseUrl}/health`,
    });

    request.flush(healthResponse);

    expect(response).toEqual(healthResponse);
  });

  it('loads authenticated document audio as a Blob without putting the token in the URL', () => {
    const sourceBlob = new Blob(['audio'], { type: 'audio/mpeg' });
    let response: Blob | undefined;
    api.getDocumentAudioSource('project-1', 'document-1').subscribe(
      (value) => (response = value),
    );
    const request = httpTesting.expectOne(
      `${baseUrl}/projects/project-1/documents/document-1/source`,
    );

    expect(request.request.method).toBe('GET');
    expect(request.request.responseType).toBe('blob');
    expect(request.request.headers.get('Authorization')).toBe(
      'Bearer runtime-token',
    );
    expect(request.request.url).not.toContain('runtime-token');
    request.flush(sourceBlob);

    expect(response).toEqual(sourceBlob);
  });

  it('does not set Content-Type for a FormData upload', () => {
    const body = new FormData();
    body.append('file', new Blob(['pdf']), 'exam.pdf');
    let response: unknown;
    api
      .uploadDocument('project-1', body, {
        headers: { 'X-Cert-Prep-Operation-Id': 'operation-1' },
      })
      .subscribe((value) => (response = value));
    const request = httpTesting.expectOne(
      `${baseUrl}/projects/project-1/documents`,
    );

    expect(request.request.body).toBe(body);
    expect(request.request.headers.has('Content-Type')).toBe(false);
    request.flush(null);
    expect(response).toBeNull();
  });

  it('removes the abort listener after a successful response', () => {
    const controller = new AbortController();
    const listeners = trackAbortListener(controller.signal);
    let response: HealthResponse | undefined;
    api.health({ signal: controller.signal }).subscribe(
      (value) => (response = value),
    );
    const request = httpTesting.expectOne(`${baseUrl}/health`);

    request.flush(healthResponse);

    expect(response).toEqual(healthResponse);
    listeners.expectRemoved();
  });

  it('preserves an HTTP error and removes the abort listener', () => {
    const controller = new AbortController();
    const listeners = trackAbortListener(controller.signal);
    let error: unknown;
    api.health({ signal: controller.signal }).subscribe({
      error: (reason) => (error = reason),
    });
    const request = httpTesting.expectOne(`${baseUrl}/health`);

    request.flush({ detail: 'failed' }, { status: 500, statusText: 'Failed' });

    expect(error).toBeInstanceOf(HttpErrorResponse);
    expect(error).toMatchObject({ status: 500, error: { detail: 'failed' } });
    listeners.expectRemoved();
  });

  it('preserves a config error and removes the abort listener', () => {
    const configError = new Error('Config failed.');
    backendConfig$ = throwError(() => configError);
    const controller = new AbortController();
    const listeners = trackAbortListener(controller.signal);
    let error: unknown;

    api.health({ signal: controller.signal }).subscribe({
      error: (reason) => (error = reason),
    });

    expect(error).toBe(configError);
    httpTesting.expectNone(`${baseUrl}/health`);
    listeners.expectRemoved();
  });

  it('preserves an HTTP error when no signal is provided', () => {
    let error: unknown;
    api.health().subscribe({ error: (reason) => (error = reason) });
    const request = httpTesting.expectOne(`${baseUrl}/health`);

    request.flush({ detail: 'failed' }, { status: 503, statusText: 'Failed' });

    expect(error).toMatchObject({ status: 503 });
  });
});
