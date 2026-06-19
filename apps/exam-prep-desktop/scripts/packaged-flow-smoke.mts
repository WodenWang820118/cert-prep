import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runPackagedFlowSmokeCli } from './packaged-flow-smoke/runner.mts';

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runPackagedFlowSmokeCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
