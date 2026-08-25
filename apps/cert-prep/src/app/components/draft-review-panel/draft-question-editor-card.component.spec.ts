import { TestBed } from '@angular/core/testing';
import type {
  DraftQuestionEditorAction,
  DraftQuestionEditorViewModel,
} from './draft-review-panel.contracts';
import { DraftQuestionEditorCardComponent } from './draft-question-editor-card.component';

describe('DraftQuestionEditorCardComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [DraftQuestionEditorCardComponent],
    });
  });

  it('renders question content, answer, rationale, and source evidence', () => {
    const fixture = TestBed.createComponent(DraftQuestionEditorCardComponent);
    fixture.componentRef.setInput('model', questionModel());
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Which answer is supported?');
    expect(text).toContain('The source supports A.');
    expect(text).toContain('Answer');
    expect(text).toContain('Page 3');
    expect(text).toContain('Relevant source excerpt.');
    expect(text).toContain('Ready for practice');
  });

  it('renders an editable card and emits typed edit actions', () => {
    const fixture = TestBed.createComponent(DraftQuestionEditorCardComponent);
    const actions: DraftQuestionEditorAction[] = [];
    fixture.componentRef.setInput('model', editingQuestionModel());
    fixture.componentInstance.action.subscribe((action) =>
      actions.push(action),
    );
    fixture.detectChanges();

    expect(
      (fixture.nativeElement.querySelector('input') as HTMLInputElement).value,
    ).toBe('Which answer is supported?');
    expect(
      (fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement)
        .value,
    ).toBe('The source supports A.');

    const questionInput = fixture.nativeElement.querySelector(
      'input',
    ) as HTMLInputElement;
    questionInput.value = 'Updated question';
    questionInput.dispatchEvent(new Event('input'));
    clickButton(fixture.nativeElement, 'Add choice');
    clickButton(fixture.nativeElement, 'Save');

    expect(actions).toEqual([
      { type: 'set-question', value: 'Updated question' },
      { type: 'add-choice' },
      { type: 'save' },
    ]);
  });
});

function questionModel(): DraftQuestionEditorViewModel {
  return {
    id: 'draft-1',
    fieldPrefix: 'question-draft-1',
    statusLabel: 'Ready for practice',
    question: 'Which answer is supported?',
    choices: ['A', 'B'],
    answer: 'A',
    rationale: 'The source supports A.',
    citationPage: 3,
    sourceExcerpt: 'Relevant source excerpt.',
    isEditing: false,
    edit: null,
    saveBusy: false,
  };
}

function editingQuestionModel(): DraftQuestionEditorViewModel {
  return {
    ...questionModel(),
    isEditing: true,
    edit: {
      question: 'Which answer is supported?',
      choices: ['A', 'B'],
      answer: 'A',
      rationale: 'The source supports A.',
    },
  };
}

function clickButton(root: HTMLElement, label: string): void {
  const button = Array.from(root.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  expect(button).not.toBeUndefined();
  button?.click();
}
