use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::constants::{
    CAPTURE_DOCUMENT_SCHEMA_FILE, CAPTURE_DOCUMENT_SCHEMA_SHA256, CAPTURE_DOCUMENT_SCHEMA_VERSION,
    CAPTURE_RUNTIME_API_VERSION, CAPTURE_RUNTIME_BINARY, CAPTURE_RUNTIME_MANIFEST_VERSION,
    CAPTURE_RUNTIME_MAX_BYTES, CAPTURE_RUNTIME_VERSION,
};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureRuntimeManifest {
    pub manifest_version: String,
    pub runtime_version: String,
    pub api_version: String,
    pub capture_document_schema_version: String,
    pub platform: String,
    pub arch: String,
    pub file_name: String,
    pub bytes: u64,
    pub sha256: String,
    pub schema_file_name: String,
    pub schema_sha256: String,
}

#[derive(Debug, Clone)]
pub(crate) struct VerifiedCaptureRuntime {
    pub manifest: CaptureRuntimeManifest,
    pub executable_path: PathBuf,
}

pub(crate) fn load_capture_runtime_manifest(path: &Path) -> Result<CaptureRuntimeManifest, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "Capture runtime manifest is unavailable at {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Capture runtime manifest is invalid JSON: {error}"))
}

pub(crate) fn verify_capture_runtime(
    manifest_path: &Path,
    executable_path: &Path,
) -> Result<VerifiedCaptureRuntime, String> {
    let manifest = load_capture_runtime_manifest(manifest_path)?;
    validate_capture_manifest_contract(&manifest)?;
    verify_capture_artifact(executable_path, &manifest)?;
    let resource_dir = manifest_path
        .parent()
        .ok_or_else(|| "Capture runtime manifest has no resource directory.".to_string())?;
    verify_capture_schema(&resource_dir.join(&manifest.schema_file_name))?;
    Ok(VerifiedCaptureRuntime {
        manifest,
        executable_path: executable_path.to_path_buf(),
    })
}

pub(crate) fn validate_capture_manifest_contract(
    manifest: &CaptureRuntimeManifest,
) -> Result<(), String> {
    expect_field(
        "manifestVersion",
        &manifest.manifest_version,
        CAPTURE_RUNTIME_MANIFEST_VERSION,
    )?;
    expect_field(
        "runtimeVersion",
        &manifest.runtime_version,
        CAPTURE_RUNTIME_VERSION,
    )?;
    expect_field(
        "apiVersion",
        &manifest.api_version,
        CAPTURE_RUNTIME_API_VERSION,
    )?;
    expect_field(
        "captureDocumentSchemaVersion",
        &manifest.capture_document_schema_version,
        CAPTURE_DOCUMENT_SCHEMA_VERSION,
    )?;
    expect_field("platform", &manifest.platform, "windows")?;
    expect_field("arch", &manifest.arch, "x86_64")?;
    expect_field("fileName", &manifest.file_name, CAPTURE_RUNTIME_BINARY)?;

    if !safe_file_name(&manifest.file_name) {
        return Err("Capture runtime manifest fileName must be a plain file name.".into());
    }
    if !(1..=CAPTURE_RUNTIME_MAX_BYTES).contains(&manifest.bytes) {
        return Err("Capture runtime executable bytes must be between 1 and 536870912.".into());
    }
    validate_sha256("sha256", &manifest.sha256)?;

    expect_field(
        "schemaFileName",
        &manifest.schema_file_name,
        CAPTURE_DOCUMENT_SCHEMA_FILE,
    )?;
    if !safe_file_name(&manifest.schema_file_name) {
        return Err("Capture runtime manifest schemaFileName must be a plain file name.".into());
    }
    expect_field(
        "schemaSha256",
        &manifest.schema_sha256,
        CAPTURE_DOCUMENT_SCHEMA_SHA256,
    )?;
    Ok(())
}

fn expect_field(name: &str, actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "Capture runtime {name} is incompatible: expected {expected}, found {actual}."
        ))
    }
}

fn safe_file_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains(['/', '\\', ':'])
        && Path::new(value)
            .file_name()
            .is_some_and(|name| name == value)
}

fn validate_sha256(name: &str, value: &str) -> Result<(), String> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!(
            "Capture runtime manifest {name} must contain 64 hexadecimal characters."
        ))
    }
}

