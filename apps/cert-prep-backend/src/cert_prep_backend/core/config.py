from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from cert_prep_ollama.models import DEFAULT_OLLAMA_MODEL

DEFAULT_FASTFLOWLM_MODEL = "qwen3.5:4b"
DEFAULT_FASTFLOWLM_BASE_URL = "http://127.0.0.1:52625/v1"
DEFAULT_OLLAMA_FALLBACK_MODELS = ("qwen3.5:2b",)
DEFAULT_FASTFLOWLM_FALLBACK_MODELS = ("qwen3.5:2b",)
DEFAULT_FASTFLOWLM_PRIMARY_MIN_AVAILABLE_RAM_BYTES = 6 * 1024 * 1024 * 1024


def default_data_dir() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return (base / "cert-prep-backend").resolve()


def default_ollama_fallback_models() -> list[str]:
    return list(DEFAULT_OLLAMA_FALLBACK_MODELS)


def default_fastflowlm_fallback_models() -> list[str]:
    return list(DEFAULT_FASTFLOWLM_FALLBACK_MODELS)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CERT_PREP_", extra="ignore")

    data_dir: Path = Field(default_factory=default_data_dir)
    database_name: str = "cert-prep.sqlite3"
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
    llm_provider: Literal["fake", "ollama", "fastflowlm"] = "fake"
    ocr_provider: Literal["fake", "ollama", "paddle", "windowsml"] = "fake"
    ocr_device: str = "auto"
    ocr_benchmark: bool = False
    ollama_host: str = "http://127.0.0.1:11434"
    ollama_model: str = DEFAULT_OLLAMA_MODEL
    ollama_fallback_models: Annotated[list[str], NoDecode] = Field(
        default_factory=default_ollama_fallback_models
    )
    fastflowlm_base_url: str = DEFAULT_FASTFLOWLM_BASE_URL
    fastflowlm_model: str = DEFAULT_FASTFLOWLM_MODEL
    fastflowlm_fallback_models: Annotated[list[str], NoDecode] = Field(
        default_factory=default_fastflowlm_fallback_models
    )
    fastflowlm_timeout_seconds: float = 120.0
    fastflowlm_primary_min_available_ram_bytes: int = Field(
        default=DEFAULT_FASTFLOWLM_PRIMARY_MIN_AVAILABLE_RAM_BYTES,
        ge=0,
    )
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

    @field_validator("ollama_fallback_models", mode="before")
    @classmethod
    def parse_ollama_fallback_models(cls, value):
        if isinstance(value, str):
            return [model.strip() for model in value.split(",") if model.strip()]
        return value

    @field_validator("fastflowlm_fallback_models", mode="before")
    @classmethod
    def parse_fastflowlm_fallback_models(cls, value):
        if isinstance(value, str):
            return [model.strip() for model in value.split(",") if model.strip()]
        return value

    @property
    def resolved_ocr_runtime_dir(self) -> Path:
        return (self.ocr_runtime_dir or self.data_dir / "runtimes" / "paddle_ocr").resolve()

    @property
    def resolved_windowsml_ocr_runtime_dir(self) -> Path:
        return (
            self.windowsml_ocr_runtime_dir or self.data_dir / "runtimes" / "windowsml_ocr"
        ).resolve()
