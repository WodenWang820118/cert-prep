import {
  HTTP_INTERCEPTORS,
  type HttpInterceptorFn,
  provideHttpClient,
  withInterceptors,
  withInterceptorsFromDi,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { CertPrepAuthInterceptor } from '../data';
import type { DocumentRead, QuestionDraftRead } from '../domain';
import {
  appDocument,
  appProject,
  availableLlmHealth,
  backendHealth,
  buttonByText,
  editableAppQuestion,
  emptyWrongAnswerSummary,
  secondAppDocument,
  secondAppProject,
} from '../testing';
import { App } from './app.component';
import { appRoutes } from './app-routes.constants';

/**
 * Characterization of when the `/build` route reloads the project's question
 * drafts (DDD step C7, part 4). It drives the real route, shell and stores
 * against `HttpTestingController` and records every HTTP request and
 * server-sent event stream in the order they are issued. Moving the reload
 * from the build page into Question Authoring's store must not change these
 * logs.
 */
const otherDocument: DocumentRead = {
  ...appDocument,
  id: 'document-3',
  filename: 'controls.pdf',
  updated_at: '2026-06-16T00:00:00Z',
};
const uploadedDocument: DocumentRead = {
  ...appDocument,
  id: 'document-uploaded',
  filename: 'uploaded.pdf',
};
const uploadedDraft: QuestionDraftRead = {
  ...editableAppQuestion,
  id: 'draft-uploaded',
  document_id: uploadedDocument.id,
  question: 'Which control was uploaded last?',
};

interface FakeServer {
  documents: Record<string, DocumentRead[]>;
  drafts: Record<string, QuestionDraftRead[]>;
}

describe('Build route draft reloads', () => {
  let fixture: ComponentFixture<App>;
  let http: HttpTestingController;
  let log: string[];
  let server: FakeServer;

  const recordRequests: HttpInterceptorFn = (request, next) => {
    log.push(`${request.method} ${pathOf(request.url)}`);
    return next(request);
  };

  beforeEach(() => {
    localStorage.clear();
    log = [];
    server = {
      documents: {
        [appProject.id]: [appDocument, otherDocument],
        [secondAppProject.id]: [secondAppDocument],
      },
      drafts: {
        [appProject.id]: [editableAppQuestion],
        [secondAppProject.id]: [],
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        log.push(`SSE ${pathOf(String(input))}`);
        return new Promise<Response>(() => undefined);
      }),
    );

    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideHttpClient(
          withInterceptorsFromDi(),
          withInterceptors([recordRequests]),
        ),
        {
          provide: HTTP_INTERCEPTORS,
          useClass: CertPrepAuthInterceptor,
          multi: true,
        },
        provideHttpClientTesting(),
        provideRouter(appRoutes),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    fixture?.destroy();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  async function openBuild(): Promise<void> {
    fixture = TestBed.createComponent(App);
    fixture.autoDetectChanges();
    await TestBed.inject(Router).navigateByUrl('/build');
    await drain();
  }

  /** Answers every open request until the app stops issuing new ones. */
  async function drain(
    hold: (request: TestRequest) => boolean = () => false,
  ): Promise<TestRequest[]> {
    const held: TestRequest[] = [];
    for (let round = 0; round < 40; round += 1) {
      await settle();
      const open = http
        .match(() => true)
        .filter((request) => !request.cancelled);
      if (open.length === 0) {
        break;
      }
      for (const request of open) {
        if (hold(request)) {
          held.push(request);
        } else {
          respond(request);
        }
      }
    }
    await settle();
    return held;
  }

  async function settle(): Promise<void> {
    for (let pass = 0; pass < 4; pass += 1) {
      TestBed.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  function respond(request: TestRequest): void {
    const { method } = request.request;
    const path = pathOf(request.request.url);
    const project = /^\/projects\/([^/]+)/.exec(path)?.[1] ?? '';
    const documents = server.documents[project] ?? [];
    const routes: [RegExp, () => unknown][] = [
      [/^GET \/health$/, () => backendHealth()],
      [/^GET \/llm\/health$/, () => availableLlmHealth()],
      [/^GET \/runtime\/requirements$/, () => ({ items: [] })],
      [/^GET \/projects$/, () => ({ items: [appProject, secondAppProject] })],
      [/^GET \/projects\/[^/]+\/documents$/, () => ({ items: documents })],
      [
        /^POST \/projects\/[^/]+\/documents$/,
        () => {
          server.documents[project] = [uploadedDocument, ...documents];
          server.drafts[project] = [uploadedDraft];
          return uploadedDocument;
        },
      ],
      [
        /^GET \/projects\/[^/]+\/documents\/[^/]+$/,
        () => documents.find((document) => path.endsWith(`/${document.id}`)),
      ],
      [
        /^GET \/projects\/[^/]+\/documents\/[^/]+\/chunks$/,
        () => ({ items: [] }),
      ],
      [
        /^GET \/projects\/[^/]+\/documents\/[^/]+\/draft-jobs$/,
        () => ({ items: [] }),
      ],
      [
        /^GET \/projects\/[^/]+\/question-drafts$/,
        () => ({ items: server.drafts[project] ?? [] }),
      ],
      [/^GET \/projects\/[^/]+\/wrong-answers$/, () => ({ items: [] })],
      [
        /^GET \/projects\/[^/]+\/wrong-answers\/summary$/,
        () => emptyWrongAnswerSummary(),
      ],
      [/^GET \/projects\/[^/]+\/practice-sessions$/, () => ({ items: [] })],
    ];
    const route = routes.find(([pattern]) => pattern.test(`${method} ${path}`));
    const body = route?.[1]();
    if (body === undefined) {
      request.flush(null, { status: 404, statusText: 'Not Found' });
      return;
    }
    request.flush(body as Parameters<TestRequest['flush']>[0]);
  }

  function draftRequests(): string[] {
    return log.filter((entry) => entry.endsWith('/question-drafts'));
  }

  function sourcePanel(): HTMLElement {
    return fixture.nativeElement.querySelector('app-source-import-panel');
  }

  function draftPanelText(): string {
    return (
      fixture.nativeElement.querySelector('app-draft-review-panel')
        ?.textContent ?? ''
    );
  }

  async function selectDocument(documentId: string): Promise<void> {
    const select = sourcePanel().querySelector(
      'app-source-document-status select',
    ) as HTMLSelectElement;
    select.value = documentId;
    select.dispatchEvent(new Event('change'));
    await drain();
  }

  async function uploadFile(): Promise<TestRequest[]> {
    const input = sourcePanel().querySelector(
      '#sourceFiles',
    ) as HTMLInputElement;
    const file = new File(['%PDF-1.7'], uploadedDocument.filename, {
      type: 'application/pdf',
    });
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    });
    input.dispatchEvent(new Event('change'));
    await drain();
    buttonByText(sourcePanel(), 'Upload files')?.click();
    return drain(
      (request) =>
        request.request.method === 'POST' &&
        pathOf(request.request.url).endsWith('/documents'),
    );
  }

  function selectProject(name: string): Promise<TestRequest[]> {
    buttonByText(
      fixture.nativeElement.querySelector('app-project-rail'),
      name,
    )?.click();
    return drain();
  }

  it('a. loads the drafts on open and again when the latest document becomes active', async () => {
    await openBuild();

    expect(log).toEqual([
      'GET /projects',
      'GET /health',
      'GET /llm/health',
      'GET /llm/provider-selection',
      'GET /runtime/requirements',
      'GET /projects/project-1/documents',
      'GET /projects/project-1/question-drafts',
      'GET /projects/project-1/wrong-answers',
      'GET /projects/project-1/wrong-answers/summary',
      'GET /projects/project-1/practice-sessions',
      'GET /projects/project-1/documents/document-1',
      'GET /projects/project-1/documents/document-1/chunks',
      'GET /projects/project-1/question-drafts',
    ]);
    expect(draftRequests()).toHaveLength(2);
    expect(draftPanelText()).toContain(editableAppQuestion.question);
  });

  it('b. reloads the drafts when an upload finishes after the first drafts query returned empty', async () => {
    server.documents[appProject.id] = [];
    server.drafts[appProject.id] = [];
    await openBuild();
    expect(log).toEqual([
      'GET /projects',
      'GET /health',
      'GET /llm/health',
      'GET /llm/provider-selection',
      'GET /runtime/requirements',
      'GET /projects/project-1/documents',
      'GET /projects/project-1/question-drafts',
      'GET /projects/project-1/wrong-answers',
      'GET /projects/project-1/wrong-answers/summary',
      'GET /projects/project-1/practice-sessions',
    ]);
    log = [];

    const heldUploads = await uploadFile();

    expect(heldUploads).toHaveLength(1);
    expect(log).toEqual([
      'POST /projects/project-1/documents',
      'GET /projects/project-1/question-drafts',
    ]);
    expect(draftPanelText()).toContain('No questions are ready yet.');
    log = [];

    heldUploads.forEach((request) => respond(request));
    await drain();

    expect(log).toEqual([
      'GET /projects/project-1/documents/document-uploaded',
      'GET /projects/project-1/documents/document-uploaded/chunks',
      'GET /projects/project-1/question-drafts',
      'GET /projects/project-1/documents/document-uploaded',
      'GET /projects/project-1/documents/document-uploaded/chunks',
    ]);
    expect(draftRequests()).toHaveLength(1);
    expect(draftPanelText()).toContain(uploadedDraft.question);
    expect(draftPanelText()).not.toContain('No questions are ready yet.');
  });

  it('c. reloads the drafts once when the learner selects a different document', async () => {
    await openBuild();
    log = [];

    await selectDocument(otherDocument.id);

    expect(log).toEqual([
      'GET /projects/project-1/documents/document-3',
      'GET /projects/project-1/documents/document-3/chunks',
      'GET /projects/project-1/question-drafts',
    ]);
    expect(draftRequests()).toHaveLength(1);
  });

  it('d. reloads the drafts when the learner re-selects the same document', async () => {
    await openBuild();
    log = [];

    await selectDocument(appDocument.id);

    expect(log).toEqual([
      'GET /projects/project-1/documents/document-1',
      'GET /projects/project-1/documents/document-1/chunks',
      'GET /projects/project-1/question-drafts',
    ]);
    expect(draftRequests()).toHaveLength(1);
  });

  it('e. loads the drafts on a project switch and again when its latest document becomes active', async () => {
    await openBuild();
    log = [];

    await selectProject(secondAppProject.name);

    expect(log).toEqual([
      'GET /projects/project-2/documents',
      'GET /projects/project-2/question-drafts',
      'GET /projects/project-2/wrong-answers',
      'GET /projects/project-2/wrong-answers/summary',
      'GET /projects/project-2/practice-sessions',
      'GET /projects/project-2/documents/document-2',
      'GET /projects/project-2/documents/document-2/chunks',
      'GET /projects/project-2/question-drafts',
    ]);
    expect(draftRequests()).toHaveLength(2);
  });
});

function pathOf(url: string): string {
  return new URL(url, 'http://cert-prep.test').pathname;
}
