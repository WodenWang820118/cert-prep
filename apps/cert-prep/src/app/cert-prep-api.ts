import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Injectable, InjectionToken } from '@angular/core';
import { createCertPrepGeneratedClient } from '@cert-prep/api';
import type {
  CertPrepGeneratedClient,
  CertPrepHttpRequest,
} from '@cert-prep/api';
import { firstValueFrom } from 'rxjs';

export type {
  ChunkRead,
  DocumentRead,
  DraftGenerateRequest,
  DraftGenerationJobList,
  DraftGenerationJobRead,
  CertPrepGeneratedClient,
  HealthResponse,
  LLMHealthRead,
  ModelDownloadRead,
  OCRHealthRead,
  PracticeAttemptCreate,
  PracticeAttemptRead,
  PracticeSessionCreate,
  PracticeSessionRead,
  ProjectCreate,
  ProjectList,
  ProjectRead,
  QuestionDraftList,
  QuestionDraftRead,
  QuestionDraftUpdate,
  RuntimeInstallationRead,
  RuntimeRequirementKind,
  RuntimeRequirementRead,
  RuntimeRequirementsRead,
  WrongAnswerExplanationRead,
  WrongAnswerList,
  WrongAnswerRead,
  WrongAnswerSummaryRead,
} from '@cert-prep/api';

const DEFAULT_LOCAL_API_BASE_URL = 'http://127.0.0.1:8765';

interface BackendConfig {
  base_url: string;
  token: string;
}

export const CERT_PREP_API = new InjectionToken<CertPrepGeneratedClient>(
  'CERT_PREP_API',
  {
    providedIn: 'root',
    factory: () =>
      createCertPrepGeneratedClient(inject(CertPrepAuthenticatedTransport)),
  },
);

@Injectable({ providedIn: 'root' })
export class CertPrepRuntimeConfig {
  private configPromise: Promise<BackendConfig> | null = null;

  async getBackendConfig(): Promise<BackendConfig> {
    this.configPromise ??= this.loadBackendConfig();
    return this.configPromise;
  }

  private async loadBackendConfig(): Promise<BackendConfig> {
    const tauriConfig = await this.loadTauriBackendConfig();
    return tauriConfig ?? this.loadLocalBackendConfig();
  }

  private async loadTauriBackendConfig(): Promise<BackendConfig | null> {
    const windowRef = globalThis as typeof globalThis & {
      window?: Window & { __TAURI_INTERNALS__?: unknown };
    };
    if (
      typeof windowRef.window === 'undefined' ||
      !('__TAURI_INTERNALS__' in windowRef.window)
    ) {
      return null;
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<BackendConfig>('backend_config');
    } catch {
      throw new Error('Desktop backend configuration is unavailable.');
    }
  }

  private loadLocalBackendConfig(): BackendConfig {
    const storage = this.getLocalStorage();
    return {
      base_url:
        storage?.getItem('certPrepApiBaseUrl')?.trim() ??
        DEFAULT_LOCAL_API_BASE_URL,
      token: storage?.getItem('certPrepApiToken')?.trim() ?? '',
    };
  }

  private getLocalStorage(): Storage | null {
    const windowRef = globalThis as typeof globalThis & { window?: Window };
    if (typeof windowRef.window === 'undefined') {
      return null;
    }

    try {
      return windowRef.window.localStorage;
    } catch {
      return null;
    }
  }
}

@Injectable({ providedIn: 'root' })
class CertPrepAuthenticatedTransport {
  private readonly http = inject(HttpClient);
  private readonly runtimeConfig = inject(CertPrepRuntimeConfig);

  async request<TResponse>(request: CertPrepHttpRequest): Promise<TResponse> {
    const config = await this.runtimeConfig.getBackendConfig();
    return firstValueFrom(
      this.http.request<TResponse>(
        request.method,
        this.url(config.base_url, request.path),
        {
          body: request.body,
          headers: new HttpHeaders({
            Authorization: `Bearer ${config.token}`,
          }),
        },
      ),
    );
  }

  private url(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}${path}`;
  }
}
