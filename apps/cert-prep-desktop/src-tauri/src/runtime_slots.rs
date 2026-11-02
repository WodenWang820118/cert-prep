//! Versioned install slots for the bundled runtimes under `<app data>/runtimes`.
//!
//! An app update ships new bundled runtimes, but the copies the user already
//! installed into app data stay behind. Each slot records which bundle its
//! active copy came from (the SHA-256 of the bundled manifest) in a marker
//! file next to it. A changed bundle is installed into a new directory,
//! verified there, and only then made active by atomically replacing the
//! marker. The previous copy is removed afterwards, and only when no process
//! is running from it; otherwise a later sweep removes it.
//!
//! Slots own nothing outside their own names in `runtimes`: downloaded Capture
//! engines (`capture-workbench/`) and user data stay untouched.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::constants::{BACKEND_RUNTIME_DIR, CAPTURE_RUNTIME_DIR};

const RUNTIMES_DIR: &str = "runtimes";
const MARKER_SUFFIX: &str = ".current.json";
/// Hex digits of the bundle identity used in a versioned directory name.
/// Short on purpose: the Python backend runs from deep paths under it.
const DIRECTORY_IDENTITY_DIGITS: usize = 8;

#[derive(Debug, Clone, Copy)]
pub(crate) struct RuntimeSlot {
    /// Slot name. It is also the fixed directory used before markers existed.
    name: &'static str,
    staging_prefix: &'static str,
    retired_prefix: &'static str,
}

/// The staging and retired prefixes are the ones the pre-marker installers
/// used, so a sweep also removes their leftovers.
pub(crate) const CAPTURE_RUNTIME_SLOT: RuntimeSlot = RuntimeSlot {
    name: CAPTURE_RUNTIME_DIR,
    staging_prefix: ".capture-runtime-install-",
    retired_prefix: ".capture-runtime-backup-",
};

