use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

pub(crate) fn download_artifact(url: &str, destination: &Path) -> Result<(), String> {
    if url.starts_with("file://") {
        let source_path = file_url_to_path(url)?;
        fs::copy(&source_path, destination)
            .map(|_| ())
            .map_err(|error| format!("failed to copy runtime artifact: {error}"))
    } else if Path::new(url).is_file() {
        fs::copy(Path::new(url), destination)
            .map(|_| ())
            .map_err(|error| format!("failed to copy runtime artifact: {error}"))
    } else if url.starts_with("http://") || url.starts_with("https://") {
        powershell(&format!(
            "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '{}' -OutFile '{}'",
            ps_quote(url),
            ps_quote(&destination.display().to_string())
        ))
        .map_err(|error| format!("failed to download runtime artifact: {error}"))
    } else {
        Err(format!("unsupported runtime artifact URL: {url}"))
    }
}

fn file_url_to_path(url: &str) -> Result<PathBuf, String> {
    let raw_path = url
        .strip_prefix("file://")
        .ok_or_else(|| format!("not a file URL: {url}"))?;
    let decoded = percent_decode_utf8(raw_path)?;

    #[cfg(windows)]
    {
        let without_drive_slash =
            if decoded.starts_with('/') && decoded.as_bytes().get(2) == Some(&b':') {
                &decoded[1..]
            } else {
                decoded.as_str()
            };
        Ok(PathBuf::from(without_drive_slash.replace('/', "\\")))
    }

    #[cfg(not(windows))]
    {
        Ok(PathBuf::from(decoded))
    }
}

fn percent_decode_utf8(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes
                .get(index + 1)
                .and_then(|byte| hex_value(*byte))
                .ok_or_else(|| format!("invalid percent escape in file URL: {input}"))?;
            let low = bytes
                .get(index + 2)
                .and_then(|byte| hex_value(*byte))
                .ok_or_else(|| format!("invalid percent escape in file URL: {input}"))?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|error| format!("invalid UTF-8 in file URL: {error}"))
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

pub(crate) fn extract_zip(artifact: &Path, destination: &Path) -> Result<(), String> {
    powershell(&format!(
        "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
        ps_quote(&artifact.display().to_string()),
        ps_quote(&destination.display().to_string())
    ))
    .map_err(|error| format!("failed to extract runtime artifact: {error}"))
}

fn powershell(script: &str) -> Result<(), String> {
    let output = Command::new(powershell_executable())
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if stderr.is_empty() { stdout } else { stderr })
}

fn powershell_executable() -> PathBuf {
    ["SystemRoot", "WINDIR"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .map(|root| {
            PathBuf::from(root)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe")
        })
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("powershell.exe"))
}

fn ps_quote(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_url_to_path_accepts_windows_drive_urls() {
        let path =
            file_url_to_path("file:///C:/software-dev/cert-prep/runtime.zip").expect("file URL");

        #[cfg(windows)]
        assert_eq!(
            path,
            PathBuf::from(r"C:\software-dev\cert-prep\runtime.zip")
        );

        #[cfg(not(windows))]
        assert_eq!(
            path,
            PathBuf::from("/C:/software-dev/cert-prep/runtime.zip")
        );
    }

    #[test]
    fn file_url_to_path_decodes_percent_escaped_utf8() {
        let path = file_url_to_path("file:///C:/runtime%20cache/%E6%B8%AC%E8%A9%A6.zip")
            .expect("file URL");

        #[cfg(windows)]
        assert_eq!(path, PathBuf::from(r"C:\runtime cache\測試.zip"));

        #[cfg(not(windows))]
        assert_eq!(path, PathBuf::from("/C:/runtime cache/測試.zip"));
    }

    #[test]
    fn powershell_executable_prefers_windows_absolute_path() {
        let executable = powershell_executable();

        if let Ok(root) = std::env::var("SystemRoot") {
            let expected = PathBuf::from(root)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");
            if expected.is_file() {
                assert_eq!(executable, expected);
                return;
            }
        }

        assert_eq!(executable, PathBuf::from("powershell.exe"));
    }
}
