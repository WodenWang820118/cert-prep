/* eslint-disable @softarc/sheriff/dependency-rule -- Known before C6: the app config is the composition root; C6 moves it out of constants. */
import {
  HTTP_INTERCEPTORS,
  provideHttpClient,
  withInterceptorsFromDi,
} from '@angular/common/http';
import type { ApplicationConfig } from '@angular/core';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { CertPrepAuthInterceptor } from '../interceptors/cert-prep-auth.interceptor';
import { appRoutes } from './app-routes.constants';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withInterceptorsFromDi()),
    { provide: HTTP_INTERCEPTORS, useClass: CertPrepAuthInterceptor, multi: true },
    provideRouter(appRoutes),
  ],
};
