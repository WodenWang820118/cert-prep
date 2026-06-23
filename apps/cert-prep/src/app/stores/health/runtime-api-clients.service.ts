import { inject, Injectable } from '@angular/core';
import { CERT_PREP_API, type CertPrepGeneratedClient } from '../../cert-prep-api';
import type {
  ModelDownloadApiClient,
  RuntimeInstallationApiClient,
} from './contracts/health-runtime.contracts';

@Injectable({ providedIn: 'root' })
export class RuntimeApiClientsService {
  private readonly api = inject(CERT_PREP_API);

  modelDownloadClient(): ModelDownloadApiClient | null {
    const client = this.api as CertPrepGeneratedClient &
      Partial<ModelDownloadApiClient>;
    if (
      typeof client.startModelDownload !== 'function' ||
      typeof client.getModelDownload !== 'function'
    ) {
      return null;
    }

    return {
      startModelDownload: () => client.startModelDownload(),
      getModelDownload: (jobId) => client.getModelDownload(jobId),
    };
  }

  runtimeInstallationClient(): RuntimeInstallationApiClient | null {
    const client = this.api as CertPrepGeneratedClient &
      Partial<RuntimeInstallationApiClient>;
    if (
      typeof client.runtimeRequirements !== 'function' ||
      typeof client.startRuntimeInstallation !== 'function' ||
      typeof client.getRuntimeInstallation !== 'function'
    ) {
      return null;
    }

    return {
      runtimeRequirements: () => client.runtimeRequirements(),
      startRuntimeInstallation: (kind) => client.startRuntimeInstallation(kind),
      getRuntimeInstallation: (jobId) => client.getRuntimeInstallation(jobId),
    };
  }
}
