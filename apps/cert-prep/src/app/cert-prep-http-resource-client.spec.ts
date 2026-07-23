import {
  HTTP_INTERCEPTORS,
  provideHttpClient,
  withInterceptorsFromDi,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { CertPrepRuntimeConfig } from './cert-prep-api';
import { CertPrepAuthInterceptor } from './cert-prep-auth.interceptor';
import { CertPrepHttpResourceClient } from './cert-prep-http-resource-client';

describe('CertPrepHttpResourceClient', () => {
  let httpTesting: HttpTestingController;
  let client: CertPrepHttpResourceClient;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
        { provide: HTTP_INTERCEPTORS, useClass: CertPrepAuthInterceptor, multi: true },
        {
          provide: CertPrepRuntimeConfig,
          useValue: {
            getBackendConfig: vi.fn().mockReturnValue(of({
              base_url: 'http://127.0.0.1:9001',
              token: 'resource-token',
            })),
          },
        },
      ],
    });
    httpTesting = TestBed.inject(HttpTestingController);
    client = TestBed.inject(CertPrepHttpResourceClient);
  });

  afterEach(() => httpTesting.verify({ ignoreCancelled: true }));

  it('uses generated route encoding and parses a collection response', () => {
    const projectId = signal<string | null>('project/one');
    const resource = client.documents(() => projectId());
    resource.status();
    TestBed.tick();

    const matches = httpTesting.match(
      'http://127.0.0.1:9001/projects/project%2Fone/documents',
    );
    expect(matches).toHaveLength(1);
    const request = matches[0];
    if (request === undefined) {
      throw new Error('The project documents request was not created.');
    }
    expect(request.request.headers.get('Authorization')).toBe(
      'Bearer resource-token',
    );

    request.flush({ items: [{ id: 'document-1' }] });
    return vi.waitFor(() => {
      expect(resource.status()).toBe('resolved');
      expect(resource.value()).toEqual([{ id: 'document-1' }]);
    });
  });

  it('cancels the previous project query when its signal key changes', () => {
    const projectId = signal<string | null>('old-project');
    const resource = client.documents(() => projectId());
    resource.status();
    TestBed.tick();

    const matches = httpTesting.match(
      'http://127.0.0.1:9001/projects/old-project/documents',
    );
    expect(matches).toHaveLength(1);
    const oldRequest = matches[0];
    if (oldRequest === undefined) {
      throw new Error('The initial project documents request was not created.');
    }
    const initialRequest = oldRequest;

    projectId.set('new-project');
    resource.status();
    TestBed.tick();
    expect(initialRequest.cancelled).toBe(true);

    const newRequest = httpTesting.expectOne(
      'http://127.0.0.1:9001/projects/new-project/documents',
    );
    newRequest.flush({ items: [] });
    return vi.waitFor(() => {
      expect(resource.status()).toBe('resolved');
      expect(resource.value()).toEqual([]);
    });
  });

  it('exposes a resource error for invalid JSON collection data', () => {
    const projectId = signal<string | null>('project-1');
    const resource = client.documents(() => projectId());
    resource.status();
    TestBed.tick();

    const matches = httpTesting.match(
      'http://127.0.0.1:9001/projects/project-1/documents',
    );
    expect(matches).toHaveLength(1);
    const request = matches[0];
    if (request === undefined) {
      throw new Error('The project documents request was not created.');
    }
    request.flush({ invalid: true });

    return vi.waitFor(() => {
      expect(resource.status()).toBe('error');
      expect(resource.error()).toBeInstanceOf(Error);
    });
  });
});
