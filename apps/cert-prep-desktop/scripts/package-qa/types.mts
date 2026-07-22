export interface PackageQaOptions {
  readonly workspaceRoot?: string;
  readonly bundleRoot?: string;
  readonly packagedResourceRoot?: string;
  readonly tauriConfig?: string;
  readonly expectedTargetTriple?: string;
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

type SizeGateStatus = 'passed' | 'warning' | 'failed';

export interface SizeGate {
  readonly status: SizeGateStatus;
  readonly largest_initial_mb: number;
  readonly warning_mb: number;
  readonly error_mb: number;
  readonly detail: string;
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

export interface CaptureRuntimeManifest {
  readonly manifestVersion: string;
  readonly runtimeVersion: string;
  readonly apiVersion: string;
  readonly captureDocumentSchemaVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly schemaFileName: string;
  readonly schemaSha256: string;
  readonly runtimeRequirements: {
    readonly 'windowsml-ocr': {
      readonly artifactUrl: string;
      readonly artifactFileName: string;
      readonly bytes: number;
      readonly sha256: string;
    };
  };
}

export interface PackageQaReport {
  readonly schema_version: 3;
  readonly generated_at: string;
  readonly assessment: {
    readonly status: 'blocked';
    readonly evidence_scope: 'static_tauri_release_resources';
    readonly blockers: readonly [
      'installer_contents_not_verified',
      'fresh_install_not_verified',
    ];
  };
  readonly target: {
    readonly rust_triple: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly package: {
    readonly bundle_root: string;
    readonly bundle_artifacts: PublicFileRecord[];
    readonly packaged_resource_root: string;
    readonly resource_contract: PackagedResourceContract;
    readonly size_gate: SizeGate;
  };
}

export interface ParsedArgs {
  output?: string;
  bundleRoot?: string;
  packagedResourceRoot?: string;
  tauriConfig?: string;
  expectedTargetTriple?: string;
}

export interface PackagedResourceContract {
  readonly evidence_scope: 'static_tauri_release_resources';
  readonly installer_contents_verified: false;
  readonly fresh_install_verified: false;
  readonly alpha_release_gate: 'blocked_pending_clean_install';
  readonly backend_bundled: true;
  readonly windowsml_ocr_bundled: false;
  readonly capture_runtime_bundled: true;
  readonly capture_runtime_version: '0.1.0';
  readonly capture_runtime_api_version: '1.0';
  readonly capture_document_schema_version: '1';
  readonly capture_structuring_mode: 'host';
  readonly release_urls_only: true;
  readonly version: '0.1.0-alpha.1';
  readonly python_runtime_version: '3.12';
  readonly channel: 'unsigned_public_alpha';
  readonly signed: false;
  readonly target: string;
  readonly tauri_resource_mapping: 'generated-resources/* -> resources/ plus legal/*';
  readonly resource_files: PublicFileRecord[];
  readonly legal_files: PublicFileRecord[];
}
