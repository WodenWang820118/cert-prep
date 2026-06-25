import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import { BuildWorkbenchPage } from './build-workbench.page';

describe('BuildWorkbenchPage', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BuildWorkbenchPage],
      providers: [{ provide: CERT_PREP_API, useValue: {} }],
    }).compileComponents();
  });

  it('renders the build workbench source and draft regions', () => {
    const fixture = TestBed.createComponent(BuildWorkbenchPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Cert Prep Workbench');
    expect(fixture.nativeElement.textContent).toContain('Source PDF');
    expect(fixture.nativeElement.textContent).toContain('Mock Exam Items');
  });
});
