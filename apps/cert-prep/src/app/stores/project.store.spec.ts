import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CERT_PREP_API } from '../constants/cert-prep-api.constants';
import type { ProjectRead } from '../contracts/api.contracts';
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

  it('loads projects from the API and exposes the selected project', () => {
    apiClient.listProjects.mockReturnValue(of({ items: [project] }));
    const store = TestBed.inject(ProjectStore);

    expect(store.projectsResource.status()).toBe('idle');
    expect(apiClient.listProjects).not.toHaveBeenCalled();

    store.load();
    store.select(project.id);
    TestBed.tick();

    expect(apiClient.listProjects).toHaveBeenCalledTimes(1);
    expect(store.projectsResource.status()).toBe('resolved');
    expect(store.projectsLoading()).toBe(false);
    expect(store.projects()).toEqual([project]);
    expect(store.selectedProject()).toEqual(project);
  });

  it('creates a trimmed project and resets form fields', () => {
    apiClient.createProject.mockReturnValue(of(project));
    const store = TestBed.inject(ProjectStore);
    store.projects.set([{ ...project, name: 'Old value' }]);
    store.setProjectName('  Security Study  ');
    store.setProjectDescription('  Practice set  ');

    store.createFromForm();
    TestBed.tick();

    expect(apiClient.createProject).toHaveBeenCalledWith(
      { name: 'Security Study', description: 'Practice set' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(store.projects()).toEqual([project]);
    expect(store.projectName()).toBe('');
    expect(store.projectDescription()).toBe('');
  });

  it('rejects blank project names without calling the API', () => {
    const store = TestBed.inject(ProjectStore);
    const operations = TestBed.inject(OperationStore);
    store.setProjectName('   ');

    store.createFromForm();

    expect(apiClient.createProject).not.toHaveBeenCalled();
    expect(operations.error()).toBe('Project name is required.');
  });
});
