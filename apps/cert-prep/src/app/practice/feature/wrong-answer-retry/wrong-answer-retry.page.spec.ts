import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../../core/data';
import { WrongAnswerRetryPage } from './wrong-answer-retry.page';

describe('WrongAnswerRetryPage', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [WrongAnswerRetryPage],
      providers: [{ provide: CERT_PREP_API, useValue: {} }],
    });
  });

  it('renders the review page empty state', () => {
    const fixture = TestBed.createComponent(WrongAnswerRetryPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Wrong-answer retry');
    expect(fixture.nativeElement.textContent).toContain(
      'Wrong answers will appear here after a practice attempt needs review.',
    );
  });
});
