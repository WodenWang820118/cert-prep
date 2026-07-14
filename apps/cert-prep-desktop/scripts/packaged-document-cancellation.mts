import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadDocumentCancellationOptions } from './packaged-resilience/args.mts';
import { runDocumentCancellationAcceptance } from './packaged-resilience/document-runner.mts';

export async function runPackagedDocumentCancellationCli(): Promise<void> {
  const options = await loadDocumentCancellationOptions();
  const result = await runDocumentCancellationAcceptance(options);
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'completed',
        candidateId: options.candidate.candidateId,
        acceptanceRunId: options.acceptanceRunId,
        outputRoot: result.outputRoot,
        evidence: result.evidence,
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
  runPackagedDocumentCancellationCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
