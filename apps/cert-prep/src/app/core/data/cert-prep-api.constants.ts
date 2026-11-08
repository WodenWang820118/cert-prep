import { inject, InjectionToken } from '@angular/core';
import { createCertPrepGeneratedClient } from '@cert-prep/api';
import type { CertPrepGeneratedClient } from '../domain';
import { CertPrepAuthenticatedTransport } from './cert-prep-api.service';

export const CERT_PREP_API = new InjectionToken<CertPrepGeneratedClient>(
  'CERT_PREP_API',
  {
    providedIn: 'root',
    factory: () =>
      createCertPrepGeneratedClient(inject(CertPrepAuthenticatedTransport)),
  },
);
