# Audio capture and translation

## Product contract

Audio MP3, WAV, and M4A imports go through the published Capture Runtime when
its Whisper requirement is available. Capture Runtime owns Whisper
requirements, audio decoding, time-aligned Japanese transcript segments, and
unavailable/error states. v0.3.8 reports the requirement as unavailable, so it
does not provide real audio capture evidence. Cert Prep owns the authenticated
proxy, host review/structuring, persistence, and Traditional Chinese
translation.

Japanese source text remains canonical. Each persisted audio chunk retains its
time locator and raw Japanese transcript in `document_chunks.raw_text`; the
reviewed or translated value is stored in `document_chunks.text` and the
existing translation fields.

## Failure and lifecycle rules

- Invalid codec, signature, size, or duration fails before capture creation.
- Missing Capture Runtime or Whisper requirements fails closed; Cert Prep does
  not download models or retry through a local Whisper provider.
- Cancel, retry, timeout, and runtime failure remain explicit and preserve the
  canonical source when it is safe to retry.
- Translation failure does not discard a successful Japanese capture.
- Audio remains in the shared document/chunk and practice pipeline with its
  explicit time locator and source/translation revision semantics.

## Evidence

Backend coordinator tests cover audio routing, raw provenance, cancellation,
retry, timeout, unavailable runtime, and translation mapping. The real consumer
smoke must use the published Capture Runtime asset and verify Japanese source
retention plus Traditional Chinese translation independently.
