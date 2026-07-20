# Audio Transcription And Translation

## Purpose

Allow a project to import Japanese MP3, WAV, or M4A audio, preserve a
time-aligned Japanese transcript, and keep a Traditional Chinese translation
beside it. Japanese remains the canonical source used for draft generation.

## Product Contract

- Audio uploads are limited to 100 MiB and 90 minutes.
- Whisper `large-v3-turbo` is preferred on a capable GPU. A recognized GPU
  initialization or out-of-memory failure retries once with `small` on CPU.
- Whisper models are downloaded only after explicit runtime consent and are not
  bundled in the desktop installer.
- Ollama `qwen3.5:4b` translates completed Japanese segments to Traditional
  Chinese. Translation failure never discards a successful transcript.
- Each segment retains its time range, original Whisper text, current editable
  Japanese text, current Traditional Chinese translation, source revision, and
  the revision used by the translation.
- A translation is stale when its source revision differs from the current
  Japanese revision. Users can retranslate one segment or every stale segment.
- Audio documents use `page_count=0`; audio chunks use `page_number=0` and an
  explicit time locator. Existing PDF/image contracts remain unchanged.

## Interfaces

- Existing document upload accepts MP3, WAV, and M4A and routes them to the
  transcription provider without initializing OCR.
- Audio participates in the shared source-import slot queue. Runtime/model
  consent gates only audio items that require Whisper; unrelated ready PDF or
  image items continue to use available upload slots.
- Document reads expose source kind, duration, transcription/translation state,
  and configured/effective Whisper model and device.
- Chunk reads expose locator kind, start/end milliseconds, translation text,
  source/translation revisions, and derived translation staleness.
- `PATCH .../chunks/{chunk_id}` updates Japanese text and increments its source
  revision.
- `POST .../chunks/{chunk_id}/translation` translates one segment.
- `POST .../documents/{document_id}/translations` translates every stale segment.
- `GET .../documents/{document_id}/source` serves only the authenticated,
  integrity-checked canonical audio source and supports byte ranges.
- Operation phases include `transcribing` and `translating`.
- The bilingual segment preview includes native audio controls; each time-located
  segment can seek the authenticated source to its `start_ms` and begin playback.

## Failure And Lifecycle Rules

- Invalid signatures, unsupported codecs, excessive duration, and excessive
  size fail validation before processing begins.
- Cancel stops transcription/translation at the next provider checkpoint,
  removes derived temporary media, and retains the canonical source for retry.
- Whisper execution is separately resource-bounded from the document upload
  queue and defaults to one active transcription. An app-owned fixed FIFO
  worker pool holds only canonical source references while audio waits; a
  cancellation-aware provider gate also protects synchronous callers. Concurrent
  PDF OCR uses a separate fixed pool, so it does not create additional Whisper
  model instances. Cancellation while queued prevents model construction, and
  every terminal path releases the gate.
- Upload/retry submit races reconcile the durable operation after enqueue, so a
  cancel arriving between document attachment and worker submission is removed
  and acknowledged without starting transcription. Shutdown closes the gate and
  queue, cancels queued work, and performs a bounded join before provider
  cleanup. Active native inference remains cooperative and stops at its next
  provider checkpoint rather than by unsafe thread termination.
- Completed segments are committed incrementally and remain readable.
- An uncanceled Whisper failure preserves completed Japanese segments, marks
  the document `transcription_failed`, and keeps the canonical source eligible
  for retry. Recovery after an interrupted translation keeps the successful
  transcript usable and marks translation failed.
- A valid audio file with no recognized speech completes as
  `no_text_detected`, remains retryable, and does not claim translation success.
- Ollama unavailability produces `translation_failed` while the document stays
  usable as a transcript and as a Japanese draft-generation source.
- Provider attribution records configured/effective Whisper model and device;
  fallback is always visible and never silently reported as Turbo success.
- If GPU execution fails after partial segments were emitted, those segments are
  removed before the single CPU retry so the two model outputs cannot be mixed.
  A polling client may briefly observe an empty segment list during that reset.
- Decoded duration uses both accumulated samples and timestamp endpoints. Mixed
  timestamped/untimestamped streams therefore retain leading and trailing audio
  while still rejecting any conservative duration above 90 minutes.

## Non-Goals

- Microphone recording, speaker diarization, word timestamps, cloud ASR,
  translation-history browsing, and non-Japanese source languages.

## Acceptance Evidence

- On 2026-07-19, the queue-responsiveness follow-up passed all 388 backend
  tests, including 26 focused audio/PDF queue, cancel-race, submit-failure, and
  shutdown cases. Audio and OCR worker counts are fixed by their respective
  settings, queued payloads are canonical metadata only, and no API/schema
  regeneration was required.
- On 2026-07-20, the final review follow-up passed all 393 backend tests and 28
  focused queue/async tests after adding rolling mixed-source upload coverage,
  bounded document workers, shutdown cleanup, and immediate release of audio
  source bytes after transcription. Backend lint and the production Angular
  build also passed.
- On 2026-07-19, the automated matrix completed 877 tests: backend 374,
  transcription runtime 14, contracts 5, generated API client 3, Angular 251,
  desktop package QA 210, and Rust 20. Relevant lint, typecheck, OpenAPI
  generation, and `git diff --check` also passed.
- A packaged-backend smoke processed a local 45:51 Japanese MP3 on CUDA
  `large-v3-turbo` into 650 ordered segments. Every segment retained Japanese
  and received a Traditional Chinese translation; the authenticated source
  endpoint returned a correct HTTP 206 byte range. The copyrighted source is
  local-only and is not committed.
- Local browser verification covered playback seeking, editable Japanese,
  visible Traditional Chinese, stale detection, and successful single-segment
  retranslation with no console or server errors. Copyrighted transcript
  screenshots and session logs remain local-only and are not committed.
- The final backend runtime is 111,409,503 bytes with SHA-256
  `c587453d3b45a92baf53cb89ecf675eff829ec6d727985bf1839fda382daf6f0`.
  The backend, generated-resource, and release-resource copies match exactly;
  the PyInstaller archive contains CTranslate2 cuDNN and Silero VAD but no
  Whisper model cache. Both consent-downloaded models are locally ready and
  total 2,107,878,355 bytes.
- The final NSIS package is 114,740,122 bytes (109.42 MiB), with SHA-256
  `bcc62177340c51bcd55962a6dc7be0e8577a089067b58839bd0f83fd4279fe77`.
  The package QA target completes and its configured size gate passes.
  Public release remains independently gated on installer-contents verification,
  a clean-install acceptance run, and an explicit native-binary license/SBOM
  audit. The packaged backend includes wheel-bundled FFmpeg, cuDNN, and Intel
  OpenMP binaries that are not yet represented as separate redistributed
  components in the generated inventory. These release gates do not block the
  reviewed source commits, but they do block public installer distribution.
