// Standalone packaged smoke for the embedded Capture Workbench (scanned PDF).
// It still follows the flow before the 0.4.2 OCR preflight and stops at that
// step; updating it (and adding the audio leg) is tracked in
// .agents/TODOS/capture-workbench-cert-prep-pdf.md. The real OCR acceptance is
// acceptance-real.spec.mts.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parsePackagedCaptureWorkbenchSmokeArgs } from './packaged-capture-workbench-smoke/args.mts';
import { runPackagedCaptureWorkbenchSmoke } from './packaged-capture-workbench-smoke/runner.mts';

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runPackagedCaptureWorkbenchSmoke(
    parsePackagedCaptureWorkbenchSmokeArgs(process.argv.slice(2)),
  ).catch((error) => { console.error(error); process.exitCode = 1; });
}
