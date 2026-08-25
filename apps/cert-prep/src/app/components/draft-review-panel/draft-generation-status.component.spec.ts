import { TestBed } from '@angular/core/testing';
import type {
  DraftGenerationAction,
  DraftGenerationStatusViewModel,
} from './draft-review-panel.contracts';
import { DraftGenerationStatusComponent } from './draft-generation-status.component';

describe('DraftGenerationStatusComponent', () => {
  const model: DraftGenerationStatusViewModel = {
    message: 'Source is ready. Generate questions when you are ready.',
    tone: 'neutral',
    canGenerate: true,
    generateBusy: false,
    canRetry: true,
    retryBusy: false,
    canCancel: true,
    cancelBusy: false,
    reviewEvidence: [],
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [DraftGenerationStatusComponent],
    });
  });

  it('emits one typed action output for each human generation control', () => {
    const fixture = TestBed.createComponent(DraftGenerationStatusComponent);
    const actions: DraftGenerationAction[] = [];
    fixture.componentRef.setInput('model', model);
    fixture.componentInstance.action.subscribe((action) =>
      actions.push(action),
    );
    fixture.detectChanges();

    click(fixture.nativeElement, '[data-testid="draft-generate"]');
    click(fixture.nativeElement, '[data-testid="draft-retry"]');
    click(fixture.nativeElement, '[data-testid="draft-cancel"]');

    expect(actions).toEqual([
      { type: 'generate' },
      { type: 'retry' },
      { type: 'cancel' },
    ]);
  });
});

function click(root: HTMLElement, selector: string): void {
  (root.querySelector(selector) as HTMLButtonElement).click();
}
