import assert from 'node:assert/strict';
import test from 'node:test';

import { countAnchors } from './anchors.mts';
import {
  ACTIVE_SAMPLE_COUNT,
  adaptersFromRegistry,
  classifyAdapter,
  DEDICATED_VIDEO_BYTES,
  decidePhaseVerdict,
  designedOcrAdapterClass,
  formatAdapterLuid,
  MICROSOFT_VENDOR_ID,
  NVIDIA_VENDOR_ID,
  parseNvidiaSamples,
  parseRegistryAdapterJson,
  parseWindowsSamples,
  sameSpawnedProcess,
  summarizeObservation,
  type GpuAdapter,
} from './devices.mts';
import { redactSecrets } from './redact.mts';
import { backendServeArguments, childEnvironment, keptRunTreeMarker, REAL_ENGINES_TARGET } from './run.mts';

const DEDICATED = '000000000001fa93';
const INTEGRATED = '00000000000000ab';

function adapter(luid: string, adapterClass: GpuAdapter['adapterClass'], vendorId: number | null): GpuAdapter {
  return { luid, adapterClass, description: 'adapter', vendorId };
}

function windowsFixture(): string {
  return [
    'cpu,2026-11-25T00:00:00.000Z,1,10,1,True',
    'worker,2026-11-25T00:00:00.000Z,10:637000000000000000,text-recognition,1.0000000',
    'cpu,2026-11-25T00:00:02.000Z,2,20,1,True',
    'worker,2026-11-25T00:00:02.000Z,10:637000000000000000,text-recognition,1.2000000',
    'gpu,2026-11-25T00:00:02.000Z,owned,' + DEDICATED + ',3D,40,text-recognition',
    'busy,2026-11-25T00:00:02.000Z,10:637000000000000000,' + DEDICATED + ',0,3D,5000000,text-recognition',
    'cpu,2026-11-25T00:00:04.000Z,3,20,1,True',
    'worker,2026-11-25T00:00:04.000Z,10:637000000000000000,text-recognition,2.0000000',
    'gpu,2026-11-25T00:00:04.000Z,owned,' + DEDICATED + ',3D,50,text-recognition',
    'busy,2026-11-25T00:00:04.000Z,10:637000000000000000,' + DEDICATED + ',0,3D,25000000,text-recognition',
    'junk,not,a,sample',
  ].join('\n');
}

test('formats a DirectX adapter LUID high part then low part', () => {
  assert.equal(formatAdapterLuid(0x1fa93n), DEDICATED);
  assert.equal(formatAdapterLuid((0x89abcdefn << 32n) | 0x01234567n), '89abcdef01234567');
  assert.throws(() => formatAdapterLuid(-1n), /out of range/);
});

test('classifies adapters from vendor, description and dedicated video memory', () => {
  assert.equal(
    classifyAdapter({ vendorId: MICROSOFT_VENDOR_ID, dedicatedVideoBytes: DEDICATED_VIDEO_BYTES, description: 'GPU' }),
    'software',
  );
  assert.equal(
    classifyAdapter({
      vendorId: NVIDIA_VENDOR_ID,
      dedicatedVideoBytes: DEDICATED_VIDEO_BYTES,
      description: 'Microsoft Basic Render Driver',
    }),
    'software',
  );
  assert.equal(
    classifyAdapter({ vendorId: NVIDIA_VENDOR_ID, dedicatedVideoBytes: DEDICATED_VIDEO_BYTES, description: 'NVIDIA' }),
    'dedicated',
  );
  assert.equal(
    classifyAdapter({
      vendorId: NVIDIA_VENDOR_ID,
      dedicatedVideoBytes: DEDICATED_VIDEO_BYTES - 1n,
      description: 'NVIDIA',
    }),
    'integrated',
  );
});

test('parses the registry adapter JSON and drops duplicate LUIDs', () => {
  const records = parseRegistryAdapterJson(
    'noise [{"luidQword":"129683","dedicatedVideoBytes":"536870912","vendorId":"4318","description":"NVIDIA"},' +
      '{"luidQword":"129683","dedicatedVideoBytes":"536870912","vendorId":"4318","description":"again"},' +
      '{"luidQword":"nope","dedicatedVideoBytes":"1","vendorId":"1","description":"bad"}]',
  );
  const adapters = adaptersFromRegistry(records);
  assert.equal(adapters.length, 1);
  assert.equal(adapters[0]?.luid, DEDICATED);
  assert.equal(adapters[0]?.adapterClass, 'dedicated');
  assert.equal(adapters[0]?.vendorId, NVIDIA_VENDOR_ID);
  assert.deepEqual(parseRegistryAdapterJson('not json'), []);
});

