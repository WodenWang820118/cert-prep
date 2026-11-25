/** Bounds for the manual dev-server journey. Each wait in the journey uses one of these. */

export const REAL_ENGINES_TARGET = 'cert-prep-e2e:smoke-real-engines-dev-server';

export const ACTION_TIMEOUT_MS = 30_000;
export const NAVIGATION_TIMEOUT_MS = 60_000;

/** One Capture requirement or the Ollama model install. */
export const INSTALL_TIMEOUT_MS = 60 * 60_000;
/** One PDF or image, from the file input through the saved review. */
export const OCR_TIMEOUT_MS = 10 * 60_000;
/** Recording upload through a ready transcript. */
export const SPEECH_TIMEOUT_MS = 15 * 60_000;
/** Question generation, including the device samples around it. */
export const QUESTION_TIMEOUT_MS = 15 * 60_000;

export const PROCESS_READY_TIMEOUT_MS = 180_000;
export const CLEANUP_WAIT_MS = 35_000;

/** taskkill, where.exe, nvidia-smi -L, and the devices verdict process. */
export const SHORT_COMMAND_TIMEOUT_MS = 15_000;
/** One CIM or PowerShell script: creation time, owned-process walk, worker exit, adapter list. */
export const WINDOWS_SCRIPT_TIMEOUT_MS = 30_000;

/**
 * The device sampler stops if the phase never writes its stop file.
 * The bound is the longest phase budget plus a margin.
 */
const SAMPLE_STOP_MARGIN_MS = 60_000;
export const SAMPLE_STOP_TIMEOUT_MS =
  Math.max(INSTALL_TIMEOUT_MS, OCR_TIMEOUT_MS, SPEECH_TIMEOUT_MS, QUESTION_TIMEOUT_MS) + SAMPLE_STOP_MARGIN_MS;

/** Installs, two OCR documents, speech, questions, and process startup. */
export const JOURNEY_TEST_TIMEOUT_MS =
  3 * INSTALL_TIMEOUT_MS +
  2 * OCR_TIMEOUT_MS +
  SPEECH_TIMEOUT_MS +
  QUESTION_TIMEOUT_MS +
  10 * 60_000;

export const CAPTURE_RUNTIME_API_VERSION = '2.0';
export const CAPTURE_DOCUMENT_SCHEMA_VERSION = '2';
export const DEFAULT_SPEECH_MODEL = 'tea-asr-1.1-mini';
export const RUNTIME_EXECUTABLE = 'capture-runtime-x86_64-pc-windows-msvc.exe';

/** Root length cap so staged engines stay under Windows MAX_PATH. */
export const MAX_ROOT_LENGTH = 48;

export const ENV_ROOT = 'CERT_PREP_REAL_ENGINES_ROOT';
export const ENV_PDF = 'CERT_PREP_REAL_ENGINES_PDF';
export const ENV_IMAGE = 'CERT_PREP_REAL_ENGINES_IMAGE';
export const ENV_RECORDING = 'CERT_PREP_REAL_ENGINES_RECORDING';
export const ENV_SPEECH_MODEL = 'CERT_PREP_REAL_ENGINES_SPEECH_MODEL';
export const ENV_OLLAMA_MODELS = 'CERT_PREP_REAL_ENGINES_OLLAMA_MODELS';
export const ENV_RUN = 'CERT_PREP_REAL_ENGINES_RUN';
export const ENV_API_BASE_URL = 'CERT_PREP_REAL_ENGINES_API_BASE_URL';
export const ENV_API_TOKEN = 'CERT_PREP_API_TOKEN';
export const ENV_RUNTIME_PID = 'CERT_PREP_REAL_ENGINES_RUNTIME_PID';
export const ENV_ENGINE_ROOT = 'CERT_PREP_REAL_ENGINES_ENGINE_ROOT';
export const ENV_OLLAMA_PORT = 'CERT_PREP_REAL_ENGINES_OLLAMA_PORT';
export const ENV_ADAPTERS = 'CERT_PREP_REAL_ENGINES_ADAPTERS';
export const ENV_DEVICES_CLI = 'CERT_PREP_REAL_ENGINES_DEVICES_CLI';
export const ENV_RUNTIME_VERSION = 'CERT_PREP_REAL_ENGINES_RUNTIME_VERSION';
export const ENV_PLAYWRIGHT_OUTPUT = 'CERT_PREP_REAL_ENGINES_PLAYWRIGHT_OUTPUT';
export const ENV_BASE_URL = 'BASE_URL';
