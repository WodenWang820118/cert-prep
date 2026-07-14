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

  it('uses the dedicated provider-selection terms decision endpoint', async () => {
    const transport = new RecordingTransport();
    const client = createCertPrepGeneratedClient(transport);

    await client.llmProviderSelection();
    await client.decideFastflowlmTerms({
      decision: 'accepted',
      terms_version: '0.9.43',
    });

    expect(transport.requests).toEqual([
      {
        method: 'GET',
        path: '/llm/provider-selection',
      },
      {
        method: 'POST',
        path: '/llm/provider-selection/fastflowlm-terms-decision',
        body: {
          decision: 'accepted',
          terms_version: '0.9.43',
        },
      },
    ]);
  });

  it('uses the generated active-session and abandon endpoints', async () => {
    const transport = new RecordingTransport();
    const client = createCertPrepGeneratedClient(transport);

    await client.listActivePracticeSessions('project/one');
    await client.abandonPracticeSession('project/one', 'session two');

    expect(transport.requests).toEqual([
      {
        method: 'GET',
        path: '/projects/project%2Fone/practice-sessions',
      },
      {
        method: 'POST',
        path: '/projects/project%2Fone/practice-sessions/session%20two/abandon',
      },
    ]);
  });

  it('forwards document operation headers, signals, and cancellation routes', async () => {
    const transport = new RecordingTransport();
    const client = createCertPrepGeneratedClient(transport);
    const controller = new AbortController();
    const formData = new FormData();

    await client.uploadDocument('project/one', formData, {
      headers: { 'X-Cert-Prep-Operation-Id': 'upload-1' },
      signal: controller.signal,
    });
    await client.getDocumentOperation('project/one', 'upload/1');
    await client.cancelDocumentOperation('project/one', 'upload/1');
    await client.cancelDocumentProcessing('project/one', 'document/1');
    await client.retryDocumentProcessing('project/one', 'document/1', {
      headers: { 'X-Cert-Prep-Operation-Id': 'retry-1' },
    });

    expect(transport.requests).toEqual([
      {
        method: 'POST',
        path: '/projects/project%2Fone/documents',
        body: formData,
        headers: { 'X-Cert-Prep-Operation-Id': 'upload-1' },
        signal: controller.signal,
      },
      {
        method: 'GET',
        path: '/projects/project%2Fone/document-operations/upload%2F1',
      },
      {
        method: 'DELETE',
        path: '/projects/project%2Fone/document-operations/upload%2F1',
      },
      {
        method: 'DELETE',
        path: '/projects/project%2Fone/documents/document%2F1/processing',
      },
      {
        method: 'POST',
        path: '/projects/project%2Fone/documents/document%2F1/retry',
        headers: { 'X-Cert-Prep-Operation-Id': 'retry-1' },
      },
    ]);
  });
});
