import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CERT_PREP_API } from '../data';
import { BuildPage } from './build.page';

describe('BuildPage', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [BuildPage],
      providers: [{ provide: CERT_PREP_API, useValue: {} }, provideRouter([])],
    });
  });

  it('renders the build source and draft regions', () => {
    const fixture = TestBed.createComponent(BuildPage);
    fixture.detectChanges();

    // The 'Local Workspace' eyebrow was removed (design audit, gate 54); the heading names the page.
    expect(fixture.nativeElement.textContent).not.toContain('Local Workspace');
    expect(fixture.nativeElement.textContent).toContain('Cert Prep');
    expect(fixture.nativeElement.textContent).toContain('Workspace ready');
    expect(fixture.nativeElement.textContent).toContain('Source files');
    expect(fixture.nativeElement.textContent).toContain('Exam Questions');
    expect(
      fixture.nativeElement.querySelector('[aria-label="Runtime status"]'),
    ).toBeNull();
  });
});
