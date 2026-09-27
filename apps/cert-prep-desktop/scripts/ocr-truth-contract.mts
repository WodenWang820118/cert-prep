import { basename } from 'node:path';

export type OcrTruthKind = 'pdf' | 'image';

export interface OcrTruthPage {
  readonly pageNumber: number;
  readonly text: string;
  readonly criticalAnchors: readonly string[];
}

export interface OcrTruthManifest {
  readonly schemaVersion: 1;
  readonly sourceFileName: string;
  readonly kind: OcrTruthKind;
  readonly pages: readonly OcrTruthPage[];
  readonly cerThreshold: 0.01 | 0.03;
  /** Capture Runtime's privacy-safe expectation contract contains anchors only. */
  readonly anchorOnly?: true;
}

export interface OcrActualPage {
  readonly pageNumber: number;
  readonly text: string;
}

export type OcrTruthInvalidCode = 'empty_reference';

export class OcrTruthInvalidError extends Error {
  readonly code: OcrTruthInvalidCode;

  constructor(code: OcrTruthInvalidCode, message: string) {
    super(message);
    this.name = 'OcrTruthInvalidError';
    this.code = code;
  }
}

export interface OcrTruthPageEvaluation {
  readonly pageNumber: number;
  readonly cer: number;
  readonly criticalAnchorsMatched: readonly string[];
}

export interface OcrTruthEvaluation {
  readonly status: 'passed';
  readonly cer: number;
  readonly cerThreshold: 0.01 | 0.03;
  readonly pages: readonly OcrTruthPageEvaluation[];
  readonly criticalAnchorsMissing: readonly string[];
}

export function parseOcrTruthManifest(
  value: unknown,
  sourceFileName: string,
  kind: OcrTruthKind,
): OcrTruthManifest {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('OCR truth manifest schemaVersion must be 1.');
  }

  const expectedFileName = basename(sourceFileName);
  if (
    typeof value.sourceFileName !== 'string' ||
    value.sourceFileName.toLowerCase() !== expectedFileName.toLowerCase()
  ) {
    throw new Error(
      `OCR truth manifest sourceFileName must identify ${expectedFileName}.`,
    );
  }
  if (value.kind !== kind) {
    throw new Error(`OCR truth manifest kind must be ${kind}.`);
  }
  const expectedThreshold = kind === 'pdf' ? 0.01 : 0.03;
  if (value.cerThreshold !== expectedThreshold) {
    throw new Error(
      `OCR truth manifest cerThreshold must be ${expectedThreshold}.`,
    );
  }
  if (!Array.isArray(value.pages) || value.pages.length === 0) {
    throw new Error('OCR truth manifest pages must be non-empty.');
  }
  if (kind === 'image' && value.pages.length !== 1) {
    throw new Error('Image OCR truth manifests must contain exactly one page.');
  }

  const pages = value.pages.map((page, index) => parsePage(page, index));
  pages.forEach((page, index) => {
    if (page.pageNumber !== index + 1) {
      throw new Error(
        `OCR truth manifest pages must be contiguous starting at page 1 (found ${page.pageNumber}).`,
      );
    }
  });

  return {
    schemaVersion: 1,
    sourceFileName: expectedFileName,
    kind,
    pages,
    cerThreshold: expectedThreshold,
  };
}

/**
 * Adapt Capture Runtime's privacy-safe `rawTextIncludes` expectation to the
 * Cert acceptance truth seam. The source contract intentionally carries no
 * private full-page transcription, so evaluation is anchor-only and never
 * invents a CER reference from the selected document.
 */
export function parseOcrAnchorExpectation(
  value: unknown,
  sourceFileName: string,
  kind: OcrTruthKind,
): OcrTruthManifest {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('OCR anchor expectation schemaVersion must be 1.');
  }
  const expectedFileName = basename(sourceFileName);
  if (
    typeof value.sourceFileName !== 'string' ||
    value.sourceFileName.toLowerCase() !== expectedFileName.toLowerCase()
  ) {
    throw new Error(
      `OCR anchor expectation sourceFileName must identify ${expectedFileName}.`,
    );
  }
  if (!Array.isArray(value.rawTextIncludes) || value.rawTextIncludes.length === 0) {
    throw new Error('OCR anchor expectation rawTextIncludes must be non-empty.');
  }
  const anchors = value.rawTextIncludes.map((anchor, index) => {
    if (typeof anchor !== 'string' || normalizeOcrText(anchor).length === 0) {
      throw new Error(
        `OCR anchor expectation rawTextIncludes[${index}] must contain text.`,
      );
    }
    return anchor;
  });
  const normalizedAnchors = anchors.map(normalizeOcrText);
  if (new Set(normalizedAnchors).size !== normalizedAnchors.length) {
    throw new Error('OCR anchor expectation anchors must be unique after normalization.');
  }
  return {
    schemaVersion: 1,
    sourceFileName: expectedFileName,
    kind,
    pages: [
      {
        pageNumber: 1,
        text: anchors.join(' '),
        criticalAnchors: anchors,
      },
    ],
    cerThreshold: kind === 'pdf' ? 0.01 : 0.03,
    anchorOnly: true,
  };
}

