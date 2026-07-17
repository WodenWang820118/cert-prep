import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parsePackagedImageUploadSmokeArgs } from './packaged-image-upload-smoke/args.mts';
import { runPackagedImageUploadSmoke } from './packaged-image-upload-smoke/runner.mts';

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runPackagedImageUploadSmoke(
    parsePackagedImageUploadSmokeArgs(process.argv.slice(2)),
  )
    .then((evidence) => console.log(JSON.stringify(evidence, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
