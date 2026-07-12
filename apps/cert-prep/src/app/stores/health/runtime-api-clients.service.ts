import { inject, Injectable } from '@angular/core';
import { CERT_PREP_API } from '../../cert-prep-api';
import type {
  ModelDownloadApiClient,
  RuntimeInstallationApiClient,
} from './contracts/health-runtime.contracts';

@Injectable({ providedIn: 'root' })
export class RuntimeApiClientsService {
  private readonly api = inject(CERT_PREP_API);

  modelDownloadClient(): ModelDownloadApiClient {
    return {
      startModelDownload: () => this.api.startModelDownload(),
      getModelDownload: (jobId) => this.api.getModelDownload(jobId),
    };
  }

  runtimeInstallationClient(): RuntimeInstallationApiClient {
    return {
      runtimeRequirements: () => this.api.runtimeRequirements(),
      startRuntimeInstallation: (kind) =>
        this.api.startRuntimeInstallation(kind),
      getRuntimeInstallation: (jobId) =>
        this.api.getRuntimeInstallation(jobId),
    };
  }
}
