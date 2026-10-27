import { TestBed } from '@angular/core/testing';
import { DraftEditService } from './draft-edit.service';
import { questionDraft } from './draft-review.store.spec-helpers';

describe('DraftEditService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
  });

  it('sends the edited answer as a manual answer key', () => {
    const service = TestBed.inject(DraftEditService);
    const draft = questionDraft({
      choices: ['1. First', '2. Second'],
      answer: '1. First',
      answer_key_source: 'ai_inferred',
    });

    const payload = service.updatePayload(draft, {
      ...service.editFromDraft(draft),
      answer: '  2. Second  ',
    });

    expect(payload.answer).toBe('2. Second');
    expect(payload.answer_key_source).toBe('manual');
  });
});
