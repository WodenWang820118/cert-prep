# Capture Workbench Decisions

- Publish an embeddable Angular library and a separately versioned Windows x64 sidecar.
- Use host structuring mode in Cert Prep: its existing Ollama provider implements
  the Capture Workbench provider interface, so capture does not run a second
  production Ollama process.
- Keep an isolated Workbench Ollama profile, port, model directory, and owned
  process tree for standalone development and installation verification only.
- Treat `CaptureDocumentV1` as canonical. The sidecar, not the host LLM, decides
  whether a candidate is valid and may complete.
- Keep domain reasoning outside the capture schema and outside the package.
- Configure colors and panel dimensions through typed inputs and CSS custom properties.
- Cut over without a production dual-provider fallback; rollback pins the prior
  host/package/runtime versions.
