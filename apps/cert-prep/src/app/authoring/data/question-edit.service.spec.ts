import { TestBed } from '@angular/core/testing';
import { QuestionEditService } from './question-edit.service';
import { questionFixture } from './questions.store.spec-helpers';

describe('QuestionEditService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
  });

  it('sends the edited answer as a manual answer key', () => {
    const service = TestBed.inject(QuestionEditService);
    const question = questionFixture({
      choices: ['1. First', '2. Second'],
      answer: '1. First',
      answer_key_source: 'ai_inferred',
    });

    const payload = service.updatePayload(question, {
      ...service.editFromQuestion(question),
      answer: '  2. Second  ',
    });

    expect(payload.answer).toBe('2. Second');
    expect(payload.answer_key_source).toBe('manual');
  });
});
