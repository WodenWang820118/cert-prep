fn main() {
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tools/capture-runtime-version.json");
    println!("cargo:rerun-if-changed={}", source.display());
    let pin: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(source).expect("read Capture adoption version"),
    )
    .expect("parse Capture adoption version");
    let version = pin["runtimeVersion"]
        .as_str()
        .expect("Capture runtimeVersion string");
    assert!(
        !version.is_empty() && !version.contains('\n') && !version.contains('\r'),
        "invalid Capture version"
    );
    println!("cargo:rustc-env=CERT_PREP_CAPTURE_RUNTIME_VERSION={version}");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-arg-bin=cert-prep-desktop=/STACK:8388608");
    }
    tauri_build::build()
}
