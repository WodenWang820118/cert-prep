use std::{
    ffi::{OsStr, OsString},
    fmt::Write as _,
    fs,
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use rand::{rngs::OsRng, RngCore};
use serde_json::Value;

use crate::{
    capture_manifest::{verify_capture_runtime, CaptureRuntimeManifest},
    constants::CAPTURE_RUNTIME_MANIFEST,
    windows_process::terminate_owned_process_tree,
};

const LOOPBACK_HOST: &str = "127.0.0.1";
const DEFAULT_READY_TIMEOUT: Duration = Duration::from_secs(45);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_HEALTH_RESPONSE_BYTES: u64 = 64 * 1024;
const DEFAULT_RETENTION_HOURS: &str = "24";
const CERT_MAX_AUDIO_UPLOAD_BYTES: &str = "104857600";
const CERT_MAX_PDF_PAGES: &str = "250";
const CERT_MAX_IMAGE_PIXELS: &str = "50000000";
const CAPTURE_CHILD_ENV_ALLOWLIST: &[&str] = &[
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "PROGRAMDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "NUMBER_OF_PROCESSORS",
];

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct CaptureRuntimeConnection {
    pub base_url: String,
    pub token: String,
    pub runtime_version: String,
    pub api_version: String,
    pub capture_document_schema_version: String,
}

struct CaptureRuntimeInner {
    child: Mutex<Option<Child>>,
    connection: CaptureRuntimeConnection,
}

#[derive(Clone)]
pub(crate) struct CaptureRuntimeState {
    inner: Arc<CaptureRuntimeInner>,
}

impl Drop for CaptureRuntimeInner {
    fn drop(&mut self) {
        self.terminate_child_process_tree();
    }
}

impl CaptureRuntimeInner {
    fn terminate_child_process_tree(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.take() {
                terminate_owned_process_tree(child);
            }
        }
    }
}

impl CaptureRuntimeState {
    pub(crate) fn launch(
        manifest_path: &Path,
        executable_path: &Path,
        app_data_dir: &Path,
    ) -> Result<Self, String> {
        let verified = verify_capture_runtime(manifest_path, executable_path)?;
        let policy = CaptureLaunchPolicy::new(app_data_dir.join("capture-workbench"))?;
        fs::create_dir_all(&policy.data_dir).map_err(|error| {
            format!("Capture runtime data directory could not be created: {error}")
        })?;

        let mut command =
            capture_runtime_command(&verified.executable_path, &policy, &verified.manifest);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Capture runtime could not be started: {error}"))?;
        let handshake = match wait_until_ready(
            &mut child,
            &policy,
            &verified.manifest,
            capture_ready_timeout(),
        ) {
            Ok(handshake) => handshake,
            Err(error) => {
                terminate_owned_process_tree(child);
                return Err(error);
            }
        };

        Ok(Self {
            inner: Arc::new(CaptureRuntimeInner {
                child: Mutex::new(Some(child)),
                connection: CaptureRuntimeConnection {
                    base_url: policy.base_url(),
                    token: policy.token,
                    runtime_version: handshake.runtime_version,
                    api_version: handshake.api_version,
                    capture_document_schema_version: handshake.capture_document_schema_version,
                },
            }),
        })
    }

    pub(crate) fn connection(&self) -> CaptureRuntimeConnection {
        self.inner.connection.clone()
    }

    pub(crate) fn terminate_child_process_tree(&self) {
        self.inner.terminate_child_process_tree();
    }
}

struct CaptureLaunchPolicy {
    port: u16,
    token: String,
    data_dir: PathBuf,
}

impl CaptureLaunchPolicy {
    fn new(data_dir: PathBuf) -> Result<Self, String> {
        Ok(Self {
            port: reserve_loopback_port()?,
            token: generate_bearer_token()?,
            data_dir,
        })
    }

    #[cfg(test)]
    fn deterministic(data_dir: PathBuf, port: u16, token: &str) -> Self {
        Self {
            port,
            token: token.into(),
            data_dir,
        }
    }

