import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import { SourceAudioPreviewService } from './source-audio-preview.service';

describe('SourceAudioPreviewService', () => {
  const api = {
    getDocumentAudioSource: vi.fn(),
  };
  let service: SourceAudioPreviewService;
  let objectUrlCounter = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    objectUrlCounter = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(
      () => `blob:audio-preview-${++objectUrlCounter}`,
    );
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    TestBed.configureTestingModule({
      providers: [
        SourceAudioPreviewService,
        { provide: CERT_PREP_API, useValue: api },
      ],
    });
    service = TestBed.inject(SourceAudioPreviewService);
  });

  afterEach(() => {
    service.destroy();
    vi.restoreAllMocks();
  });

  it('replaces the object URL when the active document changes', () => {
    const firstRequest = of(new Blob(['first'], { type: 'audio/mpeg' }));
    const secondRequest = new Subject<Blob>();
    api.getDocumentAudioSource
      .mockReturnValueOnce(firstRequest)
      .mockReturnValueOnce(secondRequest);

    service.load('project-1', 'audio-1');
    expect(service.state()).toEqual({
      url: 'blob:audio-preview-1',
      loading: false,
      error: null,
    });

    service.load('project-2', 'audio-2');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:audio-preview-1');

    expect(service.state().url).toBeNull();
    secondRequest.next(new Blob(['second'], { type: 'audio/mpeg' }));
    expect(service.state().url).toBe('blob:audio-preview-2');
  });

  it('aborts a pending request and ignores its stale response after a context switch', () => {
    const firstRequest = new Subject<Blob>();
    const secondRequest = new Subject<Blob>();
    api.getDocumentAudioSource
      .mockReturnValueOnce(firstRequest)
      .mockReturnValueOnce(secondRequest);

    service.load('project-1', 'audio-1');
    const firstSignal = api.getDocumentAudioSource.mock.calls[0][2].signal as AbortSignal;
    service.load('project-2', 'audio-2');
    expect(firstSignal.aborted).toBe(true);

    firstRequest.next(new Blob(['stale'], { type: 'audio/mpeg' }));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    secondRequest.next(new Blob(['current'], { type: 'audio/mpeg' }));
    expect(service.state().url).toBe('blob:audio-preview-1');
  });

  it('exposes a retry after a failed authenticated source request', () => {
    api.getDocumentAudioSource
      .mockReturnValueOnce(throwError(() => new Error('network down')))
      .mockReturnValueOnce(of(new Blob(['retry'], { type: 'audio/mpeg' })));

    service.load('project-1', 'audio-1');
    expect(service.state()).toEqual({
      url: null,
      loading: false,
      error: 'The source audio could not be loaded.',
    });

    service.retry();
    expect(api.getDocumentAudioSource).toHaveBeenCalledTimes(2);
    expect(service.state().url).toBe('blob:audio-preview-1');
  });

  it('aborts an active request on destroy and ignores a late response', () => {
    const pendingRequest = new Subject<Blob>();
    api.getDocumentAudioSource.mockReturnValue(pendingRequest);
    service.load('project-1', 'audio-1');
    const signal = api.getDocumentAudioSource.mock.calls[0][2].signal as AbortSignal;

    service.destroy();
    expect(signal.aborted).toBe(true);
    pendingRequest.next(new Blob(['late'], { type: 'audio/mpeg' }));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('revokes the current object URL on destroy', () => {
    api.getDocumentAudioSource.mockReturnValue(of(new Blob(['ready'])));
    service.load('project-1', 'audio-1');
    expect(service.state().url).toBe('blob:audio-preview-1');
    service.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:audio-preview-1');
  });
});
