import { TestBed } from '@angular/core/testing';
import { ReviewDisplayService } from './review-display.service';

describe('ReviewDisplayService', () => {
  let service: ReviewDisplayService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ReviewDisplayService);
  });

  it('resolves document labels with a stable fallback', () => {
    const documents = [{ id: 'document-1', filename: 'guide.pdf' }];

    expect(service.documentLabel(documents, 'document-1')).toBe('guide.pdf');
    expect(service.documentLabel(documents, 'missing')).toBe('missing');
    expect(service.documentLabel(documents, null)).toBeNull();
    expect(service.requiredDocumentLabel(documents, null)).toBe(
      'No source document',
    );
  });

  it('formats page and review date labels', () => {
    expect(service.pageLabel(3)).toBe('Page 3');
    expect(service.pageLabel(null)).toBe('Page n/a');
    expect(service.reviewDateLabel('2026-07-23T10:00:00Z')).toBe('2026-07-23');
    expect(service.reviewDateLabel(null)).toBe('None');
  });
});
