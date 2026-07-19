from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from threading import Event
from typing import Any


PRIMARY_MODEL = "large-v3-turbo"
FALLBACK_MODEL = "small"
REQUIRED_MODELS = (PRIMARY_MODEL, FALLBACK_MODEL)
_MODEL_REPO_IDS = {
    PRIMARY_MODEL: "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    FALLBACK_MODEL: "Systran/faster-whisper-small",
}
_MODEL_ALLOW_PATTERNS = (
    "config.json",
    "preprocessor_config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.*",
)


@dataclass(frozen=True, slots=True)
class WhisperModelInventory:
    """Read-only local inventory for the consent-gated Whisper model bundle."""

    available: bool
    installed_models: tuple[str, ...]
    missing_models: tuple[str, ...]
    installed_paths: tuple[str, ...]
    bytes: int | None


@dataclass(frozen=True, slots=True)
class WhisperModelDownloadProgress:
    """Byte progress reported while resolving the required model bundle."""

    detail: str
    completed: int | None = None
    total: int | None = None
    phase: str = "model_download"
    cancellable: bool = True


class WhisperModelDownloadCanceled(RuntimeError):
    """Raised at a model-download checkpoint after cancellation is requested."""


class WhisperModelRuntime:
    """Owns local model inventory and explicit Hugging Face model acquisition."""

    def __init__(
        self,
        *,
        models: Sequence[str] = REQUIRED_MODELS,
        local_model_resolver: Callable[[str], str] | None = None,
        snapshot_downloader: Callable[..., Any] | None = None,
    ) -> None:
        self.models = tuple(models)
        self._local_model_resolver = local_model_resolver
        self._snapshot_downloader = snapshot_downloader
        self._cancellation = Event()

    def inventory(self) -> WhisperModelInventory:
        """Return local-only model availability without making network requests."""

        installed_models: list[str] = []
        missing_models: list[str] = []
        installed_paths: list[str] = []
        installed_bytes = 0
        for model in self.models:
            try:
                path = self.model_path(model)
            except (FileNotFoundError, OSError, RuntimeError, ValueError):
                missing_models.append(model)
                continue
            installed_models.append(model)
            installed_paths.append(str(path))
            installed_bytes += _directory_bytes(path)

        return WhisperModelInventory(
            available=not missing_models,
            installed_models=tuple(installed_models),
            missing_models=tuple(missing_models),
            installed_paths=tuple(installed_paths),
            bytes=installed_bytes if installed_models else None,
        )

    def model_path(self, model: str) -> Path:
        """Resolve a fully cached model and never start an implicit download."""

        resolver = self._local_model_resolver
        if resolver is None:
            from faster_whisper.utils import download_model

            def resolve_cached_model(name: str) -> str:
                return download_model(name, local_files_only=True)

            resolver = resolve_cached_model
        try:
            path = Path(resolver(model))
        except Exception as exc:
            raise FileNotFoundError(f"Whisper model is not cached: {model}") from exc
        if not path.is_dir():
            raise FileNotFoundError(f"Whisper model is not cached: {model}")
        return path

    def download(
        self,
        progress: Callable[[WhisperModelDownloadProgress], None],
    ) -> WhisperModelInventory:
        """Download every missing required model after the caller obtained consent."""

        self._cancellation.clear()
        self._checkpoint()
        inventory = self.inventory()
        if inventory.available:
            progress(
                WhisperModelDownloadProgress(
                    "Whisper speech models are already cached.",
                    completed=inventory.bytes,
                    total=inventory.bytes,
                    phase="completed",
                    cancellable=False,
                )
            )
            return inventory

        downloader = self._snapshot_downloader
        if downloader is None:
            from huggingface_hub import snapshot_download

            downloader = snapshot_download

        download_plan: list[tuple[str, str, int]] = []
        cached_bytes = inventory.bytes or 0
        total_bytes = cached_bytes
        progress(
            WhisperModelDownloadProgress(
                "Resolving Whisper model download metadata.",
                phase="resolving",
            )
        )
        for model in inventory.missing_models:
            self._checkpoint()
            repo_id = _model_repo_id(model)
            dry_run = downloader(
                repo_id,
                allow_patterns=list(_MODEL_ALLOW_PATTERNS),
                max_workers=1,
                dry_run=True,
            )
            model_bytes = sum(
                int(getattr(item, "file_size", 0))
                for item in dry_run
                if bool(getattr(item, "will_download", True))
            )
            total_bytes += model_bytes
            download_plan.append((model, repo_id, model_bytes))

        completed_bytes = cached_bytes
        progress(
            WhisperModelDownloadProgress(
                "Downloading Whisper speech models.",
                completed=completed_bytes,
                total=total_bytes or None,
            )
        )

        for model, repo_id, model_bytes in download_plan:
            self._checkpoint()
            model_completed = 0
            runtime = self

            from tqdm.auto import tqdm

            class DownloadProgress(tqdm):
                """Real tqdm adapter with cancellation and runtime byte reporting."""

                def __init__(self, *args: Any, **kwargs: Any) -> None:
                    self._reports_bytes = (
                        str(kwargs.get("unit") or "").upper() == "B"
                        or str(kwargs.get("desc") or "").startswith("Reconstructing")
                    )
                    kwargs.setdefault("disable", True)
                    super().__init__(*args, **kwargs)

                def __iter__(self):
                    for item in super().__iter__():
                        runtime._checkpoint()
                        yield item
                    runtime._checkpoint()

                def update(self, amount: int = 1) -> bool | None:
                    nonlocal completed_bytes, model_completed
                    runtime._checkpoint()
                    delta = max(0, int(amount))
                    updated = super().update(amount)
                    if not self._reports_bytes:
                        return updated
                    model_completed += delta
                    completed_bytes += delta
                    progress(
                        WhisperModelDownloadProgress(
                            f"Downloading Whisper {model}.",
                            completed=min(completed_bytes, total_bytes),
                            total=total_bytes or None,
                        )
                    )
                    return updated

            downloader(
                repo_id,
                allow_patterns=list(_MODEL_ALLOW_PATTERNS),
                max_workers=1,
                tqdm_class=DownloadProgress,
            )
            if model_completed < model_bytes:
                completed_bytes += model_bytes - model_completed
            progress(
                WhisperModelDownloadProgress(
                    f"Whisper {model} download complete.",
                    completed=min(completed_bytes, total_bytes),
                    total=total_bytes or None,
                )
            )

        self._checkpoint()
        progress(
            WhisperModelDownloadProgress(
                "Verifying Whisper speech models.",
                completed=total_bytes or None,
                total=total_bytes or None,
                phase="verifying",
                cancellable=False,
            )
        )
        refreshed = self.inventory()
        if not refreshed.available:
            missing = ", ".join(refreshed.missing_models)
            raise RuntimeError(f"Whisper model download did not complete: {missing}")
        return refreshed

    def cancel(self) -> None:
        """Request cancellation at the next Hugging Face progress checkpoint."""

        self._cancellation.set()

    def _checkpoint(self) -> None:
        if self._cancellation.is_set():
            raise WhisperModelDownloadCanceled("Whisper model download was canceled.")


def _model_repo_id(model: str) -> str:
    repo_id = _MODEL_REPO_IDS.get(model)
    if repo_id is None:
        raise ValueError(f"Unsupported faster-whisper model: {model}")
    return repo_id


def _directory_bytes(path: Path) -> int:
    return sum(file.stat().st_size for file in path.rglob("*") if file.is_file())


__all__ = [
    "FALLBACK_MODEL",
    "PRIMARY_MODEL",
    "REQUIRED_MODELS",
    "WhisperModelDownloadCanceled",
    "WhisperModelDownloadProgress",
    "WhisperModelInventory",
    "WhisperModelRuntime",
]
