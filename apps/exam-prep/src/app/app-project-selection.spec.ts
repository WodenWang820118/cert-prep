import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { EXAM_PREP_API } from './exam-prep-api';
import {
  appDocument,
  appProject,
  editableAppQuestion,
  availableLlmHealth,
  availableOcrHealth,
  backendHealth,
  secondAppDocument,
  secondAppProject,
} from './app.spec-helpers';
import { ProjectStore } from './stores/project.store';

describe('App project selection', () => {
  let apiClient: ReturnType<typeof createApiClient>;

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    apiClient = createApiClient();

    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: EXAM_PREP_API, useValue: apiClient }],
    }).compileComponents();
  });

  it('selects the last project on restart when it still exists', async () => {
    localStorage.setItem('examPrepLastProjectId', secondAppProject.id);
    apiClient.listProjects.mockResolvedValue({
      items: [appProject, secondAppProject],
    });
    apiClient.listDocuments.mockImplementation(async (projectId: string) => ({
      items: [
        projectId === secondAppProject.id ? secondAppDocument : appDocument,
      ],
    }));
    apiClient.getDocument.mockImplementation(async (projectId: string) =>
      projectId === secondAppProject.id ? secondAppDocument : appDocument,
    );
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [] });

    const fixture = TestBed.createComponent(App);
    const projects = TestBed.inject(ProjectStore);
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(projects.selectedProjectId()).toBe(secondAppProject.id);
    });

    expect(localStorage.getItem('examPrepLastProjectId')).toBe(
      secondAppProject.id,
    );
    expect(apiClient.listDocuments).toHaveBeenCalledWith(secondAppProject.id);
  });

  it('selects the first project when the saved restart project is gone', async () => {
    localStorage.setItem('examPrepLastProjectId', 'missing-project');
    apiClient.listProjects.mockResolvedValue({
      items: [appProject, secondAppProject],
    });

    const fixture = TestBed.createComponent(App);
    const projects = TestBed.inject(ProjectStore);
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(projects.selectedProjectId()).toBe(appProject.id);
    });

    expect(localStorage.getItem('examPrepLastProjectId')).toBe(appProject.id);
  });

  it('selects the first project while optional runtime health is still loading', async () => {
    apiClient.ocrHealth.mockReturnValue(new Promise(() => undefined));

    const fixture = TestBed.createComponent(App);
    const projects = TestBed.inject(ProjectStore);
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(projects.selectedProjectId()).toBe(appProject.id);
    });

    expect(apiClient.listDocuments).toHaveBeenCalledWith(appProject.id);
    expect(localStorage.getItem('examPrepLastProjectId')).toBe(appProject.id);
  });
});

function createApiClient() {
  return {
    health: vi.fn().mockResolvedValue(backendHealth()),
    llmHealth: vi.fn().mockResolvedValue(availableLlmHealth()),
    ocrHealth: vi.fn().mockResolvedValue(availableOcrHealth()),
    runtimeRequirements: vi.fn().mockResolvedValue({ items: [] }),
    startRuntimeInstallation: vi.fn(),
    getRuntimeInstallation: vi.fn(),
    listProjects: vi.fn().mockResolvedValue({ items: [appProject] }),
    listDocuments: vi.fn().mockResolvedValue({ items: [appDocument] }),
    getDocument: vi.fn().mockResolvedValue(appDocument),
    listDocumentChunks: vi.fn().mockResolvedValue({ items: [] }),
    listQuestionDrafts: vi.fn().mockResolvedValue({ items: [editableAppQuestion] }),
    listWrongAnswers: vi.fn().mockResolvedValue({ items: [] }),
  };
}
