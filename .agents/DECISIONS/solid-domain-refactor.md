# SOLID Domain Refactor 決策

## 2026-06-18

- 本輪採 pure refactor，功能 TODO 保持在 `.agents/TODOS/parallel-parsing-reasoning.md`。
- 舊 `.agents/TODOS/*.md` archive 指標檔刪除納入 baseline commit `803310f`，避免後續 domain refactor diff 混入文件清理。
- Root agent 採 coordinator 職責：文件、commit、scope、整合 review、QA evidence；Tauri、Angular、Python 各自有 bounded ownership。
- 允許 breaking changes，但本輪最後沒有刻意改外部 REST/OpenAPI、Tauri command、package QA JSON schema。
- `runtime_installations` 從單檔改成 package，保留目前 domain public import path；這不是舊 shim，而是 package root API。
- Runtime manifests 必須跟 release build 後 artifact hash 同步，否則 packaged install/runtime verification 會 drift。
- Packaged smoke 通過後仍保留三個後續風險：first chunk latency、OCR health settle、graceful close/process-tree cleanup。
