import type {
  HealthResponse,
  LLMHealthRead,
  WrongAnswerSummaryRead,
} from '../contracts/api.contracts';
export {
  appDocument,
  appProject,
  editableAppQuestion,
  secondAppDocument,
  secondAppProject,
} from './constants/app-fixtures.constants';

export function backendHealth(): HealthResponse {
  return {
    status: 'ok',
    app: 'cert-prep-backend',
    version: '0.1.0',
    python_version: '3.13.5',
    runtime_mode: 'source',
  };
}

export function availableLlmHealth(): LLMHealthRead {
  return {
    provider: 'fake',
    model: 'reasoner:7b',
    available: true,
    detail: 'deterministic local fake provider',
    unavailable_reason: null,
  };
}

export function emptyWrongAnswerSummary(): WrongAnswerSummaryRead {
  return {
    current_wrong_count: 0,
    cleared_count: 0,
    last_wrong_date: null,
    repeated_misses: [],
    clusters: [],
  };
}

export function buttonByText(
  root: ParentNode,
  text: string,
): HTMLButtonElement | null {
  return (
    Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  );
}
