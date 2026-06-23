import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import { ProjectRailComponent } from './project-rail.component';

describe('ProjectRailComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProjectRailComponent],
      providers: [{ provide: CERT_PREP_API, useValue: {} }],
    }).compileComponents();
  });

  it('renders the empty project list state', () => {
    const fixture = TestBed.createComponent(ProjectRailComponent);

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Projects');
    expect(fixture.nativeElement.textContent).toContain('No projects yet.');
  });
});
