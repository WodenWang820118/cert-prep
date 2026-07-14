import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  parseArgs,
  readJson,
  sha256File,
  validateHardwareEvidenceFiles,
  validateHardwareResult,
  validateRecordingProbeContract,
  writeJson,
} from './release-lib.ts';

export async function verifyHardwareEvidence(
  resultPath,
  planPath,
  evidenceRoot,
  expectedCandidateId,
  { ffprobePath, ffprobeSha256, expectedHarnessSha256, probeRecording } = {},
) {
  const plan = readJson(planPath);
  const result = validateHardwareResult(
    readJson(resultPath),
    plan,
    expectedCandidateId,
  );
  const resolvedEvidenceRoot = resolve(evidenceRoot);
  if (
    expectedHarnessSha256 &&
    result.harnessSha256.toLowerCase() !== expectedHarnessSha256.toLowerCase()
  ) {
    throw new Error(
      'Hardware result was not produced by the pinned acceptance harness.',
    );
  }
  await validateHardwareEvidenceFiles(result, resolvedEvidenceRoot);
  const recordingPath = resolve(resolvedEvidenceRoot, result.recording.path);
  const header = Buffer.alloc(4);
  const descriptor = openSync(recordingPath, 'r');
  try {
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      throw new Error('Hardware recording is too short to be a WebM file.');
    }
  } finally {
    closeSync(descriptor);
  }
  if (!header.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    throw new Error('Hardware recording does not contain a WebM EBML header.');
  }

  let rawProbe;
  let verifiedFfprobeSha256;
  if (probeRecording) {
    const injected = await probeRecording(recordingPath);
    rawProbe = injected.probe;
    verifiedFfprobeSha256 = injected.ffprobeSha256;
  } else {
    const probed = await runFfprobe(recordingPath, ffprobePath, ffprobeSha256);
    rawProbe = probed.probe;
    verifiedFfprobeSha256 = probed.ffprobeSha256;
  }
  const video = rawProbe?.streams?.find(
    (stream) => stream.codec_type === 'video',
  );
  const frameCount = Number.parseInt(video?.nb_read_frames ?? '', 10);
  const probeContract = {
    schemaVersion: 1,
    acceptanceRunId: result.acceptance.runId,
    recording: {
      path: result.recording.path,
      bytes: result.recording.bytes,
      sha256: result.recording.sha256.toLowerCase(),
    },
    ffprobe: { sha256: String(verifiedFfprobeSha256 ?? '').toLowerCase() },
    formatNames: String(rawProbe?.format?.format_name ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
    durationSeconds: Number(rawProbe?.format?.duration),
    video: {
      codec: String(video?.codec_name ?? '').toLowerCase(),
      width: Number(video?.width),
      height: Number(video?.height),
      frameCount,
    },
  };
  validateRecordingProbeContract(probeContract, result);
  writeJson(join(resolvedEvidenceRoot, 'recording-probe.json'), probeContract);
  return result;
}

async function runFfprobe(recordingPath, ffprobePath, expectedSha256) {
  if (
    !isAbsolute(ffprobePath ?? '') ||
    !existsSync(ffprobePath) ||
    !statSync(ffprobePath).isFile() ||
    !/^[0-9a-f]{64}$/i.test(expectedSha256 ?? '')
  ) {
    throw new Error(
      'A provisioned absolute ffprobe path and pinned SHA-256 are required.',
    );
  }
  const actualSha256 = await sha256File(ffprobePath);
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new Error(
      'Provisioned ffprobe digest does not match the approved tool.',
    );
  }
  const invocation = spawnSync(
    ffprobePath,
    [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'format=format_name,duration:stream=codec_type,codec_name,width,height,nb_read_frames',
      '-of',
      'json',
      recordingPath,
    ],
    {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (invocation.error || invocation.status !== 0) {
    throw new Error(
      `ffprobe could not validate the hardware recording: ${invocation.stderr || invocation.error?.message || invocation.status}.`,
    );
  }
  let probe;
  try {
    probe = JSON.parse(invocation.stdout);
  } catch {
    throw new Error(
      'ffprobe returned invalid JSON for the hardware recording.',
    );
  }
  return { probe, ffprobeSha256: actualSha256 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!/^[0-9a-f]{64}$/i.test(args['harness-sha256'] ?? '')) {
    throw new Error('A pinned hardware harness SHA-256 is required.');
  }
  await verifyHardwareEvidence(
    resolve(args.result),
    resolve(args.plan),
    resolve(args['evidence-root']),
    args['candidate-id'],
    {
      ffprobePath: args['ffprobe-path'],
      ffprobeSha256: args['ffprobe-sha256'],
      expectedHarnessSha256: args['harness-sha256'],
    },
  );
  process.stdout.write('Hardware evidence contract passed.\n');
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