test('parses Windows and nvidia-smi samples and ignores a BOM and junk', () => {
  const parsed = parseWindowsSamples('\uFEFF' + windowsFixture());
  assert.equal(parsed.cpu.length, 3);
  assert.equal(parsed.gpu.length, 1 + 1);
  assert.equal(parsed.busy.length, 2);
  assert.equal(parsed.workers.length, 3);
  assert.equal(parsed.cpu[0]?.gpuOk, true);
  assert.deepEqual(parseNvidiaSamples('\uFEFF2026/11/25 00:00:02, 80, 1000\nbad\n2026/11/25 00:00:04, 10, 1100\n'), [
    { time: '2026/11/25 00:00:02', utilization: 80, memoryUsedMiB: 1000 },
    { time: '2026/11/25 00:00:04', utilization: 10, memoryUsedMiB: 1100 },
  ]);
});

test('a busy dedicated adapter is the observed device', () => {
  const parsed = parseWindowsSamples(windowsFixture());
  const observation = summarizeObservation({
    ...parsed,
    nvidia: parseNvidiaSamples('2026/11/25 00:00:04, 90, 1000'),
    adapters: [adapter(DEDICATED, 'dedicated', NVIDIA_VENDOR_ID)],
    worker: 'text-recognition',
  });
  assert.equal(observation.observedDevice, 'dedicated-gpu');
  assert.equal(observation.matchingProcessObserved, true);
  assert.equal(observation.conflictingAdapters, false);
  assert.ok((observation.ownedAdapterUse[0]?.busySeconds ?? 0) >= 0.5);
  assert.ok((observation.ownedAdapterUse[0]?.activeSamples ?? 0) >= ACTIVE_SAMPLE_COUNT);
});

test('too few samples, copy engines, conflicts and a huge baseline do not pass as GPU work', () => {
  const oneTick = parseWindowsSamples('cpu,2026-11-25T00:00:00.000Z,1,10,1,True\n');
  assert.equal(
    summarizeObservation({
      ...oneTick,
      nvidia: [],
      adapters: [adapter(DEDICATED, 'dedicated', NVIDIA_VENDOR_ID)],
    }).observedDevice,
    null,
  );

  const copy = parseWindowsSamples(
    [
      'cpu,2026-11-25T00:00:00.000Z,1,10,1,True',
      'worker,2026-11-25T00:00:00.000Z,10:100,text-recognition,1',
      'cpu,2026-11-25T00:00:02.000Z,2,10,1,True',
      'worker,2026-11-25T00:00:02.000Z,10:100,text-recognition,2',
      'gpu,2026-11-25T00:00:02.000Z,owned,' + DEDICATED + ',Copy,90,text-recognition',
      'busy,2026-11-25T00:00:02.000Z,10:100,' + DEDICATED + ',0,Copy,10000000,text-recognition',
    ].join('\n'),
  );
  assert.equal(
    summarizeObservation({
      ...copy,
      nvidia: [],
      adapters: [adapter(DEDICATED, 'dedicated', NVIDIA_VENDOR_ID)],
      worker: 'text-recognition',
    }).observedDevice,
    null,
  );

  const conflict = parseWindowsSamples(
    windowsFixture() +
      '\ngpu,2026-11-25T00:00:02.000Z,owned,' +
      INTEGRATED +
      ',3D,30,text-recognition' +
      '\nbusy,2026-11-25T00:00:02.000Z,11:637000000000000000,' +
      INTEGRATED +
      ',0,3D,5000000,text-recognition' +
      '\nbusy,2026-11-25T00:00:04.000Z,11:637000000000000000,' +
      INTEGRATED +
      ',0,3D,25000000,text-recognition',
  );
  const conflicted = summarizeObservation({
    ...conflict,
    nvidia: [],
    adapters: [adapter(DEDICATED, 'dedicated', NVIDIA_VENDOR_ID), adapter(INTEGRATED, 'integrated', 0x8086)],
    worker: 'text-recognition',
  });
  assert.equal(conflicted.conflictingAdapters, true);
  assert.equal(conflicted.observedDevice, null);

  const huge = parseWindowsSamples(
    [
      'cpu,2026-11-25T00:00:00.000Z,1,10,1,True',
      'worker,2026-11-25T00:00:00.000Z,10:100,text-recognition,1',
      'cpu,2026-11-25T00:00:02.000Z,4,10,1,True',
      'worker,2026-11-25T00:00:02.000Z,10:100,text-recognition,4',
      'busy,2026-11-25T00:00:00.000Z,10:100,' + DEDICATED + ',0,3D,18446744073709551615,text-recognition',
      'busy,2026-11-25T00:00:02.000Z,10:100,' + DEDICATED + ',0,3D,18446744073709551615,text-recognition',
    ].join('\n'),
  );
  const cpu = summarizeObservation({
    ...huge,
    nvidia: [],
    adapters: [adapter(DEDICATED, 'dedicated', NVIDIA_VENDOR_ID)],
    worker: 'text-recognition',
  });
  assert.equal(cpu.observedDevice, 'cpu');
  assert.ok((cpu.ownedAdapterUse[0]?.busySeconds ?? 0) < 0.5);
});

