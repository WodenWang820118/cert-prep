import { createHash } from 'node:crypto';

import {
  normalizeOcrText,
  type OcrActualPage,
  type OcrTruthEvaluation,
  type OcrTruthManifest,
} from './ocr-truth-contract.mts';

export const OCR_NORMALIZATION_VERSION = 'nfkc-whitespace-v1' as const;

export type OcrCerMode = 'anchor_only' | 'full_reference';

export interface PrivacySafeOcrSemanticEvidence {
  readonly status: 'passed';
  readonly cerThreshold: number;
  readonly cer: number;
  readonly cerMode: OcrCerMode;
  readonly normalizationVersion: typeof OCR_NORMALIZATION_VERSION;
  readonly referenceNormalizedSha256: string;
  readonly outputNormalizedSha256: string;
  readonly expectedAnchorCount: number;
  readonly matchedAnchorCount: number;
  readonly missingAnchorCount: number;
  readonly pages: readonly PrivacySafeOcrPageEvidence[];
}

export interface PrivacySafeOcrPageEvidence {
  readonly pageNumber: number;
  readonly cer: number;
  readonly referenceNormalizedSha256: string;
  readonly outputNormalizedSha256: string;
  readonly expectedAnchorCount: number;
  readonly matchedAnchorCount: number;
  readonly missingAnchorCount: number;
}

export function serializePrivacySafeOcrSemanticEvidence(input: {
  readonly truth: OcrTruthManifest;
  readonly evaluation: OcrTruthEvaluation;
  readonly actualPages: readonly OcrActualPage[];
}): PrivacySafeOcrSemanticEvidence {
  if (input.evaluation.status !== 'passed') fail('OCR semantic evidence requires a passed evaluation.');
  if (!Number.isFinite(input.evaluation.cerThreshold) || input.evaluation.cerThreshold < 0) fail('OCR semantic evidence threshold was invalid.');
  const expectedPages = input.truth.pages;
  const actualByPage = new Map(input.actualPages.map((page) => [page.pageNumber, page]));
  const evaluationByPage = new Map(input.evaluation.pages.map((page) => [page.pageNumber, page]));
  if (actualByPage.size !== expectedPages.length || evaluationByPage.size !== expectedPages.length) fail('OCR semantic evidence page count was invalid.');
  if (input.evaluation.criticalAnchorsMissing.length > 0) fail('OCR semantic evidence contained missing anchors.');

  const pages: PrivacySafeOcrPageEvidence[] = [];
  let expectedAnchorCount = 0;
  let matchedAnchorCount = 0;
  for (const expectedPage of expectedPages) {
    const actualPage = actualByPage.get(expectedPage.pageNumber);
    const evaluatedPage = evaluationByPage.get(expectedPage.pageNumber);
    if (!actualPage || !evaluatedPage) fail('OCR semantic evidence page identity was invalid.');
    if (evaluatedPage.criticalAnchorsMatched.length !== expectedPage.criticalAnchors.length) fail('OCR semantic evidence anchor counts did not match.');
    const expectedCount = expectedPage.criticalAnchors.length;
    const matchedCount = evaluatedPage.criticalAnchorsMatched.length;
    expectedAnchorCount += expectedCount;
    matchedAnchorCount += matchedCount;
    pages.push({
      pageNumber: expectedPage.pageNumber,
      cer: finiteCer(evaluatedPage.cer),
      referenceNormalizedSha256: sha256(normalizeOcrText(expectedPage.text)),
      outputNormalizedSha256: sha256(normalizeOcrText(actualPage.text)),
      expectedAnchorCount: expectedCount,
      matchedAnchorCount: matchedCount,
      missingAnchorCount: expectedCount - matchedCount,
    });
  }
  const missingAnchorCount = expectedAnchorCount - matchedAnchorCount;
  if (missingAnchorCount > 0 || matchedAnchorCount !== expectedAnchorCount) fail('OCR semantic evidence anchor counts did not pass.');
  const cerMode: OcrCerMode = input.truth.anchorOnly === true ? 'anchor_only' : 'full_reference';
  const cer = finiteCer(input.evaluation.cer);
  if (cer > input.evaluation.cerThreshold) fail('OCR semantic evidence CER exceeded its threshold.');
  if (cerMode === 'anchor_only' && cer !== 0) fail('Anchor-only OCR semantic evidence must retain its zero CER sentinel.');
  const referenceText = expectedPages.map((page) => normalizeOcrText(page.text)).join('\n');
  const outputText = expectedPages.map((page) => normalizeOcrText(actualByPage.get(page.pageNumber)?.text ?? '')).join('\n');
  return {
    status: 'passed',
    cerThreshold: input.evaluation.cerThreshold,
    cer,
    cerMode,
    normalizationVersion: OCR_NORMALIZATION_VERSION,
    referenceNormalizedSha256: sha256(referenceText),
    outputNormalizedSha256: sha256(outputText),
    expectedAnchorCount,
    matchedAnchorCount,
    missingAnchorCount,
    pages,
  };
}

function finiteCer(value: number): number {
  if (!Number.isFinite(value) || value < 0) fail('OCR semantic evidence CER was invalid.');
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fail(message: string): never {
  throw new Error(message);
}
