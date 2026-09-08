import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';

import {
  ACCEPTANCE_PRIVATE_SCREENSHOT_SELECTORS,
  ACCEPTANCE_REDACTION_STYLE,
  acceptancePrivacyMasks,
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

test('acceptance masks the current Project source library card label', () => {
  const calls: Array<{
    kind: 'locator' | 'filter';
    selector?: string;
    hasText?: string | RegExp;
  }> = [];
  const locator = new RecordingLocator(calls);
  const page = {
    locator: (selector: string) => {
      calls.push({ kind: 'locator', selector });
      return locator;
    },
  } as unknown as Page;

  acceptancePrivacyMasks(page);

  assert.equal(
    calls.some(
      (call) =>
        call.kind === 'filter' &&
        call.hasText instanceof RegExp &&
        call.hasText.test('Project source library'),
    ),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.kind === 'filter' &&
        call.hasText === 'Project document library',
    ),
    false,
  );
});

class RecordingLocator {
  private readonly calls: Array<{
    kind: 'locator' | 'filter';
    selector?: string;
    hasText?: string | RegExp;
  }>;

  constructor(
    calls: Array<{
      kind: 'locator' | 'filter';
      selector?: string;
      hasText?: string | RegExp;
    }>,
  ) {
    this.calls = calls;
  }

  filter(options: { hasText?: string | RegExp }): this {
    this.calls.push({ kind: 'filter', hasText: options.hasText });
    return this;
  }

  locator(selector: string): this {
    this.calls.push({ kind: 'locator', selector });
    return this;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
