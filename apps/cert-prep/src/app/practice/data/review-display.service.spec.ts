import { TestBed } from '@angular/core/testing';
import { ReviewDisplayService } from './review-display.service';

describe('ReviewDisplayService', () => {
  let service: ReviewDisplayService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ReviewDisplayService);
  });

  it('resolves source labels with a stable fallback', () => {
    const sources = [{ id: 'source-1', filename: 'guide.pdf' }];

    expect(service.sourceLabel(sources, 'source-1')).toBe('guide.pdf');
    expect(service.sourceLabel(sources, 'missing')).toBe('missing');
    expect(service.sourceLabel(sources, null)).toBeNull();
    expect(service.requiredSourceLabel(sources, null)).toBe(
      'No source',
    );
  });

  it('formats page and review date labels', () => {
    expect(service.pageLabel(3)).toBe('Page 3');
    expect(service.pageLabel(null)).toBe('Page n/a');
    expect(service.reviewDateLabel('2026-07-23T10:00:00Z')).toBe('2026-07-23');
    expect(service.reviewDateLabel(null)).toBe('None');
  });
});
