import { inject, Injectable } from '@angular/core';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import {
  isModelDownloadEventTerminal,
  isRuntimeInstallationEventTerminal,
} from '../../contracts/operation-events.contracts';
import type {
  ModelDownloadEvent,
  RuntimeInstallationEvent,
} from '../../contracts/operation-events.contracts';
import { CertPrepSseClient } from '../../services/cert-prep-sse-client.service';
import type {
  LLMProviderSelectionApiClient,
  ModelDownloadApiClient,
  RuntimeInstallationApiClient,
} from './contracts/health-runtime.contracts';

@Injectable({ providedIn: 'root' })
export class RuntimeApiClientsService {
  private readonly api = inject(CERT_PREP_API);
  private readonly sse = inject(CertPrepSseClient);

  modelDownloadClient(): ModelDownloadApiClient {
    return {
      startModelDownload: () => this.api.startModelDownload(),
      getModelDownload: (jobId) => this.api.getModelDownload(jobId),
      cancelModelDownload: (jobId) => this.api.cancelModelDownload(jobId),
      streamModelDownload: (jobId) =>
        this.sse.streamJson<ModelDownloadEvent>(
          `/llm/model-downloads/${encodeURIComponent(jobId)}/events`,
          'model-download',
          { isTerminal: isModelDownloadEventTerminal },
        ),
    };
  }

  providerSelectionClient(): LLMProviderSelectionApiClient {
    return {
      llmProviderSelection: () => this.api.llmProviderSelection(),
    };
  }

  runtimeInstallationClient(): RuntimeInstallationApiClient {
    return {
      runtimeRequirements: () => this.api.runtimeRequirements(),
      startRuntimeInstallation: (kind) =>
        this.api.startRuntimeInstallation(kind),
      getRuntimeInstallation: (jobId) => this.api.getRuntimeInstallation(jobId),
      cancelRuntimeInstallation: (jobId) =>
        this.api.cancelRuntimeInstallation(jobId),
      streamRuntimeInstallation: (jobId) =>
        this.sse.streamJson<RuntimeInstallationEvent>(
          `/runtime/installations/${encodeURIComponent(jobId)}/events`,
          'runtime-installation',
          { isTerminal: isRuntimeInstallationEventTerminal },
        ),
    };
  }
}
