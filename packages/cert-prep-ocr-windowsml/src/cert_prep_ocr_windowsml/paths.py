from __future__ import annotations

import os
from pathlib import Path


def resolve_backend_root() -> Path:
    configured = os.environ.get("CERT_PREP_BACKEND_ROOT", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()

    cwd = Path.cwd().resolve()
    if (cwd / "pyproject.toml").is_file() and cwd.name == "cert-prep-backend":
        return cwd

    for parent in (cwd, *cwd.parents):
        candidate = parent / "apps" / "cert-prep-backend"
        if (candidate / "pyproject.toml").is_file():
            return candidate.resolve()

    return cwd


BACKEND_ROOT = resolve_backend_root()
REPO_ROOT = BACKEND_ROOT.parents[1] if BACKEND_ROOT.name == "cert-prep-backend" else BACKEND_ROOT
DEFAULT_OUTPUT_DIR = BACKEND_ROOT / ".benchmarks"
DEFAULT_MODEL_DIR = DEFAULT_OUTPUT_DIR / "ocr-windowsml-models"
DEFAULT_SOURCES_DIR = DEFAULT_OUTPUT_DIR / "ocr-windowsml-sources"
