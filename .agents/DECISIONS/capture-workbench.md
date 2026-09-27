# Capture Workbench Decisions

## 2026-08-25 Cert Prep 0.4.2 consumer target

- Keep the current 0.4.1/schema-2 artifacts as the fixed point until matching
  producer 0.4.2 artifacts are published. The target consumer requires schema 3
  with a typed page/segment OCR projection.
- Every PDF page and image uses runtime rasterization and canonical PaddleOCR;
  embedded extraction, mixed arbitration, and LLM route selection are forbidden.
- New Cert Prep persistence is `windowsml_ocr` only. Existing embedded/mixed
  records remain readable for compatibility, and rollback remains a complete
  version pin rollback rather than a mixed runtime/client deployment.

- Publish an embeddable Angular library and a separately versioned Windows x64 sidecar.
- Use host structuring mode in Cert Prep: its existing Ollama provider implements
  the Capture Workbench provider interface, so capture does not run a second
  production Ollama process.
- Keep an isolated Workbench Ollama profile, port, model directory, and owned
  process tree for standalone development and installation verification only.
- Treat `CaptureDocument` schema `2` as canonical. The sidecar, not the host LLM, decides
  whether a candidate is valid and may complete.
- Keep domain reasoning outside the capture schema and outside the package.
- Configure colors and panel dimensions through typed inputs and CSS custom properties.
- Cut over without a production dual-provider fallback; rollback pins the prior
  host/package/runtime versions.
