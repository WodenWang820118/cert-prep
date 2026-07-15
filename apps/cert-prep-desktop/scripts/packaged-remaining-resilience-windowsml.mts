import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadRemainingResilienceOptions } from './packaged-resilience/remaining-options.mts';
import { runRemainingResilienceAcceptance } from './packaged-resilience/resilience-runner.mts';

export async function runPackagedRemainingResilienceCli(): Promise<void> {
  const options = await loadRemainingResilienceOptions();
  const result = await runRemainingResilienceAcceptance(options);
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'completed',
        lane: 'remaining-resilience-only',
        complementsTarget: 'packaged-document-cancellation-windowsml',
        candidateId: options.candidate.candidateId,
        acceptanceRunId: options.acceptanceRunId,
        packageKind: options.installation.packageKind,
        installReceiptSha256: options.installation.receiptSha256,
        outputRoot: result.outputRoot,
        evidence: result.evidence,
        sessionRestart: result.sessionRestart,
      },
      null,
      2,
    )}\n`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runPackagedRemainingResilienceCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
