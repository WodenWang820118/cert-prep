import {
  createCertPrepGeneratedClient,
  type CertPrepHttpRequest,
  type CertPrepTransport,
} from './cert-prep-api.generated';
import { Observable, of } from 'rxjs';

class RecordingTransport implements CertPrepTransport {
  readonly requests: CertPrepHttpRequest[] = [];

  request<TResponse>(request: CertPrepHttpRequest): Observable<TResponse> {
    this.requests.push(request);
    return of(undefined as TResponse);
  }
}

describe('createCertPrepGeneratedClient', () => {
  it('sends typed project creation requests through the transport', () => {
    const transport = new RecordingTransport();
    const client = createCertPrepGeneratedClient(transport);

    client.createProject({
      name: 'Security Study',
      description: 'Local cert prep',
    }).subscribe();

    expect(transport.requests).toEqual([
      {
        method: 'POST',
        path: '/projects',
        body: {
          name: 'Security Study',
          description: 'Local cert prep',
        },
      },
    ]);
  });

  it('encodes route parameters before building request paths', () => {
    const transport = new RecordingTransport();
    const client = createCertPrepGeneratedClient(transport);

    client.getProject('project/with space').subscribe();

    expect(transport.requests).toEqual([
      {
        method: 'GET',
        path: '/projects/project%2Fwith%20space',
      },
    ]);
  });

  it('forwards operation headers and abort signals without changing route types', () => {
    const transport = new RecordingTransport();
    const client = createCertPrepGeneratedClient(transport);
    const controller = new AbortController();

    client.getProject('project-id', {
      headers: { 'X-Cert-Prep-Operation-Id': 'operation-id' },
      signal: controller.signal,
    }).subscribe();

    expect(transport.requests).toEqual([
      {
        method: 'GET',
        path: '/projects/project-id',
        headers: { 'X-Cert-Prep-Operation-Id': 'operation-id' },
        signal: controller.signal,
      },
    ]);
  });
});
