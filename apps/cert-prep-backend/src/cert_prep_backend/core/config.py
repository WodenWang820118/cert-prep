from __future__ import annotations

import os
from pathlib import Path
from typing import Literal
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from cert_prep_contracts.llm import DEFAULT_LLM_RUNTIME_POLICY
from cert_prep_ollama.models import DEFAULT_OLLAMA_MODEL


def default_data_dir() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return (base / "cert-prep-backend").resolve()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CERT_PREP_", extra="ignore")

    data_dir: Path = Field(default_factory=default_data_dir)
    database_name: str = "cert-prep.sqlite3"
    api_token: str = ""
    max_upload_bytes: int = 20 * 1024 * 1024
    max_audio_upload_bytes: int = 100 * 1024 * 1024
    max_image_pixels: int = Field(default=50_000_000, ge=1)
    max_pdf_pages: int = 250
    max_page_text_chars: int = 20_000
    max_total_text_chars: int = 500_000
    ocr_render_scale: float = 1.0
    ocr_page_workers: int = Field(default=1, ge=1)
    document_ocr_parallelism: int = Field(default=2, ge=1, le=4)
    audio_transcription_parallelism: int = Field(default=1, ge=1, le=4)
    auto_generate_exam_on_upload: bool = False
    auto_generate_exam_limit: int = 50
    streaming_draft_generation_on_upload: bool = False
    streaming_draft_generation_strategy: Literal["deterministic_only", "hybrid_reasoning"] = (
        "hybrid_reasoning"
    )
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
    llm_provider: Literal["auto", "fake", "ollama"] = (
        DEFAULT_LLM_RUNTIME_POLICY.preference.value
    )
    ocr_provider: Literal["fake", "ollama", "paddle", "windowsml"] = "fake"
    ocr_device: str = "auto"
    ocr_benchmark: bool = False
    ollama_host: str = "http://127.0.0.1:11434"
    ollama_model: Literal["qwen3.5:4b"] = DEFAULT_OLLAMA_MODEL
    ollama_profile_enabled: bool = True
    ollama_profile_id: Literal["auto", "qwen3.5-4b-study-8k"] = "auto"
    ollama_profile_inventory_timeout_seconds: float = Field(default=5.0, ge=0.1)
    ocr_runtime_mode: Literal["external", "inprocess"] = "external"
    ocr_runtime_dir: Path | None = None
    ocr_runtime_manifest_path: Path | None = None
    windowsml_ocr_runtime_dir: Path | None = None
    windowsml_ocr_runtime_manifest_path: Path | None = None
    ocr_windowsml_device_id: int = Field(default=-1, ge=-1)
    ocr_runtime_timeout_seconds: float = 300.0
    runtime_install_timeout_seconds: float = 900.0

    @property
    def database_path(self) -> Path:
        return self.data_dir / self.database_name

    @field_validator("ollama_profile_id", mode="before")
    @classmethod
    def parse_ollama_profile_id(cls, value):
        if isinstance(value, str):
            return value.strip() or "auto"
        return value

    @property
    def resolved_ocr_runtime_dir(self) -> Path:
        return (self.ocr_runtime_dir or self.data_dir / "runtimes" / "paddle_ocr").resolve()

    @property
    def resolved_windowsml_ocr_runtime_dir(self) -> Path:
        return (
            self.windowsml_ocr_runtime_dir or self.data_dir / "runtimes" / "windowsml_ocr"
        ).resolve()