    fn base_url(&self) -> String {
        format!("http://{LOOPBACK_HOST}:{}", self.port)
    }

    fn environment(&self) -> Vec<(&'static str, String)> {
        vec![
            ("CAPTURE_HOST", LOOPBACK_HOST.into()),
            ("CAPTURE_PORT", self.port.to_string()),
            ("CAPTURE_API_TOKEN", self.token.clone()),
            (
                "CAPTURE_ALLOWED_HOSTS",
                format!("{LOOPBACK_HOST}:{}", self.port),
            ),
            ("CAPTURE_ALLOWED_ORIGINS", String::new()),
            ("CAPTURE_ENABLE_API_DOCS", "false".into()),
            (
                "CAPTURE_APP_DATA_DIR",
                self.data_dir.to_string_lossy().into_owned(),
            ),
            ("CAPTURE_EXTRACTION_PROVIDER", "runtime".into()),
            ("CAPTURE_STRUCTURING_PROVIDER", "host".into()),
            ("CAPTURE_RETENTION_HOURS", DEFAULT_RETENTION_HOURS.into()),
            (
                "CAPTURE_MAX_UPLOAD_BYTES",
                CERT_MAX_AUDIO_UPLOAD_BYTES.into(),
            ),
            ("CAPTURE_MAX_PDF_PAGES", CERT_MAX_PDF_PAGES.into()),
            ("CAPTURE_MAX_IMAGE_PIXELS", CERT_MAX_IMAGE_PIXELS.into()),
        ]
    }
}

fn capture_runtime_command(
    executable: &Path,
    policy: &CaptureLaunchPolicy,
    manifest: &CaptureRuntimeManifest,
) -> Command {
    capture_runtime_command_with_parent_environment(
        executable,
        policy,
        manifest,
        std::env::vars_os(),
    )
}

fn capture_runtime_command_with_parent_environment<I>(
    executable: &Path,
    policy: &CaptureLaunchPolicy,
    manifest: &CaptureRuntimeManifest,
    parent_environment: I,
) -> Command
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    let mut command = Command::new(executable);
    command.env_clear();
    for (name, value) in parent_environment {
        if capture_child_env_allowed(&name) {
            command.env(name, value);
        }
    }
    command
        .arg("serve")
        .arg("--host")
        .arg(LOOPBACK_HOST)
        .arg("--port")
        .arg(policy.port.to_string())
        .current_dir(executable.parent().unwrap_or_else(|| Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // The sidecar receives only Windows process bootstrap state plus verified
    // Capture values. Parent credentials, model stores, proxies, and ambient
    // Capture overrides never cross this process boundary.
    for (name, value) in policy.environment() {
        command.env(name, value);
    }
    command.env(
        "CAPTURE_WINDOWSML_BUNDLE_URL",
        &manifest.runtime_requirements.windowsml_ocr.artifact_url,
    );
    command.env(
        "CAPTURE_WINDOWSML_BUNDLE_SHA256",
        &manifest.runtime_requirements.windowsml_ocr.sha256,
    );
    command.env(
        "CAPTURE_WINDOWSML_BUNDLE_BYTES",
        manifest
            .runtime_requirements
            .windowsml_ocr
            .bytes
            .to_string(),
    );

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn capture_child_env_allowed(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    CAPTURE_CHILD_ENV_ALLOWLIST
        .iter()
        .any(|allowed| name.eq_ignore_ascii_case(allowed))
}

fn reserve_loopback_port() -> Result<u16, String> {
    TcpListener::bind((LOOPBACK_HOST, 0))
        .map_err(|error| format!("Capture runtime loopback port could not be reserved: {error}"))?
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Capture runtime loopback port could not be read: {error}"))
}

fn generate_bearer_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| "Capture runtime bearer token generation failed.".to_string())?;
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut token, "{byte:02x}")
            .map_err(|_| "Capture runtime bearer token encoding failed.".to_string())?;
    }
    Ok(token)
}

