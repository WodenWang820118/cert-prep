import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { removeAcceptanceAppDataDirectory } from './acceptance-app-data.mts';
import { createAcceptanceSmokeOptions } from './acceptance-real-options.mts';
import {
  PackagedImageUploadSmokeError,
  runPackagedImageUploadSmoke,
  type PackagedImageCleanupEvidence,
} from './packaged-image-upload-smoke/runner.mts';
import { runPackagedFlowSmoke } from './packaged-flow-smoke/runner.mts';
import { acceptancePrivacyMasks } from './packaged-flow-smoke/runner-context.mts';

const VISUAL_BASELINE_NAMES = new Set([
  'runtime-python-missing',
  'runtime-drawer-python-missing',
  'python-install-consent',
  'python-runtime-ready',
]);

test('real Cert Prep packaged PDF and JPEG acceptance journeys pass', async () => {
  const {
    run,
    options,
    imageOptions,
    fixtures,
    installedArtifact,
    runtimeProvenance,
    captureRuntimeMirror,
    appDataDirectories,
  } =
    await createAcceptanceSmokeOptions();
  let pdfMetrics: Awaited<ReturnType<typeof runPackagedFlowSmoke>> | undefined;
  let imageEvidence: Awaited<ReturnType<typeof runPackagedImageUploadSmoke>> | undefined;
  let failure: string | undefined;
  let imageFailure: string | undefined;
  let pdfFailure: string | undefined;
  let imageFailureCleanup: PackagedImageCleanupEvidence | undefined;
  let imageFailureCleanupVerified = false;
  try {
    // Run the one-page JPEG journey before the long PDF/restart journey. Each
    // journey still has its own app-data directory and CDP port; keeping the
    // image cold start first avoids overlapping a fresh WindowsML worker with
    // native OCR teardown from the previous packaged app.
    try {
      imageEvidence = await runPackagedImageUploadSmoke(imageOptions);
      expect(imageEvidence.status).toBe('completed');
      expect(imageEvidence.document.status).toBe('ready');
      expect(imageEvidence.document.chunks_count).toBeGreaterThan(0);
    } catch (error) {
      imageFailure = error instanceof Error ? error.message : String(error);
      if (error instanceof PackagedImageUploadSmokeError) {
        imageFailureCleanup = error.cleanup;
        imageFailureCleanupVerified = error.cleanupVerified;
      }
      throw error;
    }

    try {
      pdfMetrics = await runPackagedFlowSmoke({
        ...options,
        acceptanceFixture: fixtures.pdf,
        acceptanceVisualCheckpoint: async (page, name) => {
          // This checkpoint is intentionally taken while the OCR job is still
          // running. Its status badge and page counters are timing-dependent,
          // so a pixel baseline would turn a healthy parse into a flaky failure
          // whenever the worker advances between the screenshot and assertion.
          if (name === 'mid-parse-ui-still-usable') {
            await expect(page.locator('main')).toBeVisible();
            await expect(page.getByText('Step 01: Source files')).toBeVisible();
            await expect(page.getByText('Step 02: Exam Questions')).toBeVisible();
            return;
          }
          // Source and generated-content checkpoints remain masked run
          // artifacts and are validated by domain assertions below. Only the
          // private-data-free runtime shell is a checked-in pixel contract.
          if (!VISUAL_BASELINE_NAMES.has(name)) return;
          if (run.recordVideo) return;
          await expect(page).toHaveScreenshot(`${name}.png`, {
            animations: 'disabled',
            fullPage: false,
            maskColor: '#ffffff',
            mask: [
              ...acceptancePrivacyMasks(page),
              page.locator('time'),
              page.locator('.dynamic-id'),
              page.locator('[data-testid="document-elapsed-time"]'),
              page.locator('[data-testid="document-progress-metrics"]'),
              page.locator('[data-testid="document-progress-bar"]'),
              page.locator('[data-testid="draft-question-id"]'),
              // Capture Runtime assigns a fresh UUID to each raw segment. The
              // result JSON is functionally asserted separately, so keep this
              // visual checkpoint focused on the rendered result shell.
              page.locator('aside.practice-session-rail dd').first(),
            ],
          });
        },
      });
      expect(pdfMetrics.status).toBe('completed');
      expect(pdfMetrics.errors).toEqual([]);
      expect(pdfMetrics.restart?.verified).toBe(true);
    } catch (error) {
      pdfFailure = error instanceof Error ? error.message : String(error);
      throw error;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const cleanupFailures: string[] = [];
    try {
      await captureRuntimeMirror?.close();
    } catch (error) {
      cleanupFailures.push(
        `Capture Runtime mirror cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const appDataDirectory of appDataDirectories) {
      try {
        removeAcceptanceAppDataDirectory(
          resolve(import.meta.dirname, '../..', '..'),
          appDataDirectory,
        );
      } catch (error) {
        cleanupFailures.push(
          `Temporary app-data cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (cleanupFailures.length > 0 && !failure) {
      failure = cleanupFailures.join(' ');
    }
    await writeFile(
      join(run.artifactRoot, 'acceptance-sources.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: failure ? 'failed' : 'completed',
          pdf: {
            fixture: fixtures.pdf,
            status: pdfMetrics?.status ?? 'failed',
            errors:
              pdfMetrics?.errors ??
              [pdfFailure ?? (imageFailure ? 'PDF journey did not run.' : failure ?? 'PDF journey did not run.')],
            restartVerified: pdfMetrics?.restart?.verified === true,
          },
          image: {
            fixture: fixtures.image,
            status: imageEvidence?.status ?? 'failed',
            cleanupVerified:
              imageEvidence?.cleanupVerified === true || imageFailureCleanupVerified,
            cleanup: imageEvidence?.cleanup ?? imageFailureCleanup,
            error: imageFailure,
          },
          runtime: {
            installed: installedArtifact,
            candidate: runtimeProvenance,
          },
          cleanupErrors: cleanupFailures,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
});