test('the phase verdict passes only when designed, reported and observed agree', () => {
  const parsed = parseWindowsSamples(windowsFixture());
  const adapters = [adapter(DEDICATED, 'dedicated', NVIDIA_VENDOR_ID)];
  const observation = summarizeObservation({
    ...parsed,
    nvidia: parseNvidiaSamples('2026/11/25 00:00:04, 90, 1000'),
    adapters,
    worker: 'text-recognition',
  });
  const pass = decidePhaseVerdict({
    design: { device: 'cuda', observed: 'dedicated-gpu', model: 'tea-asr-1.1-mini', vendor: 'nvidia' },
    reported: { device: 'cuda', model: 'tea-asr-1.1-mini' },
    observation,
  });
  assert.equal(pass.verdict, 'pass');
  assert.deepEqual(pass.reasons, []);

  const wrongVendor = decidePhaseVerdict({
    design: { device: 'cuda', observed: 'dedicated-gpu', vendor: 'nvidia' },
    reported: { device: 'cuda' },
    observation: summarizeObservation({
      ...parsed,
      nvidia: parseNvidiaSamples('2026/11/25 00:00:04, 1, 1'),
      adapters: [adapter(DEDICATED, 'dedicated', 0x8086)],
      worker: 'text-recognition',
    }),
  });
  assert.equal(wrongVendor.verdict, 'mismatch');
  assert.ok(wrongVendor.reasons.some((reason) => reason.includes('designed NVIDIA')));

  const missingNvidia = decidePhaseVerdict({
    design: { device: 'cuda', observed: 'dedicated-gpu', vendor: 'nvidia' },
    reported: { device: 'cuda' },
    observation: summarizeObservation({ ...parsed, nvidia: [], adapters, worker: 'text-recognition' }),
  });
  assert.equal(missingNvidia.verdict, 'not observed');
  assert.ok(missingNvidia.reasons.includes('nvidia-smi produced no samples'));

  const mismatch = decidePhaseVerdict({
    design: { device: 'directml', observed: 'dedicated-gpu', adapterClass: 'dedicated' },
    reported: { device: 'cpu', adapterClass: 'dedicated' },
    observation,
  });
  assert.equal(mismatch.verdict, 'mismatch');
  assert.ok(mismatch.reasons.some((reason) => reason.startsWith('device ')));

  const absent = decidePhaseVerdict({
    design: { device: 'directml', observed: 'dedicated-gpu' },
    reported: {},
    observation: null,
  });
  assert.equal(absent.verdict, 'not observed');
  assert.ok(absent.reasons.includes('device not observed'));
});

test('anchor comparison is NFKC with collapsed whitespace, and secrets are redacted', () => {
  const counted = countAnchors('Ａ\u3000Ｂ   c', ['A B', 'c', 'missing', '   ']);
  assert.deepEqual(counted, { found: 2, expected: 4 });
  assert.equal(redactSecrets('token abcdefghijkl and short ab', ['abcdefghijkl', 'ab']), 'token [token] and short ab');
});

test('directml OCR is designed for the dedicated adapter when the list has one', () => {
  assert.equal(designedOcrAdapterClass(['integrated', 'software', 'dedicated']), 'dedicated');
  assert.equal(designedOcrAdapterClass(['software', 'integrated']), 'integrated');
  assert.equal(designedOcrAdapterClass([]), 'integrated');
  const parsed = parseWindowsSamples(windowsFixture());
  const observation = summarizeObservation({
    ...parsed,
    nvidia: [],
    adapters: [adapter(DEDICATED, 'dedicated', NVIDIA_VENDOR_ID), adapter(INTEGRATED, 'integrated', 0x8086)],
    worker: 'text-recognition',
  });
  const disagreed = decidePhaseVerdict({
    design: {
      device: 'directml',
      observed: 'dedicated-gpu',
      adapterClass: designedOcrAdapterClass(['dedicated', 'integrated']),
    },
    reported: { device: 'directml', adapterClass: 'integrated' },
    observation,
  });
  assert.equal(disagreed.verdict, 'mismatch');
  assert.ok(disagreed.reasons.some((reason) => reason.includes('adapter integrated, designed dedicated')));
});

