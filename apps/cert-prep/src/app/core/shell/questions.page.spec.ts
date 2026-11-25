import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CERT_PREP_API } from '../data';
import { QuestionsPage } from './questions.page';

describe('QuestionsPage', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [QuestionsPage],
      providers: [{ provide: CERT_PREP_API, useValue: {} }, provideRouter([])],
    });
  });

  it('renders the source import and question regions', () => {
    const fixture = TestBed.createComponent(QuestionsPage);
    fixture.detectChanges();

    // The 'Local Workspace' eyebrow was removed (design audit, gate 54); the heading names the page.
    expect(fixture.nativeElement.textContent).not.toContain('Local Workspace');
    expect(fixture.nativeElement.textContent).toContain('Cert Prep');
    expect(fixture.nativeElement.textContent).toContain('Workspace ready');
    expect(fixture.nativeElement.textContent).toContain('Source files');
    expect(fixture.nativeElement.querySelector('app-questions-panel h2')?.textContent).toBe('Questions');
    expect(
      fixture.nativeElement.querySelector('[aria-label="Runtime status"]'),
    ).toBeNull();
  });
});
