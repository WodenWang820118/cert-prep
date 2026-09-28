import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hosted Windows runners can expose TEMP through an 8.3 path alias such as RUNNER~1.
// Each test process also gets a private root that is removed on exit, so test
// runs never leave files in the shared temp directory.
const canonicalTempDirectory = realpathSync.native(
  mkdtempSync(join(realpathSync.native(tmpdir()), 'cert-test-')),
);

process.env.TEMP = canonicalTempDirectory;
process.env.TMP = canonicalTempDirectory;
process.env.TMPDIR = canonicalTempDirectory;

process.once('exit', () => {
  try {
    rmSync(canonicalTempDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    process.stderr.write(`Could not remove test temp root ${canonicalTempDirectory}: ${String(error)}\n`);
  }
});
