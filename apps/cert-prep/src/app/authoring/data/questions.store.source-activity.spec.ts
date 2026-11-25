import { TestBed } from '@angular/core/testing';
import { NEVER, of } from 'rxjs';
import { CERT_PREP_API, CertPrepSseClient } from '../../core/data';
import type { SourceRead } from '../../core/domain';
import { ProjectStore } from '../../projects/data';
import { SourceImportStore } from '../../source-library/data';
import { provideCertPrepHttpResourceClientFake } from '../../core/testing';
import { QuestionsStore } from './questions.store';
import { sourceRead } from './questions.store.spec-helpers';

const latestSource: SourceRead = sourceRead();
const otherSource: SourceRead = sourceRead({
  id: 'source-2',
  filename: 'second.pdf',
});

describe('QuestionsStore reacting to source activity', () => {
  const apiClient = {
    listSources: vi.fn(),
    getSource: vi.fn(),
    listSourceChunks: vi.fn(),
    listSourceQuestionJobs: vi.fn(),
    listQuestions: vi.fn(),
    uploadSource: vi.fn(),
  };
  let questionsStore: QuestionsStore;
  let sourceImport: SourceImportStore;
  let load: ReturnType<typeof vi.fn<(projectId: string) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.listSources.mockReturnValue(
      of({ items: [latestSource, otherSource] }),
    );
    apiClient.getSource.mockImplementation(
      (_projectId: string, sourceId: string) =>
        of(sourceId === otherSource.id ? otherSource : latestSource),
    );
    apiClient.listSourceChunks.mockReturnValue(of({ items: [] }));
    apiClient.listSourceQuestionJobs.mockReturnValue(of({ items: [] }));
    apiClient.listQuestions.mockReturnValue(of({ items: [] }));
    apiClient.uploadSource.mockReturnValue(NEVER);
    TestBed.configureTestingModule({
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        { provide: CertPrepSseClient, useValue: { streamJson: vi.fn() } },
        provideCertPrepHttpResourceClientFake(apiClient),
      ],
    });

    const projects = TestBed.inject(ProjectStore);
    projects.projects.set([
      {
        id: 'project-1',
        name: 'JLPT N1',
        description: '',
        created_at: '2026-06-09T00:00:00Z',
        updated_at: '2026-06-09T00:00:00Z',
      },
    ]);
    projects.select('project-1');
    questionsStore = TestBed.inject(QuestionsStore);
    sourceImport = TestBed.inject(SourceImportStore);
    load = vi.fn<(projectId: string) => void>();
    vi.spyOn(questionsStore, 'load').mockImplementation(load);
    TestBed.tick();
  });

  function activateLatestSource(): void {
    sourceImport.loadLatestSource('project-1');
    TestBed.tick();
    load.mockClear();
  }

  it('reloads the questions when the latest source becomes active', () => {
    expect(load).not.toHaveBeenCalled();

    sourceImport.loadLatestSource('project-1');
    TestBed.tick();

    expect(sourceImport.activeSourceId()).toBe(latestSource.id);
    expect(load).toHaveBeenCalledExactlyOnceWith('project-1');
  });

  it('reloads the questions when the learner uploads', () => {
    activateLatestSource();
    sourceImport.chooseFiles([
      new File(['%PDF-1.7'], 'upload.pdf', { type: 'application/pdf' }),
    ]);
    TestBed.tick();
    load.mockClear();

    sourceImport.uploadSources();
    TestBed.tick();

    expect(apiClient.uploadSource).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledExactlyOnceWith('project-1');
  });

  it('reloads the questions when the learner selects another source', () => {
    activateLatestSource();

    sourceImport.selectSource(otherSource.id);
    TestBed.tick();

    expect(load).toHaveBeenCalledExactlyOnceWith('project-1');
  });

  it('reloads the questions when the learner selects the active source again', () => {
    activateLatestSource();

    sourceImport.selectSource(latestSource.id);
    TestBed.tick();
    sourceImport.selectSource(latestSource.id);
    TestBed.tick();

    expect(sourceImport.activeSourceId()).toBe(latestSource.id);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenNthCalledWith(2, 'project-1');
  });
});
