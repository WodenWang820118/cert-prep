import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import { CertPrepSseClient } from '../../services/cert-prep-sse-client.service';
import { HealthStore } from './health.store';
import type { RuntimeActionContext } from './contracts/health-runtime.contracts';
import { RuntimeActionsStore } from './runtime-actions.store';
import { OperationStore } from '../operation.store';
import {
  llmHealth,
  modelDownload,
  providerSelection,
} from './health.store.spec-helpers';
import { provideCertPrepHttpResourceClientFake } from '../../testing/cert-prep-http-resource-client.fake';

describe('HealthStore model downloads', () => {
  const apiClient = {
    health: vi.fn(),
    llmHealth: vi.fn(),
    llmProviderSelection: vi.fn(),
    runtimeRequirements: vi.fn(),
    startModelDownload: vi.fn(),
    getModelDownload: vi.fn(),
    cancelModelDownload: vi.fn(),
    startRuntimeInstallation: vi.fn(),
    getRuntimeInstallation: vi.fn(),
  };
  let modelStream: Subject<ReturnType<typeof modelDownload>>;
  const sseClient = { streamJson: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    modelStream = new Subject();
    sseClient.streamJson.mockReturnValue(modelStream.asObservable());
    apiClient.health.mockReturnValue(of({
      status: 'ok',
      app: 'cert-prep-backend',
      version: '0.1.0',
      python_version: '3.13.5',
      runtime_mode: 'source',
    }));
    apiClient.llmHealth.mockReturnValue(of(llmHealth({ available: false })));
    apiClient.llmProviderSelection.mockReturnValue(of(
      providerSelection({
        selected_provider: 'ollama',
        effective_provider: 'ollama',
        selection_reason: 'Auto-selected Ollama for this device.',
        runtime_requirement_kind: 'ollama',
        model_requirement_kind: 'ollama_model',
      }),
    ));
    apiClient.runtimeRequirements.mockReturnValue(of({ items: [] }));
    TestBed.configureTestingModule({
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        { provide: CertPrepSseClient, useValue: sseClient },
        provideCertPrepHttpResourceClientFake(apiClient),
      ],
    });
  });

  it('does not start a model download when consent is cancelled', () => {
    const store = TestBed.inject(HealthStore);
    store.load();
    TestBed.tick();

    store.openModelDownloadConsent();
    store.cancelModelDownloadConsent();

    expect(store.modelDownloadConsentVisible()).toBe(false);
    expect(apiClient.startModelDownload).not.toHaveBeenCalled();
  });

  it('starts and streams a model download only after confirmation', () => {
    const store = TestBed.inject(HealthStore);
    apiClient.startModelDownload.mockReturnValue(of(
      modelDownload({
        status: 'running',
        detail: 'downloading',
        completed: 25,
      }),
    ));
    store.load();
    TestBed.tick();

    store.openModelDownloadConsent();
    store.confirmModelDownload();
    TestBed.tick();

    expect(apiClient.startModelDownload).toHaveBeenCalledTimes(1);
    expect(store.modelDownloadConsentVisible()).toBe(false);
    expect(store.modelDownload()?.phase).toBe('running');
    expect(store.modelDownload()?.progress).toBe(25);

    modelStream.next(modelDownload({
      status: 'succeeded',
      detail: 'model download complete',
      completed: 100,
      phase: 'succeeded',
      cancellable: false,
    }));
    TestBed.tick();

    expect(store.modelDownload()?.phase).toBe('succeeded');
    expect(store.modelDownload()?.progress).toBe(100);
  });

  it('preserves the durable model state when its progress stream errors and refresh reconnects it', () => {
    const actions = TestBed.inject(RuntimeActionsStore);
    const operations = TestBed.inject(OperationStore);
    const context = runtimeActionContext();
    apiClient.startModelDownload.mockReturnValue(of(
      modelDownload({ status: 'running', phase: 'running', detail: 'downloading' }),
    ));

    actions.confirmModelDownload(context);
    TestBed.tick();
    const durableState = actions.modelDownload();

    modelStream.error(new Error('SSE disconnected'));
    TestBed.tick();

    expect(actions.modelDownload()).toBe(durableState);
    expect(actions.modelDownload()?.status).toBe('running');
    expect(actions.modelDownload()?.phase).toBe('running');
    expect(actions.modelDownloadStreamError()).toBe(
      'Model download progress stream disconnected. Retry refresh to reconnect.',
    );
    expect(operations.error()).toBeNull();

    const retryStream = new Subject<ReturnType<typeof modelDownload>>();
    apiClient.getModelDownload.mockReturnValue(of(
      modelDownload({ status: 'running', phase: 'running', detail: 'still downloading' }),
    ));
    sseClient.streamJson.mockReturnValueOnce(retryStream.asObservable());
    actions.refreshModelDownload(context);
    TestBed.tick();

    expect(actions.modelDownloadStreamError()).toBeNull();
    expect(sseClient.streamJson).toHaveBeenCalledTimes(2);
  });

  it('preserves the durable runtime state when its progress stream errors and refresh reconnects it', () => {
    const actions = TestBed.inject(RuntimeActionsStore);
    const operations = TestBed.inject(OperationStore);
    const context = runtimeActionContext();
    const runtimeStream = new Subject<Record<string, unknown>>();
    const retryStream = new Subject<Record<string, unknown>>();
    sseClient.streamJson.mockReturnValue(runtimeStream.asObservable());
    apiClient.startRuntimeInstallation.mockReturnValue(of(runtimeInstallation()));

    actions.openRuntimeInstallConsent('ollama', true);
    actions.confirmRuntimeInstallation(context);
    TestBed.tick();
    const durableState = actions.runtimeInstall();

    runtimeStream.error(new Error('SSE disconnected'));
    TestBed.tick();

    expect(actions.runtimeInstall()).toBe(durableState);
    expect(actions.runtimeInstall()?.status).toBe('running');
    expect(actions.runtimeInstall()?.phase).toBe('running');
    expect(actions.runtimeInstallStreamError()).toBe(
      'Runtime installation progress stream disconnected. Retry refresh to reconnect.',
    );
    expect(operations.error()).toBeNull();

    apiClient.getRuntimeInstallation.mockReturnValue(of(runtimeInstallation()));
    sseClient.streamJson.mockReturnValueOnce(retryStream.asObservable());
    actions.refreshRuntimeInstallation(context);
    TestBed.tick();

    expect(actions.runtimeInstallStreamError()).toBeNull();
    expect(sseClient.streamJson).toHaveBeenCalledTimes(2);
  });

  it('preserves the durable model state when refresh GET errors and refresh can recover', () => {
    const actions = TestBed.inject(RuntimeActionsStore);
    const operations = TestBed.inject(OperationStore);
    const context = runtimeActionContext();
    apiClient.startModelDownload.mockReturnValue(of(
      modelDownload({ status: 'running', phase: 'running', detail: 'downloading' }),
    ));

    actions.confirmModelDownload(context);
    TestBed.tick();
    const durableState = actions.modelDownload();
    apiClient.getModelDownload.mockReturnValue(
      throwError(() => new Error('GET disconnected')),
    );

    actions.refreshModelDownload(context);
    TestBed.tick();

    expect(actions.modelDownload()).toBe(durableState);
    expect(actions.modelDownload()?.status).toBe('running');
    expect(actions.modelDownload()?.phase).toBe('running');
    expect(actions.modelDownloadStreamError()).toBe(
      'Model download status could not be refreshed. Retry refresh to reconnect.',
    );
    expect(operations.error()).toBeNull();

    const retryStream = new Subject<ReturnType<typeof modelDownload>>();
    apiClient.getModelDownload.mockReturnValue(of(
      modelDownload({ status: 'running', phase: 'running' }),
    ));
    sseClient.streamJson.mockReturnValueOnce(retryStream.asObservable());
    actions.refreshModelDownload(context);
    TestBed.tick();

    expect(actions.modelDownloadStreamError()).toBeNull();
    expect(sseClient.streamJson).toHaveBeenCalledTimes(2);
  });

  it('preserves the durable runtime state when refresh GET errors and refresh can recover', () => {
    const actions = TestBed.inject(RuntimeActionsStore);
    const operations = TestBed.inject(OperationStore);
    const context = runtimeActionContext();
    const runtimeStream = new Subject<Record<string, unknown>>();
    const retryStream = new Subject<Record<string, unknown>>();
    sseClient.streamJson.mockReturnValue(runtimeStream.asObservable());
    apiClient.startRuntimeInstallation.mockReturnValue(of(runtimeInstallation()));

    actions.openRuntimeInstallConsent('ollama', true);
    actions.confirmRuntimeInstallation(context);
    TestBed.tick();
    const durableState = actions.runtimeInstall();
    apiClient.getRuntimeInstallation.mockReturnValue(
      throwError(() => new Error('GET disconnected')),
    );

    actions.refreshRuntimeInstallation(context);
    TestBed.tick();

    expect(actions.runtimeInstall()).toBe(durableState);
    expect(actions.runtimeInstall()?.status).toBe('running');
    expect(actions.runtimeInstall()?.phase).toBe('running');
    expect(actions.runtimeInstallStreamError()).toBe(
      'Runtime installation status could not be refreshed. Retry refresh to reconnect.',
    );
    expect(operations.error()).toBeNull();

    apiClient.getRuntimeInstallation.mockReturnValue(of(runtimeInstallation()));
    sseClient.streamJson.mockReturnValueOnce(retryStream.asObservable());
    actions.refreshRuntimeInstallation(context);
    TestBed.tick();

    expect(actions.runtimeInstallStreamError()).toBeNull();
    expect(sseClient.streamJson).toHaveBeenCalledTimes(2);
  });

  it('exposes runtime transport errors through the HealthStore façade', () => {
    const health = TestBed.inject(HealthStore);
    const actions = TestBed.inject(RuntimeActionsStore);

    expect(health.modelDownloadStreamError).toBe(actions.modelDownloadStreamError);
    expect(health.runtimeInstallStreamError).toBe(actions.runtimeInstallStreamError);

    actions.modelDownloadStreamError.set('model stream disconnected');
    actions.runtimeInstallStreamError.set('runtime stream disconnected');

    expect(health.modelDownloadStreamError()).toBe('model stream disconnected');
    expect(health.runtimeInstallStreamError()).toBe('runtime stream disconnected');
  });

  it('does not offer download for an available model', () => {
    const store = TestBed.inject(HealthStore);
    apiClient.llmHealth.mockReturnValue(of(llmHealth({ available: true })));

    store.load();
    TestBed.tick();
    store.openModelDownloadConsent();
    store.confirmModelDownload();
    TestBed.tick();

    expect(store.modelDownloadConsentVisible()).toBe(false);
    expect(apiClient.startModelDownload).not.toHaveBeenCalled();
  });

  it('starts the selected provider model pull without provider-specific payload', () => {
    const store = TestBed.inject(HealthStore);
    apiClient.llmHealth.mockReturnValue(of(
      llmHealth({
        model: 'qwen3.5:4b',
        available: false,
        detail: 'Ollama model is missing.',
        unavailable_reason: 'model_missing',
        configured_model: 'qwen3.5:4b',
        effective_model: null,
      }),
    ));
    apiClient.runtimeRequirements.mockReturnValue(of({
      items: [
        {
          kind: 'ollama',
          label: 'Ollama',
          available: true,
          detail: 'Ollama is ready.',
          unavailable_reason: null,
        },
        {
          kind: 'ollama_model',
          label: 'Ollama model',
          available: false,
          detail: 'qwen3.5:4b is missing.',
          unavailable_reason: 'model_missing',
        },
      ],
    }));
    apiClient.startModelDownload.mockReturnValue(of(
      modelDownload({
        model: 'qwen3.5:4b',
        status: 'running',
      }),
    ));
    store.load();
    TestBed.tick();

    store.openModelDownloadConsent();
    store.confirmModelDownload();
    TestBed.tick();

    expect(apiClient.startModelDownload).toHaveBeenCalledWith();
    expect(store.modelDownload()?.model).toBe('qwen3.5:4b');
  });

  it('cancels an active model download through the generated API', () => {
    const store = TestBed.inject(HealthStore);
    apiClient.startModelDownload.mockReturnValue(of(
      modelDownload({ status: 'running', phase: 'downloading' }),
    ));
    apiClient.cancelModelDownload.mockReturnValue(of(
      modelDownload({
        status: 'canceled',
        phase: 'canceled',
        cancellable: false,
      }),
    ));
    store.load();
    TestBed.tick();
    store.openModelDownloadConsent();
    store.confirmModelDownload();
    TestBed.tick();

    store.cancelModelDownload();
    TestBed.tick();

    expect(apiClient.cancelModelDownload).toHaveBeenCalledWith('job-1');
    expect(store.modelDownload()?.phase).toBe('canceled');
    expect(store.canCancelModelDownload()).toBe(false);
  });
});

function runtimeActionContext(): RuntimeActionContext {
  return {
    canDownloadModel: () => true,
    canInstallRuntime: () => true,
    configuredModelName: () => 'qwen3.5:4b',
    refreshHealthAfterRuntimeChange: vi.fn(),
  };
}

function runtimeInstallation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'runtime-job-1',
    kind: 'ollama',
    provider: 'ollama',
    model: 'qwen3.5:4b',
    status: 'running',
    phase: 'running',
    cancellable: true,
    detail: 'Installing Ollama...',
    completed: 25,
    total: 100,
    created_at: '2026-08-20T00:00:00Z',
    updated_at: '2026-08-20T00:00:01Z',
    ...overrides,
  };
}
