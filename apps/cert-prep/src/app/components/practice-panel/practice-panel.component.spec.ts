import { TestBed } from '@angular/core/testing';
import { appProject, editableAppQuestion } from '../../app.spec-helpers';
import { CERT_PREP_API } from '../../cert-prep-api';
import { DraftReviewStore } from '../../stores/draft-review/draft-review.store';
import { ProjectStore } from '../../stores/project.store';
import { PracticePanelComponent } from './practice-panel.component';

describe('PracticePanelComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PracticePanelComponent],
      providers: [{ provide: CERT_PREP_API, useValue: {} }],
    }).compileComponents();
  });

  it('renders the random quiz empty state', () => {
    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'random_draw');

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Random Quiz');
    expect(fixture.nativeElement.textContent).toContain(
      'Select a project before starting practice.',
    );
  });

  it('shows the effective random draw total before a session starts', () => {
    const projects = TestBed.inject(ProjectStore);
    const drafts = TestBed.inject(DraftReviewStore);
    projects.projects.set([appProject]);
    projects.select(appProject.id);
    drafts.drafts.set([editableAppQuestion]);

    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'random_draw');
    fixture.detectChanges();

    expect(metricValue(fixture.nativeElement, 'Draw Size')).toBe('1');
    expect(fixture.nativeElement.textContent).toContain('Question 1 of 1');
  });
});

function metricValue(root: ParentNode, label: string): string | null {
  const metric = Array.from(root.querySelectorAll('.practice-metrics div')).find(
    (item) => item.querySelector('dt')?.textContent?.trim() === label,
  );
  return metric?.querySelector('dd')?.textContent?.trim() ?? null;
}
