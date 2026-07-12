from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from cert_prep_contracts.llm import (
    DEFAULT_LLM_LOW_RESOURCE_MODEL,
    DEFAULT_LLM_PRIMARY_MODEL,
    DEFAULT_LLM_RUNTIME_POLICY,
)
from cert_prep_ollama.models import DEFAULT_OLLAMA_MODEL

DEFAULT_FASTFLOWLM_MODEL = DEFAULT_LLM_PRIMARY_MODEL
DEFAULT_FASTFLOWLM_BASE_URL = "http://127.0.0.1:52625/v1"
DEFAULT_OLLAMA_FALLBACK_MODELS = (DEFAULT_LLM_LOW_RESOURCE_MODEL,)
DEFAULT_FASTFLOWLM_FALLBACK_MODELS = (DEFAULT_LLM_LOW_RESOURCE_MODEL,)
DEFAULT_FASTFLOWLM_PRIMARY_MIN_AVAILABLE_RAM_BYTES = 6 * 1024 * 1024 * 1024
DEFAULT_FASTFLOWLM_AUTO_START_SERVER = True
DEFAULT_FASTFLOWLM_SERVER_START_TIMEOUT_SECONDS = 90.0
DEFAULT_FASTFLOWLM_OWNED_SERVER_IDLE_TIMEOUT_SECONDS = 5.0


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
    document_ocr_parallelism: int = Field(default=2, ge=1, le=4)
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
    llm_provider: Literal["auto", "fake", "ollama", "fastflowlm"] = (
        DEFAULT_LLM_RUNTIME_POLICY.preference.value
    )
    ocr_provider: Literal["fake", "ollama", "paddle", "windowsml"] = "fake"
    ocr_device: str = "auto"
    ocr_benchmark: bool = False
    ollama_host: str = "http://127.0.0.1:11434"
    ollama_model: str = DEFAULT_OLLAMA_MODEL
    ollama_profile_enabled: bool = True
    ollama_profile_id: str = "auto"
    ollama_profile_inventory_timeout_seconds: float = Field(default=5.0, ge=0.1)
    ollama_fallback_models: Annotated[list[str], NoDecode] = Field(
        default_factory=default_ollama_fallback_models
    )
    fastflowlm_base_url: str = DEFAULT_FASTFLOWLM_BASE_URL
    fastflowlm_model: str = DEFAULT_FASTFLOWLM_MODEL
    fastflowlm_executable_path: Path | None = None
    fastflowlm_terms_accepted_version: str | None = None
    fastflowlm_terms_declined: bool = False
    fastflowlm_fallback_models: Annotated[list[str], NoDecode] = Field(
        default_factory=default_fastflowlm_fallback_models
    )
    fastflowlm_timeout_seconds: float = 120.0
    fastflowlm_primary_min_available_ram_bytes: int = Field(
        default=DEFAULT_FASTFLOWLM_PRIMARY_MIN_AVAILABLE_RAM_BYTES,
        ge=0,
    )
    fastflowlm_auto_start_server: bool = DEFAULT_FASTFLOWLM_AUTO_START_SERVER
    fastflowlm_server_start_timeout_seconds: float = Field(
        default=DEFAULT_FASTFLOWLM_SERVER_START_TIMEOUT_SECONDS,
        ge=0.1,
    )
    fastflowlm_owned_server_idle_timeout_seconds: float = Field(
        default=DEFAULT_FASTFLOWLM_OWNED_SERVER_IDLE_TIMEOUT_SECONDS,
        ge=0.0,
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

    @field_validator("ollama_profile_id", mode="before")
    @classmethod
    def parse_ollama_profile_id(cls, value):
        if isinstance(value, str):
            return value.strip() or "auto"
        return value

    @field_validator("fastflowlm_fallback_models", mode="before")
    @classmethod
    def parse_fastflowlm_fallback_models(cls, value):
        if isinstance(value, str):
            return [model.strip() for model in value.split(",") if model.strip()]
        return value

    @field_validator("fastflowlm_base_url")
    @classmethod
    def validate_fastflowlm_base_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        try:
            port = parsed.port
        except ValueError as exc:
            raise ValueError("FastFlowLM base URL has an invalid port.") from exc
        if (
            parsed.scheme != "http"
            or parsed.hostname != "127.0.0.1"
            or port is None
            or port == 0
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path.rstrip("/") != "/v1"
        ):
            raise ValueError(
                "FastFlowLM base URL must be http://127.0.0.1:<port>/v1."
            )
        return f"http://127.0.0.1:{port}/v1"

    @model_validator(mode="after")
    def validate_fastflowlm_terms_state(self) -> Settings:
        if self.fastflowlm_terms_declined and self.fastflowlm_terms_accepted_version:
            raise ValueError(
                "FastFlowLM terms cannot be accepted and declined at the same time."
            )
        return self

    @property
    def resolved_ocr_runtime_dir(self) -> Path:
        return (self.ocr_runtime_dir or self.data_dir / "runtimes" / "paddle_ocr").resolve()

    @property
    def resolved_windowsml_ocr_runtime_dir(self) -> Path:
        return (
            self.windowsml_ocr_runtime_dir or self.data_dir / "runtimes" / "windowsml_ocr"
        ).resolve()