fn verify_capture_artifact(path: &Path, manifest: &CaptureRuntimeManifest) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| {
        format!(
            "Capture runtime executable is unavailable at {}: {error}",
            path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err("Capture runtime executable is not a regular file.".into());
    }
    if metadata.len() != manifest.bytes {
        return Err(format!(
            "Capture runtime byte count mismatch: expected {}, found {}.",
            manifest.bytes,
            metadata.len()
        ));
    }

    let digest = sha256_file(path)?;
    if !digest.eq_ignore_ascii_case(&manifest.sha256) {
        return Err("Capture runtime SHA-256 mismatch.".into());
    }
    Ok(())
}

fn verify_capture_schema(path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| {
        format!(
            "Capture document schema is unavailable at {}: {error}",
            path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err("Capture document schema is not a regular file.".into());
    }
    let digest = sha256_file(path)?;
    if digest != CAPTURE_DOCUMENT_SCHEMA_SHA256 {
        return Err("Capture document schema SHA-256 mismatch.".into());
    }
    let content = fs::read(path)
        .map_err(|error| format!("Capture document schema cannot be read: {error}"))?;
    let schema: serde_json::Value = serde_json::from_slice(&content)
        .map_err(|error| format!("Capture document schema is invalid JSON: {error}"))?;
    if schema.get("$schema").and_then(serde_json::Value::as_str)
        != Some("https://json-schema.org/draft/2020-12/schema")
        || schema.get("title").and_then(serde_json::Value::as_str) != Some("CaptureDocumentV1")
        || schema.get("type").and_then(serde_json::Value::as_str) != Some("object")
        || schema
            .get("additionalProperties")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
        || schema
            .pointer("/properties/schemaVersion/const")
            .and_then(serde_json::Value::as_str)
            != Some(CAPTURE_DOCUMENT_SCHEMA_VERSION)
    {
        return Err(
            "Capture document schema does not declare the pinned CaptureDocumentV1 contract."
                .into(),
        );
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Capture runtime executable cannot be opened: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Capture runtime executable cannot be read: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANONICAL_SCHEMA_LF: &str =
        include_str!("../../test-fixtures/capture-document-v1.schema.json");

    fn canonical_schema_bytes() -> Vec<u8> {
        CANONICAL_SCHEMA_LF
            .replace("\r\n", "\n")
            .replace('\n', "\r\n")
            .into_bytes()
    }

    fn valid_manifest(bytes: u64, sha256: &str) -> CaptureRuntimeManifest {
        CaptureRuntimeManifest {
            manifest_version: CAPTURE_RUNTIME_MANIFEST_VERSION.into(),
            runtime_version: CAPTURE_RUNTIME_VERSION.into(),
            api_version: CAPTURE_RUNTIME_API_VERSION.into(),
            capture_document_schema_version: CAPTURE_DOCUMENT_SCHEMA_VERSION.into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            file_name: CAPTURE_RUNTIME_BINARY.into(),
            bytes,
            sha256: sha256.into(),
            schema_file_name: CAPTURE_DOCUMENT_SCHEMA_FILE.into(),
            schema_sha256: CAPTURE_DOCUMENT_SCHEMA_SHA256.into(),
        }
    }

    #[test]
    fn pinned_manifest_and_artifact_are_verified_together() {
        let root = std::env::temp_dir().join(format!(
            "cert-prep-capture-manifest-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("temp root");
        let executable = root.join(CAPTURE_RUNTIME_BINARY);
        let schema = root.join(CAPTURE_DOCUMENT_SCHEMA_FILE);
        let manifest_path = root.join("capture-runtime-manifest.json");
        fs::write(&executable, b"deterministic capture runtime").expect("runtime");
        let canonical_schema = canonical_schema_bytes();
        fs::write(&schema, &canonical_schema).expect("schema");
        let digest = format!("{:x}", Sha256::digest(b"deterministic capture runtime"));
        assert_eq!(
            format!("{:x}", Sha256::digest(&canonical_schema)),
            CAPTURE_DOCUMENT_SCHEMA_SHA256
        );
        let manifest = valid_manifest(29, &digest);
        fs::write(
            &manifest_path,
            serde_json::to_vec(&manifest).expect("manifest"),
        )
        .expect("manifest file");

        let verified =
            verify_capture_runtime(&manifest_path, &executable).expect("verified runtime");

        assert_eq!(verified.manifest, manifest);
        assert_eq!(verified.executable_path, executable);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn executable_bytes_accept_only_the_shared_inclusive_bounds() {
        for bytes in [1, CAPTURE_RUNTIME_MAX_BYTES] {
            let manifest = valid_manifest(bytes, &"0".repeat(64));
            validate_capture_manifest_contract(&manifest).expect("inclusive executable bytes");
        }
        for bytes in [0, CAPTURE_RUNTIME_MAX_BYTES + 1] {
            let manifest = valid_manifest(bytes, &"0".repeat(64));
            let error = validate_capture_manifest_contract(&manifest)
                .expect_err("out-of-range executable bytes");
            assert!(error.contains("executable bytes must be between"));
        }
    }

    #[test]
    fn version_schema_path_and_digest_drift_fail_closed() {
        let mut manifest = valid_manifest(1, &"0".repeat(64));
        manifest.runtime_version = "0.2.0".into();
        assert!(validate_capture_manifest_contract(&manifest)
            .expect_err("runtime version")
            .contains("runtimeVersion"));

        manifest.runtime_version = CAPTURE_RUNTIME_VERSION.into();
        manifest.capture_document_schema_version = "2".into();
        assert!(validate_capture_manifest_contract(&manifest)
            .expect_err("schema")
            .contains("captureDocumentSchemaVersion"));

        manifest.capture_document_schema_version = CAPTURE_DOCUMENT_SCHEMA_VERSION.into();
        manifest.file_name = "../capture-runtime.exe".into();
        assert!(validate_capture_manifest_contract(&manifest).is_err());

        manifest.file_name = CAPTURE_RUNTIME_BINARY.into();
        manifest.schema_file_name = "../capture-document-v1.schema.json".into();
        assert!(validate_capture_manifest_contract(&manifest)
            .expect_err("schema path")
            .contains("schemaFileName"));

        manifest.schema_file_name = CAPTURE_DOCUMENT_SCHEMA_FILE.into();
        manifest.schema_sha256 = "1".repeat(64);
        assert!(validate_capture_manifest_contract(&manifest)
            .expect_err("schema trust anchor")
            .contains("schemaSha256"));

        manifest.schema_sha256 = CAPTURE_DOCUMENT_SCHEMA_SHA256.into();
    }

    #[test]
    fn schema_trust_anchor_rejects_self_signed_truncation_and_critical_mutation() {
        let canonical = canonical_schema_bytes();
        let mut truncated = canonical.clone();
        truncated.truncate(truncated.len() - 2);
        let mut manifest = valid_manifest(1, &"0".repeat(64));
        manifest.schema_sha256 = format!("{:x}", Sha256::digest(&truncated));
        assert!(validate_capture_manifest_contract(&manifest)
            .expect_err("self-signed truncation")
            .contains("schemaSha256"));

        let mut changed: serde_json::Value =
            serde_json::from_slice(&canonical).expect("canonical JSON");
        changed["additionalProperties"] = serde_json::Value::Bool(true);
        let changed_bytes = serde_json::to_vec_pretty(&changed).expect("changed schema");
        manifest.schema_sha256 = format!("{:x}", Sha256::digest(&changed_bytes));
        assert!(validate_capture_manifest_contract(&manifest)
            .expect_err("self-signed critical mutation")
            .contains("schemaSha256"));
    }

    #[test]
    fn missing_or_tampered_schema_fails_closed() {
        let root =
            std::env::temp_dir().join(format!("cert-prep-capture-schema-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp root");
        let executable = root.join(CAPTURE_RUNTIME_BINARY);
        let manifest_path = root.join("capture-runtime-manifest.json");
        fs::write(&executable, b"runtime").expect("runtime");
        let runtime_digest = format!("{:x}", Sha256::digest(b"runtime"));
        let manifest = valid_manifest(7, &runtime_digest);
        fs::write(
            &manifest_path,
            serde_json::to_vec(&manifest).expect("manifest"),
        )
        .expect("manifest file");

        assert!(verify_capture_runtime(&manifest_path, &executable)
            .expect_err("missing schema")
            .contains("schema is unavailable"));

        fs::write(root.join(CAPTURE_DOCUMENT_SCHEMA_FILE), b"{}").expect("schema");
        assert!(verify_capture_runtime(&manifest_path, &executable)
            .expect_err("schema digest")
            .contains("schema SHA-256 mismatch"));
        let _ = fs::remove_dir_all(root);
    }
}
