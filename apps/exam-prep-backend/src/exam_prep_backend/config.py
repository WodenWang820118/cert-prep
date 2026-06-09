from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


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
    api_token: str = "exam-prep-local-dev-token"
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
    ollama_host: str = "http://127.0.0.1:11434"
    ollama_model: str = "gemma4:12b"

    @property
    def database_path(self) -> Path:
        return self.data_dir / self.database_name
