import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parsePackagedCaptureWorkbenchSmokeArgs } from './packaged-capture-workbench-smoke/args.mts';
import { runPackagedCaptureWorkbenchSmoke } from './packaged-capture-workbench-smoke/runner.mts';

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runPackagedCaptureWorkbenchSmoke(
    parsePackagedCaptureWorkbenchSmokeArgs(process.argv.slice(2)),
  ).catch((error) => { console.error(error); process.exitCode = 1; });
}
