import {
  createCertPrepGeneratedClient,
  type CertPrepHttpRequest,
  type CertPrepTransport,
} from './cert-prep-api.generated';

class RecordingTransport implements CertPrepTransport {
  readonly requests: CertPrepHttpRequest[] = [];

  async request<TResponse>(request: CertPrepHttpRequest): Promise<TResponse> {
    this.requests.push(request);
    return undefined as TResponse;
  }
}

describe('createCertPrepGeneratedClient', () => {
  it('sends typed project creation requests through the transport', async () => {
    const transport = new RecordingTransport();
    const client = createCertPrepGeneratedClient(transport);

    await client.createProject({
      name: 'Security Study',
      description: 'Local cert prep',
    });

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

  it('encodes route parameters before building request paths', async () => {
    const transport = new RecordingTransport();
    const client = createCertPrepGeneratedClient(transport);

    await client.getProject('project/with space');

    expect(transport.requests).toEqual([
      {
        method: 'GET',
        path: '/projects/project%2Fwith%20space',
      },
    ]);
  });
});
