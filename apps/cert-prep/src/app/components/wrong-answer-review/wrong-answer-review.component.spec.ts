import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import { WrongAnswerReviewComponent } from './wrong-answer-review.component';

describe('WrongAnswerReviewComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WrongAnswerReviewComponent],
      providers: [{ provide: CERT_PREP_API, useValue: {} }],
    }).compileComponents();
  });

  it('renders the empty review state', () => {
    const fixture = TestBed.createComponent(WrongAnswerReviewComponent);

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Wrong Answers');
    expect(fixture.nativeElement.textContent).toContain(
      'Wrong answers will appear here after a practice attempt needs review.',
    );
  });
});
