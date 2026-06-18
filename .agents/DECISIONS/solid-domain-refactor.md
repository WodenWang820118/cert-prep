# SOLID Domain Refactor 決策

## 2026-06-18

- 本輪採 pure refactor，保留既有產品行為；功能 TODO 保持在 `.agents/TODOS/parallel-parsing-reasoning.md`。
- 允許 breaking changes，但不允許留下 compatibility shim；所有本地 consumer、測試、generated artifact 與 QA script 必須同輪更新。
- 舊 `.agents/TODOS/*.md` archive 指標檔刪除納入 baseline commit，避免後續 domain refactor diff 混入文件清理。
- Root agent 採 coordinator 職責：文件、commit、scope、整合 review、QA evidence；Tauri/Angular/Python 各自有 bounded ownership。
- File-size 目標採務實原則：優先拆混合責任與難測試邊界，不追求任意行數；大型 orchestration 檔案目標約 350-450 行以下，若拆分會引入更差抽象則保留較長檔案並記錄理由。
