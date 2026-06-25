import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import { RandomQuizPage } from './random-quiz.page';

describe('RandomQuizPage', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RandomQuizPage],
      providers: [{ provide: CERT_PREP_API, useValue: {} }],
    }).compileComponents();
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
