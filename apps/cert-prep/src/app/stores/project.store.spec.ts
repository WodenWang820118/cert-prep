import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API, ProjectRead } from '../cert-prep-api';
import { OperationStore } from './operation.store';
import { ProjectStore } from './project.store';
import { provideCertPrepHttpResourceClientFake } from '../testing/cert-prep-http-resource-client.fake';

describe('ProjectStore', () => {
  const project: ProjectRead = {
    id: 'project-1',
    name: 'Security Study',
    description: 'Practice set',
    created_at: '2026-06-23T00:00:00Z',
    updated_at: '2026-06-23T00:00:00Z',
  };
  const apiClient = {
    createProject: vi.fn(),
    listProjects: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        provideCertPrepHttpResourceClientFake(apiClient),
      ],
    });
  });

  it('loads projects from the API and exposes the selected project', async () => {
    apiClient.listProjects.mockResolvedValue({ items: [project] });
    const store = TestBed.inject(ProjectStore);

    expect(store.projectsResource.status()).toBe('idle');
    expect(apiClient.listProjects).not.toHaveBeenCalled();

    store.load();
    store.select(project.id);
    await vi.waitFor(() => expect(store.projectsResource.status()).toBe('resolved'));

    expect(apiClient.listProjects).toHaveBeenCalledTimes(1);
    expect(store.projectsResource.status()).toBe('resolved');
    expect(store.projectsLoading()).toBe(false);
    expect(store.projects()).toEqual([project]);
    expect(store.selectedProject()).toEqual(project);
  });

  it('creates a trimmed project and resets form fields', async () => {
    apiClient.createProject.mockResolvedValue(project);
    const store = TestBed.inject(ProjectStore);
    store.projects.set([{ ...project, name: 'Old value' }]);
    store.setProjectName('  Security Study  ');
    store.setProjectDescription('  Practice set  ');

    const created = await store.createFromForm();

    expect(created).toEqual(project);
    expect(apiClient.createProject).toHaveBeenCalledWith({
      name: 'Security Study',
      description: 'Practice set',
    });
    expect(store.projects()).toEqual([project]);
    expect(store.projectName()).toBe('');
    expect(store.projectDescription()).toBe('');
  });

  it('rejects blank project names without calling the API', async () => {
    const store = TestBed.inject(ProjectStore);
    const operations = TestBed.inject(OperationStore);
    store.setProjectName('   ');

    const created = await store.createFromForm();

    expect(created).toBeNull();
    expect(apiClient.createProject).not.toHaveBeenCalled();
    expect(operations.error()).toBe('Project name is required.');
  });
});
