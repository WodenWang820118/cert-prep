from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SourceArtifact:
    kind: str
    model_name: str
    url: str
    filename: str
    sha256: str
    byte_size: int
    archive_root: str
    target_onnx_name: str


@dataclass(frozen=True)
class ConversionResult:
    state: str
    command: list[str]
    stdout: str
    stderr: str
    output_model: Path | None = None
    blocker: str | None = None


DownloadFn = Callable[[str, Path], None]
ConverterRunner = Callable[[SourceArtifact, Path, Path], ConversionResult]
