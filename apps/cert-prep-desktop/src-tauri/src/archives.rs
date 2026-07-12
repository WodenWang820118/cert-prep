use std::{
    fs::{self, OpenOptions},
    io,
    path::{Component, Path},
};

use zip::ZipArchive;

const MAX_RUNTIME_ARCHIVE_ENTRIES: usize = 10_000;
const MAX_EXTRACTED_RUNTIME_BYTES: u64 = 1024 * 1024 * 1024;

/// Extracts a trusted-by-digest runtime ZIP without invoking a shell.
///
/// Every archive path must be a plain relative path. Links, special files,
/// alternate data stream names, duplicate files, traversal, and oversized
/// archives are rejected before they can escape or mutate the destination.
pub(crate) fn extract_zip(artifact: &Path, destination: &Path) -> Result<(), String> {
    let file = fs::File::open(artifact).map_err(|error| {
        format!(
            "failed to open runtime artifact {}: {error}",
            artifact.display()
        )
    })?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| format!("failed to read runtime ZIP: {error}"))?;
    if archive.len() > MAX_RUNTIME_ARCHIVE_ENTRIES {
        return Err(format!(
            "runtime ZIP has too many entries: {}",
            archive.len()
        ));
    }

    let total_bytes = (0..archive.len()).try_fold(0_u64, |total, index| {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("failed to inspect runtime ZIP entry: {error}"))?;
        total
            .checked_add(entry.size())
            .ok_or_else(|| "runtime ZIP expanded size overflowed.".to_string())
    })?;
    if total_bytes > MAX_EXTRACTED_RUNTIME_BYTES {
        return Err(format!(
            "runtime ZIP expands to {total_bytes} bytes, above the safety limit."
        ));
    }

    fs::create_dir_all(destination)
        .map_err(|error| format!("failed to create runtime extraction directory: {error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("failed to read runtime ZIP entry: {error}"))?;
        let relative_path = safe_entry_path(&entry)?;
        let output_path = destination.join(relative_path);

        if entry.is_dir() {
            fs::create_dir_all(&output_path)
                .map_err(|error| format!("failed to create runtime directory: {error}"))?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create runtime directory: {error}"))?;
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output_path)
            .map_err(|error| {
                format!(
                    "failed to create runtime file {}: {error}",
                    output_path.display()
                )
            })?;
        io::copy(&mut entry, &mut output)
            .map_err(|error| format!("failed to extract runtime file: {error}"))?;
    }
    Ok(())
}

fn safe_entry_path(entry: &zip::read::ZipFile<'_>) -> Result<std::path::PathBuf, String> {
    let name = entry.name();
    if name.contains('\\') {
        return Err(format!("runtime ZIP entry uses an unsafe separator: {name}"));
    }
    if entry.unix_mode().is_some_and(|mode| {
        let file_type = mode & 0o170000;
        !matches!(file_type, 0 | 0o040000 | 0o100000)
    }) {
        return Err(format!("runtime ZIP entry is a link or special file: {name}"));
    }
    let enclosed = entry
        .enclosed_name()
        .ok_or_else(|| format!("runtime ZIP entry escapes the destination: {name}"))?;
    if enclosed.as_os_str().is_empty()
        || enclosed.components().any(|component| match component {
            Component::Normal(value) => value.to_string_lossy().contains(':'),
            _ => true,
        })
    {
        return Err(format!("runtime ZIP entry path is unsafe: {name}"));
    }
    Ok(enclosed.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use zip::write::SimpleFileOptions;

    #[test]
    fn extracts_regular_files_without_shelling_out() {
        let root = temp_root();
        let archive = root.join("runtime.zip");
        write_zip(&archive, "bin/backend.exe", b"runtime", 0o100644);
        let destination = root.join("extract");

        extract_zip(&archive, &destination).expect("extract runtime");

        let mut content = String::new();
        fs::File::open(destination.join("bin/backend.exe"))
            .expect("entrypoint")
            .read_to_string(&mut content)
            .expect("read entrypoint");
        assert_eq!(content, "runtime");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_parent_traversal_entries() {
        let root = temp_root();
        let archive = root.join("runtime.zip");
        write_zip(&archive, "../escape.exe", b"runtime", 0o100644);

        let error = extract_zip(&archive, &root.join("extract")).expect_err("reject traversal");

        assert!(error.contains("escapes the destination"));
        assert!(!root.join("escape.exe").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_symbolic_link_entries() {
        let root = temp_root();
        let archive = root.join("runtime.zip");
        let file = fs::File::create(&archive).expect("archive");
        let mut writer = zip::ZipWriter::new(file);
        writer
            .add_symlink(
                "backend-link",
                "backend.exe",
                SimpleFileOptions::default(),
            )
            .expect("symlink entry");
        writer.finish().expect("finish zip");

        let error = extract_zip(&archive, &root.join("extract")).expect_err("reject symlink");

        assert!(error.contains("link or special file"));
        let _ = fs::remove_dir_all(root);
    }

    fn temp_root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "cert-prep-archive-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("temp root");
        root
    }

    fn write_zip(path: &Path, name: &str, content: &[u8], mode: u32) {
        let file = fs::File::create(path).expect("archive");
        let mut writer = zip::ZipWriter::new(file);
        writer
            .start_file(name, SimpleFileOptions::default().unix_permissions(mode))
            .expect("zip entry");
        writer.write_all(content).expect("zip content");
        writer.finish().expect("finish zip");
    }
}
