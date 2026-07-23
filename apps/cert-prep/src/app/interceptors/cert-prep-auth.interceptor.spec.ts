import {
  HttpClient,
  HTTP_INTERCEPTORS,
  provideHttpClient,
  withInterceptorsFromDi,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { CertPrepRuntimeConfig } from '../services/cert-prep-api.service';
import { CertPrepAuthInterceptor } from './cert-prep-auth.interceptor';

describe('CertPrepAuthInterceptor', () => {
  let http: HttpClient;
  let httpTesting: HttpTestingController;
  const backendConfig = {
    base_url: 'http://127.0.0.1:9001/',
    token: 'runtime-token',
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
        { provide: HTTP_INTERCEPTORS, useClass: CertPrepAuthInterceptor, multi: true },
        {
          provide: CertPrepRuntimeConfig,
          useValue: {
            getBackendConfig: vi.fn().mockReturnValue(of(backendConfig)),
          },
        },
      ],
    });
    http = TestBed.inject(HttpClient);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpTesting.verify({ ignoreCancelled: true }));

  it('joins the configured backend URL and normalizes caller headers', () => {
    let response: unknown;
    http.get('/projects', {
        headers: {
          Authorization: 'Bearer caller-token',
          'X-Cert-Prep-Operation-Id': 'operation-1',
        },
      }).subscribe((value) => (response = value));
    const request = httpTesting.expectOne('http://127.0.0.1:9001/projects');

    expect(request.request.headers.getAll('Authorization')).toEqual([
      'Bearer runtime-token',
    ]);
    expect(request.request.headers.get('X-Cert-Prep-Operation-Id')).toBe(
      'operation-1',
    );

    request.flush({ items: [] });
    expect(response).toEqual({ items: [] });
  });

  it('does not rewrite absolute URLs', () => {
    let response: unknown;
    http.get('https://example.test/health').subscribe((value) => (response = value));
    const request = httpTesting.expectOne('https://example.test/health');

    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush({ status: 'ok' });
    expect(response).toEqual({ status: 'ok' });
  });

  it('surfaces backend config failures without issuing a request', () => {
    const getBackendConfig = TestBed.inject(CertPrepRuntimeConfig)
      .getBackendConfig as ReturnType<typeof vi.fn>;
    getBackendConfig.mockReturnValue(throwError(() => new Error('desktop unavailable')));

    let error: unknown;
    http.get('/health').subscribe({ error: (reason) => (error = reason) });
    expect(error).toEqual(expect.objectContaining({ message: 'desktop unavailable' }));
    httpTesting.expectNone('http://127.0.0.1:9001/health');
  });
});
