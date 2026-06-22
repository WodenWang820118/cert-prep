export interface PackageQaOptions {
  readonly workspaceRoot?: string;
  readonly bundleRoot?: string;
  readonly backendRuntimeRoot?: string;
  readonly backendRuntimeManifest?: string;
  readonly backendRuntimeEntrypoint?: string;
  readonly ocrRuntimeRoot?: string;
  readonly ocrRuntimeManifest?: string;
  readonly directmlOcrRuntimeRoot?: string;
  readonly directmlOcrRuntimeManifest?: string;
  readonly expectedTargetTriple?: string;
  readonly healthTimeoutMs?: number;
  readonly dataDir?: string;
  readonly llmModel?: string;
  readonly ocrPageWorkers?: number;
}

export interface RuntimeHealthOptions {
  readonly backendRuntimeEntrypoint: string;
  readonly workspaceRoot?: string;
  readonly timeoutMs?: number;
  readonly dataDir?: string;
  readonly llmModel?: string;
  readonly ocrRuntimeManifest?: string;
  readonly directmlOcrRuntimeManifest?: string;
  readonly ocrPageWorkers?: number;
}

export interface FileRecord {
  readonly absolutePath: string;
  readonly path: string;
  readonly bytes: number;
  readonly mb: number;
}

export interface PublicFileRecord {
  readonly path: string;
  readonly bytes: number;
  readonly mb: number;
}

export type SizeGateStatus = 'passed' | 'warning' | 'failed';

export interface SizeGate {
  readonly status: SizeGateStatus;
  readonly largest_initial_mb: number;
  readonly warning_mb: number;
  readonly error_mb: number;
  readonly detail: string;
}

export interface OcrHealthSummary {
  readonly provider: unknown;
  readonly engine: unknown;
  readonly available: unknown;
  readonly detail: unknown;
  readonly selected_device: unknown;
  readonly cuda_available: unknown;
  readonly gpu_count: unknown;
  readonly fallback_reason: unknown;
  readonly unavailable_reason: unknown;
}

export interface LlmHealthSummary {
  readonly provider: unknown;
  readonly model: unknown;
  readonly available: unknown;
  readonly detail: unknown;
  readonly unavailable_reason: unknown;
}

export interface RuntimeHealthSummary {
  readonly launch_env: {
    readonly EXAM_PREP_OCR_PROVIDER: 'directml' | 'paddle';
    readonly EXAM_PREP_OCR_RUNTIME_MODE: 'external';
    readonly EXAM_PREP_OCR_DEVICE: 'auto';
    readonly EXAM_PREP_OCR_RUNTIME_MANIFEST_PATH: string;
    readonly EXAM_PREP_OCR_DIRECTML_DEVICE_ID: '-1';
    readonly EXAM_PREP_DIRECTML_OCR_RUNTIME_MANIFEST_PATH: string;
    readonly EXAM_PREP_LLM_PROVIDER: 'ollama';
    readonly EXAM_PREP_OLLAMA_MODEL: string;
    readonly EXAM_PREP_STREAMING_DRAFT_GENERATION_ON_UPLOAD: 'true';
    readonly EXAM_PREP_OCR_PAGE_WORKERS: string | null;
  };
  readonly system_health: unknown;
  readonly ocr_health: OcrHealthSummary;
  readonly llm_health: LlmHealthSummary;
  readonly raw_health: {
    readonly ocr: JsonRecord;
    readonly llm: JsonRecord;
  };
  readonly backend_output_tail: OutputCapture;
}

export interface RuntimeManifest {
  readonly kind: string;
  readonly version: string;
  readonly target: string;
  readonly entrypoint: string;
  readonly artifact: {
    readonly file_name: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly url?: string | null;
  };
}

export interface RuntimeManifestSummary {
  readonly kind: string;
  readonly version: string;
  readonly target: string;
  readonly entrypoint: string;
  readonly url: string | null;
  readonly manifest: PublicFileRecord;
  readonly artifact: PublicFileRecord;
}

export interface PackageQaReport {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly target: {
    readonly rust_triple: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly package: {
    readonly bundle_root: string;
    readonly bundle_artifacts: PublicFileRecord[];
    readonly backend_runtime_root: string;
    readonly backend_runtime_manifest: RuntimeManifestSummary;
    readonly backend_runtime_artifacts: PublicFileRecord[];
    readonly ocr_runtime_root: string;
    readonly ocr_runtime_manifest: RuntimeManifestSummary;
    readonly ocr_runtime_artifacts: PublicFileRecord[];
    readonly directml_ocr_runtime_root: string;
    readonly directml_ocr_runtime_manifest: RuntimeManifestSummary;
    readonly directml_ocr_runtime_artifacts: PublicFileRecord[];
    readonly size_gate: SizeGate;
  };
  readonly runtime: RuntimeHealthSummary;
}

export interface OutputCapture {
  stdout: string;
  stderr: string;
}

export interface ChildState {
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface WaitForJsonOptions {
  readonly state: ChildState;
  readonly output: OutputCapture;
  readonly timeoutMs: number;
}

export interface ParsedArgs {
  output?: string;
  bundleRoot?: string;
  backendRuntimeRoot?: string;
  backendRuntimeManifest?: string;
  backendRuntimeEntrypoint?: string;
  ocrRuntimeRoot?: string;
  ocrRuntimeManifest?: string;
  directmlOcrRuntimeRoot?: string;
  directmlOcrRuntimeManifest?: string;
  expectedTargetTriple?: string;
  healthTimeoutMs?: number;
  ocrPageWorkers?: number;
}

export type JsonRecord = Record<string, unknown>;

export interface RuntimeLaunchEnvOptions {
  readonly port: number;
  readonly token: string;
  readonly dataDir: string;
  readonly llmModel: string;
  readonly ocrRuntimeManifest: string;
  readonly directmlOcrRuntimeManifest: string;
  readonly ocrProvider?: 'directml' | 'paddle';
  readonly ocrPageWorkers?: number;
  readonly baseEnv?: NodeJS.ProcessEnv;
}

export interface RuntimeManifestValidationOptions {
  readonly manifestPath: string;
  readonly runtimeRoot: string;
  readonly workspaceRoot?: string;
  readonly expectedKind: string;
  readonly artifactPrefix: string;
}
