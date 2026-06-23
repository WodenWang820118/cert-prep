# Cert Prep Rename Decisions

## Decision
Use `cert-prep` as the workspace/project/package slug, `cert_prep` for Python modules and Rust library identifiers, `certPrep` for localStorage-style camelCase keys, and `CertPrep` for TypeScript symbols.

## Rationale
The repository directory and product intent are already `cert-prep`, while app/package names still use `cert-prep`. Keeping both names increases drift in Nx targets, runtime manifests, generated clients, package names, and evidence folders.

## Rejected Options
- Keep `cert_prep_backend` as a compatibility package: rejected because the request is to unify naming, and the backend is internal to this workspace.
- Rename only user-visible text: rejected because root scripts and Nx targets would remain inconsistent.
- Rename every historical `.agents` artifact: rejected because those files are durable history; new planning artifacts use `cert-prep`.

## Review Notes
This should be reviewed as a behavior-preserving mechanical rename. Any behavior change found during verification is a bug in the rename, not a new feature.
