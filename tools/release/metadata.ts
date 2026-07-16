import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertExternalConfirmations,
  assertReleaseInvocationContext,
  assertWorkspaceVersions,
  deriveReleaseIdentity,
  parseArgs,
  writeJson,
} from './release-lib.ts';

export function buildReleasePlan(args) {
  const plan = deriveReleaseIdentity({
    eventName: args['event-name'],
    refName: args['ref-name'],
    requestedVersion: args.version,
    repository: args.repository,
    commitSha: args.sha,
  });
  assertReleaseInvocationContext({
    eventName: args['event-name'],
    ref: args.ref,
    refName: args['ref-name'],
    defaultBranch: args['default-branch'],
    repository: args.repository,
    expectedRepository: args['expected-repository'],
    tag: plan.tag,
  });
  assertExternalConfirmations({
    publicRepository: args['public-repository-confirmed'],
    protectedReleaseEnvironment: args['release-environment-protected'],
    hardwareRunner: args['hardware-runner-ready'],
  });
  const workspaceRoot = resolve(args['workspace-root'] ?? '.');
  const sourceVersions = assertWorkspaceVersions(workspaceRoot, plan.version);
  return {
    ...plan,
    windowsMsiVersion: sourceVersions.windowsMsiVersion,
    sourceVersions,
  };
}

function writeOutputs(plan, path) {
  if (!path) return;
  const outputs = {
    version: plan.version,
    tag: plan.tag,
    repository: plan.repository,
    commit_sha: plan.commitSha,
    asset_base_url: plan.assetBaseUrl,
    candidate_artifact: `cert-prep-alpha-candidate-${plan.commitSha}`,
    release_plan_artifact: `cert-prep-alpha-plan-${plan.commitSha}`,
  };
  appendFileSync(
    path,
    `${Object.entries(outputs)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n')}\n`,
    'utf8',
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = resolve(args['output-dir']);
  mkdirSync(outputDir, { recursive: true });
  const plan = buildReleasePlan(args);
  writeJson(resolve(outputDir, 'release-plan.json'), plan);
  writeOutputs(plan, process.env.GITHUB_OUTPUT);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
