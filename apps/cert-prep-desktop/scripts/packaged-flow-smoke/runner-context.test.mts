import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCEPTANCE_PRIVATE_SCREENSHOT_SELECTORS,
  ACCEPTANCE_REDACTION_STYLE,
} from './runner-context.mts';

test('acceptance screenshot privacy contract covers source, OCR, and generated content', () => {
  for (const selector of [
    '[aria-label="Selected source file upload status"]',
    '.workbench-preview-list',
    '[data-testid="draft-question-card"]',
    '.practice-question-card',
    '[data-testid="capture-result"]',
    'capture-workbench',
    '.capture-trial-status',
    '.capture-trial-result',
  ]) {
    assert.equal(
      (ACCEPTANCE_PRIVATE_SCREENSHOT_SELECTORS as readonly string[]).includes(selector),
      true,
    );
    assert.match(ACCEPTANCE_REDACTION_STYLE, new RegExp(escapeRegExp(selector), 'u'));
  }
  assert.match(ACCEPTANCE_REDACTION_STYLE, /\.workbench-file-name/u);
  assert.match(ACCEPTANCE_REDACTION_STYLE, /\.workbench-field select/u);
  assert.doesNotMatch(ACCEPTANCE_REDACTION_STYLE, /:text-/u);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
