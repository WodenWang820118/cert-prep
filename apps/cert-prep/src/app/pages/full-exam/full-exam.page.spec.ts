import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import { FullExamPage } from './full-exam.page';

describe('FullExamPage', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FullExamPage],
      providers: [{ provide: CERT_PREP_API, useValue: {} }],
    });
  });

  it('renders the full exam practice page', () => {
    const fixture = TestBed.createComponent(FullExamPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Full Exam');
    expect(fixture.nativeElement.textContent).toContain(
      'Select a project before starting practice.',
    );
  });
});
