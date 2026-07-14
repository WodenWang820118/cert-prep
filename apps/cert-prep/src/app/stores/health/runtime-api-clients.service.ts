import { inject, Injectable } from '@angular/core';
import { CERT_PREP_API } from '../../cert-prep-api';
import type {
  LLMProviderSelectionApiClient,
  ModelDownloadApiClient,
  RuntimeInstallationApiClient,
} from './contracts/health-runtime.contracts';

@Injectable({ providedIn: 'root' })
export class RuntimeApiClientsService {
  private readonly api = inject(CERT_PREP_API);

  modelDownloadClient(): ModelDownloadApiClient {
    return {
      startModelDownload: (body) =>
        body === undefined
          ? this.api.startModelDownload()
          : this.api.startModelDownload(body),
      getModelDownload: (jobId) => this.api.getModelDownload(jobId),
      cancelModelDownload: (jobId) => this.api.cancelModelDownload(jobId),
    };
  }

  providerSelectionClient(): LLMProviderSelectionApiClient {
    return {
      llmProviderSelection: () => this.api.llmProviderSelection(),
      decideFastflowlmTerms: (body) => this.api.decideFastflowlmTerms(body),
    };
  }

  runtimeInstallationClient(): RuntimeInstallationApiClient {
    return {
      runtimeRequirements: () => this.api.runtimeRequirements(),
      startRuntimeInstallation: (kind, body) =>
        body === undefined
          ? this.api.startRuntimeInstallation(kind)
          : this.api.startRuntimeInstallation(kind, body),
      getRuntimeInstallation: (jobId) =>
        this.api.getRuntimeInstallation(jobId),
      cancelRuntimeInstallation: (jobId) =>
        this.api.cancelRuntimeInstallation(jobId),
    };
  }
}