test('a pid may be killed only while the child is still running and the creation time matches', () => {
  assert.equal(sameSpawnedProcess({ stillRunning: true, recordedCreation: '100', liveCreation: '100' }), true);
  assert.equal(sameSpawnedProcess({ stillRunning: false, recordedCreation: '100', liveCreation: '100' }), false);
  assert.equal(sameSpawnedProcess({ stillRunning: true, recordedCreation: '100', liveCreation: '200' }), false);
  assert.equal(sameSpawnedProcess({ stillRunning: true, recordedCreation: '100', liveCreation: null }), false);
  assert.equal(sameSpawnedProcess({ stillRunning: true, recordedCreation: null, liveCreation: '100' }), false);
  assert.equal(sameSpawnedProcess({ stillRunning: true, recordedCreation: '', liveCreation: '' }), false);
});

test('child environments drop ambient engine controls and package tokens', () => {
  const filtered = childEnvironment(
    {
      Path: 'C:\\Windows',
      CAPTURE_OCR_DEVICE: 'cpu',
      CAPTURE_ENGINE_CACHE_DIR: 'D:\\cache',
      OLLAMA_NUM_GPU: '0',
      OLLAMA_MODELS: 'D:\\ambient-models',
      CERT_PREP_API_TOKEN: 'ambient-token-value',
      GITHUB_PACKAGES_TOKEN: 'ghp_ambient_packages',
      GITHUB_TOKEN: 'ghp_installer',
      TEMP: 'C:\\Temp',
    },
    {
      CAPTURE_PORT: '9',
      OLLAMA_MODELS: 'D:\\run-models',
      CERT_PREP_API_TOKEN: 'run-token-value',
    },
  );
  assert.equal(filtered['Path'], 'C:\\Windows');
  assert.equal(filtered['TEMP'], 'C:\\Temp');
  assert.equal(filtered['CAPTURE_ENGINE_CACHE_DIR'], 'D:\\cache');
  assert.equal(filtered['CAPTURE_OCR_DEVICE'], undefined);
  assert.equal(filtered['OLLAMA_NUM_GPU'], undefined);
  assert.equal(filtered['GITHUB_PACKAGES_TOKEN'], undefined);
  assert.equal(filtered['GITHUB_TOKEN'], undefined);
  assert.equal(filtered['CAPTURE_PORT'], '9');
  assert.equal(filtered['OLLAMA_MODELS'], 'D:\\run-models');
  assert.equal(filtered['CERT_PREP_API_TOKEN'], 'run-token-value');

  const installer = childEnvironment(
    { GITHUB_TOKEN: 'ghp_installer', GH_TOKEN: 'ghp_alt', GITHUB_PACKAGES_TOKEN: 'ghp_ambient_packages', CAPTURE_OCR_DEVICE: 'cpu' },
    { CAPTURE_ENGINE_CACHE_DIR: 'D:\\override-cache' },
    { githubToken: true },
  );
  assert.equal(installer['GITHUB_TOKEN'], 'ghp_installer');
  assert.equal(installer['GH_TOKEN'], 'ghp_alt');
  assert.equal(installer['GITHUB_PACKAGES_TOKEN'], undefined);
  assert.equal(installer['CAPTURE_OCR_DEVICE'], undefined);
  assert.equal(installer['CAPTURE_ENGINE_CACHE_DIR'], 'D:\\override-cache');
});

test('the orchestrator appends the backend port and marks the run tree kept', () => {
  assert.equal(REAL_ENGINES_TARGET, 'cert-prep-e2e:smoke-real-engines-dev-server');
  assert.equal(backendServeArguments(9100), '--args=--port=9100');
  assert.throws(() => backendServeArguments(0), /port/);
  assert.deepEqual(keptRunTreeMarker('2026-11-25T00:00:00.000Z'), {
    schemaVersion: 1,
    createdAt: '2026-11-25T00:00:00.000Z',
    target: 'cert-prep-e2e:smoke-real-engines-dev-server',
    reason: 'real engine installs',
  });
});
