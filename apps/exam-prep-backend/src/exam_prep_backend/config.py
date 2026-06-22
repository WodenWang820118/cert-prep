from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


DEFAULT_OLLAMA_MODEL = "qwen3:14b"


def default_data_dir() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return (base / "exam-prep-backend").resolve()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="EXAM_PREP_", extra="ignore")

    data_dir: Path = Field(default_factory=default_data_dir)
    database_name: str = "exam-prep.sqlite3"
    api_token: str = ""
    max_upload_bytes: int = 20 * 1024 * 1024
    max_pdf_pages: int = 250
    max_page_text_chars: int = 20_000
    max_total_text_chars: int = 500_000
    ocr_render_scale: float = 1.0
    ocr_page_workers: int = Field(default=1, ge=1)
    auto_generate_exam_on_upload: bool = False
    auto_generate_exam_limit: int = 50
    streaming_draft_generation_on_upload: bool = False
    streaming_draft_generation_strategy: Literal[
        "deterministic_only", "hybrid_reasoning"
    ] = "hybrid_reasoning"
    streaming_draft_generation_page_limit: int = Field(default=3, ge=1, le=20)
    streaming_draft_workers: int = Field(default=1, ge=1, le=4)
    ollama_timeout_seconds: float = 120.0
    allowed_origins: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:4200",
            "http://127.0.0.1:4200",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "tauri://localhost",
        ]
    )
    llm_provider: Literal["fake", "ollama"] = "fake"
    ocr_provider: Literal["fake", "ollama", "paddle", "directml"] = "fake"
    ocr_device: str = "auto"
    ocr_benchmark: bool = False
    ollama_host: str = "http://127.0.0.1:11434"
    ollama_model: str = DEFAULT_OLLAMA_MODEL
    ocr_runtime_mode: Literal["external", "inprocess"] = "external"
    ocr_runtime_dir: Path | None = None
    ocr_runtime_manifest_path: Path | None = None
    directml_ocr_runtime_dir: Path | None = None
    directml_ocr_runtime_manifest_path: Path | None = None
    ocr_directml_device_id: int = Field(default=0, ge=0)
    ocr_runtime_timeout_seconds: float = 300.0
    runtime_install_timeout_seconds: float = 900.0

    @property
    def database_path(self) -> Path:
        return self.data_dir / self.database_name

    @property
    def resolved_ocr_runtime_dir(self) -> Path:
        return (self.ocr_runtime_dir or self.data_dir / "runtimes" / "paddle_ocr").resolve()

    @property
    def resolved_directml_ocr_runtime_dir(self) -> Path:
        return (
            self.directml_ocr_runtime_dir or self.data_dir / "runtimes" / "directml_ocr"
        ).resolve()
