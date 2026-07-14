import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  validateResilienceEvidence,
  validateSessionRestartEvidence,
  type CandidateBinding,
  type EvidenceObservation,
  type ResilienceCheck,
} from './evidence-contract.mts';

export interface EvidenceArtifactReference {
  readonly passed: true;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface EvidenceEnvelopeOptions {
  readonly candidate: CandidateBinding;
  readonly acceptanceRunId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly observations: readonly EvidenceObservation[];
  readonly proof: Readonly<Record<string, unknown>>;
}

export function writeResilienceEvidence(
  root: string,
  check: ResilienceCheck,
  options: EvidenceEnvelopeOptions,
): EvidenceArtifactReference {
  const evidence = {
    schemaVersion: 2,
    check,
    passed: true,
    ...options,
  };
  validateResilienceEvidence(evidence, check, {
    candidate: options.candidate,
    acceptanceRunId: options.acceptanceRunId,
  });
  return writeEvidence(root, `cancellation/${check}.json`, evidence);
}

export function writeSessionRestartEvidence(
  root: string,
  options: EvidenceEnvelopeOptions,
): EvidenceArtifactReference {
  const evidence = {
    schemaVersion: 2,
    check: 'sessionRestart',
    passed: true,
    ...options,
  };
  validateSessionRestartEvidence(evidence, {
    candidate: options.candidate,
    acceptanceRunId: options.acceptanceRunId,
  });
  return writeEvidence(root, 'session-restart.json', evidence);
}

function writeEvidence(
  root: string,
  relativePath: string,
  evidence: unknown,
): EvidenceArtifactReference {
  const payload = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  const filePath = join(root, ...relativePath.split('/'));
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, payload, { flag: 'wx' });
  return {
    passed: true,
    path: relativePath,
    bytes: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'),
  };
}
