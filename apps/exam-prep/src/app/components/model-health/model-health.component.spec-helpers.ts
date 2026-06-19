import type {
  HealthResponse,
  LLMHealthRead,
  OCRHealthRead,
} from '../../exam-prep-api';

export function systemHealth(): HealthResponse {
  return {
    status: 'ok',
    app: 'exam-prep-backend',
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

export function missingModelHealth(): LLMHealthRead & {
  unavailable_reason: string;
} {
  return {
    provider: 'ollama',
    model: 'reasoner:7b',
    available: false,
    detail: 'Ollama model reasoner:7b is missing.',
    unavailable_reason: 'model_missing',
  };
}

export function ocrHealth(): OCRHealthRead {
  return {
    provider: 'paddle',
    engine: 'paddleocr',
    available: true,
    detail: 'Ready',
    python_version: '3.13.5',
    paddle_version: null,
    paddleocr_version: null,
    selected_device: 'cpu',
    cuda_available: false,
    gpu_count: 0,
    model_cache_dir: null,
    fallback_reason: null,
    unavailable_reason: null,
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
