import type { ExamPrepGeneratedClient } from '../exam-prep-api';
import type {
  ModelDownloadApiClient,
  RuntimeInstallationApiClient,
} from './health-runtime.models';

export function modelDownloadClient(
  api: ExamPrepGeneratedClient,
): ModelDownloadApiClient | null {
  const client = api as ExamPrepGeneratedClient & Partial<ModelDownloadApiClient>;
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

export function runtimeInstallationClient(
  api: ExamPrepGeneratedClient,
): RuntimeInstallationApiClient | null {
  const client = api as ExamPrepGeneratedClient &
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
