import type {
  FinalAggregate,
  MutableAggregate,
  NvidiaSmiRow,
  ResourceCsvRow,
} from './resource-sampling-types.mts';

export function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(parseCsvLine);
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

export function resourceCsvRow(row: string[]): ResourceCsvRow | null {
  if (row.length < 8 || row[0] === 'timestamp') {
    return null;
  }
  return {
    timestamp: row[0],
    source: row[1],
    path: row[2],
    pid: row[3],
    name: row[4],
    metric: row[5],
    value: row[6],
    unit: row[7],
  };
}

export function isResourceCsvRow(row: ResourceCsvRow | null): row is ResourceCsvRow {
  return row !== null;
}

export function nvidiaSmiRow(row: string[]): NvidiaSmiRow | null {
  if (row.length < 5) {
    return null;
  }
  return {
    utilizationGpuPercent: firstNumber(row[1]),
    memoryUsedMiB: firstNumber(row[2]),
    memoryTotalMiB: firstNumber(row[3]),
    powerDrawW: firstNumber(row[4]),
  };
}

export function isNvidiaSmiRow(row: NvidiaSmiRow | null): row is NvidiaSmiRow {
  return row !== null;
}

function firstNumber(value: string): number | null {
  const match = /-?\d+(?:\.\d+)?/.exec(value);
  return match ? Number(match[0]) : null;
}

export function newAggregate(): MutableAggregate {
  return {
    samples: 0,
    sum: 0,
    min: null,
    max: null,
  };
}

export function addOptionalAggregate(
  aggregate: MutableAggregate,
  value: number | null,
): void {
  if (value !== null) {
    addAggregate(aggregate, value);
  }
}

export function addAggregate(aggregate: MutableAggregate, value: number): void {
  aggregate.samples += 1;
  aggregate.sum += value;
  aggregate.min = aggregate.min === null ? value : Math.min(aggregate.min, value);
  aggregate.max = aggregate.max === null ? value : Math.max(aggregate.max, value);
}

export function finalizeAggregate(aggregate: MutableAggregate): FinalAggregate {
  return {
    samples: aggregate.samples,
    min: aggregate.min,
    max: aggregate.max,
    avg:
      aggregate.samples === 0
        ? null
        : Number((aggregate.sum / aggregate.samples).toFixed(3)),
  };
}

export function mapRecord(
  map: Map<string, Record<string, MutableAggregate>>,
  key: string,
): Record<string, MutableAggregate> {
  const current = map.get(key);
  if (current) {
    return current;
  }
  const created: Record<string, MutableAggregate> = {};
  map.set(key, created);
  return created;
}

export function mapAggregate(
  record: Record<string, MutableAggregate>,
  key: string,
): MutableAggregate {
  record[key] ??= newAggregate();
  return record[key];
}

export function finalizeAggregateRecord(
  record: Record<string, MutableAggregate>,
): Record<string, FinalAggregate> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, finalizeAggregate(value)]),
  );
}

export function extractLuid(path: string): string | null {
  return /luid_(0x[0-9a-f]+_0x[0-9a-f]+)/i.exec(path)?.[1].toLowerCase() ?? null;
}

export function extractPid(path: string): string | null {
  return /pid_(\d+)/i.exec(path)?.[1] ?? null;
}

export function extractEngineType(path: string): string | null {
  const value = /engtype_([^\\)]+)/i.exec(path)?.[1];
  return value ? normalizeMetricName(value) : null;
}

export function normalizedCounterMetric(path: string): string {
  const raw = path.split('\\').at(-1) ?? path;
  return normalizeMetricName(raw);
}

function normalizeMetricName(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, '_').replaceAll(/^_|_$/g, '');
}

export function maxByPrefix(
  record: Record<string, FinalAggregate>,
  prefix: string,
): number | null {
  const values = Object.entries(record)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, aggregate]) => aggregate.max)
    .filter((value): value is number => value !== null);
  return values.length === 0 ? null : Math.max(...values);
}
