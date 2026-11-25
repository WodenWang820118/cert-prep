import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  DevicePreferenceRead,
  DevicePreferenceUpdate,
} from '@cert-prep/api';
import { CERT_PREP_API, CertPrepSseClient } from '../../core/data';
import { isLLMInstallationEventTerminal } from '../../core/domain';
import type { LLMInstallationEvent } from '../../core/domain';
import type {
  LLMProviderSelectionApiClient,
  LLMInstallationApiClient,
} from '../domain';

@Injectable({ providedIn: 'root' })
export class LLMApiClientsService {
  private readonly api = inject(CERT_PREP_API);
  private readonly sse = inject(CertPrepSseClient);

  devicePreference(): Observable<DevicePreferenceRead> {
    return this.api.llmDevicePreference();
  }

  chooseDevicePreference(
    body: DevicePreferenceUpdate,
  ): Observable<DevicePreferenceRead> {
    return this.api.putLlmDevicePreference(body);
  }

  providerSelectionClient(): LLMProviderSelectionApiClient {
    return {
      llmProviderSelection: () => this.api.llmProviderSelection(),
    };
  }

  llmInstallationClient(): LLMInstallationApiClient {
    return {
      llmRequirements: () => this.api.llmRequirements(),
      startLlmInstallation: (kind) =>
        this.api.startLlmInstallation({ kind }),
      getLlmInstallation: (jobId) => this.api.getLlmInstallation(jobId),
      cancelLlmInstallation: (jobId) =>
        this.api.cancelLlmInstallation(jobId),
      streamLlmInstallation: (jobId) =>
        this.sse.streamJson<LLMInstallationEvent>(
          `/llm/installations/${encodeURIComponent(jobId)}/events`,
          'llm-installation',
          { isTerminal: isLLMInstallationEventTerminal },
        ),
    };
  }
}
