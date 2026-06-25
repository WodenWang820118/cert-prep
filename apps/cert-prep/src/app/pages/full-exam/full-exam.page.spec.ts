import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import { FullExamPage } from './full-exam.page';

describe('FullExamPage', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FullExamPage],
      providers: [{ provide: CERT_PREP_API, useValue: {} }],
    }).compileComponents();
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
