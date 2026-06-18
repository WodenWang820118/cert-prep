# Saved Parsed Exams 與 Runtime UX QA 摘要

## 現況

2026-06-17 已用 packaged Windows Tauri app 完成 production QA。測試使用真實 PDF `pdfs/【1】2025年07月N1 真题.pdf`，重點驗證 saved parsed content、full exam、random quiz、wrong-answer cleanup、runtime compact drawer。

## QA 證據

- Release exe：`apps/exam-prep-desktop/src-tauri/target/x86_64-pc-windows-msvc/release/exam-prep-desktop.exe`。
- Package QA JSON：`tmp/exam-prep-desktop/package-qa/package-qa.json`。
- Screenshot directory：`.agents/tmp/saved-parsed-exams-runtime-ux/20260617-162641/screenshots/`。
- Runtime：Python backend 3.13.5 packaged、PaddleOCR `gpu:0` ready、Ollama/Gemma offline but optional。
- Flow：Python install → PDF selected with `language_hint=ja` → processing/chunks → 46 pages/46 chunks ready → 3 manual drafts approved → restart persistence → full exam → wrong answer → random quiz → correct answer clears review。

## 量測

- Upload response：139 ms。
- First visible progress/chunks：45s poll 顯示 2/46 pages、2 chunks。
- Full parsing：17m47s。
- Manual approval：3 drafts in 6.410s。
- Full exam session：128 ms。
- Random session：85 ms，seed saved。
- Wrong-answer clear：58 ms attempt path。

## 已吸收完成 TODO

- Backend persistence fields、parser/classifier、practice modes。
- OpenAPI client and frontend types。
- Project-level mode navigation。
- Compact runtime drawer。
- E2E/full/random/review coverage。
- Package/script/cargo checks。
- Packaged app production QA。

## 未解風險

- OCR wall time 仍長。
- Runtime stale message、Ollama guided install、source panel height 仍需改。
- OCR-confused glyphs 是內容品質問題，但 final DB/user-facing state 未出現 UTF-8 replacement corruption。
