import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  HARDWARE_CANCELLATION_CHECKS,
  deriveReleaseIdentity,
  sha256File,
  writeJson,
} from './release-lib.ts';
import { verifyHardwareEvidence } from './verify-hardware-result.ts';

async function hardwareResult(plan, evidenceRoot, recording, recordingSha256) {
  const cancellation = {};
  const cancellationRoot = join(evidenceRoot, 'cancellation');
  mkdirSync(cancellationRoot, { recursive: true });
  for (const key of HARDWARE_CANCELLATION_CHECKS) {
    const path = join(cancellationRoot, `${key}.json`);
    writeJson(path, {
      schemaVersion: 1,
      check: key,
      passed: true,
      candidateId: 'e'.repeat(64),
      observations: [`${key} terminal state and residue were inspected`],
    });
    cancellation[key] = {
      passed: true,
      path: `cancellation/${key}.json`,
      bytes: statSync(path).size,
      sha256: await sha256File(path),
    };
  }
  return {
    schemaVersion: 1,
    version: plan.version,
    tag: plan.tag,
    commitSha: plan.commitSha,
    candidateId: 'e'.repeat(64),
    candidateShaVerified: true,
    harnessSha256: 'c'.repeat(64),
    cleanSnapshot: true,
    windowsMlProvider: 'windowsml',
    configuredProvider: 'fastflowlm',
    effectiveProvider: 'fastflowlm',
    configuredModel: 'qwen3.5:4b',
    effectiveModel: 'qwen3.5:4b',
    providerFallback: false,
    modelFallback: false,
    generationReadyAtStart: true,
    resourcesReleasedAtEnd: true,
    fullExamQuestionCountPositive: true,
    sessionRestartPassed: true,
    cancellation,
    processResidueCount: 0,
    pdfs: Array.from({ length: 4 }, (_, index) => ({
      name: `pdf-${index + 1}`,
      usableQuestions: 1,
      fullExamQuestionCount: 1,
    })),
    acceptance: {
      runId: 'acceptance-run-0001',
      startedAt: '2026-07-11T01:00:01.000Z',
      completedAt: '2026-07-11T01:00:04.000Z',
      completed: true,
    },
    recording: {
      path: 'acceptance.webm',
      captureSource: 'playwright_screencast',
      bytes: recording.length,
      sha256: recordingSha256,
      acceptanceRunId: 'acceptance-run-0001',
      startedAt: '2026-07-11T01:00:00.000Z',
      completedAt: '2026-07-11T01:00:05.000Z',
    },
  };
}

const validProbe = async () => ({
  ffprobeSha256: 'd'.repeat(64),
  probe: {
    format: { format_name: 'matroska,webm', duration: '5.000000' },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'vp9',
        width: 1280,
        height: 720,
        nb_read_frames: '150',
      },
    ],
  },
});

test('hardware verifier requires a contained digest-matched WebM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cert-prep-hardware-evidence-'));
  try {
    const evidenceRoot = join(root, 'evidence');
    mkdirSync(evidenceRoot, { recursive: true });
    const plan = deriveReleaseIdentity({
      eventName: 'workflow_dispatch',
      refName: 'main',
      requestedVersion: '0.1.0-alpha.1',
      repository: 'owner/cert-prep',
      commitSha: 'a'.repeat(40),
    });
    const planPath = join(root, 'plan.json');
    const resultPath = join(evidenceRoot, 'hardware-result.json');
    const recordingPath = join(evidenceRoot, 'acceptance.webm');
    const recording = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.from('recording'),
    ]);
    writeJson(planPath, plan);
    writeFileSync(recordingPath, recording);
    writeJson(
      resultPath,
      await hardwareResult(
        plan,
        evidenceRoot,
        recording,
        await sha256File(recordingPath),
      ),
    );

    await assert.doesNotReject(() =>
      verifyHardwareEvidence(
        resultPath,
        planPath,
        evidenceRoot,
        'e'.repeat(64),
        {
          expectedHarnessSha256: 'c'.repeat(64),
          probeRecording: validProbe,
        },
      ),
    );

    const invalidRecording = Buffer.from('not-webm');
    writeFileSync(recordingPath, invalidRecording);
    writeJson(
      resultPath,
      await hardwareResult(
        plan,
        evidenceRoot,
        invalidRecording,
        await sha256File(recordingPath),
      ),
    );
    await assert.rejects(
      () =>
        verifyHardwareEvidence(
          resultPath,
          planPath,
          evidenceRoot,
          'e'.repeat(64),
          {
            expectedHarnessSha256: 'c'.repeat(64),
            probeRecording: validProbe,
          },
        ),
      /WebM EBML header/,
    );

    writeFileSync(recordingPath, recording);
    writeJson(
      resultPath,
      await hardwareResult(
        plan,
        evidenceRoot,
        recording,
        await sha256File(recordingPath),
      ),
    );
    await assert.rejects(
      () =>
        verifyHardwareEvidence(
          resultPath,
          planPath,
          evidenceRoot,
          'e'.repeat(64),
          {
            expectedHarnessSha256: 'c'.repeat(64),
            probeRecording: async () => ({
              ffprobeSha256: 'd'.repeat(64),
              probe: {
                format: { format_name: 'matroska,webm', duration: '5' },
                streams: [
                  {
                    codec_type: 'video',
                    codec_name: 'vp9',
                    width: 1280,
                    height: 720,
                    nb_frames: '150',
                  },
                ],
              },
            }),
          },
        ),
      /playable WebM video/,
    );

    await assert.rejects(
      () =>
        verifyHardwareEvidence(
          resultPath,
          planPath,
          evidenceRoot,
          'e'.repeat(64),
          {
            expectedHarnessSha256: 'b'.repeat(64),
            probeRecording: validProbe,
          },
        ),
      /pinned acceptance harness/,
    );
    await assert.rejects(
      () =>
        verifyHardwareEvidence(
          resultPath,
          planPath,
          evidenceRoot,
          'e'.repeat(64),
          {
            expectedHarnessSha256: 'c'.repeat(64),
            ffprobePath: recordingPath,
            ffprobeSha256: '0'.repeat(64),
          },
        ),
      /ffprobe digest/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
