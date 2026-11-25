# Cert Prep packaged engine smoke TODO

The real OCR journeys on the packaged app run through
`cert-prep-desktop:acceptance-real` ([acceptance spec](../SPECS/cert-prep-pdf-image-acceptance.md)).
The standalone packaged Capture Workbench smoke
([spec](../SPECS/packaged-capture-workbench-smoke.md)) is behind it.

The smoke's order (native Start success, dependency-negative cases before the
OCR install, preflight refresh before the picker) passed on an installed app
on 2026-11-25.

Open work: cover a successful packaged transcription through the Questions
page's source-library import, since the Capture Workbench page offers PDF and
image only: https://github.com/WodenWang820118/cert-prep/issues/153
