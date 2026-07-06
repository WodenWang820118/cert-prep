# Workbench Screen Alignment Decisions

Date: 2026-06-26

## Stitch Folders Are Page References

The four `design/stitch_cert_prep_workbench*` folders are separate app screens,
not alternative versions of one screen.

## Runtime Surface

The Stitch runtime reference is a modal overlay. The app should expose runtime
management from the topbar as a modal surface. The `/runtime` route remains an
unguarded recovery and deep-link surface, including when the packaged Python
backend runtime is missing. It should render the same runtime details without
modal-only close or cancel affordances instead of introducing a fifth visual
pattern. Standalone `ModelHealthComponent` Manage actions keep navigating to
`/runtime` so the component remains compatible outside the app shell.

## Random Quiz

No Stitch folder represents Random Quiz. It should inherit the Full Exam
workbench runner structure and keep only the mode-specific random-draw controls.

## Global Status

Normal operation success text is not part of the Stitch workbench shell. Show
blocking errors and active work globally; keep routine ready/success statuses
inside the relevant panel or omit them.