fn capture_ready_timeout() -> Duration {
    Duration::from_secs(
        std::env::var("CERT_PREP_CAPTURE_RUNTIME_READY_TIMEOUT_SECS")
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_READY_TIMEOUT.as_secs()),
    )
}

fn wait_until_ready(
    child: &mut Child,
    policy: &CaptureLaunchPolicy,
    manifest: &CaptureRuntimeManifest,
    timeout: Duration,
) -> Result<CaptureReadyHandshake, String> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Capture runtime status could not be read: {error}"))?
        {
            return Err(format!(
                "Capture runtime exited before readiness with status {status}."
            ));
        }
        match probe_ready_once(policy.port, &policy.token, manifest)? {
            CaptureProbeResult::Ready(handshake) => return Ok(handshake),
            CaptureProbeResult::NotReady => thread::sleep(READY_POLL_INTERVAL),
        }
    }
    Err("Capture runtime did not become ready before the timeout.".into())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CaptureReadyHandshake {
    runtime_version: String,
    api_version: String,
    capture_document_schema_version: String,
}

#[derive(Debug)]
enum CaptureProbeResult {
    Ready(CaptureReadyHandshake),
    NotReady,
}

fn probe_ready_once(
    port: u16,
    token: &str,
    manifest: &CaptureRuntimeManifest,
) -> Result<CaptureProbeResult, String> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(250)) {
        Ok(stream) => stream,
        Err(_) => return Ok(CaptureProbeResult::NotReady),
    };
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|_| "Capture runtime readiness socket could not be configured.".to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_millis(500)))
        .map_err(|_| "Capture runtime readiness socket could not be configured.".to_string())?;

    let request = format!(
        "GET /v1/health/ready HTTP/1.1\r\nHost: {LOOPBACK_HOST}:{port}\r\nAuthorization: Bearer {token}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return Ok(CaptureProbeResult::NotReady);
    }

    let mut response = Vec::new();
    if stream
        .take(MAX_HEALTH_RESPONSE_BYTES + 1)
        .read_to_end(&mut response)
        .is_err()
    {
        return Ok(CaptureProbeResult::NotReady);
    }
    if response.len() as u64 > MAX_HEALTH_RESPONSE_BYTES {
        return Err("Capture runtime readiness response exceeded the safety limit.".into());
    }
    parse_health_response(&response, manifest)
}

fn parse_health_response(
    response: &[u8],
    manifest: &CaptureRuntimeManifest,
) -> Result<CaptureProbeResult, String> {
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Capture runtime readiness response was malformed.".to_string())?;
    let headers = std::str::from_utf8(&response[..separator])
        .map_err(|_| "Capture runtime readiness headers were not UTF-8.".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "Capture runtime readiness status was malformed.".to_string())?;
    if status == 503 {
        return Ok(CaptureProbeResult::NotReady);
    }
    if status != 200 {
        return Err(format!(
            "Capture runtime readiness request was rejected with HTTP {status}."
        ));
    }

    let body = &response[separator + 4..];
    let value: Value = serde_json::from_slice(body)
        .map_err(|_| "Capture runtime readiness body was invalid JSON.".to_string())?;
    validate_handshake(&value, manifest).map(CaptureProbeResult::Ready)
}

fn validate_handshake(
    value: &Value,
    manifest: &CaptureRuntimeManifest,
) -> Result<CaptureReadyHandshake, String> {
    let ready = value.get("ready").and_then(Value::as_bool).unwrap_or(false)
        || value
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| status.eq_ignore_ascii_case("ready"));
    if !ready {
        return Err("Capture runtime did not report ready.".into());
    }
    let exact_host_structuring = value
        .pointer("/capabilities/structuringModes")
        .and_then(Value::as_array)
        .is_some_and(|modes| modes.len() == 1 && modes[0].as_str() == Some("host"));
    if !exact_host_structuring {
        return Err(
            "Capture runtime readiness structuringModes must be exactly [\"host\"].".into(),
        );
    }

    let runtime_version = response_string(value, "runtimeVersion")?;
    let api_version = response_string(value, "apiVersion")?;
    let schema_version = response_string(value, "captureDocumentSchemaVersion")?;
    compare_handshake(
        "runtimeVersion",
        &runtime_version,
        &manifest.runtime_version,
    )?;
    compare_handshake("apiVersion", &api_version, &manifest.api_version)?;
    compare_handshake(
        "captureDocumentSchemaVersion",
        &schema_version,
        &manifest.capture_document_schema_version,
    )?;
    Ok(CaptureReadyHandshake {
        runtime_version,
        api_version,
        capture_document_schema_version: schema_version,
    })
}

