import { setTimeout as delay } from 'node:timers/promises';

import {
  FIRST_CHUNK_GATE_MS,
  firstChunkGateMetrics,
} from './streaming-evidence.mts';
import { errorMessage } from './text-utils.mts';
import type { SmokeRunState } from './types.mts';
import { bodyText, log } from './runner-context.mts';

export const FIRST_CHUNK_TEXT_PATTERN = /Extracted text|Page \d+|\b[1-9]\d* chunks\b/;
const FIRST_CHUNK_VISIBLE_TIMEOUT_MS = FIRST_CHUNK_GATE_MS + 260_000;

interface FirstChunkObservation {
  readonly done: Promise<void>;
  stop(): void;
}

export function refreshFirstChunkGateMetrics(run: SmokeRunState): void {
  const gate = firstChunkGateMetrics(
    run.metrics.ui_timings_ms.first_chunk_visible,
    FIRST_CHUNK_GATE_MS,
  );
  run.metrics.first_chunk_gate_ms = gate.first_chunk_gate_ms;
  run.metrics.first_chunk_under_gate = gate.first_chunk_under_gate;
}

export function recordFirstChunkVisible(run: SmokeRunState, parseStart: number): void {
  if (run.metrics.ui_timings_ms.first_chunk_visible === undefined) {
    run.metrics.ui_timings_ms.first_chunk_visible = Date.now() - parseStart;
  }
  refreshFirstChunkGateMetrics(run);
}

export function observeFirstChunkVisibleFromParseStart(
  run: SmokeRunState,
  parseStart: number,
): FirstChunkObservation {
  let stopped = false;
  const firstChunkStart = Date.now();
  const done = (async () => {
    try {
      while (
        !stopped &&
        Date.now() - firstChunkStart < FIRST_CHUNK_VISIBLE_TIMEOUT_MS
      ) {
        const text = await bodyText(run);
        if (FIRST_CHUNK_TEXT_PATTERN.test(text)) {
          const elapsed = Date.now() - firstChunkStart;
          log(run, `first extracted chunk visible after ${elapsed}ms`);
          recordFirstChunkVisible(run, parseStart);
          return;
        }
        await delay(500);
      }

      if (!stopped) {
        const text = await bodyText(run);
        throw new Error(
          `Timed out waiting for first extracted chunk visible. Pattern=${FIRST_CHUNK_TEXT_PATTERN}. Body=${text.slice(0, 1400)}`,
        );
      }
    } catch (error) {
      if (!stopped) {
        run.metrics.errors.push(`first chunk wait failed: ${errorMessage(error)}`);
        refreshFirstChunkGateMetrics(run);
      }
    } finally {
      if (
        !stopped ||
        run.metrics.ui_timings_ms.first_chunk_wait_window === undefined
      ) {
        run.metrics.ui_timings_ms.first_chunk_wait_window =
          Date.now() - firstChunkStart;
      }
    }
  })();

  return {
    done,
    stop(): void {
      stopped = true;
    },
  };
}
