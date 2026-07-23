import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import { ProjectRailComponent } from './project-rail.component';

describe('ProjectRailComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ProjectRailComponent],
      providers: [{ provide: CERT_PREP_API, useValue: {} }],
    });
  });

  it('renders the empty project list state', () => {
    const fixture = TestBed.createComponent(ProjectRailComponent);

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Projects');
    expect(fixture.nativeElement.textContent).toContain('No projects yet.');
  });
});
