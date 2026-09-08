import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { removeAcceptanceAppDataDirectory } from './acceptance-app-data.mts';
import { sanitizeAcceptanceFixtureMetadata } from './acceptance-artifacts.mts';
import { createAcceptanceSmokeOptions } from './acceptance-real-options.mts';
import {
  PackagedImageUploadSmokeError,
  runPackagedImageUploadSmoke,
  type PackagedImageCleanupEvidence,
} from './packaged-image-upload-smoke/runner.mts';
import { runPackagedFlowSmoke } from './packaged-flow-smoke/runner.mts';
import { acceptancePrivacyMasks } from './packaged-flow-smoke/runner-context.mts';
import type { Phase1FinalEvidence } from './phase1-final-identity.mts';

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
    pdfOnly,
    imageOptions,
    fixtures,
    installedArtifact,
    runtimeProvenance,
    phase1Final,
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
    if (!pdfOnly) {
      // Run the one-page JPEG journey before the long PDF/restart journey. Each
      // journey still has its own app-data directory and CDP port; keeping the
      // image cold start first avoids overlapping a fresh WindowsML worker with
      // native OCR teardown from the previous packaged app.
      if (!imageOptions || !fixtures.image) {
        throw new Error('JPEG acceptance options were unexpectedly absent.');
      }
      try {
        imageEvidence = await runPackagedImageUploadSmoke(imageOptions);
        expect(imageEvidence.status).toBe('completed');
        expect(imageEvidence.document.status).toBe('ready');
        expect(imageEvidence.document.chunks_count).toBeGreaterThan(0);
        expect(imageEvidence.ocrTruth?.status).toBe('passed');
        if (phase1Final) {
          expect(imageEvidence.acceptanceEvidence).toMatchObject(
            phase1JourneyExpectation(phase1Final, fixtures.image.sha256),
          );
        }
      } catch (error) {
        imageFailure = error instanceof Error ? error.message : String(error);
        if (error instanceof PackagedImageUploadSmokeError) {
          imageFailureCleanup = error.cleanup;
          imageFailureCleanupVerified = error.cleanupVerified;
        }
        throw error;
      }
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
      if (!options.acceptanceOcrOnly) {
        expect(pdfMetrics.restart?.verified).toBe(true);
      }
      expect(pdfMetrics.ocr_truth?.status).toBe('passed');
      if (phase1Final) {
        expect(pdfMetrics.ocr_preflight).toMatchObject({
          mode: 'gpu-dml',
          contract_sha256: phase1Final.identity.contractSetSha256,
          worker_sha256: phase1Final.identity.ocrWorkerExecutableSha256,
          ui_gpu_before_import: true,
          source_import_enabled: true,
        });
        expect(pdfMetrics.ocr_completion).toMatchObject({
          pages_processed: 1,
          total_pages: 46,
          chunks: 1,
          expected_pages: 1,
          expected_chunks: 1,
        });
        expect(pdfMetrics.acceptance_evidence).toMatchObject(
          phase1JourneyExpectation(phase1Final, fixtures.pdf.sha256, true),
        );
      }
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
        sanitizeAcceptanceFixtureMetadata({
          schemaVersion: 1,
          runId: run.runId,
          status: failure ? 'failed' : 'completed',
          pdf: {
            fixture: {
              name: fixtures.pdf.name,
              sha256: fixtures.pdf.sha256,
            },
            status: pdfMetrics?.status ?? 'failed',
            truth: pdfMetrics?.ocr_semantic_evidence,
            evidence: pdfMetrics?.acceptance_evidence,
            errors:
              pdfMetrics?.errors ??
              [pdfFailure ?? (imageFailure ? 'PDF journey did not run.' : failure ?? 'PDF journey did not run.')],
            restartVerified: pdfMetrics?.restart?.verified === true,
          },
          ...(pdfOnly
            ? {}
            : {
                image: {
                  fixture: {
                    name: fixtures.image!.name,
                    sha256: fixtures.image!.sha256,
                  },
                  status: imageEvidence?.status ?? 'failed',
                  truth: imageEvidence?.ocrSemanticEvidence,
                  cleanupVerified:
                    imageEvidence?.cleanupVerified === true || imageFailureCleanupVerified,
                  cleanup: imageEvidence?.cleanup ?? imageFailureCleanup,
                  error: imageFailure,
                  evidence: imageEvidence?.acceptanceEvidence,
                },
              }),
          runtime: {
            installed: installedArtifact,
            candidate: runtimeProvenance,
            phase1Final: phase1Final
              ? phase1AggregateSummary(phase1Final)
              : undefined,
          },
          cleanupErrors: cleanupFailures,
        }),
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
});

function phase1JourneyExpectation(
  phase1Final: Phase1FinalEvidence,
  sourceSha256: string,
  pdf = false,
): Record<string, unknown> {
  return {
    sourceSha256,
    importedSourceSha256: sourceSha256,
    runtimeArtifactSha256: phase1Final.identity.runtimeArtifactSha256,
    contractSetSha256: phase1Final.identity.contractSetSha256,
    workerArchiveSha256: phase1Final.identity.ocrWorkerArchiveSha256,
    workerExecutableSha256: phase1Final.identity.ocrWorkerExecutableSha256,
    authenticatedRuntimePreflight: 'gpu-dml',
    uiGpuBeforeImport: true,
    sourceImportEnabled: true,
    expectedAnchorCount: 1,
    matchedAnchorCount: 1,
    ...(pdf
      ? {
          pageScope: {
            sourcePageCount: 46,
            requestedPageNumbers: [1],
            processedPageNumbers: [1],
            uiRawPageNumbers: [1],
            uiStructuredPageNumbers: [1],
          },
        }
      : {}),
  };
}

function phase1AggregateSummary(
  phase1Final: Phase1FinalEvidence,
): Record<string, unknown> {
  return {
    manifestSha256: phase1Final.manifestSha256,
    sourceHead: phase1Final.sourceHead,
    identity: phase1Final.identity,
    jpeg: {
      runId: phase1Final.jpeg.runId,
      acceptanceManifestSha256: phase1Final.jpeg.acceptanceManifestSha256,
    },
    pdfPage1: {
      runId: phase1Final.pdfPage1.runId,
      acceptanceManifestSha256: phase1Final.pdfPage1.acceptanceManifestSha256,
      pageScope: phase1Final.pdfPage1.pageScope,
    },
  };
}
