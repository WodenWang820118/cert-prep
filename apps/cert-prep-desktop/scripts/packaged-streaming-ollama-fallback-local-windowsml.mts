import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runLocalCandidateOllamaFallbackCli } from './packaged-flow-smoke/local-candidate-ollama-fallback.mts';

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runLocalCandidateOllamaFallbackCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
