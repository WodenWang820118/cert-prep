use std::{fs, io::Read, path::Path};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct RuntimeManifest {
    pub(crate) kind: String,
    pub(crate) version: String,
    pub(crate) target: String,
    pub(crate) entrypoint: String,
    pub(crate) artifact: RuntimeArtifact,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct RuntimeArtifact {
    pub(crate) file_name: String,
    pub(crate) sha256: String,
    pub(crate) bytes: u64,
    pub(crate) url: Option<String>,
}

pub(crate) fn load_runtime_manifest(path: &Path) -> Result<RuntimeManifest, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "failed to read runtime manifest {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_str(&content).map_err(|error| {
        format!(
            "failed to parse runtime manifest {}: {error}",
            path.display()
        )
    })
}

pub(crate) fn write_installed_manifest(
    runtime_dir: &Path,
    manifest: &RuntimeManifest,
) -> Result<(), String> {
    let path = runtime_dir.join("runtime-manifest.json");
    let content = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("failed to serialize runtime manifest: {error}"))?;
    fs::write(path, format!("{content}\n"))
        .map_err(|error| format!("failed to write installed runtime manifest: {error}"))
}

/// Verifies a runtime artifact against the bundled manifest's byte count and SHA-256 digest.
pub(crate) fn verify_artifact(path: &Path, artifact: &RuntimeArtifact) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| {
        format!(
            "failed to stat runtime artifact {}: {error}",
            path.display()
        )
    })?;
    if metadata.len() != artifact.bytes {
        return Err(format!(
            "runtime artifact size mismatch: expected {}, found {}",
            artifact.bytes,
            metadata.len()
        ));
    }

    let digest = sha256_file(path)?;
    if digest.to_lowercase() != artifact.sha256.to_lowercase() {
        return Err("runtime artifact checksum mismatch.".into());
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| {
        format!(
            "failed to open runtime artifact {}: {error}",
            path.display()
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to read runtime artifact: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn sha256_file_hashes_artifact_bytes() {
        let path =
            std::env::temp_dir().join(format!("exam-prep-hash-{}.txt", uuid::Uuid::new_v4()));
        let mut file = fs::File::create(&path).expect("temp file");
        file.write_all(b"runtime").expect("write");

        assert_eq!(
            sha256_file(&path).expect("hash"),
            "d92c6a81b2ff50096bcda80885427d1f59a25b5f483f7055523504925d16ab23"
        );

        let _ = fs::remove_file(path);
    }
}
