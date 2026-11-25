pub(crate) const PYTHON_RUNTIME_KIND: &str = "python_backend";
pub(crate) const PYTHON_RUNTIME_LABEL: &str = "Python backend runtime";
pub(crate) const BACKEND_RUNTIME_DIR: &str = "python_backend";
pub(crate) const CAPTURE_RUNTIME_DIR: &str = "capture_runtime";
pub(crate) const BACKEND_RUNTIME_MANIFEST: &str = "backend-runtime-manifest.json";

pub(crate) const CAPTURE_RUNTIME_MANIFEST: &str = "capture-runtime-manifest.json";
pub(crate) const CAPTURE_RUNTIME_BINARY: &str = "capture-runtime-x86_64-pc-windows-msvc.exe";
pub(crate) const CAPTURE_RUNTIME_VERSION: &str = env!("CERT_PREP_CAPTURE_RUNTIME_VERSION");
pub(crate) const CAPTURE_RUNTIME_RELEASE: &str = concat!(
    "capture-runtime@",
    env!("CERT_PREP_CAPTURE_RUNTIME_VERSION")
);
pub(crate) const CAPTURE_RUNTIME_API_VERSION: &str = "2.0";
pub(crate) const CAPTURE_DOCUMENT_SCHEMA_VERSION: &str = "2";
pub(crate) const CAPTURE_DOCUMENT_SCHEMA_FILE: &str = "capture-document-v2.schema.json";
pub(crate) const CAPTURE_DOCUMENT_SCHEMA_SHA256: &str =
    "7d2262f13489df24eab83f8c3b5a5b5b7f5e8f7af0f521ac1b247ae86df9b493";
