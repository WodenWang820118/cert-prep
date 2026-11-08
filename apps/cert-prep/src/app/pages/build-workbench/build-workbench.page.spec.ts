import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { CERT_PREP_API } from '../../core/data';
import { SourceImportPanelComponent } from '../../source-library/feature';
import { DraftReviewStore } from '../../stores/draft-review/draft-review.store';
import { BuildWorkbenchPage } from './build-workbench.page';

describe('BuildWorkbenchPage', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [BuildWorkbenchPage],
      providers: [{ provide: CERT_PREP_API, useValue: {} }, provideRouter([])],
    });
  });

  it('renders the build workbench source and draft regions', () => {
    const fixture = TestBed.createComponent(BuildWorkbenchPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Local Workspace');
    expect(fixture.nativeElement.textContent).toContain('Cert Prep');
    expect(fixture.nativeElement.textContent).toContain('Workspace ready');
    expect(fixture.nativeElement.textContent).toContain('Source files');
    expect(fixture.nativeElement.textContent).toContain('Exam Questions');
    expect(
      fixture.nativeElement.querySelector('[aria-label="Runtime status"]'),
    ).toBeNull();
  });

  it('reloads the project drafts when the source panel reports document activity', () => {
    const fixture = TestBed.createComponent(BuildWorkbenchPage);
    const load = vi
      .spyOn(TestBed.inject(DraftReviewStore), 'load')
      .mockImplementation(() => undefined);
    fixture.detectChanges();
    load.mockClear();

    const panel = fixture.debugElement.query(
      By.directive(SourceImportPanelComponent),
    ).componentInstance as SourceImportPanelComponent;
    panel.sourceDocumentActivity.emit('project-1');

    expect(load).toHaveBeenCalledExactlyOnceWith('project-1');
  });
});
