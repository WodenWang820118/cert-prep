import { inject, InjectionToken } from '@angular/core';
import { createCertPrepGeneratedClient } from '@cert-prep/api';
import type { CertPrepGeneratedClient } from '../contracts/api.contracts';
// eslint-disable-next-line @softarc/sheriff/dependency-rule -- Known before C7: API constants read a service; C7 separates them.
import { CertPrepAuthenticatedTransport } from '../services/cert-prep-api.service';

export const CERT_PREP_API = new InjectionToken<CertPrepGeneratedClient>(
  'CERT_PREP_API',
  {
    providedIn: 'root',
    factory: () =>
      createCertPrepGeneratedClient(inject(CertPrepAuthenticatedTransport)),
  },
);
