# Open work

Ordered by priority. Each line links to the TODO that holds the detail and
evidence rules.

## Capture Runtime consumer (0.5.0)

- Packaged smoke: audio leg, and update `packaged-capture-workbench-smoke` to
  the OCR-preflight flow — [capture-workbench-cert-prep-pdf.md](capture-workbench-cert-prep-pdf.md)
- Installed acceptance journey: original private PDF page 1, cleanup proofs,
  restart persistence, review override and export, package-defined
  `ConsumerSemanticResultV1` — [cert-prep-pdf-image-acceptance.md](cert-prep-pdf-image-acceptance.md)
- Lifecycle hardening slices 4–7 (runtime promotion store, semantic result,
  supervision adapter, restart reconciliation, performance baseline); 0.5.0
  consumption does not depend on them — [capture-runtime-consumer.md](capture-runtime-consumer.md)

## Product release

- Public Alpha `0.1.0-alpha.1`: one green `release-alpha.yml` run and its
  public verification — [alpha-launch-readiness.md](alpha-launch-readiness.md)

Known limitation: handwritten OCR quality (Capture Runtime 0.5.0).