pub(crate) const PYTHON_BACKEND_SLOT: RuntimeSlot = RuntimeSlot {
    name: BACKEND_RUNTIME_DIR,
    staging_prefix: ".python-backend-install-",
    retired_prefix: ".python-backend-backup-",
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SlotMarker {
    directory: String,
    bundle_manifest_sha256: String,
}

/// Stable identity of a bundled runtime: the SHA-256 of its manifest bytes.
/// The manifest pins the artifact digest, so any runtime change changes it.
pub(crate) fn bundle_identity(manifest_path: &Path) -> Result<String, String> {
    let bytes = fs::read(manifest_path).map_err(|error| {
        format!(
            "Bundled runtime manifest {} cannot be read: {error}",
            manifest_path.display()
        )
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

impl RuntimeSlot {
    /// Directory of the active installed copy. With `expected_identity`, a
    /// copy from another bundle (or a pre-marker copy, whose bundle is
    /// unknown) does not count. Without it, any installed copy counts.
    pub(crate) fn installed_dir(
        &self,
        data_dir: &Path,
        expected_identity: Option<&str>,
    ) -> Option<PathBuf> {
        let (dir, identity) = self.active(&runtimes_root(data_dir))?;
        match expected_identity {
            None => Some(dir),
            Some(expected) if identity.as_deref() == Some(expected) => Some(dir),
            Some(_) => None,
        }
    }

    /// True when the user installed this runtime earlier, but from a bundle
    /// other than `expected_identity`, so it must be installed again.
    pub(crate) fn needs_refresh(&self, data_dir: &Path, expected_identity: &str) -> bool {
        self.installed_dir(data_dir, None).is_some()
            && self
                .installed_dir(data_dir, Some(expected_identity))
                .is_none()
    }

    /// Installs a new copy: `populate` fills and verifies a staging
    /// directory, which then becomes a new versioned directory and the
    /// marker is switched to it. On any error the previous copy and marker
    /// stay active. Returns the new active directory.
    pub(crate) fn install(
        &self,
        data_dir: &Path,
        identity: &str,
        populate: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<PathBuf, String> {
        if !is_sha256(identity) {
            return Err(format!(
                "Runtime bundle identity is not a SHA-256: {identity}"
            ));
        }
        let root = runtimes_root(data_dir);
        fs::create_dir_all(&root)
            .map_err(|error| format!("Runtime install root could not be created: {error}"))?;
        self.sweep_root(&root);
        let previous = self.active(&root).map(|(dir, _)| dir);

        let staging = root.join(format!("{}{}", self.staging_prefix, uuid::Uuid::new_v4()));
        fs::create_dir_all(&staging)
            .map_err(|error| format!("Runtime staging directory could not be created: {error}"))?;
        if let Err(error) = populate(&staging) {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }

        let directory = self.free_directory_name(&root, identity);
        let target = root.join(&directory);
        if let Err(error) = fs::rename(&staging, &target) {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!(
                "Runtime installation could not be finalized: {error}"
            ));
        }
        if let Err(error) = self.write_marker(&root, &directory, identity) {
            let _ = fs::remove_dir_all(&target);
            return Err(error);
        }
        if let Some(previous) = previous {
            retire_directory(&previous, &root, self.retired_prefix);
        }
        Ok(target)
    }

    /// Removes leftovers: interrupted staging, retired copies, marker temp
    /// files, and inactive copies no process is running from. Best effort;
    /// anything still in use is retried by the next sweep.
    pub(crate) fn sweep(&self, data_dir: &Path) {
        let root = runtimes_root(data_dir);
        if root.is_dir() {
            self.sweep_root(&root);
        }
    }

    fn sweep_root(&self, root: &Path) {
        let active = self.active(root).map(|(dir, _)| dir);
        let Ok(entries) = fs::read_dir(root) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let path = entry.path();
            if file_type.is_file() {
                if self.is_marker_temp_name(&name) {
                    let _ = fs::remove_file(&path);
                }
                continue;
            }
            if !file_type.is_dir() {
                continue;
            }
            if has_uuid_suffix(&name, self.staging_prefix)
                || has_uuid_suffix(&name, self.retired_prefix)
            {
                let _ = fs::remove_dir_all(&path);
            } else if (name == self.name || self.is_versioned_name(&name))
                && active.as_deref() != Some(path.as_path())
            {
                retire_directory(&path, root, self.retired_prefix);
            }
        }
    }

    /// The active copy: the marker's directory, or else the pre-marker
    /// directory with an unknown bundle identity.
    fn active(&self, root: &Path) -> Option<(PathBuf, Option<String>)> {
        if let Some(marker) = self.read_marker(root) {
            return Some((
                root.join(marker.directory),
                Some(marker.bundle_manifest_sha256),
            ));
        }
        let legacy = root.join(self.name);
        legacy.is_dir().then_some((legacy, None))
    }

    fn read_marker(&self, root: &Path) -> Option<SlotMarker> {
        let content = fs::read(self.marker_path(root)).ok()?;
        let marker: SlotMarker = serde_json::from_slice(&content).ok()?;
        (self.is_versioned_name(&marker.directory)
            && is_sha256(&marker.bundle_manifest_sha256)
            && root.join(&marker.directory).is_dir())
        .then_some(marker)
    }

    fn write_marker(&self, root: &Path, directory: &str, identity: &str) -> Result<(), String> {
        let content = serde_json::to_vec_pretty(&SlotMarker {
            directory: directory.into(),
            bundle_manifest_sha256: identity.into(),
        })
        .map_err(|error| format!("Runtime marker could not be serialized: {error}"))?;
        let temp = root.join(format!(
            "{}{MARKER_SUFFIX}.{}.tmp",
            self.name,
            uuid::Uuid::new_v4()
        ));
        let written = (|| {
            let mut file = fs::File::create(&temp)?;
            file.write_all(&content)?;
            file.sync_all()
        })();
        // A rename over the old marker is atomic, so readers see either the
        // previous copy or the new one, never a partial marker.
        let switched = written.and_then(|()| fs::rename(&temp, self.marker_path(root)));
        switched.map_err(|error| {
            let _ = fs::remove_file(&temp);
            format!("Runtime marker could not be switched: {error}")
        })
    }

    fn marker_path(&self, root: &Path) -> PathBuf {
        root.join(format!("{}{MARKER_SUFFIX}", self.name))
    }

    fn is_marker_temp_name(&self, name: &str) -> bool {
        name.strip_prefix(&format!("{}{MARKER_SUFFIX}.", self.name))
            .and_then(|rest| rest.strip_suffix(".tmp"))
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
    }

    /// `<name>-<identity prefix>` with an optional `-<n>` suffix.
    fn is_versioned_name(&self, name: &str) -> bool {
        let Some(rest) = name
            .strip_prefix(self.name)
            .and_then(|rest| rest.strip_prefix('-'))
        else {
            return false;
        };
        let (identity, counter) = rest.split_once('-').unwrap_or((rest, "1"));
        identity.len() == DIRECTORY_IDENTITY_DIGITS
            && identity.bytes().all(|byte| byte.is_ascii_hexdigit())
            && !counter.is_empty()
            && counter.bytes().all(|byte| byte.is_ascii_digit())
    }

    /// A reinstall of the same bundle (for example a repair) must not reuse
    /// the active directory, so later installs get a counter suffix.
    fn free_directory_name(&self, root: &Path, identity: &str) -> String {
        let base = format!("{}-{}", self.name, &identity[..DIRECTORY_IDENTITY_DIGITS]);
        std::iter::once(base.clone())
            .chain((2_u32..).map(|counter| format!("{base}-{counter}")))
            .find(|name| !root.join(name).exists())
            .expect("an unused directory name exists")
    }
}

fn runtimes_root(data_dir: &Path) -> PathBuf {
    data_dir.join(RUNTIMES_DIR)
}

/// Moves an inactive copy out of the way and deletes it, unless a process
/// is running from it. Windows lets a directory holding a running program
/// be renamed and partly deleted, so the check is explicit.
fn retire_directory(dir: &Path, root: &Path, retired_prefix: &str) {
    if has_running_executable(dir) {
        return;
    }
    let retired = root.join(format!("{retired_prefix}{}", uuid::Uuid::new_v4()));
    if fs::rename(dir, &retired).is_ok() {
        let _ = fs::remove_dir_all(&retired);
    }
}

/// A running program's image cannot be opened for writing (Windows reports
/// a sharing violation, Linux `ETXTBSY`). Unreadable entries count as in
/// use, so an uncertain copy is kept rather than removed.
fn has_running_executable(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return true;
    };
    for entry in entries {
        let Ok(entry) = entry else {
            return true;
        };
        let Ok(file_type) = entry.file_type() else {
            return true;
        };
        let path = entry.path();
        if file_type.is_dir() {
            if has_running_executable(&path) {
                return true;
            }
        } else if file_type.is_file()
            && path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
            && OpenOptions::new().write(true).open(&path).is_err()
        {
            return true;
        }
    }
    false
}

fn has_uuid_suffix(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix)
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SLOT: RuntimeSlot = CAPTURE_RUNTIME_SLOT;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("cert-prep-runtime-slots-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).expect("temp root");
            Self(root)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn identity(seed: &str) -> String {
        format!("{:x}", Sha256::digest(seed.as_bytes()))
    }

    fn write_payload(content: &'static str) -> impl FnOnce(&Path) -> Result<(), String> {
        move |staging| fs::write(staging.join("payload.txt"), content).map_err(|e| e.to_string())
    }

    fn slot_entries(data_dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(runtimes_root(data_dir))
            .expect("runtimes root")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn same_bundle_is_current_and_needs_no_refresh() {
        let temp = TempRoot::new();
        let v1 = identity("v1");
        let dir = SLOT
            .install(&temp.0, &v1, write_payload("v1"))
            .expect("install");

        assert_eq!(SLOT.installed_dir(&temp.0, Some(&v1)), Some(dir.clone()));
        assert!(!SLOT.needs_refresh(&temp.0, &v1));
        SLOT.sweep(&temp.0);
        assert_eq!(
            fs::read_to_string(dir.join("payload.txt")).expect("payload"),
            "v1"
        );
    }

    #[test]
    fn changed_bundle_installs_a_new_directory_and_retires_the_old_one() {
        let temp = TempRoot::new();
        let (v1, v2) = (identity("v1"), identity("v2"));
        let old = SLOT.install(&temp.0, &v1, write_payload("v1")).expect("v1");

        assert!(SLOT.needs_refresh(&temp.0, &v2));
        assert_eq!(SLOT.installed_dir(&temp.0, Some(&v2)), None);
        let new = SLOT.install(&temp.0, &v2, write_payload("v2")).expect("v2");

        assert_ne!(old, new);
        assert!(!old.exists());
        assert_eq!(SLOT.installed_dir(&temp.0, Some(&v2)), Some(new.clone()));
        assert_eq!(
            fs::read_to_string(new.join("payload.txt")).expect("payload"),
            "v2"
        );
        assert_eq!(
            slot_entries(&temp.0),
            vec![
                format!("capture_runtime-{}", &v2[..8]),
                "capture_runtime.current.json".to_string(),
            ]
        );
    }

    #[test]
    fn failed_verification_keeps_the_previous_copy_active() {
        let temp = TempRoot::new();
        let (v1, v2) = (identity("v1"), identity("v2"));
        let old = SLOT.install(&temp.0, &v1, write_payload("v1")).expect("v1");

        let error = SLOT
            .install(&temp.0, &v2, |staging| {
                fs::write(staging.join("payload.txt"), "corrupt").expect("payload");
                Err("Capture runtime SHA-256 mismatch.".into())
            })
            .expect_err("verification failure");

        assert_eq!(error, "Capture runtime SHA-256 mismatch.");
        assert_eq!(SLOT.installed_dir(&temp.0, Some(&v1)), Some(old.clone()));
        assert_eq!(
            fs::read_to_string(old.join("payload.txt")).expect("payload"),
            "v1"
        );
        assert!(SLOT.needs_refresh(&temp.0, &v2));
        assert_eq!(slot_entries(&temp.0).len(), 2, "no staging left behind");
    }

    #[test]
    fn leftovers_from_an_interrupted_install_are_cleaned_and_the_retry_succeeds() {
        let temp = TempRoot::new();
        let (v1, v2) = (identity("v1"), identity("v2"));
        let old = SLOT.install(&temp.0, &v1, write_payload("v1")).expect("v1");
        let root = runtimes_root(&temp.0);
        // A crash can leave staging, a renamed copy whose marker was never
        // written, a marker temp file, and a half-deleted retired copy.
        let staging = root.join(format!(".capture-runtime-install-{}", uuid::Uuid::new_v4()));
        let orphan = root.join(format!("capture_runtime-{}", &v2[..8]));
        let retired = root.join(format!(".capture-runtime-backup-{}", uuid::Uuid::new_v4()));
        let marker_temp = root.join(format!(
            "capture_runtime.current.json.{}.tmp",
            uuid::Uuid::new_v4()
        ));
        for dir in [&staging, &orphan, &retired] {
            fs::create_dir_all(dir).expect("leftover");
            fs::write(dir.join("partial.bin"), "partial").expect("partial");
        }
        fs::write(&marker_temp, "{").expect("marker temp");
        let unrelated = root.join(".capture-runtime-install-not-a-uuid");
        fs::create_dir_all(&unrelated).expect("unrelated");

        assert_eq!(SLOT.installed_dir(&temp.0, None), Some(old.clone()));
        let new = SLOT
            .install(&temp.0, &v2, write_payload("v2"))
            .expect("retry");

        assert_eq!(new, orphan, "the orphan name is reused after cleanup");
        assert!(!new.join("partial.bin").exists());
        assert_eq!(
            fs::read_to_string(new.join("payload.txt")).expect("payload"),
            "v2"
        );
        assert!(!staging.exists() && !retired.exists() && !marker_temp.exists());
        assert!(!old.exists());
        assert!(unrelated.exists(), "only UUID-owned leftovers are removed");
    }

    #[test]
    fn a_pre_marker_copy_counts_as_installed_but_stale_and_is_replaced() {
        let temp = TempRoot::new();
        let legacy = runtimes_root(&temp.0).join(CAPTURE_RUNTIME_DIR);
        fs::create_dir_all(&legacy).expect("legacy");
        fs::write(legacy.join("payload.txt"), "legacy").expect("legacy payload");
        let v1 = identity("v1");

        assert_eq!(SLOT.installed_dir(&temp.0, None), Some(legacy.clone()));
        assert!(SLOT.needs_refresh(&temp.0, &v1));
        let new = SLOT
            .install(&temp.0, &v1, write_payload("v1"))
            .expect("install");

        assert!(!legacy.exists());
        assert_eq!(SLOT.installed_dir(&temp.0, Some(&v1)), Some(new));
    }

    #[test]
    fn reinstalling_the_same_bundle_switches_to_a_fresh_directory() {
        let temp = TempRoot::new();
        let v1 = identity("v1");
        let first = SLOT
            .install(&temp.0, &v1, write_payload("first"))
            .expect("first");
        let second = SLOT
            .install(&temp.0, &v1, write_payload("second"))
            .expect("second");

        assert_ne!(first, second);
        assert!(!first.exists());
        assert_eq!(SLOT.installed_dir(&temp.0, Some(&v1)), Some(second));
    }

    #[test]
    fn a_missing_or_tampered_marker_is_not_trusted() {
        let temp = TempRoot::new();
        let v1 = identity("v1");
        SLOT.install(&temp.0, &v1, write_payload("v1"))
            .expect("install");
        let marker = runtimes_root(&temp.0).join("capture_runtime.current.json");
        fs::write(
            &marker,
            r#"{"directory":"..\\elsewhere","bundleManifestSha256":"00"}"#,
        )
        .expect("tamper");

        assert_eq!(SLOT.installed_dir(&temp.0, None), None);
        assert!(
            !SLOT.needs_refresh(&temp.0, &v1),
            "nothing installed to refresh"
        );
    }

    #[test]
    fn slots_leave_engines_user_data_and_other_slots_alone() {
        let temp = TempRoot::new();
        let engines = temp.0.join("capture-workbench").join("engines");
        fs::create_dir_all(&engines).expect("engines");
        fs::write(engines.join("model.bin"), "engine").expect("engine");
        fs::write(temp.0.join("cert-prep.db"), "user data").expect("user data");
        let backend = PYTHON_BACKEND_SLOT
            .install(&temp.0, &identity("backend"), write_payload("backend"))
            .expect("backend");

        SLOT.install(&temp.0, &identity("v1"), write_payload("v1"))
            .expect("v1");
        SLOT.install(&temp.0, &identity("v2"), write_payload("v2"))
            .expect("v2");

        assert!(engines.join("model.bin").is_file());
        assert!(temp.0.join("cert-prep.db").is_file());
        assert!(backend.join("payload.txt").is_file());
    }

    #[cfg(windows)]
    #[test]
    fn a_copy_with_a_running_program_is_kept_until_the_program_exits() {
        struct KillOnDrop(std::process::Child);
        impl Drop for KillOnDrop {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let temp = TempRoot::new();
        let (v1, v2) = (identity("v1"), identity("v2"));
        let system_root = std::env::var("SystemRoot").expect("SystemRoot");
        let shell = Path::new(&system_root).join("System32").join("cmd.exe");
        let old = SLOT
            .install(&temp.0, &v1, |staging| {
                fs::copy(&shell, staging.join("sidecar.exe"))
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .expect("v1");
        let mut child = KillOnDrop(
            std::process::Command::new(old.join("sidecar.exe"))
                .args(["/q", "/c", "ping", "-n", "30", "127.0.0.1"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("sidecar"),
        );
        let started = std::time::Instant::now();
        while !has_running_executable(&old) {
            assert!(started.elapsed().as_secs() < 10, "sidecar did not start");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let new = SLOT.install(&temp.0, &v2, write_payload("v2")).expect("v2");

        assert_eq!(SLOT.installed_dir(&temp.0, Some(&v2)), Some(new));
        assert!(
            old.join("sidecar.exe").is_file(),
            "running copy is kept intact"
        );
        let _ = child.0.kill();
        let _ = child.0.wait();
        drop(child);
        SLOT.sweep(&temp.0);
        assert!(
            !old.exists(),
            "sweep removes the copy once the program exited"
        );
    }
}
