import {
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
} from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { defer, switchMap } from 'rxjs';
import { CertPrepRuntimeConfig } from '../services/cert-prep-api.service';

@Injectable({ providedIn: 'root' })
export class CertPrepAuthInterceptor implements HttpInterceptor {
  private readonly runtimeConfig = inject(CertPrepRuntimeConfig);

  intercept(
    request: HttpRequest<unknown>,
    next: HttpHandler,
  ): Observable<HttpEvent<unknown>> {
    if (this.isAbsoluteUrl(request.url)) {
      return next.handle(request);
    }

    return defer(() => this.runtimeConfig.getBackendConfig()).pipe(
      switchMap((config) => {
        const headers = request.headers
          .delete('Authorization')
          .set('Authorization', `Bearer ${config.token}`);

        return next.handle(
          request.clone({
            url: this.joinUrl(config.base_url, request.url),
            headers,
          }),
        );
      }),
    );
  }

  private isAbsoluteUrl(url: string): boolean {
    return /^[a-z][a-z\d+.-]*:/i.test(url);
  }

  private joinUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }
}
