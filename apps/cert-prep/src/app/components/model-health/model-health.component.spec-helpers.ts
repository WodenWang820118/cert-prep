import type {
  HealthResponse,
  LLMHealthRead,
  OCRHealthRead,
} from '../../cert-prep-api';

export function systemHealth(): HealthResponse {
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

export function cpuExecutionLlmHealth(
  overrides: Partial<LLMHealthRead> = {},
): LLMHealthRead {
  return {
    provider: 'ollama',
    model: 'qwen3.5:4b',
    available: true,
    detail: 'model available',
    unavailable_reason: null,
    configured_model: 'qwen3.5:4b',
    effective_model: 'qwen3.5:4b',
    fallback_models: [],
    fallback_reason: null,
    execution_mode: 'cpu',
    execution_warning:
      'GPU acceleration conditions were not met; Ollama is using CPU.',
    ...overrides,
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

export function cpuFallbackOcrHealth(): OCRHealthRead {
  return {
    ...ocrHealth(),
    provider: 'windowsml',
    engine: 'paddleocr-3.7-onnxruntime-windowsml',
    detail: 'WindowsML OCR is ready in CPU fallback mode.',
    selected_device: 'cpu',
    fallback_reason:
      'WindowsML acceleration was not confirmed; using CPU OCR. OCR may be slower.',
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
