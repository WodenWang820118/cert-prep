import type {
  DraftEditValuesLike,
  DraftGenerationMessage,
  DraftGenerationMessageInput,
  DraftQuestionEditorViewModel,
} from './draft-review-panel.contracts';

export function formatDraftGenerationMessage(
  input: DraftGenerationMessageInput,
): DraftGenerationMessage {
  if (!input.sourceReady) {
    return {
      message: 'Add a source file with text before generating questions.',
      tone: 'neutral',
    };
  }

  if (input.hasGenerationError && input.hasQuestions) {
    return {
      message:
        'Questions are ready to edit. Retry to prepare any missing questions.',
      tone: 'warning',
    };
  }

  if (input.hasGenerationError) {
    return {
      message: 'Could not prepare questions. Retry.',
      tone: 'danger',
    };
  }

  if (input.isPreparing) {
    return {
      message: 'Preparing questions...',
      tone: 'info',
    };
  }

  if (input.hasQuestions && input.hasReviewEvidence) {
    return {
      message: 'Questions are ready to edit. Check the source evidence below.',
      tone: 'warning',
    };
  }

  if (input.hasQuestions) {
    return {
      message: 'Questions are ready to edit.',
      tone: 'success',
    };
  }

  if (input.sourceProcessing) {
    return {
      message: 'Preparing source content...',
      tone: 'info',
    };
  }

  return {
    message: 'Source is ready. Generate questions when you are ready.',
    tone: 'neutral',
  };
}

export function formatDraftQuestionStatus(isPlayable: boolean): string {
  return isPlayable ? 'Ready for practice' : 'Needs review';
}

export function formatChoiceKey(index: number): string {
  let value = index + 1;
  let key = '';
  while (value > 0) {
    value -= 1;
    key = String.fromCharCode(65 + (value % 26)) + key;
    value = Math.floor(value / 26);
  }
  return key;
}

export function cloneDraftEdit(
  edit: DraftEditValuesLike,
): DraftQuestionEditorViewModel['edit'] {
  return {
    question: edit.question,
    choices: [...edit.choices],
    answer: edit.answer,
    rationale: edit.rationale,
  };
}
