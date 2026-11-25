# Cert Prep packaged engine smoke TODO

The real OCR journeys on the packaged app run through
`cert-prep-desktop:acceptance-real` ([acceptance spec](../SPECS/cert-prep-pdf-image-acceptance.md)).
The standalone packaged Capture Workbench smoke
([spec](../SPECS/packaged-capture-workbench-smoke.md)) is behind it.

Open work: run the smoke on an installed app to verify its order (native
Start success, dependency-negative cases before the OCR install, preflight
refresh before the picker), and cover a successful packaged transcription
through the Build page's source-library import, since the Capture Workbench page offers
PDF and image only: https://github.com/gx-capture/capture-workbench/issues/259
