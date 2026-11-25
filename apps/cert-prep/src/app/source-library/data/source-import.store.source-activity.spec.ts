import { TestBed } from '@angular/core/testing';
import { NEVER, of } from 'rxjs';
import { CERT_PREP_API, CertPrepSseClient } from '../../core/data';
import type { SourceRead } from '../../core/domain';
import { ProjectStore } from '../../projects/data';
import { appSource, appProject } from '../../core/testing';
import { provideCertPrepHttpResourceClientFake } from '../../core/testing';
import { SourceImportStore } from './source-import.store';

const otherSource: SourceRead = {
  ...appSource,
  id: 'source-3',
  filename: 'controls.pdf',
};

describe('SourceImportStore source activity', () => {
  const apiClient = {
    listSources: vi.fn(),
    getSource: vi.fn(),
    listSourceChunks: vi.fn(),
    uploadSource: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.listSources.mockReturnValue(
      of({ items: [appSource, otherSource] }),
    );
    apiClient.getSource.mockImplementation(
      (_projectId: string, sourceId: string) =>
        of(sourceId === otherSource.id ? otherSource : appSource),
    );
    apiClient.listSourceChunks.mockReturnValue(of({ items: [] }));
    apiClient.uploadSource.mockReturnValue(NEVER);
    TestBed.configureTestingModule({
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        { provide: CertPrepSseClient, useValue: { streamJson: vi.fn() } },
        provideCertPrepHttpResourceClientFake(apiClient),
      ],
    });
  });

  function selectProject(): void {
    const projects = TestBed.inject(ProjectStore);
    projects.projects.set([appProject]);
    projects.select(appProject.id);
  }

  function storeWithActiveSource(): SourceImportStore {
    selectProject();
    const store = TestBed.inject(SourceImportStore);
    store.loadLatestSource(appProject.id);
    TestBed.tick();
    return store;
  }

  it('reports activity when the latest source becomes active', () => {
    selectProject();
    const store = TestBed.inject(SourceImportStore);
    TestBed.tick();
    expect(store.sourceActivity()).toBeNull();

    store.loadLatestSource(appProject.id);
    TestBed.tick();

    expect(store.activeSourceId()).toBe(appSource.id);
    expect(store.sourceActivity()).toEqual({ projectId: appProject.id });
  });

  it('reports a new activity when the learner uploads', () => {
    const store = storeWithActiveSource();
    store.chooseFiles([
      new File(['%PDF-1.7'], 'upload.pdf', { type: 'application/pdf' }),
    ]);
    TestBed.tick();
    const before = store.sourceActivity();

    store.uploadSources();

    expect(apiClient.uploadSource).toHaveBeenCalledTimes(1);
    expect(store.sourceActivity()).toEqual({ projectId: appProject.id });
    expect(store.sourceActivity()).not.toBe(before);
  });

  it('reports a new activity when the learner selects another source', () => {
    const store = storeWithActiveSource();
    const before = store.sourceActivity();

    store.selectSource(otherSource.id);

    expect(store.activeSourceId()).toBe(otherSource.id);
    expect(store.sourceActivity()).toEqual({ projectId: appProject.id });
    expect(store.sourceActivity()).not.toBe(before);
  });

  it('reports a new activity when the learner selects the active source again', () => {
    const store = storeWithActiveSource();
    const before = store.sourceActivity();

    store.selectSource(appSource.id);
    TestBed.tick();

    expect(store.activeSourceId()).toBe(appSource.id);
    expect(store.sourceActivity()).toEqual({ projectId: appProject.id });
    expect(store.sourceActivity()).not.toBe(before);
  });

  it('reports nothing without a selected project', () => {
    const store = TestBed.inject(SourceImportStore);

    store.uploadSources();
    store.selectSource(appSource.id);
    TestBed.tick();

    expect(store.sourceActivity()).toBeNull();
  });
});
