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

  it('strips source ordinals in the choice list and answer while retaining letter labels', () => {
    const fixture = TestBed.createComponent(DraftQuestionEditorCardComponent);
    fixture.componentRef.setInput('model', {
      ...questionModel(), choices: ['１ からかって', '２ ためらって'], answer: '１ からかって',
    });
    fixture.detectChanges();

    const choices = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.workbench-choice-list li'));
    expect(choices.map((choice) => choice.textContent?.replace(/\s+/g, ''))).toEqual(['Aからかって', 'Bためらって']);
    expect(fixture.nativeElement.textContent).not.toContain('１ からかって');
    expect(fixture.nativeElement.querySelector('.is-answer app-icon')).not.toBeNull();
  });

  it('keeps original choice values in the editor and answer selector', () => {
    const fixture = TestBed.createComponent(DraftQuestionEditorCardComponent);
    const model = editingQuestionModel();
    fixture.componentRef.setInput('model', {
      ...model,
      edit: { ...model.edit, question: model.question, rationale: model.rationale, choices: ['1. First', '2. Second'], answer: '1. First' },
    });
    const actions: DraftQuestionEditorAction[] = [];
    fixture.componentInstance.action.subscribe((action) => actions.push(action));
    fixture.detectChanges();

    const selector = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    expect(selector.options[1].textContent?.trim()).toBe('First');
    expect(selector.options[1].value).toBe('1. First');
    expect((fixture.nativeElement.querySelector('fieldset input') as HTMLInputElement).value).toBe('1. First');
    selector.value = '2. Second';
    selector.dispatchEvent(new Event('change'));
    expect(actions).toEqual([{ type: 'set-answer', value: '2. Second' }]);
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
