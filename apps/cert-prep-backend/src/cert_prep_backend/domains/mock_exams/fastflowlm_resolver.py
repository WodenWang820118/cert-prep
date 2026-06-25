from __future__ import annotations

import os
from pathlib import Path
import shutil


def resolve_fastflowlm_executable() -> Path | None:
    """Resolve the FastFlowLM CLI from PATH or common Windows install paths."""

    configured = shutil.which("flm")
    if configured:
        return Path(configured)
    if os.name != "nt":
        return None

    candidates: list[Path] = []
    for root in (
        os.environ.get("LOCALAPPDATA"),
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramFiles(x86)"),
    ):
        if not root:
            continue
        base = Path(root)
        candidates.extend(
            [
                base / "Programs" / "FastFlowLM" / "flm.exe",
                base / "flm" / "flm.exe",
                base / "flm" / "bin" / "flm.exe",
                base / "FastFlowLM" / "flm.exe",
                base / "FastFlowLM" / "bin" / "flm.exe",
            ]
        )
    return next((candidate for candidate in candidates if candidate.is_file()), None)
