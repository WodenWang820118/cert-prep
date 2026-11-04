# Audio capture and translation

## Product contract

Audio MP3, WAV and M4A imports go through the pinned Capture Runtime when its
`speech-recognition` requirement is ready. Capture Runtime owns the speech
engine and its installation, audio decoding, time-aligned transcript segments
and unavailable/error states; Cert passes the spoken language (`ja` for
Japanese audio). Cert Prep owns the authenticated proxy, persistence and the
Traditional Chinese translation. Audio is not accepted by the capture review
session; it is imported through the documents upload.

Japanese source text remains canonical. Each persisted audio chunk keeps its
time locator and raw Japanese transcript in `document_chunks.raw_text`; the
reviewed or translated value is stored in `document_chunks.text` and the
translation fields.

## Failure and lifecycle rules

- Invalid codec, signature, size or duration fails before capture creation.
- A missing Capture Runtime or `speech-recognition` requirement fails closed;
  Cert Prep does not download models or retry through a local speech provider.
- Cancel, retry, timeout and runtime failure remain explicit and preserve the
  canonical source when it is safe to retry.
- Translation failure does not discard a successful Japanese capture.
- Audio stays in the shared document/chunk and practice pipeline with its time
  locator and source/translation revision semantics.

## Evidence

Backend coordinator tests cover audio routing, raw provenance, cancellation,
retry, timeout, unavailable runtime and translation mapping. A real run must use
the published Capture Runtime and check Japanese source retention and the
Traditional Chinese translation separately. The packaged smoke has no audio leg
yet ([TODO](../../TODOS/capture-workbench-cert-prep-pdf.md)).
