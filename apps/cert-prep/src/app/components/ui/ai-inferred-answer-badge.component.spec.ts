import { TestBed } from '@angular/core/testing';
import { AiInferredAnswerBadgeComponent } from './ai-inferred-answer-badge.component';

const AI_INFERRED_ANSWER_DESCRIPTION =
  'The answer was inferred by the local AI model and has not been confirmed. Check it against the source.';

describe('AiInferredAnswerBadgeComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AiInferredAnswerBadgeComponent],
    });
  });

  it.each([
    ['ai_inferred', true],
    ['manual', false],
    ['pdf', false],
    [null, false],
    [undefined, false],
    ['legacy_custom', false],
  ] as const)('shows the badge only for an AI-inferred key (%s)', (source, shown) => {
    const fixture = TestBed.createComponent(AiInferredAnswerBadgeComponent);
    fixture.componentRef.setInput('source', source);
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector(
      '[data-testid="ai-inferred-answer"]',
    ) as HTMLElement | null;
    if (shown) {
      expect(badge?.textContent?.trim()).toBe('AI-inferred answer');
      expect(badge?.classList).toContain('workbench-tag');
      expect(badge?.getAttribute('aria-description')).toBe(
        AI_INFERRED_ANSWER_DESCRIPTION,
      );
      return;
    }

    expect(badge).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('AI-inferred answer');
  });
});
