# cert-prep-desktop


# Packaged desktop acceptance

`acceptance-real`, packaged-flow smoke, image-upload smoke, and Capture
Workbench smoke are real packaged application journeys. They must finish with zero
owned process, listener, and app-data residue.

Packaged-flow smoke can wait for background question jobs with
`--wait-for-question-jobs`. Set the wait timeout with
`--question-jobs-complete-timeout-ms`, cap the processed chunks with
`--question-jobs-chunk-limit`, and set the worker count with
`--question-job-workers`. The last two flags set
`CERT_PREP_QUESTION_JOBS_CHUNK_LIMIT` and `CERT_PREP_QUESTION_JOB_WORKERS`
for the launched app.


# Integration desktop tests

Package-QA and staged-runtime checks exercise multiple local components while
keeping package provenance local and explicit.


# Cert Prep desktop test levels

- `scripts/**/*.test.mts`: hermetic Node contract/process tests under `scripts/`.
- `package-qa-test`: package-QA, resource staging, and consumer contract tests.
- `acceptance-real` and packaged smoke targets: real packaged smoke and acceptance targets, including
  the real OCR journey; these own process, port, app-data, and temp cleanup.

The existing script topology is retained because its helper imports are part
of the desktop runner contract; the directories above are the canonical level
labels used by Nx targets and review evidence.


# Unit desktop tests

Deterministic process, artifact, and argument tests are collected by the
desktop `package-qa-test` lane without starting a packaged application.
