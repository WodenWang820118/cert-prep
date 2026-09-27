import assert from 'node:assert/strict';
import test from 'node:test';

import {
  serializePrivacySafeOcrSemanticEvidence,
} from './ocr-semantic-evidence.mts';

const privateAnchor = 'PRIVATE_ANCHOR_SHOULD_NEVER_BE_SERIALIZED';
const privateReference = 'PRIVATE_REFERENCE_TEXT_SHOULD_NEVER_BE_SERIALIZED';
const privateOutput = 'PRIVATE_OUTPUT_TEXT_SHOULD_NEVER_BE_SERIALIZED';

function truth(anchorOnly = true) {
  return {
    schemaVersion: 1 as const,
    sourceFileName: 'fixture.jpeg',
    kind: 'image' as const,
    anchorOnly: anchorOnly ? (true as const) : undefined,
    cerThreshold: 0.03 as const,
    pages: [{ pageNumber: 1, text: privateReference, criticalAnchors: [privateAnchor] }],
  };
}

function evaluation(cer = 0) {
  return {
    status: 'passed' as const,
    cer,
    cerThreshold: 0.03 as const,
    pages: [{ pageNumber: 1, cer, criticalAnchorsMatched: [privateAnchor] }],
    criticalAnchorsMissing: [] as string[],
  };
}

test('serializes anchor-only OCR as count/hash evidence without literal private data', () => {
  const evidence = serializePrivacySafeOcrSemanticEvidence({
    truth: truth(),
    evaluation: evaluation(),
    actualPages: [{ pageNumber: 1, text: privateOutput }],
  });
  const serialized = JSON.stringify(evidence);

  assert.equal(evidence.cerMode, 'anchor_only');
  assert.equal(evidence.cer, 0);
  assert.equal(evidence.expectedAnchorCount, 1);
  assert.equal(evidence.matchedAnchorCount, 1);
  assert.equal(evidence.missingAnchorCount, 0);
  assert.match(evidence.normalizationVersion, /nfkc/iu);
  assert.doesNotMatch(serialized, /PRIVATE_/u);
  for (const forbidden of [
    'expectedTextIncludes',
    'textAnchorsMatched',
    'criticalAnchorsMatched',
    'criticalAnchorsMissing',
    'referenceText',
    'outputText',
    'localPath',
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});
test('uses declared NFKC whitespace hashes for full-reference OCR and rejects missing anchors', () => {
  const fullTruth = truth(false);
  const fullEvaluation = evaluation(0.01);
  const evidence = serializePrivacySafeOcrSemanticEvidence({
    truth: fullTruth,
    evaluation: fullEvaluation,
    actualPages: [{ pageNumber: 1, text: 'PRIVATE_REFERENCE_TEXT_SHOULD_NEVER_BE_SERIALIZED' }],
  });

  assert.equal(evidence.cerMode, 'full_reference');
  assert.equal(evidence.cer, 0.01);
  assert.match(evidence.referenceNormalizedSha256, /^[a-f0-9]{64}$/u);
  assert.match(evidence.outputNormalizedSha256, /^[a-f0-9]{64}$/u);
  assert.equal(evidence.pages[0]?.expectedAnchorCount, 1);

  assert.throws(
    () => serializePrivacySafeOcrSemanticEvidence({
      truth: fullTruth,
      evaluation: { ...fullEvaluation, criticalAnchorsMissing: [privateAnchor] },
      actualPages: [{ pageNumber: 1, text: privateOutput }],
    }),
    /anchor/u,
  );
});
