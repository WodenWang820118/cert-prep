import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { CERT_PREP_API } from '../../core/data';
import { CertPrepSseClient } from '../../core/data';
import { HealthStore } from './health.store';
import type { LLMInstallationActionContext } from '../domain';
import { LLMInstallationActionsStore } from './llm-installation-actions.store';
import { OperationStore } from '../../core/data';
import {
  llmHealth,
  modelDownload,
  providerSelection,
} from './health.store.spec-helpers';
import { provideCertPrepHttpResourceClientFake } from '../../core/testing';

describe('HealthStore model downloads', () => {
  const apiClient = {
    health: vi.fn(),
    llmHealth: vi.fn(),
    llmProviderSelection: vi.fn(),
    llmRequirements: vi.fn(),
    startLlmInstallation: vi.fn(),
    getLlmInstallation: vi.fn(),
    cancelLlmInstallation: vi.fn(),
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
        llm_engine_requirement_kind: 'ollama',
        model_requirement_kind: 'ollama_model',
      }),
    ));
    apiClient.llmRequirements.mockReturnValue(of({ items: [] }));
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
    expect(apiClient.startLlmInstallation).not.toHaveBeenCalled();
  });

  it('starts and streams a model download only after confirmation', () => {
    const store = TestBed.inject(HealthStore);
    apiClient.startLlmInstallation.mockReturnValue(of(
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

    expect(apiClient.startLlmInstallation).toHaveBeenCalledTimes(1);
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
    const actions = TestBed.inject(LLMInstallationActionsStore);
    const operations = TestBed.inject(OperationStore);
    const context = llmInstallationActionContext();
    apiClient.startLlmInstallation.mockReturnValue(of(
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
    apiClient.getLlmInstallation.mockReturnValue(of(
      modelDownload({ status: 'running', phase: 'running', detail: 'still downloading' }),
    ));
    sseClient.streamJson.mockReturnValueOnce(retryStream.asObservable());
    actions.refreshModelDownload(context);
    TestBed.tick();

    expect(actions.modelDownloadStreamError()).toBeNull();
    expect(sseClient.streamJson).toHaveBeenCalledTimes(2);
  });

  it('preserves the durable runtime state when its progress stream errors and refresh reconnects it', () => {
    const actions = TestBed.inject(LLMInstallationActionsStore);
    const operations = TestBed.inject(OperationStore);
    const context = llmInstallationActionContext();
    const runtimeStream = new Subject<Record<string, unknown>>();
    const retryStream = new Subject<Record<string, unknown>>();
    sseClient.streamJson.mockReturnValue(runtimeStream.asObservable());
    apiClient.startLlmInstallation.mockReturnValue(of(llmEngineInstallation()));

    actions.openLLMEngineInstallConsent('ollama', true);
    actions.confirmLLMEngineInstallation(context);
    TestBed.tick();
    const durableState = actions.llmEngineInstall();

    runtimeStream.error(new Error('SSE disconnected'));
    TestBed.tick();

    expect(actions.llmEngineInstall()).toBe(durableState);
    expect(actions.llmEngineInstall()?.status).toBe('running');
    expect(actions.llmEngineInstall()?.phase).toBe('running');
    expect(actions.llmEngineInstallStreamError()).toBe(
      'Runtime installation progress stream disconnected. Retry refresh to reconnect.',
    );
    expect(operations.error()).toBeNull();

    apiClient.getLlmInstallation.mockReturnValue(of(llmEngineInstallation()));
    sseClient.streamJson.mockReturnValueOnce(retryStream.asObservable());
    actions.refreshLLMEngineInstallation(context);
    TestBed.tick();

    expect(actions.llmEngineInstallStreamError()).toBeNull();
    expect(sseClient.streamJson).toHaveBeenCalledTimes(2);
  });

  it('preserves the durable model state when refresh GET errors and refresh can recover', () => {
    const actions = TestBed.inject(LLMInstallationActionsStore);
    const operations = TestBed.inject(OperationStore);
    const context = llmInstallationActionContext();
    apiClient.startLlmInstallation.mockReturnValue(of(
      modelDownload({ status: 'running', phase: 'running', detail: 'downloading' }),
    ));

    actions.confirmModelDownload(context);
    TestBed.tick();
    const durableState = actions.modelDownload();
    apiClient.getLlmInstallation.mockReturnValue(
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
    apiClient.getLlmInstallation.mockReturnValue(of(
      modelDownload({ status: 'running', phase: 'running' }),
    ));
    sseClient.streamJson.mockReturnValueOnce(retryStream.asObservable());
    actions.refreshModelDownload(context);
    TestBed.tick();

    expect(actions.modelDownloadStreamError()).toBeNull();
    expect(sseClient.streamJson).toHaveBeenCalledTimes(2);
  });

  it('preserves the durable runtime state when refresh GET errors and refresh can recover', () => {
    const actions = TestBed.inject(LLMInstallationActionsStore);
    const operations = TestBed.inject(OperationStore);
    const context = llmInstallationActionContext();
    const runtimeStream = new Subject<Record<string, unknown>>();
    const retryStream = new Subject<Record<string, unknown>>();
    sseClient.streamJson.mockReturnValue(runtimeStream.asObservable());
    apiClient.startLlmInstallation.mockReturnValue(of(llmEngineInstallation()));

    actions.openLLMEngineInstallConsent('ollama', true);
    actions.confirmLLMEngineInstallation(context);
    TestBed.tick();
    const durableState = actions.llmEngineInstall();
    apiClient.getLlmInstallation.mockReturnValue(
      throwError(() => new Error('GET disconnected')),
    );

    actions.refreshLLMEngineInstallation(context);
    TestBed.tick();

    expect(actions.llmEngineInstall()).toBe(durableState);
    expect(actions.llmEngineInstall()?.status).toBe('running');
    expect(actions.llmEngineInstall()?.phase).toBe('running');
    expect(actions.llmEngineInstallStreamError()).toBe(
      'Runtime installation status could not be refreshed. Retry refresh to reconnect.',
    );
    expect(operations.error()).toBeNull();

    apiClient.getLlmInstallation.mockReturnValue(of(llmEngineInstallation()));
    sseClient.streamJson.mockReturnValueOnce(retryStream.asObservable());
    actions.refreshLLMEngineInstallation(context);
    TestBed.tick();

    expect(actions.llmEngineInstallStreamError()).toBeNull();
    expect(sseClient.streamJson).toHaveBeenCalledTimes(2);
  });

  it('exposes runtime transport errors through the HealthStore façade', () => {
    const health = TestBed.inject(HealthStore);
    const actions = TestBed.inject(LLMInstallationActionsStore);

    expect(health.modelDownloadStreamError).toBe(actions.modelDownloadStreamError);
    expect(health.llmEngineInstallStreamError).toBe(actions.llmEngineInstallStreamError);

    actions.modelDownloadStreamError.set('model stream disconnected');
    actions.llmEngineInstallStreamError.set('runtime stream disconnected');

    expect(health.modelDownloadStreamError()).toBe('model stream disconnected');
    expect(health.llmEngineInstallStreamError()).toBe('runtime stream disconnected');
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
    expect(apiClient.startLlmInstallation).not.toHaveBeenCalled();
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
    apiClient.llmRequirements.mockReturnValue(of({
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
    apiClient.startLlmInstallation.mockReturnValue(of(
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

    expect(apiClient.startLlmInstallation).toHaveBeenCalledWith({ kind: 'ollama_model' });
    expect(store.modelDownload()?.model).toBe('qwen3.5:4b');
  });

  it('cancels an active model download through the generated API', () => {
    const store = TestBed.inject(HealthStore);
    apiClient.startLlmInstallation.mockReturnValue(of(
      modelDownload({ status: 'running', phase: 'downloading' }),
    ));
    apiClient.cancelLlmInstallation.mockReturnValue(of(
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

    expect(apiClient.cancelLlmInstallation).toHaveBeenCalledWith('job-1');
    expect(store.modelDownload()?.phase).toBe('canceled');
    expect(store.canCancelModelDownload()).toBe(false);
  });
});

function llmInstallationActionContext(): LLMInstallationActionContext {
  return {
    canDownloadModel: () => true,
    canInstallLLMEngine: () => true,
    configuredModelName: () => 'qwen3.5:4b',
    refreshHealthAfterLLMInstallation: vi.fn(),
  };
}

function llmEngineInstallation(
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
