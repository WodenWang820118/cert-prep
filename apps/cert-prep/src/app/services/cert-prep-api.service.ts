import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { CertPrepTauriBridgeService } from './cert-prep-tauri-bridge.service';
import { DEFAULT_LOCAL_API_BASE_URL } from '../constants/runtime.constants';
import type { CertPrepHttpRequest } from '../contracts/api.contracts';
import type { BackendConfig } from '../contracts/backend.contracts';
import {
  catchError,
  defer,
  Observable,
  of,
  race,
  ReplaySubject,
  share,
  switchMap,
  tap,
  throwError,
} from 'rxjs';

@Injectable({ providedIn: 'root' })
export class CertPrepRuntimeConfig {
  private readonly tauri = inject(CertPrepTauriBridgeService);
  private backendConfig$: Observable<BackendConfig> | null = null;

  getBackendConfig(): Observable<BackendConfig> {
    if (this.backendConfig$ !== null) {
      return this.backendConfig$;
    }

    const lookup$ = defer(() => this.loadBackendConfig()).pipe(
      tap({
        error: () => (this.backendConfig$ = null),
      }),
      share({
        connector: () => new ReplaySubject<BackendConfig>(1),
        resetOnError: false,
        resetOnComplete: false,
        resetOnRefCountZero: false,
      }),
    );
    this.backendConfig$ = lookup$;
    return lookup$;
  }

  /**
   * Tauri rotates the owned backend URL/token when optional Capture Runtime is
   * started. Forget the replayed value before the next authenticated request.
   */
  invalidateBackendConfig(): void {
    this.backendConfig$ = null;
  }

  private loadBackendConfig(): Observable<BackendConfig> {
    return this.loadTauriBackendConfig().pipe(
      switchMap((tauriConfig) =>
        of(tauriConfig ?? this.loadLocalBackendConfig()),
      ),
    );
  }

  private loadTauriBackendConfig(): Observable<BackendConfig | null> {
    if (!this.tauri.isDesktop()) {
      return of(null);
    }

    return this.tauri.invoke<BackendConfig>('backend_config').pipe(
      catchError(() =>
        throwError(() =>
          new Error('Desktop backend configuration is unavailable.'),
        ),
      ),
    );
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
export class CertPrepAuthenticatedTransport {
  private readonly http = inject(HttpClient);
  private readonly runtimeConfig = inject(CertPrepRuntimeConfig);

  request<TResponse>(request: CertPrepHttpRequest): Observable<TResponse> {
    const response = defer(() => this.runtimeConfig.getBackendConfig()).pipe(
      switchMap((config) => {
        const url = this.url(config.base_url, request.path);
        const options = {
          body: request.body,
          headers: new HttpHeaders(request.headers ?? {})
            .delete('Authorization')
            .set('Authorization', `Bearer ${config.token}`),
        };
        if (request.responseType === 'blob') {
          return this.http.request(request.method, url, {
            ...options,
            responseType: 'blob',
          }) as unknown as Observable<TResponse>;
        }
        return this.http.request<TResponse>(request.method, url, options);
      }),
    );

    if (request.signal === undefined) {
      return response;
    }

    return request.signal.aborted
      ? this.abortError(request.signal)
      : race(this.abortError(request.signal), response);
  }

  private abortError(signal: AbortSignal): Observable<never> {
    return new Observable<never>((subscriber) => {
      const onAbort = (): void => subscriber.error(this.abortReason(signal));
      if (signal.aborted) {
        onAbort();
        return undefined;
      }

      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }

      return () => signal.removeEventListener('abort', onAbort);
    });
  }

  private abortReason(signal: AbortSignal): unknown {
    return (
      signal.reason ??
      new DOMException('The operation was aborted.', 'AbortError')
    );
  }

  private url(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}${path}`;
  }
}