fn response_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .or_else(|| value.get("versions").and_then(|versions| versions.get(key)))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("Capture runtime readiness response omitted {key}."))
}

fn compare_handshake(name: &str, actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "Capture runtime readiness {name} is incompatible with the verified manifest."
        ))
    }
}

pub(crate) fn bundled_capture_runtime_paths(
    manifest_path: Option<PathBuf>,
) -> Result<(PathBuf, PathBuf), String> {
    let manifest_path = manifest_path
        .ok_or_else(|| format!("Bundled {CAPTURE_RUNTIME_MANIFEST} was not found."))?;
    let manifest = crate::capture_manifest::load_capture_runtime_manifest(&manifest_path)?;
    crate::capture_manifest::validate_capture_manifest_contract(&manifest)?;
    let executable_path = manifest_path
        .parent()
        .ok_or_else(|| "Capture runtime manifest has no resource directory.".to_string())?
        .join(&manifest.file_name);
    Ok((manifest_path, executable_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture_manifest::{CaptureRuntimeBundleRequirement, CaptureRuntimeRequirements};
    use crate::constants::{
        CAPTURE_DOCUMENT_SCHEMA_FILE, CAPTURE_DOCUMENT_SCHEMA_SHA256,
        CAPTURE_DOCUMENT_SCHEMA_VERSION, CAPTURE_RUNTIME_API_VERSION, CAPTURE_RUNTIME_BINARY,
        CAPTURE_RUNTIME_VERSION,
    };
    use std::{net::TcpListener, sync::mpsc};

    fn env_value(command: &Command, name: &str) -> Option<Option<String>> {
        command
            .get_envs()
            .find(|(key, _)| *key == OsStr::new(name))
            .map(|(_, value)| value.map(|value| value.to_string_lossy().into_owned()))
    }

    fn manifest() -> CaptureRuntimeManifest {
        CaptureRuntimeManifest {
            manifest_version: "1".into(),
            runtime_version: CAPTURE_RUNTIME_VERSION.into(),
            api_version: CAPTURE_RUNTIME_API_VERSION.into(),
            capture_document_schema_version: CAPTURE_DOCUMENT_SCHEMA_VERSION.into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            file_name: CAPTURE_RUNTIME_BINARY.into(),
            bytes: 1,
            sha256: "0".repeat(64),
            schema_file_name: CAPTURE_DOCUMENT_SCHEMA_FILE.into(),
            schema_sha256: CAPTURE_DOCUMENT_SCHEMA_SHA256.into(),
            runtime_requirements: CaptureRuntimeRequirements {
                windowsml_ocr: CaptureRuntimeBundleRequirement {
                    artifact_url: "https://example.test/releases/capture-windowsml-ocr-v1.zip"
                        .into(),
                    artifact_file_name: "capture-windowsml-ocr-v1.zip".into(),
                    bytes: 123_456,
                    sha256: "2".repeat(64),
                },
            },
        }
    }

    #[test]
    fn bearer_token_is_random_256_bit_hex() {
        let first = generate_bearer_token().expect("first token");
        let second = generate_bearer_token().expect("second token");
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn host_mode_command_is_loopback_only_and_does_not_inherit_ollama() {
        let policy = CaptureLaunchPolicy::deterministic(
            PathBuf::from("cert-data/capture-workbench"),
            41001,
            &"a".repeat(64),
        );
        let manifest = manifest();
        let command =
            capture_runtime_command(Path::new(CAPTURE_RUNTIME_BINARY), &policy, &manifest);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert_eq!(args, ["serve", "--host", LOOPBACK_HOST, "--port", "41001"]);
        assert_eq!(
            env_value(&command, "CAPTURE_STRUCTURING_PROVIDER"),
            Some(Some("host".into()))
        );
        assert_eq!(
            env_value(&command, "CAPTURE_ALLOWED_HOSTS"),
            Some(Some("127.0.0.1:41001".into()))
        );
        assert_eq!(
            env_value(&command, "CAPTURE_ENABLE_API_DOCS"),
            Some(Some("false".into()))
        );
        assert_eq!(env_value(&command, "OLLAMA_HOST"), None);
        assert_eq!(env_value(&command, "OLLAMA_MODELS"), None);
        assert_eq!(env_value(&command, "CAPTURE_OLLAMA_HOST"), None);
        assert_eq!(
            env_value(&command, "CAPTURE_WINDOWSML_BUNDLE_URL"),
            Some(Some(
                "https://example.test/releases/capture-windowsml-ocr-v1.zip".into()
            ))
        );
        assert_eq!(
            env_value(&command, "CAPTURE_WINDOWSML_BUNDLE_SHA256"),
            Some(Some("2".repeat(64)))
        );
        assert_eq!(
            env_value(&command, "CAPTURE_WINDOWSML_BUNDLE_BYTES"),
            Some(Some("123456".into()))
        );
        assert_eq!(env_value(&command, "CERT_PREP_API_TOKEN"), None);
        assert_eq!(
            env_value(&command, "CAPTURE_MAX_UPLOAD_BYTES"),
            Some(Some(CERT_MAX_AUDIO_UPLOAD_BYTES.into()))
        );
        assert_eq!(
            env_value(&command, "CAPTURE_MAX_PDF_PAGES"),
            Some(Some(CERT_MAX_PDF_PAGES.into()))
        );
        assert_eq!(
            env_value(&command, "CAPTURE_MAX_IMAGE_PIXELS"),
            Some(Some(CERT_MAX_IMAGE_PIXELS.into()))
        );
    }

    #[test]
    fn poisoned_parent_environment_is_replaced_by_allowlisted_and_verified_values() {
        let policy = CaptureLaunchPolicy::deterministic(
            PathBuf::from("cert-data/capture-workbench"),
            41001,
            &"a".repeat(64),
        );
        let parent_environment = [
            ("SystemRoot", r"C:\Windows"),
            ("PATH", r"C:\Windows\System32"),
            ("CAPTURE_API_TOKEN", "parent-token-sentinel"),
            ("CAPTURE_WINDOWSML_BUNDLE_URL", "parent-url-sentinel"),
            ("CAPTURE_WINDOWSML_BUNDLE_SHA256", "parent-sha-sentinel"),
            ("CAPTURE_WINDOWSML_BUNDLE_BYTES", "999"),
            ("CERT_PREP_CAPTURE_RUNTIME_TOKEN", "parent-cert-sentinel"),
            ("OLLAMA_HOST", "parent-ollama-sentinel"),
            ("AWS_SECRET_ACCESS_KEY", "parent-cloud-sentinel"),
            ("HTTP_PROXY", "parent-proxy-sentinel"),
        ]
        .into_iter()
        .map(|(name, value)| (OsString::from(name), OsString::from(value)));
        let command = capture_runtime_command_with_parent_environment(
            Path::new(CAPTURE_RUNTIME_BINARY),
            &policy,
            &manifest(),
            parent_environment,
        );

        assert_eq!(
            env_value(&command, "SystemRoot"),
            Some(Some(r"C:\Windows".into()))
        );
        assert_eq!(
            env_value(&command, "PATH"),
            Some(Some(r"C:\Windows\System32".into()))
        );
        assert_eq!(
            env_value(&command, "CAPTURE_API_TOKEN"),
            Some(Some("a".repeat(64)))
        );
        assert_eq!(
            env_value(&command, "CAPTURE_WINDOWSML_BUNDLE_BYTES"),
            Some(Some("123456".into()))
        );
        for forbidden_name in [
            "CERT_PREP_CAPTURE_RUNTIME_TOKEN",
            "OLLAMA_HOST",
            "AWS_SECRET_ACCESS_KEY",
            "HTTP_PROXY",
        ] {
            assert_eq!(env_value(&command, forbidden_name), None);
        }

        let child_values: Vec<_> = command
            .get_envs()
            .filter_map(|(_, value)| value)
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        for poisoned_value in [
            "parent-token-sentinel",
            "parent-url-sentinel",
            "parent-sha-sentinel",
            "999",
            "parent-cert-sentinel",
            "parent-ollama-sentinel",
            "parent-cloud-sentinel",
            "parent-proxy-sentinel",
        ] {
            assert!(!child_values.iter().any(|value| value == poisoned_value));
        }
    }

    #[test]
    fn authenticated_readiness_matches_pinned_manifest_without_echoing_secrets() {
        let listener = TcpListener::bind((LOOPBACK_HOST, 0)).expect("listener");
        let port = listener.local_addr().expect("address").port();
        let (sender, receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).expect("request");
            sender.send(request[..count].to_vec()).expect("send");
            let body = format!(
                "{{\"ready\":true,\"runtimeVersion\":\"{}\",\"apiVersion\":\"{}\",\"captureDocumentSchemaVersion\":\"{}\",\"capabilities\":{{\"structuringModes\":[\"host\"]}}}}",
                CAPTURE_RUNTIME_VERSION,
                CAPTURE_RUNTIME_API_VERSION,
                CAPTURE_DOCUMENT_SCHEMA_VERSION
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("response");
        });
        let result = probe_ready_once(port, "secret-sidecar-token", &manifest()).expect("probe");
        assert!(matches!(result, CaptureProbeResult::Ready(_)));
        let request = String::from_utf8(receiver.recv().expect("request")).expect("UTF-8");
        assert!(request.contains(&format!("Host: {LOOPBACK_HOST}:{port}")));
        assert!(request.contains("Authorization: Bearer secret-sidecar-token"));
        server.join().expect("server");

        let wrong = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: 170\r\n\r\n{{\"ready\":true,\"runtimeVersion\":\"{}\",\"apiVersion\":\"1.0\",\"captureDocumentSchemaVersion\":\"99\",\"capabilities\":{{\"structuringModes\":[\"host\"]}}}}",
            CAPTURE_RUNTIME_VERSION
        );
        let error = parse_health_response(wrong.as_bytes(), &manifest()).expect_err("schema");
        assert!(error.contains("captureDocumentSchemaVersion"));
        assert!(!error.contains("99"));
        assert!(!error.contains("secret-sidecar-token"));

        for modes in [
            serde_json::json!([]),
            serde_json::json!(["runtime"]),
            serde_json::json!(["host", "runtime"]),
            serde_json::json!(["runtime", "host"]),
            serde_json::json!(["host", "host"]),
        ] {
            let invalid_modes = serde_json::json!({
                "ready": true,
                "runtimeVersion": CAPTURE_RUNTIME_VERSION,
                "apiVersion": CAPTURE_RUNTIME_API_VERSION,
                "captureDocumentSchemaVersion": CAPTURE_DOCUMENT_SCHEMA_VERSION,
                "capabilities": {"structuringModes": modes}
            });
            let error =
                validate_handshake(&invalid_modes, &manifest()).expect_err("exact host mode");
            assert!(error.contains("exactly [\"host\"]"));
        }

        let wrong_type = serde_json::json!({
            "ready": true,
            "runtimeVersion": CAPTURE_RUNTIME_VERSION,
            "apiVersion": CAPTURE_RUNTIME_API_VERSION,
            "captureDocumentSchemaVersion": CAPTURE_DOCUMENT_SCHEMA_VERSION,
            "capabilities": {"structuringModes": "host"}
        });
        let error = validate_handshake(&wrong_type, &manifest()).expect_err("array mode");
        assert!(error.contains("exactly [\"host\"]"));
    }
}
