import {
  HttpInterceptorFn,
  HttpRequest,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { defer, switchMap } from 'rxjs';
import { CertPrepRuntimeConfig } from './cert-prep-api';

export const certPrepAuthInterceptor: HttpInterceptorFn = (request, next) => {
  if (isAbsoluteUrl(request.url)) {
    return next(request);
  }

  const runtimeConfig = inject(CertPrepRuntimeConfig);
  return defer(() => runtimeConfig.getBackendConfig()).pipe(
    switchMap((config) => {
      const headers = request.headers
        .delete('Authorization')
        .set('Authorization', `Bearer ${config.token}`);

      return next(
        request.clone({
          url: joinUrl(config.base_url, request.url),
          headers,
        }),
      );
    }),
  );
};

function isAbsoluteUrl(url: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(url);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

// Keep this reference explicit so the interceptor's request shape remains easy to inspect in tests.
export type CertPrepInterceptedRequest = HttpRequest<unknown>;
