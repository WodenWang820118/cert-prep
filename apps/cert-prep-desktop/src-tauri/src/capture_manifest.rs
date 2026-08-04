use std::{fs, io::Read, path::Path};

use capture_sidecar_launcher::{
    load_manifest, validate_manifest_contract, verify_sidecar, ManifestExpectations,
    SidecarManifest, VerifiedSidecar,
};
use sha2::{Digest, Sha256};

use crate::constants::{
    CAPTURE_DOCUMENT_SCHEMA_FILE, CAPTURE_DOCUMENT_SCHEMA_SHA256, CAPTURE_DOCUMENT_SCHEMA_VERSION,
    CAPTURE_RUNTIME_API_VERSION, CAPTURE_RUNTIME_BINARY, CAPTURE_RUNTIME_VERSION,
};

pub(crate) type CaptureRuntimeManifest = SidecarManifest;
pub(crate) type VerifiedCaptureRuntime = VerifiedSidecar;

pub(crate) fn load_capture_runtime_manifest(path: &Path) -> Result<CaptureRuntimeManifest, String> {
    load_manifest(path)
}

pub(crate) fn verify_capture_runtime(
    manifest_path: &Path,
    executable_path: &Path,
) -> Result<VerifiedCaptureRuntime, String> {
    let manifest = load_capture_runtime_manifest(manifest_path)?;
    validate_capture_manifest_contract(&manifest)?;
    let verified = verify_sidecar(
        manifest_path,
        executable_path,
        &capture_manifest_expectations(),
    )?;
    let resource_dir = manifest_path
        .parent()
        .ok_or_else(|| "Capture runtime manifest has no resource directory.".to_string())?;
    verify_capture_schema(&resource_dir.join(&manifest.schema_file_name))?;
    Ok(verified)
}

pub(crate) fn validate_capture_manifest_contract(
    manifest: &CaptureRuntimeManifest,
) -> Result<(), String> {
    validate_manifest_contract(manifest, &capture_manifest_expectations())?;
    if manifest.schema_sha256 != CAPTURE_DOCUMENT_SCHEMA_SHA256 {
        return Err(
            "Capture runtime manifest schemaSha256 is incompatible with the pinned schema.".into(),
        );
    }
    Ok(())
}

fn capture_manifest_expectations() -> ManifestExpectations {
    ManifestExpectations {
        runtime_version: CAPTURE_RUNTIME_VERSION.into(),
        api_version: CAPTURE_RUNTIME_API_VERSION.into(),
        capture_document_schema_version: CAPTURE_DOCUMENT_SCHEMA_VERSION.into(),
        file_name: CAPTURE_RUNTIME_BINARY.into(),
        schema_file_name: CAPTURE_DOCUMENT_SCHEMA_FILE.into(),
    }
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
            manifest_version: "1".into(),
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
        for bytes in [1, 512 * 1024 * 1024] {
            let manifest = valid_manifest(bytes, &"0".repeat(64));
            validate_capture_manifest_contract(&manifest).expect("inclusive executable bytes");
        }
        for bytes in [0, 512 * 1024 * 1024 + 1] {
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
