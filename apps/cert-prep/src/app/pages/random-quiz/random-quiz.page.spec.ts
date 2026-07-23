import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import { RandomQuizPage } from './random-quiz.page';

describe('RandomQuizPage', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [RandomQuizPage],
      providers: [{ provide: CERT_PREP_API, useValue: {} }],
    });
  });

  it('renders the random quiz practice page', () => {
    const fixture = TestBed.createComponent(RandomQuizPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Random Quiz');
    expect(fixture.nativeElement.textContent).toContain(
      'Select a project before starting practice.',
    );
  });
});
