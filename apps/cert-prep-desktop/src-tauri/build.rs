fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-arg-bin=cert-prep-desktop=/STACK:8388608");
    }
    tauri_build::build()
}
