import {
  HttpClient,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { CertPrepRuntimeConfig } from './cert-prep-api';
import { certPrepAuthInterceptor } from './cert-prep-auth.interceptor';

describe('certPrepAuthInterceptor', () => {
  let http: HttpClient;
  let httpTesting: HttpTestingController;
  const backendConfig = {
    base_url: 'http://127.0.0.1:9001/',
    token: 'runtime-token',
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([certPrepAuthInterceptor])),
        provideHttpClientTesting(),
        {
          provide: CertPrepRuntimeConfig,
          useValue: {
            getBackendConfig: vi.fn().mockResolvedValue(backendConfig),
          },
        },
      ],
    });
    http = TestBed.inject(HttpClient);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpTesting.verify({ ignoreCancelled: true }));

  it('joins the configured backend URL and normalizes caller headers', async () => {
    const responsePromise = firstValueFrom(
      http.get('/projects', {
        headers: {
          Authorization: 'Bearer caller-token',
          'X-Cert-Prep-Operation-Id': 'operation-1',
        },
      }),
    );
    await Promise.resolve();
    const request = httpTesting.expectOne('http://127.0.0.1:9001/projects');

    expect(request.request.headers.getAll('Authorization')).toEqual([
      'Bearer runtime-token',
    ]);
    expect(request.request.headers.get('X-Cert-Prep-Operation-Id')).toBe(
      'operation-1',
    );

    request.flush({ items: [] });
    await expect(responsePromise).resolves.toEqual({ items: [] });
  });

  it('does not rewrite absolute URLs', async () => {
    const responsePromise = firstValueFrom(
      http.get('https://example.test/health'),
    );
    const request = httpTesting.expectOne('https://example.test/health');

    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush({ status: 'ok' });
    await expect(responsePromise).resolves.toEqual({ status: 'ok' });
  });

  it('surfaces backend config failures without issuing a request', async () => {
    const getBackendConfig = TestBed.inject(CertPrepRuntimeConfig)
      .getBackendConfig as ReturnType<typeof vi.fn>;
    getBackendConfig.mockRejectedValue(new Error('desktop unavailable'));

    const responsePromise = firstValueFrom(http.get('/health'));
    await Promise.resolve();
    await expect(responsePromise).rejects.toThrow('desktop unavailable');
    httpTesting.expectNone('http://127.0.0.1:9001/health');
  });
});
