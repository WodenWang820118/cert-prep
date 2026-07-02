import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { errorMessage, normalizePath } from './text-utils.mts';
import type { SmokeRunState, VideoArtifact } from './types.mts';

const VIDEO_SIZE = { width: 1440, height: 1000 };

export async function startAcceptanceVideo(run: SmokeRunState): Promise<void> {
  if (!run.options.recordVideo || !run.page) {
    return;
  }

  const filePath = join(
    run.options.outDir,
    `${String((run.metrics.video_artifacts?.length ?? 0) + 1).padStart(2, '0')}-acceptance-recording.webm`,
  );
  const artifact: VideoArtifact = {
    path: normalizePath(relative(run.options.workspaceRoot, filePath)),
    bytes: 0,
    sha256: '',
    capture_source: 'playwright_screencast',
    status: 'recording',
    started_at: new Date().toISOString(),
  };
  run.metrics.video_artifacts ??= [];
  run.metrics.video_artifacts.push(artifact);
  run.videoRecording = { artifact, filePath, active: false };

  try {
    await run.page.screencast.start({
      path: filePath,
      size: VIDEO_SIZE,
      quality: 85,
    });
    run.videoRecording.active = true;
  } catch (error) {
    markVideoFailure(artifact, errorMessage(error));
    throw error;
  }
}

export async function stopAcceptanceVideo(run: SmokeRunState): Promise<void> {
  const recording = run.videoRecording;
  if (!recording) {
    return;
  }

  if (!recording.active && recording.artifact.status === 'failed') {
    run.videoRecording = null;
    return;
  }

  if (recording.active && run.page) {
    try {
      await run.page.screencast.stop();
    } catch (error) {
      markVideoFailure(recording.artifact, errorMessage(error));
      recording.active = false;
      run.videoRecording = null;
      return;
    }
  }

  await finalizeVideoArtifact(recording.filePath, recording.artifact);
  recording.active = false;
  run.videoRecording = null;
}

export function videoEvidencePassed(run: SmokeRunState): boolean {
  return (
    run.metrics.video_artifacts?.some(
      (artifact) =>
        artifact.status === 'completed' &&
        artifact.bytes > 0 &&
        artifact.sha256.length > 0,
    ) ?? false
  );
}

async function finalizeVideoArtifact(
  absolutePath: string,
  artifact: VideoArtifact,
): Promise<void> {
  artifact.finished_at = new Date().toISOString();
  if (!existsSync(absolutePath)) {
    markVideoFailure(artifact, 'Video artifact was not written.');
    return;
  }

  const stats = statSync(absolutePath);
  artifact.bytes = stats.size;
  artifact.sha256 = await sha256File(absolutePath);
  if (stats.size <= 0) {
    markVideoFailure(artifact, 'Video artifact is empty.');
    return;
  }
  artifact.status = 'completed';
  delete artifact.error;
}

function markVideoFailure(artifact: VideoArtifact, message: string): void {
  artifact.status = 'failed';
  artifact.finished_at = new Date().toISOString();
  artifact.error = message;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}