export function evaluateOcrTruth(
  manifest: OcrTruthManifest,
  actualPages: readonly OcrActualPage[],
): OcrTruthEvaluation {
  const actualByPage = new Map<number, string>();
  for (const page of actualPages) {
    if (!Number.isInteger(page.pageNumber) || page.pageNumber < 1) {
      throw new Error('OCR actual page numbers must be positive integers.');
    }
    if (actualByPage.has(page.pageNumber)) {
      throw new Error(`OCR actual page ${page.pageNumber} was duplicated.`);
    }
    actualByPage.set(page.pageNumber, page.text);
  }

  const expectedPageNumbers = new Set(
    manifest.pages.map((page) => page.pageNumber),
  );
  if (
    actualByPage.size !== expectedPageNumbers.size ||
    [...actualByPage.keys()].some((pageNumber) => !expectedPageNumbers.has(pageNumber))
  ) {
    throw new Error(
      `OCR actual page count/numbers did not match the truth manifest (expected ${manifest.pages.length}).`,
    );
  }

  let totalDistance = 0;
  let totalReferenceLength = 0;
  const pageEvaluations: OcrTruthPageEvaluation[] = [];
  const criticalAnchorsMissing: string[] = [];
  for (const expectedPage of manifest.pages) {
    const actualText = actualByPage.get(expectedPage.pageNumber) ?? '';
    const reference = comparableText(expectedPage.text);
    if (reference.length === 0) {
      throw new OcrTruthInvalidError(
        'empty_reference',
        `OCR truth manifest page ${expectedPage.pageNumber} reference text must be non-empty.`,
      );
    }
    const actual = comparableText(actualText);
    const distance = manifest.anchorOnly ? 0 : levenshtein(reference, actual);
    const cer = distance / reference.length;
    totalDistance += distance;
    totalReferenceLength += reference.length;

    const normalizedActual = normalizeOcrText(actualText);
    const criticalAnchorsMatched: string[] = [];
    for (const anchor of expectedPage.criticalAnchors) {
      if (normalizedActual.includes(normalizeOcrText(anchor))) {
        criticalAnchorsMatched.push(anchor);
      } else {
        criticalAnchorsMissing.push(`page ${expectedPage.pageNumber}: ${anchor}`);
      }
    }
    pageEvaluations.push({
      pageNumber: expectedPage.pageNumber,
      cer,
      criticalAnchorsMatched,
    });
  }

  const aggregateCer = totalDistance / totalReferenceLength;
  const failedPage = pageEvaluations.find(
    (page) => page.cer > manifest.cerThreshold,
  );
  if (failedPage) {
    throw new Error(
      `OCR CER exceeded ${manifest.cerThreshold} on page ${failedPage.pageNumber}: ${failedPage.cer}.`,
    );
  }
  if (aggregateCer > manifest.cerThreshold) {
    throw new Error(
      `OCR aggregate CER exceeded ${manifest.cerThreshold}: ${aggregateCer}.`,
    );
  }
  if (criticalAnchorsMissing.length > 0) {
    throw new Error(
      `OCR critical anchors were missing: ${criticalAnchorsMissing.join(', ')}.`,
    );
  }

  return {
    status: 'passed',
    cer: aggregateCer,
    cerThreshold: manifest.cerThreshold,
    pages: pageEvaluations,
    criticalAnchorsMissing,
  };
}

export function normalizeOcrText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\s\p{White_Space}]+/gu, ' ')
    .trim();
}

function parsePage(value: unknown, index: number): OcrTruthPage {
  if (!isRecord(value)) {
    throw new Error(`OCR truth manifest page ${index + 1} must be an object.`);
  }
  if (
    typeof value.pageNumber !== 'number' ||
    !Number.isInteger(value.pageNumber) ||
    value.pageNumber < 1
  ) {
    throw new Error(`OCR truth manifest page ${index + 1} has an invalid pageNumber.`);
  }
  if (typeof value.text !== 'string') {
    throw new Error(`OCR truth manifest page ${index + 1} text must be non-empty.`);
  }
  if (normalizeOcrText(value.text).length === 0) {
    throw new OcrTruthInvalidError(
      'empty_reference',
      `OCR truth manifest page ${index + 1} reference text must be non-empty.`,
    );
  }
  if (!Array.isArray(value.criticalAnchors) || value.criticalAnchors.length === 0) {
    throw new Error(
      `OCR truth manifest page ${index + 1} criticalAnchors must be non-empty.`,
    );
  }
  const anchors = value.criticalAnchors.map((anchor) => {
    if (typeof anchor !== 'string' || normalizeOcrText(anchor).length === 0) {
      throw new Error(
        `OCR truth manifest page ${index + 1} criticalAnchors must contain text.`,
      );
    }
    return anchor;
  });
  const normalizedAnchors = anchors.map(normalizeOcrText);
  if (new Set(normalizedAnchors).size !== normalizedAnchors.length) {
    throw new Error(
      `OCR truth manifest page ${index + 1} criticalAnchors must be unique.`,
    );
  }
  return {
    pageNumber: value.pageNumber,
    text: value.text,
    criticalAnchors: anchors,
  };
}

function comparableText(value: string): readonly string[] {
  return [...normalizeOcrText(value)];
}

function levenshtein(reference: readonly string[], actual: readonly string[]): number {
  const previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let referenceIndex = 1; referenceIndex <= reference.length; referenceIndex += 1) {
    let diagonal = previous[0];
    previous[0] = referenceIndex;
    for (let actualIndex = 1; actualIndex <= actual.length; actualIndex += 1) {
      const above = previous[actualIndex];
      previous[actualIndex] =
        reference[referenceIndex - 1] === actual[actualIndex - 1]
          ? diagonal
          : 1 + Math.min(diagonal, above, previous[actualIndex - 1]);
      diagonal = above;
    }
  }
  return previous[actual.length];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
