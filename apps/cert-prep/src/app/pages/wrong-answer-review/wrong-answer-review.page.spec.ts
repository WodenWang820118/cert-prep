import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import { WrongAnswerReviewPage } from './wrong-answer-review.page';

describe('WrongAnswerReviewPage', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WrongAnswerReviewPage],
      providers: [{ provide: CERT_PREP_API, useValue: {} }],
    }).compileComponents();
  });

  it('renders the review page empty state', () => {
    const fixture = TestBed.createComponent(WrongAnswerReviewPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Wrong Answers');
    expect(fixture.nativeElement.textContent).toContain(
      'Wrong answers will appear here after a practice attempt needs review.',
    );
  });
});
