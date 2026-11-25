import { TestBed } from '@angular/core/testing';
import type {
  QuestionGenerationAction,
  QuestionGenerationStatusViewModel,
} from '../../domain';
import { QuestionGenerationStatusComponent } from './question-generation-status.component';

describe('QuestionGenerationStatusComponent', () => {
  const model: QuestionGenerationStatusViewModel = {
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
      imports: [QuestionGenerationStatusComponent],
    });
  });

  it('emits one typed action output for each human generation control', () => {
    const fixture = TestBed.createComponent(QuestionGenerationStatusComponent);
    const actions: QuestionGenerationAction[] = [];
    fixture.componentRef.setInput('model', model);
    fixture.componentInstance.action.subscribe((action) =>
      actions.push(action),
    );
    fixture.detectChanges();

    click(fixture.nativeElement, '[data-testid="question-generate"]');
    click(fixture.nativeElement, '[data-testid="question-retry"]');
    click(fixture.nativeElement, '[data-testid="question-cancel"]');

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
