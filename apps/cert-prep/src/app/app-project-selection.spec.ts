import { TestBed } from '@angular/core/testing';
import { NEVER, of } from 'rxjs';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { appRoutes } from './app.routes';
import { CERT_PREP_API } from './cert-prep-api';
import {
  appDocument,
  appProject,
  editableAppQuestion,
  availableLlmHealth,
  availableOcrHealth,
  backendHealth,
  emptyWrongAnswerSummary,
  secondAppDocument,
  secondAppProject,
} from './app.spec-helpers';
import { ProjectStore } from './stores/project.store';
import { provideCertPrepHttpResourceClientFake } from './testing/cert-prep-http-resource-client.fake';

describe('App project selection', () => {
  let apiClient: ReturnType<typeof createApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    apiClient = createApiClient();

    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        provideCertPrepHttpResourceClientFake(apiClient),
        provideRouter(appRoutes),
      ],
    });
  });

  it('selects the last project on restart when it still exists', () => {
    localStorage.setItem('certPrepLastProjectId', secondAppProject.id);
    apiClient.listProjects.mockReturnValue(of({
      items: [appProject, secondAppProject],
    }));
    apiClient.listDocuments.mockImplementation((projectId: string) => of({
      items: [
        projectId === secondAppProject.id ? secondAppDocument : appDocument,
      ],
    }));
    apiClient.getDocument.mockImplementation((projectId: string) =>
      of(projectId === secondAppProject.id ? secondAppDocument : appDocument),
    );
    apiClient.listQuestionDrafts.mockReturnValue(of({ items: [] }));

    const fixture = TestBed.createComponent(App);
    const projects = TestBed.inject(ProjectStore);
    fixture.detectChanges();
    TestBed.tick();
    return vi.waitFor(() => {
      fixture.detectChanges();
      expect(projects.selectedProjectId()).toBe(secondAppProject.id);
      expect(localStorage.getItem('certPrepLastProjectId')).toBe(
        secondAppProject.id,
      );
      expect(apiClient.listDocuments).toHaveBeenCalledWith(
        secondAppProject.id,
      );
    });
  });

  it('selects the first project when the saved restart project is gone', () => {
    localStorage.setItem('certPrepLastProjectId', 'missing-project');
    apiClient.listProjects.mockReturnValue(of({
      items: [appProject, secondAppProject],
    }));

    const fixture = TestBed.createComponent(App);
    const projects = TestBed.inject(ProjectStore);
    fixture.detectChanges();

    TestBed.tick();
    return vi.waitFor(() => {
      fixture.detectChanges();
      expect(projects.selectedProjectId()).toBe(appProject.id);
      expect(localStorage.getItem('certPrepLastProjectId')).toBe(appProject.id);
    });
  });

  it('selects the first project while optional runtime health is still loading', () => {
    apiClient.ocrHealth.mockReturnValue(NEVER);

    const fixture = TestBed.createComponent(App);
    const projects = TestBed.inject(ProjectStore);
    fixture.detectChanges();

    TestBed.tick();
    return vi.waitFor(() => {
      fixture.detectChanges();
      expect(projects.selectedProjectId()).toBe(appProject.id);
      expect(apiClient.listDocuments).toHaveBeenCalledWith(appProject.id);
      expect(localStorage.getItem('certPrepLastProjectId')).toBe(appProject.id);
    });
  });
});

function createApiClient() {
  return {
    health: vi.fn().mockReturnValue(of(backendHealth())),
    llmHealth: vi.fn().mockReturnValue(of(availableLlmHealth())),
    ocrHealth: vi.fn().mockReturnValue(of(availableOcrHealth())),
    runtimeRequirements: vi.fn().mockReturnValue(of({ items: [] })),
    startRuntimeInstallation: vi.fn(),
    getRuntimeInstallation: vi.fn(),
    listProjects: vi.fn().mockReturnValue(of({ items: [appProject] })),
    listDocuments: vi.fn().mockReturnValue(of({ items: [appDocument] })),
    getDocument: vi.fn().mockReturnValue(of(appDocument)),
    listDocumentChunks: vi.fn().mockReturnValue(of({ items: [] })),
    listQuestionDrafts: vi.fn().mockReturnValue(of({ items: [editableAppQuestion] })),
    listWrongAnswers: vi.fn().mockReturnValue(of({ items: [] })),
    summarizeWrongAnswers: vi.fn().mockReturnValue(of(emptyWrongAnswerSummary())),
  };
}
