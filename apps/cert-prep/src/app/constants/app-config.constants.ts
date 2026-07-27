import {
  HTTP_INTERCEPTORS,
  provideHttpClient,
  withInterceptorsFromDi,
} from '@angular/common/http';
import type { ApplicationConfig } from '@angular/core';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import Aura from '@primeuix/themes/aura';
import { providePrimeNG } from 'primeng/config';
import { provideRouter } from '@angular/router';
import { CertPrepAuthInterceptor } from '../interceptors/cert-prep-auth.interceptor';
import { appRoutes } from './app-routes.constants';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withInterceptorsFromDi()),
    { provide: HTTP_INTERCEPTORS, useClass: CertPrepAuthInterceptor, multi: true },
    providePrimeNG({
      inputVariant: 'outlined',
      ripple: true,
      theme: {
        preset: Aura,
        options: {
          cssLayer: {
            name: 'primeng',
            order: 'theme, base, primeng',
          },
          darkModeSelector: false,
        },
      },
    }),
    provideRouter(appRoutes),
  ],
};
