import type { SmokeMetrics, SmokeOptions, SmokeRunState } from './types.mts';

/**
 * Fresh run state for a packaged-app journey. Callers own the journey-specific
 * options and initial metrics; this only supplies the idle process handles.
 */
export function createSmokeRunState(
  options: SmokeOptions,
  metrics: SmokeMetrics,
): SmokeRunState {
  return {
    options,
    metrics,
    app: null,
    appExit: null,
    resourceSampling: null,
    browser: null,
    page: null,
    port: options.cdpPort,
    processBaseline: { all: [], nodePids: new Set() },
    projectApi: null,
    uploadedDocument: null,
    streamingDraftParseStartedAt: null,
    streamingDraftCaptureOpen: false,
    streamingApiPollErrorCaptured: false,
  };
}
