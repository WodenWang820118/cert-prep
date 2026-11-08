import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../../core/data';
import type { ProjectRead } from '../../../core/domain';
import { ProjectStore } from '../../data';
import { ProjectRailComponent } from './project-rail.component';

describe('ProjectRailComponent', () => {
  const project: ProjectRead = {
    id: 'project-1',
    name: 'Security Study',
    description: 'Practice set',
    created_at: '2026-06-23T00:00:00Z',
    updated_at: '2026-06-23T00:00:00Z',
  };

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

  it('emits the clicked project for the shell to select', () => {
    TestBed.inject(ProjectStore).projects.set([project]);
    const fixture = TestBed.createComponent(ProjectRailComponent);
    const selected: string[] = [];
    fixture.componentInstance.projectSelected.subscribe((id) =>
      selected.push(id),
    );
    fixture.detectChanges();

    const item = fixture.nativeElement.querySelector(
      '.project-list-item',
    ) as HTMLButtonElement;
    item.click();

    expect(selected).toEqual(['project-1']);
  });

  it('emits a created project, then closes the create form', () => {
    const store = TestBed.inject(ProjectStore);
    const createFromForm = vi
      .spyOn(store, 'createFromForm')
      .mockImplementation((onCreated) => onCreated?.(project));
    store.setProjectName('Security Study');
    const fixture = TestBed.createComponent(ProjectRailComponent);
    const formOpenWhenSelected: boolean[] = [];
    fixture.componentInstance.projectSelected.subscribe(() => {
      formOpenWhenSelected.push(
        fixture.nativeElement.querySelector(
          '[data-testid="project-create-form"]',
        ) !== null,
      );
    });
    fixture.detectChanges();

    (
      fixture.nativeElement.querySelector(
        '.project-create-toggle',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector(
        '[data-testid="project-create-form"]',
      ) as HTMLFormElement
    ).dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    expect(createFromForm).toHaveBeenCalledTimes(1);
    // The shell selects the project before the form closes, as before.
    expect(formOpenWhenSelected).toEqual([true]);
    expect(
      fixture.nativeElement.querySelector(
        '[data-testid="project-create-form"]',
      ),
    ).toBeNull();
  });
});
